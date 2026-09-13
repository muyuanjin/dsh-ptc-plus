/** Session logical identities, independent of the native cell's lexical frame. */
import { createDynamicEnvironmentRuntime } from './dynamic-environment-runtime.js'
import { captureCompilerIntrinsics, moduleRuntimeIntrinsics as internal } from './compiler-intrinsics.js'

const { Map, Set, Object, Proxy, mapGet, mapSet, mapHas, mapClear, mapForEach,
  setHas, setAdd, includes, appendArray, stringify } = internal

export function createStatefulRootRuntime({ readAmbient, typeofAmbient, writeAmbient, deleteAmbient,
  canWriteAmbient = () => true,
  errors,
  dynamicIntrinsics, importModule = (source, options) => import(source, options),
  hasOverlay = () => false, hasAmbient, publish = () => {}, changed = () => {}, refresh = () => {} }) {
  const entries = new Map()
  const intrinsics = captureCompilerIntrinsics(dynamicIntrinsics?.realmFunction)
  errors ??= intrinsics
  const dynamicRuntime = createDynamicEnvironmentRuntime({ ...dynamicIntrinsics, importModule })
  const moduleRuntime = dynamicIntrinsics === undefined ? undefined : createDynamicEnvironmentRuntime()
  let commit
  const read = name => {
    refresh(name)
    const entry = mapGet(entries, name)
    return hasOverlay(name) || entry === undefined || entry.object === true || entry.deleted === true
      ? readAmbient(name) : entry.read === undefined ? entry.value : entry.read()
  }
  const storeValue = (name, value, { source = 'local', readOnly = false, declaration = false,
    strict = false, target, nativeKind } = {}) => {
    refresh(name)
    const previous = mapGet(entries, name)
    if (hasOverlay(name)) {
      // A hard request overlay is not shadowable, so this store cannot publish a session identity.
      // A declaration is the overlay's own pre-emption and stays absorbed; an actual write that the
      // ambient property cannot accept must fail observably instead of being discarded.
      if (!declaration && !canWriteAmbient(name)) {
        throw new errors.TypeError(`${name} cannot be overwritten because reserved program bindings are not shadowable`)
      }
      writeAmbient(name, value, strict)
      return undefined
    }
    if (!declaration && (previous === undefined || previous.object === true || previous.deleted === true) && writeAmbient !== undefined) {
      writeAmbient(name, value, strict)
      mapSet(entries, name, { source, object: true, ...(previous?.legacyWritable === true ? { legacyWritable: true } : {}) })
    } else if (previous?.legacyWritable === true && writeAmbient !== undefined
      && (previous.object !== true || canWriteAmbient(name))) {
      writeAmbient(name, value)
      mapSet(entries, name, { ...previous, source, readOnly })
    } else mapSet(entries, name, { value, source, readOnly, ...(previous?.nativeKind === undefined ? {} : { nativeKind: previous.nativeKind }) })
    const writeTarget = target ?? (declaration ? undefined : previous?.writeTarget)
    const entry = mapGet(entries, name)
    delete entry.writeTarget
    if (writeTarget !== undefined) entry.writeTarget = writeTarget
    if (nativeKind !== undefined) entry.nativeKind = nativeKind
    return entry
  }
  const write = (name, value, options) => {
    const entry = storeValue(name, value, options)
    if (entry === undefined) return value
    if (entry.object !== true) publish(name, () => read(name), value => write(name, value))
    changed(name, entry.source)
    return value
  }
  const begin = ({ declared = [], known = [], readOnly = [], legacyImports = [], legacyWritable = [], legacyLexicals = [], legacyObjects = [],
    declarationKinds = [], declaredKinds = [], callableSources = [], languageSemantics = 'stateful-v1', committed }) => {
    dynamicRuntime.registerSources(callableSources)
    commit = committed
    const kinds = new Map()
    for (let index = 0; index < declarationKinds.length; index++) mapSet(kinds, declarationKinds[index][0], declarationKinds[index][1])
    for (let index = 0; index < legacyImports.length; index++) {
      const name = legacyImports[index][0], binding = legacyImports[index][1]
      if (!mapHas(entries, name)) mapSet(entries, name, { source: 'import', read: () => {
        const namespace = readAmbient(binding.namespace)
        return binding.imported === undefined ? namespace : namespace[binding.imported]
      } })
    }
    for (let index = 0; index < legacyWritable.length; index++) {
      const name = legacyWritable[index]
      if (!mapHas(entries, name)) mapSet(entries, name, { source: 'local', legacyWritable: true,
        ...(includes(legacyObjects, name) ? { object: true } : {}), read: () => readAmbient(name) })
    }
    for (let index = 0; index < legacyLexicals.length; index++) {
      const name = legacyLexicals[index]
      if (!mapHas(entries, name)) mapSet(entries, name, { source: 'local', readOnly: true, read: () => readAmbient(name) })
    }
    const protectedNames = new Set()
    if (languageSemantics === 'protected-v1') {
      for (let index = 0; index < readOnly.length; index++) setAdd(protectedNames, readOnly[index])
      mapForEach(entries, (entry, name) => { if (entry.readOnly) setAdd(protectedNames, name) })
    }
    const fresh = new Set()
    for (let index = 0; index < declared.length; index++) {
      const name = declared[index]
      if (!mapHas(entries, name) && !includes(known, name)) setAdd(fresh, name)
    }
    const checkInitialized = name => {
      if (!hasOverlay(name) && setHas(fresh, name) && !mapHas(entries, name)) throw new errors.ReferenceError(`Cannot access '${name}' before initialization`)
    }
    const get = name => {
      checkInitialized(name)
      return read(name)
    }
    const checkWritable = name => {
      if (languageSemantics === 'protected-v1') checkInitialized(name)
      if (languageSemantics === 'protected-v1' && (setHas(protectedNames, name) || mapGet(entries, name)?.readOnly === true)) {
        throw new errors.TypeError('Assignment to constant variable.')
      }
    }
    const needsDeclaration = name => {
      const entry = mapGet(entries, name)
      return entry === undefined && (setHas(fresh, name) || hasAmbient !== undefined && !hasAmbient(name))
        || (entry?.object === true || entry?.deleted === true) && !hasAmbient(name)
    }
    const remove = name => {
      const entry = mapGet(entries, name)
      if (hasOverlay(name) || entry?.object || entry?.deleted || entry === undefined && !setHas(fresh, name)) return deleteAmbient(name)
      if (entry?.nativeKind !== 'eval-var') return false
      mapSet(entries, name, { ...entry, deleted: true })
      return true
    }
    const values = new Proxy(Object.create(null), {
      get: (_, name) => get(name),
      set: (_, name, value) => {
        checkWritable(name)
        write(name, value)
        return true
      },
      deleteProperty: (_, name) => remove(name),
    })
    const result = {
      values,
      intrinsics,
      importModule,
      dynamic({ realm = false } = {}) {
        const pendingKinds = new Map()
        for (let index = 0; index < declaredKinds.length; index++) mapSet(pendingKinds, declaredKinds[index][0], declaredKinds[index][1])
        const kindFor = name => {
          const entry = mapGet(entries, name)
          if (hasOverlay(name) || entry?.deleted) return undefined
          if (entry?.object || entry === undefined && realm && !setHas(fresh, name)) return realm && hasAmbient(name) ? 'var' : undefined
          return entry === undefined ? setHas(fresh, name) ? mapGet(pendingKinds, name) ?? 'let' : undefined : entry.nativeKind ?? 'let'
        }
        const variableKind = kind => includes(['var', 'eval-var', 'hoisted'], kind)
        const descriptor = (name, kind) => ({
          kind,
          get: () => get(name),
          set(value, strict, origin, writeTarget) {
            result.reference(name, strict, writeTarget ?? (origin === undefined ? undefined : `${origin}:${stringify(name)}`)).value = value
          },
          delete() {
            const entry = mapGet(entries, name)
            if (realm && (entry === undefined || entry.object)) return delete values[name]
            return remove(name)
          },
        })
        const lexicalFrame = { has: name => kindFor(name) !== undefined && !variableKind(kindFor(name)),
          get: name => lexicalFrame.has(name) ? descriptor(name, kindFor(name)) : undefined }
        const varFrame = { has: name => variableKind(kindFor(name)), get: name => varFrame.has(name) ? descriptor(name, 'var') : undefined,
          set() {} }
        return dynamicRuntime.environment({
          varFrame, frames: [{ kind: 'lexical', bindings: lexicalFrame }],
          declareVars: realm ? (names, functionNames) => {
            const globals = []
            for (let index = 0; index < names.length; index++) {
              const name = names[index], entry = mapGet(entries, name)
              if (hasOverlay(name) || entry === undefined || entry.object === true || entry.deleted === true) appendArray(globals, name)
            }
            dynamicRuntime.declareGlobals(globals, functionNames)
          } : undefined,
          ambient(name, strict, origin, writeTarget) {
            return dynamicRuntime.reference(name, {
              get: () => get(name),
              set: value => { result.reference(name, strict, writeTarget ?? (origin === undefined ? undefined : `${origin}:${stringify(name)}`)).value = value },
              typeof: () => result.typeof(name),
              delete: () => delete values[name],
            }, undefined, strict)
          },
          createVar(name, origin) {
            if (!mapHas(entries, name) || mapGet(entries, name).object || mapGet(entries, name).deleted) {
              // A hard overlay pre-empts a realm-level var declaration, so that declaration is
          // absorbed instead of being written through to a property the ambient cannot accept.
          write(name, undefined, { declaration: !realm || hasOverlay(name), nativeKind: 'eval-var',
                target: origin === undefined ? undefined : `${origin}:${stringify(name)}` })
            }
            return descriptor(name, 'var')
          },
        })
      },
      typeof(name) {
        // Native typeof distinguishes an unresolvable reference from any error
        // thrown by resolving a getter, including errors from another realm.
        if (hasOverlay(name) || !mapHas(entries, name) && !setHas(fresh, name)
          || mapGet(entries, name)?.object === true || mapGet(entries, name)?.deleted === true) return typeofAmbient(name)
        return typeof get(name)
      },
      declare(name, target) {
        if (needsDeclaration(name)) {
          write(name, undefined, { readOnly: setHas(protectedNames, name), declaration: true,
            nativeKind: mapGet(kinds, target) ?? 'var' })
          commit(target)
        }
      },
      assign(name, value, target) {
        write(name, value, { readOnly: setHas(protectedNames, name), declaration: true,
          nativeKind: mapGet(kinds, target) ?? 'let' })
        commit(target)
        return value
      },
      reference(name, strict, target) {
        return new Proxy(Object.create(null), {
          get: () => get(name),
          set: (_, key, value) => {
            checkWritable(name)
            write(name, value, { strict, target })
            return true
          },
        })
      },
      import(name, namespace, imported, target) {
        mapSet(entries, name, { source: 'import', nativeKind: 'const', readOnly: setHas(protectedNames, name), read: () => imported === null ? namespace : namespace[imported] })
        publish(name, () => read(name), value => write(name, value))
        changed(name, 'import')
        commit(target)
      },
      link(name, linked, target) {
        if (name !== linked) {
          mapSet(entries, name, { source: 'local', read: () => read(linked) })
          publish(name, () => read(name), value => write(name, value))
          changed(name, 'local')
        }
        commit(target)
      },
      candidate(names) {
        const pending = new Map()
        let published = false
        // Pattern targets initialize values; source references enforce writes.
        const values = new Proxy(Object.create(null), {
          deleteProperty: (_, name) => published ? remove(name) : false,
          get: (_, name) => {
            if (published) return read(name)
            return mapHas(pending, name) ? mapGet(pending, name) : get(name)
          },
          set: (_, name, value) => {
            if (published) {
              checkWritable(name)
              write(name, value)
            }
            else mapSet(pending, name, value)
            return true
          },
        })
        return {
          values,
          reference(name, strict = false, target) {
            return dynamicRuntime.reference(name, {
              get: () => values[name],
              set(value) {
                if (!published && mapHas(pending, name)) {
                  if (setHas(protectedNames, name)) throw new errors.TypeError('Assignment to constant variable.')
                } else checkWritable(name)
                if (published) write(name, value, { strict, target })
                else mapSet(pending, name, value)
              },
              delete: () => published ? remove(name) : false,
            }, undefined, strict)
          },
          commit(target) {
            const stored = []
            for (let index = 0; index < names.length; index++) {
              const name = names[index]
              // A with/catch target can receive a var initializer while the
              // declaration still establishes its own previously absent name.
              if (!mapHas(pending, name) && (mapGet(kinds, target) !== 'var' || !needsDeclaration(name))) continue
              if (storeValue(name, mapGet(pending, name), { readOnly: setHas(protectedNames, name), declaration: true,
                nativeKind: mapGet(kinds, target) ?? 'let' }) === undefined) continue
              appendArray(stored, name)
            }
            mapClear(pending)
            published = true
            for (let index = 0; index < stored.length; index++) {
              const name = stored[index]
              publish(name, () => read(name), value => write(name, value))
              changed(name, 'local')
            }
            commit(target)
          },
        }
      },
    }
    dynamicRuntime.setRootEnvironment(() => result.dynamic({ realm: true }))
    // Only new-generation environments select intrinsic interfaces. Native
    // global/prototype properties and saved legacy identities remain intact.
    if (dynamicIntrinsics !== undefined) {
      dynamicRuntime.installIntrinsics()
      moduleRuntime.installIntrinsics()
    }
    return result
  }
  return {
    begin,
    read,
    legacyReference(name, writable) {
      const kind = mapGet(entries, name)?.nativeKind ?? 'let'
      return { kind: includes(['var', 'eval-var', 'hoisted'], kind) ? 'var' : kind,
        get: () => read(name),
        typeof: () => mapGet(entries, name)?.deleted === true ? typeofAmbient(name) : typeof read(name),
        set(value) {
          if (!writable) throw new errors.TypeError('Assignment to constant variable.')
          write(name, value)
        },
        declare() { write(name, undefined, { declaration: true }) },
        delete() {
          const entry = mapGet(entries, name)
          if (entry.nativeKind !== 'eval-var') return false
          mapSet(entries, name, { ...entry, deleted: true })
          return true
        },
      }
    },
    publishLegacy(name, writable, binding, object = false) {
      mapSet(entries, name, binding === undefined
        ? { source: 'local', readOnly: !writable, legacyWritable: writable, object, read: () => readAmbient(name) }
        : { source: 'import', read: () => {
          const namespace = readAmbient(binding.namespace)
          return binding.imported === undefined ? namespace : namespace[binding.imported]
        } })
      publish(name, () => read(name), value => write(name, value))
      changed(name, binding === undefined ? 'local' : 'import')
    },
    localValue(name) {
      const entry = mapGet(entries, name)
      return entry?.source === 'local' && entry.object !== true && entry.read === undefined ? { value: entry.value } : undefined
    },
    has: name => mapHas(entries, name) && mapGet(entries, name).object !== true && mapGet(entries, name).deleted !== true,
    facts() {
      const facts = []
      mapForEach(entries, (entry, name) => appendArray(facts, { name,
        source: entry.deleted === true || entry.object === true && !hasAmbient(name) ? 'absent' : entry.source,
        ...(entry.writeTarget === undefined ? {} : { write: entry.writeTarget }) }))
      return facts
    },
  }
}
