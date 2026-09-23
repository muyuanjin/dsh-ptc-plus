import { Report } from 'c8'
import { checkCoverages } from 'c8/lib/commands/check-coverage.js'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageInputFilter } from './coverage-inputs.mjs'

export const COVERAGE_INCLUDE = ['index.js', 'internal/*.js', 'compiler-*.cjs']
export const COVERAGE_THRESHOLDS = { lines: 100, branches: 95, functions: 100, statements: 0 }

/**
 * The plugin sources every graded coverage merge must measure: the plugin entry
 * and each `internal/` JavaScript owner. `COVERAGE_INCLUDE` additionally keeps
 * the generated compiler bundles, whose recorded evidence is remapped onto
 * their original `internal/` sources. Without this closure, a module that no
 * instrumented process loads simply stays out of the merged map and every
 * threshold passes on the remaining files.
 */
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
    console.log(`Coverage merger input: ${stats.scripts} → ${stats.retainedScripts} scripts`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
