import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { SessionRuntime } from '../internal/session-runtime.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'

const statements = Array.from({ length: 1200 }, (_, index) => `total+=step(${index % 11});`).join('\n')
const source = `
let value=3;
const read=()=>value;
function step(value){return value+1}
class Base { read(){return this.amount} }
class Box extends Base {
  #offset=2;
  constructor(amount){super();this.amount=amount}
  read(){return super.read()+this.#offset}
}
async function* values(){yield await Promise.resolve(read())}
async function run(){
  let total=0;
  const original=read;
  const receiver={value:7,read(){return this.value}};
  ${statements}
  const saved=[];
  outer: for(let index=0;index<3;index++){
    saved.push(()=>index);
    switch(index){case 1:continue outer;default:total+=receiver?.read()}
  }
  try { total+=new Box(4).read() } finally { value+=2 }
  return [total,saved.map(fn=>fn()),original===read,read(),
    (await values().next()).value,receiver.read.toString(),run.toString()];
}
`

for (const extension of ['cjs', 'mjs']) for (const lexicalDynamic of [false, true]) test(`source regions preserve scopes, effects and callable ownership (${extension}, eval=${lexicalDynamic})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-source-regions-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const input = lexicalDynamic ? source.replace('const saved=[];', 'eval("total+=value");const saved=[];') : source
  await writeFile(join(directory, `source.${extension}`), input
    + (extension === 'cjs' ? '\nmodule.exports={run}' : '\nexport {run}'))
  const native = JSON.parse(JSON.stringify(await runInNewContext(input + '\nrun()')))
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const session = orderedSurfaceSession(`source-regions-${extension}`)
  session.header = { cwd: directory }
  const result = await runRecordedCell(runtime, session, 'load-dependency', { bindings: [], program:
    `const dependency=${extension === 'cjs' ? 'require("./source.cjs")' : 'await import("./source.mjs")'};return await dependency.run()` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, native)
  const next = await runRecordedCell(runtime, session, 'reuse-dependency', {
    bindings: [], program: 'return (await dependency.run()).slice(2,5)',
  })
  assert.equal(next.error, undefined, next.error?.message)
  assert.deepEqual(next.value, [true, 7, 7])
})
