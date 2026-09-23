import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCALE_NS } from '../src/client-copy.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundleUrl = new URL('../client.js', import.meta.url)

// Artifact contract only: how the built bundle loads, which public slots and
// identities it carries, and what it is allowed to depend on. Reactive
// behaviour belongs to client-runtime.spec.js, so nothing here reads
// src/client.js and nothing asserts how it is written.
async function loadBundle() {
  const source = await readFile(bundleUrl, 'utf8')
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const registrations = []
  const window = { __ModuleLoader__: { load(value) { registrations.push(value) } } }
  runInNewContext(source, { window, TextEncoder })
  assert.equal(registrations.length, 1, 'the bundle registers exactly one client module')
  const loaded = registrations[0]
  const requested = []
  // Enough React and UI primitives to construct the module's component
  // factories; apply() is not called here.
  const react = {
    createElement: () => null, useState: value => [value, () => {}], useRef: value => ({ current: value }),
    useCallback: value => value, useMemo: value => value(), useEffect: () => {},
    useSyncExternalStore: () => undefined, useId: () => 'id', Fragment: 'Fragment',
  }
  const primitives = new Proxy({}, { get: () => undefined })
  const exported = loaded.factory(name => {
    requested.push(name)
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency ${name}`)
  })
  return { source, loaded, exported, packageJson, requested }
}

test('keeps generated client bundle checkout bytes stable', () => {
  const attribute = execFileSync('git', ['check-attr', 'eol', '--', 'client.js'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  assert.equal(attribute, 'client.js: eol: lf')
})

test('checked client bundle loads through the DSH module loader contract', async () => {
  const { loaded, exported, packageJson, requested } = await loadBundle()
  assert.equal(loaded.id, packageJson.name)
  assert.deepEqual([...new Set(requested)], ['react', '@deepseek-ai/dsh-client-ui-primitives'])
  assert.equal(Array.from(exported.inject).join(','), 'slots,locale,connection,remote')
  assert.equal(typeof exported.apply, 'function')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.deepEqual(packageJson.dsh.client.external, ['react'])
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.equal(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-session'), false)
})

test('bundle carries every public slot and entry identity it registers', async () => {
  const { source } = await loadBundle()
  // Slot names are the public registration surface: a bundle missing one of
  // them silently drops a user-visible surface, which is what this asserts.
  for (const slot of [
    'settings.plugin.item',
    'plugins.row.config',
    'conversation.session.header.actions',
    'conversation.chat.commandview',
    'conversation.input.left',
    'conversation.input.dock',
    'conversation.view',
    'conversation.composer',
    'tool.call.toolview',
  ]) {
    assert.ok(source.includes(slot), `bundle does not register ${slot}`)
  }
  for (const identity of [
    'ptc-plus-active',
    'ptc-plus-binding-author',
    'ptc-plus-repl',
    'run_code',
    'edit_run_code',
    LOCALE_NS,
  ]) {
    assert.ok(source.includes(identity), `bundle does not carry ${identity}`)
  }
  assert.equal(source.includes('dsh-client-ui-conversation/client'), false)
})
