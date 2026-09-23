import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareProgram, PreflightError } from '../internal/cell-analysis.js'
import { ModuleRewriteError } from '../internal/cell-rewriter.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { BindingCatalog } from '../internal/session-state.js'
import { JOURNAL_KEY } from '../internal/session-journal.js'
import { encodeValue } from '../internal/value-wire.js'
import { appendRunCodeEvents, orderedSurfaceSession } from './plugin-fixture.js'
import { prepareLegacyProgram } from '../internal/legacy-cell-analysis.js'

const legacyPolicy = { variableRedeclarations: true, functionClassRedeclarations: true }
const rewritePolicy = { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true }
const moduleSemantics = { defaultExportBinding: 'live-readonly', importExpressionBoundary: 'statement-safe' }

function legacyPrepare(source, catalog = new BindingCatalog(), options = {}) {
  return prepareProgram(source, { ...catalog.inputs(), languageSemantics: 'legacy-v1',
    bindingPolicy: legacyPolicy, rewritesEnabled: rewritePolicy, ...options })
}

function recordedSession(id, cells, options = {}) {
  const session = orderedSurfaceSession(id)
  for (const [index, [source, value, hasValue = value !== undefined]] of cells.entries()) {
    appendRunCodeEvents(session.events, `${id}-${index}`, source, { meta: { [JOURNAL_KEY]: {
      version: 8, bindingPolicy: legacyPolicy, rewritePolicy, moduleSemantics,
      userBindingsFingerprint: null, userBindingsReusePolicy: 'implementation-v1',
      userBindingsShadowPolicy: 'per-name', userBindingNames: [],
      status: 'durable', calls: [], operations: [], confirms: [], diagnostics: [],
      completion: { kind: 'return', hasValue, ...(hasValue ? { value: encodeValue(value) } : {}) },
      ...options,
    } } })
  }
  return session
}

function recordedResult(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && event.data?.message?.source?.callId === callId)
}

async function recover(t, session, program, config = {}) {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', ...config })
  t.after(() => runtime.dispose())
  const callSeq = Math.max(-1, ...session.events.map(event => event.seq)) + 2
  const execution = await runtime.runTentative({ id: session.id, session, persistedCallSeq: callSeq }, {
    program, bindings: [],
  })
  assert.equal(execution.result.error, undefined, execution.result.error?.message)
  assert.equal(execution.settlement.recoveryBoundaries, undefined)
  runtime.finalize(execution.settlement, true)
  return execution
}

test('v8 replay clears an existing value on a bare declaration with void completion', async t => {
  const session = recordedSession('legacy-bare', [
    ['let x = 1; return x', 1],
    ['let x', undefined],
  ])
  const execution = await recover(t, session, 'return [typeof x, x === undefined]')
  assert.deepEqual(execution.result.value, ['undefined', true])
  assert.equal(execution.settlement.journal.languageSemantics, 'stateful-v1')
  assert.deepEqual(recordedResult(session, 'legacy-bare-1').data.meta[JOURNAL_KEY].completion,
    { kind: 'return', hasValue: false })
})

test('v8 void replay retains native callers and the values captured by their closures', async t => {
  const session = recordedSession('legacy-native-callers', [[
    'function f(){return f.caller===g} function g(){return f()} const result=g(); const saved=()=>result; void 0', undefined,
  ]])
  const execution = await recover(t, session, 'return [result,saved(),g()]')
  assert.deepEqual(execution.result.value, [true,true,true])
})

test('v8 replay retains old import closure identity when a later declaration replaces its alias', async t => {
  const session = recordedSession('legacy-import-closure', [
    ['import { format as imported } from "node:util"; const read = () => imported("%s", "kept"); void 0', undefined],
    ['const imported = () => "local"; void 0', undefined],
  ])
  const execution = await recover(t, session, 'return [read(), imported()]')
  assert.deepEqual(execution.result.value, ['kept', 'local'])
})

test('current protected settings do not reinterpret recorded loose legacy declarations', async t => {
  const session = recordedSession('legacy-policy', [
    ['const value = 1; return value', 1],
    ['const value = 2; return value', 2],
    ['var value; void 0', undefined],
  ])
  const execution = await recover(t, session, 'return typeof value', { bindingUpdates: 'protected' })
  assert.equal(execution.result.value, 'undefined')
  assert.equal(execution.settlement.journal.languageSemantics, 'protected-v1')
})

test('legacy mixed patterns avoid source helper names in live execution and v8 replay', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true })
  t.after(() => runtime.dispose())
  const cells = [
    ['let x=0; return x', 0],
    ['const [x,__dsh_ptc_mixed_value_0__]=[1,2]; return [x,__dsh_ptc_mixed_value_0__]', [1, 2]],
    ['const {x,__dsh_ptc_mixed_commit_0__}= {x:3,__dsh_ptc_mixed_commit_0__:4}; return [x,__dsh_ptc_mixed_commit_0__]', [3, 4]],
  ]
  for (const [program, expected] of cells) {
    const result = await runtime.run('legacy-source-helper-names', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, expected)
  }
  const recovered = await recover(t, recordedSession('legacy-helper-replay', cells),
    'return [x,__dsh_ptc_mixed_value_0__,__dsh_ptc_mixed_commit_0__]')
  assert.deepEqual(recovered.result.value, [3, 2, 4])
})

test('legacy module lowering keeps its recorded default export generation', async t => {
  const source = 'export default function value() { return 1 }; void 0'
  const later = 'function value() { return 2 }; void 0'
  for (const defaultExportBinding of ['legacy-variable', 'live-readonly']) {
    const session = recordedSession(`legacy-default-${defaultExportBinding}`, [[source, undefined], [later, undefined]], {
      moduleSemantics: { ...moduleSemantics, defaultExportBinding },
    })
    const execution = await recover(t, session, 'return [value(), __default()]')
    assert.deepEqual(execution.result.value, [2, 1])
    const prepared = legacyPrepare(source, new BindingCatalog(), {
      moduleSemantics: { ...moduleSemantics, defaultExportBinding },
    })
    assert.equal(prepared.imports.has('__default'), defaultExportBinding === 'live-readonly')
  }
})

test('legacy preparation preserves parser rejection, declaration policy and shared diagnostics', () => {
  for (const source of ['const missing;', 'let value = 1; let value = 2', 'function read() { const value = 1; const value = 2 }']) {
    assert.throws(() => legacyPrepare(source), ModuleRewriteError)
  }
  assert.throws(() => legacyPrepare('import { Worker } from "node:worker_threads"'), PreflightError)
  assert.throws(() => legacyPrepare('const value: number = ;'), error => {
    assert.ok(error instanceof ModuleRewriteError)
    assert.equal(error.cellPosition.line, 1)
    return true
  })
  const first = legacyPrepare('const value = 1')
  const catalog = new BindingCatalog().advance(first, 'const value = 1')
  const bare = legacyPrepare('let value', catalog)
  assert.match(bare.code, /value = .*undefined/)
  const protectedDeclaration = legacyPrepare('let value = 2', catalog, {
    bindingPolicy: { variableRedeclarations: false, functionClassRedeclarations: false },
  })
  assert.equal(protectedDeclaration.collisions[0].reason, 'variable-redeclarations-disabled')
})

test('legacy catalog uses historical namespace and declaration commit evidence', () => {
  const first = legacyPrepare('import { format } from "node:util"; void 0')
  const catalog = new BindingCatalog().advance(first, 'import { format } from "node:util"; void 0')
  for (const namespace of first.importNamespaces) assert.equal(catalog.inputs().importNamespaces.has(namespace), true)
  const next = legacyPrepare('export default 3', catalog)
  const beforeCommit = catalog.advance(next, 'export default 3', new Set())
  assert.equal(beforeCommit.inputs().importBindings.has('__default'), false)
  assert.equal(beforeCommit.inputs().importBindings.has('format'), true)
  const afterCommit = catalog.advance(next, 'export default 3', next.commitTargets)
  assert.equal(afterCommit.inputs().importBindings.has('__default'), true)
  const referenced = legacyPrepare('format; void 0', catalog)
  const withRootFact = catalog.advance(referenced, 'format; void 0', undefined, [
    { name: 'format', source: 'import' },
  ])
  assert.equal(withRootFact.inputs().importBindings.has('format'), true)
})

test('v8 replay preserves class static-block and switch lexical owners', async t => {
  const source = `
let answer=0
class Owner { static { var process={value:7}; answer=process.value } }
switch (1) { case 1: const Math={random:()=>8}; answer+=Math.random() }
const Local=class { static value=answer }
void 0
`
  assert.equal(legacyPrepare(source).durability, 'durable')
  const execution = await recover(t, recordedSession('legacy-static-scopes', [[source, undefined]]),
    'return [answer, Local.value]')
  assert.deepEqual(execution.result.value, [15, 15])
})

test('historical compilation retains ambient and dynamic-module recovery boundaries', () => {
  const cases = [
    ['const saved=Math', { kind: 'ambient', name: 'Math' }],
    ['const saved=globalThis.Math', { kind: 'ambient', name: 'Math' }],
    ['const saved=globalThis["Math"]["random"]', { kind: 'math-random' }],
    ['const pick=key=>globalThis[key]', { kind: 'computed-global-access' }],
    ['const saved=globalThis.global', { kind: 'ambient', name: 'global' }],
    ['const saved=globalThis.process', { kind: 'ambient', name: 'process' }],
    ['const saved=globalThis.Date', { kind: 'ambient', name: 'Date' }],
    ['const saved=globalThis', { kind: 'ambient', name: 'globalThis' }],
    ['const load=name=>import(name)', { kind: 'dynamic-module-resolution' }],
  ]
  for (const [source, reason] of cases) {
    const prepared = legacyPrepare(`${source}; void 0`)
    assert.equal(prepared.durability, 'volatile', source)
    assert.deepEqual(prepared.reasons, [reason], source)
  }
  assert.throws(() => legacyPrepare('const load=()=>require("node:worker_threads")'), PreflightError)
})

test('frozen legacy preparation retains loop scopes and mixed declaration evidence', () => {
  const options = { bindingPolicy: legacyPolicy, rewritesEnabled: rewritePolicy }
  for (const source of [
    'for(let process of [{value:1}]){process.value}',
    'for(const Math in {}){Math.length}',
    'for(let Date=0;Date<1;Date++){}',
    'process.cwd();process["stdout"].write("")',
  ]) assert.equal(prepareLegacyProgram(source, options).durability, 'durable', source)
  assert.equal(prepareLegacyProgram('process.env', options).durability, 'volatile')
  const prepared = prepareLegacyProgram('const existing=2,fresh=3;class Shape{static value=4}', {
    ...options, knownBindings: new Set(['existing','Shape']), writableBindings: new Set(['existing','Shape']),
  })
  assert.deepEqual(prepared.collisions, [])
  const committed = []
  const result = new Function(`let existing=1,Shape=class{};
    ${prepared.code};return [existing,fresh,Shape.value,Shape.name]`).call({
    [prepared.commitSignal]: name => committed.push(name),
  })
  assert.deepEqual(result, [2,3,4,'Shape'])
  assert.deepEqual(new Set(committed), prepared.commitTargets)
})
