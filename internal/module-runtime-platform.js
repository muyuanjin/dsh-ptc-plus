import { registerHooks } from 'node:module'
import { compilerPlatformBridge } from './compiler-platform.js'

const nativeRegisterHooks = registerHooks
const apply = Reflect.apply
// Acquire the public hook lifecycle before any owned source can replace Node
// exports or the hook prototype. The empty bootstrap hook changes no edge.
const bootstrapHook = nativeRegisterHooks({})
const deregister = bootstrapHook.deregister
apply(deregister, bootstrapHook, [])

/** Each native resolution scope has one captured registration and disposer. */
export function registerModuleResolutionHook(resolve) {
  const hook = nativeRegisterHooks({ resolve })
  return () => apply(deregister, hook, [])
}

export const fileURLToPath = compilerPlatformBridge.fileURLToPath
export const pathToFileURL = compilerPlatformBridge.pathToFileURL
