import { types } from 'node:util'
import { SourceMapRuns, SOURCE_MAP_RUNS } from './source-position-map.js'
import { compilerDescriptors } from './compiler-descriptors.js'

const { isMap, isSet, isUint32Array } = types
const ownKeys = Reflect.ownKeys
const descriptor = Object.getOwnPropertyDescriptor
const defineData = compilerDescriptors.defineDataProperty
const setPrototypeOf = Object.setPrototypeOf
const stringify = JSON.stringify
const array = Array.isArray
const NativeMap = Map, NativeSet = Set, NativeUint32Array = Uint32Array, NativeTypeError = TypeError
const uncurry = Function.prototype.bind.bind(Function.prototype.call)
const mapForEach = uncurry(Map.prototype.forEach), mapSet = uncurry(Map.prototype.set)
const setForEach = uncurry(Set.prototype.forEach), setAdd = uncurry(Set.prototype.add)

/** Compiler messages contain data only. Rehome collections instead of invoking
 * methods inherited from a caller's mutable realm. No user value crosses here. */
export function copyCompilerData(value) {
  return copyData(value, false)
}

/** Internal JSON keys have data fields, never inherited source serialization
 * hooks. Source values continue to use their own realm's JSON operations. */
export function stringifyCompilerData(value) {
  return stringify(copyData(value, true))
}

function copyData(value, json) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') throw new NativeTypeError('compiler messages must contain data')
    return value
  }
  if (!json && isUint32Array(value)) return new NativeUint32Array(value)
  if (!json && descriptor(value, SOURCE_MAP_RUNS)?.value === true) return new SourceMapRuns(copyData(value.data, false))
  if (!json && isMap(value)) {
    const result = new NativeMap()
    mapForEach(value, (item, key) => mapSet(result, copyData(key, false), copyData(item, false)))
    return result
  }
  if (!json && isSet(value)) {
    const result = new NativeSet()
    setForEach(value, item => setAdd(result, copyData(item, false)))
    return result
  }
  const result = array(value) ? [] : {}
  if (json) setPrototypeOf(result, null)
  const keys = ownKeys(value)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (key === 'length' && array(value)) continue
    const field = descriptor(value, key)
    if (!('value' in field)) throw new NativeTypeError('compiler messages must not contain accessors')
    defineData(result, key, copyData(field.value, json), field.enumerable)
  }
  if (array(value)) result.length = value.length
  return result
}
