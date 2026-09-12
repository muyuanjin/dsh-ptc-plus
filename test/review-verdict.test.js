import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  checkReviewLedger,
  preCommitReviewLedger,
  readReviewVerdict,
  recordReviewVerdict,
  sourceTreeFingerprint,
} from '../scripts/review-findings.mjs'

const FINGERPRINT_A = 'a'.repeat(40)
const FINGERPRINT_B = 'b'.repeat(40)
const CLEAN_EVIDENCE = 'reviewed the frozen candidate\nVERDICT: NO FINDINGS\n'

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr)
  return result.stdout.trim()
}

function headOf(root) {
  return git(root, ['rev-parse', 'HEAD'])
}

async function repository(t) {
  const base = await mkdtemp(join(tmpdir(), 'ptc-review-gate-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  const evidence = join(base, 'evidence')
  await mkdir(root)
  await mkdir(evidence)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'gate@example.invalid'])
  git(root, ['config', 'user.name', 'Gate Test'])
  await writeFile(join(root, 'subject.txt'), 'one\n')
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '-m', 'init'])
  return { root, evidence }
}

let evidenceSequence = 0
async function evidenceFile(directory, text = CLEAN_EVIDENCE) {
  evidenceSequence += 1
  const filename = join(directory, 'review-' + evidenceSequence + '.txt')
  await writeFile(filename, text)
  return filename
}

const injected = (head, fingerprint = FINGERPRINT_A) => ({
  fingerprint: async () => fingerprint,
  indexFingerprint: async () => fingerprint,
  head: () => head,
})

async function check(root, head, fingerprint = FINGERPRINT_A) {
  return checkReviewLedger(root, { verify: async () => {}, fingerprint: async () => fingerprint, head: () => head })
}

async function record(root, head, evidence, actual = FINGERPRINT_A, expected = actual) {
  return recordReviewVerdict(root, {
    base: head,
    expectHead: head,
    evidence,
    expectFingerprint: expected,
    fingerprint: async () => actual,
    head: () => head,
  })
}

test('the gate rejects a candidate without a verification proof', async (t) => {
  const { root } = await repository(t)
  await assert.rejects(() => preCommitReviewLedger(root, injected(headOf(root))), /no review verification proof exists/u)
})

test('the gate rejects a verified candidate without a clean verdict', async (t) => {
  const { root } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  await assert.rejects(() => preCommitReviewLedger(root, injected(head)), /no clean independent review verdict exists/u)
})

test('a matching clean verdict verifies the frozen candidate', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  const report = await evidenceFile(evidence)
  const recorded = await record(root, head, report)
  assert.equal(recorded.verdict.status, 'clean')
  assert.equal(recorded.verdict.head, head)
  assert.equal((await readReviewVerdict(root)).fingerprint, FINGERPRINT_A)
  const result = await preCommitReviewLedger(root, injected(head))
  assert.equal(result.state, 'verified')
  assert.equal(result.verdict.evidence.sha256.length, 64)
})

test('recording refuses a candidate that changed while the review ran', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  const report = await evidenceFile(evidence)
  await assert.rejects(() => record(root, head, report, FINGERPRINT_A, FINGERPRINT_B), /changed while the independent review ran/u)
})

test('recording requires the report to end with the clean marker', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  const findingsReport = await evidenceFile(evidence, 'FINDINGS PRESENT\nVERDICT: FINDINGS PRESENT\n')
  const incompleteReport = await evidenceFile(evidence, 'interrupted\nVERDICT: INCOMPLETE\n')
  const markerlessReport = await evidenceFile(evidence, 'no marker\n')
  const trailingReport = await evidenceFile(evidence, 'VERDICT: NO FINDINGS\nAdditional review: incomplete\n')
  await assert.rejects(() => record(root, head, findingsReport), /did not end with/u)
  await assert.rejects(() => record(root, head, incompleteReport), /incomplete verdict/u)
  await assert.rejects(() => record(root, head, markerlessReport), /must end with/u)
  await assert.rejects(() => record(root, head, trailingReport), /did not end with/u)
  assert.equal(await readReviewVerdict(root), undefined)
})

test('recording resolves the scope base and refuses one that does not cover HEAD', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  const report = await evidenceFile(evidence)
  await assert.rejects(() => recordReviewVerdict(root, {
    base: '0'.repeat(40),
    expectHead: head,
    evidence: report,
    expectFingerprint: FINGERPRINT_A,
    fingerprint: async () => FINGERPRINT_A,
    head: () => head,
  }), /not a commit in this repository/u)
  git(root, ['checkout', '--quiet', '-b', 'side'])
  await writeFile(join(root, 'side.txt'), 'side\n')
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '-m', 'side'])
  const side = headOf(root)
  git(root, ['checkout', '--quiet', '-'])
  await assert.rejects(() => recordReviewVerdict(root, {
    base: side,
    expectHead: head,
    evidence: report,
    expectFingerprint: FINGERPRINT_A,
    fingerprint: async () => FINGERPRINT_A,
    head: () => head,
  }), /not an ancestor of HEAD/u)
  const recorded = await recordReviewVerdict(root, {
    base: head.slice(0, 7),
    expectHead: head,
    evidence: report,
    expectFingerprint: FINGERPRINT_A,
    fingerprint: async () => FINGERPRINT_A,
    head: () => head,
  })
  assert.equal(recorded.verdict.base, head)
})

test('recording refuses a head that is not the current HEAD', async (t) => {
  const { root, evidence } = await repository(t)
  const report = await evidenceFile(evidence)
  await assert.rejects(() => recordReviewVerdict(root, {
    base: headOf(root),
    expectHead: '0'.repeat(40),
    evidence: report,
    expectFingerprint: FINGERPRINT_A,
    fingerprint: async () => FINGERPRINT_A,
    head: () => '0'.repeat(40),
  }), /must bind the current HEAD/u)
})

test('the gate rejects a source fingerprint change after verification', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  await record(root, head, await evidenceFile(evidence))
  await assert.rejects(() => preCommitReviewLedger(root, {
    fingerprint: async () => FINGERPRINT_B,
    indexFingerprint: async () => FINGERPRINT_B,
    head: () => head,
  }), /source tree changed after npm run check/u)
})

test('the gate rejects a verdict whose scope base does not cover the candidate', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  await record(root, head, await evidenceFile(evidence))
  const verdictFile = join(root, '.git', 'review-findings', 'verdict')
  const verdict = JSON.parse(await readFile(verdictFile, 'utf8'))
  verdict.base = '0'.repeat(40)
  await writeFile(verdictFile, JSON.stringify(verdict) + '\n')
  await assert.rejects(() => preCommitReviewLedger(root, injected(head)), /scope does not cover/u)
})

test('a verdict that does not match the verified candidate is retired', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  await record(root, head, await evidenceFile(evidence))
  const verdictFile = join(root, '.git', 'review-findings', 'verdict')
  const verdict = JSON.parse(await readFile(verdictFile, 'utf8'))
  verdict.fingerprint = FINGERPRINT_B
  await writeFile(verdictFile, JSON.stringify(verdict) + '\n')
  await assert.rejects(() => preCommitReviewLedger(root, injected(head)), /does not belong to the verified candidate/u)
  assert.equal(existsSync(verdictFile), false)
  assert.equal(existsSync(join(root, '.git', 'review-findings', 'verified-tree')), true)
})

test('the gate rejects tampered independent review evidence', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  const recorded = await record(root, head, await evidenceFile(evidence))
  await writeFile(recorded.evidencePath, 'tampered\nVERDICT: NO FINDINGS\n')
  await assert.rejects(() => preCommitReviewLedger(root, injected(head)), /evidence is missing or changed/u)
})

test('the gate rejects a staged tree that differs from the verified source', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  await record(root, head, await evidenceFile(evidence))
  await assert.rejects(() => preCommitReviewLedger(root, {
    fingerprint: async () => FINGERPRINT_A,
    indexFingerprint: async () => FINGERPRINT_B,
    head: () => head,
  }), /staged tree differs/u)
})

test('an unresolved finding blocks at the same fingerprint', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  await record(root, head, await evidenceFile(evidence))
  await writeFile(join(root, 'REVIEW_FINDINGS.md'), [
    '---',
    'schema: dsh-review-findings/v3',
    'ledgerStatus: open',
    'findings:',
    '  - id: F001',
    '    severity: P2',
    '    status: unresolved',
    '    dispositionRef:',
    '    owner: internal/example.js',
    '    condition: >-',
    '      A reproducible condition.',
    '    impact: >-',
    '      An observable consequence.',
    '    requiredOutcome: >-',
    '      The invariant that must hold after resolution.',
    '    implementationPlan:',
    '    resolutionEvidence:',
    '---',
    '# Review Findings',
    '',
  ].join('\n'))
  await assert.rejects(() => preCommitReviewLedger(root, injected(head)), /unresolved finding/u)
})

test('a moved HEAD retires the proof and the verdict', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  await record(root, head, await evidenceFile(evidence))
  await writeFile(join(root, 'subject.txt'), 'two\n')
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '-m', 'second'])
  await assert.rejects(() => preCommitReviewLedger(root, injected(headOf(root))), /HEAD moved after npm run check/u)
  assert.equal(existsSync(join(root, '.git', 'review-findings', 'verified-tree')), false)
  assert.equal(existsSync(join(root, '.git', 'review-findings', 'verdict')), false)
})

test('the real fingerprint flow verifies a clean frozen candidate', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  const fingerprint = await sourceTreeFingerprint(root)
  await checkReviewLedger(root, { verify: async () => {} })
  await recordReviewVerdict(root, { base: head, expectHead: head, evidence: await evidenceFile(evidence), expectFingerprint: fingerprint })
  const result = await preCommitReviewLedger(root)
  assert.equal(result.state, 'verified')
  assert.equal(result.verdict.fingerprint, fingerprint)
})

test('a non-clean report retires the standing clean verdict', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  await check(root, head)
  await record(root, head, await evidenceFile(evidence))
  assert.equal((await preCommitReviewLedger(root, injected(head))).state, 'verified')
  const incomplete = await evidenceFile(evidence, 'interrupted\nVERDICT: INCOMPLETE\n')
  await assert.rejects(() => record(root, head, incomplete), /retired for this candidate/u)
  await assert.rejects(() => preCommitReviewLedger(root, injected(head)), /no review verification proof exists/u)
})

test('recording refuses a HEAD that moved while the review ran', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  const report = await evidenceFile(evidence)
  await writeFile(join(root, 'second.txt'), 'two\n')
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '-m', 'second'])
  const moved = headOf(root)
  await assert.rejects(() => recordReviewVerdict(root, {
    base: head,
    expectHead: head,
    evidence: report,
    expectFingerprint: FINGERPRINT_A,
    fingerprint: async () => FINGERPRINT_A,
    head: () => moved,
  }), /HEAD moved while the independent review ran/u)
})

test('recording requires the captured candidate identity and accepts an abbreviated HEAD', async (t) => {
  const { root, evidence } = await repository(t)
  const head = headOf(root)
  const report = await evidenceFile(evidence)
  const complete = {
    base: head,
    expectHead: head,
    evidence: report,
    expectFingerprint: FINGERPRINT_A,
    fingerprint: async () => FINGERPRINT_A,
    head: () => head,
  }
  for (const key of ['base', 'evidence', 'expectFingerprint', 'expectHead']) {
    const options = { ...complete }
    delete options[key]
    await assert.rejects(() => recordReviewVerdict(root, options), /a review verdict requires/u)
  }
  await assert.rejects(() => recordReviewVerdict(root, { ...complete, expectHead: 'HEAD' }), /full or abbreviated HEAD commit id/u)
  const recorded = await recordReviewVerdict(root, { ...complete, expectHead: head.slice(0, 8) })
  assert.equal(recorded.verdict.head, head)
})

test('recording and the gate require a commit at HEAD', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'ptc-review-unborn-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  git(base, ['init', '--quiet'])
  await assert.rejects(() => preCommitReviewLedger(base), /the review gate requires a commit at HEAD/u)
  await assert.rejects(() => recordReviewVerdict(base, {
    base: '0'.repeat(40),
    expectHead: '0'.repeat(40),
    evidence: 'unused.txt',
    expectFingerprint: FINGERPRINT_A,
    fingerprint: async () => FINGERPRINT_A,
  }), /a review verdict requires a commit at HEAD/u)
})
