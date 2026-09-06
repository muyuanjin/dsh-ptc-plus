import { latestRecoveryTip } from './recovery-tips.js'
import { projectSessionLog, systemPromptSnapshotSections } from './session-log-view.js'
import {
  PTC_DELIVERY_CONTEXT, PTC_STATE_NAMES, readRuntimeMessage,
  runtimeNoticeMessage, runtimeStateMessage,
} from './runtime-messages.js'

const REWRITE_FEEDBACK = 'tools:ptc-plus-rewrite-info'
const CORDIS_RECOVERY = 'tools:ptc-plus-cordis-recovery'
const CORDIS_RECOVERY_TEXT = 'Recorded Cordis values in the recovered REPL are historical data, not proof that process-local Plugins, Runs, approvals, or Inspect observations still exist in the current DSH process. Before relying on prior Cordis IDs, state, or capability data, follow the current Cordis owner guidance and call the live read-only Cordis Inspect bindings through `tools.*`; do not rerun mutating Cordis calls merely to reconstruct history.'

function continuationFeedback(view) {
  const run = view.latestRun
  const rewrites = run?.rewrites
  if (rewrites === undefined || rewrites.length === 0) return undefined
  const descriptions = rewrites.map(rewrite => rewrite.description).join('; ')
  const details = descriptions.length <= 2048 ? descriptions
    : `${descriptions.slice(0, 2048)}... (source-adjustment list truncated)`
  if (run.journal === undefined) {
    return `The preceding run_code cell had these source adjustments: ${details}. Its completion is unknown because no valid execution journal is available. Inspect its tool result and live bindings before continuing; do not assume it completed or failed, and do not replay it automatically.`
  }
  if (run.journal.completion?.kind !== 'return') {
    return `The preceding run_code cell failed after a source adjustment: ${details}. Treat it as failed; inspect its tool result and live bindings before continuing, and do not replay it automatically.`
  }
  return undefined
}

/** Build all dynamic PTC contexts from one session-log projection. */
export function sessionRuntimeContexts(agent, tipConfig, options = {}) {
  const view = projectSessionLog(agent)
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
export function projectRuntimeMessages(view, contexts, pending = []) {
  if (view.visibleRuntimeMessages === undefined) return []
  const sections = contexts.filter(context => PTC_STATE_NAMES.includes(context.name))
  const records = view.visibleRuntimeMessages
  const owned = records.filter(record => record.producer === 'ptc-plus' && record.form === 'snapshot').at(-1)
  const legacy = records.filter(record => record.producer === 'aggregate').at(-1)
  const pendingAggregate = pending.map(systemPromptSnapshotSections).filter(sections => sections !== undefined).at(-1)
  const retained = owned?.sections
    ?? (pendingAggregate ?? legacy?.sections)?.filter(section => PTC_STATE_NAMES.includes(section.name))
  const hadState = view.ptcMessages.some(record => record.form === 'snapshot')
    || view.systemPromptSnapshots.some(record => record.sections.some(section => PTC_STATE_NAMES.includes(section.name)))
  const messages = []
  const proposed = pending.map(readRuntimeMessage).filter(record => record !== undefined)
  const pendingState = proposed.filter(record => record.form === 'snapshot').at(-1)
  const previous = pendingState?.sections ?? retained
  if ((sections.length > 0 || previous !== undefined || hadState)
    && JSON.stringify(previous) !== JSON.stringify(sections)) {
    messages.push(runtimeStateMessage(sections))
  }
  for (const tip of contexts.filter(context => context.name.startsWith('tools:ptc-plus-tip/'))) {
    if (proposed.some(record => record.form === 'notice' && record.name === tip.name)) continue
    if (view.ptcMessages.some(record => record.form === 'notice' && record.name === tip.name)
      || view.systemPromptSnapshots.some(snapshot => snapshot.sections.some(section => section.name === tip.name))) continue
    messages.push(runtimeNoticeMessage(tip))
  }
  return messages
}

/** Passive message delivery follows the actual public assembly and accepted step. */
export function createRuntimeMessageOwner(contextsForRequest) {
  const requests = new WeakMap()
  const disposedAgents = new WeakSet()
  let disposed = false
  const hasWitness = assembly => assembly.contexts?.some(context => (
    context.name === PTC_DELIVERY_CONTEXT && context.text === ''
  )) === true
  return Object.freeze({
    async assemble(initial, context, next) {
      const assembly = await next()
      if (!disposed && context?.agent !== null && typeof context?.agent === 'object'
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
      const messages = projectRuntimeMessages(
        projectSessionLog(payload.agent), contextsForRequest(request.context), decision.messages,
      )
      return messages.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...messages] }
    },
    disposeAgent(agent) { disposedAgents.add(agent); requests.delete(agent) },
    dispose() { disposed = true },
  })
}
