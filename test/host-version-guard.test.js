import assert from 'node:assert/strict'
import test from 'node:test'
import { hostVersionLiteralViolations, scanHostVersionLiterals } from '../scripts/check-host-version-literals.mjs'

test('a host version compared with any spelling is a violation', () => {
  for (const line of [
    "if (dshVersion < '0.2.1') return legacy()",
    "if (hostVersion < '0.2.1') return legacy()",
    "if (DSH_VERSION >= '0.2.2') enable()",
    "const pinned = '@deepseek-ai/dsh-tool-executor-ptc@0.2.2-alpha.2'",
    "if (dsh >= '0.2.2-alpha.2') enable()",
    "if (hostEngine >= '0.2.1') enable()",
    "if (hostFloor <= '0.2.1') settleLegacy()",
    "const HOST_FLOOR = '0.2.1'",
    "if (dshPkg.version < '0.2.1') settleLegacy()",
    "if (ctx.tools?.hostVersionAtLeast?.('0.2.1')) enable()",
    // A pinned package specifier is how a version comparison is written, so the
    // specifier spelling may not buy the line an exemption.
    "if (specifier === '@deepseek-ai/dsh@0.2.1-rc.4') return legacy()",
    "const PINNED = new Set(['@deepseek-ai/dsh@0.2.1-rc.4'])",
    "const pinnedVersion = '@deepseek-ai/dsh@0.2.1-rc.4'.split('@')[2]",
    // A branch on the release prefix carries fewer components and decides exactly
    // as much as a full comparison does.
    "if (dshVersion.startsWith('0.2.')) enable()",
    "if (dshVersion >= '0.2') enable()",
    "const DSH_FLOOR = '0.2'",
  ]) {
    assert.notDeepEqual(hostVersionLiteralViolations(line), [], line)
  }
})

test('a version that belongs to something else is not a violation', () => {
  for (const line of [
    "export const LEGACY_USER_BINDING_TRANSFORM = 'amaro@1.1.11'",
    "if (nodeEngine >= '24.9.0') requireNode()",
    "if (compare(amaroVersion, '1.1.11') >= 0) migrate()",
    "if (semver.satisfies(amaroVersion, '1.1.11')) migrate()",
    "if (hostname === '0.2.1') report()",
    "  // 0.2.2-alpha.2 will carry this shape",
    "import { describe } from './tool-executor.js'",
    // `ghost` contains `host` and a stylesheet beside a 0.5px border is not a
    // host-version claim.
    "const style = '.ptcPlusButton[data-kind=ghost]{border:0.5px solid transparent}'",
    "  const ratio = Math.round(0.5 * total)",
  ]) {
    assert.deepEqual(hostVersionLiteralViolations(line), [], line)
  }
})

test('importing the guard does not scan the checkout as a side effect', () => {
  // A unit test must fail for its own reasons; a scan at import time would set
  // process.exitCode from an unrelated file.
  assert.equal(process.exitCode, undefined)
  assert.deepEqual(scanHostVersionLiterals(process.cwd()), [])
})
