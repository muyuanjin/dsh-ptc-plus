import { latestRecoveryTip, runtimeHistoryForView } from './recovery-tips.js'
import { foldSurface, deriveEventMessage, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { readSessionLog } from './session-events.js'
import { JOURNAL_KEY } from './session-journal.js'
import { projectSessionLog, runtimeMessageFacts, systemPromptSnapshotSections } from './session-log-view.js'
import {
  PTC_BINDING_CATALOG, PTC_DELIVERY_CONTEXT, PTC_STATE_NAMES, readRuntimeMessage,
  runtimeBindingCatalogMessage, runtimeNoticeMessage, runtimeStateMessage,
  projectRuntimeAvailability,
  runtimeAvailabilityMessage,
} from './runtime-messages.js'

const REWRITE_FEEDBACK = 'tools:ptc-plus-rewrite-info'
const CORDIS_RECOVERY = 'tools:ptc-plus-cordis-recovery'
const CORDIS_RECOVERY_TEXT = 'Recorded Cordis values in the recovered REPL are historical data, not proof that process-local Plugins, Runs, approvals, or Inspect observations still exist in the current DSH process. Before relying on prior Cordis IDs, state, or capability data, follow the current Cordis owner guidance and call the live read-only Cordis Inspect bindings through `tools.*`; do not rerun mutating Cordis calls merely to reconstruct history.'

// A historical plugin result proves that this provider was used, not that its
// bindings remain known, recoverable, initialized or currently alive.
function hadPluginComputation(session) {
  return (session?.events ?? []).some(event => event.type === 'tool/result'
    && Object.hasOwn(event.data?.meta ?? {}, JOURNAL_KEY))
}

/** Persist actual provider release through public Session and single-writer owners. */
export async function handBackRuntimeSessions(ctx, owners) {
  const service = name => owners ? owners[name] : typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  const sessions = service('sessions')
  const persistence = service('sessionPersistence')
  const query = service('sessionQuery')
  if (!sessions?.list || !sessions?.flush || !persistence?.list || !persistence?.open) {
    throw new Error('PTC Plus provider handback requires the public session and persistence owners')
  }
  const live = new Map(sessions.list().map(session => [session.id, session]))
  const failures = []
  const withdraw = (session, log) => {
    if (!projectRuntimeAvailability(session.deriveMessages(), false, hadPluginComputation(log))) return undefined
    return session.append('user/message', runtimeAvailabilityMessage('unloaded'), { surfaceOp: 'append' })
  }
  for (const session of live.values()) {
    try {
      const log = await readSessionLog(session, query)
      const event = withdraw(session, log)
      const pending = session.deriveMessages().some(message => message.source?.form === 'runtime-availability')
      if ((event || pending) && await sessions.flush(session) !== true) throw new Error('No public durability listener confirmed the session handback')
    } catch (error) { failures.push(new Error(`PTC Plus handback failed for session ${session.id}`, { cause: error })) }
  }
  const entries = await persistence.list()
  for (const entry of entries) {
    const id = entry.header.id
    if (live.has(id)) continue
    try {
      const handle = await persistence.open(id, 'write')
      try {
        const stored = await handle.read()
        const definitions = new Map(currentSessionMessageProjections.map(item => [item.type, item]))
        for (const definition of sessions.messageProjections ?? []) definitions.set(definition.type, definition)
        const projections = [...definitions.values()]
        const surface = foldSurface(stored.events, projections)
        const messages = surface.nodes.map(seq => deriveEventMessage(stored.events[seq], surface.projectedMessages)).filter(Boolean)
        if (!projectRuntimeAvailability(messages, false, hadPluginComputation({ events: stored.events }))) continue
        // This is a new fact from the releasing provider, not a Session resume.
        // The exclusive writer's next offset owns the new event's identity.
        const event = snapshotSessionEvent({ type: 'user/message', seq: stored.events.length, time: Date.now(),
          data: runtimeAvailabilityMessage('unloaded'), surfaceOp: 'append' })
        foldSurface([...stored.events, event], projections)
        await handle.append([event])
        await handle.flush()
      } finally { await handle.close() }
    } catch (error) { failures.push(new Error(`PTC Plus handback failed for session ${id}`, { cause: error })) }
  }
  if (failures.length) throw new AggregateError(failures, 'PTC Plus provider released, but session handback is incomplete')
}

function continuationFeedback(view) {
  const run = view.latestRun
  const rewrites = run?.rewrites
  if (rewrites === undefined || rewrites.length === 0 || run.journal !== undefined) return undefined
  const descriptions = rewrites.map(rewrite => rewrite.description).join('; ')
  const details = descriptions.length <= 2048 ? descriptions
    : `${descriptions.slice(0, 2048)}... (source-adjustment list truncated)`
  return `The preceding run_code cell had these source adjustments: ${details}. Its completion is unknown because no valid execution journal is available. Inspect its tool result and live bindings before continuing; do not assume it completed or failed, and do not replay it automatically.`
}

/** Build all dynamic PTC contexts from one session-log projection. */
export function sessionRuntimeContexts(agent, tipConfig, options = {}) {
  const view = (options.sessionLogView ?? projectSessionLog)(agent)
  const rewrite = continuationFeedback(view)
  const tip = latestRecoveryTip(view, tipConfig)
  const cordisRecovery = options.cordisRecoveryRequired?.(view) === true
    ? { name: CORDIS_RECOVERY, text: CORDIS_RECOVERY_TEXT }
    : undefined
  return Object.freeze({
    contexts: Object.freeze([
      ...(rewrite === undefined ? [] : [{ name: REWRITE_FEEDBACK, text: rewrite }]),
      ...(cordisRecovery === undefined ? [] : [cordisRecovery]),
      ...(tip === undefined ? [] : [tip]),
    ]),
  })
}

/** Project messages without treating an uncommitted proposal as delivery. */
export function projectRuntimeMessages(view, contexts, pending = [], options) {
  if (view.visibleRuntimeMessages === undefined) return []
  const sections = contexts.filter(context => PTC_STATE_NAMES.includes(context.name) && context.name !== PTC_BINDING_CATALOG)
  const catalog = contexts.find(context => context.name === PTC_BINDING_CATALOG)
  const records = view.visibleRuntimeMessages
  const facts = view.visibleRuntimeFacts ?? runtimeMessageFacts(records)
  const history = runtimeHistoryForView(view)
  const owned = facts.snapshot
  const legacy = facts.aggregate
  const pendingAggregate = pending.map(systemPromptSnapshotSections).filter(sections => sections !== undefined).at(-1)
  const retained = owned?.sections
    ?? (pendingAggregate ?? legacy?.sections)?.filter(section => PTC_STATE_NAMES.includes(section.name))
  const hadState = history.hadState
  const messages = []
  const proposed = pending.map(record => readRuntimeMessage(record)).filter(record => record !== undefined)
  const pendingState = proposed.filter(record => record.form === 'snapshot').at(-1)
  const previous = pendingState?.sections ?? retained
  if ((sections.length > 0 || (previous !== undefined && previous.length > 0) || (previous === undefined && hadState))
    && JSON.stringify(previous) !== JSON.stringify(sections)) {
    messages.push(runtimeStateMessage(sections))
  }
  const previousCatalog = proposed.filter(record => record.form === 'catalog').at(-1)
    ?? facts.catalog
  const hadCatalog = history.hadCatalog
  if ((catalog !== undefined || previousCatalog !== undefined || hadCatalog)
    && JSON.stringify(previousCatalog?.sections) !== JSON.stringify(catalog === undefined ? [] : [catalog])) {
    messages.push(runtimeBindingCatalogMessage(catalog, options))
  }
  for (const tip of contexts.filter(context => context.name.startsWith('tools:ptc-plus-tip/'))) {
    if (proposed.some(record => record.form === 'notice' && record.name === tip.name)) continue
    if (Object.hasOwn(history.seenNames, tip.name)) continue
    messages.push(runtimeNoticeMessage(tip))
  }
  return messages
}

/** Passive message delivery follows the actual public assembly and accepted step. */
export function createRuntimeMessageOwner(contextsForRequest, sessionLogView = projectSessionLog, activeForRequest, sessionQuery, promptForRequest) {
  const requests = new WeakMap()
  const disposedAgents = new WeakSet()
  let disposed = false
  const hasWitness = assembly => assembly.contexts?.some(context => (
    context.name === PTC_DELIVERY_CONTEXT && context.text === ''
  )) === true
  return Object.freeze({
    async assemble(initial, context, next) {
      const assembly = await next()
      if (!disposed && context?.ptcPlusCapabilityObservation !== true && context?.agent !== null && typeof context?.agent === 'object'
        && !disposedAgents.has(context.agent)) requests.set(context.agent, {
        context,
        allowed: hasWitness(initial) && hasWitness(assembly),
      })
      return hasWitness(assembly) ? {
        ...assembly, contexts: assembly.contexts.filter(item => item.name !== PTC_DELIVERY_CONTEXT),
      } : assembly
    },
    async preStep(payload, next) {
      const decision = await next()
      const request = requests.get(payload.agent)
      if (disposed || decision.kind !== 'enter' || payload.signal?.aborted === true
        || request?.allowed !== true || request.context.signal !== payload.signal) return decision
      const view = sessionLogView(payload.agent)
      const resolved = promptForRequest === undefined ? undefined : promptForRequest(request.context)
      const messages = projectRuntimeMessages(view, contextsForRequest(request.context), decision.messages,
        resolved === undefined ? undefined : { prompt: resolved })
      if (activeForRequest !== undefined) {
        const log = await readSessionLog(payload.agent.session, sessionQuery, payload.signal)
        const availability = projectRuntimeAvailability([
          ...(payload.agent.session.deriveMessages?.() ?? []), ...decision.messages, ...messages,
        ], activeForRequest(request.context), hadPluginComputation(log))
        if (availability) messages.push(availability)
      }
      return messages.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...messages] }
    },
    disposeAgent(agent) { disposedAgents.add(agent); requests.delete(agent) },
    dispose() { disposed = true },
  })
}
