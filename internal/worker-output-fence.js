import { runtimeIntrinsics as internal } from './runtime-intrinsics.js'

const FENCE_PREFIX = '\u001eDSH_PTC_OUTPUT_FENCE_V1:'
const FENCE_SUFFIX = '\u001f'
const TOKEN = /^[a-f0-9]{48}$/u
const FENCE = /\u001eDSH_PTC_OUTPUT_FENCE_V1:(?:stdout|stderr):(?:start|end):[a-f0-9]{48}\u001f/gu
const { regexpTest, replaceString, toString } = internal

export const OUTPUT_FENCE_ALLOWANCE_BYTES = 512

export function validOutputFenceToken(token) {
  return typeof token === 'string' && regexpTest(TOKEN, token)
}

export function outputFenceMarker(token, channel, phase) {
  if (!validOutputFenceToken(token)
    || (channel !== 'stdout' && channel !== 'stderr')
    || (phase !== 'start' && phase !== 'end')) {
    throw new TypeError('invalid worker output fence')
  }
  return `${FENCE_PREFIX}${channel}:${phase}:${token}${FENCE_SUFFIX}`
}

export function stripOutputFenceMarkers(value) {
  return replaceString(toString(value ?? ''), FENCE, '')
}
