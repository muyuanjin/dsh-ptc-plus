import { stringifyCompilerData } from './compiler-data.js'
import { compilerStorageSource } from './compiler-storage-source.js'
import { compilerDescriptorSource } from './compiler-descriptors.js'
import { runtimeIntrinsics } from './runtime-intrinsics.js'

/** Compiler operations are captured before an owned realm executes user code. */
const defaultRealmFunction = Function
const realms = new WeakMap()
const { weakMapGet, weakMapSet } = runtimeIntrinsics

export function captureCompilerIntrinsics(realmFunction = defaultRealmFunction) {
  let intrinsics = weakMapGet(realms, realmFunction)
  if (intrinsics !== undefined) return intrinsics
  intrinsics = realmFunction(`
    const nativeObject=Object;
    const nativeReflect=Reflect;
    const properties=(${compilerDescriptorSource})(nativeObject,nativeReflect);
    const object=properties.Object;
    const symbol=Symbol;
    return {Object:object,WeakMap,WeakSet,unscopables:symbol.unscopables,Reflect:{apply:nativeReflect.apply,
      construct:nativeReflect.construct,deleteProperty:nativeReflect.deleteProperty,has:nativeReflect.has,
      ownKeys:nativeReflect.ownKeys,defineProperty:properties.reflectDefineProperty,
      get decorate(){return nativeReflect.decorate}},TypeError,ReferenceError,SyntaxError,Error,Symbol,String,Number,
      Promise:{resolve:Promise.resolve.bind(Promise),reject:Promise.reject.bind(Promise)},
      SuppressedError:typeof SuppressedError==='function'?SuppressedError:undefined,
      ...(${compilerStorageSource})(object,WeakMap,WeakSet,symbol,Promise,nativeReflect,Array,Function.prototype)};
  `)()
  weakMapSet(realms, realmFunction, intrinsics)
  return intrinsics
}

export const moduleCompilerIntrinsics = captureCompilerIntrinsics()

/** Internal graph records use captured collection operations. Source-owned
 * objects and callbacks keep their original realm and observable methods. */
export const moduleRuntimeIntrinsics = {
  ...runtimeIntrinsics,
  Object: moduleCompilerIntrinsics.Object,
  Reflect: moduleCompilerIntrinsics.Reflect,
  Error: moduleCompilerIntrinsics.Error,
  TypeError: moduleCompilerIntrinsics.TypeError,
  // Only private native Promises enter this boundary. Source promises and the
  // public result keep their prototypes; private reactions cannot select a
  // source constructor/species or dynamically dispatch through then/catch.
  observeOwnedPromise: moduleCompilerIntrinsics.observeOwnedPromise,
  promiseThen: moduleCompilerIntrinsics.promiseThen,
  promiseResolve: moduleCompilerIntrinsics.Promise.resolve,
  promiseReject: moduleCompilerIntrinsics.Promise.reject,
  stringify: stringifyCompilerData,
}
