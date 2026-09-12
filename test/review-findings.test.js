import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ACTIVE_LEDGER,
  TEMPLATE_PATH,
  checkReviewLedger,
  createReviewLedger,
  gateReviewLedger,
  installHook,
  parseReviewLedger,
  preCommitReviewLedger,
  recordReviewVerdict,
  indexTreeFingerprint,
  sourceTreeFingerprint,
  validateReviewLedger,
  verificationCommand,
} from '../scripts/review-findings.mjs'
import { writeRawFilenameFixture } from './raw-filename-fixture.js'

const templateText = await readFile(TEMPLATE_PATH, 'utf8')

function ledger(overrides = {}) {
  const finding = {
    id: 'F001',
    severity: 'P1',
    status: 'unresolved',
    dispositionRef: null,
    owner: 'internal/runtime.js',
    condition: 'Calling the documented boundary reproduces the failure.',
    impact: 'The runtime returns an incorrect canonical value.',
    requiredOutcome: 'The runtime preserves the documented value.',
    implementationPlan: null,
    resolutionEvidence: null,
    ...overrides.finding,
  }
  return `---
schema: dsh-review-findings/v3
ledgerStatus: ${overrides.ledgerStatus ?? 'open'}
findings:
${Object.entries(finding).map(([key, value]) => `  - ${key}: ${value === null ? '' : JSON.stringify(value)}`).join('\n').replace(/\n  - /g, '\n    ')}
---
# Review Findings
`
}

function resolvedLedger() {
  return ledger({
    ledgerStatus: 'resolved',
    finding: {
      status: 'resolved',
      implementationPlan: 'Correct the runtime owner and verify the resulting invariant.',
      resolutionEvidence: 'The focused regression and deterministic verification pass.',
    },
  })
}

async function repository(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

async function committedRepository(t, prefix) {
  const root = await repository(t, prefix)
  await writeFile(path.join(root, 'base.txt'), 'base\n')
  execFileSync('git', ['add', 'base.txt'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })
  return root
}

function headOf(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

async function recordCleanVerdict(root, fingerprint = sourceTreeFingerprint) {
  const report = path.join(root, '.git', 'review-report.txt')
  await writeFile(report, 'the frozen candidate has no findings\nVERDICT: NO FINDINGS\n')
  return recordReviewVerdict(root, {
    base: headOf(root),
    expectHead: headOf(root),
    evidence: report,
    expectFingerprint: await fingerprint(root),
    fingerprint: () => fingerprint(root),
  })
}

function usesWindowsGitPathSemantics(root) {
  const execPath = execFileSync('git', ['--exec-path'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  return /^[A-Za-z]:[\\/]/.test(execPath) || execPath.startsWith('\\\\')
}

function gitConfigValue(root, key) {
  try {
    return execFileSync('git', ['config', '--bool', '--get', key], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  } catch (error) {
    if (error.status === 1) return undefined
    throw error
  }
}

async function gitIndexBytes(root) {
  const index = execFileSync('git', ['rev-parse', '--git-path', 'index'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  return readFile(path.resolve(root, index))
}

test('uses the tracked review template as the ledger schema owner', () => {
  const parsedTemplate = parseReviewLedger(templateText, templateText, { template: true })
  assert.equal(parsedTemplate.schema, 'dsh-review-findings/v3')
  assert.equal(parsedTemplate.ledgerStatus, 'open')
  assert.equal(parsedTemplate.findings[0].status, 'unresolved')

  const open = parseReviewLedger(ledger(), templateText)
  assert.equal(open.allTerminal, false)
  assert.equal(open.findings[0].implementationPlan, null)
  assert.throws(
    () => parseReviewLedger(ledger({ finding: { implementationPlan: ' ' } }), templateText),
    /invalid implementationPlan/,
  )
  assert.throws(
    () => parseReviewLedger(ledger({ ledgerStatus: 'resolved' }), templateText),
    /still contains unresolved findings/,
  )
  assert.throws(
    () => parseReviewLedger(ledger({ finding: { owner: 'path/to/canonical-owner' } }), templateText),
    /template owner/,
  )
})

test('requires accepted findings to retain one durable disposition owner', async (t) => {
  assert.throws(
    () => parseReviewLedger(ledger({
      ledgerStatus: 'resolved',
      finding: { status: 'accepted', resolutionEvidence: 'The limitation is intentional.' },
    }), templateText),
    /requires dispositionRef/,
  )
  assert.throws(
    () => parseReviewLedger(ledger({ finding: { dispositionRef: 'docs/decision.md' } }), templateText),
    /has dispositionRef for status unresolved/,
  )

  const root = await repository(t, 'ptc-review-accepted-')
  const active = path.join(root, ACTIVE_LEDGER)
  const accepted = (dispositionRef) => ledger({
    ledgerStatus: 'resolved',
    finding: {
      status: 'accepted',
      dispositionRef,
      resolutionEvidence: 'The named owner records the accepted limitation.',
    },
  })
  await writeFile(active, accepted('https://example.test/issues/1'))
  assert.equal((await gateReviewLedger(root)).state, 'ready')

  await writeFile(active, accepted('docs/decision.md'))
  await assert.rejects(() => gateReviewLedger(root), /must name a tracked file or HTTPS issue/)
  await mkdir(path.join(root, 'docs'))
  await writeFile(path.join(root, 'docs/decision.md'), '# Decision\n')
  execFileSync('git', ['add', 'docs/decision.md'], { cwd: root })
  assert.equal((await gateReviewLedger(root)).state, 'ready')
})

test('validates open and resolved ledgers without applying readiness or archive', async (t) => {
  const root = await repository(t, 'ptc-review-validation-')
  assert.deepEqual(await validateReviewLedger(root), { state: 'absent' })
  const active = path.join(root, ACTIVE_LEDGER)

  await writeFile(active, ledger())
  const open = await validateReviewLedger(root)
  assert.equal(open.state, 'open')
  assert.equal(open.ledger.allTerminal, false)
  await assert.rejects(() => gateReviewLedger(root), /contains 1 unresolved finding/)

  await writeFile(active, resolvedLedger())
  assert.equal((await validateReviewLedger(root)).state, 'ready')
  assert.equal((await gateReviewLedger(root)).state, 'ready')
  assert.equal(await readFile(active, 'utf8'), resolvedLedger())

  await writeFile(active, 'not a review ledger\n')
  await assert.rejects(() => validateReviewLedger(root), /must start with YAML frontmatter/)
})

test('archives only after verification of an unchanged source tree', async (t) => {
  const root = await committedRepository(t, 'ptc-review-check-')
  const archiveDirectory = path.join(root, 'archive')
  const active = await createReviewLedger(root)
  await writeFile(active, resolvedLedger())
  const head = headOf(root)
  const fingerprint = async () => 'a'.repeat(40)
  let verificationRuns = 0

  const result = await checkReviewLedger(root, {
    archiveDirectory,
    now: new Date('2026-08-22T10:20:30.456Z'),
    fingerprint,
    head: () => head,
    verify: async () => { verificationRuns += 1 },
  })
  assert.equal(verificationRuns, 1)
  assert.equal(result.state, 'archived')
  assert.equal(await readFile(result.destination, 'utf8'), resolvedLedger())
  await assert.rejects(() => readFile(active, 'utf8'), { code: 'ENOENT' })

  await recordCleanVerdict(root, fingerprint)
  assert.equal((await preCommitReviewLedger(root, {
    fingerprint,
    indexFingerprint: fingerprint,
    head: () => head,
  })).state, 'verified')
  assert.equal((await preCommitReviewLedger(root, {
    fingerprint,
    indexFingerprint: fingerprint,
    head: () => head,
  })).state, 'verified')
  await assert.rejects(() => preCommitReviewLedger(root, {
    fingerprint,
    head: () => 'committed-head',
  }), /HEAD moved after npm run check/)
  await assert.rejects(() => preCommitReviewLedger(root), /no review verification proof exists/)
})

test('preserves the ledger when verification fails or changes the source tree', async (t) => {
  const root = await repository(t, 'ptc-review-atomic-')
  const active = await createReviewLedger(root)
  await writeFile(active, resolvedLedger())

  await assert.rejects(() => checkReviewLedger(root, {
    fingerprint: async () => 'same',
    verify: async () => { throw new Error('verification failed') },
  }), /verification failed/)
  assert.equal(await readFile(active, 'utf8'), resolvedLedger())

  const fingerprints = ['before', 'after']
  await assert.rejects(() => checkReviewLedger(root, {
    fingerprint: async () => fingerprints.shift(),
    verify: async () => {},
  }), /source tree changed during deterministic verification/)
  assert.equal(await readFile(active, 'utf8'), resolvedLedger())
  await assert.rejects(() => preCommitReviewLedger(root), /resolved but unverified/)

  await assert.rejects(() => checkReviewLedger(root, {
    fingerprint: async () => 'same',
    verify: async () => { await writeFile(active, `${resolvedLedger()}\n`) },
  }), /review findings ledger changed during deterministic verification/)
})

test('rejects an open ledger before running final deterministic verification', async (t) => {
  const root = await repository(t, 'ptc-review-open-check-')
  const active = await createReviewLedger(root)
  await writeFile(active, ledger())
  let verificationRuns = 0

  await assert.rejects(() => checkReviewLedger(root, {
    verify: async () => { verificationRuns += 1 },
  }), /contains 1 unresolved finding/)
  assert.equal(verificationRuns, 0)
  assert.equal(await readFile(active, 'utf8'), ledger())
})

test('rejects a commit when the checked source tree changes', async (t) => {
  const root = await committedRepository(t, 'ptc-review-proof-')
  const active = await createReviewLedger(root)
  await writeFile(active, resolvedLedger())
  const head = headOf(root)
  await checkReviewLedger(root, {
    fingerprint: async () => 'checked-tree',
    head: () => head,
    verify: async () => {},
  })
  await assert.rejects(() => preCommitReviewLedger(root, {
    fingerprint: async () => 'changed-tree',
    head: () => head,
  }), /source tree changed after npm run check/)

  await assert.rejects(() => preCommitReviewLedger(root, {
    fingerprint: async () => 'changed-tree',
    head: () => 'committed-head',
  }), /HEAD moved after npm run check/)
  await assert.rejects(() => preCommitReviewLedger(root), /no review verification proof exists/)
})

test('rejects a commit whose index omits part of the verified source tree', async (t) => {
  const root = await repository(t, 'ptc-review-index-proof-')
  const first = path.join(root, 'fix-a.txt')
  const second = path.join(root, 'fix-b.txt')
  await writeFile(first, 'base-a\n')
  await writeFile(second, 'base-b\n')
  execFileSync('git', ['add', 'fix-a.txt', 'fix-b.txt'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })

  const active = await createReviewLedger(root)
  await writeFile(active, resolvedLedger())
  await writeFile(first, 'fixed-a\n')
  await writeFile(second, 'fixed-b\n')
  await checkReviewLedger(root, { verify: async () => {} })
  await recordCleanVerdict(root)

  execFileSync('git', ['add', 'fix-a.txt'], { cwd: root })
  await assert.rejects(
    () => preCommitReviewLedger(root),
    /staged tree differs from the source tree verified by npm run check/,
  )

  execFileSync('git', ['add', 'fix-b.txt'], { cwd: root })
  assert.equal((await preCommitReviewLedger(root)).state, 'verified')
  assert.equal(await indexTreeFingerprint(root), await sourceTreeFingerprint(root))

  await unlink(second)
  await checkReviewLedger(root, { verify: async () => {} })
  await recordCleanVerdict(root)
  execFileSync('git', ['add', 'fix-b.txt'], { cwd: root })
  assert.equal((await preCommitReviewLedger(root)).state, 'verified')
  assert.equal(await indexTreeFingerprint(root), await sourceTreeFingerprint(root))
})

test('rejects malformed verification proof instead of treating it as absent', async (t) => {
  const root = await committedRepository(t, 'ptc-review-malformed-proof-')
  const proof = path.join(root, '.git/review-findings/verified-tree')
  await mkdir(path.dirname(proof), { recursive: true })

  await writeFile(proof, 'not JSON\n')
  await assert.rejects(() => preCommitReviewLedger(root), /verification proof is malformed/)

  await writeFile(proof, '{"head":"only-head"}\n')
  await assert.rejects(() => preCommitReviewLedger(root), /verification proof is malformed/)
})

test('fingerprints checkout content independently of staging state', async (t) => {
  const root = await repository(t, 'ptc-review-fingerprint-')
  const tracked = path.join(root, 'tracked.txt')
  await writeFile(tracked, 'one\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })

  const initialIndex = indexTreeFingerprint(root)
  const initialIndexBytes = await gitIndexBytes(root)
  await writeFile(tracked, 'two\n')
  const unstaged = await sourceTreeFingerprint(root)
  assert.equal(indexTreeFingerprint(root), initialIndex)
  assert.deepEqual(await gitIndexBytes(root), initialIndexBytes)
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  assert.equal(await sourceTreeFingerprint(root), unstaged)

  await writeFile(tracked, 'three\n')
  assert.notEqual(await sourceTreeFingerprint(root), unstaged)
  await unlink(tracked)
  assert.notEqual(await sourceTreeFingerprint(root), unstaged)

  const removedAddition = path.join(root, 'removed-addition.txt')
  await writeFile(removedAddition, 'staged then removed\n')
  execFileSync('git', ['add', 'removed-addition.txt'], { cwd: root })
  await unlink(removedAddition)
  const withoutRemovedAddition = await sourceTreeFingerprint(root)
  execFileSync('git', ['add', '--all'], { cwd: root })
  assert.equal(indexTreeFingerprint(root), withoutRemovedAddition)
})

test('fingerprints staged renames independently of Git rename detection', async (t) => {
  const root = await repository(t, 'ptc-review-rename-')
  const large = `${Array.from({ length: 40 }, (_unused, index) => `line ${index}`).join('\n')}\n`
  await writeFile(path.join(root, 'before.txt'), 'before\n')
  await writeFile(path.join(root, 'bulk.txt'), large)
  execFileSync('git', ['add', 'before.txt', 'bulk.txt'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })

  execFileSync('git', ['mv', 'before.txt', 'after.txt'], { cwd: root })
  assert.match(execFileSync('git', ['diff', '--cached', '--name-status'], { cwd: root, encoding: 'utf8' }), /^R100\tbefore\.txt\tafter\.txt$/m)
  const renamedTree = indexTreeFingerprint(root)
  const renamedIndex = await gitIndexBytes(root)
  assert.equal(await sourceTreeFingerprint(root), renamedTree)
  assert.equal(indexTreeFingerprint(root), renamedTree)
  assert.deepEqual(await gitIndexBytes(root), renamedIndex)

  execFileSync('git', ['mv', 'bulk.txt', 'bulk-renamed.txt'], { cwd: root })
  await writeFile(path.join(root, 'bulk-renamed.txt'), large.replace('line 20', 'line twenty'))
  execFileSync('git', ['add', 'bulk-renamed.txt'], { cwd: root })
  assert.match(execFileSync('git', ['diff', '--cached', '--name-status'], { cwd: root, encoding: 'utf8' }), /^R\d+\tbulk\.txt\tbulk-renamed\.txt$/m)
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))

  await writeFile(path.join(root, 'bulk-renamed.txt'), `${large.replace('line 20', 'line twenty')}unstaged\n`)
  assert.notEqual(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
  execFileSync('git', ['add', 'bulk-renamed.txt'], { cwd: root })
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
})

test('fingerprints renames into special and nested paths through the commit gate', async (t) => {
  const root = await repository(t, 'ptc-review-rename-gate-')
  await mkdir(path.join(root, 'plain'))
  await writeFile(path.join(root, 'plain', 'spaced name.txt'), 'spaced\n')
  await writeFile(path.join(root, 'plain', 'naïve-ß.txt'), 'unicode\n')
  execFileSync('git', ['add', '--all'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })

  await mkdir(path.join(root, 'moved', 'deeper'), { recursive: true })
  execFileSync('git', ['mv', 'plain/spaced name.txt', 'moved/deeper/spaced name.txt'], { cwd: root })
  execFileSync('git', ['mv', 'plain/naïve-ß.txt', 'moved/naïve-ß.txt'], { cwd: root })

  const active = await createReviewLedger(root)
  await writeFile(active, resolvedLedger())
  const renamedTree = indexTreeFingerprint(root)
  const indexBytes = await gitIndexBytes(root)
  await checkReviewLedger(root, { verify: async () => {} })
  await recordCleanVerdict(root)
  assert.equal(await sourceTreeFingerprint(root), renamedTree)
  assert.equal(indexTreeFingerprint(root), renamedTree)
  assert.equal((await preCommitReviewLedger(root)).state, 'verified')
  assert.deepEqual(await gitIndexBytes(root), indexBytes)
})

test('rejects scratch administration failures before touching the target index', async (t) => {
  const root = await repository(t, 'ptc-review-scratch-failure-')
  await writeFile(path.join(root, 'tracked.txt'), 'base\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  const indexTree = indexTreeFingerprint(root)
  const indexBytes = await gitIndexBytes(root)
  await writeFile(path.join(root, '.git', 'review-findings'), 'blocks scratch metadata\n')

  await assert.rejects(() => sourceTreeFingerprint(root), /review-findings/)
  assert.equal(indexTreeFingerprint(root), indexTree)
  assert.deepEqual(await gitIndexBytes(root), indexBytes)
})

test('preserves unmaterialized entries in a sparse checkout fingerprint', async (t) => {
  const root = await repository(t, 'ptc-review-sparse-tree-')
  await mkdir(path.join(root, 'visible'))
  await mkdir(path.join(root, 'hidden'))
  await writeFile(path.join(root, 'visible', 'tracked.txt'), 'visible\n')
  await writeFile(path.join(root, 'hidden', 'tracked.txt'), 'hidden\n')
  execFileSync('git', ['add', 'visible/tracked.txt', 'hidden/tracked.txt'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })
  execFileSync('git', ['sparse-checkout', 'init', '--cone'], { cwd: root })
  execFileSync('git', ['sparse-checkout', 'set', 'visible'], { cwd: root })

  assert.match(execFileSync('git', ['ls-files', '-t', 'hidden/tracked.txt'], {
    cwd: root, encoding: 'utf8',
  }), /^S /)
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))

  await writeFile(path.join(root, 'visible', 'tracked.txt'), 'changed\n')
  assert.notEqual(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
  execFileSync('git', ['add', 'visible/tracked.txt'], { cwd: root })
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
})

test('treats pathspec-looking filenames as literal source paths', async (t) => {
  const root = await repository(t, 'ptc-review-literal-path-')
  if (usesWindowsGitPathSemantics(root)) {
    t.skip('The active Git cannot represent the colon in this filename')
    return
  }
  const tracked = path.join(root, ':(exclude)base')
  const untracked = path.join(root, ':(top)untracked')
  await writeFile(tracked, 'tracked\n')
  execFileSync('git', ['--literal-pathspecs', 'add', '--', ':(exclude)base'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))

  await writeFile(tracked, 'changed tracked\n')
  assert.notEqual(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
  execFileSync('git', ['--literal-pathspecs', 'add', '--', ':(exclude)base'], { cwd: root })
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))

  await writeFile(untracked, 'untracked\n')
  assert.notEqual(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
  await writeFile(untracked, 'changed\n')
  assert.notEqual(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
  execFileSync('git', ['--literal-pathspecs', 'add', '--', ':(top)untracked'], { cwd: root })
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
})

test('preserves raw POSIX filename bytes in source fingerprints', async (t) => {
  const root = await repository(t, 'ptc-review-raw-path-')
  if (usesWindowsGitPathSemantics(root)) {
    t.skip('The active Git cannot represent arbitrary POSIX filename bytes')
    return
  }
  const file = await writeRawFilenameFixture(
    root,
    Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xff]),
    'base\n',
  )
  if (file === undefined) {
    t.skip('The active filesystem cannot represent arbitrary POSIX filename bytes')
    return
  }
  execFileSync('git', ['add', '--all'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))

  await writeFile(file, 'changed\n')
  assert.notEqual(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
  execFileSync('git', ['add', '--all'], { cwd: root })
  assert.equal(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
})

test('uses Git canonical content for source trees', async (t) => {
  const root = await repository(t, 'ptc-review-git-tree-')
  await writeFile(path.join(root, '.gitattributes'), '*.txt text eol=lf\n')
  const transformed = path.join(root, 'transformed.txt')
  await writeFile(transformed, 'one\ntwo\n')
  execFileSync('git', ['add', '.gitattributes', 'transformed.txt'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })

  await writeFile(transformed, 'one\r\ntwo\r\n')
  const canonicalSource = await sourceTreeFingerprint(root)
  execFileSync('git', ['add', 'transformed.txt'], { cwd: root })
  assert.equal(indexTreeFingerprint(root), canonicalSource)
  assert.match(canonicalSource, /^[0-9a-f]{40,64}$/)
})

test('uses Git symlink identity for source trees', async (t) => {
  const root = await repository(t, 'ptc-review-git-symlink-tree-')
  if (gitConfigValue(root, 'core.symlinks') === 'false') {
    t.skip('The active Git is configured not to preserve symlink entries')
    return
  }
  const target = path.join(root, 'target.txt')
  const link = path.join(root, 'target-link')
  const changedTarget = path.join(root, 'changed-target.txt')
  await writeFile(target, 'target\n')
  await writeFile(changedTarget, 'changed target\n')
  try {
    await symlink('target.txt', link, 'file')
  } catch (error) {
    if (['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip('The filesystem does not permit symbolic links')
      return
    }
    throw error
  }
  execFileSync('git', ['add', 'target.txt', 'changed-target.txt', 'target-link'], { cwd: root })
  assert.equal(indexTreeFingerprint(root), await sourceTreeFingerprint(root))
  await unlink(link)
  await symlink('changed-target.txt', link, 'file')
  assert.notEqual(await sourceTreeFingerprint(root), indexTreeFingerprint(root))
  execFileSync('git', ['add', 'target-link'], { cwd: root })
  assert.equal(indexTreeFingerprint(root), await sourceTreeFingerprint(root))
})

test('rejects a mode-only index change made after verification', async (t) => {
  const root = await repository(t, 'ptc-review-mode-proof-')
  const hook = path.join(root, 'hook.sh')
  await writeFile(hook, '#!/bin/sh\nexit 0\n')
  await chmod(hook, 0o755)
  execFileSync('git', ['add', 'hook.sh'], { cwd: root })
  execFileSync('git', ['update-index', '--chmod=+x', 'hook.sh'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })
  execFileSync('git', ['config', 'core.filemode', 'false'], { cwd: root })

  const active = await createReviewLedger(root)
  await writeFile(active, resolvedLedger())
  await checkReviewLedger(root, { verify: async () => {} })
  execFileSync('git', ['update-index', '--chmod=-x', 'hook.sh'], { cwd: root })

  assert.notEqual(indexTreeFingerprint(root), await sourceTreeFingerprint(root))
  await assert.rejects(
    () => preCommitReviewLedger(root),
    /staged tree differs from the source tree verified by npm run check/,
  )
})

test('lets Git reject an unmerged prospective tree', async (t) => {
  const root = await repository(t, 'ptc-review-unmerged-tree-')
  const conflicted = path.join(root, 'conflicted.txt')
  await writeFile(conflicted, 'base\n')
  execFileSync('git', ['add', 'conflicted.txt'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test',
    'commit', '--quiet', '-m', 'base'], { cwd: root })
  const base = execFileSync('git', ['rev-parse', 'HEAD:conflicted.txt'], {
    cwd: root, encoding: 'utf8',
  }).trim()
  await writeFile(conflicted, 'ours\n')
  const ours = execFileSync('git', ['hash-object', '-w', 'conflicted.txt'], {
    cwd: root, encoding: 'utf8',
  }).trim()
  await writeFile(conflicted, 'theirs\n')
  const theirs = execFileSync('git', ['hash-object', '-w', 'conflicted.txt'], {
    cwd: root, encoding: 'utf8',
  }).trim()
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: root,
    input: `100644 ${base} 1\tconflicted.txt\n100644 ${ours} 2\tconflicted.txt\n100644 ${theirs} 3\tconflicted.txt\n`,
  })

  assert.throws(() => indexTreeFingerprint(root), /unmerged|write-tree/i)
  await assert.rejects(() => sourceTreeFingerprint(root), /unmerged|write-tree/i)
})

test('refreshes a stale proof after a later check without an active ledger', async (t) => {
  const root = await committedRepository(t, 'ptc-review-refresh-')
  const active = await createReviewLedger(root)
  await writeFile(active, resolvedLedger())
  const head = headOf(root)
  await checkReviewLedger(root, {
    fingerprint: async () => 'a'.repeat(40),
    head: () => head,
    verify: async () => {},
  })
  await assert.rejects(() => preCommitReviewLedger(root, {
    fingerprint: async () => 'b'.repeat(40),
    head: () => head,
  }), /source tree changed after npm run check/)

  assert.equal((await checkReviewLedger(root, {
    fingerprint: async () => 'b'.repeat(40),
    head: () => head,
    verify: async () => {},
  })).state, 'absent')
  await recordCleanVerdict(root, async () => 'b'.repeat(40))
  assert.equal((await preCommitReviewLedger(root, {
    fingerprint: async () => 'b'.repeat(40),
    indexFingerprint: async () => 'b'.repeat(40),
    head: () => head,
  })).state, 'verified')
})

test('creates the ignored ledger only through the authorized lifecycle', async (t) => {
  const root = await repository(t, 'ptc-review-create-')
  const active = await createReviewLedger(root)
  assert.equal(await readFile(active, 'utf8'), templateText)
  assert.match(await readFile(path.join(root, '.git/info/exclude'), 'utf8'), /^\/REVIEW_FINDINGS\.md$/m)
  await assert.rejects(() => createReviewLedger(root), /already exists/)
})

test('keeps verification, checked archive, and hook installation explicit', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const agentContract = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  assert.equal(packageJson.scripts.prepare, undefined)
  assert.equal(packageJson.scripts['hooks:install'], 'node scripts/review-findings.mjs install-hook')
  assert.match(packageJson.scripts.verify, /^npm run review:validate && /)
  assert.doesNotMatch(packageJson.scripts.verify, /review:gate/)
  assert.equal(packageJson.scripts.check, 'node scripts/review-findings.mjs check')
  assert.match(agentContract, /## Product Obligations/)
  assert.match(agentContract, /General contributor or agent methodology belongs outside the repository/)
  assert.doesNotMatch(agentContract, /skills? before acting|wip\/checkpoint/)
  assert.match(agentContract, /git diff --check HEAD --/)
  assert.doesNotMatch(agentContract, /git diff --check(?! HEAD --)/)
})

test('reuses the invoking npm CLI across forwarded and native environments', () => {
  assert.deepEqual(verificationCommand({
    platform: 'win32',
    execPath: 'X:\\fixture\\runtime\\node.exe',
    npmExecPath: 'X:\\fixture\\runtime\\npm-cli.js',
  }), {
    executable: 'X:\\fixture\\runtime\\node.exe',
    args: ['X:\\fixture\\runtime\\npm-cli.js', 'run', 'verify'],
  })
  assert.deepEqual(verificationCommand({ platform: 'win32', npmExecPath: undefined }), {
    executable: 'npm.cmd', args: ['run', 'verify'],
  })
  assert.deepEqual(verificationCommand({ platform: 'linux', npmExecPath: undefined }), {
    executable: 'npm', args: ['run', 'verify'],
  })
})

test('installs the tracked hook path without replacing another hook owner', async (t) => {
  const root = await repository(t, 'ptc-review-hook-')
  assert.throws(() => installHook(root), /tracked pre-commit hook is missing/)

  await mkdir(path.join(root, '.githooks'))
  await writeFile(path.join(root, '.githooks/pre-commit'), '#!/bin/sh\n')
  await writeFile(path.join(root, '.git/hooks/pre-commit'), '#!/bin/sh\n')
  await writeFile(path.join(root, '.git/hooks/commit-msg'), '#!/bin/sh\n')

  assert.throws(() => installHook(root), /custom hooks: commit-msg, pre-commit/)
  assert.throws(
    () => execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }),
  )
  await Promise.all([
    unlink(path.join(root, '.git/hooks/pre-commit')),
    unlink(path.join(root, '.git/hooks/commit-msg')),
  ])

  assert.equal(installHook(root).state, 'installed')
  assert.equal(execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(), '.githooks')

  execFileSync('git', ['config', '--local', 'core.hooksPath', 'other-hooks'], { cwd: root })
  assert.throws(() => installHook(root), /without discarding the existing hooks/)
})
