import { captureCompilerIntrinsics } from './compiler-intrinsics.js'

/** Execution owns its frame promise; the returned source value still uses
 * Await in the source realm. Neither consumer performs host-realm assimilation
 * of an unexamined source promise. */
export function createCellCompletionObserver(realmFunction) {
  const intrinsics = captureCompilerIntrinsics(realmFunction)
  return {
    observe: intrinsics.observeOwnedPromise,
    settle(value, fulfilled, rejected) {
      const completion = intrinsics.awaitValue(value, value => ({ value }))
      intrinsics.observeOwnedPromise(completion, result => fulfilled(result.value), rejected)
    },
  }
}
