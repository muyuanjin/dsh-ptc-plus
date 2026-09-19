import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { coverageInputFilter } from '../scripts/coverage-inputs.mjs'
import {
  COVERAGE_INCLUDE,
  COVERAGE_THRESHOLDS,
  coverageReportArguments,
  createCoverageReport,
} from '../scripts/coverage-report.mjs'
import { uncoveredEnvironment } from './subprocess-environment.js'

async function fixture(t) {
  // c8 keys coverage scripts by the real path, so the fixture root must be one
  // too; on macOS /var is a symlink to /private/var.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ptc-coverage-map-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'internal'))
  await mkdir(join(root, 'node_modules', 'dependency'), { recursive: true })
  const own = join(root, 'internal', 'example.js')
  const dependency = join(root, 'node_modules', 'dependency', 'index.js')
  const source = 'function example(value) { return value ? 1 : 2 }\nexample(true)\n'
  await writeFile(own, source)
  await writeFile(dependency, source)
  return { root, own, dependency, source }
}

test('focused report arguments select explicit sources', () => {
  assert.deepEqual(coverageReportArguments(['raw']), {
    directory: 'raw', include: COVERAGE_INCLUDE, focused: false,
  })
  assert.deepEqual(coverageReportArguments([
    'raw', '--include', 'internal/first.js', '--include', 'internal/second.js',
  ]), {
    directory: 'raw', include: ['internal/first.js', 'internal/second.js'], focused: true,
  })
  assert.throws(() => coverageReportArguments([]), /requires an evidence directory/)
  assert.throws(() => coverageReportArguments(['raw', '--include']), /requires a value/)
  assert.throws(() => coverageReportArguments(['raw', '--unknown']), /unknown coverage report argument/)
})

test('focused reports retain an unexecuted selected source as uncovered', async t => {
  const cwd = process.cwd()
  t.after(() => process.chdir(cwd))
  const { root } = await fixture(t)
  const directory = join(root, 'raw')
  const selected = join(root, 'internal', 'selected.js')
  await mkdir(directory)
  await writeFile(selected, 'export function selected(value) { return value ? 1 : 2 }\n')
  await writeFile(join(directory, 'worker.json'), JSON.stringify({ result: [] }))
  process.chdir(root)
  const { report } = createCoverageReport({
    root,
    directory,
    include: ['internal/selected.js'],
    includeUncovered: true,
    reporters: [],
  })
  const map = await report.getCoverageMapFromAllCoverageFiles()
  assert.deepEqual(map.files(), [selected])
  const summary = map.fileCoverageFor(selected).toSummary()
  assert.equal(summary.lines.pct, 0)
  assert.equal(summary.functions.pct, 0)
})

test('coverage input filtering retains mapped plugin code and leaves unproved maps to c8', async t => {
  const { root, own, dependency, source } = await fixture(t)
  const keep = coverageInputFilter(root)
  const record = filename => ({ url: pathToFileURL(filename).href })
  assert.equal(keep(record(own)), true)
  assert.equal(keep(record(dependency)), false)
  assert.equal(keep({ url: 'node:fs' }), false)
  assert.equal(keep({ url: 'evalmachine.<anonymous>' }), false)
  assert.equal(keep({ url: `${record(own).url}?node-test-mock=0` }), false)
  assert.equal(keep({ url: `${record(own).url}?variant=1` }), true)
  assert.equal(keep({ url: `${record(own).url}#fragment` }), true)
  const emitted = join(root, 'generated file.cjs')
  const map = { version: 3, sources: ['internal/example.js'], sourcesContent: [source], names: [], mappings: 'AAAA;AACA' }
  await writeFile(emitted, source + '\n//# sourceMappingURL=generated.map')
  await writeFile(join(root, 'generated.map'), JSON.stringify(map))
  assert.equal(keep(record(emitted)), true)
  const compiler = join(root, 'compiler-dependency.cjs')
  await writeFile(compiler, source + '\n//# sourceMappingURL=data:application/json;base64,'
    + Buffer.from(JSON.stringify({ ...map, sources: ['node_modules/dependency/index.js'] })).toString('base64'))
  assert.equal(keep(record(compiler)), false)
  // Per-report source maps override the cached disk decision for the same URL.
  assert.equal(keep(record(dependency), { [record(dependency).url]: { data: { ...map,
    sources: [relative(join(root, 'node_modules', 'dependency'), own)] } } }), true)
  assert.equal(keep(record(dependency), { [record(dependency).url]: { data: { sections: [] } } }), true)
  const broken = join(root, 'broken.js')
  await writeFile(broken, source + '\n//# sourceMappingURL=missing.map')
  assert.equal(keep(record(broken)), true)
})

test('filtered c8 maps and uncovered counters exactly match ordinary c8', async t => {
  const cwd = process.cwd()
  t.after(() => process.chdir(cwd))
  const { root, own, dependency, source } = await fixture(t)
  process.chdir(root)
  const directory = join(root, 'raw')
  await mkdir(directory)
  const emitted = join(root, 'compiler-core.cjs')
  const generated = source + source
  await writeFile(emitted, generated + '\n//# sourceMappingURL=compiler-core.cjs.map')
  await writeFile(emitted + '.map', JSON.stringify({
    version: 3, sources: ['internal/example.js', 'node_modules/dependency/index.js'],
    sourcesContent: [source, source], names: [], mappings: 'AAAA;AACA;ACDA;AACA',
  }))
  const record = (filename, text, count) => ({ url: pathToFileURL(filename).href, functions: [
    { functionName: '', ranges: [{ startOffset: 0, endOffset: text.length, count }], isBlockCoverage: true },
    { functionName: 'example', ranges: [{ startOffset: 0, endOffset: 46, count: 0 }], isBlockCoverage: true },
  ] })
  await writeFile(join(directory, 'worker.json'), JSON.stringify({ result: [
    record(own, source, 1), record(dependency, source, 1), record(emitted, generated, 1),
    { url: 'node:fs', functions: [] },
  ] }))
  const raw = await readFile(join(directory, 'worker.json'))
  const ordinary = createCoverageReport({ root, directory, filter: false, reporters: [] })
  const filtered = createCoverageReport({ root, directory, reporters: [] })
  const expected = await ordinary.report.getCoverageMapFromAllCoverageFiles()
  const actual = await filtered.report.getCoverageMapFromAllCoverageFiles()
  assert.deepEqual(actual.toJSON(), expected.toJSON())
  assert.deepEqual(actual.files(), [own])
  assert.ok(actual.getCoverageSummary().functions.pct < 100, 'uncovered functions disappeared')
  assert.ok(filtered.stats.retainedScripts < filtered.stats.scripts)
  assert.deepEqual(await readFile(join(directory, 'worker.json')), raw, 'filter rewrote V8 evidence')
  assert.deepEqual(COVERAGE_THRESHOLDS, { lines: 100, branches: 95, functions: 100, statements: 0 })
  const gate = spawnSync(process.execPath,
    [fileURLToPath(new URL('../scripts/coverage-report.mjs', import.meta.url)), directory], {
      cwd: root, env: uncoveredEnvironment(), encoding: 'utf8', timeout: 10000,
    })
  assert.equal(gate.status, 1, gate.stdout + gate.stderr)
  assert.match(gate.stderr, /Coverage for functions .* does not meet global threshold \(100%\)/)
})

test('drops Node test mock aliases before they pollute the real source map', async t => {
  const cwd = process.cwd()
  t.after(() => process.chdir(cwd))
  const { root, own, source } = await fixture(t)
  process.chdir(root)
  const directory = join(root, 'raw')
  await mkdir(directory)
  const real = {
    url: pathToFileURL(own).href,
    functions: [
      { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }], isBlockCoverage: true },
      { functionName: 'called', ranges: [{ startOffset: 0, endOffset: 10, count: 1 }], isBlockCoverage: true },
      { functionName: 'uncalled', ranges: [{ startOffset: 10, endOffset: Math.min(20, source.length), count: 0 }], isBlockCoverage: true },
    ],
  }
  const mock = {
    url: `${pathToFileURL(own).href}?node-test-mock=0`,
    functions: [
      { functionName: '', ranges: [{ startOffset: 0, endOffset: 4, count: 1 }], isBlockCoverage: true },
      { functionName: 'mock', ranges: [{ startOffset: 0, endOffset: 4, count: 0 }], isBlockCoverage: true },
    ],
  }
  await writeFile(join(directory, 'worker.json'), JSON.stringify({ result: [real, mock] }))
  const { report } = createCoverageReport({ root, directory, reporters: [] })
  const map = await report.getCoverageMapFromAllCoverageFiles()
  assert.deepEqual(map.files(), [own])
  assert.equal(map.getCoverageSummary().lines.pct, 100)
  const counters = Object.values(map.fileCoverageFor(own).data.f)
  assert.ok(counters.includes(1), 'the executed real function must stay counted as covered')
  assert.ok(counters.includes(0), 'the unexecuted real function must stay counted as uncovered')
})
