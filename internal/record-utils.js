/** Shared structural guards for closed PTC metadata boundaries. */

import { runtimeIntrinsics as internal } from './runtime-intrinsics.js'

const { TypeError, isArray, reflectOwnKeys, objectGetOwnPropertyDescriptor,
  objectHasOwn, objectPropertyIsEnumerable, objectFreeze, trimString, toString,
  Set, setHas, setAdd, setSize, appendArray, popArray } = internal

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !isArray(value)
}

export function assertOwnFields(value, allowed, label) {
  const keys = reflectOwnKeys(value)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (typeof key !== 'string' || !setHas(allowed, key)
      || !objectPropertyIsEnumerable(value, key)) {
      throw new TypeError(`invalid ${label} field ${toString(key)}`)
    }
  }
}

export function assertFields(value, allowed, label) {
  if (!isRecord(value)) throw new TypeError(`invalid ${label}`)
  assertOwnFields(value, allowed, label)
  if (reflectOwnKeys(value).length !== setSize(allowed)) throw new TypeError(`invalid ${label} fields`)
}

export function record(value, label) {
  if (!isRecord(value)) throw new TypeError(`ptc-plus: ${label} must be an object`)
  return value
}

export function text(value, label) {
  if (typeof value !== 'string' || trimString(value).length === 0) {
    throw new TypeError(`ptc-plus: ${label} must be a non-empty string`)
  }
  return value
}

/** Freeze one static object graph without invoking accessors or recursing. */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  const pending = [value]
  const seen = new Set()
  while (pending.length > 0) {
    const current = popArray(pending)
    if (setHas(seen, current)) continue
    setAdd(seen, current)
    const keys = reflectOwnKeys(current)
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = objectGetOwnPropertyDescriptor(current, keys[index])
      if (descriptor !== undefined && objectHasOwn(descriptor, 'value')) {
        const child = descriptor.value
        if (child !== null && typeof child === 'object') appendArray(pending, child)
      }
    }
    objectFreeze(current)
  }
  return value
}
