import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createUserModuleCompilationHooks } from '../internal/stateful-module-compiler.js'
import { managedModuleImport } from '../internal/stateful-module-runtime.js'
import { fixture } from './plugin-fixture.js'

test('type-member imports have no runtime dependencies in either cell policy', async t => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const result = await state.run(`type-import-${bindingUpdates}`, `
      import { type Missing, type Other as Alias } from 'ptc-nonexistent-type-only-module';
      import { type Missing } from 'data:text/javascript,throw new Error("type import executed")';
      import { type Missing, basename } from 'node:path';
      return basename('/a/value');
    `)
    assert.equal(result.error, undefined)
    assert.equal(result.value, 'value')
  }
})

test('module type erasure preserves explicit empty and mixed value imports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-type-imports-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sources = {
    'consumer.mjs': `
      import { type Missing } from './missing.mjs';
      import { type Missing } from './type.mjs';
      import {} from './empty.mjs';
      import { type Missing, value } from './mixed.mjs';
      import fallback, { type Missing } from './default.mjs';
      export const answer=value+fallback;
    `,
    'type.mjs': 'throw new Error("type-only dependency evaluated")',
    'empty.mjs': 'globalThis.__ptcEmptyImportEffects=(globalThis.__ptcEmptyImportEffects??0)+1',
    'mixed.mjs': 'export const value=40',
    'default.mjs': 'export default 2',
  }
  t.after(() => { delete globalThis.__ptcEmptyImportEffects })
  await Promise.all(Object.entries(sources).map(([name, source]) => writeFile(join(directory, name), source)))
  const url = pathToFileURL(join(directory, 'consumer.mjs')).href
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(url)
  const hooks = registerHooks(compilation)
  t.after(() => hooks.deregister())
  const module = await managedModuleImport(url, url)
  assert.equal(module.answer, 42)
  assert.equal(globalThis.__ptcEmptyImportEffects, 1)
})
