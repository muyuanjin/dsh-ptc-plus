import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL('./large-dependency-worker-fixture.js', import.meta.url))
const policies = [
  ['stateful', { bindingUpdates: 'stateful' }, 'import'],
  ['protected', { bindingUpdates: 'protected' }, 'require'],
  ['legacy', { legacyBindingSettings: true, looseTopLevelRedeclarations: false }, 'import'],
  ['legacy-loose', { legacyBindingSettings: true, looseTopLevelRedeclarations: true }, 'require'],
]

for (const [name, options, first] of policies) test(`large dependency keeps useful computation and state within default worker budgets (${name})`, async t => {
  // Resource limits describe normal execution. V8 coverage changes allocation
  // and execution cost; semantic suites instrument the same compiler owners.
  await execute(process.execPath, [fixture, JSON.stringify({ name, options, first })], {
    env: { ...process.env, NODE_V8_COVERAGE: '' }, signal: t.signal, windowsHide: true,
  })
})
