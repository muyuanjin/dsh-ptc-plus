import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { createRequire } from 'node:module'
import { build, transform } from 'esbuild'
import { compilerPlatformRequirements, validateCompilerPlatform } from './compiler-platform-contract.mjs'
import { createPlatform } from '../internal/compiler-platform-factory.js'
import { compilerPlatformBridge } from '../internal/compiler-platform.js'
import { extractCompilerAssets } from './compiler-assets.mjs'

const command = process.argv[2] ?? 'check'
if (command !== 'build' && command !== 'check') throw new Error(`unknown compiler bundle command ${command}`)
const root = new URL('../', import.meta.url)
const assets = new Map()
const options = { entryPoints: {
  'compiler-core': fileURLToPath(new URL('internal/compiler-entry.js', root)),
  'compiler-platform': fileURLToPath(new URL('internal/compiler-platform-factory.js', root)),
}, bundle: true, platform: 'node', format: 'cjs',
  target: 'node22.19', write: false, metafile: true, minifyIdentifiers: true, minifyWhitespace: true,
  outdir: fileURLToPath(root), outExtension: { '.js': '.cjs' }, sourcemap: 'linked', sourcesContent: false,
  // Babel's optional on-disk TypeScript config loader is never selected: every
  // transform disables configFile/babelrc and supplies its plugins directly.
  external: ['@babel/preset-typescript/package.json', 'typescript', 'amaro', 'compiler-asset:*'],
  alias: { path: 'pathe',
    'node:zlib': fileURLToPath(new URL('../internal/compiler-compression.js', import.meta.url)) },
  define: { 'import.meta.url': '__compilerBaseUrl' }, legalComments: 'eof',
  // Remove dependency comments before readable bundle emission. Non-ASCII
  // comments can double the entire retained source string's memory footprint.
  plugins: [{ name: 'dependency-source', setup(plugin) {
    plugin.onLoad({ filter: /node_modules[\\/].*\.[cm]?js$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      const input = source.length >= 64 * 1024 ? extractCompilerAssets(source, path, assets) : source
      const result = await transform(input, { sourcefile: basename(path),
        minifyWhitespace: true, sourcemap: 'inline', sourcesContent: false, legalComments: 'eof' })
      return { contents: result.code, loader: 'js' }
    })
  } }],
}
const results = [await build(options)]
for (const name of ['typescript', 'amaro']) results.push(await build({ ...options,
  entryPoints: { [`compiler-${name}`]: createRequire(import.meta.url).resolve(name) },
  external: ['compiler-asset:*'],
  // The artifact evaluates to its exports without retaining globals in the
  // shared compiler realm. Its owner may reclaim the entire optional module.
  banner: { js: '(() => { const module = { exports: {} }; const exports = module.exports;' },
  footer: { js: 'return module.exports; })()' },
}))
const platform = createPlatform(compilerPlatformBridge)
const inputs = new Map(results.flatMap(result => Object.entries(result.metafile.inputs)))
const requirements = (await Promise.all([...inputs].filter(([file]) => /^internal\/.*\.[cm]?js$/u.test(file))
  .map(async ([file, input]) => compilerPlatformRequirements(await readFile(new URL(file, root), 'utf8'),
    new Set(input.imports.filter(dependency => dependency.external).map(dependency => dependency.path)))))).flat()
// Maintained dependencies also contain disabled filesystem/configuration paths.
// Their supported initialization paths are exercised by the private-realm tests;
// compiler-owner imports are unconditional requirements of this platform.
validateCompilerPlatform(platform.require, requirements)
for (const result of results) for (const file of Object.keys(result.metafile.inputs)) {
  if (/internal\/.*(?:runtime|worker|session|kernel).*\.js$/u.test(file)) {
    throw new Error(`compiler bundle includes execution owner ${file}`)
  }
}
for (const result of results) for (const file of result.outputFiles) {
  if (command === 'build') await writeFile(file.path, file.text)
  else if (await readFile(file.path, 'utf8') !== file.text) {
    throw new Error('compiler bundle is stale; run npm run build and review its source changes')
  }
}
const assetManifest = {}
for (const [key, value] of [...assets].sort(([left], [right]) => left.localeCompare(right))) {
  const name = `compiler-asset-${key.slice('compiler-asset:'.length)}.txt`
  assetManifest[key] = name
  // JSON preserves all UTF-16 code units, including unpaired surrogates.
  const content = JSON.stringify(value)
  if (command === 'build') await writeFile(new URL(name, root), content)
  else if (await readFile(new URL(name, root), 'utf8') !== content) throw new Error(`compiler asset is stale: ${name}`)
}
const manifestText = JSON.stringify(assetManifest, null, 2) + '\n'
if (command === 'build') await writeFile(new URL('compiler-assets.json', root), manifestText)
else if (await readFile(new URL('compiler-assets.json', root), 'utf8') !== manifestText) {
  throw new Error('compiler asset manifest is stale; run npm run build')
}
