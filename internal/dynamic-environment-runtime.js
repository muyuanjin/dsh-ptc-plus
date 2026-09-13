import { compileDynamicSource, isCompilerSyntaxError } from './compiler-service.js'
import { createNativeCallAdapter } from './dynamic-native-runtime.js'
import { captureCompilerIntrinsics, moduleRuntimeIntrinsics as internal } from './compiler-intrinsics.js'
import { types } from 'node:util'

const reflectionIntrinsics = new internal.WeakMap()
function captureReflection(reflect) {
  let captured = internal.weakMapGet(reflectionIntrinsics, reflect)
  if (captured === undefined) {
    captured = { apply: reflect.apply, construct: reflect.construct, get: reflect.get,
      has: reflect.has, set: reflect.set, deleteProperty: reflect.deleteProperty,
      defineProperty: reflect.defineProperty, ownKeys: reflect.ownKeys }
    internal.weakMapSet(reflectionIntrinsics, reflect, captured)
    internal.weakMapSet(reflectionIntrinsics, captured, captured)
  }
  return captured
}
const defaultIntrinsics = { intrinsicEval: eval, realmFunction: Function, globalObject: globalThis, reflect: captureReflection(Reflect) }

const isObject = value => value !== null && (typeof value === 'object' || typeof value === 'function')
const isMap = types.isMap
const bindingStores = new internal.WeakMap()
const asBindings = value => {
  if (internal.isArray(value)) {
    const result = new internal.Map()
    for (let index = 0; index < value.length; index++) {
      const entry = value[index]
      internal.mapSet(result, entry[0], entry[1])
    }
    value = result
  }
  // Logical roots implement this same live lookup/update contract. Native Map
  // storage adapts once; callers never select its mutable prototype methods.
  if (!isMap(value)) return value
  let result = internal.weakMapGet(bindingStores, value)
  if (result !== undefined) return result
  result = { has: name => internal.mapHas(value, name), get: name => internal.mapGet(value, name),
    set: (name, binding) => internal.mapSet(value, name, binding), delete: name => internal.mapDelete(value, name),
    forEach: visit => internal.mapForEach(value, visit) }
  internal.weakMapSet(bindingStores, value, result)
  return result
}

/** Native reference operations over compiler-proved lexical and object frames. */
export function createDynamicEnvironmentRuntime({
  importModule = (source, options) => import(source, options),
  intrinsicEval = defaultIntrinsics.intrinsicEval, realmFunction = defaultIntrinsics.realmFunction, globalObject = defaultIntrinsics.globalObject,
  errors, reflect = defaultIntrinsics.reflect, object, interfaceOwner,
} = {}) {
  const intrinsics = captureCompilerIntrinsics(realmFunction)
  const { unscopables, Object: intrinsicObject, array: internalArray } = intrinsics
  object ??= intrinsicObject
  errors ??= intrinsics
  // Reference mechanics use the realm's captured operations. Explicit source
  // Reflect calls still observe the mutable user-visible Reflect object.
  reflect = captureReflection(reflect)
  const parameterEnvironments = new internal.WeakMap()
  let rootEnvironment
  let defaultRootEnvironment
  const evaluate = (callee, receiver, args, environment, compilerOptions = {}) => {
    if (!nativeCalls.isEval(callee)) return reflect.apply(callee, receiver, args)
    const source = args[0]
    if (typeof source !== 'string') return source
    let compiled
    try {
      compiled = compileDynamicSource(source, { strict: environment.strict, allowNewTarget: environment.allowNewTarget,
        privateNames: environment.privateNames, allowSuper: environment.allowSuper, allowSuperCall: environment.allowSuperCall,
        forbidArguments: environment.forbidArguments, resolveOriginalSource: nativeCalls.originalSource, ...compilerOptions })
    } catch (error) {
      if (!isCompilerSyntaxError(error)) throw error
      throw new errors.SyntaxError(error.message)
    }
    nativeCalls.registerSources(compiled.callableSources)
    environment.declareEvalVars(compiled.varNames)
    return nativeCalls.evaluate(compiled, environment)
  }
  const nativeCalls = createNativeCallAdapter({ realmFunction, intrinsicEval, reflect, errors, evaluate, interfaceOwner,
    rootEnvironment(origin) {
      if (rootEnvironment === undefined && defaultRootEnvironment === undefined) {
        const varFrame = new internal.Map()
        defaultRootEnvironment = environment({ varFrame, frames: [{ kind: 'lexical', bindings: varFrame }],
          declareVars: declareGlobals,
          createVar(name) {
            const target = ambientReference(name, false)
            return { kind: 'var', get: () => target.value, set: value => { target.value = value },
              typeof: () => target.typeof(), delete: () => target.delete() }
          },
        })
      }
      return (rootEnvironment?.() ?? defaultRootEnvironment).context({ strict: false,
        getThis: () => globalObject, allowNewTarget: false }).at(origin)
    },
  })
  function declareGlobals(names, functionNames = []) {
    for (let index = 0; index < functionNames.length; index++) {
      const name = functionNames[index]
      if (!internal.includes(names, name)) continue
      const descriptor = intrinsicObject.getOwnPropertyDescriptor(globalObject, name)
      const allowed = descriptor === undefined ? intrinsicObject.isExtensible(globalObject)
        : descriptor.configurable || intrinsicObject.hasOwn(descriptor, 'value') && descriptor.writable && descriptor.enumerable
      if (!allowed) throw new errors.TypeError(`Cannot declare global function '${name}'`)
    }
    nativeCalls.declareGlobals(names)
  }
  const reference = (name, descriptor, receiver, strict, origin, writeTarget) => descriptor.reference === undefined ? ({
    get value() { return descriptor.get() },
    set value(value) {
      if (descriptor.kind === 'self' && descriptor.set === undefined) {
        if (strict) throw new errors.TypeError('Assignment to constant variable.')
        return
      }
      descriptor.set(value, strict, origin, writeTarget)
    },
    get callee() {
      const value = descriptor.get()
      return nativeCalls.referenceCall(value, receiver)
    },
    get evalInvocation() {
      const value = descriptor.get()
      return (environment, args, callOrigin) => nativeCalls.isEval(value)
        ? () => evaluate(value, receiver, args, environment)
        : nativeCalls.beginInvocation(nativeCalls.prepareInvocation(value, receiver, callOrigin), args)
    },
    typeof() { return descriptor.typeof === undefined ? typeof descriptor.get() : descriptor.typeof() },
    delete() { return descriptor.delete === undefined ? false : descriptor.delete(strict) },
  }) : descriptor.reference()
  const forwardReference = resolve => ({
    get value() { return resolve().value },
    set value(value) { resolve().value = value },
    get callee() { return resolve().callee },
    get evalInvocation() { return resolve().evalInvocation },
    typeof() { return resolve().typeof() },
    delete() { return resolve().delete() },
  })
  const objectReference = (object, name, strict) => reference(name, {
    get: () => reflect.get(object, name, object),
    set(value) {
      if (!reflect.set(object, name, value, object) && strict) throw new errors.TypeError(`Cannot assign to property '${name}'`)
    },
    delete() {
      const deleted = reflect.deleteProperty(object, name)
      if (!deleted && strict) throw new errors.TypeError(`Cannot delete property '${name}'`)
      return deleted
    },
  }, object, strict)
  const ambientReference = (name, strict) => reference(name, {
    get() {
      if (!reflect.has(globalObject, name)) throw new errors.ReferenceError(`${name} is not defined`)
      return reflect.get(globalObject, name, globalObject)
    },
    set(value) {
      if (strict && !reflect.has(globalObject, name)) throw new errors.ReferenceError(`${name} is not defined`)
      if (!reflect.set(globalObject, name, value, globalObject) && strict) throw new errors.TypeError(`Cannot assign to '${name}'`)
    },
    typeof: () => reflect.has(globalObject, name) ? typeof reflect.get(globalObject, name, globalObject) : 'undefined',
    delete: () => reflect.deleteProperty(globalObject, name),
  }, undefined, strict)

  function environment({ frames = [], varFrame = new internal.Map(), strict = false, origin, lexicalContext = {},
    getThis = () => globalObject, getNewTarget = () => undefined, allowNewTarget = false,
    ambient = ambientReference, createVar, declareVars, nativeAwait = false } = {}) {
    varFrame = asBindings(varFrame)
    const capturedFrames = []
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]
      internal.appendArray(capturedFrames, frame.kind === 'object' ? frame : { ...frame, bindings: asBindings(frame.bindings) })
    }
    frames = capturedFrames
    const result = {
      importModule,
      internalArray,
      expose: nativeCalls.exposedValue,
      prepareCall: nativeCalls.prepareCall,
      prepareInvocation: nativeCalls.prepareInvocation,
      releaseMemberReceiver: nativeCalls.releaseMemberReceiver,
      prepareMemberInvocation: nativeCalls.prepareMemberInvocation,
      beginInvocation: nativeCalls.beginInvocation,
      prepareTagInvocation: nativeCalls.prepareTagInvocation,
      templateArguments: nativeCalls.templateArguments,
      propagate: nativeCalls.propagate,
      strict,
      allowNewTarget,
      privateNames: internal.Object.keys(lexicalContext.privateReferences ?? {}),
      allowSuper: lexicalContext.getSuper !== undefined,
      allowSuperCall: lexicalContext.callSuper !== undefined,
      forbidArguments: lexicalContext.forbidArguments === true,
      thisValue: () => getThis(),
      newTarget: () => getNewTarget(),
      get superReference() {
        const receiver = getThis()
        return key => reference(key, lexicalContext.getSuper(key), receiver, strict)
      },
      get superCall() { return lexicalContext.callSuper },
      privateReference(name, receiver, optional = false) {
        return optional && receiver == null ? undefined : reference(name, lexicalContext.privateReferences[name](receiver), receiver, strict)
      },
      privateHas(name, receiver) { return lexicalContext.privateReferences[name](receiver).has() },
      reference(name, writeTarget) {
        for (let index = 0; index < frames.length; index++) {
          const frame = frames[index]
          if (frame.kind === 'lexical' || frame.kind === 'self') {
            if (frame.bindings.has(name)) return reference(name, frame.bindings.get(name), undefined, strict, origin, writeTarget)
          } else if (reflect.has(frame.object, name)) {
            const excluded = reflect.get(frame.object, unscopables, frame.object)
            if (!isObject(excluded) || !reflect.get(excluded, name, excluded)) return objectReference(frame.object, name, strict)
          }
        }
        return ambient(name, strict, origin, writeTarget)
      },
      deferredReference(name, writeTarget) {
        return forwardReference(() => result.reference(name, writeTarget))
      },
      withReference(name, withDepth, fallback) {
        const select = () => {
          let remaining = withDepth
          for (let index = 0; index < frames.length; index++) {
            const frame = frames[index]
            if (remaining === 0) break
            if (frame.kind !== 'object') continue
            remaining--
            if (!reflect.has(frame.object, name)) continue
            const excluded = reflect.get(frame.object, unscopables, frame.object)
            if (!isObject(excluded) || !reflect.get(excluded, name, excluded)) return objectReference(frame.object, name, strict)
          }
          return reference(name, fallback, undefined, strict, origin)
        }
        return forwardReference(select)
      },
      initialize(name, value) {
        result.reference(name).value = value
        return value
      },
      capture(scopes, nextStrict = strict, rootIndex = -1) {
        const captured = []
        for (let index = 0; index < scopes.length; index++) internal.appendArray(captured, { kind: 'lexical', bindings: asBindings(scopes[index]) })
        let combined = internal.copyArray(frames, 0, frames.length, internal.copyArray(captured))
        if (nativeAwait && rootIndex >= 0) {
          let boundary = 0
          for (let index = 0; index < frames.length; index++) {
            if (frames[index].kind === 'lexical' && frames[index].bindings === varFrame) { boundary = index + 1; break }
          }
          for (let index = rootIndex; index < captured.length; index++) captured[index].bindings.forEach((binding, name) => {
            if (binding.kind === 'hoisted' && !varFrame.has(name)) varFrame.set(name, binding)
          })
          combined = internal.copyArray(captured, 0, rootIndex)
          internal.copyArray(frames, 0, boundary, combined)
          internal.copyArray(captured, rootIndex, captured.length, combined)
          internal.copyArray(frames, boundary, frames.length, combined)
        }
        return environment({ frames: combined,
          varFrame, strict: nextStrict, getThis, getNewTarget, allowNewTarget, ambient, createVar, declareVars, nativeAwait, origin, lexicalContext })
      },
      awaitActivation() {
        const local = new internal.Map()
        return environment({ frames: internal.copyArray(frames, 0, frames.length, [{ kind: 'lexical', bindings: local }]), varFrame: local,
          strict, getThis, getNewTarget, allowNewTarget, ambient, nativeAwait: true, origin, lexicalContext })
      },
      activation(bindings, nextGetThis = getThis, nextGetNewTarget = getNewTarget, nextStrict = strict, ownFunction = true, selfBindings) {
        bindings = asBindings(bindings)
        const activationFrames = [{ kind: 'lexical', bindings }]
        if (selfBindings !== undefined) internal.appendArray(activationFrames, { kind: 'self', bindings: asBindings(selfBindings) })
        return environment({ frames: internal.copyArray(frames, 0, frames.length, activationFrames), varFrame: bindings,
          strict: nextStrict, getThis: nextGetThis, getNewTarget: nextGetNewTarget, allowNewTarget: ownFunction || allowNewTarget, ambient, origin,
          lexicalContext: ownFunction ? { privateReferences: lexicalContext.privateReferences } : lexicalContext })
      },
      parameters(key, bindings, nextGetThis = getThis, nextGetNewTarget = getNewTarget, nextStrict = strict, ownFunction = true, selfBindings) {
        let selected = internal.weakMapGet(parameterEnvironments, key)
        if (selected === undefined) {
          bindings = asBindings(bindings)
          if (ownFunction && !bindings.has('arguments')) {
            let value = key
            bindings.set('arguments', { kind: 'param', get: () => value, set: next => { value = next } })
          }
          const parameterFrames = [{ kind: 'lexical', bindings }]
          if (selfBindings !== undefined) internal.appendArray(parameterFrames, { kind: 'self', bindings: asBindings(selfBindings) })
          selected = environment({ frames: internal.copyArray(frames, 0, frames.length, parameterFrames), varFrame: bindings,
            strict: nextStrict, getThis: nextGetThis, getNewTarget: nextGetNewTarget, allowNewTarget: ownFunction || allowNewTarget, ambient, origin, lexicalContext })
          internal.weakMapSet(parameterEnvironments, key, selected)
        }
        return selected
      },
      propertyKey(value) { return reflect.ownKeys({ [value]: undefined })[0] },
      parameterArrow(fn, name) {
        intrinsics.Reflect.defineProperty(fn, 'length', { value: internal.max(0, fn.length - 1) })
        if (name !== undefined && fn.name === '') intrinsics.Reflect.defineProperty(fn, 'name', { value: name })
        const adapter = new internal.Proxy(fn, { apply(target, receiver, args) {
          return reflect.apply(target, receiver, internal.copyArray(args, 0, args.length, [{}]))
        } })
        return nativeCalls.registerCallableSourceTarget(adapter, fn)
      },
      context(options) { return environment({ frames, varFrame, strict: options.strict ?? strict,
        getThis: options.getThis ?? getThis, getNewTarget: options.getNewTarget ?? getNewTarget,
        allowNewTarget: options.allowNewTarget ?? allowNewTarget, ambient, createVar, declareVars, nativeAwait, origin,
        lexicalContext: { ...lexicalContext, ...options } }) },
      at(nextOrigin) { return environment({ frames, varFrame, strict, getThis, getNewTarget,
        allowNewTarget, ambient, createVar, declareVars, nativeAwait, origin: nextOrigin, lexicalContext }) },
      withObject(value) {
        if (value === null || value === undefined) throw new errors.TypeError('Cannot convert undefined or null to object')
        return environment({ frames: internal.copyArray(frames, 0, frames.length, [{ kind: 'object', object: object(value) }]),
          varFrame, strict, getThis, getNewTarget, allowNewTarget, ambient, createVar, declareVars, nativeAwait, origin, lexicalContext })
      },
      declareEvalVars(names) {
        // EvalDeclarationInstantiation checks every name before any initializer
        // runs. Object environments do not create lexical conflicts.
        for (let index = 0; index < names.length; index++) {
          const name = names[index]
          for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
            const frame = frames[frameIndex]
            if (frame.kind !== 'lexical') continue
            const binding = frame.bindings.get(name)
            if (binding !== undefined && binding.kind !== 'var' && binding.kind !== 'param' && binding.kind !== 'hoisted') {
              throw new errors.SyntaxError(`Identifier '${name}' has already been declared`)
            }
            if (frame.bindings === varFrame) break
          }
        }
        if (declareVars === undefined) {
          const declarations = []
          for (let index = 0; index < names.length; index++) internal.appendArray(declarations, [names[index]])
          result.initializeEvalDeclarations(declarations)
        }
      },
      initializeEvalDeclarations(declarations) {
        for (let index = 0; index < declarations.length; index++) {
          const declaration = declarations[index]
          const name = declaration[0], value = declaration[1], isFunction = declaration[2] === true
          declareVars?.([name], isFunction ? [name] : [])
          if (!varFrame.has(name)) {
            if (createVar !== undefined) varFrame.set(name, createVar(name, origin))
            else {
              let current
              const binding = { kind: 'var', get: () => current, set: next => {
                current = next
                varFrame.set(name, binding)
              }, delete: () => varFrame.delete(name) }
              varFrame.set(name, binding)
            }
          }
          if (isFunction) result.initializeEvalFunction(name, value)
        }
      },
      initializeEvalFunction(name, value) { varFrame.get(name).set(value, strict, origin) },
    }
    return result
  }
  return {
    installIntrinsics() { nativeCalls.install(); return this },
    exposedIntrinsic: nativeCalls.exposedValue,
    registerSources: nativeCalls.registerSources,
    declareGlobals,
    setRootEnvironment(getEnvironment) { rootEnvironment = getEnvironment },
    reference,
    environment(options = {}) {
      const varFrame = options.varFrame ?? new internal.Map()
      const frames = internal.copyArray(options.frames ?? [])
      if (options.nativeBindings !== undefined) internal.appendArray(frames, { kind: 'lexical', bindings: asBindings(options.nativeBindings) })
      internal.appendArray(frames, { kind: 'lexical', bindings: varFrame })
      return environment({ ...options, varFrame, frames })
    },
    evaluate,
  }
}
