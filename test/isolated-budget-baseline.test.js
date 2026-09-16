import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

test('samples a fresh compute baseline after earlier work settles', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ptc-warm-baseline-'))
  t.after(async () => { await rm(temporary, { recursive: true, force: true }) })

  for (let iteration = 0; iteration < 3; iteration++) {
    const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 3_000 })
    try {
      const flag = join(temporary, String(iteration))
      const first = await runtime.run('warm', { bindings: [], program: `
const fs = await import('node:fs')
setTimeout(() => {
  const started = performance.now()
  while (performance.now() - started < 135) {}
  fs.writeFileSync(${JSON.stringify(flag)}, 'ready')
}, 150)
return 1
` })
      assert.equal(first.error, undefined)
      const deadline = Date.now() + 5_000
      while (!existsSync(flag)) {
        if (Date.now() > deadline) assert.fail('background work did not finish')
        await new Promise(resolve => setTimeout(resolve, 1))
      }

      // The next cell starts immediately after the background callback. Its
      // budget baseline must exclude that completed work even though the
      // helper's last periodic sample predates the callback's final segment.
      runtime.reconfigure({ computeMs: 20, maxWallMs: 3_000 })
      const second = await runtime.run('warm', {
        bindings: [],
        program: 'await new Promise(resolve => setTimeout(resolve, 100)); return 7',
      })
      assert.deepEqual(second, { logs: [], value: 7 })
    } finally {
      await runtime.dispose()
    }
  }
})
