import { parseExpression } from '@babel/parser'

/** Dynamic names require both a native identifier and their exact source origin. */
export function dynamicBindingOrigin(target, name, origins) {
  if (typeof target !== 'string' || typeof name !== 'string') return undefined
  const suffix = `:${JSON.stringify(name)}`
  if (!target.endsWith(suffix)) return undefined
  const origin = target.slice(0, -suffix.length)
  if (!origins.has(origin)) return undefined
  try {
    const identifier = parseExpression(name)
    return identifier.type === 'Identifier' && identifier.name === name ? origin : undefined
  } catch {
    return undefined
  }
}
