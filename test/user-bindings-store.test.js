import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { UserBindingsStore } from '../internal/user-bindings-store.js'

function binding(overrides = {}) {
  return {
    id: 'math',
    name: 'math',
    scope: 'namespace',
    purpose: 'Math helpers.',
    enabled: true,
    source: 'export function add(left: number, right: number): number { return left + right }',
    ...overrides,
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ptc-plus-bindings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, 'profile', 'ptc-plus', 'bindings.json')
  return { root, filename, store: new UserBindingsStore({ filename }) }
}

test('atomically saves, reads, toggles, removes, and snapshots one document', async (t) => {
  const { filename, store } = await fixture(t)
  const empty = await store.list()
  assert.equal(empty.revision, 1)
  assert.deepEqual(empty.entries, [])
  assert.equal(store.filename, filename)

  const saved = await store.save(binding(), empty.revision)
  assert.equal(saved.revision, 2)
  assert.equal(saved.entries[0].origin, 'global')
  assert.equal(saved.entries[0].source, undefined)
  assert.match(saved.entries[0].declaration, /add\(left: number/)
  const loaded = await store.entry('math')
  assert.equal(loaded.entry.source, binding().source)
  assert.equal((await store.snapshot()).entries[0].id, 'math')
  await assert.rejects(store.create(binding(), saved.revision), /already exists/)

  const disabled = await store.setEnabled('math', false, saved.revision)
  assert.equal(disabled.entries[0].enabled, false)
  assert.equal((await store.snapshot()).entries.length, 0)
  const validationDocument = await store.validationDocument()
  assert.equal(validationDocument.revision, disabled.revision)
  assert.equal(validationDocument.entries[0].enabled, false)
  assert.equal(validationDocument.entries[0].source, binding().source)
  assert.equal(Object.isFrozen(validationDocument.entries[0]), true)
  const enabled = await store.setEnabled('math', true, disabled.revision)
  const removed = await store.remove('math', enabled.revision)
  assert.deepEqual(removed.entries, [])
  assert.throws(() => store.setEnabled('math', 'yes', removed.revision), /must be a boolean/)
  await assert.rejects(store.entry('math'), /does not exist/)
  await assert.rejects(store.setEnabled('math', true, removed.revision), /does not exist/)
  await assert.rejects(store.remove('math', removed.revision), /does not exist/)

  const persisted = JSON.parse(await readFile(filename, 'utf8'))
  assert.deepEqual(persisted, { entries: [] })
  if (process.platform !== 'win32') {
    assert.equal((await stat(filename)).mode & 0o777, 0o600)
  }
})

test('coalesces concurrent first-use reads into one revision', async (t) => {
  const { store } = await fixture(t)
  const [listed, snapshot] = await Promise.all([store.list(), store.snapshot()])
  assert.equal(listed.revision, 1)
  assert.equal(snapshot.revision, 1)
  assert.equal((await store.save(binding(), listed.revision)).revision, 2)
})

test('persists model prompt preferences with source through reload and activation toggles', async t => {
  const { filename, store } = await fixture(t)
  const modelContext = { includeDeclaration: false, instructions: 'Use math.add for numeric sums.' }
  const saved = await store.save(binding({ modelContext }), (await store.list()).revision)
  assert.deepEqual(saved.entries[0].modelContext, modelContext)
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).entries[0].modelContext, modelContext)
  const fresh = new UserBindingsStore({ filename })
  const loaded = await fresh.entry('math')
  assert.deepEqual(loaded.entry.modelContext, modelContext)
  const disabled = await fresh.setEnabled('math', false, loaded.revision)
  await fresh.setEnabled('math', true, disabled.revision)
  assert.deepEqual((await fresh.snapshot()).entries[0].modelContext, modelContext)
})

test('rejects non-identifier names before persistence and deactivates malformed disk entries', async t => {
  const { filename, store } = await fixture(t)
  const saved = await store.save(binding(), (await store.list()).revision)
  const before = await readFile(filename, 'utf8')
  assert.throws(() => store.save(binding({ name: 'math ' }), saved.revision), /identifier/)
  assert.equal(await readFile(filename, 'utf8'), before)
  await writeFile(filename, JSON.stringify({ entries: [binding({ name: 'math ' })] }))
  const damaged = await store.reload()
  assert.match(damaged.error, /identifier/)
  assert.deepEqual((await store.snapshot()).entries, [])
  await writeFile(filename, before)
  await store.reload()
  assert.equal((await store.snapshot()).entries[0].name, 'math')
})

test('rejects stale and externally changed revisions without overwriting disk', async (t) => {
  const { filename, store } = await fixture(t)
  const initial = await store.list()
  await assert.rejects(store.save(binding(), -1), /non-negative safe integer/)
  await assert.rejects(store.save(binding(), initial.revision + 1), error => error.code === 'BINDINGS_CONFLICT')
  const saved = await store.save(binding(), initial.revision)
  await writeFile(filename, `${JSON.stringify({ entries: [binding({ purpose: 'external' })] }, null, 2)}\n`)
  await assert.rejects(
    store.save(binding({ purpose: 'local' }), saved.revision),
    error => error.code === 'BINDINGS_CONFLICT' && /outside this process/.test(error.message),
  )
  const reloaded = await store.reload()
  assert.equal(reloaded.entries[0].purpose, 'external')

  const replacement = await store.save(binding({ purpose: 'replacement' }), reloaded.revision)
  assert.equal(replacement.entries[0].purpose, 'replacement')
})

test('reports damaged storage as an empty inactive catalog and refuses blind repair', async (t) => {
  const { filename, store } = await fixture(t)
  await mkdir(dirname(filename), { recursive: true })
  await writeFile(filename, '{bad json')
  const damaged = await store.reload()
  assert.match(damaged.error, /invalid bindings document/)
  assert.deepEqual(damaged.entries, [])
  assert.equal((await store.snapshot()).entries.length, 0)
  await assert.rejects(store.validationDocument(), /invalid bindings document/)
  await assert.rejects(store.save(binding(), damaged.revision), /invalid bindings document/)

  await writeFile(filename, JSON.stringify({ entries: [null] }))
  const malformedDocument = await store.reload()
  assert.match(malformedDocument.error, /invalid bindings document/)
  await rm(filename)
  await assert.rejects(
    store.save(binding(), malformedDocument.revision),
    error => error.code === 'BINDINGS_CONFLICT' && /outside this process/.test(error.message),
  )
  const missing = await store.reload()
  assert.equal(missing.error, undefined)
  assert.equal((await store.save(binding(), missing.revision)).entries[0].id, 'math')
})

test('rejects an enabled declaration set that cannot produce a bounded snapshot', async (t) => {
  const { filename, store } = await fixture(t)
  const initial = await store.list()
  const saved = await store.save(binding(), initial.revision)
  const before = await readFile(filename, 'utf8')
  const declarationHeavy = Array.from({ length: 64 }, (_, index) => binding({
    id: `declaration-${index}`,
    name: `declaration${index}`,
    purpose: 'p'.repeat(240),
    source: `export const value${index} = ${index}`,
  }))
  await assert.rejects(
    store.mutate(saved.revision, () => ({ entries: declarationHeavy })),
    /model-context limit/,
  )
  assert.equal((await store.list()).revision, saved.revision)
  assert.equal((await store.snapshot()).entries[0].id, 'math')
  assert.equal(await readFile(filename, 'utf8'), before)

  await writeFile(filename, `${JSON.stringify({ entries: declarationHeavy })}\n`)
  const damaged = await store.reload()
  assert.match(damaged.error, /model-context limit/)
  assert.deepEqual((await store.snapshot()).entries, [])
})

test('can save directly before the first catalog read', async (t) => {
  const { store } = await fixture(t)
  const saved = await store.save(binding(), 1)
  assert.equal(saved.entries[0].id, 'math')
})

test('creates a new entry without overwriting an existing stable id', async (t) => {
  const { store } = await fixture(t)
  const initial = await store.list()
  const created = await store.create(binding(), initial.revision)
  assert.equal(created.entries[0].purpose, 'Math helpers.')
  await assert.rejects(
    store.create(binding({ purpose: 'Replacement.' }), created.revision),
    /already exists/,
  )
  assert.equal((await store.entry('math')).entry.purpose, 'Math helpers.')
})

test('updates one existing entry without creating a missing stable id', async (t) => {
  const { filename, store } = await fixture(t)
  const created = await store.create(binding(), (await store.list()).revision)
  const updated = await store.update(binding({ purpose: 'Revised helpers.' }), created.revision)
  assert.equal(updated.entries[0].purpose, 'Revised helpers.')
  assert.equal((await store.entry('math')).entry.purpose, 'Revised helpers.')

  await assert.rejects(
    store.update(binding({ id: 'missing' }), updated.revision),
    /does not exist/,
  )
  assert.equal((await store.list()).revision, updated.revision)
  assert.equal((await store.snapshot()).entries[0].id, 'math')

  await writeFile(filename, `${JSON.stringify({ entries: [binding({ purpose: 'external' })] }, null, 2)}\n`)
  await assert.rejects(
    store.update(binding({ purpose: 'local' }), updated.revision),
    error => error.code === 'BINDINGS_CONFLICT' && /outside this process/.test(error.message),
  )
  assert.equal((await store.reload()).entries[0].purpose, 'external')
})

test('imports local TypeScript with collision-free ids and validates import options', async (t) => {
  const { root, store } = await fixture(t)
  const source = join(root, 'my helpers.ts')
  await writeFile(source, 'export const value: number = 1\n')
  const initial = await store.list()
  const first = await store.importFile(source, initial.revision)
  assert.equal(first.entries[0].id, 'my-helpers')
  assert.equal(first.entries[0].name, 'my_helpers')
  assert.equal(first.entries[0].enabled, false)
  const second = await store.importFile(source, first.revision, {
    name: 'other',
    scope: 'top-level',
    enabled: false,
  })
  assert.equal(second.entries[1].id, 'my-helpers-2')

  const longSource = join(root, `${'a'.repeat(64)}.ts`)
  await writeFile(longSource, 'export const value: number = 2\n')
  const longFirst = await store.importFile(longSource, second.revision)
  assert.equal(longFirst.entries[2].id, 'a'.repeat(64))
  const longSecond = await store.importFile(longSource, longFirst.revision)
  assert.equal(longSecond.entries[3].id, `${'a'.repeat(62)}-2`)
  await assert.rejects(store.importFile(join(root, 'bad.js'), second.revision), /local \.ts file/)

  const unreadable = join(root, 'unreadable.ts')
  await writeFile(unreadable, 'export const x = 1')
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await chmod(unreadable, 0o000)
    await assert.rejects(store.importFile(unreadable, second.revision))
  }
})

test('rejects active identifier conflicts while retaining disabled drafts', async (t) => {
  const { store } = await fixture(t)
  let state = await store.list()
  state = await store.save(binding({ id: 'one' }), state.revision)
  state = await store.save(binding({ id: 'two', enabled: false }), state.revision)
  await assert.rejects(store.setEnabled('two', true, state.revision), /conflicts between entries/)
})
