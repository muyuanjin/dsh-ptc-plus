import { stringifyCompilerData } from './compiler-data.js'
import { compilerStorageSource } from './compiler-storage-source.js'
import { compilerDescriptorSource } from './compiler-descriptors.js'

/** Compiler operations are captured before an owned realm executes user code. */
const defaultRealmFunction = Function
const realms = new WeakMap()
const uncurry = Function.prototype.bind.bind(Function.prototype.call)
const weakMapGet = uncurry(WeakMap.prototype.get)
const weakMapSet = uncurry(WeakMap.prototype.set)
const mapKeys = uncurry(Map.prototype.keys)
const mapIteratorNext = uncurry(Object.getPrototypeOf(new Map().keys()).next)

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
      construct:nativeReflect.construct,ownKeys:nativeReflect.ownKeys,defineProperty:properties.reflectDefineProperty,
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
  Object: moduleCompilerIntrinsics.Object,
  Reflect: moduleCompilerIntrinsics.Reflect,
  Error: moduleCompilerIntrinsics.Error,
  Map, Set, WeakMap, Proxy,
  mapGet: uncurry(Map.prototype.get),
  mapHas: uncurry(Map.prototype.has),
  mapSet: uncurry(Map.prototype.set),
  mapDelete: uncurry(Map.prototype.delete),
  mapClear: uncurry(Map.prototype.clear),
  mapSize: uncurry(Object.getOwnPropertyDescriptor(Map.prototype, 'size').get),
  mapFirstKey: value => mapIteratorNext(mapKeys(value)).value,
  mapForEach: uncurry(Map.prototype.forEach),
  setHas: uncurry(Set.prototype.has),
  setAdd: uncurry(Set.prototype.add),
  setDelete: uncurry(Set.prototype.delete),
  setClear: uncurry(Set.prototype.clear),
  setForEach: uncurry(Set.prototype.forEach),
  weakMapHas: uncurry(WeakMap.prototype.has),
  weakMapGet, weakMapSet,
  isArray: Array.isArray,
  includes: uncurry(Array.prototype.includes),
  join: uncurry(Array.prototype.join),
  sliceString: uncurry(String.prototype.slice),
  replaceAllString: uncurry(String.prototype.replaceAll),
  includesString: uncurry(String.prototype.includes),
  floor: Math.floor,
  min: Math.min,
  max: Math.max,
  // Only private native Promises enter this boundary. Source promises and the
  // public result keep their prototypes; private reactions cannot select a
  // source constructor/species or dynamically dispatch through then/catch.
  observeOwnedPromise: moduleCompilerIntrinsics.observeOwnedPromise,
  appendArray(target, value) {
    moduleCompilerIntrinsics.Object.defineProperty(target, target.length,
      { value, writable: true, enumerable: true, configurable: true })
    return target
  },
  copyArray(source, start = 0, end = source.length, target = []) {
    for (let index = start; index < end; index++) this.appendArray(target, source[index])
    return target
  },
  sort: uncurry(Array.prototype.sort),
  compare: uncurry(String.prototype.localeCompare),
  startsWith: uncurry(String.prototype.startsWith),
  stringify: stringifyCompilerData,
}
