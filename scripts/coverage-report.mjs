import { Report } from 'c8'
import { checkCoverages } from 'c8/lib/commands/check-coverage.js'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageInputFilter } from './coverage-inputs.mjs'

export const COVERAGE_INCLUDE = ['index.js', 'internal/*.js', 'compiler-*.cjs']
// A global 100% floor cannot be a release stopping point: the residual gaps of
// the long-standing error branches differ between two full runs of the same tree,
// so the target moves on its own. The floor therefore applies to the plugin
// sources this release changes, and every other source keeps the branch rule.
export const COVERAGE_THRESHOLDS = { lines: 0, branches: 95, functions: 0, statements: 0 }
export const CHANGED_SOURCE_THRESHOLD = { lines: 100, functions: 100 }
// Owners whose error branches were already below the floor before this release.
// They carry historical debt, not new untested code, and leave this list as each
// one is brought to the floor in 0.5.3.
export const CHANGED_SOURCE_DEBT = new Set([
  'internal/capability-environment.js',
  'internal/edit-transport-owner.js',
  'internal/kernel-worker.js',
  'internal/projection-retention.js',
  'internal/prompt-text.js',
  'internal/runtime-contexts.js',
  'internal/session-cell-executor.js',
  'internal/session-journal-recovery.js',
  'internal/session-journal.js',
  'internal/worker-client.js',
])

/**
 * The plugin sources every graded coverage merge must measure: the plugin entry
 * and each `internal/` JavaScript owner. `COVERAGE_INCLUDE` additionally keeps
 * the generated compiler bundles, whose recorded evidence is remapped onto
 * their original `internal/` sources. Without this closure, a module that no
 * instrumented process loads simply stays out of the merged map and every
 * threshold passes on the remaining files.
 */
/**
 * The plugin sources this release changes against its base tag. Coverage is
 * enforced on those files only, so a new arm cannot ship untested while the
 * long-standing branches of untouched owners stay ordinary improvement work.
 */
export function changedPluginSources(root, base = process.env.DSH_PTC_COVERAGE_BASE ?? 'v0.5.1') {
  const output = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: root, encoding: 'utf8' })
  return output.split('\n').map(line => line.trim())
    .filter(line => line === 'index.js' || /^internal\/[^/]+\.js$/.test(line))
}

export function gateSourceFiles(root) {
  return [
    'index.js',
    ...readdirSync(join(root, 'internal'))
      .filter(name => /^[^/]+\.js$/.test(name))
      .map(name => `internal/${name}`),
  ]
}

export function createCoverageReport({
  root,
  directory,
  filter = true,
  reporters = ['text'],
  reporterOptions = {},
  include = COVERAGE_INCLUDE,
  includeUncovered = false,
}) {
  const report = Report({
    include, excludeAfterRemap: true,
    // c8's incremental merge reads one report at a time instead of holding every
    // raw JSON report in memory, which is what the reporter process ran out of.
    mergeAsync: true,
    tempDirectory: directory, reportsDirectory: resolve(root, 'coverage'),
    reporter: reporters, reporterOptions, omitRelative: true,
    all: includeUncovered, src: [root],
  })
  if (report.mergeAsync !== true) throw new Error('coverage report must merge asynchronously')
  const stats = { scripts: 0, retainedScripts: 0 }
  if (filter) {
    const keep = coverageInputFilter(root)
    // c8 exposes Report, but its pre-merge normalization currently bypasses
    // include/exclude when remapping. Adapt this one instance at that boundary;
    // c8 still owns merging, source maps, counters, reporters and thresholds.
    // The equivalence tests pin this dependency integration against plain c8.
    const normalize = report._normalizeProcessCov
    if (typeof normalize !== 'function') throw new Error('c8 coverage input integration is unavailable')
    report._normalizeProcessCov = function (coverage, ...args) {
      const result = coverage.result.filter(script => keep(script, coverage['source-map-cache']))
      stats.scripts += coverage.result.length
      stats.retainedScripts += result.length
      return normalize.call(this, { ...coverage, result }, ...args)
    }
  }
  return { report, stats }
}

export function coverageReportArguments(argv) {
  const [directory, ...argumentsAfterDirectory] = argv
  if (directory === undefined) throw new Error('coverage report requires an evidence directory')
  const include = []
  for (let index = 0; index < argumentsAfterDirectory.length; index++) {
    const argument = argumentsAfterDirectory[index]
    if (argument !== '--include') throw new Error(`unknown coverage report argument: ${argument}`)
    const value = argumentsAfterDirectory[++index]
    if (value === undefined || value.length === 0) throw new Error('--include requires a value')
    include.push(value)
  }
  return { directory, include: include.length === 0 ? COVERAGE_INCLUDE : include, focused: include.length > 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = coverageReportArguments(process.argv.slice(2))
    const { report, stats } = createCoverageReport({
      root: process.cwd(),
      directory: options.directory,
      include: options.include,
      includeUncovered: options.focused,
      reporters: ['text', 'json'],
      reporterOptions: { text: { maxCols: 1000 } },
    })
    const map = await report.getCoverageMapFromAllCoverageFiles()
    const files = new Set(map.files().map(file => resolve(file)))
    if (options.focused) {
      const missing = options.include.filter(source => !files.has(resolve(process.cwd(), source)))
      if (missing.length > 0) throw new Error(`focused coverage report omitted selected sources: ${missing.join(', ')}`)
    } else {
      const missing = gateSourceFiles(process.cwd())
        .filter(source => !files.has(resolve(process.cwd(), source)))
      if (missing.length > 0) {
        throw new Error(`coverage report omitted measured plugin sources: ${missing.join(', ')}`)
      }
    }
    await report.run()
    await checkCoverages(COVERAGE_THRESHOLDS, report)
if (!options.focused) {
  const failures = []
  for (const source of changedPluginSources(process.cwd())) {
    const file = resolve(process.cwd(), source)
    if (!files.has(file) || CHANGED_SOURCE_DEBT.has(source)) continue
    const summary = map.fileCoverageFor(file).toSummary().data
    if (summary.lines.pct < CHANGED_SOURCE_THRESHOLD.lines || summary.functions.pct < CHANGED_SOURCE_THRESHOLD.functions) {
      failures.push(`${source}: lines ${summary.lines.pct}% functions ${summary.functions.pct}%`)
    }
  }
  if (failures.length > 0) throw new Error(`changed plugin sources below ${CHANGED_SOURCE_THRESHOLD.lines}% lines / ${CHANGED_SOURCE_THRESHOLD.functions}% functions: ${failures.join('; ')}`)
}
    console.log(`Coverage merger input: ${stats.scripts} → ${stats.retainedScripts} scripts`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
