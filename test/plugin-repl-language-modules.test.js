import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertSameFilesystemEntry } from './filesystem-identity.js'
import { appendRunCodeEvents, fixture as pluginFixture, ptcAgent } from './plugin-fixture.js'

// These historical language contracts also govern replay of pre-v9 journals.
const fixture = (config = {}, ...args) => pluginFixture({ ...config, legacyBindingSettings: true }, ...args)

test('keeps REPL bindings isolated by session', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('session-a', 'const privateValue = 7')
  assert.deepEqual(await state.run('session-a', 'return privateValue'), { logs: [], value: 7 })
  assert.deepEqual(await state.run('session-b', 'return typeof privateValue'), { logs: [], value: 'undefined' })
})

test('retains dynamic imports without repeating their source', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const imported = await state.runDurable('session-a', 'const { basename } = await import("node:path")')
  assert.equal(imported.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(
    await state.run('session-a', 'return basename("C:/logs/session.jsonl.zstd")'),
    { logs: [], value: 'session.jsonl.zstd' },
  )
})

test('adapts static import declarations with provenance', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const code = [
    "import path from 'node:path'",
    "import { basename, dirname as parent } from 'node:path'",
    "import * as ns from 'node:path'",
    "import 'node:util'",
    "import type { Specifier } from 'node:module'",
    "import { type Options, resolve } from 'node:path'",
    "import path2, { basename as alt } from 'node:path'",
    "import { type Inline, dirname as parent2 } from 'node:path'",
    "return [path.basename('/a/b.txt'), basename('/a/c.txt'), parent('/a/d.txt'), ns.basename('/a/e.txt'), ns.basename(ns.resolve('/a', 'f.txt')), alt('/a/g.txt'), parent2('/a/h.txt')]",
  ].join('\n')
  const result = await state.runDurable('import-rewrite-shapes', code, {}, { session: { events: [] } })
  assert.deepEqual(result.value, ['b.txt', 'c.txt', '/a', 'e.txt', 'f.txt', 'g.txt', '/a'])
  assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  assert.match(result.meta.dshPtcPlus.volatileReason, /module node:path/)
  const rewrites = result.meta.dshPtcPlusRewrites
  assert.equal(rewrites.length, 8)
  for (const rewrite of rewrites) {
    assert.equal(rewrite.kind, 'import')
    assert.match(rewrite.description, /import/)
  }
  assert.equal(rewrites[0].source, 'node:path')
  assert.equal(rewrites[4].source, 'node:module')
  assert.match(rewrites[4].description, /type-only/)
})

test('initializes static import captures before every executable cell statement', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const beforeDeclaration = await state.run('import-hoist', [
    "const before = basename('/a/b.txt')",
    "import { basename } from 'node:path'",
    'return before',
  ].join('\n'))
  assert.equal(beforeDeclaration.value, 'b.txt')

  const beforeReturn = await state.run(
    'import-hoist',
    "return 'early'; import { dirname } from 'node:path'",
  )
  assert.equal(beforeReturn.value, 'early')
  assert.deepEqual(await state.run('import-hoist', "return dirname('/a/b.txt')"), {
    logs: [],
    value: '/a',
  })

  const orderKey = '__ptc_static_preload_order__'
  const firstModule = 'data:text/javascript,' + encodeURIComponent([
    `globalThis.${orderKey} = []`,
    `globalThis.${orderKey}.push('first')`,
    "export const first = 'one'",
  ].join('\n'))
  const secondModule = 'data:text/javascript,' + encodeURIComponent([
    `globalThis.${orderKey}.push('second')`,
    `export const second = globalThis.${orderKey}.join(',')`,
    `delete globalThis.${orderKey}`,
  ].join('\n'))
  const ordered = await state.run('import-order', [
    'const beforeImports = first',
    `import { first } from ${JSON.stringify(firstModule)}`,
    `import { second } from ${JSON.stringify(secondModule)}`,
    'return [beforeImports, second]',
  ].join('\n'))
  assert.deepEqual(ordered.value, ['one', 'first,second'])

  const failingSource = [
    "const adjacent = mappedBasename('/a/b.txt')",
    "import { basename as mappedBasename } from 'node:path'",
    'throw new Error("mapped failure")',
  ].join('\n')
  const failed = await state.runDurable('import-hoist-position', failingSource)
  assert.equal(failed.isError, true)
  assert.deepEqual(failed.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current',
    start: { line: 3, column: 7 },
  })
})

test('keeps user bindings that resemble private import namespaces intact', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('private-before-import', 'let __dsh_ptc_import_namespace_0__ = 99')
  const imported = await state.run(
    'private-before-import',
    "import { basename } from 'node:path'; return basename('/a/b.txt')",
  )
  assert.equal(imported.value, 'b.txt')
  assert.deepEqual(await state.run(
    'private-before-import',
    'return __dsh_ptc_import_namespace_0__',
  ), { logs: [], value: 99 })
})

test('keeps static import capture outside lexical globalThis shadowing', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const sameCell = await state.run('shadowed-global-this', [
    "import { inspect } from 'node:util'",
    "const globalThis = { marker: 'same-cell' }",
    'return [typeof inspect, globalThis.marker]',
  ].join('\n'))
  assert.deepEqual(sameCell.value, ['function', 'same-cell'])

  const laterCell = await state.run('shadowed-global-this', [
    "import { dirname } from 'node:path'",
    "return [dirname('/a/b'), globalThis.marker]",
  ].join('\n'))
  assert.deepEqual(laterCell.value, ['/a', 'same-cell'])
})

test('keeps return control outside user name resolution', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const intercepted = await state.run('with-return-control', [
    'const scope = new Proxy({ answer: 42 }, {',
    "  has: (_, name) => name !== 'globalThis',",
    "  get: (target, name) => name in target ? target[name] : class InterceptedReturn {},",
    '})',
    'with (scope) {',
    '  try { return answer } catch { throw new Error(\'return control was intercepted\') }',
    '}',
  ].join('\n'))
  assert.deepEqual(intercepted, { logs: [], value: 42 })

  assert.deepEqual(await state.run('shadowed-return-control', [
    "'use strict'",
    "const globalThis = { marker: 'lexical' }",
    'return globalThis.marker',
  ].join('\n')), { logs: [], value: 'lexical' })

  assert.deepEqual(await state.run('return-signal-cleanup', 'return 1'), { logs: [], value: 1 })
  assert.deepEqual(await state.run('return-signal-cleanup', [
    'const __dsh_ptc_return_signal_0__ = 0',
    'return [',
    "  Object.hasOwn(globalThis, '__dsh_ptc_return_signal_0__'),",
    '  __dsh_ptc_return_signal_0__,',
    ']',
  ].join('\n')), { logs: [], value: [false, 0] })
  assert.deepEqual(await state.run('with-return-control', 'return 7'), { logs: [], value: 7 })
})

test('preserves live and read-only imported bindings across REPL cells', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const moduleSource = 'data:text/javascript,' + encodeURIComponent([
    'export let value = 0',
    'export function inc() { value++ }',
    'export function receiver() { return this }',
    'export const absent = null',
  ].join('\n'))

  assert.deepEqual(await state.run('live-imports', [
    `import { value, inc, receiver, absent } from ${JSON.stringify(moduleSource)}`,
    'const importedClosure = () => value',
    'inc()',
    "return [value, importedClosure(), typeof receiver(), absent?.() ?? 'short-circuited']",
  ].join('\n')), { logs: [], value: [1, 1, 'undefined', 'short-circuited'], rewrites: [{
    kind: 'import',
    description: `adapted the static import of ${JSON.stringify(moduleSource)} for REPL execution`,
    source: moduleSource,
  }] })

  assert.deepEqual(await state.run('live-imports', [
    'let assignmentError',
    'try { value = value + 2 } catch (error) { assignmentError = error.name }',
    'function shadow(value) { return value }',
    'return [assignmentError, value, importedClosure(), shadow(9)]',
  ].join('\n')), { logs: [], value: ['TypeError', 1, 1, 9] })

  assert.deepEqual(await state.run('live-imports', 'let value = 9\nreturn [value, importedClosure()]'), {
    logs: [], value: [9, 1],
  })
  assert.deepEqual(await state.run('live-imports', 'return value'), { logs: [], value: 9 })

  const secondModule = 'data:text/javascript,' + encodeURIComponent('export const other = 2')
  assert.deepEqual(await state.run('live-imports', [
    `import { other } from ${JSON.stringify(secondModule)}`,
    'return [other, importedClosure()]',
  ].join('\n')), {
    logs: [],
    value: [2, 1],
    rewrites: [{
      kind: 'import',
      description: `adapted the static import of ${JSON.stringify(secondModule)} for REPL execution`,
      source: secondModule,
    }],
  })

  const privateCollision = await state.run(
    'live-imports',
    'let __dsh_ptc_import_namespace_0__ = { value: 99 }',
  )
  assert.equal(privateCollision.error.kind, 'exception')
  assert.match(privateCollision.error.message, /top-level bindings already exist/)
  assert.deepEqual(await state.run('live-imports', 'return importedClosure()'), { logs: [], value: 1 })
})

test('rejects same-cell import collisions before module preload', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const marker = '__ptc_same_cell_import_effect__'
  const moduleSource = 'data:text/javascript,' + encodeURIComponent([
    `globalThis.${marker} = (globalThis.${marker} ?? 0) + 1`,
    'export const value = 1',
  ].join('\n'))
  const collision = await state.runDurable('same-cell-import-collision', [
    `import { value } from ${JSON.stringify(moduleSource)}`,
    'const value = 2',
    'return value',
  ].join('\n'))
  assert.equal(collision.isError, true)
  assert.equal(collision.meta.dshPtcPlus.status, 'noop')
  assert.match(collision.error.message, /Duplicate declaration "value"/)
  assert.deepEqual(await state.run(
    'same-cell-import-collision', `return globalThis.${marker} ?? 0`,
  ), { logs: [], value: 0 })
})

test('loads static modules before compiling the cell body', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const failingModule = 'data:text/javascript,' + encodeURIComponent('export default 1; throw new Error("module failed")')
  const source = `const bodyBinding = 1; import failed from ${JSON.stringify(failingModule)}`
  const failed = await state.runDurable('static-import-failure', source)
  assert.equal(failed.isError, true)
  assert.match(failed.error.message, /module failed/)
  assert.deepEqual(failed.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current',
    start: { line: 1, column: source.indexOf(JSON.stringify(failingModule)) + 1 },
  })
  assert.deepEqual(await state.run('static-import-failure', 'const bodyBinding = 2; const failed = 3; return [bodyBinding, failed]'), {
    logs: [], value: [2, 3],
  })
})

test('resolves static and dynamic imports from the session project with Node ESM conditions', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-modules-'))
  const packageDirectory = join(project, 'node_modules', 'ptc-esm-fixture')
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(join(project, 'data.json'), JSON.stringify({ answer: 42 }))
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'ptc-esm-fixture',
    type: 'module',
    exports: { import: './import.js', require: './require.cjs' },
  }))
  await writeFile(join(packageDirectory, 'import.js'), 'export default 41; export const condition = "import"')
  await writeFile(join(packageDirectory, 'require.cjs'), 'module.exports = { default: 0, condition: "require" }')

  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('project-imports', [
    "import data from './data.json' with { type: 'json' }",
    "import packageValue, { condition } from 'ptc-esm-fixture'",
    "const dynamicData = await import('./data.json', { with: { type: 'json' } })",
    "const dynamicPackage = await import('ptc-esm-fixture')",
    'return [data.answer, dynamicData.default.answer, packageValue, condition, dynamicPackage.condition]',
  ].join('\n'), {}, { session })
  assert.deepEqual(result, {
    logs: [],
    value: [42, 42, 41, 'import', 'import'],
    rewrites: [
      { kind: 'import', description: 'adapted the static import of "./data.json" for REPL execution', source: './data.json' },
      { kind: 'import', description: 'adapted the static import of "ptc-esm-fixture" for REPL execution', source: 'ptc-esm-fixture' },
    ],
  })
})

test('uses the process project as the import base when session cwd is absent', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.run('default-import-base', [
    "import manifest from './package.json' with { type: 'json' }",
    "const dynamicManifest = await import('./package.json', { with: { type: 'json' } })",
    'return [manifest.name, dynamicManifest.default.name]',
  ].join('\n'))
  assert.deepEqual(result.value, ['dsh-ptc-plus', 'dsh-ptc-plus'])
})

test('virtualizes CommonJS and ESM filesystem paths against the session cwd', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-fs-cwd-'))
  await writeFile(join(project, 'value.txt'), 'session-value')
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('filesystem-cwd', [
    "const commonJs = require('node:fs').readFileSync('value.txt', 'utf8')",
    "const defaultFs = (await import('node:fs')).default",
    "const defaultEsm = defaultFs.readFileSync('value.txt', 'utf8')",
    "const { readFileSync } = await import('node:fs')",
    "const namedEsm = readFileSync('value.txt', 'utf8')",
    "const { mkdtemp } = await import('node:fs/promises')",
    "const created = await mkdtemp('relative-entry-')",
    "const createdFromFs = require('node:fs').existsSync(created)",
    "const { glob } = await import('node:fs/promises')",
    'const matches = []',
    "for await (const match of glob('*.txt')) matches.push(match)",
    'return [commonJs, defaultEsm, namedEsm, created, createdFromFs, matches]',
  ].join('\n'), {}, { session })
  assert.deepEqual(result.value.slice(0, 3), ['session-value', 'session-value', 'session-value'])
  assert.equal(result.value[3].startsWith(project), true)
  assert.equal(result.value[4], true)
  assert.deepEqual(result.value[5], ['value.txt'])
})

test('preserves mkdtemp prefix semantics under the session cwd', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-mkdtemp-cwd-'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('mkdtemp-prefix-cwd', [
    "const fs = require('node:fs')",
    "const fsp = require('node:fs/promises')",
    "const path = require('node:path')",
    "const { pathToFileURL } = require('node:url')",
    'const made = []',
    "made.push(['sync-empty', fs.mkdtempSync('')])",
    "made.push(['callback-dot', await new Promise((resolve, reject) => fs.mkdtemp('.', (error, value) => error ? reject(error) : resolve(value)))])",
    "made.push(['promise-named', await fsp.mkdtemp('promise-')])",
    "made.push(['sync-buffer', fs.mkdtempSync(Buffer.from('buffer-'))])",
    "made.push(['sync-absolute', fs.mkdtempSync(path.join(process.cwd(), 'absolute-'))])",
    "made.push(['sync-url', fs.mkdtempSync(pathToFileURL(path.join(process.cwd(), 'url-')))])",
    "if (process.platform === 'win32') {",
    "  const drive = path.parse(process.cwd()).root.slice(0, 2)",
    "  made.push(['sync-drive', fs.mkdtempSync(`${drive}sync-drive-`)])",
    "  made.push(['callback-drive', await new Promise((resolve, reject) => fs.mkdtemp(`${drive}callback-drive-`, (error, value) => error ? reject(error) : resolve(value)))])",
    "  made.push(['promise-drive', await fsp.mkdtemp(`${drive}promise-drive-`)])",
    '}',
    "if (typeof fs.mkdtempDisposableSync === 'function') {",
    "  const value = fs.mkdtempDisposableSync('.')",
    "  made.push(['sync-disposable-dot', value.path])",
    "  if (process.platform === 'win32') {",
    "    const drive = path.parse(process.cwd()).root.slice(0, 2)",
    "    const driveValue = fs.mkdtempDisposableSync(`${drive}sync-disposable-drive-`)",
    "    made.push(['sync-disposable-drive', driveValue.path])",
    '  }',
    '}',
    "if (typeof fsp.mkdtempDisposable === 'function') {",
    "  const value = await fsp.mkdtempDisposable('disposable-')",
    "  made.push(['promise-disposable', value.path])",
    "  if (process.platform === 'win32') {",
    "    const drive = path.parse(process.cwd()).root.slice(0, 2)",
    "    const driveValue = await fsp.mkdtempDisposable(`${drive}promise-disposable-drive-`)",
    "    made.push(['promise-disposable-drive', driveValue.path])",
    '  }',
    '}',
    'const observed = made.map(([name, value]) => {',
    '  const text = Buffer.isBuffer(value) ? value.toString() : value',
    '  return [name, path.dirname(text), path.basename(text), fs.existsSync(text)]',
    '})',
    "for (const [, value] of made) fs.rmSync(value, { recursive: true, force: true })",
    'return observed',
  ].join('\n'), {}, { session })
  assert.equal(result.error, undefined)
  for (const [, parent, , exists] of result.value) {
    assert.deepEqual([parent, exists], [project, true])
  }
  assert.equal(result.value.find(([name]) => name === 'callback-dot')[2].startsWith('.'), true)
  assert.equal(result.value.find(([name]) => name === 'promise-named')[2].startsWith('promise-'), true)
  assert.equal(result.value.find(([name]) => name === 'sync-buffer')[2].startsWith('buffer-'), true)
  assert.equal(result.value.find(([name]) => name === 'sync-absolute')[2].startsWith('absolute-'), true)
  assert.equal(result.value.find(([name]) => name === 'sync-url')[2].startsWith('url-'), true)
  for (const [name, , basename] of result.value.filter(([name]) => name.endsWith('-drive'))) {
    assert.equal(basename.startsWith(`${name}-`), true)
  }
})

test('preserves native path.resolve semantics under a session cwd', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-resolve-cwd-'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('path-resolve-cwd', [
    "const path = await import('node:path')",
    `return [path.resolve(), path.resolve('nested', 'file.txt'), path.resolve(${JSON.stringify(project)}, 'child'), path.resolve('nested', ${JSON.stringify(project)}, 'child')]`,
  ].join('\n'), {}, { session })
  assert.deepEqual(result.value, [
    project,
    join(project, 'nested', 'file.txt'),
    join(project, 'child'),
    join(project, 'child'),
  ])
})

test('anchors path.resolve to the session cwd after process.cwd mutation', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-resolve-mutation-'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('path-resolve-cwd-mutation', [
    "const path = await import('node:path')",
    "process.cwd = () => '/tmp/assigned-worker-cwd'",
    "return { displayed: process.cwd(), resolved: path.resolve('child') }",
  ].join('\n'), {}, { session })
  assert.deepEqual(result.value, {
    displayed: project,
    resolved: join(project, 'child'),
  })
})

test('uses the session cwd for child processes while preserving explicit cwd', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-child-cwd-'))
  const explicit = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-child-explicit-'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
    await rm(explicit, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const source = [
    "const childProcess = await import('node:child_process')",
    "const source = 'process.stdout.write(process.cwd())'",
    "const execFileCwd = childProcess.execFileSync(process.execPath, ['-e', source], { encoding: 'utf8' })",
    "const execFileDefaultCwd = childProcess.execFileSync(process.execPath, ['-e', source]).toString()",
    "const spawnCwd = childProcess.spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' }).stdout",
    "const command = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(source)",
    "const execCwd = await new Promise((resolve, reject) => childProcess.exec(command, { encoding: 'utf8' }, (error, stdout) => error === null ? resolve(stdout) : reject(error)))",
    `const explicitCwd = childProcess.execFileSync(process.execPath, ['-e', source], { cwd: ${JSON.stringify(explicit)}, encoding: 'utf8' })`,
    'return { execFileCwd, execFileDefaultCwd, spawnCwd, execCwd, explicitCwd }',
  ].join('\n')
  const result = await state.run('child-process-cwd', source, {}, { session })
  assert.deepEqual(Object.keys(result.value), [
    'execFileCwd',
    'execFileDefaultCwd',
    'spawnCwd',
    'execCwd',
    'explicitCwd',
  ])
  for (const member of ['execFileCwd', 'execFileDefaultCwd', 'spawnCwd', 'execCwd']) {
    await assertSameFilesystemEntry(result.value[member], project)
  }
  await assertSameFilesystemEntry(result.value.explicitCwd, explicit)
})

test('keeps child-process cwd projection after an earlier intrinsic mutation', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-child-intrinsic-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const spawnSource = [
    "const childProcess = require('node:child_process')",
    "const source = 'process.stdout.write(process.cwd())'",
    "return childProcess.spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' }).stdout",
  ].join('\n')
  const execSource = [
    "const childProcess = require('node:child_process')",
    "const source = 'process.stdout.write(process.cwd())'",
    "const command = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(source)",
    'return await new Promise((resolve, reject) => childProcess.exec(command, (error, stdout) => error === null ? resolve(stdout) : reject(error)))',
  ].join('\n')
  const cases = [
    ['array-is-array', 'Array.isArray = null', spawnSource],
    ['reflect-apply', 'Reflect.apply = null', spawnSource],
    ['array-splice', 'Array.prototype.splice = null', execSource],
  ]

  for (const [name, mutation, source] of cases) {
    const state = fixture()
    const session = { events: [], header: { cwd: project } }
    try {
      assert.deepEqual(await state.run(`child-process-intrinsic-${name}`, [
        mutation,
        "return 'mutated'",
      ].join('\n'), {}, { session }), { logs: [], value: 'mutated' })
      const result = await state.run(`child-process-intrinsic-${name}`, source, {}, { session })
      assert.equal(result.error, undefined, name)
      await assertSameFilesystemEntry(result.value, project)
    } finally {
      await state.dispose()
    }
  }
})

test('keeps Buffer filesystem paths after earlier Buffer intrinsic mutations', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-buffer-intrinsic-'))
  await writeFile(join(project, 'value.txt'), 'session-value')
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }

  await state.run('buffer-path-intrinsic', [
    'Buffer.isBuffer = null',
    'Buffer.concat = null',
  ].join('\n'), {}, { session })
  const result = await state.run('buffer-path-intrinsic', [
    "const fs = require('node:fs')",
    "return fs.readFileSync(Buffer.from('value.txt'), 'utf8')",
  ].join('\n'), {}, { session })

  assert.deepEqual(result, { logs: [], value: 'session-value' })
})

test('keeps filesystem and path projection after iterator and regexp mutations', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-path-intrinsic-'))
  await writeFile(join(project, 'value.txt'), 'session-value')
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }

  await state.run('path-intrinsic', [
    'Array.prototype[Symbol.iterator] = null',
    'RegExp.prototype.test = null',
  ].join('\n'), {}, { session })
  const result = await state.run('path-intrinsic', [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const created = fs.mkdtempSync('.')",
    "const value = fs.readFileSync('value.txt', 'utf8')",
    "const resolved = path.resolve('nested')",
    'return { value, resolved }',
  ].join('\n'), {}, { session })

  assert.equal(result.error, undefined)
  assert.equal(result.value.value, 'session-value')
  assert.equal(result.value.resolved, join(project, 'nested'))
})

test('keeps glob callback projection after an earlier splice mutation', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-glob-intrinsic-'))
  await writeFile(join(project, 'value.txt'), 'session-value')
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }

  await state.run('glob-intrinsic', 'Array.prototype.splice = null', {}, { session })
  const result = await state.run('glob-intrinsic', [
    "const fs = require('node:fs')",
    "return await new Promise((resolve, reject) => fs.glob('*.txt', (error, matches) => error === null ? resolve(matches) : reject(error)))",
  ].join('\n'), {}, { session })

  assert.deepEqual(result, { logs: [], value: ['value.txt'] })
})

test('injects session cwd into execFile callback overloads', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-execfile-callback-'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('execfile-callback-cwd', [
    "const childProcess = await import('node:child_process')",
    "const source = 'process.stdout.write(process.cwd())'",
    "const observed = await new Promise((resolve, reject) => childProcess.execFile(process.execPath, ['-e', source], (error, stdout) => error === null ? resolve(stdout) : reject(error)))",
    'return observed',
  ].join('\n'), {}, { session })
  await assertSameFilesystemEntry(result.value, project)
})

test('preserves child-process promisify results while injecting the session cwd', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-promisify-child-'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('promisify-child-cwd', [
    "const childProcess = await import('node:child_process')",
    "const { promisify } = await import('node:util')",
    "const source = 'process.stdout.write(process.cwd())'",
    "const execFileResult = await promisify(childProcess.execFile)(process.execPath, ['-e', source])",
    "const command = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(source)",
    'const execResult = await promisify(childProcess.exec)(command)',
    "const failingSource = 'process.stdout.write(\"out\"); process.stderr.write(\"err\"); process.exitCode = 7'",
    'let execFileError, execError',
    "try { await promisify(childProcess.execFile)(process.execPath, ['-e', failingSource]) } catch (error) { execFileError = { code: error.code, stdout: error.stdout, stderr: error.stderr } }",
    "try { await promisify(childProcess.exec)(JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(failingSource)) } catch (error) { execError = { code: error.code, stdout: error.stdout, stderr: error.stderr } }",
    'return { execFileResult, execResult, execFileError, execError }',
  ].join('\n'), {}, { session })
  assert.deepEqual(Object.keys(result.value), [
    'execFileResult',
    'execResult',
    'execFileError',
    'execError',
  ])
  for (const member of ['execFileResult', 'execResult']) {
    assert.deepEqual(Object.keys(result.value[member]), ['stdout', 'stderr'])
  }
  assert.equal(result.value.execFileResult.stderr, '')
  assert.equal(result.value.execResult.stderr, '')
  await assertSameFilesystemEntry(result.value.execFileResult.stdout, project)
  await assertSameFilesystemEntry(result.value.execResult.stdout, project)
  assert.deepEqual({
    execFileError: result.value.execFileError,
    execError: result.value.execError,
  }, {
    execFileError: { code: 7, stdout: 'out', stderr: 'err' },
    execError: { code: 7, stdout: 'out', stderr: 'err' },
  })
})

test('projects session cwd through execFile and glob option overloads', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-cwd-overloads-'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  await writeFile(join(project, 'entry.txt'), 'value')
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('child-process-overload-cwd', [
    "const childProcess = await import('node:child_process')",
    "const fs = await import('node:fs')",
    'const child = childProcess.execFile(process.execPath)',
    "const alive = typeof child.pid === 'number'",
    'child.kill()',
    "const globbed = fs.globSync('*.txt', {})",
    'return { alive, globbed }',
  ].join('\n'), {}, { session })
  assert.equal(result.error, undefined)
  assert.equal(result.value.alive, true)
  assert.deepEqual(result.value.globbed, ['entry.txt'])
})
