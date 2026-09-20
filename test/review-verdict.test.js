import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  checkReviewLedger,
  clearReviewVerdict,
  finalizeReviewVerdict,
  parseReviewPlan,
  preCommitReviewLedger,
  readReviewVerdict,
  recordReviewLaneVerdict,
  recordReviewPlan,
  reviewStatus,
  sourceTreeSnapshot,
} from '../scripts/review-findings.mjs'
import { writeRawFilenameFixture } from './raw-filename-fixture.js'

const CLEAN_EVIDENCE = 'reviewed the declared lane\nVERDICT: NO FINDINGS\n'

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr)
  return result.stdout.trim()
}

function headOf(root) {
  return git(root, ['rev-parse', 'HEAD'])
}

function usesWindowsGitPathSemantics(root) {
  const execPath = git(root, ['--exec-path'])
  return /^[A-Za-z]:[\\/]/u.test(execPath) || execPath.startsWith('\\\\')
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'ptc-review-gate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'gate@example.invalid'])
  git(root, ['config', 'user.name', 'Gate Test'])
  await Promise.all([
    writeFile(join(root, 'a.txt'), 'a0\n'),
    writeFile(join(root, 'b.txt'), 'b0\n'),
    writeFile(join(root, 'c.txt'), 'c0\n'),
  ])
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '-m', 'init'])
  await mkdir(join(root, '.git', 'reports'))
  return root
}

function plan(overrides = {}) {
  return {
    schema: 'dsh-review-plan/v1',
    obligations: [
      { id: 'owner-a', description: 'Review owner A.', disposition: 'covered', reason: null },
      { id: 'owner-b', description: 'Review owner B.', disposition: 'covered', reason: null },
      { id: 'integration', description: 'Review the B to C contract.', disposition: 'covered', reason: null },
      { id: 'intrinsic-handling', description: 'Review intrinsic handling.', disposition: 'excluded', reason: 'Not changed.' },
      { id: 'scope-and-declaration-ownership', description: 'Review declaration ownership.', disposition: 'excluded', reason: 'Not changed.' },
      { id: 'callable-reconstruction', description: 'Review callable reconstruction.', disposition: 'excluded', reason: 'Not changed.' },
      { id: 'module-and-cross-entry-contracts', description: 'Review module contracts.', disposition: 'excluded', reason: 'Not changed.' },
      { id: 'historical-semantics-and-recovery', description: 'Review historical recovery.', disposition: 'excluded', reason: 'Not changed.' },
    ],
    lanes: [
      {
        id: 'owner-a', scope: 'Owner A and its direct behavior.', paths: ['a.txt'], dependsOn: [],
        obligations: ['owner-a'], owners: ['a.txt'], consumers: ['The A consumer.'],
        counterexamples: ['Changing A without the expected result falsifies this lane.'],
      },
      {
        id: 'owner-b', scope: 'Owner B and its direct behavior.', paths: ['b.txt'], dependsOn: [],
        obligations: ['owner-b'], owners: ['b.txt'], consumers: ['The B consumer.'],
        counterexamples: ['Changing B without the expected result falsifies this lane.'],
      },
      {
        id: 'integration', scope: 'The contract from B into C.', paths: ['c.txt'], dependsOn: ['owner-b'],
        obligations: ['integration'], owners: ['c.txt'], consumers: ['The cross-owner consumer.'],
        counterexamples: ['A B change that C interprets incorrectly falsifies this lane.'],
      },
    ],
    ...overrides,
  }
}

async function writePlan(root, value = plan(), space) {
  await writeFile(join(root, 'REVIEW_PLAN.json'), JSON.stringify(value, null, space))
}

async function installPlan(root, value = plan()) {
  await writePlan(root, value)
  return recordReviewPlan(root, { base: headOf(root) })
}

let evidenceSequence = 0
async function evidenceFile(root, text = CLEAN_EVIDENCE) {
  evidenceSequence += 1
  const filename = join(root, '.git', 'reports', `review-${evidenceSequence}.txt`)
  await writeFile(filename, text)
  return filename
}

async function recordLane(root, lane, text = CLEAN_EVIDENCE, captured) {
  const status = captured ?? await reviewStatus(root)
  const state = status.lanes.find(candidate => candidate.id === lane)
  return recordReviewLaneVerdict(root, {
    lane,
    evidence: await evidenceFile(root, text),
    expectHead: status.head,
    expectFingerprint: state.fingerprint,
  })
}

async function recordAll(root) {
  for (const lane of ['owner-a', 'owner-b', 'integration']) await recordLane(root, lane)
}

async function verifyAndFinalize(root) {
  await checkReviewLedger(root, { verify: async () => {} })
  return finalizeReviewVerdict(root)
}

test('review plans require explicit obligations, stable lanes, and an acyclic dependency graph', () => {
  assert.equal(parseReviewPlan(JSON.stringify(plan())).lanes.length, 3)
  assert.equal(parseReviewPlan(JSON.stringify({ ...plan(), lanes: [
    { ...plan().lanes[0], paths: ['fixtures/'] }, plan().lanes[1], plan().lanes[2],
  ] })).lanes[0].paths[0], 'fixtures/')
  const excluded = plan({
    obligations: [
      { id: 'owner-a', description: 'Review owner A.', disposition: 'covered', reason: null },
      { id: 'not-applicable', description: 'A deliberately excluded contract.', disposition: 'excluded', reason: 'No runtime code changes.' },
      ...plan().obligations.slice(3),
    ],
    lanes: [plan().lanes[0]],
  })
  assert.equal(parseReviewPlan(JSON.stringify(excluded)).obligations[1].disposition, 'excluded')
  for (const obligation of plan().obligations.slice(3)) {
    assert.throws(() => parseReviewPlan(JSON.stringify({
      ...plan(), obligations: plan().obligations.filter(candidate => candidate.id !== obligation.id),
    })), new RegExp(`omits standard obligation\\(s\\): ${obligation.id}`, 'u'))
  }
  assert.throws(() => parseReviewPlan(JSON.stringify({ ...plan(), lanes: [
    { ...plan().lanes[0], dependsOn: ['integration'] },
    plan().lanes[1],
    { ...plan().lanes[2], dependsOn: ['owner-a'] },
  ] })), /dependency cycle/u)
  assert.throws(() => parseReviewPlan(JSON.stringify({ ...plan(), lanes: [
    { ...plan().lanes[0], paths: ['../outside'] }, plan().lanes[1], plan().lanes[2],
  ] })), /cannot escape/u)
  assert.throws(() => parseReviewPlan(JSON.stringify({ ...plan(), lanes: [plan().lanes[0]] })), /not assigned/u)
})

test('review-state mutations never auto-recover a lock and support explicit crash cleanup', async (t) => {
  const root = await repository(t)
  await writePlan(root)
  const lockPath = join(root, '.git', 'review-findings', 'state.lock')
  await mkdir(lockPath, { recursive: true })
  const deadOwner = spawnSync(process.execPath, ['-e', ''])
  assert.equal(deadOwner.status, 0)
  await writeFile(join(lockPath, 'owner'), JSON.stringify({ pid: deadOwner.pid, token: 'abandoned' }))
  await assert.rejects(
    () => recordReviewPlan(root, { base: headOf(root), lockTimeoutMs: 20, lockRetryMs: 5 }),
    /confirm no review command is active/u,
  )
  await rm(lockPath, { recursive: true })
  const recorded = await recordReviewPlan(root, { base: headOf(root) })
  assert.equal(recorded.state, 'recorded')
  await assert.rejects(() => readFile(join(lockPath, 'owner')), error => error?.code === 'ENOENT')
})

test('parallel lanes compose into one verdict for the verified candidate', async (t) => {
  const root = await repository(t)
  await Promise.all([writeFile(join(root, 'a.txt'), 'a1\n'), writeFile(join(root, 'b.txt'), 'b1\n')])
  await installPlan(root)
  const initial = await reviewStatus(root)
  assert.deepEqual(initial.lanes.map(lane => lane.clean), [false, false, false])
  await recordAll(root)
  assert.equal((await reviewStatus(root)).state, 'clean')
  const finalized = await verifyAndFinalize(root)
  assert.equal(finalized.verdict.schema, 'dsh-review-verdict/v2')
  assert.deepEqual(finalized.verdict.lanes.map(lane => lane.id), ['owner-a', 'owner-b', 'integration'])
  git(root, ['add', '--all'])
  assert.equal((await preCommitReviewLedger(root)).state, 'verified')
})

test('an unrelated edit preserves clean lanes while dependency changes invalidate their closure', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await writeFile(join(root, 'b.txt'), 'b1\n')
  let status = await reviewStatus(root)
  assert.deepEqual(status.lanes.map(lane => [lane.id, lane.clean]), [
    ['owner-a', true], ['owner-b', false], ['integration', false],
  ])
  await recordLane(root, 'owner-b')
  status = await reviewStatus(root)
  assert.deepEqual(status.lanes.map(lane => lane.clean), [true, true, false])
  await recordLane(root, 'integration')
  assert.equal((await reviewStatus(root)).state, 'clean')
})

test('a findings verdict retires only the failed lane and its dependents', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  const captured = await reviewStatus(root)
  await assert.rejects(
    () => recordLane(root, 'owner-b', 'finding\nVERDICT: FINDINGS PRESENT\n', captured),
    /retired review lane\(s\): owner-b, integration/u,
  )
  const status = await reviewStatus(root)
  assert.deepEqual(status.lanes.map(lane => [lane.id, lane.clean]), [
    ['owner-a', true], ['owner-b', false], ['integration', false],
  ])
})

test('a findings verdict rotates an exhausted generation before retiring authorization', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  const generationsPath = join(root, '.git', 'review-findings', 'lane-generations')
  const generations = JSON.parse(await readFile(generationsPath, 'utf8'))
  generations['owner-b'].revision = Number.MAX_SAFE_INTEGER
  await writeFile(generationsPath, JSON.stringify(generations))
  await recordAll(root)
  await verifyAndFinalize(root)
  const captured = await reviewStatus(root)
  const capturedOwnerB = captured.lanes.find(lane => lane.id === 'owner-b')

  await assert.rejects(
    () => recordLane(root, 'owner-b', 'finding\nVERDICT: FINDINGS PRESENT\n', captured),
    /retired review lane\(s\): owner-b, integration/u,
  )

  const rotated = JSON.parse(await readFile(generationsPath, 'utf8'))
  assert.notEqual(rotated['owner-b'].epoch, generations['owner-b'].epoch)
  assert.equal(rotated['owner-b'].revision, 0)
  assert.equal(await readReviewVerdict(root), undefined)
  const status = await reviewStatus(root)
  assert.notEqual(status.lanes.find(lane => lane.id === 'owner-b').fingerprint, capturedOwnerB.fingerprint)
  assert.deepEqual(status.lanes.map(lane => [lane.id, lane.clean]), [
    ['owner-a', true], ['owner-b', false], ['integration', false],
  ])
  await assert.rejects(
    () => recordLane(root, 'owner-b', CLEAN_EVIDENCE, captured),
    /review lane owner-b changed while/u,
  )
})

test('an unreadable report path does not retire valid lane evidence', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  const captured = await reviewStatus(root)
  const ownerB = captured.lanes.find(lane => lane.id === 'owner-b')
  await assert.rejects(
    () => recordReviewLaneVerdict(root, {
      lane: 'owner-b',
      evidence: join(root, '.git', 'reports', 'missing.txt'),
      expectHead: captured.head,
      expectFingerprint: ownerB.fingerprint,
    }),
    /independent review evidence cannot be read/u,
  )
  assert.deepEqual((await reviewStatus(root)).lanes.map(lane => lane.clean), [true, true, true])
})

test('a findings verdict cannot revive after temporary lane drift', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  const captured = await reviewStatus(root)
  await writeFile(join(root, 'b.txt'), 'b1\n')
  await assert.rejects(
    () => recordLane(root, 'owner-b', 'review interrupted\nVERDICT: INCOMPLETE\n', captured),
    /retired review lane\(s\): owner-b, integration/u,
  )
  await writeFile(join(root, 'b.txt'), 'b0\n')
  const restored = await reviewStatus(root)
  assert.deepEqual(restored.lanes.map(lane => [lane.id, lane.clean]), [
    ['owner-a', true], ['owner-b', false], ['integration', false],
  ])
  await checkReviewLedger(root, { verify: async () => {} })
  await assert.rejects(() => finalizeReviewVerdict(root), /review lanes are incomplete: owner-b, integration/u)
})

test('a concurrent negative verdict is serialized after an older clean recorder and wins', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  const captured = await reviewStatus(root)
  const ownerB = captured.lanes.find(lane => lane.id === 'owner-b')
  let pauseClean
  let resumeClean
  const cleanPaused = new Promise(resolve => { pauseClean = resolve })
  const cleanMayResume = new Promise(resolve => { resumeClean = resolve })
  const clean = recordReviewLaneVerdict(root, {
    lane: 'owner-b',
    evidence: await evidenceFile(root),
    expectHead: captured.head,
    expectFingerprint: ownerB.fingerprint,
    beforeLaneVerdictWrite: async () => {
      pauseClean()
      await cleanMayResume
    },
  })
  await cleanPaused
  let negativeSettled = false
  const negative = recordLane(root, 'owner-b', 'finding\nVERDICT: FINDINGS PRESENT\n', captured)
    .then(
      () => { negativeSettled = true },
      error => { negativeSettled = true; throw error },
    )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(negativeSettled, false)
  resumeClean()
  await clean
  await assert.rejects(() => negative, /retired review lane\(s\): owner-b, integration/u)
  await assert.rejects(
    () => recordLane(root, 'owner-b', CLEAN_EVIDENCE, captured),
    /review lane owner-b changed while/u,
  )
  const status = await reviewStatus(root)
  assert.deepEqual(status.lanes.map(lane => [lane.id, lane.clean]), [
    ['owner-a', true], ['owner-b', false], ['integration', false],
  ])
  await recordLane(root, 'owner-b')
  assert.equal((await reviewStatus(root)).lanes.find(lane => lane.id === 'owner-b').clean, true)
})

test('clearing and rebuilding review state does not revive pre-retirement clean evidence', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  const captured = await reviewStatus(root)
  await assert.rejects(
    () => recordLane(root, 'owner-b', 'finding\nVERDICT: FINDINGS PRESENT\n', captured),
    /retired review lane\(s\): owner-b, integration/u,
  )
  await clearReviewVerdict(root)
  await recordReviewPlan(root, { base: captured.base })
  const rebuilt = await reviewStatus(root)
  assert.equal(
    rebuilt.lanes.find(lane => lane.id === 'owner-a').fingerprint,
    captured.lanes.find(lane => lane.id === 'owner-a').fingerprint,
  )
  assert.notEqual(
    rebuilt.lanes.find(lane => lane.id === 'owner-b').fingerprint,
    captured.lanes.find(lane => lane.id === 'owner-b').fingerprint,
  )
  await assert.rejects(
    () => recordLane(root, 'owner-b', CLEAN_EVIDENCE, captured),
    /review lane owner-b changed while/u,
  )
})

test('a negative report invalidates a lane temporarily removed from the plan', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  const captured = await reviewStatus(root)
  const revised = plan()
  revised.obligations[1] = {
    ...revised.obligations[1], disposition: 'excluded', reason: 'Temporarily outside the plan.',
  }
  revised.lanes = revised.lanes.filter(lane => lane.id !== 'owner-b')
    .map(lane => lane.id === 'integration' ? { ...lane, dependsOn: [] } : lane)
  await writePlan(root, revised)
  await recordReviewPlan(root)
  const unknownLaneEvidence = await evidenceFile(root, 'finding\nVERDICT: FINDINGS PRESENT\n')
  await assert.rejects(
    () => recordReviewLaneVerdict(root, {
      lane: 'owner-typo',
      evidence: unknownLaneEvidence,
      expectHead: captured.head,
      expectFingerprint: captured.lanes.find(lane => lane.id === 'owner-b').fingerprint,
    }),
    /has no recorded invalidation generation/u,
  )
  await assert.rejects(
    () => recordLane(root, 'owner-b', 'finding\nVERDICT: FINDINGS PRESENT\n', captured),
    /retired review lane\(s\): owner-b/u,
  )
  await writePlan(root)
  await recordReviewPlan(root)
  await assert.rejects(
    () => recordLane(root, 'owner-b', CLEAN_EVIDENCE, captured),
    /review lane owner-b changed while/u,
  )
})

test('parallel recording accepts unrelated edits but rejects a changed dependency input', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  const captured = await reviewStatus(root)
  await writeFile(join(root, 'b.txt'), 'b1\n')
  await recordLane(root, 'owner-a', CLEAN_EVIDENCE, captured)
  await assert.rejects(
    () => recordLane(root, 'integration', CLEAN_EVIDENCE, captured),
    /review lane integration changed while/u,
  )
})

test('parallel recording survives an unrelated HEAD advance', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  const captured = await reviewStatus(root)
  await writeFile(join(root, 'a.txt'), 'a1\n')
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '-m', 'advance unrelated owner'])
  const recorded = await recordLane(root, 'owner-b', CLEAN_EVIDENCE, captured)
  assert.equal(recorded.verdict.reviewedHead, captured.head)
  assert.equal((await reviewStatus(root)).lanes.find(lane => lane.id === 'owner-b').clean, true)
  await assert.rejects(
    () => recordLane(root, 'owner-a', CLEAN_EVIDENCE, captured),
    /review lane owner-a changed while/u,
  )
})

test('a plan revision preserves lanes whose declared slice and dependency inputs are unchanged', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  const revised = plan()
  revised.obligations[1] = { ...revised.obligations[1], description: 'A revised owner B obligation.' }
  await writePlan(root, revised)
  await recordReviewPlan(root)
  const status = await reviewStatus(root)
  assert.deepEqual(status.lanes.map(lane => [lane.id, lane.clean]), [
    ['owner-a', true], ['owner-b', false], ['integration', false],
  ])
})

test('plan revision keeps the original base after HEAD advances', async (t) => {
  const root = await repository(t)
  const base = headOf(root)
  await writeFile(join(root, 'a.txt'), 'a1\n')
  await installPlan(root)
  await recordAll(root)
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '-m', 'advance'])
  const revised = plan()
  revised.obligations[1] = { ...revised.obligations[1], description: 'Revised owner B obligation.' }
  await writePlan(root, revised)
  const recorded = await recordReviewPlan(root)
  assert.equal(recorded.plan.base, base)
  assert.deepEqual((await reviewStatus(root)).lanes.map(lane => lane.clean), [true, false, false])
  revised.lanes[0] = { ...revised.lanes[0], paths: ['b.txt'] }
  await writePlan(root, revised)
  await assert.rejects(() => recordReviewPlan(root), /does not cover changed path\(s\): a.txt/u)
})

test('active plan drift blocks every stale conclusion until the revision is recorded', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await verifyAndFinalize(root)
  const captured = await reviewStatus(root)
  const revised = plan()
  revised.obligations[1] = { ...revised.obligations[1], description: 'A revised owner B obligation.' }
  await writePlan(root, revised)

  await assert.rejects(() => reviewStatus(root), /REVIEW_PLAN\.json changed after it was recorded/u)
  await assert.rejects(() => recordLane(root, 'owner-a', CLEAN_EVIDENCE, captured), /REVIEW_PLAN\.json changed after it was recorded/u)
  await assert.rejects(() => finalizeReviewVerdict(root), /REVIEW_PLAN\.json changed after it was recorded/u)
  await assert.rejects(() => preCommitReviewLedger(root), /REVIEW_PLAN\.json changed after it was recorded/u)

  await assert.rejects(
    () => recordLane(root, 'owner-a', 'review interrupted\nVERDICT: INCOMPLETE\n', captured),
    /retired review lane\(s\): owner-a/u,
  )
  await writePlan(root)
  assert.equal((await reviewStatus(root)).lanes.find(lane => lane.id === 'owner-a').clean, false)
  await writePlan(root, revised)

  const rerecorded = await recordReviewPlan(root)
  assert.equal(rerecorded.plan.base, headOf(root))
  const status = await reviewStatus(root)
  assert.deepEqual(status.lanes.map(lane => [lane.id, lane.clean]), [
    ['owner-a', false], ['owner-b', false], ['integration', false],
  ])
})

test('active plan validation rejects missing and malformed files but ignores formatting changes', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await writePlan(root, plan(), 2)
  assert.equal((await reviewStatus(root)).state, 'clean')

  await unlink(join(root, 'REVIEW_PLAN.json'))
  await assert.rejects(() => reviewStatus(root), /REVIEW_PLAN\.json is missing/u)
  await writeFile(join(root, 'REVIEW_PLAN.json'), '{not json}\n')
  await assert.rejects(() => reviewStatus(root), /REVIEW_PLAN\.json is invalid/u)
})

test('new changed paths force an explicit plan revision instead of silently expanding a lane', async (t) => {
  const root = await repository(t)
  await writeFile(join(root, 'unplanned.txt'), 'new\n')
  await assert.rejects(() => installPlan(root), /does not cover changed path\(s\): unplanned.txt/u)
})

test('raw Git path bytes distinguish same-content filenames and changed-path coverage', async (t) => {
  const root = await repository(t)
  if (usesWindowsGitPathSemantics(root)) {
    t.skip('The active Git cannot represent arbitrary POSIX filename bytes')
    return
  }
  const first = await writeRawFilenameFixture(root, Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xff]), 'same\n')
  if (first === undefined) {
    t.skip('The active filesystem cannot represent arbitrary POSIX filename bytes')
    return
  }
  const singleLanePlan = plan({ obligations: [plan().obligations[0], ...plan().obligations.slice(3)], lanes: [
    { ...plan().lanes[0], paths: ['.'] },
  ] })
  await installPlan(root, singleLanePlan)
  await recordLane(root, 'owner-a')
  const before = await reviewStatus(root)
  await unlink(first)
  const second = await writeRawFilenameFixture(root, Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xfe]), 'same\n')
  assert.ok(second)
  const after = await reviewStatus(root)
  assert.notEqual(after.fingerprint, before.fingerprint)
  assert.notEqual(after.lanes[0].fingerprint, before.lanes[0].fingerprint)
  assert.equal(after.lanes[0].clean, false)
  await checkReviewLedger(root, { verify: async () => {} })
  await assert.rejects(() => finalizeReviewVerdict(root), /review lanes are incomplete: owner-a/u)

  singleLanePlan.lanes[0] = { ...singleLanePlan.lanes[0], paths: ['a.txt'] }
  await writePlan(root, singleLanePlan)
  await assert.rejects(() => recordReviewPlan(root), /raw Git path 0x7261772d(?:ff|fe)/u)
})

test('misassigned lane metadata cannot authorize the final gate', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await verifyAndFinalize(root)
  const filename = join(root, '.git', 'review-findings', 'lanes', 'owner-b.json')
  const verdict = JSON.parse(await readFile(filename, 'utf8'))
  await writeFile(filename, JSON.stringify({ ...verdict, lane: 'owner-a' }))
  const status = await reviewStatus(root)
  assert.equal(status.lanes.find(lane => lane.id === 'owner-a').clean, true)
  assert.equal(status.lanes.find(lane => lane.id === 'owner-b').clean, false)
  await assert.rejects(() => finalizeReviewVerdict(root), /review lanes are incomplete: owner-b/u)
  await assert.rejects(() => preCommitReviewLedger(root), /review lanes are no longer effective: owner-b/u)
})

test('malformed recorded review metadata cannot be accepted as clean', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await verifyAndFinalize(root)
  const statePath = join(root, '.git', 'review-findings', 'plan')
  const generationsPath = join(root, '.git', 'review-findings', 'lane-generations')
  const state = await readFile(statePath, 'utf8')
  await writeFile(statePath, '{bad json}\n')
  await assert.rejects(() => reviewStatus(root), /review plan state is malformed/u)
  await assert.rejects(() => finalizeReviewVerdict(root), /review plan state is malformed/u)
  await assert.rejects(() => preCommitReviewLedger(root), /review plan state is malformed/u)
  const semanticallyTampered = JSON.parse(state)
  semanticallyTampered.plan.obligations[0].description = 'Changed under the recorded hash.'
  await writeFile(statePath, JSON.stringify(semanticallyTampered))
  await assert.rejects(() => reviewStatus(root), /review plan state is malformed/u)
  await assert.rejects(() => finalizeReviewVerdict(root), /review plan state is malformed/u)
  await assert.rejects(() => preCommitReviewLedger(root), /review plan state is malformed/u)
  await writeFile(statePath, state)
  const generations = await readFile(generationsPath, 'utf8')
  await writeFile(generationsPath, JSON.stringify({ 'owner-a': -1 }))
  await assert.rejects(() => reviewStatus(root), /review lane generations are malformed/u)
  await assert.rejects(() => finalizeReviewVerdict(root), /review lane generations are malformed/u)
  await assert.rejects(() => preCommitReviewLedger(root), /review lane generations are malformed/u)
  await writeFile(generationsPath, generations)
  const partialGenerations = JSON.parse(generations)
  delete partialGenerations['owner-b']
  await writeFile(generationsPath, JSON.stringify(partialGenerations))
  await assert.rejects(() => reviewStatus(root), /generations are missing lane owner-b/u)
  await assert.rejects(() => finalizeReviewVerdict(root), /generations are missing lane owner-b/u)
  await assert.rejects(() => preCommitReviewLedger(root), /generations are missing lane owner-b/u)
  await writeFile(generationsPath, generations)
  const lanePath = join(root, '.git', 'review-findings', 'lanes', 'owner-b.json')
  await writeFile(lanePath, '{bad json}\n')
  const status = await reviewStatus(root)
  assert.equal(status.lanes.find(lane => lane.id === 'owner-b').clean, false)
  await checkReviewLedger(root, { verify: async () => {} })
  await assert.rejects(() => finalizeReviewVerdict(root), /review lanes are incomplete: owner-b/u)
})

test('missing generation state cannot revive a pre-retirement clean report', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await verifyAndFinalize(root)
  const verdictPath = join(root, '.git', 'review-findings', 'verdict')
  const oldVerdict = await readFile(verdictPath, 'utf8')
  const captured = await reviewStatus(root)
  await assert.rejects(
    () => recordLane(root, 'owner-b', 'finding\nVERDICT: FINDINGS PRESENT\n', captured),
    /retired review lane\(s\): owner-b, integration/u,
  )
  await unlink(join(root, '.git', 'review-findings', 'lane-generations'))
  await assert.rejects(() => reviewStatus(root), /review lane generations are missing/u)
  await assert.rejects(() => recordLane(root, 'owner-b', CLEAN_EVIDENCE, captured), /review lane generations are missing/u)
  await checkReviewLedger(root, { verify: async () => {} })
  await assert.rejects(() => finalizeReviewVerdict(root), /review lane generations are missing/u)
  await writeFile(verdictPath, oldVerdict)
  await assert.rejects(() => preCommitReviewLedger(root), /review lane generations are missing/u)
  await clearReviewVerdict(root)
  await recordReviewPlan(root, { base: captured.base })
  const rebuilt = await reviewStatus(root)
  assert.notEqual(
    rebuilt.lanes.find(lane => lane.id === 'owner-b').fingerprint,
    captured.lanes.find(lane => lane.id === 'owner-b').fingerprint,
  )
  await assert.rejects(
    () => recordLane(root, 'owner-b', CLEAN_EVIDENCE, captured),
    /review lane owner-b changed while/u,
  )
})

test('clear removes malformed generation state so plan reconstruction can create a new epoch', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  const before = await reviewStatus(root)
  await writeFile(join(root, '.git', 'review-findings', 'lane-generations'), '{bad json}\n')
  await assert.rejects(() => reviewStatus(root), /review lane generations are malformed/u)
  await clearReviewVerdict(root)
  await recordReviewPlan(root, { base: before.base })
  const rebuilt = await reviewStatus(root)
  assert.notEqual(rebuilt.lanes[0].fingerprint, before.lanes[0].fingerprint)
})

test('finalization directly rejects missing, malformed, stale, and changing proofs', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  const proofPath = join(root, '.git', 'review-findings', 'verified-tree')
  const verdictPath = join(root, '.git', 'review-findings', 'verdict')
  const status = await reviewStatus(root)

  await assert.rejects(() => finalizeReviewVerdict(root), /no review verification proof exists/u)
  await writeFile(proofPath, '{bad json}\n')
  await assert.rejects(() => finalizeReviewVerdict(root), /verification proof is malformed/u)
  await writeFile(proofPath, JSON.stringify({ head: '0'.repeat(40), fingerprint: status.fingerprint }))
  await assert.rejects(() => finalizeReviewVerdict(root), /does not belong to the current HEAD/u)
  await writeFile(proofPath, JSON.stringify({ head: status.head, fingerprint: '0'.repeat(40) }))
  await assert.rejects(() => finalizeReviewVerdict(root), /source tree changed after npm run check/u)

  await checkReviewLedger(root, { verify: async () => {} })
  let calls = 0
  await assert.rejects(
    () => finalizeReviewVerdict(root, {
      fingerprint: async () => (++calls === 1 ? status.fingerprint : 'f'.repeat(40)),
    }),
    /candidate changed while/u,
  )
  await assert.rejects(() => readFile(verdictPath), error => error?.code === 'ENOENT')

  let headCalls = 0
  await assert.rejects(
    () => finalizeReviewVerdict(root, {
      head: () => (++headCalls === 1 ? status.head : 'f'.repeat(40)),
    }),
    /(?:candidate changed while|review plan base is not an ancestor)/u,
  )
  await assert.rejects(() => readFile(verdictPath), error => error?.code === 'ENOENT')

  await checkReviewLedger(root, { verify: async () => {} })
  await assert.rejects(
    () => finalizeReviewVerdict(root, {
      beforeFinalizationRevalidation: () => writeFile(proofPath, JSON.stringify({
        head: status.head,
        fingerprint: 'e'.repeat(40),
      })),
    }),
    /verification proof changed while/u,
  )
  await assert.rejects(() => readFile(verdictPath), error => error?.code === 'ENOENT')
})

test('finalization final reads reject hook-time tree and HEAD changes', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await checkReviewLedger(root, { verify: async () => {} })
  const snapshot = await sourceTreeSnapshot(root)
  const verdictPath = join(root, '.git', 'review-findings', 'verdict')

  await assert.rejects(
    () => finalizeReviewVerdict(root, {
      snapshot,
      beforeFinalizationRevalidation: () => writeFile(join(root, 'a.txt'), 'a1\n'),
    }),
    /candidate changed while/u,
  )
  await assert.rejects(() => readFile(verdictPath), error => error?.code === 'ENOENT')

  await writeFile(join(root, 'a.txt'), 'a0\n')
  await checkReviewLedger(root, { verify: async () => {} })
  await assert.rejects(
    () => finalizeReviewVerdict(root, {
      snapshot,
      beforeFinalizationRevalidation: () => {
        git(root, ['commit', '--quiet', '--allow-empty', '-m', 'concurrent head'])
      },
    }),
    /candidate changed while/u,
  )
  await assert.rejects(() => readFile(verdictPath), error => error?.code === 'ENOENT')
})

test('pre-commit serializes negative retirement and revalidates active-plan drift', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await verifyAndFinalize(root)
  git(root, ['add', '--all'])
  const captured = await reviewStatus(root)
  let pauseGate
  let resumeGate
  const gatePaused = new Promise(resolve => { pauseGate = resolve })
  const gateMayResume = new Promise(resolve => { resumeGate = resolve })
  const gate = preCommitReviewLedger(root, {
    beforeReviewGateReturn: async () => {
      pauseGate()
      await gateMayResume
    },
  })
  await gatePaused
  let negativeSettled = false
  const negative = recordLane(root, 'owner-b', 'finding\nVERDICT: FINDINGS PRESENT\n', captured)
    .then(
      () => { negativeSettled = true },
      error => { negativeSettled = true; throw error },
    )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(negativeSettled, false)
  resumeGate()
  assert.equal((await gate).state, 'verified')
  await assert.rejects(() => negative, /retired review lane\(s\): owner-b, integration/u)

  await recordLane(root, 'owner-b')
  await recordLane(root, 'integration')
  await verifyAndFinalize(root)
  const revised = plan()
  revised.obligations[0] = { ...revised.obligations[0], description: 'Concurrent plan drift.' }
  await assert.rejects(
    () => preCommitReviewLedger(root, {
      beforeReviewGateReturn: () => writePlan(root, revised),
    }),
    /REVIEW_PLAN\.json changed after it was recorded/u,
  )
})

test('pre-commit final reads reject hook-time proof, index, lane, and tree changes', async (t) => {
  async function prepared() {
    const root = await repository(t)
    await installPlan(root)
    await recordAll(root)
    await verifyAndFinalize(root)
    git(root, ['add', '--all'])
    return root
  }

  const proofRoot = await prepared()
  const proofPath = join(proofRoot, '.git', 'review-findings', 'verified-tree')
  await assert.rejects(
    () => preCommitReviewLedger(proofRoot, {
      beforeReviewGateReturn: () => writeFile(proofPath, JSON.stringify({
        head: headOf(proofRoot), fingerprint: 'e'.repeat(40),
      })),
    }),
    /review state changed while/u,
  )

  const indexRoot = await prepared()
  await assert.rejects(
    () => preCommitReviewLedger(indexRoot, {
      beforeReviewGateReturn: () => { git(indexRoot, ['update-index', '--chmod=+x', 'a.txt']) },
    }),
    /review state changed while/u,
  )

  const laneRoot = await prepared()
  const lanePath = join(laneRoot, '.git', 'review-findings', 'lanes', 'owner-b.json')
  const lane = JSON.parse(await readFile(lanePath, 'utf8'))
  await assert.rejects(
    () => preCommitReviewLedger(laneRoot, {
      beforeReviewGateReturn: () => writeFile(lanePath, JSON.stringify({ ...lane, lane: 'owner-a' })),
    }),
    /review state changed while/u,
  )

  const treeRoot = await prepared()
  await assert.rejects(
    () => preCommitReviewLedger(treeRoot, {
      beforeReviewGateReturn: () => writeFile(join(treeRoot, 'a.txt'), 'a1\n'),
    }),
    /review state changed while/u,
  )
})

test('tampered lane evidence blocks finalization without invalidating unrelated lane evidence', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  const recordedA = await recordLane(root, 'owner-a')
  await recordLane(root, 'owner-b')
  await recordLane(root, 'integration')
  const ownerB = (await reviewStatus(root)).lanes.find(lane => lane.id === 'owner-b').verdict
  await writeFile(join(root, '.git', 'review-findings', 'evidence', ownerB.evidence.name), 'tampered\nVERDICT: NO FINDINGS\n')
  const status = await reviewStatus(root)
  assert.equal(status.lanes.find(lane => lane.id === 'owner-a').clean, true)
  assert.equal(status.lanes.find(lane => lane.id === 'owner-b').clean, false)
  assert.equal(await readFile(recordedA.evidencePath, 'utf8'), CLEAN_EVIDENCE)
  await checkReviewLedger(root, { verify: async () => {} })
  await assert.rejects(() => finalizeReviewVerdict(root), /review lanes are incomplete: owner-b/u)
})

test('same-content evidence from another lane cannot satisfy verdict identity', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await verifyAndFinalize(root)
  const status = await reviewStatus(root)
  const ownerA = status.lanes.find(lane => lane.id === 'owner-a').verdict
  const ownerB = status.lanes.find(lane => lane.id === 'owner-b').verdict
  assert.equal(ownerA.evidence.sha256, ownerB.evidence.sha256)
  const ownerBPath = join(root, '.git', 'review-findings', 'lanes', 'owner-b.json')
  await writeFile(ownerBPath, JSON.stringify({ ...ownerB, evidence: ownerA.evidence }))
  assert.equal((await reviewStatus(root)).lanes.find(lane => lane.id === 'owner-b').clean, false)
  await assert.rejects(() => finalizeReviewVerdict(root), /review lanes are incomplete: owner-b/u)
  await assert.rejects(() => preCommitReviewLedger(root), /review lanes are no longer effective: owner-b/u)
})

test('the aggregate verdict is bound to the final proof while lane evidence survives a moved HEAD', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await verifyAndFinalize(root)
  await writeFile(join(root, 'a.txt'), 'a1\n')
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '-m', 'advance'])
  await assert.rejects(() => preCommitReviewLedger(root), /HEAD moved after npm run check/u)
  const status = await reviewStatus(root)
  assert.equal(status.lanes.find(lane => lane.id === 'owner-b').clean, true)
  assert.equal(status.lanes.find(lane => lane.id === 'owner-a').clean, false)
})

test('the gate rejects a missing plan, missing aggregate, source changes, and partial staging', async (t) => {
  const root = await repository(t)
  await checkReviewLedger(root, { verify: async () => {} })
  await assert.rejects(() => finalizeReviewVerdict(root), /no review plan exists/u)
  await installPlan(root)
  await recordAll(root)
  await assert.rejects(() => preCommitReviewLedger(root), /no composite clean review verdict exists/u)
  await verifyAndFinalize(root)
  await writeFile(join(root, 'a.txt'), 'a1\n')
  await assert.rejects(() => preCommitReviewLedger(root), /source tree changed after npm run check/u)

  await recordLane(root, 'owner-a')
  await checkReviewLedger(root, { verify: async () => {} })
  await finalizeReviewVerdict(root)
  await assert.rejects(() => preCommitReviewLedger(root), /staged tree differs/u)
  git(root, ['add', '--all'])
  assert.equal((await preCommitReviewLedger(root)).state, 'verified')
})

test('the gate rejects structurally valid aggregate identity tampering', async (t) => {
  const root = await repository(t)
  await installPlan(root)
  await recordAll(root)
  await verifyAndFinalize(root)
  git(root, ['add', '--all'])
  const verdictPath = join(root, '.git', 'review-findings', 'verdict')
  const original = JSON.parse(await readFile(verdictPath, 'utf8'))

  await writeFile(verdictPath, JSON.stringify({ ...original, planHash: '0'.repeat(64) }))
  await assert.rejects(() => preCommitReviewLedger(root), /different review plan/u)
  await writeFile(verdictPath, JSON.stringify({ ...original, lanes: original.lanes.slice(0, -1) }))
  await assert.rejects(() => preCommitReviewLedger(root), /does not match the effective review lanes/u)
  const lanes = structuredClone(original.lanes)
  lanes[0].evidence.sha256 = '0'.repeat(64)
  await writeFile(verdictPath, JSON.stringify({ ...original, lanes }))
  await assert.rejects(() => preCommitReviewLedger(root), /does not match the effective review lanes/u)
})

test('the aggregate reader rejects the retired single-report schema', async (t) => {
  const root = await repository(t)
  const filename = join(root, '.git', 'review-findings', 'verdict')
  await mkdir(join(root, '.git', 'review-findings'), { recursive: true })
  await writeFile(filename, JSON.stringify({
    schema: 'dsh-review-verdict/v1', status: 'clean', head: headOf(root), fingerprint: 'a'.repeat(40),
    base: headOf(root), evidence: { name: 'old.txt', sha256: 'a'.repeat(64) },
  }))
  await assert.rejects(() => readReviewVerdict(root), /review verdict is malformed/u)
})
