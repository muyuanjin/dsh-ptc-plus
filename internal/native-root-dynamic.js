import { createDynamicEnvironmentRuntime } from './dynamic-environment-runtime.js'
import { moduleRuntimeIntrinsics as internal } from './compiler-intrinsics.js'

const { Map, Set, mapGet, mapSet, mapHas, mapDelete, setHas, setAdd, appendArray } = internal

/** Native storage and catalog-proved logical roots share a captured legacy view. */
export function createNativeRootDynamic({ intrinsics, importModule, read, write, typeOf, remove, logicalReference }) {
  const interfaceOwner = {}
  const descriptor = name => ({ kind: 'var', get: () => read(name),
    set: (value, strict) => write(name, value, strict), delete: () => remove(name), typeof: () => typeOf(name) })
  return {
    environment(callableSources, awaitRoot = false, logicalRoots = [], writableRoots = [], cellImportModule = importModule) {
      if (logicalRoots.length === 0) {
        const cellRuntime = createDynamicEnvironmentRuntime({ ...intrinsics,
          importModule: cellImportModule, interfaceOwner }).installIntrinsics()
        const captured = cellRuntime.environment({
          ambient: (name, strict) => cellRuntime.reference(name, descriptor(name), undefined, strict),
          declareVars: cellRuntime.declareGlobals,
          createVar: descriptor,
        })
        cellRuntime.setRootEnvironment(() => captured)
        cellRuntime.registerSources(callableSources)
        return awaitRoot ? captured.awaitActivation() : captured
      }
      // Each captured legacy environment keeps its own root view. Installing a
      // later bridge must not change escaped eval/Function calls from old cells.
      const bridgedRuntime = createDynamicEnvironmentRuntime({ ...intrinsics, importModule: cellImportModule, interfaceOwner }).installIntrinsics()
      const writable = new Set()
      for (let index = 0; index < writableRoots.length; index++) setAdd(writable, writableRoots[index])
      const bindings = new Map(), varFrame = new Map(), roots = new Map()
      for (let index = 0; index < logicalRoots.length; index++) {
        const name = logicalRoots[index], binding = logicalReference(name, setHas(writable, name))
        mapSet(bindings, name, binding)
        mapSet(roots, name, binding)
        if (binding.kind === 'var') mapSet(varFrame, name, binding)
        const remove = binding.delete
        binding.delete = () => {
          if (!remove()) return false
          mapDelete(bindings, name)
          mapDelete(varFrame, name)
          return true
        }
      }
      const bridged = bridgedRuntime.environment({ frames: [{ kind: 'lexical', bindings }], varFrame,
        ambient: (name, strict) => bridgedRuntime.reference(name, descriptor(name), undefined, strict),
        declareVars(names, functionNames) {
          const globals = []
          for (let index = 0; index < names.length; index++) {
            if (!mapHas(roots, names[index])) appendArray(globals, names[index])
          }
          bridgedRuntime.declareGlobals(globals, functionNames)
        },
        createVar(name) {
          const root = mapGet(roots, name)
          if (root === undefined) return descriptor(name)
          root.declare()
          mapSet(bindings, name, root)
          return root
        },
      })
      bridgedRuntime.setRootEnvironment(() => bridged)
      bridgedRuntime.registerSources(callableSources)
      return awaitRoot ? bridged.awaitActivation() : bridged
    },
  }
}
