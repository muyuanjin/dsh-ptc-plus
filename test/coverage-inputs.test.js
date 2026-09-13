import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { coverageInputFilter } from '../scripts/coverage-inputs.mjs'
import { COVERAGE_THRESHOLDS, createCoverageReport } from '../scripts/coverage-report.mjs'
import { uncoveredEnvironment } from './subprocess-environment.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ptc-coverage-map-'))
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

test('coverage input filtering retains mapped plugin code and leaves unproved maps to c8', async t => {
  const { root, own, dependency, source } = await fixture(t)
  const keep = coverageInputFilter(root)
  const record = filename => ({ url: pathToFileURL(filename).href })
  assert.equal(keep(record(own)), true)
  assert.equal(keep(record(dependency)), false)
  assert.equal(keep({ url: 'node:fs' }), false)
  assert.equal(keep({ url: 'evalmachine.<anonymous>' }), false)
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
