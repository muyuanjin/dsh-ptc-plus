/** Private descriptors contain own fields only. Native source reflection keeps
 * its separate ToPropertyDescriptor behavior, including inherited fields. */
export function createCompilerDescriptors(object, reflect) {
  const define = object.defineProperty, defineMany = object.defineProperties
  const ownKeys = reflect.ownKeys, ownField = object.getOwnPropertyDescriptor
  const reflectDefine = reflect.defineProperty
  const descriptor = fields => ({ __proto__: null, ...fields })
  const ownedObject = function(value) { return object(value) }
  const names = object.getOwnPropertyNames(object)
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    if (name !== 'name' && name !== 'length' && name !== 'prototype') {
      define(ownedObject, name, descriptor(ownField(object, name)))
    }
  }
  const operations = {
    Object: ownedObject,
    descriptor,
    getOwnPropertyDescriptor(target, key) {
      const fields = ownField(target, key)
      return fields === void 0 ? void 0 : descriptor(fields)
    },
    defineProperty: (target, key, fields) => define(target, key, descriptor(fields)),
    reflectDefineProperty: (target, key, fields) => reflectDefine(target, key, descriptor(fields)),
    defineProperties(target, fields) {
      const table = { __proto__: null }, keys = ownKeys(fields)
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]
        if (ownField(fields, key).enumerable) table[key] = descriptor(fields[key])
      }
      return defineMany(target, table)
    },
  }
  ownedObject.defineProperty = operations.defineProperty
  ownedObject.defineProperties = operations.defineProperties
  ownedObject.getOwnPropertyDescriptor = operations.getOwnPropertyDescriptor
  return operations
}

// The same construction contract is instantiated in emitted realms.
export const compilerDescriptorSource = Function.prototype.toString.call(createCompilerDescriptors)
export const compilerDescriptors = createCompilerDescriptors(Object, Reflect)
