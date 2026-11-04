import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { parse } from 'acorn'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
// `@deepseek-ai/dsh-api-session-controller` is a peer of the declared client
// test runtime, not a direct dependency, so it resolves from that owner's
// location instead of relying on the installer hoisting it to the root.
const ownerRequire = createRequire(require.resolve('@deepseek-ai/dsh-client-test-runtime'))
const resolveClientEntry = (name) => {
  try { return ownerRequire.resolve(name) } catch { return require.resolve(name) }
}
// Not every package exports `./package.json`, so the manifest is found by walking
// up from the entry it does export rather than by resolving a fixed subpath.
const manifestOf = (name) => {
  for (let dir = dirname(resolveClientEntry(name)); ; dir = dirname(dir)) {
    const candidate = resolvePath(dir, 'package.json')
    try {
      if (JSON.parse(readFileSync(candidate, 'utf8')).name === name) return candidate
    } catch {}
    if (dirname(dir) === dir) throw new Error(`Cannot locate the package manifest of ${name}`)
  }
}
// The DSH web client is a browser consumer, so its condition wins over `node`
// even though this config runs under Node. Packages that separate the two ship a
// ModuleLoader factory for the browser and an ES module for Node.
const resolveClientTarget = (name) => {
  const manifest = manifestOf(name)
  const entry = JSON.parse(readFileSync(manifest, 'utf8')).exports?.['./client']
  const target = typeof entry === 'string' ? entry : entry?.browser ?? entry?.default
  return target === undefined ? resolveClientEntry(`${name}/client`) : resolvePath(dirname(manifest), target)
}
const prefix = '\0ptc-client-test:'
const renderer = '@deepseek-ai/dsh-client-ui-renderer'
const sessionController = '@deepseek-ai/dsh-api-session-controller'
const contextMenu = '@deepseek-ai/dsh-client-ui-context-menu'
const supportExports = {
  [`${renderer}/src/client/bind.ts`]: [renderer, 'bindSnapshotSelector'],
  [`${renderer}/src/client/scoped-slots.tsx`]: [renderer, 'createSlotRenderer'],
  [`${sessionController}/src/client/scope.ts`]: [sessionController, 'scopeIdentityOf'],
  [`${contextMenu}/src/client/trigger.ts`]: [contextMenu, 'createContextMenuBindings'],
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit))
    else if (value !== null && typeof value === 'object') walk(value, visit)
  }
}

function clientDependency(name) {
  if (!name.startsWith('@deepseek-ai/')) return name
  try { resolveClientTarget(name) } catch { return name }
  return `${name}/client`
}

const ESM_DECLARATIONS = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
])

// A client entry ships in one of two shapes: the ModuleLoader factory the browser
// evaluates, or a plain ES module projection (a namespace re-export with no
// runtime behaviour of its own). Only the factory needs this test wrapper.
function entryShape(path) {
  const source = readFileSync(path, 'utf8')
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  let factory
  walk(ast, node => {
    if (node.type === 'Property' && node.key?.name === 'factory') factory = node.value
  })
  if (factory !== undefined) return { shape: 'factory', source, factory }
  if (ast.body.some(node => ESM_DECLARATIONS.has(node.type))) return { shape: 'module' }
  throw new Error(`Client entry is neither a ModuleLoader factory nor an ES module: ${path}`)
}

const shapes = new Map()
function cachedShape(path) {
  let entry = shapes.get(path)
  if (entry === undefined) {
    entry = entryShape(path)
    shapes.set(path, entry)
  }
  return entry
}

// Exercise the shipped implementations of published browser entries with one
// React/Cordis identity in the test renderer.
function clientModules() {
  return {
    name: 'ptc-public-client-test-modules',
    enforce: 'pre',
    resolveId(id) {
      if (Object.hasOwn(supportExports, id)) return prefix + id
      if (id.startsWith('@deepseek-ai/') && id.endsWith('/client')) {
        const path = resolveClientTarget(id.slice(0, -'/client'.length))
        // An ES module entry keeps its real path so relative imports inside it
        // resolve against the package, not against this config's directory.
        return cachedShape(path).shape === 'factory' ? prefix + path : path
      }
    },
    load(id) {
      if (!id.startsWith(prefix)) return
      const path = id.slice(prefix.length)
      if (Object.hasOwn(supportExports, path)) {
        const [owner, name] = supportExports[path]
        return `export { __test_${name} as ${name} } from ${JSON.stringify(owner + '/client')}`
      }
      const entry = cachedShape(path)
      if (entry.shape !== 'factory') return
      let source = entry.source
      const factory = entry.factory
      const imports = new Set()
      walk(factory, node => {
        if (node.type === 'CallExpression' && node.callee?.name === 'require'
          && typeof node.arguments[0]?.value === 'string') imports.add(node.arguments[0].value)
      })
      const names = factory.body.body.flatMap(statement => {
        const expression = statement.type === 'ExpressionStatement' ? statement.expression : undefined
        return expression?.type === 'AssignmentExpression' && expression.left?.object?.name === 'exports'
          ? [expression.left.property.name] : []
      })
      // The published test-support package references source files omitted from
      // its dependencies' tarballs. Expose the same shipped bundle functions.
      const supportNames = Object.values(supportExports)
        .filter(([owner]) => path === resolveClientTarget(owner))
        .map(([, name]) => name)
      if (supportNames.length > 0) {
        const returned = factory.body.body.findLast(statement => statement.type === 'ReturnStatement')
        source = source.slice(0, returned.start)
          + supportNames.map(name => `exports.__test_${name} = ${name};`).join('')
          + source.slice(returned.start)
        names.push(...supportNames.map(name => `__test_${name}`))
      }
      const dependencies = [...imports]
      return [
        ...dependencies.map((name, index) => `import * as dep${index} from ${JSON.stringify(clientDependency(name))};`),
        `const deps = {${dependencies.map((name, index) => `${JSON.stringify(name)}:dep${index}`).join(',')}};`,
        'let definition; const window = { __ModuleLoader__: { load(value) { definition = value } } };',
        source,
        'const dependency = name => { if (!(name in deps)) throw new Error(`Unknown Client dependency ${name}`); return deps[name] };',
        // The loader also hands entries their asset URLs; a test renderer serves
        // the shipped path itself, which is what a stylesheet `url()` receives.
        'dependency.asset = id => id;',
        'const loaded = definition.factory(dependency);',
        ...[...new Set(names)].map((name, index) => `const value${index} = loaded[${JSON.stringify(name)}]; export { value${index} as ${name} };`),
      ].join('\n')
    },
  }
}

export default defineConfig({
  plugins: [clientModules()],
  test: {
    environment: 'jsdom',
    include: ['test/client-runtime.spec.js'],
    server: { deps: { inline: [/@deepseek-ai\//] } },
    testTimeout: 15000,
  },
})
