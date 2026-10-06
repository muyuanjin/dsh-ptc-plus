import { availableParallelism } from 'node:os'

export function browserConcurrency(value, parallelism = availableParallelism()) {
  if (value === undefined) return Math.max(1, Math.min(3, Math.floor(parallelism / 4)))
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('browser concurrency must be a positive integer')
  }
  return Number(value)
}

export function selectBrowserCases(cases, requested = [], { focus = false, list = false } = {}) {
  if (focus && requested.length === 0 && !list) {
    throw new Error('focused browser diagnostics require --case <id>; use --list to inspect the inventory')
  }
  const ids = new Set(cases.map(item => item.id))
  if (ids.size !== cases.length) throw new Error('browser case IDs must be unique')
  if (requested.length === 0) return cases
  const selected = new Set(requested)
  for (const id of selected) {
    if (!ids.has(id)) throw new Error(`unknown browser case: ${id}`)
  }
  return cases.filter(item => selected.has(item.id))
}

async function createBrowserWorker({ channel, reducedMotion }) {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true, channel })
  try {
    const page = await browser.newPage({ reducedMotion })
    return { page, close: () => browser.close() }
  } catch (error) {
    await browser.close()
    throw error
  }
}

// Each lane owns a browser process and page: keyboard focus, hover, timers and
// fixture globals are never shared between concurrently executing cases.
export async function runBrowserCases(cases, runCase, {
  concurrency = browserConcurrency(), channel, reducedMotion, createWorker = createBrowserWorker,
} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('invalid browser concurrency')
  const results = new Array(cases.length)
  const failures = []
  let next = 0
  const lanes = Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    let worker
    try {
      worker = await createWorker({ channel, reducedMotion })
      while (failures.length === 0 && next < cases.length) {
        const index = next++
        results[index] = await runCase(worker.page, cases[index])
      }
    } catch (error) {
      failures.push(error)
    } finally {
      if (worker !== undefined) {
        try { await worker.close() } catch (error) { failures.push(error) }
      }
    }
  })
  await Promise.all(lanes)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'browser cases or cleanup failed')
  return results
}
