import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createContext, Script } from 'node:vm'
import { parse } from 'yaml'
import { SessionRuntime } from '../internal/session-runtime.js'

const directory = new URL('./fixtures/test262/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'))
const readVerified = (path, hash) => {
  const bytes = readFileSync(new URL(path, directory))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `upstream fixture changed: ${path}`)
  return bytes.toString('utf8')
}
const harness = new Map(Object.entries(manifest.harness).map(([path, hash]) => [path, readVerified(path, hash)]))
const base = `${harness.get('harness/sta.js')}\n${harness.get('harness/assert.js')}\n`

// These are unmodified upstream Script tests run in a fresh native global and
// a fresh PTC cell. This subset makes no full Test262 conformance claim.
for (const fixture of manifest.cases) {
  const source = readVerified(fixture.path, fixture.sha256)
  const metadata = parse(source.match(/\/\*---([\s\S]*?)---\*\//)[1])
  const flags = metadata.flags ?? []
  const policies = fixture.policies ?? ['stateful', 'protected']
  assert.ok(policies.length > 0 && policies.every(value => ['stateful', 'protected'].includes(value)), fixture.path)
  if (policies.length !== 2) assert.equal(typeof fixture.dialectContract, 'string', fixture.path)
  assert.equal(metadata.negative, undefined, `negative fixture requires an explicit adapter: ${fixture.path}`)
  assert.ok(flags.every(flag => ['noStrict', 'onlyStrict', 'generated'].includes(flag)), fixture.path)
  const includes = (metadata.includes ?? []).map(name => {
    const value = harness.get(`harness/${name}`)
    assert.equal(typeof value, 'string', `missing upstream harness: ${name}`)
    return value
  }).join('\n')
  const modes = flags.includes('noStrict') ? [false] : flags.includes('onlyStrict') ? [true] : [false, true]
  for (const strict of modes) {
    const program = `${strict ? '"use strict";\n' : ''}${base}${includes}\n${source}`
    test(`Test262 ${fixture.topic}: ${fixture.path} (${strict ? 'strict' : 'sloppy'})`, async t => {
      new Script(program, { filename: fixture.path }).runInContext(createContext(), { timeout: 5000 })
      for (const bindingUpdates of policies) {
        await t.test(bindingUpdates, async t => {
          const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
          t.after(() => runtime.dispose())
          const result = await runtime.run('test262', { program: `${program}\nreturn true`, bindings: [] })
          assert.equal(result.error, undefined, `${fixture.path}: ${result.error?.message}`)
          assert.equal(result.value, true)
        })
      }
    })
  }
}

test('the upstream harness rejects a false assertion through both execution paths', async t => {
  const program = `${base}assert.sameValue(1, 2, 'harness canary');`
  assert.throws(() => new Script(program).runInContext(createContext()), /harness canary/)
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runtime.run('harness-canary', { program, bindings: [] })
  assert.match(result.error?.message ?? '', /harness canary/)
})
