/** Producer identity shared by Host messages and Client history projections. */
export const PTC_MESSAGE_SOURCE_KIND = 'plugin:ptc-plus'

/** Read the current producer identity and its historical pre-migration wrapper. */
export function isPtcMessageSource(source) {
  return source?.kind === PTC_MESSAGE_SOURCE_KIND
    || (source?.kind === 'plugin' && source.plugin === 'ptc-plus')
}

/** DSH owns aggregate runtime-context messages independently of PTC messages. */
export function isHostRuntimeContextSource(source) {
  return source?.kind === 'runtime-context'
    || (source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt')
}
