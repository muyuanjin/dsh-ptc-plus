import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveHostExport } from '../internal/host-tool-sdk.js'

test('a candidate package that is not installed is absence, and the next candidate answers', async () => {
  // "Cannot find package 'x'" states that x is not installed, which is the one load failure
  // that lets the caller try the next candidate; every other failure stays loud.
  const absent = '@ptc-plus/host-package-that-is-not-installed'
  const resolved = await resolveHostExport([absent, '@deepseek-ai/dsh-tools'], 'the tool registry error classes',
    candidate => typeof candidate.ToolNotFoundError === 'function')
  assert.equal(resolved.specifier, '@deepseek-ai/dsh-tools', 'the installed candidate answers the resolution')
  // Absence is remembered as absence, so a later resolution skips the missing package
  // instead of importing it again, and reports what no package provided.
  await assert.rejects(resolveHostExport([absent], 'the tool schema renderers', () => true),
    /ptc-plus: no host package provides the tool schema renderers/u)
})
