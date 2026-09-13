import { Report } from 'c8'
import { checkCoverages } from 'c8/lib/commands/check-coverage.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageInputFilter } from './coverage-inputs.mjs'

export const COVERAGE_INCLUDE = ['index.js', 'internal/*.js', 'compiler-*.cjs']
export const COVERAGE_THRESHOLDS = { lines: 100, branches: 95, functions: 100, statements: 0 }

export function createCoverageReport({ root, directory, filter = true, reporters = ['text'] }) {
  const report = Report({
    include: COVERAGE_INCLUDE, excludeAfterRemap: true,
    tempDirectory: directory, reportsDirectory: resolve(root, 'coverage'),
    reporter: reporters, omitRelative: true,
  })
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, stats } = createCoverageReport({ root: process.cwd(), directory: process.argv[2] })
    await report.run()
    await checkCoverages(COVERAGE_THRESHOLDS, report)
    console.log(`Coverage merger input: ${stats.scripts} → ${stats.retainedScripts} scripts`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
