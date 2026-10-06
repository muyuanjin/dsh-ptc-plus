import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'acorn'
import { npmCliCommand } from '../scripts/npm-cli.mjs'
import { clientTestPattern } from '../scripts/client-focused-tests.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('focused package entries reject missing selections before starting suites', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [name, message] of [
    ['test:backend:focus', /require --file/],
    ['test:client:layout:focus', /require --case/],
    ['test:client:fallback:focus', /require --case/],
    ['test:client:focus', /require one nonempty test-name pattern/],
  ]) {
    assert.ok(manifest.scripts[name])
    const command = npmCliCommand(['run', name])
    const result = spawnSync(command.executable, command.args, { cwd: root, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.error, undefined, `${name}: ${result.error}`)
    assert.equal(result.status, 1, `${name}: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout + result.stderr, message)
    assert.doesNotMatch(result.stdout, /Backend inventory:|Binding layout:|Fallback visual:|Test Files|RUN v/)
  }
})

test('Client focused selection rejects empty patterns instead of matching the entire suite', () => {
  for (const args of [[], [''], ['  '], ['one', 'two']]) {
    assert.throws(() => clientTestPattern(args), /require one nonempty/)
  }
  assert.equal(clientTestPattern(['^real case$']), '^real case$')
  assert.equal(clientTestPattern(['--file']), '--file')
})

test('fixture-only selection names exactly the two renderer export owners', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const source = await readFile(new URL('./client-runtime.spec.js', import.meta.url), 'utf8')
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const tests = program.body.filter(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression' && node.expression.callee.name === 'test')
    .map(node => ({ name: node.expression.arguments[0].value, body: source.slice(node.start, node.end) }))
  const owners = tests.filter(node => node.body.includes('PTC_BINDING_UI_FIXTURE')).map(node => node.name)
  const pattern = new RegExp(manifest.scripts['test:client:fixtures'].match(/--testNamePattern="(.*)"$/)[1])
  assert.equal(owners.length, 2)
  assert.deepEqual(tests.filter(node => pattern.test(node.name)).map(node => node.name), owners)
  const layout = await readFile(new URL('../scripts/client-binding-layout.mjs', import.meta.url), 'utf8')
  const full = await readFile(new URL('../scripts/client-visual-check.mjs', import.meta.url), 'utf8')
  assert.match(layout, /npmCliCommand\(\['run', 'test:client:fixtures'\]\)/)
  assert.match(full, /npmCliCommand\(\['run', 'test:client'\]\)/)
  assert.doesNotMatch(full, /test:client:fixtures|--focus|--case/)
})
