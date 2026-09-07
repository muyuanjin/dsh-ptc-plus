import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { parse } from '@babel/parser'
import {
  USER_BINDINGS_META_KEY,
  createUserBindingsSnapshot,
  normalizeUserBindingEntry,
  normalizeUserBindingsDocument,
  normalizeUserBindingsSnapshot,
  selectUserBindingsSnapshot,
  storedUserBindingsDocument,
  userBindingCatalogEntries,
  userBindingsContext,
  userBindingsDeclaration,
  userBindingsSnapshotFromMeta,
  userBindingsSnapshotsEqual,
  withUserBindingsSnapshot,
} from '../internal/user-bindings.js'

function entry(overrides = {}) {
  return {
    id: 'helpers',
    name: 'helpers',
    scope: 'namespace',
    purpose: 'Reusable typed helpers.',
    enabled: true,
    source: `
/** Add two values. */
export function add(left: number, right: number): number { return left + right }
export async function later(value = 1) { return value }
export class Counter {
  constructor(public value: number) {}
  increment(by: number): number { return this.value += by }
  private hidden() {}
}
export const truth = true
`,
    ...overrides,
  }
}

function snapshotWire(entries, revision = 1) {
  return {
    version: 1,
    revision,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ revision, entries: entries.map(item => item.fingerprint) }))
      .digest('hex'),
    entries,
  }
}

test('binding names are exact identifiers across entries, exports and snapshots', () => {
  const source = 'export const answer = 42'
  for (const name of ['helpers ', ' helpers', 'helpers/**/', 'helpers\n', '{ helpers }',
    '[helpers]', 'helpers = 1, extra', 'helpers = 1; const extra', String.raw`h\u0065lpers`,
    String.raw`\u0074ools`, 'tools/**/', 'await']) {
    assert.throws(() => normalizeUserBindingEntry(entry({ name, source })), /identifier/, name)
    assert.throws(() => normalizeUserBindingEntry(entry({ symbols: [name], source })), /identifier/, name)
  }
  assert.throws(() => normalizeUserBindingEntry(entry({
    source: 'const answer = 42; export { answer as "helpers " }',
  })), /identifier/)
  assert.throws(() => normalizeUserBindingEntry(entry({ name: 'tools', source })), /reserved/)
  for (const name of ['$', '_helpers', 'helpers2', '\u540d\u79f0', 'a\u200cb']) {
    const normalized = normalizeUserBindingEntry(entry({ name, source }))
    assert.equal(normalized.name, name)
    assert.equal(normalized.bindings[0].name, name)
    const ast = parse(normalized.declaration, { plugins: ['typescript'] })
    assert.equal(ast.program.body[0].declarations[0].id.name, name)
    assert.equal(normalizeUserBindingsSnapshot(snapshotWire([normalized])).entries[0].name, name)
  }
})

test('derives bounded namespace and top-level declarations from named value exports', () => {
  const namespace = normalizeUserBindingEntry(entry({ purpose: '' }))
  assert.deepEqual(namespace.symbols, ['add', 'later', 'Counter', 'truth'])
  assert.match(namespace.declaration, /Add two values/)
  assert.match(namespace.declaration, /add\(left: number, right: number\): number/)
  assert.match(namespace.declaration, /later\(value\?: unknown\): Promise<unknown>/)
  assert.match(namespace.declaration, /new\(value: number\): \{ increment\(by: number\): number \}/)
  assert.doesNotMatch(namespace.declaration, /hidden|return left|this\.value/)
  assert.equal(namespace.bindings[0].name, 'helpers')

  const topLevel = normalizeUserBindingEntry(entry({
    id: 'top',
    name: '  Top Level helpers  ',
    scope: 'top-level',
    symbols: ['add', 'Counter'],
  }))
  assert.equal(topLevel.name, 'Top Level helpers')
  assert.deepEqual(topLevel.bindings.map(item => item.kind), ['function', 'class'])
  assert.match(topLevel.declaration, /declare function add/)
  assert.match(topLevel.declaration, /declare class Counter.*increment/)

  const inferred = normalizeUserBindingEntry(entry({
    id: 'shapes',
    name: 'shapes',
    source: `
export const text = \`x\`
export const count = 1
export const huge = 1n
export const none = null
export const values = [1]
export const fn = (...items: string[]) => items.length
export const shape = { ok: true, label: 'x' }
export const dynamic = { [String('x')]: 1 }
`,
  }))
  assert.match(inferred.declaration, /text: string/)
  assert.match(inferred.declaration, /count: number/)
  assert.match(inferred.declaration, /huge: bigint/)
  assert.match(inferred.declaration, /none: null/)
  assert.match(inferred.declaration, /values: unknown\[\]/)
  assert.match(inferred.declaration, /fn: \(\.\.\.items: string\[\]\) => unknown/)
  assert.match(inferred.declaration, /shape: \{ ok: boolean; label: string \}/)
  assert.match(inferred.declaration, /dynamic: Record<string, unknown>/)
})

test('keeps generic declarations scoped and degrades source-local type references', () => {
  const namespace = normalizeUserBindingEntry(entry({
    id: 'generic-namespace',
    name: 'genericHelpers',
    source: [
      'type PrivateOptions = { prefix: string }',
      'interface PrivateResult { value: string }',
      'export function identity<T>(value: T): T { return value }',
      'export function configure<T extends PrivateOptions>(value: T): PrivateResult {',
      '  return { value: value.prefix }',
      '}',
      'export function combine(left: PrivateOptions, right: PrivateResult): [PrivateOptions, PrivateResult] {',
      '  return [left, right]',
      '}',
      'export function clone<T>(value: T): { [K in keyof T]: T[K] } { return value }',
      'export function unwrap<T>(value: T): T extends Promise<infer U> ? U : T { return value as never }',
      "export const imported: import('node:path').PlatformPath = {} as never",
      'export const math: typeof Math = Math',
      'export class Box<T> {',
      '  constructor(public value: T) {}',
      '  map<U>(project: (value: T) => U): Box<U> { return new Box(project(this.value)) }',
      '}',
    ].join('\n'),
  }))
  assert.match(namespace.declaration, /identity<T>\(value: T\): T/)
  assert.match(namespace.declaration, /configure<T extends unknown>\(value: T\): unknown/)
  assert.match(namespace.declaration, /combine\(left: unknown, right: unknown\): \[unknown, unknown\]/)
  assert.match(namespace.declaration, /clone<T>\(value: T\): \{ \[K in keyof T\]: T\[K\] \}/)
  assert.match(namespace.declaration, /unwrap<T>\(value: T\): T extends Promise<infer U> \? unknown : T/)
  assert.match(namespace.declaration, /imported: unknown/)
  assert.match(namespace.declaration, /math: unknown/)
  assert.match(namespace.declaration, /new<T>\(value: T\): \{ map<U>\(project: \(value: T\) => U\): unknown \}/)
  assert.doesNotMatch(namespace.declaration, /PrivateOptions|PrivateResult|Box<U>/)
  assert.doesNotThrow(() => parse(namespace.declaration, {
    sourceType: 'module',
    plugins: ['typescript'],
  }))

  const topLevel = normalizeUserBindingEntry(entry({
    id: 'generic-top-level',
    name: 'Generic exports',
    scope: 'top-level',
    source: [
      'type Hidden = { value: string }',
      'export const transform: <T>(value: T) => T = value => value',
      'export class Holder<T extends Hidden> {',
      '  constructor(public value: T) {}',
      '  read(): T { return this.value }',
      '}',
    ].join('\n'),
  }))
  assert.match(topLevel.declaration, /declare const transform: <T>\(value: T\) => T/)
  assert.match(topLevel.declaration, /declare class Holder<T extends unknown>/)
  assert.match(topLevel.declaration, /read\(\): T/)
  assert.doesNotMatch(topLevel.declaration, /Hidden/)
  assert.doesNotThrow(() => parse(topLevel.declaration, {
    sourceType: 'module',
    plugins: ['typescript'],
  }))

  const shadowedGlobals = normalizeUserBindingEntry(entry({
    id: 'shadowed-global-types',
    name: 'shadowedGlobalTypes',
    source: [
      "import type { PathLike as Array } from 'node:fs'",
      'type Promise<T> = { localPromise: T }',
      'interface Record<K, V> { localRecord: [K, V] }',
      'class Map<K, V> {}',
      'export function inspect(value: Promise<string>): Record<string, Map<string, number>> {',
      '  return value as never',
      '}',
      'export function imported(value: Array): Array { return value }',
      'export function preserve<Promise>(value: Promise): Promise { return value }',
    ].join('\n'),
  }))
  assert.match(shadowedGlobals.declaration, /inspect\(value: unknown\): unknown/)
  assert.match(shadowedGlobals.declaration, /imported\(value: unknown\): unknown/)
  assert.match(shadowedGlobals.declaration, /preserve<Promise>\(value: Promise\): Promise/)
  assert.doesNotMatch(shadowedGlobals.declaration, /localPromise|localRecord/)
})

test('removes source comments from model-visible type annotations', () => {
  const raw = entry({
    source: `
export function inspect(
  value: string | /* private implementation note */ number,
  mode: '/* literal type text */',
): // hidden return note
boolean { return Boolean(value && mode) }
`,
    symbols: ['inspect'],
  })
  const normalized = normalizeUserBindingEntry(raw)
  assert.doesNotMatch(normalized.declaration, /private implementation note|hidden return note/)
  assert.match(normalized.declaration, /'\/\* literal type text \*\/'/)
  const context = userBindingsContext(createUserBindingsSnapshot({ entries: [raw] }))
  assert.doesNotMatch(context.text, /private implementation note|hidden return note/)
})

test('keeps namespace member names separate from reserved top-level bindings', () => {
  const namespace = normalizeUserBindingEntry(entry({
    source: 'export function fetch(value: string) { return value }',
    symbols: ['fetch'],
  }))
  assert.match(namespace.declaration, /fetch\(value: string\)/)
  assert.throws(() => normalizeUserBindingEntry({
    ...entry({ scope: 'top-level', source: 'export const process = 1', symbols: ['process'] }),
  }), /reserved REPL binding/)
  assert.throws(() => normalizeUserBindingEntry(entry({ name: 'tools' })), /reserved REPL binding/)
  assert.throws(() => normalizeUserBindingEntry(entry({ name: 'x'.repeat(129) })), /at most 128/)
})

test('rejects malformed entries, unsupported exports, conflicts, and source budgets', () => {
  const invalidEntries = [
    [null, /must be an object/],
    [{ ...entry(), extra: true }, /invalid binding entry field/],
    [entry({ id: '' }), /binding id/],
    [entry({ name: 'not-valid-name' }), /valid JavaScript identifier/],
    [entry({ scope: 'top-level', name: 1 }), /name must be a string/],
    [entry({ scope: 'top-level', name: '   ' }), /name must contain/],
    [entry({ scope: 'top-level', name: 'x'.repeat(129) }), /name must contain/],
    [entry({ scope: 'other' }), /namespace or top-level/],
    [entry({ source: '' }), /must contain/],
    [entry({ enabled: 'yes' }), /must be a boolean/],
    [entry({ purpose: 1 }), /must be a string/],
    [entry({ purpose: 'x'.repeat(241) }), /must not exceed/],
    [entry({ symbols: 'add' }), /must be an array/],
    [entry({ symbols: ['add', 'add'] }), /duplicated/],
    [entry({ symbols: ['missing'] }), /not a named value export/],
    [entry({ source: 'export default 1' }), /named exports only/],
    [entry({ source: 'export * from "node:path"' }), /named exports only/],
    [entry({ source: 'export { join } from "node:path"' }), /cannot re-export/],
    [entry({ source: 'export type X = string' }), /at least one named value export/],
    [entry({ source: 'export { missing }' }), /could not be parsed|has no local value declaration/],
    [entry({ source: 'export const {' }), /could not be parsed/],
    [entry({ source: `export const value = 1/*${'x'.repeat(65 * 1024)}*/` }), /1-65536/],
  ]
  for (const [value, pattern] of invalidEntries) assert.throws(() => normalizeUserBindingEntry(value), pattern)
  assert.match(normalizeUserBindingEntry({
    ...entry(), source: 'const value = 1; export { value as renamed }', symbols: ['renamed'],
  }).declaration, /renamed/)
  assert.match(normalizeUserBindingEntry({
    ...entry(), source: 'export const value = Symbol()',
  }).declaration, /value: unknown/)
  assert.match(normalizeUserBindingEntry({
    ...entry(), source: 'export const value = { nested: { deep: { value: 1 } } }',
  }).declaration, /value: \{ nested: \{ deep: \{ value: unknown \} \} \}/)
  const destructured = normalizeUserBindingEntry({
    ...entry(), source: 'export const { value, ...rest } = { value: 1, other: 2 }', symbols: ['value', 'rest'],
  })
  assert.deepEqual(destructured.symbols, ['value', 'rest'])
  assert.match(destructured.declaration, /value: unknown/)
  assert.match(destructured.declaration, /rest: unknown/)
  assert.match(normalizeUserBindingEntry({
    ...entry(), source: 'export const [first] = [1]', symbols: ['first'],
  }).declaration, /first: unknown/)

  assert.throws(() => normalizeUserBindingsDocument(null), /must be an object/)
  assert.throws(() => normalizeUserBindingsDocument({ entries: [], extra: true }), /invalid bindings document field/)
  assert.throws(() => normalizeUserBindingsDocument({ entries: 'no' }), /at most 64/)
  assert.throws(() => normalizeUserBindingsDocument({ entries: Array(65).fill(entry()) }), /at most 64/)
  assert.throws(() => normalizeUserBindingsDocument({ entries: [entry(), entry()] }), /duplicated/)
  assert.throws(() => normalizeUserBindingsDocument({ entries: [
    entry({ id: 'one' }),
    entry({ id: 'two' }),
  ] }), /conflicts between entries/)
  const largeEntries = Array.from({ length: 5 }, (_, index) => entry({
    id: `large-${index}`,
    name: `large${index}`,
    enabled: false,
    source: `export const value${index} = 1/*${'x'.repeat(60 * 1024)}*/`,
  }))
  assert.throws(() => normalizeUserBindingsDocument({ entries: largeEntries }), /character document limit/)
  const declarationHeavy = Array.from({ length: 64 }, (_, index) => entry({
    id: `decl-${index}`,
    name: `decl${index}`,
    enabled: true,
    purpose: 'p'.repeat(240),
    source: `export const value${index} = 1`,
  }))
  assert.throws(() => createUserBindingsSnapshot({ entries: declarationHeavy }), /model-context limit/)
})

test('validates snapshots from source and rejects altered derived evidence', () => {
  const disabled = entry({ id: 'off', name: 'off', enabled: false })
  const snapshot = createUserBindingsSnapshot({ entries: [entry(), disabled] }, 4)
  assert.equal(snapshot.entries.length, 1)
  assert.equal(normalizeUserBindingsSnapshot(snapshot).fingerprint, snapshot.fingerprint)
  assert.equal(userBindingsDeclaration(snapshot), snapshot.entries[0].declaration)
  assert.match(userBindingsContext(snapshot).text, /helpers \(add, later, Counter, truth\)/)
  assert.equal(userBindingCatalogEntries(snapshot)[0].entryId, 'helpers')

  const selected = selectUserBindingsSnapshot(snapshot, new Set(['helpers']))
  assert.equal(selected.entries.length, 1)
  assert.equal(selected.entries[0].id, 'helpers')
  const empty = selectUserBindingsSnapshot(snapshot, new Set())
  assert.equal(empty.entries.length, 0)
  assert.equal(userBindingsContext(empty), undefined)
  assert.throws(() => createUserBindingsSnapshot({ entries: [] }, -1), /revision/)

  const malformed = [
    null,
    { ...snapshot, version: 2 },
    { ...snapshot, fingerprint: 'bad' },
    { ...snapshot, entries: [null] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], extra: true }] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], declaration: 'declare const forged: true' }] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], bindings: null }] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], bindings: [{ ...snapshot.entries[0].bindings[0], kind: 'bad' }] }] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], enabled: false }] },
    { ...snapshot, fingerprint: '0'.repeat(64) },
  ]
  for (const value of malformed) assert.throws(() => normalizeUserBindingsSnapshot(value))

  const sourceHeavy = Array.from({ length: 5 }, (_, index) => (
    createUserBindingsSnapshot({ entries: [entry({
      id: `source-${index}`,
      name: `source${index}`,
      source: `export const value${index} = 1/*${'x'.repeat(60 * 1024)}*/`,
    })] }).entries[0]
  ))
  assert.throws(
    () => normalizeUserBindingsSnapshot(snapshotWire(sourceHeavy)),
    /character document limit/,
  )

  const declarationHeavy = Array.from({ length: 64 }, (_, index) => (
    createUserBindingsSnapshot({ entries: [entry({
      id: `declaration-${index}`,
      name: `declaration${index}`,
      purpose: 'p'.repeat(240),
      source: `export const value${index} = 1`,
    })] }).entries[0]
  ))
  assert.throws(
    () => normalizeUserBindingsSnapshot(snapshotWire(declarationHeavy)),
    /model-context limit/,
  )
})

test('round-trips stored documents and private result metadata without trusting identity', () => {
  const document = storedUserBindingsDocument({ entries: [entry()] })
  assert.deepEqual(Object.keys(document.entries[0]), [
    'id', 'name', 'scope', 'symbols', 'purpose', 'enabled', 'source',
  ])
  const snapshot = createUserBindingsSnapshot(document, 2)
  const metadata = withUserBindingsSnapshot({ existing: true }, snapshot)
  assert.equal(metadata.existing, true)
  assert.equal(userBindingsSnapshotFromMeta(metadata).fingerprint, snapshot.fingerprint)
  assert.equal(userBindingsSnapshotFromMeta({}), undefined)
  assert.equal(userBindingsSnapshotsEqual(snapshot, structuredClone(snapshot)), true)
  assert.equal(userBindingsSnapshotsEqual(snapshot, undefined), false)
  assert.equal(userBindingsSnapshotsEqual(undefined, undefined), true)
  assert.equal(userBindingsSnapshotsEqual(snapshot, { ...snapshot, fingerprint: 'x' }), false)
  assert.equal(withUserBindingsSnapshot('legacy', snapshot).value, 'legacy')
  assert.ok(Object.hasOwn(metadata, USER_BINDINGS_META_KEY))
})
