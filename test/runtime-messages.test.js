import assert from 'node:assert/strict'
import { sessionEvents } from '../internal/session-events.js'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { auditRuntimeContexts, isRuntimeContextSource } from '../scripts/acceptance-contract.mjs'
import { createRuntimeMessageOwner, projectRuntimeMessages, sessionRuntimeContexts } from '../internal/runtime-contexts.js'
import { latestRecoveryTip } from '../internal/recovery-tips.js'
import { createUserBindingsSnapshot, userBindingsConfiguredContext } from '../internal/user-bindings.js'
import { projectSessionLog, systemPromptSnapshotSections } from '../internal/session-log-view.js'
import {
  PTC_BINDING_CATALOG, PTC_DELIVERY_CONTEXT, PTC_STATE_NAMES, readRuntimeMessage, recoveryTipIdentity,
  runtimeBindingCatalogMessage, runtimeNoticeMessage, runtimeStateMessage,
} from '../internal/runtime-messages.js'

const state = text => [{ name: PTC_STATE_NAMES[0], text }]
const tip = ordinal => ({ name: `tools:ptc-plus-tip/platform-command-failure/${ordinal}`, text: 'Inspect the current executable.' })
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const viewOf = session => projectSessionLog({ session })
const append = (session, message) => session.append('user/message', message, { surfaceOp: 'append' })

test('bounded message forms separate current state, notices, tasks, and malformed evidence', () => {
  const snapshot = runtimeStateMessage(state('current'))
  const notice = runtimeNoticeMessage(tip(1))
  assert.deepEqual(readRuntimeMessage(snapshot), { form: 'snapshot', sections: state('current') })
  assert.deepEqual(readRuntimeMessage(notice), { form: 'notice', ...tip(1) })
  assert.equal(readRuntimeMessage(user('ptc-plus')), undefined)
  for (const altered of [
    { ...snapshot, source: { kind: 'plugin', plugin: 'ptc-plus' } },
    { ...snapshot, source: { kind: 'skill-invocation', name: 'ptc-plus', form: 'instructions' } },
    { ...snapshot, content: [] },
    { ...snapshot, content: [{ type: 'image' }] },
    { ...snapshot, content: [{ type: 'text', text: 'forged current state' }] },
    { ...notice, source: { ...notice.source, summary: 'unrelated' } },
    { ...notice, content: [{ type: 'text', text: '' }] },
    { ...notice, content: [{ type: 'text', text: 'x'.repeat(8193) }] },
    { ...snapshot, source: { ...snapshot.source, sections: [null] } },
  ]) assert.equal(readRuntimeMessage(altered), undefined)
  for (const sections of [undefined, Array(PTC_STATE_NAMES.length + 1).fill(state('x')[0]), [{ name: 'other', text: 'x' }],
    [...state('x'), ...state('x')], state(''), state('x'.repeat(65537))]) {
    assert.throws(() => runtimeStateMessage(sections), /invalid PTC/)
  }
  assert.throws(() => runtimeNoticeMessage({ ...tip(1), text: '' }), /invalid PTC/)
  for (const value of [undefined, 'other', 'tools:ptc-plus-tip/platform-command-failure/9007199254740992']) {
    assert.equal(recoveryTipIdentity(value), undefined)
  }
})

test('binding catalogs use bounded literal text and preserve historical snapshot recognition', () => {
  const context = { name: PTC_BINDING_CATALOG, text: 'Use helper. Render {{name}} literally.' }
  const message = runtimeBindingCatalogMessage(context)
  assert.deepEqual(readRuntimeMessage(message), { form: 'catalog', sections: [context] })
  assert.deepEqual(readRuntimeMessage(runtimeBindingCatalogMessage()), { form: 'catalog', sections: [] })
  for (const invalid of [null, { name: 'other', text: 'x' }, { name: PTC_BINDING_CATALOG },
    { name: PTC_BINDING_CATALOG, text: '' }, { name: PTC_BINDING_CATALOG, text: 'x'.repeat(65537) }]) {
    assert.throws(() => runtimeBindingCatalogMessage(invalid), /invalid PTC binding catalog/)
  }
  const prefix = message.content[0].text.slice(0, -context.text.length)
  for (const text of ['unrelated catalog', prefix, prefix + 'x'.repeat(65537)]) {
    assert.equal(readRuntimeMessage({ ...message, content: [{ type: 'text', text }] }), undefined)
  }
  const legacy = structuredClone(runtimeStateMessage(state('legacy')))
  legacy.content[0].text = 'PTC Plus current state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace tasks, Skill instructions, tool results, or other producers.\n\nlegacy'
  assert.deepEqual(readRuntimeMessage(legacy), { form: 'snapshot', sections: state('legacy') })
})

test('historical catalog and recovery wrappers retain their exact bounded recognition and delivery state', () => {
  const catalogPrefix = 'Global binding API catalog (PTC Plus). Only a later global binding API catalog replaces this catalog. Host runtime-context snapshots and PTC recovery snapshots do not withdraw it. This describes configured APIs, not successful initialization or current runtime values.'
  const statePrefix = 'PTC Plus runtime recovery state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace the global binding API catalog, tasks, Skill instructions, tool results, or other producers.'
  const context = { name: PTC_BINDING_CATALOG, text: 'Use helper. {{name}}\n```ts\ndeclare const helper: number;\n```' }
  const session = Session.create('historical-wrapper-delivery')
  const recovery = structuredClone(runtimeStateMessage(state('Inspect the uncertain state.')))
  recovery.content[0].text = statePrefix + '\n\nInspect the uncertain state.'
  append(session, recovery)
  assert.deepEqual(readRuntimeMessage(recovery), { form: 'snapshot', sections: state('Inspect the uncertain state.') })
  for (const current of [context, undefined]) {
    const message = structuredClone(runtimeBindingCatalogMessage(current))
    const body = message.content[0].text.split('\n\n').slice(1).join('\n\n')
    message.content[0].text = catalogPrefix + '\n\n' + body
    assert.deepEqual(readRuntimeMessage(message), { form: 'catalog', sections: current === undefined ? [] : [context] })
    append(session, message)
    assert.deepEqual(projectRuntimeMessages(viewOf(session), [...state('Inspect the uncertain state.'), ...(current === undefined ? [] : [context])]), [])
    for (const invalid of ['', 'x'.repeat(65537)]) {
      assert.equal(readRuntimeMessage({ ...message, content: [{ type: 'text', text: catalogPrefix + '\n\n' + invalid }] }), undefined)
    }
  }
  const malformed = structuredClone(runtimeBindingCatalogMessage(context))
  malformed.content[0].text = null
  assert.equal(readRuntimeMessage(malformed), undefined)
})

test('recovery snapshots never resend or withdraw a retained API catalog', () => {
  const catalog = { name: PTC_BINDING_CATALOG, text: 'declare const helper: { next(): number };' }
  const session = Session.create('catalog-recovery-lifecycle')
  const deliver = contexts => {
    const messages = projectRuntimeMessages(viewOf(session), contexts)
    assert.deepEqual(projectRuntimeMessages(viewOf(session), contexts, messages), [])
    messages.forEach(message => append(session, message))
    return messages.map(readRuntimeMessage)
  }
  assert.deepEqual(deliver([catalog]).map(message => message.form), ['catalog'])
  for (const name of ['tools:ptc-plus-cordis-recovery', 'tools:ptc-plus-rewrite-info']) {
    assert.deepEqual(deliver([catalog, { name, text: 'Inspect the uncertain state.' }]), [
      { form: 'snapshot', sections: [{ name, text: 'Inspect the uncertain state.' }] },
    ])
    assert.deepEqual(deliver([catalog]), [{ form: 'snapshot', sections: [] }])
  }
  const config = { allowed: [catalog, ...PTC_STATE_NAMES.slice(0, 2).map(name => ({ name }))]
    .map(({ name }) => ({ name, maxChars: 1000 })) }
  assert.deepEqual(auditRuntimeContexts(sessionEvents(session), config).failures, [])
  assert.deepEqual(deliver([]), [{ form: 'catalog', sections: [] }])
  assert.deepEqual(deliver([]), [])
  const nodes = session.surface.nodes
  session.append('user/message', user('Summary'), {
    surfaceOp: { op: 'replace', start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: nodes,
  })
  assert.deepEqual(deliver([]).map(message => message.form), ['snapshot', 'catalog'])
  assert.deepEqual(deliver([]), [])
})

test('audit detects unchanged binding sections inside otherwise changed snapshots', () => {
  const session = Session.create('legacy-section-repetition')
  const catalog = { name: PTC_BINDING_CATALOG, text: 'declare const helper: unknown;' }
  append(session, runtimeStateMessage([catalog]))
  append(session, runtimeStateMessage([catalog, ...state('unknown completion')]))
  const audit = auditRuntimeContexts(sessionEvents(session), {
    allowed: [catalog, ...state('unknown completion')].map(({ name }) => ({ name, maxChars: 1000 })),
  })
  assert.match(audit.failures.join('\n'), /repeats unchanged binding documentation/)
})

test('committed history deduplicates notices while public surface controls retained state', () => {
  const session = Session.create('message-projection')
  assert.deepEqual(projectRuntimeMessages(viewOf(session), []), [])
  const contexts = [...state('current'), tip(1)]
  const first = projectRuntimeMessages(viewOf(session), contexts)
  assert.equal(first.length, 2)
  assert.equal(projectRuntimeMessages(viewOf(session), contexts).length, 2)
  assert.deepEqual(projectRuntimeMessages(viewOf(session), contexts, first), [])
  const saved = first.map(message => append(session, message))
  assert.deepEqual(projectRuntimeMessages(viewOf(session), contexts), [])
  const task = createUserMessage({ source: { kind: 'plugin', plugin: 'ptc-plus' }, content: [{ type: 'text', text: 'Author this binding.' }] })
  append(session, task)
  const changed = projectRuntimeMessages(viewOf(session), state('changed'))
  assert.equal(changed.length, 1)
  append(session, changed[0])
  assert.equal(session.deriveMessages().some(message => message.id === task.id), true)
  const cleared = projectRuntimeMessages(viewOf(session), [])
  assert.equal(cleared.length, 1)
  append(session, cleared[0])
  assert.deepEqual(projectRuntimeMessages(viewOf(session), []), [])
  const nodes = session.surface.nodes
  session.append('user/message', user('Compacted summary mentions old state.'), {
    surfaceOp: { op: 'replace', start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: [...nodes],
  })
  assert.equal(viewOf(session).ptcMessages.length, 4)
  assert.equal(viewOf(session).visibleRuntimeMessages.length, 0)
  assert.equal(projectRuntimeMessages(viewOf(session), contexts).length, 1)
  assert.equal(projectRuntimeMessages(viewOf(session), [tip(2)]).length, 2)
  assert.equal(saved[0].data.source.form, 'snapshot')
  assert.deepEqual(projectRuntimeMessages(viewOf({ events: [] }), contexts), [])
})

test('canonical historical aggregate sections coexist with independent PTC messages', () => {
  const session = Session.create('mixed-runtime-history')
  const aggregate = sections => createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections },
    content: [{ type: 'text', text: sections.map(section => section.text).join('\n') }],
  })
  append(session, aggregate([...state('legacy'), tip(1), { name: 'other', text: 'policy' }]))
  assert.deepEqual(projectRuntimeMessages(viewOf(session), [...state('legacy'), tip(1)]), [])
  append(session, runtimeStateMessage(state('independent')))
  append(session, aggregate([{ name: 'other', text: 'changed policy' }]))
  assert.deepEqual(projectRuntimeMessages(viewOf(session), state('independent')), [])
  assert.equal(projectRuntimeMessages(viewOf(session), []).length, 1)
  const damaged = { events: [], get surface() { throw new Error('unavailable') } }
  assert.equal(viewOf(damaged).visibleRuntimeMessages, undefined)
  assert.equal(viewOf({ events: [], surface: { nodes: [99] } }).visibleRuntimeMessages, undefined)
})

test('configured binding prompts reconstruct, reappear after compaction, and withdraw through persisted snapshots', () => {
  const context = instructions => userBindingsConfiguredContext(createUserBindingsSnapshot({ entries: [{
    id: 'helper', name: 'helper', scope: 'namespace', enabled: true, source: 'export const value = 1',
    modelContext: { includeDeclaration: false, instructions },
  }] }))
  const first = [context('Use helper.value for the first task.')]
  const revised = [context('Use helper.value for the revised task. Render {{name}} literally.')]
  const session = Session.create('configured-binding-context')
  append(session, projectRuntimeMessages(viewOf(session), first)[0])
  const restored = Session.create('restored-configured-context', sessionEvents(session))
  assert.deepEqual(projectRuntimeMessages(viewOf(restored), first), [])
  const update = projectRuntimeMessages(viewOf(restored), revised)
  assert.equal(update.length, 1)
  append(restored, update[0])
  assert.deepEqual(projectRuntimeMessages(viewOf(restored), revised), [])
  assert.ok(restored.deriveMessages()[0].content[0].text.includes('first task'))
  const nodes = restored.surface.nodes
  restored.append('user/message', user('Compacted task summary.'), {
    surfaceOp: { op: 'replace', start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: [...nodes],
  })
  const reaffirmed = projectRuntimeMessages(viewOf(restored), revised)
  assert.equal(reaffirmed.length, 1)
  append(restored, reaffirmed[0])
  const clear = projectRuntimeMessages(viewOf(restored), [])
  assert.equal(clear.length, 1)
  assert.deepEqual(readRuntimeMessage(clear[0]).sections, [])
  append(restored, clear[0])
  const cleared = Session.create('restored-cleared-context', sessionEvents(restored))
  assert.deepEqual(projectRuntimeMessages(viewOf(cleared), []), [])
})

test('historical activation claims are withdrawn once without retaining duplicate interfaces', () => {
  const configured = userBindingsConfiguredContext(createUserBindingsSnapshot({ entries: [{
    id: 'files', name: 'fileTools', scope: 'namespace', enabled: true,
    source: 'export function next(): number { return 1 }',
  }] }))
  const active = { name: 'tools:ptc-plus-user-bindings',
    text: 'Previously activated bindings.\n\n```ts\ndeclare const fileTools: { next(): number; };\n```' }
  for (const producer of ['ptc-plus', '@deepseek-ai/dsh-system-prompt']) {
    for (const current of [[configured], []]) {
      const session = Session.create(`historical-activation-${producer}-${current.length}`)
      const sections = [configured, active]
      const historical = producer === 'ptc-plus' ? runtimeStateMessage(sections) : createUserMessage({
        source: { kind: 'plugin', plugin: producer, form: 'snapshot', sections },
        content: [{ type: 'text', text: sections.map(section => section.text).join('\n\n') }],
      })
      append(session, historical)
      const restored = Session.create('restored-activation-claims', sessionEvents(session))
      const proposed = projectRuntimeMessages(viewOf(restored), current)
      assert.equal(proposed.length, current.length + 1)
      assert.deepEqual(readRuntimeMessage(proposed[0]).sections, [])
      assert.equal(proposed.map(message => message.content[0].text).join('\n').split('declare const fileTools: {').length - 1, current.length)
      assert.match(proposed[0].content[0].text, /Replaces earlier PTC recovery status/)
      assert.deepEqual(projectRuntimeMessages(viewOf(restored), current, proposed), [])
      proposed.forEach(message => append(restored, message))
      assert.deepEqual(projectRuntimeMessages(viewOf(restored), current), [])
      assert.deepEqual(projectRuntimeMessages(viewOf(Session.create('after-clearance', sessionEvents(restored))), current), [])
      assert.equal(restored.deriveMessages()[0].id, historical.id)
    }
  }
})

test('historical aggregate clearance and pending replacement require current PTC declarations', () => {
  const session = Session.create('aggregate-clearance')
  const legacy = createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: state('active') },
    content: [{ type: 'text', text: 'active' }],
  })
  const clear = createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    content: [{ type: 'text', text: 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.' }],
  })
  assert.deepEqual(systemPromptSnapshotSections(clear), [])
  for (const content of [undefined, [], [{ type: 'image' }], [{ type: 'text', text: 'summary of old state' }]]) {
    assert.equal(systemPromptSnapshotSections({ ...clear, content }), undefined)
  }
  append(session, legacy)
  assert.deepEqual(projectRuntimeMessages(viewOf(session), state('active')), [])
  const migration = projectRuntimeMessages(viewOf(session), state('active'), [clear])
  assert.equal(migration.length, 1)
  const unrelated = { ...legacy, source: { ...legacy.source, sections: [{ name: 'other', text: 'policy' }] } }
  assert.equal(projectRuntimeMessages(viewOf(session), state('active'), [unrelated]).length, 1)
  append(session, clear)
  assert.equal(projectRuntimeMessages(viewOf(session), state('active')).length, 1)
  append(session, migration[0])
  assert.deepEqual(projectRuntimeMessages(viewOf(session), state('active'), [clear]), [])
  assert.equal(Object.isFrozen(viewOf(session).visibleRuntimeMessages[0]), true)
})

test('bounded rewrite feedback and exhausted notice ordinals cannot block a later request', () => {
  const contexts = sessionRuntimeContexts({ session: { events: [
    { type: 'turn/start' },
    { type: 'tool/call', data: { callId: 'long-rewrite', name: 'run_code', arguments: JSON.stringify({ code: 'return 1' }) } },
    { type: 'tool/result', data: { message: { source: { callId: 'long-rewrite' } }, meta: {
      dshPtcPlusRewrites: [{ kind: 'import', description: 'x'.repeat(70000) }],
    } } },
  ] } }, { enabled: false }).contexts
  assert.equal(contexts.length, 1)
  assert.match(contexts[0].text, /list truncated/)
  assert.ok(contexts[0].text.length < 3000)
  assert.doesNotThrow(() => runtimeStateMessage(contexts))
  const view = { systemPromptSnapshots: [], contextStep: 100, ptcMessages: [{
    form: 'notice', ...tip(Number.MAX_SAFE_INTEGER), index: 1, contextStep: 1,
  }], latestRun: { args: { code: 'failure' }, journal: { diagnostics: [{ code: 'PTC-X001', message: 'command not found' }] } } }
  assert.equal(latestRecoveryTip(view, { enabled: true, cooldownMessages: 1, escalationFailures: 2 }), undefined)
})

test('mixed tip sources count each committed ordinal once and reset escalation after success', () => {
  const current = { systemPromptSnapshots: [{ index: 1, contextStep: 1, sections: [tip(1)] }],
    contextStep: 10, ptcMessages: [
      { form: 'notice', ...tip(1), index: 2, contextStep: 2 },
      { form: 'notice', ...tip(2), index: 3, contextStep: 3 },
    ], latestRun: { args: { code: 'failure' }, journal: { diagnostics: [{ code: 'PTC-X001', message: 'command not found' }] } } }
  const config = { enabled: true, cooldownMessages: 3, escalationFailures: 2 }
  const result = latestRecoveryTip(current, config)
  assert.equal(result.name, tip(3).name)
  assert.match(result.text, /Re-check/)
  assert.equal(latestRecoveryTip({ ...current, contextStep: 4 }, config), undefined)
  assert.doesNotMatch(latestRecoveryTip({ ...current, lastSuccessfulRunIndex: 4 }, config).text, /Re-check/)
})

test('acceptance audits preserve independent ownership, notice identity, and surface replacement', () => {
  const session = Session.create('runtime-audit')
  const snapshot = runtimeStateMessage(state('current'))
  append(session, snapshot)
  append(session, runtimeNoticeMessage(tip(1)))
  const nodes = session.surface.nodes
  session.append('user/message', user('summary'), {
    surfaceOp: { op: 'replace', start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: [...nodes],
  })
  append(session, runtimeStateMessage(state('current')))
  append(session, runtimeStateMessage([]))
  const config = { allowed: [...state('current'), tip(1)].map(item => ({ name: item.name, maxChars: 100 })) }
  const audited = auditRuntimeContexts(sessionEvents(session), config)
  assert.deepEqual(audited.failures, [])
  assert.deepEqual(audited.snapshots.map(item => item.producer), Array(4).fill('ptc-plus'))
  assert.ok(audited.snapshots.at(-1).transitions.some(item => item.type === 'clear'))
  append(session, runtimeNoticeMessage(tip(1)))
  assert.match(auditRuntimeContexts(sessionEvents(session), config).failures.join('\n'), /delivered identity/)
  assert.equal(isRuntimeContextSource('plugin:ptc-plus:snapshot'), true)
  assert.equal(isRuntimeContextSource('plugin:ptc-plus:notice'), true)
  assert.equal(isRuntimeContextSource('plugin:ptc-plus'), false)
})

test('replacement audits use public order and notice audits retain historical identities', () => {
  const session = Session.create('ordered-audit')
  const first = append(session, runtimeStateMessage(state('first')))
  append(session, runtimeStateMessage(state('current')))
  session.append('user/message', runtimeStateMessage(state('replacement of first')), {
    surfaceOp: { op: 'replace', start: first.seq, end: first.seq }, sourceEventSeqs: [first.seq],
  })
  session.append('request/header', {})
  const config = { allowed: [...state('current'), tip(1)].map(item => ({ name: item.name, maxChars: 100 })) }
  const audited = auditRuntimeContexts(sessionEvents(session), config)
  assert.deepEqual(audited.failures, [])
  assert.equal(audited.requests[0].sections[0].text, 'current')
  assert.deepEqual(projectRuntimeMessages(viewOf(session), state('current')), [])
  append(session, createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [tip(1)] },
    content: [{ type: 'text', text: tip(1).text }],
  }))
  append(session, runtimeNoticeMessage(tip(1)))
  assert.match(auditRuntimeContexts(sessionEvents(session), config).failures.join('\n'), /delivered identity/)
})

test('pending assembly and pre-step cannot reacquire delivery after disposal', async () => {
  const assembly = { contexts: [{ name: PTC_DELIVERY_CONTEXT, text: '' }] }
  const decision = { kind: 'enter', messages: [] }
  for (const disposal of ['agent', 'owner']) {
    const owner = createRuntimeMessageOwner(() => state('late state'))
    const agent = { session: Session.create(`disposed-${disposal}`) }
    const signal = new AbortController().signal
    const context = { agent, signal }
    const gate = Promise.withResolvers()
    const pending = owner.assemble(assembly, context, () => gate.promise)
    if (disposal === 'agent') owner.disposeAgent(agent)
    else owner.dispose()
    gate.resolve(assembly)
    assert.deepEqual((await pending).contexts, [])
    assert.equal(await owner.preStep(context, async () => decision), decision)
    await owner.assemble(assembly, context, async () => assembly)
    assert.equal(await owner.preStep(context, async () => decision), decision)
  }
  const agent = { session: Session.create('disposed-pre-step') }
  const signal = new AbortController().signal
  const context = { agent, signal }
  const owner = createRuntimeMessageOwner(() => state('late state'))
  await owner.assemble(assembly, context, async () => assembly)
  const gate = Promise.withResolvers()
  const pending = owner.preStep(context, () => gate.promise)
  owner.disposeAgent(agent)
  gate.resolve(decision)
  assert.equal(await pending, decision)
})

test('delivery requires a matching permitted assembly and a live request signal', async () => {
  const owner = createRuntimeMessageOwner(() => state('eligible'))
  const agent = { session: Session.create('assembly-permission') }
  const controller = new AbortController()
  const context = { agent, signal: controller.signal }
  const witness = { contexts: [{ name: PTC_DELIVERY_CONTEXT, text: '' }] }
  const decision = { kind: 'enter', messages: [] }
  assert.equal(await owner.preStep(context, async () => decision), decision)
  await owner.assemble(witness, undefined, async () => witness)
  await owner.assemble(witness, { agent: null }, async () => witness)
  await owner.assemble({}, context, async () => witness)
  assert.equal(await owner.preStep(context, async () => decision), decision)
  await owner.assemble(witness, context, async () => ({}))
  assert.equal(await owner.preStep(context, async () => decision), decision)
  await owner.assemble(witness, context, async () => witness)
  assert.equal(await owner.preStep({ ...context, signal: new AbortController().signal }, async () => decision), decision)
  const accepted = await owner.preStep(context, async () => decision)
  assert.equal(accepted.messages.length, 1)
  controller.abort()
  assert.equal(await owner.preStep(context, async () => decision), decision)
  owner.dispose()
})

async function hostFixture(t, includeRuntimeContext = true) {
  const ctx = new Context()
  const fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  for (const [plugin, config] of [
    [SystemPrompt, { includeRuntimeContext }], [SessionStore], [AgentRegistry],
    [LlmRuntime], [SessionProjectionRegistry], [ToolRuntime], [AgentLoop],
  ]) {
    const fiber = ctx.plugin(plugin, config)
    fibers.push(fiber)
    await fiber.await()
  }
  const calls = []
  class Adapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  let current = []
  let unrelated = 'unrelated policy'
  let reject = false
  let cancel = false
  const feature = ctx.plugin({ inject: ['llm', 'systemPrompt'], apply(scope) {
    scope.effect(() => scope.llm.registerAdapter(['fixture'], new Adapter()))
    scope.effect(() => scope.systemPrompt.context({ name: PTC_DELIVERY_CONTEXT, order: 98, text: '' }))
    scope.effect(() => scope.systemPrompt.context({ name: 'other', order: 1, text: () => unrelated }))
    const owner = createRuntimeMessageOwner(() => current)
    scope.on('system-prompt/assemble', (assembly, context, next) => owner.assemble(assembly, context, next))
    scope.on('agent/pre-step', (payload, next) => owner.preStep(payload, next))
    scope.on('agent/pre-step', async ({ agent }, next) => {
      if (cancel) { agent.cancel(); return { kind: 'reject' } }
      return reject ? { kind: 'reject' } : next()
    })
    scope.on('agent/disposed', ({ agent }) => owner.disposeAgent(agent))
    scope.effect(() => () => owner.dispose())
  } })
  fibers.push(feature)
  await feature.await()
  const handle = await ctx.agents.create({ sessionId: 'runtime-messages', agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => handle.dispose())
  const agent = handle.agent
  async function wake(text = 'continue') {
    const idle = new Promise(resolve => {
      const dispose = ctx.on('agent/status', payload => {
        if (payload.agent === agent && payload.status === 'idle') { dispose(); resolve() }
      })
    })
    agent.followup(user(text))
    await idle
  }
  return { ctx, agent, calls, wake, feature,
    setState: value => { current = value }, setOther: value => { unrelated = value },
    reject: value => { reject = value }, cancel: value => { cancel = value },
  }
}

test('real AgentLoop keeps PTC transitions independent and honors runtime suppression', { timeout: 15000 }, async t => {
  const host = await hostFixture(t)
  const messages = () => sessionEvents(host.agent.session).filter(event => event.type === 'user/message')
  const count = producer => messages().filter(event => event.data.source.plugin === producer).length
  host.setState(state('first'))
  await host.wake()
  assert.equal(host.calls.length, 1)
  assert.equal(count('ptc-plus'), 1)
  assert.equal(count('@deepseek-ai/dsh-system-prompt'), 1)
  const prefix = JSON.stringify({ system: host.calls[0].system, tools: host.calls[0].tools })
  host.setState(state('second'))
  await host.wake()
  assert.equal(count('ptc-plus'), 2)
  assert.equal(count('@deepseek-ai/dsh-system-prompt'), 1)
  host.setOther('different unrelated policy')
  await host.wake()
  assert.equal(count('ptc-plus'), 2)
  assert.equal(count('@deepseek-ai/dsh-system-prompt'), 2)
  await host.wake()
  assert.equal(count('ptc-plus'), 2)
  assert.equal(count('@deepseek-ai/dsh-system-prompt'), 2)
  const release = host.agent.ctx.systemPrompt.suppressRuntimeContext()
  host.setState(state('suppressed'))
  await host.wake()
  assert.equal(count('ptc-plus'), 2)
  release()
  await host.wake()
  assert.equal(count('ptc-plus'), 3)
  host.setState([])
  await host.wake()
  assert.equal(count('ptc-plus'), 4)
  assert.deepEqual(readRuntimeMessage(messages().filter(event => event.data.source.plugin === 'ptc-plus').at(-1).data).sections, [])
  for (const call of host.calls) assert.equal(JSON.stringify({ system: call.system, tools: call.tools }), prefix)
})

test('real AgentLoop rejection and cancellation do not mark a proposed notice delivered', { timeout: 15000 }, async t => {
  const host = await hostFixture(t)
  host.setState([tip(1)])
  host.reject(true)
  await host.wake()
  assert.equal(host.calls.length, 0)
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 0)
  host.reject(false)
  host.cancel(true)
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 0)
  host.cancel(false)
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  assert.equal(host.calls.length, 1)
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
})

test('real Host clearance leaves an explicitly scoped catalog valid across unchanged suppression', { timeout: 15000 }, async t => {
  const host = await hostFixture(t)
  const catalog = { name: PTC_BINDING_CATALOG, text: 'COUNTER_BETA. declare const counter: { next(): number };' }
  host.setState([catalog])
  await host.wake()
  const first = viewOf(host.agent.session).ptcMessages[0]
  assert.equal(first.form, 'catalog')
  const release = host.agent.ctx.systemPrompt.suppressRuntimeContext()
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  const suppressed = host.calls.at(-1).messages
  assert.ok(suppressed.some(message => message.content.some(block => block.text ===
    'Current runtime context: none. Earlier runtime-context snapshots no longer apply.')))
  const retained = suppressed.find(message => readRuntimeMessage(message)?.form === 'catalog')
  assert.match(retained.content[0].text, /remains applicable until the next binding catalog/)
  assert.match(retained.content[0].text, /COUNTER_BETA/)
  release()
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  const pause = host.agent.ctx.systemPrompt.suppressRuntimeContext()
  host.setState([{ ...catalog, text: 'COUNTER_GAMMA' }])
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  pause()
  await host.wake()
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 2)
  for (const call of host.calls) {
    assert.equal(call.system, host.calls[0].system)
    assert.deepEqual(call.tools, host.calls[0].tools)
  }
})

test('real AgentLoop migrates an active historical aggregate section during unrelated replacement', { timeout: 15000 }, async t => {
  const host = await hostFixture(t)
  append(host.agent.session, createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: state('active') },
    content: [{ type: 'text', text: 'active' }],
  }))
  host.setState(state('active'))
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  assert.deepEqual(viewOf(host.agent.session).ptcMessages[0].sections, state('active'))
  host.setOther('')
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
})

test('includeRuntimeContext false suppresses independent PTC messages through the public witness', { timeout: 15000 }, async t => {
  const host = await hostFixture(t, false)
  host.setState([...state('hidden'), tip(1)])
  await host.wake()
  assert.equal(host.calls.length, 1)
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 0)
})
