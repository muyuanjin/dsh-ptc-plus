import { AsyncLocalStorage } from 'node:async_hooks'
import { createContext, runInContext } from 'node:vm'
import { recordExceptionOrigin } from './failure-reporting.js'
import { createCallableSourceRegistry } from './callable-source-catalog.js'
import { captureCompilerIntrinsics, moduleRuntimeIntrinsics as internal } from './compiler-intrinsics.js'

const realmStates = new internal.WeakMap()
const exposedIntrinsics = new internal.WeakMap()
// Source facts describe canonical values and emitted source, independent of
// which owned realm's toString observes a callable crossing a module boundary.
const sources = createCallableSourceRegistry()
const callableSources = new internal.WeakMap()
const callableSourceTargets = new internal.WeakMap()
const callableInterfaces = new internal.WeakMap()
const sourceTarget = origin => typeof origin === 'string' ? origin : origin?.target
const copyArguments = (source, start = 0, result = []) => internal.copyArray(source, start, source.length, result)
const invocationScopes = new AsyncLocalStorage()
const getScope = AsyncLocalStorage.prototype.getStore
const enterScope = AsyncLocalStorage.prototype.enterWith
const currentScope = () => internal.Reflect.apply(getScope, invocationScopes, [])
const selectScope = value => internal.Reflect.apply(enterScope, invocationScopes, [value])
// Node 22 installs promise hooks lazily through a host array iterator. Complete
// that platform initialization before source can mutate the module realm.
selectScope(undefined)
// Native eval has no callable activation in the source caller chain. Its
// private realm gives each invocation a native try/finally lifetime without
// moving source parameters or declarations, or changing source realm globals.
let pendingInvocation
const invocationRealm = createContext({
  take() {
    const invocation = pendingInvocation
    pendingInvocation = undefined
    return invocation
  },
  enter(invocation) {
    const previous = currentScope()
    selectScope({ invoke: invocation.invoke, origin: invocation.origin,
      interface: invocation.interface, parent: previous })
    return previous
  },
  failed(invocation, error) { recordExceptionOrigin(error, sourceTarget(invocation.origin)) },
  leave(previous) { selectScope(previous) },
})
// A distinct source identity keeps V8 eval-origin notes out of user frames.
const nativeContinuation = runInContext(`eval.bind(undefined, ${JSON.stringify(`
  const invocation = take();
  const previous = enter(invocation);
  try {
    while (invocation.advance(invocation)) invocation.args = invocation.collect(invocation.arrayLike);
    invocation.complete(invocation, invocation.dispatch())
  }
  catch (error) { failed(invocation, error); throw error }
  finally { leave(previous) }
  //# sourceURL=ptc-plus:native-invocation
`)})`, invocationRealm)

/** Native callable identities are classified once for their owning realm. */
export function createNativeCallAdapter({ realmFunction, intrinsicEval, reflect, errors, evaluate, rootEnvironment, interfaceOwner }) {
  reflect = { apply: reflect.apply, construct: reflect.construct }
  const { getPrototypeOf, setPrototypeOf } = captureCompilerIntrinsics(realmFunction).Object
  let state = internal.weakMapGet(realmStates, realmFunction)
  if (state === undefined) {
    const intrinsics = realmFunction('return {constructors:[Function,(async function(){}).constructor,(function*(){}).constructor,(async function*(){}).constructor],call:Function.prototype.call,apply:Function.prototype.apply,bind:Function.prototype.bind,toString:Function.prototype.toString,reflectApply:Reflect.apply,reflectConstruct:Reflect.construct}')()
    const constructors = new internal.Set()
    for (let index = 0; index < intrinsics.constructors.length; index++) internal.setAdd(constructors, intrinsics.constructors[index])
    state = { ...intrinsics, realmFunction, intrinsicEval, constructors,
      bound: new internal.WeakMap(), prepared: new internal.WeakMap(), sources, callableSources, callableSourceTargets,
      exposed: new internal.Map(), interfaces: new internal.WeakMap(),
      nativeApply: reflect.apply(intrinsics.bind, intrinsics.reflectApply, [undefined]),
      nativeConstruct: reflect.apply(intrinsics.bind, intrinsics.reflectConstruct, [undefined]),
      templateArguments: realmFunction('return Array.of')() }
    internal.weakMapSet(realmStates, realmFunction, state)
  }
  let selected = interfaceOwner === undefined ? state : internal.weakMapGet(state.interfaces, interfaceOwner)
  if (selected === undefined) {
    selected = { exposed: new internal.Map() }
    internal.weakMapSet(state.interfaces, interfaceOwner, selected)
  }
  // Realm owners share intrinsic classification and source facts. An explicit
  // generation owner retains its own root through opaque and asynchronous calls.
  const install = () => {
    if (selected.installed) return
    selected.installed = true
    const expose = (target, constructable = false) => {
      const dispatch = (receiver, args, newTarget) => {
        const active = currentScope()
        const owner = active?.interface === selected ? active : undefined
        return (owner?.invoke ?? invoke)(target, receiver, args, owner?.origin, newTarget)
      }
      const wrapper = new internal.Proxy(target, {
        apply: (_, receiver, args) => dispatch(receiver, args),
        ...(constructable ? { construct: (_, args, newTarget) => dispatch(undefined, args, newTarget) } : {}),
      })
      internal.mapSet(selected.exposed, target, wrapper)
      if (interfaceOwner === undefined) internal.weakMapSet(exposedIntrinsics, target, wrapper)
      internal.weakMapSet(state.callableSources, wrapper, reflect.apply(state.toString, target, []))
      return wrapper
    }
    // Source reads select interfaces without replacing native global or
    // prototype properties, including in escaped asynchronous continuations.
    expose(state.intrinsicEval)
    expose(state.toString)
    internal.setForEach(state.constructors, constructor => expose(constructor, true))
    const exposedFunction = internal.mapGet(selected.exposed, state.realmFunction)
    internal.weakMapSet(realmStates, exposedFunction, state)
  }
  const isNativeConstructor = target => {
    while (internal.weakMapHas(state.bound, target)) target = internal.weakMapGet(state.bound, target).callee
    return internal.setHas(state.constructors, target)
  }
  const adaptConstructed = (native, origin) => {
    const source = reflect.apply(state.toString, native, [])
    const compiled = evaluate(state.intrinsicEval, undefined, [`(${source})`], rootEnvironment(sourceTarget(origin)), { functionConstructor: true })
    setPrototypeOf(compiled, getPrototypeOf(native))
    internal.weakMapSet(state.callableSources, compiled, source)
    return compiled
  }
  const exposedValue = value => {
    const exposed = internal.mapGet(selected.exposed, value) ?? internal.weakMapGet(exposedIntrinsics, value)
    if (exposed !== undefined) return exposed
    if (typeof value === 'function' && !internal.weakMapHas(callableInterfaces, value)) {
      internal.weakMapSet(callableInterfaces, value, selected)
    }
    return value
  }
  const exposedMemberValue = (receiver, value) => {
    const owner = typeof receiver === 'function' ? internal.weakMapGet(callableInterfaces, receiver) : undefined
    const exposed = owner === undefined ? undefined : internal.mapGet(owner.exposed, value)
    return exposed ?? exposedValue(value)
  }
  const propagate = (error, origin) => {
    recordExceptionOrigin(error, sourceTarget(origin), { reset: true })
    for (let scope = currentScope(); scope !== undefined; scope = scope.parent) {
      recordExceptionOrigin(error, sourceTarget(scope.origin))
    }
    return error
  }
  const invoke = (callee, receiver, args, origin, newTarget) => {
    // Exposed intrinsic proxies already selected their owning interface.
    const plan = invocation(callee, receiver, origin, false, newTarget !== undefined, false)
    plan.newTarget = newTarget
    return beginInvocation(plan, args)()
  }
  const prepareCall = (callee, receiver, origin, optional = false) => {
    const plan = invocation(callee, receiver, origin, optional)
    return plan === undefined ? undefined : prepareTagInvocation(plan)
  }
  const invocation = (callee, receiver, origin, optional = false, construct = false, selectInterface = true) => {
    if (optional && callee == null) return undefined
    const reference = internal.weakMapGet(state.prepared, callee)
    if (reference !== undefined && !construct) ({ callee, receiver } = reference)
    return { callee: selectInterface ? exposedValue(callee) : callee, receiver, origin, construct }
  }
  const validateInvocation = ({ callee, origin, construct }) => {
    if (!construct && typeof callee !== 'function' && typeof origin?.callee === 'string') {
      const error = new errors.TypeError(`${origin.callee} is not a function`)
      recordExceptionOrigin(error, origin.target, { sourceFailure: true })
      throw error
    }
  }
  const collectArguments = reflect.apply(state.bind, state.reflectApply, [undefined, state.templateArguments, undefined])
  const intrinsicTarget = callee => {
    while (internal.weakMapHas(state.bound, callee)) callee = internal.weakMapGet(state.bound, callee).callee
    return internal.setHas(state.constructors, callee) || callee === state.intrinsicEval || callee === state.toString
  }
  // Native array-like conversion runs in the continuation, after target
  // validation and before dispatch. User getters therefore retain their source
  // caller, and nested call/apply aliases consume each argument list once.
  const advanceInvocation = plan => {
    while (true) {
      const { callee, receiver, args, construct } = plan
      const bound = internal.weakMapGet(state.bound, callee)
      if (bound !== undefined && intrinsicTarget(callee)) {
        plan.callee = bound.callee
        if (!construct) plan.receiver = bound.receiver
        if (plan.newTarget === callee) plan.newTarget = bound.callee
        plan.args = copyArguments(args, 0, copyArguments(bound.args))
        continue
      }
      if (!construct && callee === state.call) {
        plan.callee = receiver
        plan.receiver = args[0]
        plan.args = copyArguments(args, 1)
        continue
      }
      if (!construct && (callee === state.apply && typeof receiver === 'function'
        || callee === state.reflectApply && typeof args[0] === 'function')) {
        plan.callee = callee === state.apply ? receiver : args[0]
        plan.receiver = callee === state.apply ? args[0] : args[1]
        plan.arrayLike = callee === state.apply ? args[1] : args[2]
        if (callee === state.apply && plan.arrayLike == null) { plan.args = []; continue }
        return true
      }
      plan.adaptConstructed = internal.setHas(state.constructors, callee)
        || !construct && callee === state.reflectConstruct && isNativeConstructor(args[0])
      plan.dispatch = !construct && callee === state.intrinsicEval
        ? () => evaluate(callee, receiver, args, rootEnvironment(sourceTarget(plan.origin)))
        : reflect.apply(state.bind, construct ? state.nativeConstruct : state.nativeApply,
          construct ? [undefined, callee, args, plan.newTarget] : [undefined, callee, receiver, args])
      return false
    }
  }
  const completeInvocation = (plan, value) => {
    if (plan.adaptConstructed) return adaptConstructed(value, plan.origin)
    if (!plan.construct && plan.callee === state.bind) internal.weakMapSet(state.bound, value,
      { callee: plan.receiver, receiver: plan.args[0], args: copyArguments(plan.args, 1) })
    if (!plan.construct && plan.callee === state.toString) {
      let receiver = plan.receiver
      while (!internal.weakMapHas(state.callableSources, receiver) && internal.weakMapHas(state.callableSourceTargets, receiver)) {
        receiver = internal.weakMapGet(state.callableSourceTargets, receiver)
        value = reflect.apply(state.toString, receiver, [])
      }
      return internal.weakMapGet(state.callableSources, receiver) ?? state.sources.get(value) ?? value
    }
    return exposedValue(value)
  }
  const beginInvocation = (plan, args) => {
    validateInvocation(plan)
    pendingInvocation = {
      ...plan, args, invoke, interface: selected, complete: completeInvocation,
      newTarget: plan.construct && plan.newTarget === undefined ? plan.callee : plan.newTarget,
      advance: advanceInvocation, collect: collectArguments,
    }
    return nativeContinuation
  }
  const prepareTagInvocation = plan => {
    const result = (...args) => invoke(plan.callee, plan.receiver, args, plan.origin)
    internal.weakMapSet(state.prepared, result, plan)
    return result
  }
  return {
    install,
    exposedValue,
    exposedMemberValue,
    isEval: callee => callee === state.intrinsicEval || internal.mapHas(selected.exposed, state.intrinsicEval) && callee === internal.mapGet(selected.exposed, state.intrinsicEval),
    evaluate(compiled, environment) {
      // Bootstrap originals never leave this owner. Direct eval must use the
      // actual intrinsic identity inside its private explicit lexical frame.
      const run = state.realmFunction(compiled.environmentName, 'eval', 'source', 'return eval(source)')
      return reflect.apply(run, undefined, [environment, state.intrinsicEval, compiled.code])
    },
    declareGlobals(names) { if (names.length > 0) reflect.apply(state.intrinsicEval, undefined, [`var ${internal.join(names, ',')};`]) },
    propagate,
    prepareCall,
    prepareInvocation: invocation,
    releaseMemberReceiver(receiver) { return receiver },
    prepareMemberInvocation(receiver, callee, origin, optional) { return invocation(callee, receiver, origin, optional) },
    beginInvocation,
    prepareTagInvocation,
    templateArguments: state.templateArguments,
    referenceCall(callee, receiver) {
      if (callee == null) return callee
      callee = exposedValue(callee)
      const result = (...args) => invoke(callee, receiver, args)
      internal.weakMapSet(state.prepared, result, { callee, receiver })
      return result
    },
    registerCallableSourceTarget(adapter, target) { internal.weakMapSet(state.callableSourceTargets, adapter, target); return adapter },
    registerSources(sources) { state.sources.register(sources) },
    originalSource(source) { return state.sources.get(source) },
  }
}
