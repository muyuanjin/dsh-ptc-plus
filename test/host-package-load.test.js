import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * An installed host package that cannot initialise is a failure, not an absence.
 *
 * The resolver tries its candidate packages in order, so a missing package means
 * "ask the next candidate". A package that is present but throws is a different
 * fact: substituting another implementation would run this plugin against a host
 * surface nobody proved, and reporting "no package provides this" would hide the
 * real error from the operator.
 *
 * The failure has to come from the module's own import, so this file resolves the
 * candidate specifier to a throwing module before loading the module under test.
 * Nothing else in this process imports it first: the hook, the import and the
 * assertion are the whole point of keeping this probe in its own file.
 */
test('an installed host package that fails to initialise is reported, not skipped', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-host-load-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const broken = join(root, 'broken-host-package.mjs')
  await writeFile(broken, 'throw new Error("installed host package is not loadable")\n')
  const brokenUrl = pathToFileURL(broken).href
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === '@deepseek-ai/dsh-tools'
        ? { url: brokenUrl, shortCircuit: true }
        : next(specifier, context)
    },
  })
  t.after(() => hooks.deregister())
  await assert.rejects(() => import('../internal/host-tool-sdk.js'),
    /ptc-plus: host package @deepseek-ai\/dsh-tools failed to load: installed host package is not loadable/u)
})
