import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PreflightError,
  classifyDurability,
  prepareProgram,
} from '../internal/cell-analysis.js'
import { rewriteReplRedeclarations } from '../internal/repl-convenience.js'
import { renderDurabilityReasons } from '../internal/module-policy.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { parseExecutableCell } from '../internal/cell-parser.js'

const ENABLED = {
  autoRewriteImports: true,
  autoStripExports: true,
  autoSplitRedeclarations: true,
}

function prepare(code, knownBindings = new Set(), options = {}) {
  return prepareProgram(code, { knownBindings: knownBindings, bindingPolicy: true, reservedBindings: new Set(), rewritesEnabled: { ...ENABLED, ...options } })
}

test('composes TypeScript erasure, module rewrites, REPL lowering, and return control flow', () => {
  const result = prepare(`
import { basename as base } from 'node:path'
export const exportedAnswer: number = 40
const { answer, fresh = 2, nested: { leaf }, ...rest } = {
  answer: 41,
  nested: { leaf: 1 },
  extra: true,
}
try {
  if (fresh > 0) return { name: base('/tmp/example.txt'), exportedAnswer, answer, fresh, leaf, rest }
} catch ({ message }: { message: string }) {
  return message
}
` , new Set(['answer']))

  assert.equal(result.collisions.length, 0)
  assert.deepEqual(result.redeclared.map(item => item.name), ['answer'])
  assert.deepEqual(result.declarations.map(item => item.name), ['base', 'exportedAnswer', 'answer', 'fresh', 'leaf', 'rest'])
  assert.equal(result.durability, 'volatile')
  assert.match(result.reason, /module node:path/)
  assert.doesNotMatch(result.code, /^\s*(?:import|export)\b/m)
  assert.doesNotMatch(result.code, /:\s*(number|string)\b/)
  assert.match(result.code, /throw .*exposeProperty\(this, "__dsh_ptc_return_signal_0__"\)/)
  assert.equal(result.returnSignal, '__dsh_ptc_return_signal_0__')
  assert.deepEqual(result.rewrites.map(item => item.kind), ['import', 'export', 'redeclaration'])
})

test('allocates private import namespaces outside persistent REPL bindings', () => {
  const result = prepare(
    "import { basename } from 'node:path'; return basename('/a/b')",
    new Set(['__dsh_ptc_import_namespace_0__']),
  )
  assert.equal(result.importNamespaces.has('__dsh_ptc_import_namespace_1__'), true)
  assert.equal(result.importNamespaces.has('__dsh_ptc_import_namespace_0__'), false)
  assert.deepEqual(result.redeclared, [])
  assert.match(result.code, /__dsh_ptc_import_namespace_1__/)
  assert.doesNotMatch(result.code, /__dsh_ptc_import_namespace_0__/)
})

test('allocates return control outside persistent REPL bindings', async t => {
  const result = prepare(
    'try { return 1 } catch { return 2 }',
    new Set(['__dsh_ptc_return_signal_0__']),
  )
  assert.equal(result.returnSignal, '__dsh_ptc_return_signal_1__')
  assert.match(result.code, /exposeProperty\(this, "__dsh_ptc_return_signal_1__"\)/)
  assert.doesNotMatch(result.code, /__dsh_ptc_return_signal_0__/)
  assert.doesNotMatch(result.code, /(?:globalThis|throw new __dsh_ptc).*return_signal/)
  const runtime = new SessionRuntime({ legacyBindingSettings: true })
  t.after(() => runtime.dispose())
  const run = program => runtime.run('private-return-control', { program, bindings: [] })
  assert.deepEqual(await run('let __dsh_ptc_return_signal_0__ = 7; return __dsh_ptc_return_signal_0__'), { logs: [], value: 7 })
  assert.deepEqual(await run('try { return 1 } catch { return 2 }'), { logs: [], value: 1 })
  assert.deepEqual(await run('return __dsh_ptc_return_signal_0__'), { logs: [], value: 7 })
})

test('preserves source when module rewrites are disabled and reports the parse boundary', () => {
  assert.throws(
    () => prepareProgram("import value from 'node:path'\nreturn value", { knownBindings: new Set(), bindingPolicy: true, reservedBindings: new Set(), rewritesEnabled: {
      autoRewriteImports: false,
      autoStripExports: true,
      autoSplitRedeclarations: true,
    } }),
    /Unexpected token|Cannot use import statement outside a module|import/,
  )
  assert.throws(
    () => prepareProgram('export const value = 1\nreturn value', { knownBindings: new Set(), bindingPolicy: true, reservedBindings: new Set(), rewritesEnabled: {
      autoRewriteImports: true,
      autoStripExports: false,
      autoSplitRedeclarations: true,
    } }),
    /Unexpected token|Unexpected keyword 'export'|export/,
  )
})

test('requires a complete explicit rewrite policy', () => {
  for (const policy of [undefined, {}, {
    autoRewriteImports: true,
    autoStripExports: true,
  }]) {
    assert.throws(
      () => prepareProgram('return 1', { knownBindings: new Set(), bindingPolicy: true, reservedBindings: new Set(), rewritesEnabled: policy }),
      /rewrite policy must define/,
    )
  }
})

test('requires a complete explicit binding policy', () => {
  for (const policy of [undefined, {}, {
    variableRedeclarations: true,
  }, {
    variableRedeclarations: true,
    functionClassRedeclarations: 'yes',
  }]) {
    assert.throws(
      () => prepareProgram('return 1', { knownBindings: new Set(), bindingPolicy: policy, reservedBindings: new Set(), rewritesEnabled: ENABLED }),
      /binding policy must define/,
    )
  }
})

test('requires supported module lowering semantics', () => {
  assert.throws(
    () => prepareProgram('return 1', { knownBindings: new Set(), bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true }, reservedBindings: new Set(), rewritesEnabled: ENABLED, importBindings: new Map(), importNamespaces: new Set(), writableBindings: new Set(), moduleSemantics: { defaultExportBinding: 'unknown' } }),
    /module semantics must define/,
  )
})

test('assigns distinct commit targets to same-name declaration occurrences', () => {
  const result = prepareProgram('function current() { return 1 }\nfunction current() { return 2 }', { knownBindings: new Set(['current']), bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true }, reservedBindings: new Set(), rewritesEnabled: ENABLED })
  const declarations = result.declarations.filter(declaration => declaration.name === 'current')
  assert.equal(declarations.length, 2)
  assert.equal(new Set(declarations.map(declaration => declaration.commitDependency)).size, 2)
  assert.deepEqual(
    [...result.commitTargets],
    declarations.map(declaration => declaration.commitDependency),
  )
})

test('only lowers fresh const declarations under the variable redeclaration policy', () => {
  const strict = prepareProgram('const stable = 1', { knownBindings: new Set(), bindingPolicy: { variableRedeclarations: false, functionClassRedeclarations: true }, reservedBindings: new Set(), rewritesEnabled: ENABLED })
  assert.match(strict.code, /^const stable = 1;?$/m)
  assert.equal(strict.declarations[0].writable, false)

  const loose = prepareProgram('const replaceable = 1', { knownBindings: new Set(), bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: false }, reservedBindings: new Set(), rewritesEnabled: ENABLED })
  assert.match(loose.code, /^let replaceable = 1;?$/m)
  assert.equal(loose.declarations[0].writable, true)
})

test('selects only the recorded production compiler generation', () => {
  const options = { knownBindings: new Set(['item']), bindingPolicy: true, rewritesEnabled: ENABLED }
  const historical = prepareProgram('let item', options)
  assert.equal(historical.languageSemantics, 'legacy-v1')
  assert.equal(historical.code, prepareProgram('let item', {
    ...options, languageSemantics: 'legacy-v1',
  }).code)
  const current = prepareProgram('const item=1; const item=2; return item', {
    languageSemantics: 'stateful-v1', reservedBindings: new Set(),
  })
  assert.deepEqual(current.collisions, [])
  assert.equal(current.languageSemantics, 'stateful-v1')
  assert.throws(() => prepareProgram('return 1', { languageSemantics: 'unknown' }), /unsupported language semantics/)
})

test('lowers current import.meta against explicit session metadata without publishing its private binding', () => {
  const importMeta = {
    url: 'file:///workspace/repl',
    filename: '/workspace/repl',
    dirname: '/workspace',
  }
  for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
    for (const meta of ['import.meta', 'import . meta', 'import/*comment*/.meta', 'import\n.meta']) {
      const prepared = prepareProgram(`const first = ${meta}; return first === ${meta} && new URL('./asset', first.url).href`, {
        languageSemantics,
        importMeta,
      })
      assert.equal(prepared.code.includes('import.meta'), false)
      assert.deepEqual([...prepared.declared], ['first'])
      assert.match(prepared.code, /__proto__:\s*null/)
      assert.match(prepared.code, /file:\/\/\/workspace\/repl/)
    }
  }
  assert.throws(
    () => prepare('return import.meta.url'),
    /import\.meta may appear only with 'sourceType: "module"'/,
  )
  assert.throws(
    () => prepareProgram('return import.meta.url', { languageSemantics: 'stateful-v1' }),
    error => {
      assert.equal(error.message, 'import.meta requires the session module base')
      assert.deepEqual(error.cellPosition, { line: 1, column: 8 })
      return true
    },
  )
  assert.throws(
    () => prepareProgram('function f(){}; return import.meta.url', { languageSemantics: 'stateful-v1' }),
    error => {
      assert.equal(error.message, 'import.meta requires the session module base')
      assert.deepEqual(error.cellPosition, { line: 1, column: 24 })
      return true
    },
  )
  assert.throws(
    () => prepareProgram('return import.meta.url + missing(', {
      languageSemantics: 'stateful-v1',
      importMeta,
    }),
    error => {
      assert.deepEqual(error.cellPosition, { line: 1, column: 34 })
      return true
    },
  )
})

test('classifies source-owned top-level this without treating compiler transports as ambient input', () => {
  const options = {
    languageSemantics: 'stateful-v1', knownBindings: new Set(), reservedBindings: new Set(),
    bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
    rewritesEnabled: ENABLED,
  }
  assert.equal(prepareProgram('import { inspect } from "node:util"; const kind = typeof inspect', options).durability,
    'durable')
  const collision = prepareProgram('const value = this["__dsh_ptc_root_runtime_0__"]', options)
  assert.equal(collision.durability, 'volatile')
  assert.equal(collision.reason, 'ambient globalThis')
})

test('module durability uses native import scope and checks every static dependency', () => {
  const module = { sourceType: 'module' }
  for (const source of [
    'import {parse as Date} from "node:url"; export const value=Date',
    'export {parse} from "node:url"',
    'export * from "node:url"',
    'export default class Named {}',
    'export default function () { return 1 }',
  ]) assert.equal(classifyDurability(source, new Set(), module).durability, 'durable', source)
  assert.deepEqual(classifyDurability('export default () => Date.now()', new Set(), module).reasons,
    [{ kind: 'ambient', name: 'Date' }])
  assert.deepEqual(classifyDurability('export * from "node:fs"', new Set(), module).reasons,
    [{ kind: 'module', source: 'node:fs' }])
  assert.throws(() => classifyDurability('export * from "node:worker_threads"', new Set(), module), /forbidden/)
})

test('keeps the compatibility path when no parsed body is available', () => {
  const result = rewriteReplRedeclarations({
    code: 'return 1',
    body: undefined,
    knownBindings: new Set(['value']),
    declarations: [{ name: 'value' }],
    declarationSpan: () => ({ line: 0, column: 1 }),
    collisionFor: declaration => ({ name: declaration.name }),
    bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
    autoSplitRedeclarations: true,
  })
  assert.equal(result.executableCode, 'return 1')
  assert.deepEqual(result.collisions, [{ name: 'value' }])
  assert.deepEqual(result.redeclared, [])
  assert.deepEqual(result.rewrites, [])
})

test('preserves the async function body grammar through module preprocessing', () => {
  for (const code of [
    'with ({ x: 1 }) { return x }',
    'return 010',
    'function f(a, a) {}; return f',
    'var eval = 1; return eval',
    "import type { A } from 'pkg'; with ({ x: 1 }) { return x }",
  ]) {
    assert.doesNotThrow(() => prepare(code), code)
  }
})

test('classifies ambient, module, and shadowed names from AST scope', () => {
  const scoped = classifyDurability(`
const localProcess = process
function usesLocals(process, Math, Date) {
  return [process.cwd(), Math.random(), Date.now()]
}
{
  const process = { platform: 'test' }
  const Math = { random: () => 1 }
  void usesLocals(process, Math, Date)
}
`)
  assert.equal(scoped.durability, 'volatile')
  assert.match(renderDurabilityReasons(scoped.reasons), /ambient process/)
  assert.match(renderDurabilityReasons(scoped.reasons), /ambient Date/)
  assert.deepEqual(scoped.declared, new Set(['localProcess', 'usesLocals']))

  const durable = classifyDurability(`
function stable(Date, process, require) { return [Date.now(), process.cwd(), require('node:util')] }
const value = Math.max(1, 2)
`)
  assert.equal(durable.durability, 'durable')
  assert.deepEqual(durable.reasons, [])

  assert.equal(classifyDurability("await import('node:path')").durability, 'volatile')
  assert.deepEqual(classifyDurability("await import('node:path')").reasons, [
    { kind: 'module', source: 'node:path' },
  ])
  for (const source of [
    'globalThis.Date.now()',
    'globalThis["crypto"].randomUUID()',
    'globalThis.process.env.HOME',
    'globalThis.Math.random()',
  ]) {
    assert.equal(classifyDurability(source).durability, 'volatile', source)
  }
  assert.equal(classifyDurability('globalThis.Math.max(1, 2)').durability, 'durable')
  assert.equal(classifyDurability('function local(globalThis) { return globalThis.Date.now() }').durability, 'durable')
  assert.throws(() => classifyDurability("await import('node:worker_threads')"), PreflightError)
  assert.throws(() => classifyDurability("require('node:worker_threads')"), PreflightError)
})

test('recognizes Annex B function bindings without merging lexical scopes or parameter environments', () => {
  const bodies = [
    'if (true) { function process() { return 1 } }',
    'if (false) { function process() { return 1 } }',
    'if (true) function process() { return 1 }',
    'label: function process() { return 1 }',
    '{ label: function process() { return 1 } }',
    'while (false) { function process() { return 1 } }',
    'for (const value of [1]) { function process() { return value } }',
    'switch (1) { case 1: function process() { return 1 } }',
    'switch (1) { case 0: break; default: function process() { return 1 } }',
    'try { throw 1 } catch (process) { { function process() { return 1 } } }',
    'try {} catch { function process() { return 1 } }',
    '{ let process; } { function process() { return 1 } }',
    'function process() { return 1 }',
  ]
  for (const body of bodies) {
    const source = `function f() { ${body}; return process } const saved = f()`
    assert.equal(classifyDurability(source).durability, 'durable', source)
  }
  for (const source of [
    'const f = () => { { function process() {} }; return process }',
    'const f = function () { { function process() {} }; return process }',
    'async function f() { { function process() {} }; return process }',
    'function* f() { { function process() {} }; return process }',
    'const f = { method() { { function process() {} }; return process } }',
    'function f() { "use\\x20strict"; { function process() {} }; return process }',
    'function f(process = 1) { { function process() {} }; return process }',
    'function f(value = () => 1) { { function process() {} }; return process }',
    'function f(value = () => { { function process() {} }; return process }) { return value }',
    'function f() { "use strict"; function process() {}; return process }',
    'function f() { "use strict"; { function process() {}; return process } }',
    'function f() { { function require() {}; } return require("node:worker_threads") }',
  ]) assert.equal(classifyDurability(source).durability, 'durable', source)
})

test('does not hoist block functions through strict, lexical, class or nested function boundaries', () => {
  for (const source of [
    'function f() { "use strict"; { function process() {} }; return process }',
    '"use strict"; function f() { { function process() {} }; return process }',
    'function outer() { "use strict"; return function f() { { function process() {} }; return process } }',
    'class C { method() { { function process() {} }; return process } }',
    'class C { static { { function process() {} }; process } }',
    'class C { field = () => { { function process() {} }; return process } }',
    'class C extends (function () { { function process() {} }; return process })() {}',
    'function f() { { async function process() {} }; return process }',
    'function f() { { function* process() {} }; return process }',
    'function f() { { let process; { function process() {} } }; return process }',
    'function f() { { const process = 1; { function process() {} } }; return process }',
    'function f() { { class process {}; { function process() {} } }; return process }',
    'function f() { { function* process() {}; { function process() {} } }; return process }',
    'function f() { for (let process of [1]) { function process() {} }; return process }',
    'function f() { for (const process in {}) { function process() {} }; return process }',
    'function f() { for (let process = 0; false;) { function process() {} }; return process }',
    'function f() { switch (1) { case 1: let process; { function process() {} } }; return process }',
    'function f() { try { throw {} } catch ({ process }) { { function process() {} } }; return process }',
    'function f() { try { throw [] } catch ([process]) { { function process() {} } }; return process }',
    'function f() { function nested() { { function process() {} } }; return process }',
    'function f() { class C { static { function process() {} } }; return process }',
    'function f(value = process) { { function process() {} }; return value }',
    'function f(value = () => process) { { function process() {} }; return value }',
    'function f(value = process) { function process() {}; return value }',
  ]) {
    const classified = classifyDurability(source)
    assert.equal(classified.durability, 'volatile', source)
    assert.deepEqual(classified.reasons, [{ kind: 'ambient', name: 'process' }], source)
  }
})

test('uses one structured module classification across static, dynamic, and require forms', () => {
  const source = 'package,with-comma'
  const prepared = [
    prepare(`import ${JSON.stringify(source)}`),
    prepare(`await import(${JSON.stringify(source)})`),
    prepare(`require(${JSON.stringify(source)})`),
  ]
  for (const classification of prepared) {
    assert.equal(classification.durability, 'volatile')
    assert.equal(classification.reason, `module ${source}`)
  }
  assert.deepEqual(classifyDurability('await import(moduleName)').reasons, [
    { kind: 'dynamic-module-resolution' },
  ])
  assert.deepEqual(classifyDurability('require(moduleName)').reasons, [
    { kind: 'dynamic-module-resolution' },
  ])
  assert.deepEqual(classifyDurability('function local(require) { return require(moduleName) }').reasons, [])
})

test('renders the computed-global durability reason', () => {
  assert.equal(renderDurabilityReasons([{ kind: 'computed-global-access' }]), 'computed global access')
})

test('classifies global-object aliases and escapes without treating local shadows as ambient inputs', () => {
  for (const source of [
    'global.Date.now()',
    'global["crypto"].randomUUID()',
    'global.Math.random()',
    'global.globalThis.Date.now()',
    'globalThis.global.Date.now()',
    'const root = global; root.Date.now()',
    'const { Date: Clock } = globalThis; Clock.now()',
    'const { process: hostProcess } = global; hostProcess.cwd()',
    'const math = globalThis.Math; math.random()',
    'const math = global.Math; math.random()',
    'const math = Math; math.random()',
    'const { random } = Math; random()',
    'globalThis.Math[key]()',
    'class Local { static { var global = {} } }; global.Date.now()',
    'function local(value = global.Date.now()) { var global = {}; return value }',
    'function local() { { function global() {} }; return globalThis.Date.now() }',
    'switch (global.Date.now()) { case 1: const global = {} }',
  ]) assert.equal(classifyDurability(source).durability, 'volatile', source)
  for (const source of [
    'function local(global) { return global.Date.now() }',
    'const globalThis = { Date: { now: () => 1 } }; globalThis.Date.now()',
    'if (true) { var global = { Date: { now: () => 1 } } }; global.Date.now()',
    '{ const global = { Date: { now: () => 1 } }; global.Date.now() }',
    'global.Math.max(1, 2)',
    'globalThis.Math["max"](1, 2)',
    'class Local { static { var global = { Date: { now: () => 1 } }; global.Date.now() } }',
    'function local() { if (true) { var global = { Date: { now: () => 1 } } }; return global.Date.now() }',
    'const Local = class global { static Date = { now: () => 1 }; static value = global.Date.now() }',
    'switch (1) { case 1: const global = { Date: { now: () => 1 } }; global.Date.now() }',
  ]) assert.equal(classifyDurability(source).durability, 'durable', source)
})

test('classifies only script-level this and its lexical captures as the REPL global', () => {
  for (const source of [
    'this',
    'this.Date.now()',
    'const read = () => this.Math.random(); read()',
    'const outer = () => () => this.process; outer()()',
  ]) assert.deepEqual(classifyDurability(source).reasons,
    [{ kind: 'ambient', name: 'globalThis' }], source)

  for (const source of [
    'function read() { return this }',
    'const read = function () { return this.Date }',
    'const value = { read() { return this.Date } }',
    'class Value { read() { return this.Date } }',
  ]) assert.equal(classifyDurability(source).durability, 'durable', source)

  assert.equal(classifyDurability('export const value = this', new Set(), { sourceType: 'module' }).durability,
    'durable')
})

test('classifies source-owned this without treating decorator output as ambient input', () => {
  const prepareStateful = source => prepareProgram(source, {
    languageSemantics: 'stateful-v1', knownBindings: new Set(), reservedBindings: new Set(),
    bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
  })
  for (const source of [
    'const decorate = value => value; @decorate class Value {}',
    'const decorate = value => value; class Value { @decorate method() {} }',
    'const decorate = value => value;\r\nconst marker = "\ud83c\udf1f";\r\n@decorate class Value {}',
  ]) assert.equal(prepareStateful(source).durability, 'durable', source)

  for (const source of [
    'const decorate = value => value; @decorate class Value {}; this',
    'const decorate = value => value; @decorate class Value {}; const read = () => this',
  ]) assert.deepEqual(prepareStateful(source).reasons,
    [{ kind: 'ambient', name: 'globalThis' }], source)
})

test('normalizes executable AST ranges and parser failures to the cell source', () => {
  for (const separator of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const source = `const first = /x/;${separator}const second: number = 2`
    const parsed = parseExecutableCell(source, { eraseTypes: true })
    const second = parsed.body.body[1]
    assert.equal(second.start, source.indexOf('const second'))
    assert.equal(second.loc.start.line, 2)
    assert.equal(second.loc.start.column, 0)
    assert.equal(second.loc.end.line, 2)
    assert.equal(second.declarations[0].id.loc.start.line, 2)
    assert.equal(second.declarations[0].init.loc.end.line, 2)
    assert.equal(parsed.code.length, source.length)
    assert.equal(parsed.body.start, 0)
    assert.equal(parsed.body.end, source.length)
  }
  assert.throws(() => parseExecutableCell('return ('), error => {
    assert.deepEqual(error.cellPosition, { line: 1, column: 9 })
    assert.doesNotMatch(error.message, /\(\d+:\d+\)/)
    return true
  })
})

test('maps rewritten parser failures through original module positions', () => {
  for (const [source, line] of [
    ['import type { T } from "./t"; enum E { A }', 1],
    ['import type { T } from "./t"; /*字*/ enum E { A }', 1],
    ['import type { T } from "./t";\r\n enum E { A }', 2],
    ['import type { T } from "./t";\u2028 enum E { A }', 2],
  ]) {
    const column = source.split(/\r\n|[\n\r\u2028\u2029]/u).at(-1).indexOf('enum') + 1
    assert.throws(() => prepare(source), error => {
      assert.deepEqual(error.cellPosition, { line, column })
      assert.doesNotMatch(error.message, /\(\d+:\d+\)/)
      return true
    })
  }
})

test('maps normalization failures through every completed source preparation stage', () => {
  for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
    for (const declaration of [
      'function f(){return 1}',
      'enum E { A=1 }',
      'namespace N { export const x=1 }',
    ]) {
      for (const ending of ['', '\n', '\r\n', '\r', '\u2028', '\u2029']) {
        const source = `"use strict";${ending}${declaration};${ending}delete foo`
        const before = source.slice(0, source.indexOf('delete'))
        const lines = before.split(/\r\n|[\n\r\u2028\u2029]/u)
        assert.throws(() => prepareProgram(source, { languageSemantics }), error => {
          assert.deepEqual(error.cellPosition, { line: lines.length, column: lines.at(-1).length + 1 })
          return true
        })
      }
    }
  }
})

test('maps forbidden dynamic module references to submitted positions and names their form', () => {
  for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
    for (const [expression, form, span] of [
      ["await import('node:worker_threads')", 'import', { line: 3, column: 20, end: { line: 3, column: 41 } }],
      ["require('node:worker_threads')", 'require', { line: 3, column: 15, end: { line: 3, column: 36 } }],
    ]) {
      const source = `function marked(){return 1}\nenum E { A=1 }\ntry { ${expression} } catch {}`
      assert.throws(() => prepareProgram(source, { languageSemantics }), error => {
        assert.deepEqual(error.span, span)
        assert.match(error.message, new RegExp(`cell ${form} of node:worker_threads is forbidden`))
        return true
      })
    }
  }
})

test('returns one preparation shape for successful, policy-colliding and reserved declarations', () => {
  const options = { bindingPolicy: true, rewritesEnabled: ENABLED }
  const success = prepareProgram('const value = 1; return value', options)
  const protectedCollision = prepareProgram('const value = 1', {
    ...options, knownBindings: new Set(['value']), bindingPolicy: false,
  })
  const reservedCollision = prepareProgram('const tools = 1', {
    ...options, reservedBindings: new Set(['tools']),
  })
  assert.ok(success.nativeLexicals.has('value'))
  for (const rejected of [protectedCollision, reservedCollision]) {
    assert.deepEqual(Object.keys(rejected).sort(), Object.keys(success).sort())
    assert.equal(rejected.collisions.length, 1)
    assert.equal(rejected.returnSignal, undefined)
    assert.ok(rejected.commitTargets instanceof Set)
    assert.ok(Array.isArray(rejected.sourceMap))
    assert.deepEqual(rejected.nativeLexicals, new Set())
  }
  assert.throws(() => prepareProgram(null, options), /program must be a string/)
})

test('keeps return rewriting at the cell boundary across every catch binding shape', () => {
  const result = prepare(`
function nested() { return 'nested' }
const arrow = () => { return 'arrow' }
try {
  throw { value: 7 }
} catch (error) {
  if (error.value) return nested()
}
try {
  throw { value: 8 }
} catch ({ value }) {
  return value
}
try {
  throw 9
} catch {
  return arrow()
}
`)
  const body = parseExecutableCell(result.code).body.body
  const nested = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'nested')
  const arrow = body.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations).find(node => node.id.name === 'arrow').init
  assert.equal(nested.body.body.at(-1).type, 'ReturnStatement')
  assert.equal(arrow.body.body.at(-1).type, 'ReturnStatement')
  assert.equal(nested.body.body.at(-1).argument.value, 'nested')
  assert.equal(arrow.body.body.at(-1).argument.value, 'arrow')
  assert.doesNotMatch(result.code, /catch \(error\) \{\s*return/)
  assert.match(result.code, /__dsh_ptc_caught_1__/)
  assert.match(result.code, /__dsh_ptc_caught_2__/)
})

test('allocates return-control catch bindings hygienically', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  t.after(() => runtime.dispose())
  const result = await runtime.run('hygienic-return', {
    program: 'try { return 1 } catch { let __dsh_ptc_caught_0__ }',
    bindings: [],
  })
  assert.deepEqual(result, { logs: [], value: 1 })
})

test('executes returns in switch clauses and labeled control flow', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  t.after(() => runtime.dispose())

  assert.deepEqual(await runtime.run('switch-return', {
    program: `
switch (2) {
  case 1: return 'wrong'
  case 2: return 'selected'
  default: return 'fallback'
}
`,
    bindings: [],
  }), { logs: [], value: 'selected' })

  assert.deepEqual(await runtime.run('labeled-return', {
    program: `
outer: for (const value of [1, 2]) {
  for (const nested of [10]) {
    if (value === 2) break outer
    void nested
  }
}
return 'continued'
`,
    bindings: [],
  }), { logs: [], value: 'continued' })
})
