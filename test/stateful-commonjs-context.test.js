import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { adaptDynamicCell } from '../internal/dynamic-environment-integration.js'
import { adaptModuleOperations } from '../internal/managed-module-operations.js'
import { CELL_PARSER_PLUGINS, normalizeStatefulScopes, normalizeTypeScriptValues } from '../internal/repl-scope-normalizer.js'
import { identitySourceMap, mapSourceSpan } from '../internal/source-position-map.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'
import { LEGACY_USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { managedGraph } from './managed-module-fixture.js'

const contextSource = `
const originalThis=this
const originalArguments=arguments
const target=new.target
const arrow=()=>new.target
const evaluated=eval('new.target')
const escaped=eval('()=>[new.target,this===originalThis,arguments===originalArguments]')
function Own(){return [new.target===Own,eval('new.target')===Own,(()=>new.target===Own)()]}
module.exports={
  target,arrow,
  read:()=>[target,arrow(),evaluated,...escaped(),this===originalThis,
    arguments===originalArguments,arguments.length,arguments[0]===originalThis,
    arguments[2]===module,__filename===module.filename],
  constructed:new Own(),called:Own()
}
return
throw new Error('past return')
`

for (const transform of [USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
  test(`CommonJS compiler inputs are independent of source bindings (${transform})`, async t => {
    const sources = {
      lexical: `const process=require('node:process');exports.answer=42;
        exports.read=()=>[process===require('node:process'),eval('process')===process];`,
      variable: `exports.before=typeof process;var process=3;
        exports.read=()=>[process,eval('process')];`,
      callable: `exports.before=process.name;function process(){return process}
        exports.read=()=>[process.name,process()===process,eval('process')===process];`,
      class: `class process {static observed=this.name;static read(){return process}}
        exports.read=()=>[process.name,process.observed,process.read()===process,eval('process')===process];`,
      loop: `var sum=0;for(var process=0;process<3;process++)sum+=process;
        for(var process of [4,5])sum+=process;exports.read=()=>[sum,process,eval('process')];`,
      conditional: `if(false)var process=1,other=2;exports.read=()=>[process,other];`,
      with: `var process=1;const object={process:2};with(object){var process=3}
        exports.read=()=>[process,object.process];`,
      withLoop: `var process=1;const object={process:2};with(object){for(var process=3;process<4;process++){}}
        exports.read=()=>[process,object.process];`,
      pattern: `try{var {process=1,other=(()=>{throw 2})()}={}}catch{}
        exports.read=()=>[process,other];`,
      catch: `var process=1;try{throw 2}catch(process){var process=3;exports.caught=process}
        exports.read=()=>[process,exports.caught];`,
      shadow: `const process=1;function read(process){return eval('process')}
        exports.read=()=>[read(2),eval('process')];`,
      closures: `let process=1;const read=()=>process;const dynamic=eval('()=>process');process=2;
        exports.read=()=>[read(),dynamic(),eval('process')];`,
    }
    const files = Object.fromEntries(Object.entries(sources).flatMap(([name, source]) =>
      [[`${name}.cjs`, source], [`native-${name}.cjs`, source]]))
    const graph = await managedGraph(t, files, 'lexical.cjs', Object.keys(sources).map(name => `native-${name}.cjs`))
    for (const name of Object.keys(sources)) {
      if ((name === 'with' || name === 'withLoop' || name === 'pattern') && transform === LEGACY_USER_BINDING_TRANSFORM) continue
      graph.compilation.mark(graph.url(`${name}.cjs`), { transform })
      const compiled = (await graph.load(`${name}.cjs`)).default
      const native = graph.opaque[`native-${name}.cjs`].default
      assert.deepEqual(compiled.read(), name === 'pattern' && transform === USER_BINDING_TRANSFORM
        ? [undefined,undefined] : native.read(), name)
      assert.equal(compiled.before, native.before, name)
      assert.equal(compiled.answer, native.answer, name)
    }
  })
}

for (const transform of [PROTECTED_MODULE_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
  test(`CommonJS bootstrap adaptation preserves native lexical policy (${transform})`, async t => {
    const source = `
      const effects=[];let read;
      try{const {process=1,other=(read=()=>process,(()=>{throw 3})())}={}}catch{}
      effects.push(read());
      const process=1,other=2;let mutable=3;
      for(const text of ['process=2','other=4']){try{eval(text)}catch(error){effects.push(error.name)}}
      try{let process=(process=4)}catch(error){effects.push(error.name)}
      const capture=()=>process;
      exports.read=()=>[...effects,process,other,mutable,capture()];`
    const graph = await managedGraph(t, { 'root.cjs': source, 'native.cjs': source }, 'root.cjs', ['native.cjs'])
    graph.compilation.mark(graph.url('root.cjs'), { transform })
    assert.deepEqual((await graph.load()).default.read(), graph.opaque['native.cjs'].default.read())
    for (const declaration of ['const process=1;const process=2;', 'let process;var process;']) {
      assert.throws(() => compileStatefulModule(declaration, { transform, target:'commonjs' }), SyntaxError)
    }
  })
}

test('protected CommonJS bootstrap bindings retain lexical TDZ and resource disposal', async t => {
  const graph = await managedGraph(t, {
    'root.cjs': `const process=(()=>{try{process=3}catch(error){return error.name}})();module.exports=process`,
    'resource.cjs': `const events=[];using process={[Symbol.dispose](){events.push('disposed')}};
      module.exports={process,events,read:()=>eval('process')};`,
  }, 'root.cjs')
  for (const name of ['root.cjs','resource.cjs']) graph.compilation.mark(graph.url(name), { transform:PROTECTED_MODULE_TRANSFORM })
  assert.equal((await graph.load()).default, 'ReferenceError')
  const resource = (await graph.load('resource.cjs')).default
  assert.deepEqual(resource.events, ['disposed'])
  assert.equal(resource.read(), resource.process)
})

for (const transform of [USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
  for (const strict of [false, true]) {
    test(`CommonJS wrapper arguments share the managed loader and preserve native aliasing (${transform}, strict=${strict})`, async t => {
      const graph = await managedGraph(t, {
        'value.mjs': 'export const value=7',
        'root.cjs': `${strict ? '"use strict";' : ''}
          const original=require, captured=arguments;
          const reflected=Object.getOwnPropertyDescriptor(captured,'1').value;
          const before=[require===captured[1],reflected===require,reflected('./value.mjs').value,
            Reflect.apply(captured[1],null,['./value.mjs']).value];
          captured[1]=()=>8;
          module.exports={before,after:[require===captured[1],require===original]};`,
      }, 'root.cjs')
      graph.compilation.mark(graph.url('root.cjs'), { transform })
      const result = (await graph.load()).default
      assert.deepEqual(result.before, [true,true,7,7])
      assert.deepEqual(result.after, [!strict,strict])
    })
  }
}

for (const transform of [USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
  for (const strict of [false,true]) {
    test(`CommonJS bootstrap preserves a hoisted source require (${transform}, strict=${strict})`, async t => {
      const graph = await managedGraph(t, {
        'value.mjs': 'export const value=7',
        'root.cjs': `${strict ? '"use strict";' : ''}function require(){return 3};
          module.exports=[require(),${strict ? 'arguments[1]("./value.mjs").value' : 'arguments[1]()'}]`,
      }, 'root.cjs')
      graph.compilation.mark(graph.url('root.cjs'), { transform })
      assert.deepEqual((await graph.load()).default, [3,strict ? 7 : 3])
    })
  }
}

for (const strict of [false, true]) {
  test(`CommonJS declarations retain wrapper inputs and mapped arguments (strict=${strict})`, async t => {
    const source = `${strict ? '"use strict";' : ''}
      var exports, require, module, __filename, __dirname;
      const originalArguments=arguments;
      const before=[exports===this,typeof require,module.filename===__filename,
        typeof __dirname,arguments[0]===exports,arguments[1]===require,arguments[2]===module];
      const saved=()=>exports;
      arguments[0]={value:1};
      const fromArguments=[exports===arguments[0],saved()===exports];
      exports={value:2};
      const fromBinding=[arguments[0]===exports,saved()===exports,eval('exports')===exports];
      function local(){var exports;return exports}
      module.exports={before,fromArguments,fromBinding,local:local()===undefined,
        argumentsKept:originalArguments===arguments};`
    const graph = await managedGraph(t, { 'root.cjs': source, 'native.cjs': source,
      'bare.cjs': 'var exports;exports.answer=42',
      'arguments.cjs': 'var arguments;module.exports=[arguments.length,arguments[2]===module]',
    }, 'root.cjs', ['native.cjs'])
    assert.deepEqual((await graph.load()).default, graph.opaque['native.cjs'].default)
    assert.equal((await graph.load('bare.cjs')).default.answer, 42)
    assert.deepEqual((await graph.load('arguments.cjs')).default, [5,true])
  })
}

for (const transform of [USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
  for (const strict of [false, true]) {
    test(`CommonJS wrapper context matches native require (${transform}, strict=${strict})`, async t => {
      const source = (strict ? '"use strict";\n' : '') + contextSource
      const graph = await managedGraph(t, { 'root.cjs': source, 'native.cjs': source }, 'root.cjs')
      graph.compilation.mark(graph.url('root.cjs'), { transform })
      const require = createRequire(import.meta.url)
      const native = require(join(graph.directory, 'native.cjs'))
      const managed = (await graph.load()).default
      assert.equal(managed.target, undefined)
      assert.equal(managed.arrow(), undefined)
      assert.deepEqual(managed.read(), native.read())
      assert.deepEqual(managed.constructed, [true,true,true])
      assert.deepEqual(managed.called, [false,false,false])
      assert.deepEqual(managed.constructed, native.constructed)
      assert.deepEqual(managed.called, native.called)
    })
  }
}

test('CommonJS static new.target and dynamic-only lexical captures share the wrapper goal', async t => {
  const graph = await managedGraph(t, {
    'root.cjs': 'module.exports={target:new.target,read:()=>new.target}',
    'dynamic.cjs': 'module.exports=eval("()=>[new.target,this===exports,arguments.length]")',
  }, 'root.cjs')
  const root = (await graph.load()).default
  const dynamic = (await graph.load('dynamic.cjs')).default
  assert.equal(root.target, undefined)
  assert.equal(root.read(), undefined)
  assert.deepEqual(dynamic(), [undefined,true,5])
})

test('stateful CommonJS normalization retains wrapper syntax through local revisions and decorators', async t => {
  const graph = await managedGraph(t, {
    'root.cts': `
const value:number=1
const value:number=2
function decorate(value:Function){return value}
@decorate class Item { value=new.target; read(){return eval('new.target')} }
module.exports={target:new.target,value,Item,read:()=>eval('new.target')}
`,
  }, 'root.cts')
  const root = (await graph.load()).default
  assert.equal(root.value, 2)
  assert.equal(root.target, undefined)
  assert.equal(root.read(), undefined)
  const instance = new root.Item()
  assert.equal(instance.value, undefined)
  assert.equal(instance.read(), undefined)
})

for (const legacy of [false,true]) {
  test(`actual worker CommonJS imports retain wrapper captures (legacy=${legacy})`, async t => {
    const graph = await managedGraph(t, { 'root.cjs': contextSource }, 'root.cjs')
    const runtime = new SessionRuntime({ durableReplay: false,
      ...(legacy ? { legacyBindingSettings: true, looseTopLevelRedeclarations: false } : { bindingUpdates: 'stateful' }) })
    t.after(() => runtime.dispose())
    const session = orderedSurfaceSession(`commonjs-context-${legacy}`)
    session.header = { cwd: graph.directory }
    const first = await runRecordedCell(runtime, session, 'load-commonjs-context', { bindings: [], program: `
const required=require('./root.cjs')
const imported=await import('./root.cjs')
const retained=required.arrow
return [required===imported.default,required.target===undefined,required.arrow()===undefined,
  required.read().map(value=>value===undefined?'undefined':value),required.constructed,required.called]
` })
    assert.equal(first.error, undefined, first.error?.message)
    assert.deepEqual(first.value, [true,true,true,
      ['undefined','undefined','undefined','undefined',true,true,true,true,5,true,true,true],
      [true,true,true],[false,false,false]])
    const next = await runRecordedCell(runtime, session, 'reuse-commonjs-context', {
      bindings: [], program: 'return [retained()===undefined,required.read()[4],required.read()[8]]',
    })
    assert.equal(next.error, undefined, next.error?.message)
    assert.deepEqual(next.value, [true,true,5])
  })
}

test('ESM and ordinary script goals reject top-level new.target without widening CommonJS syntax', () => {
  for (const transform of [USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
    assert.throws(() => compileStatefulModule('export const target=new.target', { transform }), SyntaxError)
    assert.throws(() => compileStatefulModule('await Promise.resolve()', { transform, target: 'commonjs' }), SyntaxError)
  }
  const source = 'new.target'
  assert.throws(() => adaptDynamicCell(source, identitySourceMap(source.length), { originalSource: source }), SyntaxError)
})

test('CommonJS syntax preparation retains original new.target locations through dynamic rewriting', () => {
  const source = '"use strict";\nconst value: number=1; const value=2;\nmodule.exports = {target:new.target,value};'
  const types = normalizeTypeScriptValues(source, identitySourceMap(source.length), 'commonjs')
  const normalized = normalizeStatefulScopes(types.code, types.sourceMap, { updates: true, target: 'commonjs' })
  const operations = adaptModuleOperations(normalized, { target: 'commonjs', url: import.meta.url })
  const dynamic = adaptDynamicCell(operations.code, operations.sourceMap, {
    module: true, sourceType: 'commonjs', originalSource: source,
    importOperation: operations.importOperation, bindings: operations.dynamicBindings,
    internalBindings: operations.internalBindings, parserPlugins: CELL_PARSER_PLUGINS,
  })
  for (const result of [operations,dynamic]) {
    const offset = result.code.lastIndexOf('new.target')
    assert.ok(offset >= 0)
    const prefix = result.code.slice(0,offset).split('\n')
    const mapped = mapSourceSpan({ line: prefix.length, column: prefix.at(-1).length + 1 },
      result.code, source, result.sourceMap)
    assert.deepEqual(mapped, { line: 3, column: 26 })
  }
})
