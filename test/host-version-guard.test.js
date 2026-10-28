import assert from 'node:assert/strict'
import test from 'node:test'
import { hostVersionLiteralViolations } from '../scripts/check-host-version-literals.mjs'

test('a host version compared with any spelling is a violation', () => {
  for (const line of [
    "if (dshVersion < '0.2.1') return legacy()",
    "if (hostVersion < '0.2.1') return legacy()",
    "const pinned = '@deepseek-ai/dsh-tool-executor-ptc@0.2.2-alpha.2'",
    "if (compare(version, '0.2.2-alpha.2') >= 0) enable()",
  ]) {
    assert.notDeepEqual(hostVersionLiteralViolations(line), [], line)
  }
})

test('a version that is not the host, or a comment, is not a violation', () => {
  for (const line of [
    "export const LEGACY_USER_BINDING_TRANSFORM = 'amaro@1.1.11'",
    "  // 0.2.2-alpha.2 will carry this shape",
    "import { describe } from './tool-executor.js'",
  ]) {
    assert.deepEqual(hostVersionLiteralViolations(line), [], line)
  }
})
