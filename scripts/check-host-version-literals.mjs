/**
 * Behaviour must not branch on a DSH version. Every host difference the plugin
 * supports is a *shape* difference — which package exports a symbol, what a
 * registration call returns, whether a tool definition exists — and shapes are
 * detected at load time by probing, the way `internal/host-tool-sdk.js` does.
 *
 * A version literal in behaviour code is therefore always a bug: it pins the
 * plugin to yesterday's alpha, then the matching rc arrives and the same literal
 * has to be edited again. This check keeps that failure out of the tree.
 *
 * Allowed places for a literal: documentation, release notes, historical
 * evidence, and test baselines (which pin a concrete host on purpose).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const BEHAVIOUR_ROOTS = ['index.js', 'internal', 'src']
const SKIP = new Set(['node_modules', '.git', 'coverage', 'artifacts'])
const LITERAL = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/g
// Only a *host* version is a hazard; other pins (the transform toolchain, for
// example) are contracts of their own and stay where they are. The pattern has to
// catch the spellings a version check is actually written with — `dshVersion`,
// `hostVersion`, `DSH_VERSION` — not just the bare package prefix, or the guard
// would miss exactly the line it exists to prevent.
const HOST = /(?:@deepseek-ai\/)?\b(?:dsh|host)[A-Za-z_]*\b/i
const COMPARISON = /(?:[<>]=?|===?|!==?)\s*['"`]?\d+\.\d+\.\d+/
// Comparing a host version through a helper reads the same in reverse order.
const COMPARE_CALL = /\b(?:compare|semver|satisfies|gte|lte|gt|lt)\s*\(/i
// A line may mention a version only as part of a host package specifier used in
// an error message for humans; behaviour still may not compare against it.
const ALLOW = [/^\s*\*/m, /^\s*\/\//m]

function* sources(directory) {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue
    const path = join(directory, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) yield* sources(path)
    else if (/\.(?:cjs|mjs|js)$/.test(entry)) yield path
  }
}

/** Which lines would let a host version decide behaviour. Exported so a test can
 * assert that the guard discriminates, rather than trusting it because it is green. */
export function hostVersionLiteralViolations(text) {
  const found = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (ALLOW.some(pattern => pattern.test(line))) return
    if (!HOST.test(line) && !COMPARISON.test(line) && !COMPARE_CALL.test(line)) return
    const match = line.match(LITERAL)
    if (match === null) return
    found.push(`${index + 1}: ${match[0]} — ${line.trim()}`)
  })
  return found
}

const violations = []
for (const root of BEHAVIOUR_ROOTS) {
  const start = join(ROOT, root)
  const files = statSync(start).isDirectory() ? [...sources(start)] : [start]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const violation of hostVersionLiteralViolations(text)) {
      violations.push(`${relative(ROOT, file).replaceAll('\\', '/')}:${violation}`)
    }
  }
}

if (violations.length > 0) {
  console.error('DSH version literals in behaviour code (detect the shape instead):')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exitCode = 1
} else {
  console.log('Host compatibility is shape-detected: no DSH version literal in behaviour code')
}
