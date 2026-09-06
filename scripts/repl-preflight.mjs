import assert from 'node:assert/strict'
import { isMainThread } from 'node:worker_threads'
import { SessionRuntime } from '../internal/session-runtime.js'

export const RUNTIME_PROBE_PREFIX = 'PTC-EVAL-RUNTIME '

/** Exercise the real kernel before a DSH entry can reach model dispatch. */
export async function probeReplRuntime() {
  const runtime = new SessionRuntime({ durableReplay: false, computeMs: 1000, maxWallMs: 8000 })
  const session = { id: 'runtime-prerequisite', events: [] }
  const run = program => runtime.run(session, { program, bindings: [] })
  try {
    assert.equal((await run('return 1 + 1')).value, 2)
    assert.equal((await run('let retained = 41')).error, undefined)
    for (const code of ['throw new TypeError("probe")', 'await Promise.reject(new TypeError("probe"))']) {
      const result = await run(code)
      assert.equal(result.error?.kind, 'exception')
      assert.match(result.error.message, /probe/)
    }
    assert.ok((await run('const =')).error)
    assert.equal((await run('return Promise.resolve(retained + 1)')).value, 42)
    return { nodeVersion: process.version, nodeExecutable: process.execPath, dshEntry: process.argv[1] }
  } finally {
    await runtime.dispose()
  }
}

if (isMainThread && process.env.DSH_PTC_EVAL_PROBE === '1') {
  try {
    process.stderr.write(RUNTIME_PROBE_PREFIX + JSON.stringify(await probeReplRuntime()) + '\n')
  } catch (error) {
    throw new Error(`PTC-EVAL-PREREQ: Node ${process.version} cannot execute the PTC REPL; no model was called`, { cause: error })
  }
}
