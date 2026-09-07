import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { parse } from 'acorn'

const entry = fileURLToPath(new URL('../src/client.js', import.meta.url))
const output = fileURLToPath(new URL('../client.js', import.meta.url))
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
  throw new Error('package.json must declare a non-empty package name for the client module id')
}

const options = {
  entryPoints: [entry],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  write: false,
  define: {
    __PTC_PLUS_CLIENT_MODULE_ID__: JSON.stringify(packageJson.name),
  },
  sourcemap: false,
  external: [
    'react',
    '@deepseek-ai/dsh-client-*',
  ],
}

const command = process.argv[2] ?? 'check'
if (!['build', 'check'].includes(command)) {
  throw new Error(`unknown client bundle command ${JSON.stringify(command)}`)
}

const result = await build(options)
const bundled = result.outputFiles[0].text
const parts = []
let offset = 0
// Dependency comments may contain trailing whitespace; literals must remain exact.
parse(bundled, {
  ecmaVersion: 'latest',
  onComment(_block, _text, start, end) {
    parts.push(bundled.slice(offset, start), bundled.slice(start, end).replace(/[\t ]+$/gm, ''))
    offset = end
  },
})
const generated = parts.join('') + bundled.slice(offset)
if (command === 'build') {
  await writeFile(output, generated)
} else {
  const committed = await readFile(output, 'utf8')
  if (committed !== generated) {
    throw new Error('client.js is stale; run npm run build and review the generated bundle')
  }
}
