import { compilerDescriptors } from './compiler-descriptors.js'

const uncurry = Function.prototype.bind.bind(Function.prototype.call)
const mapKeys = uncurry(Map.prototype.keys)
const mapIteratorNext = uncurry(Object.getPrototypeOf(new Map().keys()).next)
const weakMapGet = uncurry(WeakMap.prototype.get)
const weakMapSet = uncurry(WeakMap.prototype.set)

function appendArray(target, value) {
  compilerDescriptors.defineProperty(target, target.length,
    { value, writable: true, enumerable: true, configurable: true })
  return target
}

function copyArray(source, start = 0, end = source.length, target = []) {
  for (let index = start; index < end; index++) appendArray(target, source[index])
  return target
}

/** Host-private operations captured before any owned realm executes user code. */
export const runtimeIntrinsics = {
  Object: compilerDescriptors.Object,
  Reflect: {
    apply: Reflect.apply,
    construct: Reflect.construct,
    deleteProperty: Reflect.deleteProperty,
    defineProperty: compilerDescriptors.reflectDefineProperty,
    has: Reflect.has,
    ownKeys: Reflect.ownKeys,
  },
  Error, TypeError, Array, Map, Set, WeakMap, WeakSet, RegExp, Proxy,
  objectCreate: Object.create,
  objectDefineProperty: Object.defineProperty,
  objectEntries: Object.entries,
  objectFreeze: Object.freeze,
  objectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  objectGetPrototypeOf: Object.getPrototypeOf,
  objectHasOwn: Object.hasOwn,
  objectIs: Object.is,
  objectKeys: Object.keys,
  objectPropertyIsEnumerable: uncurry(Object.prototype.propertyIsEnumerable),
  reflectOwnKeys: Reflect.ownKeys,
  numberIsFinite: Number.isFinite,
  numberIsNaN: Number.isNaN,
  numberIsSafeInteger: Number.isSafeInteger,
  toBigInt: BigInt,
  toNumber: Number,
  toString: String,
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
  setSize: uncurry(Object.getOwnPropertyDescriptor(Set.prototype, 'size').get),
  setForEach: uncurry(Set.prototype.forEach),
  weakMapHas: uncurry(WeakMap.prototype.has),
  weakMapGet,
  weakMapSet,
  weakSetHas: uncurry(WeakSet.prototype.has),
  weakSetAdd: uncurry(WeakSet.prototype.add),
  isArray: Array.isArray,
  everyArray: uncurry(Array.prototype.every),
  includes: uncurry(Array.prototype.includes),
  join: uncurry(Array.prototype.join),
  popArray: uncurry(Array.prototype.pop),
  prependArray: uncurry(Array.prototype.unshift),
  someArray: uncurry(Array.prototype.some),
  sliceString: uncurry(String.prototype.slice),
  splitString: uncurry(String.prototype.split),
  searchString: uncurry(String.prototype.search),
  replaceString: uncurry(String.prototype.replace),
  trimString: uncurry(String.prototype.trim),
  replaceAllString: uncurry(String.prototype.replaceAll),
  includesString: uncurry(String.prototype.includes),
  startsWith: uncurry(String.prototype.startsWith),
  endsWith: uncurry(String.prototype.endsWith),
  regexpExec: uncurry(RegExp.prototype.exec),
  regexpTest: uncurry(RegExp.prototype.test),
  floor: Math.floor,
  min: Math.min,
  max: Math.max,
  appendArray,
  copyArray,
  sort: uncurry(Array.prototype.sort),
  compare: uncurry(String.prototype.localeCompare),
}

if (typeof Buffer === 'function') {
  runtimeIntrinsics.bufferByteLength = Buffer.byteLength
  runtimeIntrinsics.bufferConcat = Buffer.concat
  runtimeIntrinsics.bufferIsBuffer = Buffer.isBuffer
  runtimeIntrinsics.bufferSubarray = uncurry(Buffer.prototype.subarray)
  runtimeIntrinsics.bufferToString = uncurry(Buffer.prototype.toString)
}
