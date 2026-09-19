import { AsyncLocalStorage } from 'node:async_hooks'

const bind = Function.prototype.call.bind(Function.prototype.bind)
const defineProperty = Object.defineProperty
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const apply = Reflect.apply
const nativeGetStore = AsyncLocalStorage.prototype.getStore
const nativeEnterWith = AsyncLocalStorage.prototype.enterWith
const nativeRun = AsyncLocalStorage.prototype.run
const nativeRunDescriptor = getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'run')

function protect(scope) {
  defineProperty(scope, 'getStore', { value: bind(nativeGetStore, scope) })
  defineProperty(scope, 'enterWith', { value: bind(nativeEnterWith, scope) })
  defineProperty(scope, 'run', { value: bind(nativeRun, scope) })
  return scope
}

export function createPrivateAsyncLocalStorage() {
  return protect(new AsyncLocalStorage())
}

export function protectNextAsyncLocalStorageRun(invoke) {
  let scope
  defineProperty(AsyncLocalStorage.prototype, 'run', {
    ...nativeRunDescriptor,
    value: function (...args) {
      scope ??= protect(this)
      return apply(nativeRun, this, args)
    },
  })
  try {
    invoke()
  } finally {
    defineProperty(AsyncLocalStorage.prototype, 'run', nativeRunDescriptor)
  }
  return scope
}
