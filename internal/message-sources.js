/** Producer identity shared by Host messages and Client history projections. */
export const PTC_MESSAGE_SOURCE_KIND = 'plugin:ptc-plus'

/** Read the current producer identity and its historical pre-migration wrapper. */
export function isPtcMessageSource(source) {
  return source?.kind === PTC_MESSAGE_SOURCE_KIND
    || (source?.kind === 'plugin' && source.plugin === 'ptc-plus')
}

/**
 * The delivered capability plan form.
 *
 * The plan producer composes this message; naming its form here keeps the
 * vocabulary of what this plugin writes in one module, so the record reader can
 * recognize a delivered plan without importing the producer that composes one.
 */
export const CAPABILITY_PLAN_FORM = 'capability-plan'

/**
 * The record a surface statement becomes when it may no longer occupy the surface.
 *
 * A session written before the record carrier carries a decision as a `user/message` ahead of the
 * Host's protected head, and the released format refuses such a log on every read.
 * `scripts/repair-session-log.mjs` keeps the sequence number and the payload and gives up only the
 * carrier. The statement is therefore still a statement of the owner whose form its payload names,
 * which is why this carrier lives beside the forms rather than in either owner: two owners read it,
 * and each of them reads only its own.
 */
export const RETIRED_SURFACE_RECORD = 'plugin:ptc-plus/retired-surface-statement'

/** DSH owns aggregate runtime-context messages independently of PTC messages. */
export function isHostRuntimeContextSource(source) {
  return source?.kind === 'runtime-context'
    || (source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt')
}
