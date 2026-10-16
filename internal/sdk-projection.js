/** Adapt the Host's TypeScript cell introduction while preserving its SDK members. */

const TYPESCRIPT_FENCE = '```ts\n'

export function projectProgramSdk(nativeSdk, { languageSemantics = 'legacy-v1' } = {}) {
  if (typeof nativeSdk !== 'string') return ''
  if (languageSemantics === 'legacy-v1' || !nativeSdk.startsWith('## Writing code for run_code\n')) {
    return nativeSdk
  }
  const fence = nativeSdk.indexOf(TYPESCRIPT_FENCE)
  if (fence < 0) return nativeSdk
  return nativeSdk.slice(0, fence).replace(
    'the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped)',
    'a PTC Plus TypeScript cell (runtime `enum` and namespaces are supported; type annotations are advisory)',
  ) + nativeSdk.slice(fence)
}
