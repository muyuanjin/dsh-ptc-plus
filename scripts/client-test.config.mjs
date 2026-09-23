import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
const prefix = '\0ptc-client-test:'
const renderer = '@deepseek-ai/dsh-client-ui-renderer'
const sessionController = '@deepseek-ai/dsh-api-session-controller'
const supportExports = {
  [`${renderer}/src/client/bind.ts`]: [renderer, 'bindSnapshotSelector'],
  [`${renderer}/src/client/scoped-slots.tsx`]: [renderer, 'createSlotRenderer'],
  [`${sessionController}/src/client/scope.ts`]: [sessionController, 'scopeIdentityOf'],
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
  try { resolveClientEntry(`${name}/client`); return `${name}/client` } catch { return name }
}

// Published browser entries are ModuleLoader factories, not ESM. Exercise their
// shipped implementations with one React/Cordis identity in the test renderer.
function clientModules() {
  return {
    name: 'ptc-public-client-test-modules',
    enforce: 'pre',
    resolveId(id) {
      if (Object.hasOwn(supportExports, id)) return prefix + id
      if (id.startsWith('@deepseek-ai/') && id.endsWith('/client')) {
        return prefix + resolveClientEntry(id)
      }
    },
    load(id) {
      if (!id.startsWith(prefix)) return
      const path = id.slice(prefix.length)
      if (Object.hasOwn(supportExports, path)) {
        const [owner, name] = supportExports[path]
        return `export { __test_${name} as ${name} } from ${JSON.stringify(owner + '/client')}`
      }
      let source = readFileSync(path, 'utf8')
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' })
      let factory
      walk(ast, node => {
        if (node.type === 'Property' && node.key?.name === 'factory') factory = node.value
      })
      if (factory === undefined) throw new Error(`Client entry has no ModuleLoader factory: ${path}`)
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
        .filter(([owner]) => path === resolveClientEntry(owner + '/client'))
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
        'const loaded = definition.factory(name => { if (!(name in deps)) throw new Error(`Unknown Client dependency ${name}`); return deps[name] });',
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
