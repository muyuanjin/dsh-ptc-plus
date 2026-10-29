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

/** DSH owns aggregate runtime-context messages independently of PTC messages. */
export function isHostRuntimeContextSource(source) {
  return source?.kind === 'runtime-context'
    || (source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt')
}
