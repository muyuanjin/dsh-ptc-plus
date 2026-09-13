import { record } from './record-utils.js'

const SOFT_PLUGIN_NAMESPACES = new Set(['capabilities', 'code', 'repl'])

function name(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`ptc-plus: ${label} must be a non-empty string`)
  }
  return value
}

function normalizeErrorClass(value, globalName) {
  if (value === undefined) return undefined
  const descriptor = record(value, `binding ${globalName} errorClass`)
  return Object.freeze({
    name: name(descriptor.name, `binding ${globalName} errorClass.name`),
    memberNameProperty: name(
      descriptor.memberNameProperty,
      `binding ${globalName} errorClass.memberNameProperty`,
    ),
  })
}

function normalizeEmptyObjectMembers(value, globalName, members) {
  if (value === undefined) return Object.freeze([])
  if (globalName !== 'tools' || !Array.isArray(value)) {
    throw new TypeError(`ptc-plus: binding ${globalName} emptyObjectMembers must be an array for tools`)
  }
  const available = new Set(members)
  const seen = new Set()
  const normalized = value.map((member) => {
    const memberName = name(member, `binding ${globalName} emptyObjectMembers entry`)
    if (!available.has(memberName)) {
      throw new TypeError(`ptc-plus: binding ${globalName} emptyObjectMembers contains unknown member ${JSON.stringify(memberName)}`)
    }
    if (seen.has(memberName)) {
      throw new TypeError(`ptc-plus: binding ${globalName} emptyObjectMembers contains duplicate member ${JSON.stringify(memberName)}`)
    }
    seen.add(memberName)
    return memberName
  })
  return Object.freeze(normalized)
}

export function normalizeBindingDescriptors(bindings) {
  if (!Array.isArray(bindings)) throw new TypeError('ptc-plus: bindings must be an array')
  const reservedNames = new Set()
  const namespaceNames = new Set()
  const namespaces = bindings.map((value) => {
    const namespace = record(value, 'binding namespace')
    const globalName = name(namespace.global, 'binding namespace global')
    if (namespaceNames.has(globalName)) {
      throw new TypeError(`ptc-plus: duplicate binding namespace global ${JSON.stringify(globalName)}`)
    }
    namespaceNames.add(globalName)
    const functions = record(namespace.functions, `binding ${globalName} functions`)
    const members = Reflect.ownKeys(functions).map((member) => {
      if (typeof member !== 'string' || member.length === 0) {
        throw new TypeError(`ptc-plus: binding ${globalName} member names must be non-empty strings`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(functions, member)
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError(`ptc-plus: binding ${globalName}.${member} is not an own callable value`)
      }
      return member
    })
    const errorClass = normalizeErrorClass(namespace.errorClass, globalName)
    const emptyObjectMembers = normalizeEmptyObjectMembers(
      namespace.emptyObjectMembers,
      globalName,
      members,
    )
    if (!SOFT_PLUGIN_NAMESPACES.has(globalName)) reservedNames.add(globalName)
    if (errorClass !== undefined) reservedNames.add(errorClass.name)
    return Object.freeze({
      global: globalName,
      functions,
      members: Object.freeze(members),
      ...(emptyObjectMembers.length === 0 ? {} : { emptyObjectMembers }),
      ...(errorClass === undefined ? {} : { errorClass }),
    })
  })
  return Object.freeze({
    namespaces: Object.freeze(namespaces),
    reservedNames,
    workerDescriptors: Object.freeze(namespaces.map(namespace => Object.freeze({
      global: namespace.global,
      members: namespace.members,
      ...(reservedNames.has(namespace.global) ? {} : { shadowable: true }),
      ...(namespace.emptyObjectMembers === undefined
        ? {}
        : { emptyObjectMembers: namespace.emptyObjectMembers }),
      ...(namespace.errorClass === undefined ? {} : { errorClass: namespace.errorClass }),
    }))),
  })
}
