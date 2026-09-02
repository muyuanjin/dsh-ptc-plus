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

const ENABLED = {
  autoRewriteImports: true,
  autoStripExports: true,
  autoSplitRedeclarations: true,
}

function prepare(code, knownBindings = new Set(), options = {}) {
  return prepareProgram(code, knownBindings, true, new Set(), { ...ENABLED, ...options })
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
  assert.match(result.code, /throw new this\["__dsh_ptc_return_signal_0__"\]/)
  assert.equal(result.returnSignal, '__dsh_ptc_return_signal_0__')
  assert.deepEqual(result.rewrites.map(item => item.kind), ['import', 'export', 'redeclaration'])
})

test('allocates private import namespaces outside persistent REPL bindings', () => {
  const result = prepare(
    "import { basename } from 'node:path'; return basename('/a/b')",
    new Set(['__dsh_ptc_import_namespace_0__']),
  )
  assert.deepEqual([...result.importNamespaces], ['__dsh_ptc_import_namespace_1__'])
  assert.deepEqual(result.redeclared, [])
  assert.match(result.code, /__dsh_ptc_import_namespace_1__/)
  assert.doesNotMatch(result.code, /__dsh_ptc_import_namespace_0__/)
})

test('allocates return control outside persistent REPL bindings', () => {
  const result = prepare(
    'try { return 1 } catch { return 2 }',
    new Set(['__dsh_ptc_return_signal_0__']),
  )
  assert.equal(result.returnSignal, '__dsh_ptc_return_signal_1__')
  assert.match(result.code, /throw new this\["__dsh_ptc_return_signal_1__"\]\(1\)/)
  assert.doesNotMatch(result.code, /(?:globalThis|throw new __dsh_ptc).*return_signal/)
})

test('preserves source when module rewrites are disabled and reports the parse boundary', () => {
  assert.throws(
    () => prepareProgram("import value from 'node:path'\nreturn value", new Set(), true, new Set(), {
      autoRewriteImports: false,
      autoStripExports: true,
      autoSplitRedeclarations: true,
    }),
    /Unexpected token|Cannot use import statement outside a module|import/,
  )
  assert.throws(
    () => prepareProgram('export const value = 1\nreturn value', new Set(), true, new Set(), {
      autoRewriteImports: true,
      autoStripExports: false,
      autoSplitRedeclarations: true,
    }),
    /Unexpected token|Unexpected keyword 'export'|export/,
  )
})

test('requires a complete explicit rewrite policy', () => {
  for (const policy of [undefined, {}, {
    autoRewriteImports: true,
    autoStripExports: true,
  }]) {
    assert.throws(
      () => prepareProgram('return 1', new Set(), true, new Set(), policy),
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
      () => prepareProgram('return 1', new Set(), policy, new Set(), ENABLED),
      /binding policy must define/,
    )
  }
})

test('requires supported module lowering semantics', () => {
  assert.throws(
    () => prepareProgram(
      'return 1',
      new Set(),
      { variableRedeclarations: true, functionClassRedeclarations: true },
      new Set(),
      ENABLED,
      new Map(),
      new Set(),
      new Set(),
      { defaultExportBinding: 'unknown' },
    ),
    /module semantics must define/,
  )
})

test('assigns distinct commit targets to same-name declaration occurrences', () => {
  const result = prepareProgram(
    'function current() { return 1 }\nfunction current() { return 2 }',
    new Set(['current']),
    { variableRedeclarations: true, functionClassRedeclarations: true },
    new Set(),
    ENABLED,
  )
  const declarations = result.declarations.filter(declaration => declaration.name === 'current')
  assert.equal(declarations.length, 2)
  assert.equal(new Set(declarations.map(declaration => declaration.commitDependency)).size, 2)
  assert.deepEqual(
    [...result.commitTargets],
    declarations.map(declaration => declaration.commitDependency),
  )
})

test('only lowers fresh const declarations under the variable redeclaration policy', () => {
  const strict = prepareProgram(
    'const stable = 1',
    new Set(),
    { variableRedeclarations: false, functionClassRedeclarations: true },
    new Set(),
    ENABLED,
  )
  assert.match(strict.code, /^const stable = 1$/)
  assert.equal(strict.declarations[0].writable, false)

  const loose = prepareProgram(
    'const replaceable = 1',
    new Set(),
    { variableRedeclarations: true, functionClassRedeclarations: false },
    new Set(),
    ENABLED,
  )
  assert.match(loose.code, /^let replaceable = 1$/)
  assert.equal(loose.declarations[0].writable, true)
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
  assert.match(result.code, /function nested\(\) \{ return 'nested' \}/)
  assert.match(result.code, /let arrow = \(\) => \{ return 'arrow' \}/)
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
