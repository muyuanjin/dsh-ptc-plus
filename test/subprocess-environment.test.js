import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { uncoveredEnvironment } from './subprocess-environment.js'

test('native fixture environments preserve unrelated fields and remove coverage case variants', () => {
  assert.deepEqual(uncoveredEnvironment({ Path: 'kept', NODE_V8_COVERAGE: 'first', Node_V8_Coverage: 'second' }),
    { Path: 'kept', NODE_V8_COVERAGE: '' })
})

test('native oracle workers omit dumps while project subprocesses retain coverage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-environment-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const helper = new URL('./subprocess-environment.js', import.meta.url).href
  const oracle = new URL('./native-boundary-worker-fixture.js', import.meta.url).href
  const implementation = new URL('../internal/failure-reporting.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict';
    import {Worker} from 'node:worker_threads';
    import {once} from 'node:events';
    import {spawnSync} from 'node:child_process';
    import {uncoveredEnvironment} from ${JSON.stringify(helper)};
    for(let i=0;i<3;i++){
      const worker=new Worker(new URL(${JSON.stringify(oracle)}),{
        workerData:{source:'return 42'},env:uncoveredEnvironment(),execArgv:[]
      });
      const [value]=await once(worker,'message');
      assert.equal(value.value,42);
      await worker.terminate();
    }
    const child=spawnSync(process.execPath,['--input-type=module','--eval',
      'await import('+JSON.stringify(${JSON.stringify(implementation)})+')'],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, NODE_V8_COVERAGE: directory }, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  const reports = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))))
  const scripts = reports.flatMap(report => report.result)
  assert.equal(reports.length, 2, 'native worker coverage was inherited')
  assert.ok(scripts.some(script => script.url === implementation), 'project child lost coverage')
  assert.ok(!scripts.some(script => script.url === oracle), 'native fixture emitted a dump')
})
