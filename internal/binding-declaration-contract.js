const BINDING_TYPE_NAMESPACE_TOKEN = '__ptcBindingTypes'

export function bindingTypeNamespaceToken(source) {
  let token = BINDING_TYPE_NAMESPACE_TOKEN
  let suffix = 0
  while (source.includes(token)) token = `${BINDING_TYPE_NAMESPACE_TOKEN}_${++suffix}`
  return token
}
