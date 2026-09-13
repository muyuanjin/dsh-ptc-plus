import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { Hash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import path from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { TextDecoder, TextEncoder } from 'node:util'
import { createContext, Script } from 'node:vm'
import { deflateRawSync as nativeDeflate, inflateRawSync as nativeInflate } from 'node:zlib'
import { installCompilerPlatform, compilerPlatformBridge } from '../internal/compiler-platform.js'
import { createPlatform } from '../internal/compiler-platform-factory.js'
import { compilerPlatformRequirements, validateCompilerPlatform } from '../scripts/compiler-platform-contract.mjs'
import { deflateRawSync, inflateRawSync } from '../internal/compiler-compression.js'
import { extractCompilerAssets } from '../scripts/compiler-assets.mjs'

const bundleUrl = new URL('../compiler-core.cjs', import.meta.url)
const bundleSource = readFileSync(bundleUrl, 'utf8')

test('packaged compiler assets preserve exact argument values without retaining data in script literals', () => {
  const value = 'data\ud800\u03bb'.repeat(20_000)
  const literal = JSON.stringify(value)
  const source = `const effect=[];function consume(value){effect.push(value);return value}
    consume(${literal});consume(${literal});
    function shadowed(require){return consume(${literal})};shadowed(()=>{throw Error('source require')});
    [effect.length,effect.every(value=>value===effect[0]),effect[0]]`
  const assets = new Map()
  const output = extractCompilerAssets(source, 'dependency.cjs', assets)
  assert.equal(assets.size, 1)
  let loads = 0
  const result = new Script(output).runInNewContext({ require(name) { loads++; return assets.get(name) } })
  assert.deepEqual(Array.from(result), [3, true, value])
  assert.equal(loads, 2)
  const unchanged = `// Preserve dependency input when no argument is extracted.\nconst data=${literal};\nconsume('small');\n`
  assert.equal(extractCompilerAssets(unchanged, 'dependency.cjs', new Map()), unchanged)
  const context = createContext()
  installCompilerPlatform(context)
  const manifest = JSON.parse(readFileSync(new URL('../compiler-assets.json', import.meta.url), 'utf8'))
  assert.ok(Object.keys(manifest).length > 0)
  for (const [name, file] of Object.entries(manifest)) {
    assert.equal(new Script(`require(${JSON.stringify(name)})`).runInContext(context),
      JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')))
  }
  assert.throws(() => new Script('require("compiler-asset:../package.json")').runInContext(context), /unknown compiler asset/)
})

test('platform dependency contract detects a missing fallback operation without executing user syntax', () => {
  const source = readFileSync(new URL('../internal/cell-parser.js', import.meta.url), 'utf8')
  const requirements = compilerPlatformRequirements(source)
  const platform = createPlatform(compilerPlatformBridge)
  validateCompilerPlatform(platform.require, requirements)
  const module = platform.require('node:module')
  delete module.stripTypeScriptTypes
  assert.throws(() => validateCompilerPlatform(platform.require, requirements), /node:module.stripTypeScriptTypes/)
})

function compilerStart() {
  const context = createContext({ __compilerBaseUrl: new URL('../internal/compiler-service.js', import.meta.url).href,
    __filename: fileURLToPath(bundleUrl), __dirname: path.dirname(fileURLToPath(bundleUrl)), module: { exports: {} } })
  const script = new Script(`${bundleSource}\nmodule.exports.compile`, { displayErrors: false })
  return () => {
    installCompilerPlatform(context)
    return script.runInContext(context, { displayErrors: false })
  }
}

test('compiler platform gives dependencies realm-owned codecs and closed module interfaces', () => {
  const context = createContext()
  installCompilerPlatform(context)
  const result = new Script(`(() => {
    const bytes=Buffer.from('A\\ud800\\u03bb','utf16le');
    const encoded=new TextEncoder().encode('hello');
    const destination=new Uint8Array(8);
    const write=new TextEncoder().encodeInto('hello',destination);
    const map=new (require('node:module').SourceMap)({version:3,sources:['source.js'],names:[],mappings:'AAAA'});
    const types=require('util').types;
    require('assert')(true);
    return JSON.stringify({
      roundtrip:Buffer.from(bytes.toString('base64'),'base64').toString('utf16le'),
      copy:Buffer.from(bytes).toString('base64')===bytes.toString('base64'),
      decoded:new TextDecoder('utf-8',{ignoreBOM:true}).decode(encoded),
      empty:new TextDecoder().decode(new TextEncoder().encode()),
      write, realm:encoded instanceof Uint8Array && bytes instanceof Uint8Array,
      entry:map.findEntry(0,0),origin:map.findOrigin(1,1),
      deprecate:require('util').deprecate(()=>3)(), tty:require('tty').isatty(1),
      checks:[types.isMap(new Map()),types.isSet(new Set()),types.isUint32Array(new Uint32Array()),types.isMap({})],
      url:String(new URL('./space%20name.js','file:///C:/project/main.js')),
      filename:require('url').fileURLToPath(new URL('file:///C:/project%20space/file.js')),
      cwd:typeof process.cwd(),version:process.version, nextTick:typeof process.nextTick,
      basic:Buffer.from('hello').toString()
    });
  })()`).runInContext(context)
  const value = JSON.parse(result)
  assert.equal(value.roundtrip, 'A\ud800\u03bb')
  assert.equal(value.copy, true)
  assert.equal(value.decoded, 'hello')
  assert.equal(value.empty, '')
  assert.deepEqual(value.write, { read: 5, written: 5 })
  assert.equal(value.realm, true)
  assert.equal(value.entry.originalSource, 'source.js')
  assert.equal(value.origin.lineNumber, 1)
  assert.equal(value.deprecate, 3)
  assert.equal(value.tty, false)
  assert.deepEqual(value.checks, [true, true, true, false])
  assert.equal(value.url, 'file:///C:/project/space%20name.js')
  assert.equal(value.filename, fileURLToPath('file:///C:/project%20space/file.js'))
  assert.equal(value.cwd, 'string')
  assert.equal(value.version, process.version)
  assert.equal(value.nextTick, 'undefined')
  assert.equal(value.basic, 'hello')
  for (const expression of ['require("fs").existsSync("package.json")', 'require("fs").readFile("package.json")',
    'require("child_process")', 'require("assert")(false,"failed assertion")',
    'Buffer.from("x","hex")', 'Buffer.from("x").toString("hex")']) {
    assert.throws(() => new Script(expression).runInContext(context), /compiler|assertion/)
  }
})

test('private compiler starts and compiles after public Node platform mutations', () => {
  const filename = 'file:///C:/project%20space/module.ts'
  const source = 'const decorate=C=>C; @decorate class A{value=2}; const p=()=>{}; class B{constructor(@p public value:number){}}; function f(){return new B(new A().value).value};return f()'
  const mutations = [[Buffer, 'from'], [Buffer, 'allocUnsafe'], [Buffer, 'allocUnsafeSlow'],
    [Buffer.prototype, 'toString'], [Buffer.prototype, 'base64Write'], [Buffer.prototype, 'ucs2Write'],
    [Hash.prototype, 'update'], [Hash.prototype, 'digest'], [SourceMap.prototype, 'findEntry'],
    [SourceMap.prototype, 'findOrigin'], [URL.prototype, 'href'], [URL.prototype, 'pathname'],
    [TextEncoder.prototype, 'encode'], [TextDecoder.prototype, 'decode'], [path, 'resolve']]
  for (const [owner, name] of mutations) {
    // Create the VM script before mutation so this probes the compiler's lazy
    // dependency initialization, independently of Node's own Script loader.
    const start = compilerStart()
    const saved = Object.getOwnPropertyDescriptor(owner, name)
    Object.defineProperty(owner, name, { configurable: true, value() { throw new Error(`changed ${name}`) } })
    let prepared, module, restored
    try {
      const compile = start()
      prepared = compile('prepareProgram', [source, { languageSemantics: 'stateful-v1', nativeUsing: false }])
      module = compile('compileStatefulModule', ['export const value:number=3;export function read(){return value}',
        { url: filename, nativeUsing: false }])
      const compressed = compile('deflateText', ['retained\ud800 text'])
      restored = compressed.error === undefined
        ? compile('inflateText', [compressed.value, 64]) : compressed
    } finally { Object.defineProperty(owner, name, saved) }
    assert.equal(prepared.error, undefined, `${name}: ${prepared.error?.message}`)
    assert.equal(module.error, undefined, `${name}: ${module.error?.message}`)
    assert.equal(restored.error, undefined, `${name}: ${restored.error?.message}`)
    assert.equal(restored.value, 'retained\ud800 text')
    assert.equal(typeof prepared.value.code, 'string')
    assert.equal(typeof module.value.code, 'string')
  }
})

test('compiler compression preserves raw DEFLATE interoperability and bounded decoding', () => {
  const bytes = Buffer.from('exact\ud800 source\u03bb'.repeat(100), 'utf16le')
  const encoded = deflateRawSync(bytes)
  assert.deepEqual(nativeInflate(encoded), bytes)
  assert.deepEqual(inflateRawSync(nativeDeflate(bytes)), bytes)
  assert.deepEqual(inflateRawSync(encoded, { maxOutputLength: bytes.length }), bytes)
  for (const maxOutputLength of [0, 1, 32, bytes.length - 1]) {
    assert.throws(() => inflateRawSync(encoded, { maxOutputLength }), RangeError)
  }
  const oversized = nativeDeflate(Buffer.alloc(100000, 65))
  assert.throws(() => inflateRawSync(oversized, { maxOutputLength: 32 }), /declared limit/)
  assert.throws(() => inflateRawSync(Buffer.from([7, 0]), { maxOutputLength: 32 }))
  assert.throws(() => inflateRawSync(Buffer.from([0]), { maxOutputLength: 32 }))
})

test('optional compiler modules can be reclaimed and initialized again in their owning realm', () => {
  const platformUrl = new URL('../internal/compiler-platform.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict';
    import {createContext,Script} from 'node:vm';
    import {setImmediate} from 'node:timers/promises';
    import {installCompilerPlatform} from ${JSON.stringify(platformUrl)};
    const context=createContext();
    installCompilerPlatform(context);
    for(const name of ['amaro','typescript']){
      const compile=new Script(name==='amaro'
        ? 'require("amaro").transformSync("const value:number=42",{mode:"strip-only"}).code'
        : 'require("typescript").transpile("const value:number=42")');
      assert.match(compile.runInContext(context),/value\\s*=\\s*42/);
      const reference=new Script('new WeakRef(require('+JSON.stringify(name)+'))').runInContext(context);
      await setImmediate();
      global.gc();
      assert.equal(reference.deref(),undefined,name+' exports remain pinned');
      assert.match(compile.runInContext(context),/value\\s*=\\s*42/);
    }
  `
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '--eval', source],
    { encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 0, result.stderr)
})

test('first compiler service use retains captured bootstrap and synchronized Node exports', () => {
  const serviceUrl = new URL('../internal/compiler-service.js', import.meta.url).href
  const childSource = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import crypto from 'node:crypto';
    import url from 'node:url';
    import module from 'node:module';
    import util from 'node:util';
    import * as service from ${JSON.stringify(serviceUrl)};
    const mode=process.argv[1];
    const sync=module.syncBuiltinESMExports;
    const define=Object.defineProperty;
    const properties=mode==='prototype'
      ? [[url.URL.prototype,'href'],[url.URL.prototype,'pathname'],[url.URL.prototype,'toString'],
        [vm.Script.prototype,'runInContext'],[Map.prototype,'get'],[Map.prototype,'set'],
        [Map.prototype,'forEach'],[Set.prototype,'add']]
      : [[vm,'createContext'],[vm,'Script'],[crypto,'createHash'],[url,'URL'],
        [url,'fileURLToPath'],[module,'SourceMap'],[module,'stripTypeScriptTypes'],[util,'TextEncoder'],[util,'TextDecoder']];
    const changes=properties.map(([owner,name])=>({owner,name,descriptor:Object.getOwnPropertyDescriptor(owner,name)}));
    const source='const d=C=>C;@d class C{value=2};const p=()=>{};class L{constructor(@p public value:number){}};enum E{A,B};let assigned=0;(assigned as number)=1;function read(){return new L(new C().value).value+E.B};return read()';
    let prepared,compiled,text,diagnostic;
    try {
      for(const {owner,name,descriptor} of changes){
        const poison=()=>{throw new Error('changed '+name)};
        define(owner,name,{configurable:true,...('get' in descriptor?{get:poison}:{value:poison})});
      }
      sync();
      prepared=service.prepareProgram(source,{languageSemantics:'stateful-v1',nativeUsing:false});
      compiled=service.compileModuleSource('export const value:number=3; export function read(){return value}',
        {url:'file:///C:/project%20space/module.ts',nativeUsing:false});
      text=service.inflateText(service.deflateText('source\\ud800 with exact code units'),128);
      try { service.prepareProgram('let =',{languageSemantics:'stateful-v1'}) }
      catch(error){diagnostic=error}
    } finally {
      for(const {owner,name,descriptor} of changes) define(owner,name,descriptor);
      sync();
    }
    assert.equal(typeof prepared.code,'string');
    assert.equal(typeof compiled.code,'string');
    assert.equal(text,'source\\ud800 with exact code units');
    assert.ok(diagnostic instanceof SyntaxError);
    assert.deepEqual(diagnostic.cellPosition??diagnostic.loc,{line:1,column:6});
  `
  for (const mode of ['prototype', 'exports']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource, mode],
      { encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
  }
})
