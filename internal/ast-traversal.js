const AST_METADATA_KEYS = new Set(['start', 'end', 'loc', 'range'])

export const SKIP_AST_CHILDREN = Symbol('skip AST children')

/** Walk ESTree-shaped values while ignoring source-location metadata. */
export function walkAst(node, enter, leave = undefined, context = undefined, parent = undefined, parentKey = undefined) {
  if (node === null || typeof node !== 'object') return
  const entered = enter(node, parent, parentKey, context)
  if (entered === SKIP_AST_CHILDREN) return
  const childContext = entered === undefined ? context : entered
  const keys = Object.keys(node)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (AST_METADATA_KEYS.has(key)) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (let child = 0; child < value.length; child++) walkAst(value[child], enter, leave, childContext, node, key)
    } else {
      walkAst(value, enter, leave, childContext, node, key)
    }
  }
  leave?.(node, parent, parentKey, childContext)
}
