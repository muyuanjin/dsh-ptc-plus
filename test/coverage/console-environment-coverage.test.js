import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UserBindingConsole } from '../../internal/user-binding-console.js'

const options = { cwd: process.cwd(), maxWallMs: 10_000, maxOutputBytes: 64 * 1024, maxOldGenerationSizeMb: 128 }

test('projects the worker environment without host coverage instrumentation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-console-environment-'))
  const previousCoverage = process.env.NODE_V8_COVERAGE
  const previousWorkerCoverage = process.env.DSH_PTC_TEST_WORKER_COVERAGE
  const previousProbe = process.env.PTC_PLUS_CONSOLE_PROBE
  process.env.NODE_V8_COVERAGE = directory
  process.env.PTC_PLUS_CONSOLE_PROBE = 'kept'
  // This regression asserts the production projection. Disable the coverage
  // runner's explicit test instrumentation for the duration of the worker.
  delete process.env.DSH_PTC_TEST_WORKER_COVERAGE
  const owner = new UserBindingConsole({ ...options, maxOldGenerationSizeMb: 32 })
  t.after(async () => {
    await owner.dispose()
    if (previousCoverage === undefined) delete process.env.NODE_V8_COVERAGE
    else process.env.NODE_V8_COVERAGE = previousCoverage
    if (previousWorkerCoverage === undefined) delete process.env.DSH_PTC_TEST_WORKER_COVERAGE
    else process.env.DSH_PTC_TEST_WORKER_COVERAGE = previousWorkerCoverage
    if (previousProbe === undefined) delete process.env.PTC_PLUS_CONSOLE_PROBE
    else process.env.PTC_PLUS_CONSOLE_PROBE = previousProbe
    await rm(directory, { recursive: true, force: true })
  })
  const source = 'export const answer: number = 42'
  const coverage = await owner.run({ source, code: 'process.env.NODE_V8_COVERAGE ?? null' })
  assert.equal(coverage.error, undefined)
  assert.equal(coverage.output, 'null')
  const probe = await owner.run({
    environment: coverage.environment,
    source,
    code: 'process.env.PTC_PLUS_CONSOLE_PROBE ?? null',
  })
  assert.equal(probe.error, undefined)
  assert.equal(probe.output, "'kept'")
  const child = await owner.run({
    environment: probe.environment,
    source,
    code: [
      "const cp = await import('node:child_process')",
      'cp.execFileSync(process.execPath, ',
      `  ['-e', ${JSON.stringify('process.stdout.write(process.env.NODE_V8_COVERAGE ?? "null")')}],`,
      "  { encoding: 'utf8' })",
    ].join('\n'),
  })
  assert.equal(child.error, undefined)
  assert.equal(child.output, "'null'")
})
