import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { npmCliCommand } from './npm-cli.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_PATH = path.resolve(SCRIPT_DIRECTORY, '../.agents/templates/REVIEW_FINDINGS.md')
export const ACTIVE_LEDGER = 'REVIEW_FINDINGS.md'
export const REVIEW_PLAN_TEMPLATE_PATH = path.resolve(SCRIPT_DIRECTORY, '../.agents/templates/REVIEW_PLAN.json')
export const ACTIVE_REVIEW_PLAN = 'REVIEW_PLAN.json'
const VERIFICATION_PROOF = 'review-findings/verified-tree'
const VERIFICATION_VERDICT = 'review-findings/verdict'
const REVIEW_PLAN_STATE = 'review-findings/plan'
const REVIEW_LANE_DIRECTORY = 'review-findings/lanes'
const REVIEW_LANE_GENERATIONS = 'review-findings/lane-generations'
const VERDICT_EVIDENCE_DIRECTORY = 'review-findings/evidence'
const REVIEW_STATE_LOCK = 'review-findings/state.lock'
const REVIEW_LOCK_HELD = Symbol('reviewLockHeld')
const REVIEW_LOCK_RETRY_MS = 25
const REVIEW_LOCK_TIMEOUT_MS = 30_000
const STANDARD_REVIEW_OBLIGATIONS = new Set([
  'intrinsic-handling',
  'scope-and-declaration-ownership',
  'callable-reconstruction',
  'module-and-cross-entry-contracts',
  'historical-semantics-and-recovery',
])
const PLAN_SCHEMA = 'dsh-review-plan/v1'
const PLAN_STATE_SCHEMA = 'dsh-review-plan-state/v1'
const LANE_VERDICT_SCHEMA = 'dsh-review-lane-verdict/v1'
const VERDICT_SCHEMA = 'dsh-review-verdict/v2'
const CLEAN_VERDICT_MARKER = 'VERDICT: NO FINDINGS'
const PLAN_FIELDS = new Set(['schema', 'obligations', 'lanes'])
const OBLIGATION_FIELDS = new Set(['id', 'description', 'disposition', 'reason'])
const LANE_FIELDS = new Set([
  'id', 'scope', 'paths', 'dependsOn', 'obligations', 'owners', 'consumers', 'counterexamples',
])
const PLAN_STATE_FIELDS = new Set(['schema', 'base', 'planHash', 'plan'])
const LANE_VERDICT_FIELDS = new Set(['schema', 'status', 'lane', 'fingerprint', 'reviewedHead', 'base', 'evidence'])
const VERDICT_FIELDS = new Set(['schema', 'status', 'head', 'fingerprint', 'base', 'planHash', 'lanes'])
const AGGREGATE_LANE_FIELDS = new Set(['id', 'fingerprint', 'evidence'])
const VERDICT_EVIDENCE_FIELDS = new Set(['name', 'sha256'])
const TERMINAL_STATUSES = new Set(['resolved', 'invalid', 'accepted'])
const FINDING_STATUSES = new Set(['unresolved', ...TERMINAL_STATUSES])
const PLACEHOLDER_FIELDS = new Set(['owner', 'condition', 'impact', 'requiredOutcome'])

function git(root, args, { allowFailure = false, env, input } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    ...(input === undefined ? {} : { input }),
  })
  if (result.status === 0) return result.stdout.trim()
  if (allowFailure) return undefined
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
  throw new Error(`git ${args.join(' ')} failed: ${detail}`)
}

function gitBytes(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 })
  if (result.status === 0) return result.stdout
  const detail = result.stderr.toString('utf8').trim() || `exit ${result.status}`
  throw new Error(`git ${args.join(' ')} failed: ${detail}`)
}

function splitGitRecords(bytes) {
  const records = []
  let start = 0
  for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
    if (end > start) records.push(bytes.subarray(start, end))
    start = end + 1
  }
  return records
}

function joinGitRecords(records) {
  return Buffer.concat(records.flatMap(record => [record, Buffer.from([0])]))
}

function gitRelativePath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/')
}

function relativeGitPath(from, absolute) {
  return path.relative(from, absolute).split(path.sep).join('/')
}

function gitConfigPath(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    .replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('\b', '\\b')}"`
}

function gitPathKey(record) {
  return record.toString('base64')
}

function frontmatter(text, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match === null) throw new Error(`${label} must start with YAML frontmatter`)
  const document = parseDocument(match[1], { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error(`${label} has invalid YAML: ${document.errors[0].message}`)
  const value = document.toJS({ mapAsMap: false })
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} frontmatter must be an object`)
  }
  return value
}

function sameKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function reviewPlanHash(plan) {
  return sha256(stableJson(plan))
}

function stringArray(value, label, { empty = false } = {}) {
  if (!Array.isArray(value) || (!empty && value.length === 0)
    || value.some(item => !nonEmptyString(item))) {
    throw new Error(`${label} must be ${empty ? 'an' : 'a non-empty'} array of non-empty strings`)
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`)
  return value
}

function reviewPath(value, label) {
  if (value === '.') return value
  if (value.includes('\\') || value.startsWith('/') || value.includes('\0')) {
    throw new Error(`${label} must be a checkout-relative POSIX path or directory prefix`)
  }
  const normalized = path.posix.normalize(value)
  if (normalized !== value || value.split('/').includes('..')) {
    throw new Error(`${label} must be normalized and cannot escape the checkout`)
  }
  return value
}

function reviewLaneOrder(plan) {
  const lanes = new Map(plan.lanes.map(lane => [lane.id, lane]))
  const visiting = new Set(), visited = new Set(), order = []
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`review plan lane dependency cycle includes ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of lanes.get(id).dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
    order.push(id)
  }
  for (const lane of plan.lanes) visit(lane.id)
  return order
}

export function parseReviewPlan(text, { template = false } = {}) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`review plan has invalid JSON: ${error.message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !sameKeys(value, PLAN_FIELDS) || value.schema !== PLAN_SCHEMA
    || !Array.isArray(value.obligations) || value.obligations.length === 0
    || !Array.isArray(value.lanes) || value.lanes.length === 0) {
    throw new Error('review plan does not match the plan schema')
  }
  const obligations = new Map()
  for (const [index, obligation] of value.obligations.entries()) {
    const label = `review obligation at index ${index}`
    if (obligation === null || typeof obligation !== 'object' || Array.isArray(obligation)
      || !sameKeys(obligation, OBLIGATION_FIELDS)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(obligation.id)
      || obligations.has(obligation.id) || !nonEmptyString(obligation.description)
      || !['covered', 'excluded'].includes(obligation.disposition)) {
      throw new Error(`${label} is invalid`)
    }
    if (obligation.disposition === 'covered' && obligation.reason !== null) {
      throw new Error(`${label} must not give a reason when covered`)
    }
    if (obligation.disposition === 'excluded' && !nonEmptyString(obligation.reason)) {
      throw new Error(`${label} requires a reason when excluded`)
    }
    obligations.set(obligation.id, obligation)
  }
  const missingStandardObligations = [...STANDARD_REVIEW_OBLIGATIONS].filter(id => !obligations.has(id))
  if (missingStandardObligations.length > 0) {
    throw new Error(`review plan omits standard obligation(s): ${missingStandardObligations.join(', ')}`)
  }
  const lanes = new Map()
  for (const [index, lane] of value.lanes.entries()) {
    const label = `review lane at index ${index}`
    if (lane === null || typeof lane !== 'object' || Array.isArray(lane)
      || !sameKeys(lane, LANE_FIELDS) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lane.id)
      || lanes.has(lane.id) || !nonEmptyString(lane.scope)) {
      throw new Error(`${label} is invalid`)
    }
    stringArray(lane.paths, `${label} paths`).forEach((entry, pathIndex) => reviewPath(entry, `${label} path ${pathIndex}`))
    stringArray(lane.dependsOn, `${label} dependsOn`, { empty: true })
    stringArray(lane.obligations, `${label} obligations`)
    stringArray(lane.owners, `${label} owners`)
    stringArray(lane.consumers, `${label} consumers`)
    stringArray(lane.counterexamples, `${label} counterexamples`)
    if (!template && (lane.id === 'replace-me'
      || [lane.scope, ...lane.owners, ...lane.consumers, ...lane.counterexamples]
        .some(entry => entry.startsWith('Replace with')))) {
      throw new Error(`${label} still contains template placeholders`)
    }
    lanes.set(lane.id, lane)
  }
  for (const lane of value.lanes) {
    for (const dependency of lane.dependsOn) {
      if (!lanes.has(dependency) || dependency === lane.id) {
        throw new Error(`review lane ${lane.id} has invalid dependency ${dependency}`)
      }
    }
    for (const obligationId of lane.obligations) {
      const obligation = obligations.get(obligationId)
      if (obligation === undefined) throw new Error(`review lane ${lane.id} names unknown obligation ${obligationId}`)
      if (obligation.disposition !== 'covered') {
        throw new Error(`review lane ${lane.id} names excluded obligation ${obligationId}`)
      }
    }
  }
  for (const obligation of value.obligations) {
    const assigned = value.lanes.some(lane => lane.obligations.includes(obligation.id))
    if (obligation.disposition === 'covered' && !assigned) {
      throw new Error(`covered review obligation ${obligation.id} is not assigned to a lane`)
    }
    if (obligation.disposition === 'excluded' && assigned) {
      throw new Error(`excluded review obligation ${obligation.id} is assigned to a lane`)
    }
  }
  reviewLaneOrder(value)
  return Object.freeze(value)
}

export function parseReviewLedger(text, templateText, { template = false } = {}) {
  const shape = frontmatter(templateText, 'review findings template')
  const value = template ? shape : frontmatter(text, ACTIVE_LEDGER)
  const topLevelKeys = Object.keys(shape)
  const findingKeys = Object.keys(shape.findings?.[0] ?? {})
  if (!sameKeys(value, topLevelKeys) || value.schema !== shape.schema || !Array.isArray(value.findings)) {
    throw new Error(`${template ? 'review findings template' : ACTIVE_LEDGER} does not match the template schema`)
  }
  if (!['open', 'resolved'].includes(value.ledgerStatus)) {
    throw new Error('review findings ledgerStatus must be open or resolved')
  }
  if (value.findings.length === 0) throw new Error('review findings ledger must contain at least one finding')
  const ids = new Set()
  for (const [index, finding] of value.findings.entries()) {
    const label = `review finding at index ${index}`
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)
      || !sameKeys(finding, findingKeys)) {
      throw new Error(`${label} does not match the template schema`)
    }
    if (!nonEmptyString(finding.id) || ids.has(finding.id)) throw new Error(`${label} has an invalid or duplicate id`)
    ids.add(finding.id)
    if (!/^(?:P[0-3]|BLOCKER|HIGH|MEDIUM|LOW)$/.test(finding.severity)) {
      throw new Error(`${label} has an invalid severity`)
    }
    if (!FINDING_STATUSES.has(finding.status)) throw new Error(`${label} has an invalid status`)
    if (finding.status === 'accepted' && !nonEmptyString(finding.dispositionRef)) {
      throw new Error(`${label} requires dispositionRef for status accepted`)
    }
    if (finding.status !== 'accepted' && finding.dispositionRef !== null
      && finding.dispositionRef !== undefined) {
      throw new Error(`${label} has dispositionRef for status ${finding.status}`)
    }
    for (const key of PLACEHOLDER_FIELDS) {
      if (!nonEmptyString(finding[key])) throw new Error(`${label} is missing ${key}`)
      if (!template && finding[key] === shape.findings[0][key]) {
        throw new Error(`${label} still contains the template ${key}`)
      }
    }
    if (finding.implementationPlan !== null && finding.implementationPlan !== undefined
      && !nonEmptyString(finding.implementationPlan)) {
      throw new Error(`${label} has invalid implementationPlan`)
    }
    if (finding.status === 'resolved' && !nonEmptyString(finding.implementationPlan)) {
      throw new Error(`${label} requires implementationPlan for status resolved`)
    }
    if (TERMINAL_STATUSES.has(finding.status) && !nonEmptyString(finding.resolutionEvidence)) {
      throw new Error(`${label} requires resolutionEvidence for status ${finding.status}`)
    }
    if (finding.status === 'unresolved' && finding.resolutionEvidence !== null
      && finding.resolutionEvidence !== undefined && !nonEmptyString(finding.resolutionEvidence)) {
      throw new Error(`${label} has invalid resolutionEvidence`)
    }
  }
  const allTerminal = value.findings.every(finding => TERMINAL_STATUSES.has(finding.status))
  if (value.ledgerStatus === 'resolved' && !allTerminal) {
    throw new Error('resolved review ledger still contains unresolved findings')
  }
  if (value.ledgerStatus === 'open' && allTerminal) {
    throw new Error('review ledger has no unresolved findings; set ledgerStatus to resolved')
  }
  return Object.freeze({ ...value, allTerminal })
}

async function exists(filename) {
  try {
    await stat(filename)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function ensureLocalExclude(root) {
  const excludePath = git(root, ['rev-parse', '--git-path', 'info/exclude'])
  const absolute = path.resolve(root, excludePath)
  let text = ''
  if (await exists(absolute)) text = await readFile(absolute, 'utf8')
  const lines = new Set(text.split(/\r?\n/))
  const missing = [ACTIVE_LEDGER, ACTIVE_REVIEW_PLAN].filter(name => !lines.has(`/${name}`))
  if (missing.length === 0) return
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  await writeFile(absolute, `${text}${separator}${missing.map(name => `/${name}\n`).join('')}`)
}

function verificationProofPath(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', VERIFICATION_PROOF]))
}

function verificationVerdictPath(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', VERIFICATION_VERDICT]))
}

function reviewPlanStatePath(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', REVIEW_PLAN_STATE]))
}

function reviewLaneDirectory(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', REVIEW_LANE_DIRECTORY]))
}

function reviewLanePath(root, lane) {
  return path.join(reviewLaneDirectory(root), `${lane}.json`)
}

function reviewLaneGenerationsPath(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', REVIEW_LANE_GENERATIONS]))
}

function verdictEvidenceDirectory(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', VERDICT_EVIDENCE_DIRECTORY]))
}

function reviewStateLockPath(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', REVIEW_STATE_LOCK]))
}

async function acquireReviewStateLock(root, options = {}) {
  const lockPath = reviewStateLockPath(root)
  const ownerPath = path.join(lockPath, 'owner')
  const token = randomUUID()
  const started = Date.now()
  const timeoutMs = options.lockTimeoutMs ?? REVIEW_LOCK_TIMEOUT_MS
  const retryMs = options.lockRetryMs ?? REVIEW_LOCK_RETRY_MS
  await mkdir(path.dirname(lockPath), { recursive: true })
  while (true) {
    try {
      await mkdir(lockPath)
      try {
        await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`)
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      return async () => {
        let owner
        try {
          owner = JSON.parse(await readFile(ownerPath, 'utf8'))
        } catch {
          owner = undefined
        }
        if (owner?.token === token) await rm(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (Date.now() - started >= timeoutMs) {
        throw new Error('another review-state operation is still running; if it crashed, confirm no review command is active, remove the exact Git metadata state.lock directory, and retry')
      }
      await delay(retryMs)
    }
  }
}

async function withReviewStateLock(root, operation, options = {}) {
  const release = await acquireReviewStateLock(root, options)
  try {
    return await operation()
  } finally {
    await release()
  }
}

async function fileSha256(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex')
}

async function readReviewLaneGenerations(root, { allowMissing = false } = {}) {
  const filename = reviewLaneGenerationsPath(root)
  if (!await exists(filename)) {
    if (allowMissing) return new Map()
    throw new Error('review lane generations are missing; clear and record the review plan again')
  }
  let value
  try {
    value = JSON.parse(await readFile(filename, 'utf8'))
  } catch {
    throw new Error('review lane generations are malformed; clear and record the review plan again')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('review lane generations are malformed; clear and record the review plan again')
  }
  const generations = new Map()
  for (const [lane, generation] of Object.entries(value)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lane)
      || generation === null || typeof generation !== 'object' || Array.isArray(generation)
      || !sameKeys(generation, new Set(['epoch', 'revision']))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation.epoch)
      || !Number.isSafeInteger(generation.revision) || generation.revision < 0) {
      throw new Error('review lane generations are malformed; clear and record the review plan again')
    }
    generations.set(lane, Object.freeze({ epoch: generation.epoch, revision: generation.revision }))
  }
  return generations
}

async function writeReviewLaneGenerations(root, generations) {
  const filename = reviewLaneGenerationsPath(root)
  const temporary = `${filename}.tmp-${randomUUID()}`
  await mkdir(path.dirname(filename), { recursive: true })
  const value = Object.fromEntries([...generations].sort(([left], [right]) => left.localeCompare(right)))
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' })
    await rename(temporary, filename)
  } finally {
    await removeIfPresent(temporary)
  }
}

function objectId(value, label) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`invalid review verdict ${label}`)
  }
  return value
}

function normalizeEvidence(evidence, label = 'review verdict') {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)
    || !sameKeys(evidence, VERDICT_EVIDENCE_FIELDS)
    || !/^[a-z0-9][a-z0-9-]*-[0-9a-f]{64}\.txt$/i.test(evidence.name)
    || !/^[0-9a-f]{64}$/.test(evidence.sha256)) {
    throw new Error(`${label} is malformed`)
  }
  return evidence
}

function normalizeVerdict(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !sameKeys(value, VERDICT_FIELDS)
    || value.schema !== VERDICT_SCHEMA || value.status !== 'clean' || !/^[0-9a-f]{64}$/.test(value.planHash)
    || !Array.isArray(value.lanes) || value.lanes.length === 0) {
    throw new Error('review verdict is malformed')
  }
  objectId(value.head, 'head')
  objectId(value.fingerprint, 'fingerprint')
  objectId(value.base, 'scope base')
  const ids = new Set()
  for (const lane of value.lanes) {
    if (lane === null || typeof lane !== 'object' || Array.isArray(lane)
      || !sameKeys(lane, AGGREGATE_LANE_FIELDS) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lane.id)
      || ids.has(lane.id) || !/^[0-9a-f]{64}$/.test(lane.fingerprint)) {
      throw new Error('review verdict is malformed')
    }
    ids.add(lane.id)
    normalizeEvidence(lane.evidence)
  }
  return value
}

function normalizeLaneVerdict(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !sameKeys(value, LANE_VERDICT_FIELDS) || value.schema !== LANE_VERDICT_SCHEMA
    || value.status !== 'clean' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.lane)
    || !/^[0-9a-f]{64}$/.test(value.fingerprint)) {
    throw new Error('review lane verdict is malformed')
  }
  objectId(value.reviewedHead, 'reviewed head')
  objectId(value.base, 'scope base')
  normalizeEvidence(value.evidence, 'review lane verdict')
  return value
}

async function readReviewEvidence(filename) {
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    throw new Error(`independent review evidence cannot be read: ${error.message}`)
  }
  return text
}

function requireCleanEvidence(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  const last = lines.at(-1)
  if (last !== CLEAN_VERDICT_MARKER) {
    if (last === 'VERDICT: INCOMPLETE') {
      throw new Error('the independent review reported an incomplete verdict; the delivery gate stays closed')
    }
    if (lines.every(line => !/^VERDICT:/.test(line))) {
      throw new Error(`independent review evidence must end with "${CLEAN_VERDICT_MARKER}"`)
    }
    throw new Error(`the independent review did not end with "${CLEAN_VERDICT_MARKER}"`)
  }
  return text
}

async function readVerdict(root) {
  const filename = verificationVerdictPath(root)
  if (!await exists(filename)) return undefined
  let value
  try {
    value = JSON.parse(await readFile(filename, 'utf8'))
  } catch {
    throw new Error('review verdict is malformed; record it again')
  }
  return normalizeVerdict(value)
}

function normalizePlanState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !sameKeys(value, PLAN_STATE_FIELDS) || value.schema !== PLAN_STATE_SCHEMA
    || !/^[0-9a-f]{64}$/.test(value.planHash)) {
    throw new Error('review plan state is malformed; record the plan again')
  }
  objectId(value.base, 'scope base')
  const plan = parseReviewPlan(JSON.stringify(value.plan))
  if (reviewPlanHash(plan) !== value.planHash) {
    throw new Error('review plan state is malformed; record the plan again')
  }
  return Object.freeze({ ...value, plan })
}

async function readPlanState(root) {
  const filename = reviewPlanStatePath(root)
  if (!await exists(filename)) return undefined
  try {
    return normalizePlanState(JSON.parse(await readFile(filename, 'utf8')))
  } catch (error) {
    if (error.message.startsWith('review plan state')) throw error
    throw new Error('review plan state is malformed; record the plan again')
  }
}

async function readActiveReviewPlan(root) {
  const filename = path.join(root, ACTIVE_REVIEW_PLAN)
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${ACTIVE_REVIEW_PLAN} is missing; run npm run review:plan:new and record it`)
    }
    throw error
  }
  try {
    return parseReviewPlan(text)
  } catch (error) {
    throw new Error(`${ACTIVE_REVIEW_PLAN} is invalid: ${error.message}`)
  }
}

async function assertActiveReviewPlanMatches(root, state) {
  const active = await readActiveReviewPlan(root)
  if (reviewPlanHash(active) !== state.planHash) {
    throw new Error(`${ACTIVE_REVIEW_PLAN} changed after it was recorded; run npm run review:plan again`)
  }
}

async function readLaneVerdict(root, lane) {
  const filename = reviewLanePath(root, lane)
  if (!await exists(filename)) return undefined
  try {
    return normalizeLaneVerdict(JSON.parse(await readFile(filename, 'utf8')))
  } catch (error) {
    if (error.message === 'review lane verdict is malformed') throw error
    throw new Error('review lane verdict is malformed')
  }
}

async function removeIfPresent(filename) {
  try {
    await unlink(filename)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function sourceHead(root) {
  return git(root, ['rev-parse', 'HEAD'], { allowFailure: true }) ?? 'unborn'
}

export async function sourceTreeSnapshot(root, { base } = {}) {
  indexTreeFingerprint(root)
  // One tagged inventory retains raw filename bytes and distinguishes cached,
  // missing, untracked and deliberately unmaterialized worktree entries.
  const inventory = splitGitRecords(gitBytes(root, [
    'ls-files', '--cached', '--deleted', '--others', '--exclude-standard', '-t', '-z',
  ]))
  const skipWorktreePaths = new Set(inventory.filter(record => record[0] === 0x53)
    .map(record => gitPathKey(record.subarray(2))))
  const missingPaths = inventory.filter(record => record[0] === 0x52)
    .map(record => record.subarray(2)).filter(relative => !skipWorktreePaths.has(gitPathKey(relative)))
  const missingPathKeys = new Set(missingPaths.map(gitPathKey))
  const sourcePaths = inventory.map(record => record.subarray(2)).filter(relative => {
    const key = gitPathKey(relative)
    return !missingPathKeys.has(key) && !skipWorktreePaths.has(key)
  })
  // Rename detection would hide a staged rename's old path, leaving it in the scratch tree.
  const removedPaths = new Map(splitGitRecords(gitBytes(root, [
    'diff', '--cached', '--no-renames', '--diff-filter=D', '--name-only', '-z',
  ])).map(relative => [gitPathKey(relative), relative]))
  for (const relative of missingPaths) removedPaths.set(gitPathKey(relative), relative)
  const metadataDirectory = path.resolve(root, git(root, [
    'rev-parse', '--path-format=relative', '--git-path', 'review-findings/tmp',
  ]))
  await mkdir(metadataDirectory, { recursive: true })
  const directory = await mkdtemp(path.join(metadataDirectory, 'tree-'))
  const scratchGitDirectory = path.join(directory, 'git')
  const scratchObjects = path.join(scratchGitDirectory, 'objects')
  // Explicit Git paths also cross command forwarders that omit custom
  // environment variables. Git owns the scratch index and canonical objects.
  const scratchCommand = (args, options) => git(root, [
    '--git-dir', gitRelativePath(root, scratchGitDirectory),
    '--work-tree', '.',
    '--literal-pathspecs',
    ...args,
  ], options)
  const scratchBytes = (args) => gitBytes(root, [
    '--git-dir', gitRelativePath(root, scratchGitDirectory),
    '--work-tree', '.',
    '--literal-pathspecs',
    ...args,
  ])
  try {
    const objectFormat = git(root, ['rev-parse', '--show-object-format'])
    const originalConfig = path.resolve(root, git(root, ['rev-parse', '--git-path', 'config']))
    const worktreeConfig = path.resolve(root, git(root, ['rev-parse', '--git-path', 'config.worktree']))
    const configIncludes = [originalConfig]
    if (await exists(worktreeConfig)) configIncludes.push(worktreeConfig)
    const originalObjects = path.resolve(root, git(root, ['rev-parse', '--git-path', 'objects']))
    // This short-lived object store needs no template, hooks or branch refs.
    // Write its documented administrative layout once instead of starting Git
    // repeatedly to initialize and configure it.
    await mkdir(path.join(scratchObjects, 'info'), { recursive: true })
    await mkdir(path.join(scratchGitDirectory, 'refs'))
    await mkdir(path.join(scratchGitDirectory, 'info'))
    await writeFile(path.join(scratchGitDirectory, 'HEAD'), 'ref: refs/heads/fingerprint\n')
    await writeFile(path.join(scratchGitDirectory, 'config'),
      `[core]\nrepositoryformatversion = ${objectFormat === 'sha1' ? 0 : 1}\n`
      + (objectFormat === 'sha1' ? '' : `[extensions]\nobjectformat = ${objectFormat}\n`)
      + configIncludes.map(config => `[include]\npath = ${gitConfigPath(relativeGitPath(scratchGitDirectory, config))}\n`).join('')
      + '[core]\nbare = false\n')
    const attributes = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/attributes']))
    if (await exists(attributes)) await writeFile(path.join(scratchGitDirectory, 'info/attributes'), await readFile(attributes))
    await writeFile(
      path.join(scratchObjects, 'info', 'alternates'),
      `${relativeGitPath(scratchObjects, originalObjects)}\n`,
    )
    const headTree = git(root, ['rev-parse', 'HEAD^{tree}'], { allowFailure: true })
    scratchCommand(headTree === undefined ? ['read-tree', '--empty'] : ['read-tree', headTree])
    if (removedPaths.size > 0) {
      scratchCommand(['update-index', '--force-remove', '-z', '--stdin'], {
        input: joinGitRecords([...removedPaths.values()]),
      })
    }
    if (sourcePaths.length > 0) {
      scratchCommand([
        'add', '--all', '--force', '--pathspec-from-file=-', '--pathspec-file-nul',
      ], { input: joinGitRecords(sourcePaths) })
    }
    const fingerprint = scratchCommand(['write-tree'])
    const entries = splitGitRecords(scratchBytes(['ls-tree', '-r', '-z', '--full-tree', fingerprint])).map((record) => {
      const separator = record.indexOf(0x09)
      if (separator < 0) throw new Error('source tree entry is malformed')
      return Object.freeze({
        identity: record.subarray(0, separator).toString('ascii'),
        path: record.subarray(separator + 1),
      })
    })
    const changedPaths = base === undefined ? [] : splitGitRecords(scratchBytes([
      'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', base, fingerprint,
    ]))
    return Object.freeze({ fingerprint, entries: Object.freeze(entries), changedPaths: Object.freeze(changedPaths) })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function sourceTreeFingerprint(root) {
  return (await sourceTreeSnapshot(root)).fingerprint
}

export function indexTreeFingerprint(root) {
  return git(root, ['write-tree'])
}

function assertNotTracked(root) {
  for (const name of [ACTIVE_LEDGER, ACTIVE_REVIEW_PLAN]) {
    const tracked = git(root, ['ls-files', '--error-unmatch', '--', name], { allowFailure: true })
    if (tracked !== undefined) throw new Error(`${name} must never be tracked or staged`)
  }
}

function resolveCommit(root, value, label) {
  if (!nonEmptyString(value)) throw new Error(`${label} is required`)
  try {
    return git(root, ['rev-parse', '--verify', `${value}^{commit}`])
  } catch {
    throw new Error(`${label} is not a commit in this repository`)
  }
}

function assertPlanBaseCoversHead(root, base, head = sourceHead(root)) {
  if (head === 'unborn') throw new Error('a review plan requires a commit at HEAD')
  if (git(root, ['merge-base', '--is-ancestor', base, head], { allowFailure: true }) === undefined) {
    throw new Error('the review plan base is not an ancestor of HEAD')
  }
}

function reviewPathMatches(rule, filename) {
  if (rule === '.') return true
  const prefix = Buffer.from(rule, 'utf8')
  return rule.endsWith('/')
    ? filename.subarray(0, prefix.length).equals(prefix)
    : filename.equals(prefix)
}

function displayGitPath(filename) {
  const decoded = filename.toString('utf8')
  return Buffer.from(decoded, 'utf8').equals(filename) ? decoded : `raw Git path 0x${filename.toString('hex')}`
}

function assertReviewCoverage(plan, changedPaths) {
  const uncovered = changedPaths.filter(filename => !plan.lanes.some(lane => lane.paths.some(rule => reviewPathMatches(rule, filename))))
  if (uncovered.length > 0) {
    throw new Error(`review plan does not cover changed path(s): ${uncovered.map(displayGitPath).join(', ')}`)
  }
}

function laneFingerprints(plan, snapshot, generations = new Map()) {
  const lanes = new Map(plan.lanes.map(lane => [lane.id, lane]))
  const obligations = new Map(plan.obligations.map(obligation => [obligation.id, obligation]))
  const fingerprints = new Map()
  for (const id of reviewLaneOrder(plan)) {
    const lane = lanes.get(id)
    const inputs = snapshot.entries.filter(entry => lane.paths.some(rule => reviewPathMatches(rule, entry.path)))
      .map(entry => [entry.identity, entry.path.toString('hex')])
    const dependencies = lane.dependsOn.map(dependency => [dependency, fingerprints.get(dependency)])
    const assignedObligations = lane.obligations.map(obligation => obligations.get(obligation))
    const generation = generations.get(id)
    if (generation === undefined) {
      throw new Error(`review lane generations are missing lane ${id}; clear and record the review plan again`)
    }
    fingerprints.set(id, sha256(stableJson({ lane, assignedObligations, inputs, dependencies, generation })))
  }
  return fingerprints
}

async function reviewState(root, options = {}) {
  const state = await readPlanState(root)
  if (state === undefined) throw new Error('no review plan exists; create and record one before independent review')
  await assertActiveReviewPlanMatches(root, state)
  assertPlanBaseCoversHead(root, state.base, (options.head ?? sourceHead)(root))
  const snapshot = options.snapshot ?? await sourceTreeSnapshot(root, { base: state.base })
  assertReviewCoverage(state.plan, snapshot.changedPaths)
  const generations = await readReviewLaneGenerations(root)
  return Object.freeze({ state, snapshot, fingerprints: laneFingerprints(state.plan, snapshot, generations) })
}

export async function createReviewPlan(root, templatePath = REVIEW_PLAN_TEMPLATE_PATH) {
  const activePath = path.join(root, ACTIVE_REVIEW_PLAN)
  if (await exists(activePath)) throw new Error(`${ACTIVE_REVIEW_PLAN} already exists`)
  assertNotTracked(root)
  await ensureLocalExclude(root)
  const templateText = await readFile(templatePath, 'utf8')
  parseReviewPlan(templateText, { template: true })
  await writeFile(activePath, templateText, { flag: 'wx' })
  return activePath
}

export async function recordReviewPlan(root, options = {}) {
  if (options[REVIEW_LOCK_HELD] !== true) {
    return withReviewStateLock(root, () => recordReviewPlan(root, { ...options, [REVIEW_LOCK_HELD]: true }), options)
  }
  assertNotTracked(root)
  await ensureLocalExclude(root)
  const plan = await readActiveReviewPlan(root)
  const previous = options.base === undefined ? await readPlanState(root) : undefined
  const base = resolveCommit(root, options.base ?? previous?.base, 'the review plan base')
  assertPlanBaseCoversHead(root, base)
  const snapshot = options.snapshot ?? await sourceTreeSnapshot(root, { base })
  assertReviewCoverage(plan, snapshot.changedPaths)
  const generations = await readReviewLaneGenerations(root, {
    allowMissing: !await exists(reviewPlanStatePath(root)),
  })
  for (const lane of plan.lanes) {
    if (!generations.has(lane.id)) {
      generations.set(lane.id, Object.freeze({ epoch: randomUUID(), revision: 0 }))
    }
  }
  const state = Object.freeze({ schema: PLAN_STATE_SCHEMA, base, planHash: reviewPlanHash(plan), plan })
  const statePath = reviewPlanStatePath(root)
  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state)}\n`)
  await writeReviewLaneGenerations(root, generations)
  await removeIfPresent(verificationVerdictPath(root))
  await assertActiveReviewPlanMatches(root, state)

  const fingerprints = laneFingerprints(plan, snapshot, generations)
  const directory = reviewLaneDirectory(root)
  if (await exists(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const lane = entry.name.slice(0, -5)
      let verdict
      try {
        verdict = await readLaneVerdict(root, lane)
      } catch {
        verdict = undefined
      }
      if (verdict === undefined || verdict.lane !== lane || verdict.base !== base
        || verdict.fingerprint !== fingerprints.get(lane)
        || verdict.evidence.name !== `${lane}-${verdict.fingerprint}.txt`) {
        await removeIfPresent(path.join(directory, entry.name))
      }
    }
  }
  return Object.freeze({ state: 'recorded', plan: state, snapshot, fingerprints })
}

async function effectiveLaneVerdicts(root, review) {
  const lanes = []
  for (const lane of review.state.plan.lanes) {
    let verdict
    try {
      verdict = await readLaneVerdict(root, lane.id)
    } catch {
      verdict = undefined
    }
    const fingerprint = review.fingerprints.get(lane.id)
    const identityValid = verdict !== undefined && verdict.lane === lane.id
      && verdict.base === review.state.base && verdict.fingerprint === fingerprint
      && verdict.evidence.name === `${lane.id}-${fingerprint}.txt`
    let evidenceValid = false
    if (identityValid) {
      const evidencePath = path.join(verdictEvidenceDirectory(root), verdict.evidence.name)
      try {
        evidenceValid = await exists(evidencePath) && await fileSha256(evidencePath) === verdict.evidence.sha256
      } catch {
        evidenceValid = false
      }
    }
    lanes.push(Object.freeze({
      id: lane.id,
      fingerprint,
      clean: identityValid && evidenceValid,
      verdict,
    }))
  }
  return Object.freeze(lanes)
}

export async function reviewStatus(root, options = {}) {
  const review = await reviewState(root, options)
  const lanes = await effectiveLaneVerdicts(root, review)
  return Object.freeze({
    state: lanes.every(lane => lane.clean) ? 'clean' : 'incomplete',
    head: (options.head ?? sourceHead)(root),
    fingerprint: review.snapshot.fingerprint,
    base: review.state.base,
    planHash: review.state.planHash,
    lanes,
  })
}

function archiveName(now) {
  return `${now.toISOString().replace(/[-:.]/g, '')}-REVIEW_FINDINGS.md`
}

async function loadActiveLedger(root, templatePath) {
  const activePath = path.join(root, ACTIVE_LEDGER)
  if (!await exists(activePath)) return undefined
  const [text, templateText] = await Promise.all([
    readFile(activePath, 'utf8'),
    readFile(templatePath, 'utf8'),
  ])
  return Object.freeze({ activePath, ledger: parseReviewLedger(text, templateText) })
}

async function archiveResolvedLedger({ root, templatePath = TEMPLATE_PATH, archiveDirectory, now = new Date() }) {
  const active = await loadActiveLedger(root, templatePath)
  if (active === undefined) return Object.freeze({ state: 'absent' })
  const { activePath, ledger } = active
  if (ledger.ledgerStatus !== 'resolved') return Object.freeze({ state: 'blocked', ledger })
  const directory = archiveDirectory ?? path.resolve(
    root,
    git(root, ['rev-parse', '--git-path', 'review-findings/archive']),
  )
  await mkdir(directory, { recursive: true })
  const base = archiveName(now)
  let destination = path.join(directory, base)
  let suffix = 1
  while (await exists(destination)) {
    destination = path.join(directory, base.replace(/\.md$/, `-${suffix++}.md`))
  }
  await rename(activePath, destination)
  return Object.freeze({ state: 'archived', destination, ledger })
}

export async function createReviewLedger(root, templatePath = TEMPLATE_PATH) {
  const activePath = path.join(root, ACTIVE_LEDGER)
  if (await exists(activePath)) throw new Error(`${ACTIVE_LEDGER} already exists`)
  assertNotTracked(root)
  await ensureLocalExclude(root)
  const templateText = await readFile(templatePath, 'utf8')
  parseReviewLedger(templateText, templateText, { template: true })
  await writeFile(activePath, templateText, { flag: 'wx' })
  return activePath
}

export async function validateReviewLedger(root, options = {}) {
  assertNotTracked(root)
  const active = await loadActiveLedger(root, options.templatePath ?? TEMPLATE_PATH)
  if (active === undefined) return Object.freeze({ state: 'absent' })
  return Object.freeze({
    state: active.ledger.ledgerStatus === 'resolved' ? 'ready' : 'open',
    ledger: active.ledger,
  })
}

function localDispositionPath(reference) {
  if (/^https:\/\/[^\s]+$/.test(reference)) return undefined
  const filename = reference.split('#', 1)[0]
  if (filename.length === 0 || path.isAbsolute(filename)
    || filename.split(/[\\/]/).includes('..')) {
    throw new Error(`accepted review finding has invalid dispositionRef ${JSON.stringify(reference)}`)
  }
  return filename
}

async function validateDispositionReferences(root, ledger) {
  let sourcePaths
  for (const finding of ledger.findings) {
    if (finding.status !== 'accepted') continue
    const filename = localDispositionPath(finding.dispositionRef)
    if (filename === undefined) continue
    const tracked = splitGitRecords(gitBytes(root, ['ls-files', '-z', '--', filename]))
      .some(entry => entry.equals(Buffer.from(filename, 'utf8')))
    if (sourcePaths === undefined) {
      sourcePaths = new Set((await sourceTreeSnapshot(root)).entries.map(entry => gitPathKey(entry.path)))
    }
    const present = sourcePaths.has(gitPathKey(Buffer.from(filename, 'utf8')))
    if (!tracked || !present) {
      throw new Error(`accepted review finding ${finding.id} dispositionRef must name a tracked file or HTTPS issue`)
    }
  }
}

export async function gateReviewLedger(root, options = {}) {
  assertNotTracked(root)
  const active = await loadActiveLedger(root, options.templatePath ?? TEMPLATE_PATH)
  if (active === undefined) return Object.freeze({ state: 'absent' })
  const { ledger } = active
  if (ledger.ledgerStatus !== 'resolved') {
    const unresolved = ledger.findings.filter(finding => finding.status === 'unresolved')
    throw new Error(`${ACTIVE_LEDGER} contains ${unresolved.length} unresolved finding(s); commits are blocked`)
  }
  await validateDispositionReferences(root, ledger)
  return Object.freeze({ state: 'ready', ledger })
}

async function writeVerificationProof(root, proofValue) {
  const proof = verificationProofPath(root)
  await mkdir(path.dirname(proof), { recursive: true })
  await writeFile(proof, `${JSON.stringify(proofValue)}\n`)
  return proof
}

async function activeLedgerFingerprint(root) {
  try {
    return createHash('sha256').update(await readFile(path.join(root, ACTIVE_LEDGER))).digest('hex')
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
}

export async function checkReviewLedger(root, options = {}) {
  const ready = await gateReviewLedger(root, options)
  const fingerprint = options.fingerprint ?? sourceTreeFingerprint
  const before = await fingerprint(root)
  const ledgerBefore = await activeLedgerFingerprint(root)
  await options.verify()
  const after = await fingerprint(root)
  if (after !== before) throw new Error('source tree changed during deterministic verification')
  if (await activeLedgerFingerprint(root) !== ledgerBefore) {
    throw new Error('review findings ledger changed during deterministic verification')
  }
  const head = (options.head ?? sourceHead)(root)
  const proof = await writeVerificationProof(root, { head, fingerprint: after })
  const verified = Object.freeze({ head, fingerprint: after, proof })
  if (ready.state === 'absent') return Object.freeze({ ...ready, ...verified })
  return Object.freeze({ ...(await archiveResolvedLedger({ root, ...options })), ...verified })
}

function affectedLaneIds(plan, laneId) {
  const affected = new Set([laneId])
  let changed = true
  while (changed) {
    changed = false
    for (const lane of plan.lanes) {
      if (!affected.has(lane.id) && lane.dependsOn.some(dependency => affected.has(dependency))) {
        affected.add(lane.id)
        changed = true
      }
    }
  }
  return affected
}

async function retireLaneClosure(root, plan, laneId) {
  const generations = await readReviewLaneGenerations(root)
  const generation = generations.get(laneId)
  if (generation === undefined) {
    throw new Error(`review lane ${laneId} has no recorded invalidation generation`)
  }
  let nextGeneration
  if (generation.revision === Number.MAX_SAFE_INTEGER) {
    let epoch
    do epoch = randomUUID()
    while (epoch === generation.epoch)
    nextGeneration = Object.freeze({ epoch, revision: 0 })
  } else {
    nextGeneration = Object.freeze({ epoch: generation.epoch, revision: generation.revision + 1 })
  }
  generations.set(laneId, nextGeneration)
  await writeReviewLaneGenerations(root, generations)
  const affected = affectedLaneIds(plan, laneId)
  await Promise.all([...affected].map(id => removeIfPresent(reviewLanePath(root, id))))
  await removeIfPresent(verificationVerdictPath(root))
  return affected
}

export async function recordReviewLaneVerdict(root, options = {}) {
  if (options[REVIEW_LOCK_HELD] !== true) {
    return withReviewStateLock(root, () => recordReviewLaneVerdict(root, { ...options, [REVIEW_LOCK_HELD]: true }), options)
  }
  assertNotTracked(root)
  if (!nonEmptyString(options.lane) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.lane)) {
    throw new Error('a review lane verdict requires a valid lane id')
  }
  if (!nonEmptyString(options.evidence)) throw new Error('a review lane verdict requires the independent review report')
  if (!nonEmptyString(options.expectFingerprint)) {
    throw new Error('a review lane verdict requires the lane fingerprint captured before the review')
  }
  if (typeof options.expectHead !== 'string' || !/^[0-9a-f]{7,64}$/i.test(options.expectHead)) {
    throw new Error('a review lane verdict requires the full or abbreviated HEAD commit id captured before the review')
  }
  const head = sourceHead(root)
  if (head === 'unborn') throw new Error('a review lane verdict requires a commit at HEAD')
  const expectedHead = resolveCommit(root, options.expectHead, 'the review HEAD')
  const evidenceText = await readReviewEvidence(options.evidence)
  try {
    requireCleanEvidence(evidenceText)
  } catch (error) {
    const state = await readPlanState(root)
    if (state === undefined) throw new Error('no review plan exists; create and record one before independent review')
    const affected = await retireLaneClosure(root, state.plan, options.lane)
    throw new Error(`${error.message}; retired review lane(s): ${[...affected].join(', ')}`)
  }
  const review = await reviewState(root, options)
  const lane = review.state.plan.lanes.find(candidate => candidate.id === options.lane)
  if (lane === undefined) throw new Error(`review plan has no lane ${JSON.stringify(options.lane)}`)
  const fingerprint = review.fingerprints.get(lane.id)
  if (fingerprint !== options.expectFingerprint) {
    throw new Error(`review lane ${lane.id} changed while its independent review ran; review only that lane and its dependents again`)
  }
  await options.beforeLaneVerdictWrite?.()
  const digest = sha256(evidenceText)
  const directory = verdictEvidenceDirectory(root)
  await mkdir(directory, { recursive: true })
  const name = `${lane.id}-${fingerprint}.txt`
  const evidencePath = path.join(directory, name)
  await writeFile(evidencePath, evidenceText)
  if (await fileSha256(evidencePath) !== digest) {
    throw new Error('the retained review evidence changed while it was recorded; record the verdict again')
  }
  const verdict = Object.freeze({
    schema: LANE_VERDICT_SCHEMA,
    status: 'clean',
    lane: lane.id,
    fingerprint,
    reviewedHead: expectedHead,
    base: review.state.base,
    evidence: Object.freeze({ name, sha256: digest }),
  })
  const filename = reviewLanePath(root, lane.id)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, `${JSON.stringify(verdict)}\n`)
  await removeIfPresent(verificationVerdictPath(root))
  return Object.freeze({ state: 'recorded', verdict, path: filename, evidencePath })
}

export async function finalizeReviewVerdict(root, options = {}) {
  if (options[REVIEW_LOCK_HELD] !== true) {
    return withReviewStateLock(root, () => finalizeReviewVerdict(root, { ...options, [REVIEW_LOCK_HELD]: true }), options)
  }
  assertNotTracked(root)
  const proofPath = verificationProofPath(root)
  if (!await exists(proofPath)) throw new Error('no review verification proof exists; run npm run check before finalizing review')
  let proof
  try {
    proof = JSON.parse(await readFile(proofPath, 'utf8'))
  } catch {
    throw new Error('review verification proof is malformed; run npm run check again')
  }
  const head = (options.head ?? sourceHead)(root)
  if (proof?.head !== head || !nonEmptyString(proof.fingerprint)) {
    throw new Error('review verification proof does not belong to the current HEAD; run npm run check again')
  }
  const fingerprint = await (options.fingerprint ?? sourceTreeFingerprint)(root)
  if (proof.fingerprint !== fingerprint) {
    throw new Error('source tree changed after npm run check; run it again before finalizing review')
  }
  const status = await reviewStatus(root, options)
  const incomplete = status.lanes.filter(lane => !lane.clean).map(lane => lane.id)
  if (incomplete.length > 0) throw new Error(`review lanes are incomplete: ${incomplete.join(', ')}`)
  const lanes = status.lanes.map(lane => Object.freeze({
    id: lane.id,
    fingerprint: lane.fingerprint,
    evidence: lane.verdict.evidence,
  }))
  const after = await (options.fingerprint ?? sourceTreeFingerprint)(root)
  if (after !== fingerprint || (options.head ?? sourceHead)(root) !== head) {
    throw new Error('the candidate changed while the composite review verdict was finalized')
  }
  await options.beforeFinalizationRevalidation?.()
  const finalStatus = await reviewStatus(root, options)
  const statusIdentity = status.lanes.map(lane => ({
    id: lane.id, fingerprint: lane.fingerprint, clean: lane.clean, evidence: lane.verdict?.evidence,
  }))
  const finalStatusIdentity = finalStatus.lanes.map(lane => ({
    id: lane.id, fingerprint: lane.fingerprint, clean: lane.clean, evidence: lane.verdict?.evidence,
  }))
  if (status.base !== finalStatus.base || status.planHash !== finalStatus.planHash
    || stableJson(statusIdentity) !== stableJson(finalStatusIdentity)) {
    throw new Error('review state changed while the composite review verdict was finalized')
  }
  let finalProof
  try {
    finalProof = JSON.parse(await readFile(proofPath, 'utf8'))
  } catch {
    throw new Error('review verification proof changed while the composite review verdict was finalized')
  }
  if (stableJson(finalProof) !== stableJson(proof)) {
    throw new Error('review verification proof changed while the composite review verdict was finalized')
  }
  const finalFingerprint = await (options.fingerprint ?? sourceTreeFingerprint)(root)
  if ((options.head ?? sourceHead)(root) !== head || finalFingerprint !== fingerprint
    || finalStatus.head !== head) {
    throw new Error('the candidate changed while the composite review verdict was finalized')
  }
  const verdict = Object.freeze({
    schema: VERDICT_SCHEMA,
    status: 'clean',
    head,
    fingerprint,
    base: status.base,
    planHash: status.planHash,
    lanes: Object.freeze(lanes),
  })
  const filename = verificationVerdictPath(root)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, `${JSON.stringify(verdict)}\n`)
  return Object.freeze({ state: 'recorded', verdict, path: filename })
}

export async function readReviewVerdict(root) {
  assertNotTracked(root)
  return readVerdict(root)
}

export async function clearReviewVerdict(root, options = {}) {
  if (options[REVIEW_LOCK_HELD] !== true) {
    return withReviewStateLock(root, () => clearReviewVerdict(root, { ...options, [REVIEW_LOCK_HELD]: true }), options)
  }
  assertNotTracked(root)
  try {
    await readReviewLaneGenerations(root)
  } catch {
    await removeIfPresent(reviewLaneGenerationsPath(root))
  }
  await removeIfPresent(verificationVerdictPath(root))
  await removeIfPresent(verificationProofPath(root))
  await removeIfPresent(reviewPlanStatePath(root))
  await rm(reviewLaneDirectory(root), { recursive: true, force: true })
  return Object.freeze({ state: 'cleared' })
}

export async function preCommitReviewLedger(root, options = {}) {
  if (options[REVIEW_LOCK_HELD] !== true) {
    return withReviewStateLock(root, () => preCommitReviewLedger(root, { ...options, [REVIEW_LOCK_HELD]: true }), options)
  }
  const active = await validateReviewLedger(root, options)
  const ledgerIdentity = stableJson(active)
  if (active.state === 'open') {
    const unresolved = active.ledger.findings.filter(finding => finding.status === 'unresolved')
    throw new Error(`${ACTIVE_LEDGER} contains ${unresolved.length} unresolved finding(s); commits are blocked`)
  }
  if (active.state === 'ready') {
    throw new Error(`${ACTIVE_LEDGER} is resolved but unverified; run npm run check before committing`)
  }
  const head = (options.head ?? sourceHead)(root)
  if (head === 'unborn') throw new Error('the review gate requires a commit at HEAD')
  const proof = verificationProofPath(root)
  if (!await exists(proof)) throw new Error('no review verification proof exists; run npm run check before committing')
  let expected
  try {
    expected = JSON.parse(await readFile(proof, 'utf8'))
  } catch {
    throw new Error('review verification proof is malformed; run npm run check again')
  }
  if (typeof expected?.head !== 'string' || typeof expected.fingerprint !== 'string') {
    throw new Error('review verification proof is malformed; run npm run check again')
  }
  if (head !== expected.head) {
    await removeIfPresent(proof)
    await removeIfPresent(verificationVerdictPath(root))
    throw new Error('HEAD moved after npm run check; run it again and finalize the still-effective review lanes before committing')
  }
  const actual = await (options.fingerprint ?? sourceTreeFingerprint)(root)
  if (actual !== expected.fingerprint) {
    throw new Error('source tree changed after npm run check; run it again before committing')
  }
  const prospective = await (options.indexFingerprint ?? indexTreeFingerprint)(root)
  if (prospective !== expected.fingerprint) {
    throw new Error('staged tree differs from the source tree verified by npm run check; stage the complete verified fix or run it again')
  }
  const verdict = await readVerdict(root)
  if (verdict === undefined) {
    throw new Error('no composite clean review verdict exists; finalize the review lanes after npm run check')
  }
  if (verdict.head !== head || verdict.fingerprint !== expected.fingerprint) {
    await removeIfPresent(verificationVerdictPath(root))
    throw new Error('the composite verdict does not belong to the verified candidate; finalize the effective lanes again')
  }
  const status = await reviewStatus(root, options)
  if (verdict.base !== status.base || verdict.planHash !== status.planHash) {
    await removeIfPresent(verificationVerdictPath(root))
    throw new Error('the composite verdict uses a different review plan; finalize the effective lanes again')
  }
  const incomplete = status.lanes.filter(lane => !lane.clean).map(lane => lane.id)
  if (incomplete.length > 0) {
    await removeIfPresent(verificationVerdictPath(root))
    throw new Error(`review lanes are no longer effective: ${incomplete.join(', ')}`)
  }
  const effective = status.lanes.map(lane => ({ id: lane.id, fingerprint: lane.fingerprint, evidence: lane.verdict.evidence }))
  if (stableJson(verdict.lanes) !== stableJson(effective)) {
    await removeIfPresent(verificationVerdictPath(root))
    throw new Error('the composite verdict does not match the effective review lanes; finalize them again')
  }
  await options.beforeReviewGateReturn?.()
  const [finalActive, finalActual, finalProspective, finalVerdict, finalStatus] = await Promise.all([
    validateReviewLedger(root, options),
    (options.fingerprint ?? sourceTreeFingerprint)(root),
    (options.indexFingerprint ?? indexTreeFingerprint)(root),
    readVerdict(root),
    reviewStatus(root, options),
  ])
  const finalHead = (options.head ?? sourceHead)(root)
  let finalExpected
  try {
    finalExpected = JSON.parse(await readFile(proof, 'utf8'))
  } catch {
    throw new Error('review state changed while the commit gate was evaluated')
  }
  const finalEffective = finalStatus.lanes.map(lane => ({
    id: lane.id, fingerprint: lane.fingerprint, evidence: lane.verdict?.evidence,
  }))
  if (stableJson(finalActive) !== ledgerIdentity || finalHead !== head
    || finalActual !== actual || finalProspective !== prospective
    || stableJson(finalExpected) !== stableJson(expected)
    || stableJson(finalVerdict) !== stableJson(verdict)
    || finalStatus.base !== status.base || finalStatus.planHash !== status.planHash
    || finalStatus.lanes.some(lane => !lane.clean)
    || stableJson(finalEffective) !== stableJson(effective)) {
    throw new Error('review state changed while the commit gate was evaluated')
  }
  return Object.freeze({ state: 'verified', verdict })
}

export function installHook(root) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  if (inside !== 'true') return Object.freeze({ state: 'skipped' })
  const configured = git(root, ['config', '--get', 'core.hooksPath'], { allowFailure: true })
  if (configured !== undefined && configured !== '.githooks') {
    throw new Error(`core.hooksPath is already ${JSON.stringify(configured)}; install .githooks without discarding the existing hooks`)
  }
  const hookPaths = ['pre-commit'].map((name) => path.join(root, `.githooks/${name}`))
  for (const hookPath of hookPaths) {
    if (!existsSync(hookPath)) throw new Error(`tracked ${path.basename(hookPath)} hook is missing at ${hookPath}`)
    chmodSync(hookPath, 0o755)
  }
  if (configured === undefined) {
    const defaultHooksDirectory = path.resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']))
    const customHooks = existsSync(defaultHooksDirectory)
      ? readdirSync(defaultHooksDirectory, { withFileTypes: true })
          .filter(entry => !entry.name.endsWith('.sample') && (entry.isFile() || entry.isSymbolicLink()))
          .map(entry => entry.name)
          .sort()
      : []
    if (customHooks.length > 0) {
      throw new Error(`default Git hooks directory already contains custom hooks: ${customHooks.join(', ')}`)
    }
    git(root, ['config', '--local', 'core.hooksPath', '.githooks'])
  }
  return Object.freeze({ state: 'installed' })
}

function option(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

async function main() {
  const [command = 'gate', ...args] = process.argv.slice(2)
  const root = path.resolve(option(args, '--root') ?? process.cwd())
  if (command === 'create') {
    const active = await createReviewLedger(root)
    console.log(`created ${path.relative(root, active)}`)
    return
  }
  if (command === 'plan-create') {
    const active = await createReviewPlan(root)
    console.log(`created ${path.relative(root, active)}`)
    return
  }
  if (command === 'plan') {
    if (args.some(argument => argument === '--plan' || argument.startsWith('--plan='))) {
      throw new Error(`${ACTIVE_REVIEW_PLAN} is the only supported active review plan`)
    }
    const recorded = await recordReviewPlan(root, {
      base: option(args, '--base'),
    })
    const head = sourceHead(root)
    console.log(`recorded review plan ${recorded.plan.planHash} from ${recorded.plan.base}`)
    for (const lane of recorded.plan.plan.lanes) {
      console.log(`review-lane ${lane.id} ${head} ${recorded.fingerprints.get(lane.id)}`)
    }
    return
  }
  if (command === 'status') {
    console.log(JSON.stringify(await reviewStatus(root), null, 2))
    return
  }
  if (command === 'lane-verdict') {
    const recorded = await recordReviewLaneVerdict(root, {
      lane: option(args, '--lane'),
      evidence: option(args, '--evidence'),
      expectFingerprint: option(args, '--expect-fingerprint'),
      expectHead: option(args, '--expect-head'),
    })
    console.log(`recorded clean review lane ${recorded.verdict.lane} ${recorded.verdict.fingerprint}`)
    return
  }
  if (command === 'finalize') {
    const recorded = await finalizeReviewVerdict(root)
    console.log(`recorded composite clean verdict for ${recorded.verdict.head} ${recorded.verdict.fingerprint}`)
    return
  }
  if (command === 'validate') {
    await validateReviewLedger(root)
    return
  }
  if (command === 'gate') {
    await gateReviewLedger(root)
    return
  }
  if (command === 'check') {
    const result = await checkReviewLedger(root, { verify: () => runVerification(root) })
    if (result.state === 'archived') console.log(`archived resolved review findings at ${result.destination}`)
    if (typeof result.head === 'string' && typeof result.fingerprint === 'string') {
      console.log(`verified ${result.head} ${result.fingerprint}`)
    }
    return
  }
  if (command === 'pre-commit') {
    await preCommitReviewLedger(root)
    return
  }
  if (command === 'install-hook') {
    installHook(root)
    return
  }
  if (command === 'review-clear' || command === 'verdict-clear') {
    await clearReviewVerdict(root)
    return
  }
  if (command === 'verdict') throw new Error('the verdict command was replaced by plan, lane-verdict, and finalize')
  throw new Error(`unknown review findings command ${JSON.stringify(command)}`)
}

export function verificationCommand(options = {}) {
  return npmCliCommand(['run', 'verify'], options)
}

function runVerification(root) {
  const command = verificationCommand()
  const result = spawnSync(command.executable, command.args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw new Error(`cannot start npm run verify: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`npm run verify failed with exit ${result.status}`)
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`review-findings: ${error.message}`)
    process.exitCode = 1
  })
}
