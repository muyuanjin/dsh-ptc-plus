import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function main() {
  const consumer = process.cwd()
  const require = createRequire(join(consumer, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const pluginRoot = dirname(require.resolve('dsh-ptc-plus/package.json'))
  const pluginModule = name => import(pathToFileURL(join(pluginRoot, 'internal', name)).href)
  const [{ Context }, { Session, SessionStore }, jsonl, { createUserMessage }, direct, config, events] = await Promise.all([
    load('@deepseek-ai/cordis'),
    load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-session-persistence-jsonl'),
    load('@deepseek-ai/dsh-llm'),
    pluginModule('direct-surface-owner.js'),
    pluginModule('config-spec.js'),
    pluginModule('session-events.js'),
  ])
  const root = await mkdtemp(join(tmpdir(), 'ptc-host-message-persistence-'))
  const ctx = new Context()
  const fibers = []
  let owner
  try {
    fibers.push(ctx.plugin(SessionStore))
    await fibers.at(-1).await()
    fibers.push(ctx.plugin(jsonl.JsonlSessionPersistence ?? jsonl.default, { root, compression: 'zstd' }))
    await fibers.at(-1).await()
    const persistence = ctx.get('sessionPersistence')
    const session = Session.create('argument-diagnostic-roundtrip')
    owner = direct.createDirectSurfaceOwner({ runtimeConfig: config.CONFIG_DEFAULTS, sessionId: agent => agent.id })
    for (const nested of [false, true]) {
      const result = owner.argumentDiagnostic({
        name: 'run_code',
        agent: { id: session.id },
        arguments: { code: 'return 1', ...(nested ? { description: 'Run' } : {}) },
      }, { isError: true, error: { message: 'missing required property "description"' } })
      session.append('agent/inbox/spliced', {
        target: 'next-step', start: nested ? 1 : 0, inserted: result.additionalContexts,
      })
    }
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after diagnostic' }],
    }), { surfaceOp: 'append' })
    const expected = events.sessionEvents(session)
    const write = await persistence.create(session.header)
    try {
      await write.append(expected)
      await write.flush()
    } finally {
      await write.close()
    }
    const read = await persistence.open(session.id, 'read')
    let stored
    try {
      stored = await read.read()
    } finally {
      await read.close()
    }
    assert.deepEqual(stored.events, expected)
    assert.ok((await readdir(root, { recursive: true })).some(file => file.endsWith('.jsonl.zstd')))
    console.log('compressed diagnostic inbox persistence preserved all events and message identities')
  } finally {
    owner?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
