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
 * Only *host* versions are a hazard. A pin for another toolchain (the transform
 * compiler, the Node engine floor) is a contract of its own and stays where it is,
 * so every arm below is scoped to an identifier that names the host.
 *
 * Allowed places for a literal: documentation, release notes, historical
 * evidence, and test baselines (which pin a concrete host on purpose).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const BEHAVIOUR_ROOTS = ['index.js', 'internal', 'src']
const SKIP = new Set(['node_modules', '.git', 'coverage', 'artifacts'])
const LITERAL = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/
// A host identifier in the spellings a check is written with: `dsh`, `dshVersion`,
// `DSH_VERSION`, `hostVersion`, `@deepseek-ai/dsh`. A plain `hostname` is not one,
// and neither is `Node` — the engine floor is somebody else's contract.
// `dsh` and `host` prefix the identifiers a version check is written with:
// `dshVersion`, `hostFloor`, `HOST_FLOOR`, `dshPkg.version`, `hostVersionAtLeast`.
// `hostname` is the one prefix that is not a host; it is excluded by name.
// Any identifier that *contains* dsh/host, in any position: `MIN_DSH_FLOOR`,
// `peerHostVersion`, `dshPkg.version`. `hostname` is the one word excluded by name.
const HOST = /@deepseek-ai\/dsh|(?:[A-Za-z0-9_]*(?:dsh|host)(?!name)[A-Za-z0-9_]*)/i
// A line may mention a version only as part of a host package specifier used in
// an error message for humans; behaviour still may not compare against it.
// Comments, and a message that tells a human to install a package version, are
// not behaviour: the former explains, the latter is text a user reads.
const ALLOW = [/^\s*\*/m, /^\s*\/\//m, /@deepseek-ai\/dsh@/m]

/**
 * Which lines would let a host version decide behaviour. A literal only counts
 * when the same line names the host; a comparison through a helper counts only
 * when the helper's argument is a host version, so `nodeEngine >= '24.9.0'` and
 * `compare(amaroVersion, '1.1.11')` stay legal.
 */
export function hostVersionLiteralViolations(text, { fileNamesHost = false } = {}) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (ALLOW.some(pattern => pattern.test(line))) return []
    if (!LITERAL.test(line)) return []
    if (!fileNamesHost && !HOST.test(line)) return []
    return [`${index + 1}: ${line.trim()}`]
  })
}

function* sources(directory) {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(?:cjs|mjs|js)$/.test(entry)) yield path
  }
}

/** Host-version literals across the behaviour roots of one checkout. */
export function scanHostVersionLiterals(root) {
  const violations = []
  for (const entry of BEHAVIOUR_ROOTS) {
    const start = join(root, entry)
    const files = statSync(start).isDirectory() ? [...sources(start)] : [start]
    for (const file of files) {
      for (const violation of hostVersionLiteralViolations(readFileSync(file, 'utf8'))) {
        violations.push(`${relative(root, file).replaceAll('\\', '/')}:${violation}`)
      }
    }
  }
  return violations
}

function invokedDirectly() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return fileURLToPath(new URL(`file://${entry}`)) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const violations = scanHostVersionLiterals(process.cwd())
  if (violations.length > 0) {
    console.error('DSH version literals in behaviour code (detect the shape instead):')
    for (const violation of violations) console.error(`  ${violation}`)
    process.exitCode = 1
  } else {
    console.log('Host compatibility is shape-detected: no DSH version literal in behaviour code')
  }
}
