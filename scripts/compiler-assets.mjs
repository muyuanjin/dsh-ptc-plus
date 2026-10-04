import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { transformSync, types } from '@babel/core'

// Source copies may live under win_node_modules; only a complete dependency
// directory segment admits dependency preprocessing.
export const COMPILER_DEPENDENCY_SOURCE_FILTER = /(?:^|[\\/])node_modules[\\/].*\.[cm]?js$/

// Large immutable data belongs in packaged assets, not in retained script
// source and V8's literal pool simultaneously. Calls still receive exact text.
export function extractCompilerAssets(source, filename, assets) {
  let extracted = false
  const result = transformSync(source, {
    filename, babelrc: false, configFile: false, browserslistConfigFile: false,
    sourceMaps: 'inline', sourceFileName: basename(filename), compact: true,
    plugins: [() => ({ visitor: {
      StringLiteral(path) {
        if (path.node.value.length < 64 * 1024 || !path.parentPath.isCallExpression()
          || path.listKey !== 'arguments' || path.scope.getBinding('require') !== undefined) return
        const value = path.node.value
        const digest = createHash('sha256').update(value, 'utf16le').digest('hex')
        const key = `compiler-asset:${digest}`
        assets.set(key, value)
        extracted = true
        path.replaceWith(types.callExpression(types.identifier('require'), [types.stringLiteral(key)]))
        path.skip()
      },
    } })],
  })
  return extracted ? result.code : source
}
