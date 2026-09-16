/**
 * Load PTC Plus against the execution seam the installed DSH reads.
 *
 * `import('dsh-ptc-plus')` proves the package resolves; it does not prove that
 * the host and the plugin agree on the service the session REPL takes over.
 * Cordis keeps a plugin whose injection names an unregistered service pending
 * and reports no error, so a renamed or replaced seam leaves `run_code`
 * executing in the host's own runtime while an import check still passes.
 *
 * This runner reads the service name from the installed host's own tool runtime
 * — the consumer the plugin integrates with — registers that service beside the
 * other services the plugin requires, and requires the plugin to activate and to
 * take over the registered execution entry.
 *
 * Usage: `node scripts/dsh-execution-seam-smoke.mjs [plugin-specifier]`, with the
 * working directory set to the consumer installation.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// One execution service name is expected. A host that exposes several would need
// a selection rule this smoke cannot own, so it fails instead of guessing.
export function executionServiceName(source) {
  const names = new Set()
  for (const match of source.matchAll(/\bget\(\s*["']([A-Za-z_$][\w$]*Runtime)["']\s*\)/g)) names.add(match[1])
  if (names.size !== 1) {
    throw new Error(`dsh-execution-seam-smoke: the installed tool runtime names ${names.size} execution services (${[...names].join(', ') || 'none'})`)
  }
  return [...names][0]
}

async function main() {
  const consumer = process.cwd()
  const pluginSpecifier = process.argv[2] ?? 'dsh-ptc-plus'
  const require = createRequire(join(consumer, 'noop.cjs'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)

  const { Context } = await load('@deepseek-ai/cordis')
  const seamService = executionServiceName(readFileSync(require.resolve('@deepseek-ai/dsh-tools'), 'utf8'))
  const plugin = await load(pluginSpecifier)

  // The services the plugin requires beside the seam. Production resolves them
  // from the DSH plugin graph; this host provides the shapes the plugin reads.
  const ctx = new Context()
  ctx.provide('tools', { get: () => undefined, schemas: () => [], register: () => () => {} })
  ctx.provide('systemPrompt', { section: () => () => {}, context: () => () => {} })
  ctx.provide('agents', { list: () => [] })
  ctx.provide('llm', {})
  const runtime = {
    language: 'typescript',
    isolation: 'process',
    executionInstructions: 'provider program guidance',
    sandboxMode: 'workspace-write',
    timeout: { defaultMs: 1_000, maxMs: 2_000 },
    resolve: request => ({ ...request, cwd: consumer, timeoutMs: null }),
    async run() { return { logs: [], value: null } },
  }
  ctx.provide(seamService, runtime)

  // A plugin whose injection is never satisfied stays pending forever and Cordis
  // reports nothing, so the wait needs its own bound. The timer keeps the loop
  // alive until it fires or the plugin attaches.
  let expiry
  const activated = await Promise.race([
    Promise.resolve(plugin.apply(ctx, {})),
    new Promise((_, reject) => {
      expiry = setTimeout(() => reject(new Error(
        `dsh-execution-seam-smoke: the plugin did not attach to ${seamService}; ` +
        'the installed host and the plugin disagree on the execution service',
      )), 15_000)
    }),
  ]).finally(() => clearTimeout(expiry))
  if (!Object.hasOwn(runtime, 'run')) throw new Error('dsh-execution-seam-smoke: the plugin did not take over the execution entry')
  if (runtime.sandboxMode !== undefined || runtime.timeout !== undefined) {
    throw new Error('dsh-execution-seam-smoke: the plugin still advertises confinement or a per-call deadline it does not provide')
  }
  await ctx.fiber.dispose()
  console.log(`attached to ${seamService} and took over its execution entry`)
  return activated
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
