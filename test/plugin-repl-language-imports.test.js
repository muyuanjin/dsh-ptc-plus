import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  appendRunCodeEvents,
  fixture as pluginFixture,
  orderedSurfaceSession,
  ptcAgent,
} from './plugin-fixture.js'

const fixture = (config = {}, ...args) => pluginFixture({ ...config, legacyBindingSettings: config.bindingUpdates === undefined }, ...args)

test('updates imported and control-flow var names without cross-cell lexical collisions', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())

  const repeatedImport = 'repeated-import-update'
  assert.equal((await state.run(repeatedImport,
    "import { basename as item } from 'node:path'; return item('/a/b')")).value, 'b')
  assert.equal((await state.run(repeatedImport,
    "import { basename as item } from 'node:path'; return item('/a/c')")).value, 'c')

  const varUpdate = 'control-flow-var-update'
  assert.equal((await state.run(varUpdate,
    'if (true) { var item = 1 }; return item')).value, 1)
  assert.equal((await state.run(varUpdate,
    'let item = 2; return item')).value, 2)
  assert.equal((await state.run(varUpdate,
    'if (true) { var item = 3 }; return item')).value, 3)
})

test('replaces an import alias with a function that later cells resolve locally', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())

  const sessionId = 'import-function-replacement'
  const first = await state.run(sessionId,
    "import { basename as item } from 'node:path'; const old = () => item('/a/b'); return [item('/c/d'), old()]")
  assert.deepEqual(first.value, ['d', 'b'])

  const replaced = await state.run(sessionId,
    'function item(value) { return `fn:${value}` }; return [item("x"), old()]')
  assert.deepEqual(replaced.value, ['fn:x', 'fn:/a/b'])

  // Later cells read the local function instead of the retired alias.
  assert.deepEqual((await state.run(sessionId, 'return [item("y"), old()]')).value, ['fn:y', 'fn:/a/b'])

  // A second replacement updates the identity read by older closures.
  assert.equal((await state.run(sessionId, 'function item(value) { return `fn2:${value}` }; return item("z")')).value, 'fn2:z')
  assert.deepEqual((await state.run(sessionId, 'return [item("w"), old()]')).value, ['fn2:w', 'fn2:/a/b'])
})

test('replaces an import alias with a class that later cells construct', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())

  const sessionId = 'import-class-replacement'
  assert.equal((await state.run(sessionId,
    "import { basename as item } from 'node:path'; const old = () => item; return old()('/a/b')")).value, 'b')
  assert.deepEqual((await state.run(sessionId,
    'class item { constructor(value) { this.value = value } }; return [new item(3).value, old() === item]')).value, [3, true])
  assert.equal((await state.run(sessionId, 'return new item(4).value')).value, 4)
  assert.equal((await state.run(sessionId,
    "class item { m() { return 'base' } }; class child extends item {}; return new child().m()")).value, 'base')
})

test('keeps declared function forms and their identity through alias replacement', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())

  const recursive = 'import-identity-recursive'
  await state.run(recursive, "import { basename as item } from 'node:path'; return item('/a/b')")
  assert.deepEqual((await state.run(recursive,
    'function item(n) { return n <= 0 ? 0 : n + item(n - 1) }; return [item(3), item.name, item.length]')).value,
  [6, 'item', 1])

  const generator = 'import-identity-generator'
  await state.run(generator, "import { basename as item } from 'node:path'; return item('/a/b')")
  assert.deepEqual((await state.run(generator, "function* item() { yield 'gen' }; return [...item()]")).value, ['gen'])
  assert.deepEqual((await state.run(generator, 'return [...item()]')).value, ['gen'])

  const asyncGenerator = 'import-identity-async-generator'
  await state.run(asyncGenerator, "import { basename as item } from 'node:path'; return item('/a/b')")
  assert.deepEqual((await state.run(asyncGenerator,
    "async function* item() { yield 'a' }; const out = []; for await (const value of item()) out.push(value); return out")).value, ['a'])

  const asyncFunction = 'import-identity-async-function'
  await state.run(asyncFunction, "import { basename as item } from 'node:path'; return item('/a/b')")
  assert.equal((await state.run(asyncFunction, "async function item() { return 'async' }; return await item()")).value, 'async')
})

test('retires an alias only when the replacing declaration actually runs', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())

  const thrown = 'import-replacement-throws'
  await state.run(thrown, "import { basename as item } from 'node:path'; return item('/a/b')")
  const failed = await state.run(thrown, "throw new Error('boom'); function item() { return 'local' }")
  assert.equal(failed.error.kind, 'exception')
  assert.equal((await state.run(thrown, "return item('/a/c')")).value, 'c')

  const returned = 'import-replacement-returns-early'
  await state.run(returned, "import { basename as item } from 'node:path'; return item('/a/b')")
  assert.equal((await state.run(returned, "if (true) return 1; function item() { return 'local' }")).value, 1)
  assert.equal((await state.run(returned, "return item('/a/c')")).value, 'c')

  // A replacement after the restored alias behaves like a first replacement.
  assert.equal((await state.run(returned, "function item() { return 'later' }; return item()")).value, 'later')
  assert.equal((await state.run(returned, 'return item()')).value, 'later')
})

test('keeps imported alias identity across re-imports and namespace aliases', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())

  const reimported = 'import-replacement-then-reimport'
  await state.run(reimported, "import { basename as item } from 'node:path'; return item('/a/b')")
  assert.equal((await state.run(reimported, "function item() { return 'local' }; return item()")).value, 'local')
  assert.equal((await state.run(reimported, "import { basename as item } from 'node:path'; return item('/a/c')")).value, 'c')
  assert.equal((await state.run(reimported, "return item('/a/d')")).value, 'd')

  const namespace = 'import-namespace-replacement'
  assert.equal((await state.run(namespace,
    "import * as item from 'node:path'; return item.basename('/a/b')")).value, 'b')
  assert.equal((await state.run(namespace, "function item() { return 'local' }; return item()")).value, 'local')
  assert.equal((await state.run(namespace, 'return item()')).value, 'local')
})

test('keeps default export exposure working across an alias replacement', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const sessionId = 'import-replacement-default-export'
  await state.run(sessionId, "import { basename as item } from 'node:path'; return item('/a/b')")
  assert.equal((await state.run(sessionId,
    "function item() { return 'local' }; export default item; return __default()")).value, 'local')
})

test('keeps bare declarations of imported aliases live without creating phantom locals', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const sessionId = 'bare-import-preserves-alias'
  assert.equal((await state.run(sessionId,
    "import { basename as item } from 'node:path'; const item; return item('/a/b')")).value, 'b')
  assert.equal((await state.run(sessionId, 'return item("/a/c")')).value, 'c')
})

test('allows default export and bare const updates in stateful cells', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())

  const sessionId = 'default-and-bare-const-update'
  assert.equal((await state.run(sessionId, 'let __default = 1; return __default')).value, 1)
  assert.equal((await state.run(sessionId, 'export default 2; return __default')).value, 2)
  const bareSession = 'bare-const-update'
  assert.equal((await state.run(bareSession, 'const value = 3; return value')).value, 3)
  assert.equal((await state.run(bareSession, 'const value; return value')).value, 3)
})

test('replaces aliases independently across default, named, and synthetic forms', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())

  const pair = 'import-replacement-two-aliases'
  assert.deepEqual((await state.run(pair,
    "import { basename as a, sep as b } from 'node:path'; const readB = () => b; return [a('/x/y'), b]")).value,
  ['y', sep])
  assert.deepEqual((await state.run(pair, "function a() { return 'A1' }; return [a(), b, readB()]")).value,
    ['A1', sep, sep])
  // Replacing one alias leaves its sibling following the module.
  assert.deepEqual((await state.run(pair, 'return [a(), b]')).value, ['A1', sep])
  assert.deepEqual((await state.run(pair, "function b() { return 'B1' }; return [a(), b(), readB() === b]")).value,
    ['A1', 'B1', true])
  assert.deepEqual((await state.run(pair, 'return [a(), b()]')).value, ['A1', 'B1'])

  const mixed = 'import-replacement-default-and-named'
  assert.deepEqual((await state.run(mixed,
    "import def, { basename as item } from 'node:path'; return [typeof def, item('/x/y')]")).value, ['object', 'y'])
  assert.deepEqual((await state.run(mixed, "function item() { return 'named' }; return [typeof def, item()]")).value,
    ['object', 'named'])

  const defaultOnly = 'import-replacement-default-only'
  assert.equal((await state.run(defaultOnly, "import item from 'node:path'; return typeof item")).value, 'object')
  assert.equal((await state.run(defaultOnly, "function item() { return 'replaced' }; return item()")).value, 'replaced')

  const synthetic = 'import-replacement-synthetic-default'
  assert.equal((await state.run(synthetic, 'export default 1; return __default')).value, 1)
  assert.equal((await state.run(synthetic,
    'class __default { static value() { return 2 } }; return __default.value()')).value, 2)
  assert.equal((await state.run(synthetic, 'return __default.value()')).value, 2)
})

test('keeps compiler namespace captures independent from source-level names', async (t) => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const sessionId = 'compiler-namespace-reserved'
  await state.run(sessionId, "import { basename as item } from 'node:path'; return item('/x/y')")
  const collision = await state.run(sessionId,
    'function __dsh_ptc_import_namespace_0__() { return 1 }; return __dsh_ptc_import_namespace_0__()')
  assert.equal(collision.value, 1)
  assert.equal((await state.run(sessionId, "return item('/x/z')")).value, 'z')
})

test('preserves statement boundaries for anonymous default declarations', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const fn = await state.run('default-anonymous-function', [
    'let markers = 0',
    'export default function () {}',
    '(function marker(){ markers += 1 })()',
    'return [typeof __default, markers]',
  ].join('\n'))
  assert.deepEqual(fn.value, ['function', 1])

  const klass = await state.run('default-anonymous-class', [
    'let markers = 0',
    'export default class {}',
    '[1].forEach(() => { markers += 1 })',
    'return [typeof __default, markers]',
  ].join('\n'))
  assert.deepEqual(klass.value, ['function', 1])

  const expression = await state.run(
    'default-expression-continuation', 'export default (() => () => 7)\n()\nreturn __default()',
  )
  assert.equal(expression.value, 7)

  const throwing = await state.runDurable(
    'default-anonymous-position', 'export default function () {}\nthrow new Error("boom")',
  )
  assert.deepEqual(throwing.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 2, column: 7 },
  })
})

test('erases multiline type-only export declarations completely', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const code = [
    'export type Shape = {',
    '  width: number',
    '}',
    'export interface Named {',
    '  name: string',
    '}',
    'export type Simple = string',
    'return 1',
  ].join('\n')
  const result = await state.runDurable('export-type-multiline', code, {}, { session: { events: [] } })
  assert.equal(result.isError, false)
  assert.equal(result.value, 1)
})

test('removes entire inline type-only import specifiers', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const code = [
    "import { type Options, basename } from 'node:path'",
    "import { type Alias as Renamed, join } from 'node:path'",
    "import { dirname, type Extra } from 'node:path'",
    "return [basename('/a/b'), join('/a', 'c'), dirname('/a/d'), typeof Options, typeof Renamed, typeof Extra]",
  ].join('\n')
  const result = await state.runDurable('inline-type-specifier', code, {}, { session: { events: [] } })
  assert.deepEqual(result.value, [
    'b',
    process.platform === 'win32' ? '\\a\\c' : '/a/c',
    '/a',
    'undefined',
    'undefined',
    'undefined',
  ])
})

test('preserves import attributes in rewritten dynamic imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  // 模块不存在/属性不匹配是执行期错误（X001），不是解析错误——证明转换
  // 后的语法与 attributes 尾巴都正确
  const code = [
    "import data from './data.json' with { type: 'json' }",
    "import * as ns from 'node:path' with { type: 'x' }",
    'return [typeof data, typeof ns.basename]',
  ].join('\n')
  const result = await state.runDurable('import-attributes', code, {}, { session: { events: [] } })
  assert.equal(result.isError, true)
  assert.doesNotMatch(result.error.message, /PTC-C001/)
  assert.match(result.error.message, /PTC-X001/)
})

test('fails safe when an export shape is unrecognized and when disabled', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const broken = await state.runDurable(
    'export-broken', 'export\nreturn 1', {}, { session: { events: [] } },
  )
  assert.equal(broken.isError, true)
  assert.match(broken.error.message, /PTC-C001/)
  assert.deepEqual(
    await state.run('export-member', 'const o = { export: 7 }\nreturn o.export'),
    { logs: [], value: 7 },
  )
  const bare = await state.runDurable(
    'export-bare', 'export { a, b }', {}, { session: { events: [] } },
  )
  assert.equal(bare.isError, true)
  assert.match(bare.error.message, /PTC-C001/)
  const malformedType = await state.runDurable(
    'export-malformed', 'export type Bad = }', {}, { session: { events: [] } },
  )
  assert.equal(malformedType.isError, true)
  assert.match(malformedType.error.message, /PTC-C001/)
  const semiType = await state.runDurable(
    'export-malformed', 'export type Simple = string;\nreturn 1', {}, { session: { events: [] } },
  )
  assert.equal(semiType.isError, false)
  assert.equal(semiType.value, 1)
  const inlineType = await state.runDurable(
    'export-malformed', 'export type Shape = { a: number }', {}, { session: { events: [] } },
  )
  assert.equal(inlineType.isError, false)
  const openAttributes = await state.runDurable(
    'export-malformed', "import x from 'node:util' with { a: 1\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(openAttributes.isError, true)
  assert.match(openAttributes.error.message, /PTC-C001/)
  for (const shape of ['export default class NoBody', 'export default']) {
    const rejected = await state.runDurable('export-malformed', shape, {}, { session: { events: [] } })
    assert.equal(rejected.isError, true)
    assert.match(rejected.error.message, /PTC-C001/)
  }
  const typeSideEffect = await state.runDurable(
    'export-type-side', "import type 'node:util'\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(typeSideEffect.isError, true)
  assert.match(typeSideEffect.error.message, /PTC-C001/)
  const badAttributes = await state.runDurable(
    'export-bad-attrs', "import x from 'node:util' whatever\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(badAttributes.isError, true)
  assert.match(badAttributes.error.message, /PTC-C001/)
  const disabled = fixture({ autoStripExports: false })
  t.after(() => disabled.dispose())
  const rejected = await disabled.runDurable(
    'export-disabled', 'export const value = 1\nreturn value', {}, { session: { events: [] } },
  )
  assert.equal(rejected.isError, true)
  assert.match(rejected.error.message, /PTC-C001/)
})

test('keeps successful rewrite provenance out of runtime contexts', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const codeOnlyAssembly = {
    sections: [
      { name: 'tools:code-only', text: '`run_code` is the only tool you can call directly.' },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }
  const session = orderedSurfaceSession('export-feedback-session', [
    { type: 'turn/start', seq: 0, time: 0, data: {} },
  ])
  const agent = ptcAgent(`${session.id}-agent`, session)
  const code = 'export const exportedValue = 1\nreturn exportedValue'
  const observed = await state.runDurable(session.id, code, {}, { session, recordSession: 'deferred-result', callId: 'export-feedback-cell' })
  assert.match(
    observed.meta.dshPtcPlusRewrites[0].description,
    /stripped the export modifier from a top-level declaration/,
  )
  appendRunCodeEvents(session.events, 'export-feedback-cell', code, observed)
  const assembly = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  assert.equal(assembly.contexts.some(item => item?.name === 'tools:ptc-plus-rewrite-info'), false)
  const reexportCode = "export { basename } from 'node:path'\nreturn 1"
  const reexport = await state.runDurable(session.id, reexportCode, {}, { session, recordSession: 'deferred-result', callId: 'export-feedback-reexport' })
  assert.match(
    reexport.meta.dshPtcPlusRewrites[0].description,
    /converted the re-export of "node:path" into a side-effect import/,
  )
  appendRunCodeEvents(session.events, 'export-feedback-reexport', reexportCode, reexport)
  const updated = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  assert.equal(updated.contexts.some(item => item?.name === 'tools:ptc-plus-rewrite-info'), false)

  const erasedCode = "import type { A } from 'pkg'\nexport type B = A\nreturn 1"
  const erased = await state.runDurable(session.id, erasedCode, {}, { session, recordSession: 'deferred-result', callId: 'export-feedback-erased' })
  assert.deepEqual(
    erased.meta.dshPtcPlusRewrites.map(rewrite => rewrite.description),
    ['removed the type-only import of "pkg"', 'removed a type-only export declaration'],
  )
  appendRunCodeEvents(session.events, 'export-feedback-erased', erasedCode, erased)
  const erasedAssembly = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  assert.equal(erasedAssembly.contexts.some(item => item?.name === 'tools:ptc-plus-rewrite-info'), false)

  const plain = await state.runDurable(session.id, 'const mixExisting = 1', {}, { session, recordSession: 'deferred-result', callId: 'export-feedback-plain' })
  appendRunCodeEvents(session.events, 'export-feedback-plain', 'const mixExisting = 1', plain)
  const splitCode = 'const { mixExisting, mixNew } = { mixExisting: 2, mixNew: 3 }\nreturn mixNew'
  const split = await state.runDurable(session.id, splitCode, {}, { session, recordSession: 'deferred-result', callId: 'export-feedback-split' })
  assert.match(
    split.meta.dshPtcPlusRewrites[0].description,
    /split a mixed top-level declaration/,
  )
  appendRunCodeEvents(session.events, 'export-feedback-split', splitCode, split)
  const splitAssembly = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  assert.equal(splitAssembly.contexts.some(item => item?.name === 'tools:ptc-plus-rewrite-info'), false)
})

test('classifies require exactly like dynamic imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const durable = await state.runDurable(
    'require-util', "const { inspect } = require('node:util')\nreturn typeof inspect",
  )
  assert.equal(durable.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(
    await state.run('require-util', 'return inspect([])'),
    { logs: [], value: '[]' },
  )
  const volatile = await state.runDurable(
    'require-util', "const { basename } = require('node:path')\nreturn basename('/a/b')", {}, { session: { events: [] } },
  )
  assert.equal(volatile.meta.dshPtcPlus.status, 'volatile')
  assert.match(volatile.meta.dshPtcPlus.volatileReason, /module node:path/)
  const dynamic = await state.runDurable(
    'require-dynamic', 'const specifier = "node:path"\nconst mod = require(specifier)\nreturn typeof mod', {}, { session: { events: [] } },
  )
  assert.equal(dynamic.meta.dshPtcPlus.status, 'volatile')
  assert.match(dynamic.meta.dshPtcPlus.volatileReason, /dynamic module resolution/)
})

test('preflights forbidden kernel-control requires', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'require-forbidden', "const { parentPort } = require('node:worker_threads')\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(result.isError, true)
  assert.match(result.error.message, /PTC-C002/)
  assert.match(result.error.message, /cell import of node:worker_threads is forbidden/)
})

test('does not infer retry safety from durable replayability', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const durable = await state.runDurable(
    'retryable-err', 'const missing = undefined\nreturn missing.value', {}, { session: { events: [] } },
  )
  assert.equal(durable.isError, true)
  assert.doesNotMatch(durable.error.message, /retrying it is safe/)
  assert.doesNotMatch(durable.error.message, /no external side effects/)
  const volatile = await state.runDurable(
    'volatile-err', "const { basename } = require('node:path')\nreturn basename(undefined)", {}, { session: { events: [] } },
  )
  assert.equal(volatile.isError, true)
  assert.doesNotMatch(volatile.error.message, /no external side effects/)
})

test('preflights forbidden rewritten imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'forbidden-import', "import { parentPort } from 'node:worker_threads'\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(result.isError, true)
  assert.match(result.error.message, /PTC-C002/)
  assert.match(result.error.message, /cell import of node:worker_threads is forbidden/)
})

test('executes rewritten imports after a semicolonless directive prologue', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'semicolonless-directive-import',
    `"use strict"
import { inspect } from 'node:util'
const strictThis = (function () { return this })()
return [strictThis === undefined, inspect({ value: 1 })]`,
    {},
    { session: { events: [] } },
  )
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, [true, '{ value: 1 }'])
})

test('fails safe when a static import shape is unrecognized', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const broken = await state.runDurable(
    'broken-import', "import fs from\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(broken.isError, true)
  assert.match(broken.error.message, /PTC-C001/)
  const noFrom = await state.runDurable(
    'broken-import', "import { a } from\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(noFrom.isError, true)
  assert.match(noFrom.error.message, /PTC-C001/)
  for (const shape of ["import { a }", 'import x y', 'import { a b']) {
    const rejected = await state.runDurable('broken-import', `${shape}\nreturn 1`, {}, { session: { events: [] } })
    assert.equal(rejected.isError, true)
    assert.match(rejected.error.message, /PTC-C001/)
  }
  const nullByte = await state.runDurable(
    'broken-import', `const value = 1${String.fromCharCode(0)}\nreturn 1`, {}, { session: { events: [] } },
  )
  assert.equal(nullByte.isError, true)
  assert.match(nullByte.error.message, /PTC-C001/)
  const metaAccess = await state.runDurable(
    'import-meta', 'return import.meta.url', {}, { session: { events: [] } },
  )
  assert.equal(metaAccess.isError, true)
  assert.match(metaAccess.error.message, /PTC-C001/)
  assert.deepEqual(
    await state.run('member-import', 'const o = { import: 7 }\nreturn o.import'),
    { logs: [], value: 7 },
  )
})

test('provides current cells one synthetic module base while preserving the legacy grammar', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'ptc-import-meta-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const filename = join(project, 'repl')
  const url = pathToFileURL(filename).href
  const expected = [url, filename, project, new URL('./asset', url).href]
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    for (const [form, meta] of [
      ['compact', 'import.meta'],
      ['space', 'import . meta'],
      ['comment', 'import/*comment*/.meta'],
      ['newline', 'import\n.meta'],
    ]) {
      const session = orderedSurfaceSession(`import-meta-${bindingUpdates}-${form}`)
      session.header = { cwd: project }
      const first = `first${form[0].toUpperCase()}${form.slice(1)}`
      const result = await state.run(session.id, [
        `const ${first} = ${meta}`,
        `${meta}.extra = 7`,
        `return [${first} === ${meta}, Object.getPrototypeOf(${first}) === null,`,
        `  ${first}.url, ${first}.filename, ${first}.dirname, new URL('./asset', ${meta}.url).href, ${meta}.extra]`,
      ].join('\n'), {}, { session })
      assert.deepEqual(result.value, [true, true, ...expected, 7])
    }
  }
  const fallback = fixture({ bindingUpdates: 'stateful' })
  t.after(() => fallback.dispose())
  assert.equal(
    (await fallback.run('import-meta-default-base', 'return import.meta.url')).value,
    pathToFileURL(join(process.cwd(), 'repl')).href,
  )
})

test('defines the exact CommonJS-like surface of current cells', async (t) => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const result = await state.run(`cell-module-surface-${bindingUpdates}`, [
      'return [typeof require, typeof require.resolve, typeof require.cache, typeof require.main,',
      '  typeof __dirname, typeof __filename, typeof module]',
    ].join('\n'))
    assert.deepEqual(result.value, [
      'function', 'function', 'object', 'undefined',
      'undefined', 'undefined', 'undefined',
    ])
  }
})

test('keeps static imports rejected when autoRewriteImports is disabled', async (t) => {
  const state = fixture({ autoRewriteImports: false })
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'no-rewrite', "import fs from 'node:fs'\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(result.isError, true)
  assert.match(result.error.message, /PTC-C001/)
})

test('attaches rewrite provenance to failed executions', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'rewrite-throw', "import { basename } from 'node:path'; throw new Error('boom')", {}, { session: { events: [] } },
  )
  assert.equal(result.isError, true)
  assert.match(result.error.message, /boom/)
  assert.equal(result.meta.dshPtcPlusRewrites.length, 1)
  assert.equal(result.meta.dshPtcPlusRewrites[0].kind, 'import')
  assert.deepEqual(result.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 1, column: 45 },
  })
})

test('does not attach rewrite provenance to preflight-rejected cells', async (t) => {
  const state = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => state.dispose())
  await state.runDurable('strict-rewrite', 'const existingValue = 1')
  const rejected = await state.runDurable(
    'strict-rewrite', "import { basename } from 'node:path'\nconst existingValue = 2\nreturn 1",
  )
  assert.equal(rejected.isError, true)
  assert.match(rejected.error.message, /PTC-N001/)
  assert.equal(rejected.meta.dshPtcPlusRewrites, undefined)
})

test('rejects read-only alias declarations before execution under the strict variable policy', async (t) => {
  const state = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => state.dispose())
  const sessionId = 'strict-alias-declaration'
  await state.run(
    sessionId,
    "let executed = 0\nimport { sep as imported } from 'node:path'",
  )

  const importedCollision = await state.run(
    sessionId,
    "executed += 1\nconst imported = 'local'",
  )
  assert.equal(importedCollision.error.kind, 'exception')
  // An import alias is not a writable worker binding, so a redeclaration of it
  // is refused as a top-level binding conflict before anything runs.
  assert.match(importedCollision.error.message, /PTC-N001[^]*existing binding is immutable/)
  assert.deepEqual(
    (await state.run(sessionId, 'return [executed, typeof imported]')).value,
    [0, 'string'],
  )

  await state.run(sessionId, 'export default 1')
  const defaultCollision = await state.run(
    sessionId,
    'executed += 1\nconst __default = 2',
  )
  assert.equal(defaultCollision.error.kind, 'exception')
  assert.match(defaultCollision.error.message, /PTC-N001[^]*existing binding is immutable/)
  assert.deepEqual(
    (await state.run(sessionId, 'return [executed, __default]')).value,
    [0, 1],
  )
})

test('rejects default exports that would replace ordinary or imported __default bindings', async (t) => {
  const state = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => state.dispose())

  const ordinarySession = 'ordinary-default-export-collision'
  await state.run(
    ordinarySession,
    'let executed = 0\nconst __default = 1\nconst readDefault = () => __default',
  )
  const ordinaryCollision = await state.run(
    ordinarySession,
    'executed += 1\nexport default function helper() { return 2 }',
  )
  assert.equal(ordinaryCollision.error.kind, 'exception')
  assert.match(ordinaryCollision.error.message, /PTC-C001.*__default/s)
  assert.deepEqual(
    (await state.run(ordinarySession, 'return [executed, __default, readDefault()]')).value,
    [0, 1, 1],
  )

  const importedSession = 'imported-default-export-collision'
  await state.run(
    importedSession,
    "let executed = 0\nimport { inspect as __default } from 'node:util'\nconst readDefault = () => __default",
  )
  const importedCollision = await state.run(
    importedSession,
    'executed += 1\nexport default class Box {}',
  )
  assert.equal(importedCollision.error.kind, 'exception')
  assert.match(importedCollision.error.message, /PTC-C001.*__default/s)
  assert.deepEqual(
    (await state.run(importedSession, 'return [executed, __default === readDefault()]')).value,
    [0, true],
  )
})

test('keeps explicit loose declarations replacing future alias reads only', async (t) => {
  const state = fixture({ looseTopLevelRedeclarations: true })
  t.after(() => state.dispose())
  const sessionId = 'loose-alias-declaration'
  await state.run(
    sessionId,
    "import { sep as imported } from 'node:path'\nconst readImported = () => imported",
  )
  const original = (await state.run(sessionId, 'return imported')).value
  const replaced = await state.run(
    sessionId,
    "const imported = 'local'\nreturn [imported, readImported()]",
  )
  assert.deepEqual(replaced.value, ['local', original])
  assert.deepEqual(
    (await state.run(sessionId, 'return [imported, readImported()]')).value,
    ['local', original],
  )
})

test('persists mixed loose alias declarations across live and cold continuation', async (t) => {
  const session = orderedSurfaceSession('mixed-loose-alias-replay')
  const { events } = session
  const writer = fixture({ looseTopLevelRedeclarations: true })
  const setupSource = [
    "import { inspect as imported } from 'node:util'",
    "export default 'old-default'",
    "let existing = 'old-existing'",
    'const originalImported = imported',
    'const readImported = () => imported',
    'const readDefault = () => __default',
  ].join('\n')
  const setup = await writer.runDurable(session.id, setupSource, {}, { session, recordSession: 'deferred-result', callId: 'mixed-loose-alias-setup' })
  appendRunCodeEvents(events, 'mixed-loose-alias-setup', setupSource, setup)

  const replacementDeclaration = [
    'const { imported, __default, existing, fresh } = {',
    "  imported: 'local-import',",
    "  __default: 'local-default',",
    "  existing: 'new-existing',",
    "  fresh: 'new-fresh',",
    '}',
  ].join('\n')
  const observation = '[imported, __default, existing, fresh, readImported() === originalImported, readDefault()]'
  const replacementSource = `${replacementDeclaration}\nreturn ${observation}`
  const replacement = await writer.runDurable(session.id, replacementSource, {}, { session, recordSession: 'deferred-result', callId: 'mixed-loose-alias-replacement' })
  assert.deepEqual(replacement.value, [
    'local-import',
    'local-default',
    'new-existing',
    'new-fresh',
    true,
    'old-default',
  ])
  for (const name of ['imported', '__default']) {
    const entry = replacement.meta.dshPtcPlusBindings.memory.entries
      .find(candidate => candidate.name === name)
    assert.equal(entry.kind, 'variable')
    assert.equal(entry.definition.source, replacementDeclaration)
  }
  appendRunCodeEvents(events, 'mixed-loose-alias-replacement', replacementSource, replacement)

  assert.deepEqual(
    (await writer.run(session.id, `return ${observation}`, {}, { session })).value,
    replacement.value,
  )
  await writer.dispose()

  const reader = fixture({ looseTopLevelRedeclarations: true })
  t.after(() => reader.dispose())
  const recovered = await reader.runDurable(
    session.id,
    `return ${observation}`,
    {},
    { session },
  )
  assert.equal(recovered.error, undefined, JSON.stringify(recovered, null, 2))
  assert.deepEqual(recovered.value, replacement.value)
  for (const name of ['imported', '__default']) {
    const entry = recovered.meta.dshPtcPlusBindings.memory.entries
      .find(candidate => candidate.name === name)
    assert.equal(entry.kind, 'variable')
    assert.equal(entry.definition.source, replacementDeclaration)
  }
})
