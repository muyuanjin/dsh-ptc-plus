import { AsyncLocalStorage } from 'node:async_hooks'
import { WORKER_REALM_MUTATION, defineWorkerRealmProperty } from './worker-realm-surfaces.js'

const bind = Function.prototype.call.bind(Function.prototype.bind)
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const apply = Reflect.apply
const nativeGetStore = AsyncLocalStorage.prototype.getStore
const nativeEnterWith = AsyncLocalStorage.prototype.enterWith
const nativeRun = AsyncLocalStorage.prototype.run
const nativeRunDescriptor = getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'run')

function protect(scope) {
  defineWorkerRealmProperty(WORKER_REALM_MUTATION.STABLE, 'private AsyncLocalStorage receiver methods',
    scope, 'getStore', { value: bind(nativeGetStore, scope) })
  defineWorkerRealmProperty(WORKER_REALM_MUTATION.STABLE, 'private AsyncLocalStorage receiver methods',
    scope, 'enterWith', { value: bind(nativeEnterWith, scope) })
  defineWorkerRealmProperty(WORKER_REALM_MUTATION.STABLE, 'private AsyncLocalStorage receiver methods',
    scope, 'run', { value: bind(nativeRun, scope) })
  return scope
}

export function createPrivateAsyncLocalStorage() {
  return protect(new AsyncLocalStorage())
}

export function protectNextAsyncLocalStorageRun(invoke) {
  let scope
  defineWorkerRealmProperty(WORKER_REALM_MUTATION.TEMPORARY, 'AsyncLocalStorage.prototype.run',
    AsyncLocalStorage.prototype, 'run', {
    ...nativeRunDescriptor,
    value: function (...args) {
      scope ??= protect(this)
      return apply(nativeRun, this, args)
    },
    })
  try {
    invoke()
  } finally {
    defineWorkerRealmProperty(WORKER_REALM_MUTATION.RESTORE, 'AsyncLocalStorage.prototype.run',
      AsyncLocalStorage.prototype, 'run', nativeRunDescriptor)
  }
  return scope
}
