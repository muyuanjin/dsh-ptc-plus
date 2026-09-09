import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readRuntimeMessage } from '../internal/runtime-messages.js'
import { fixture, ptcAgent } from './plugin-fixture.js'

const codeOnlyAssembly = state => ({
  sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
  contexts: [],
  variables: {},
  tools: [state.runCodeDefinition],
})

async function writeBindingsDocument(home, value) {
  const directory = join(home, 'ptc-plus')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'bindings.json'), `${JSON.stringify(value, null, 2)}\n`)
}

function configuredBindingPrompt(assembly) {
  return assembly.ptcContexts.find(item => item.name === 'tools:ptc-plus-user-binding-defaults')?.text ?? ''
}

// The module records its own evaluation from inside the worker realm, so the
// observation does not depend on any host binding supplied by a cell.
async function evaluationCount(log) {
  try {
    return (await readFile(log, 'utf8')).split('\n').filter(line => line.length > 0).length
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}

function evaluationWitness(log) {
  return {
    id: 'witness',
    name: 'evaluationWitness',
    scope: 'namespace',
    purpose: '',
    enabled: true,
    modelContext: { includeDeclaration: false, instructions: '' },
    source: `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, "evaluated\\n")\nexport const value = 7`,
  }
}

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-observability-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  return home
}

test('assembly leaves a configured module unevaluated while the same witness records an on-demand evaluation', async (t) => {
  const home = await withHome(t)
  const evaluationLog = join(home, 'binding-evaluations.log')
  const witness = evaluationWitness(evaluationLog)
  const documented = {
    id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text files.', enabled: true,
    source: 'export function readText(path: string): Promise<string> { return path }',
    modelContext: { includeDeclaration: true, instructions: 'Use fileTools.readText(path) for text.' },
  }
  await writeBindingsDocument(home, { entries: [documented, witness] })
  let rpc
  const state = fixture({ userBindingsEnabled: true }, { bindingRpc: handler => { rpc = handler } })
  t.after(() => state.dispose())
  const session = { id: 'prompt-observability', events: [] }
  const agent = ptcAgent(session.id, session)

  const assembly = await state.assembleStep(codeOnlyAssembly(state), {
    agent,
    scope: agent,
    signal: new AbortController().signal,
  })
  const prompt = configuredBindingPrompt(assembly)
  assert.match(prompt, /declare const fileTools/)
  assert.doesNotMatch(prompt, /evaluationWitness/)
  assert.equal(await evaluationCount(evaluationLog), 0)

  // Control: the plugin's own candidate evaluator runs the identical source, so a
  // module evaluation during the pre-cell window is observable to this witness.
  const probe = await rpc('run', { source: witness.source }, new AbortController().signal)
  assert.equal(probe.ok, true)
  assert.deepEqual(probe.value.value.symbols, ['value'])
  assert.equal(await evaluationCount(evaluationLog), 1)
  assert.equal(await readFile(evaluationLog, 'utf8'), 'evaluated\n')

  // Assembly repeated after an observed evaluation stays a non-evaluating read.
  const repeated = await state.assembleStep(codeOnlyAssembly(state), {
    agent,
    scope: agent,
    signal: new AbortController().signal,
  })
  assert.equal(configuredBindingPrompt(repeated), configuredBindingPrompt(assembly))
  assert.equal(await evaluationCount(evaluationLog), 1)
})

test('the binding catalog carries configuration only, with no recovery, notice, or diagnostic framing', async (t) => {
  const home = await withHome(t)
  const entry = {
    id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text files.', enabled: true,
    source: 'export const secret = "private-1"; export function readText(path: string): Promise<string> { return path }',
    modelContext: { includeDeclaration: true, instructions: 'Use fileTools.readText(path) for text.' },
  }
  const broken = { ...entry, id: 'broken', name: 'brokenTools',
    source: 'throw new Error("initializer failed"); export const value = 3',
    modelContext: { includeDeclaration: true, instructions: '' } }
  await writeBindingsDocument(home, { entries: [
    entry,
    broken,
    { ...entry, id: 'hidden', name: 'quietTools', modelContext: { includeDeclaration: false, instructions: '' } },
    { ...entry, id: 'disabled', name: 'disabledTools', enabled: false, modelContext: {} },
  ] })
  const state = fixture({ userBindingsEnabled: true })
  t.after(() => state.dispose())
  const session = { id: 'catalog-shape', events: [] }
  const agent = ptcAgent(session.id, session)

  const assembly = await state.assembleStep(codeOnlyAssembly(state), {
    agent,
    scope: agent,
    signal: new AbortController().signal,
  })
  const records = assembly.messages.map(message => readRuntimeMessage(message)).filter(Boolean)
  assert.deepEqual(records.map(record => record.form), ['catalog'])
  const [catalog] = records
  assert.deepEqual(catalog.sections.map(section => section.name), ['tools:ptc-plus-user-binding-defaults'])
  // The catalog is one literal configuration document: the delivered body is exactly
  // the configured declaration text, not a recovery snapshot or a diagnostic.
  const body = catalog.sections[0].text
  assert.equal(body, configuredBindingPrompt(assembly))
  assert.match(body, /declare const fileTools/)
  assert.match(body, /Use fileTools\.readText\(path\)/)
  assert.match(body, /brokenTools/)
  assert.doesNotMatch(body, /quietTools|disabledTools|evaluationWitness/)
  assert.doesNotMatch(body, /private-1|tools\.observe|initializer failed/)
  assert.doesNotMatch(body, /PTC Plus recovery status|error\[PTC-|^help: |^phase: |^state: /m)
  assert.equal(assembly.sections.some(section => section.name === 'tools:ptc-plus-user-binding-defaults'), false)
  assert.equal(assembly.contexts.some(item => item.name === 'tools:ptc-plus-user-bindings'), false)
  assert.equal(assembly.ptcContexts.filter(item => item.name === 'tools:ptc-plus-user-binding-defaults').length, 1)
})
