import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { npmCliCommand } from './npm-cli.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_PATH = path.resolve(SCRIPT_DIRECTORY, '../.agents/templates/REVIEW_FINDINGS.md')
export const ACTIVE_LEDGER = 'REVIEW_FINDINGS.md'
const VERIFICATION_PROOF = 'review-findings/verified-tree'
const VERIFICATION_VERDICT = 'review-findings/verdict'
const VERDICT_EVIDENCE_DIRECTORY = 'review-findings/evidence'
const VERDICT_SCHEMA = 'dsh-review-verdict/v1'
const CLEAN_VERDICT_MARKER = 'VERDICT: NO FINDINGS'
const VERDICT_FIELDS = new Set(['schema', 'status', 'head', 'fingerprint', 'base', 'evidence'])
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
  if (text.split(/\r?\n/).includes(`/${ACTIVE_LEDGER}`)) return
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  await writeFile(absolute, `${text}${separator}/${ACTIVE_LEDGER}\n`)
}

function verificationProofPath(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', VERIFICATION_PROOF]))
}

function verificationVerdictPath(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', VERIFICATION_VERDICT]))
}

function verdictEvidenceDirectory(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', VERDICT_EVIDENCE_DIRECTORY]))
}

async function fileSha256(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex')
}

function objectId(value, label) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`invalid review verdict ${label}`)
  }
  return value
}

function normalizeVerdict(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !sameKeys(value, VERDICT_FIELDS)
    || value.schema !== VERDICT_SCHEMA || value.status !== 'clean') {
    throw new Error('review verdict is malformed')
  }
  objectId(value.head, 'head')
  objectId(value.fingerprint, 'fingerprint')
  objectId(value.base, 'scope base')
  const evidence = value.evidence
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)
    || !sameKeys(evidence, VERDICT_EVIDENCE_FIELDS)
    || !/^[0-9a-f]{40,64}-[0-9a-f]{40,64}\.txt$/i.test(evidence.name)
    || !/^[0-9a-f]{64}$/.test(evidence.sha256)) {
    throw new Error('review verdict is malformed')
  }
  return value
}

async function readCleanEvidence(filename) {
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    throw new Error(`independent review evidence cannot be read: ${error.message}`)
  }
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

export async function sourceTreeFingerprint(root) {
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
    return scratchCommand(['write-tree'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function indexTreeFingerprint(root) {
  return git(root, ['write-tree'])
}

function assertNotTracked(root) {
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', ACTIVE_LEDGER], { allowFailure: true })
  if (tracked !== undefined) throw new Error(`${ACTIVE_LEDGER} must never be tracked or staged`)
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

function validateDispositionReferences(root, ledger) {
  for (const finding of ledger.findings) {
    if (finding.status !== 'accepted') continue
    const filename = localDispositionPath(finding.dispositionRef)
    if (filename === undefined) continue
    const tracked = git(root, ['ls-files', '--error-unmatch', '--', filename], { allowFailure: true })
    if (tracked === undefined) {
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
  validateDispositionReferences(root, ledger)
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

/** Record the controlled clean verdict for one frozen candidate. */
export async function recordReviewVerdict(root, options = {}) {
  assertNotTracked(root)
  if (!nonEmptyString(options.base)) throw new Error('a review verdict requires the scope base commit')
  if (!nonEmptyString(options.evidence)) throw new Error('a review verdict requires the independent review report')
  if (!nonEmptyString(options.expectFingerprint)) throw new Error('a review verdict requires the fingerprint captured before the review')
  if (typeof options.expectHead !== 'string' || !/^[0-9a-f]{7,64}$/i.test(options.expectHead)) {
    throw new Error('a review verdict requires the full or abbreviated HEAD commit id captured before the review')
  }
  const head = (options.head ?? sourceHead)(root)
  if (head === 'unborn') throw new Error('a review verdict requires a commit at HEAD')
  if (head !== sourceHead(root) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
    throw new Error('a review verdict must bind the current HEAD')
  }
  let expectedHead
  try {
    expectedHead = git(root, ['rev-parse', '--verify', `${options.expectHead}^{commit}`])
  } catch {
    throw new Error('the review HEAD is not a commit in this repository')
  }
  if (head !== expectedHead) {
    throw new Error('HEAD moved while the independent review ran; review the frozen candidate again')
  }
  const fingerprint = await (options.fingerprint ?? sourceTreeFingerprint)(root)
  if (fingerprint !== options.expectFingerprint) {
    throw new Error('the candidate changed while the independent review ran; review the frozen candidate again')
  }
  let base
  try {
    base = git(root, ['rev-parse', '--verify', `${options.base}^{commit}`])
  } catch {
    throw new Error('the review scope base is not a commit in this repository')
  }
  objectId(base, 'scope base')
  if (git(root, ['merge-base', '--is-ancestor', base, head], { allowFailure: true }) === undefined) {
    throw new Error('the review scope base is not an ancestor of HEAD')
  }
  let evidenceText
  try {
    evidenceText = await readCleanEvidence(options.evidence)
  } catch (error) {
    await removeIfPresent(verificationVerdictPath(root))
    await removeIfPresent(verificationProofPath(root))
    throw new Error(`${error.message}; the standing verification and verdict were retired for this candidate`)
  }
  const digest = createHash('sha256').update(evidenceText, 'utf8').digest('hex')
  const directory = verdictEvidenceDirectory(root)
  await mkdir(directory, { recursive: true })
  const name = `${head}-${fingerprint}.txt`
  const evidencePath = path.join(directory, name)
  await writeFile(evidencePath, evidenceText)
  if (await fileSha256(evidencePath) !== digest) {
    throw new Error('the retained review evidence changed while it was recorded; record the verdict again')
  }
  const verdict = Object.freeze({
    schema: VERDICT_SCHEMA,
    status: 'clean',
    head,
    fingerprint,
    base,
    evidence: Object.freeze({ name, sha256: digest }),
  })
  const filename = verificationVerdictPath(root)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, `${JSON.stringify(verdict)}\n`)
  return Object.freeze({ state: 'recorded', verdict, path: filename, evidencePath })
}

export async function readReviewVerdict(root) {
  assertNotTracked(root)
  return readVerdict(root)
}

export async function clearReviewVerdict(root) {
  assertNotTracked(root)
  await removeIfPresent(verificationVerdictPath(root))
  await removeIfPresent(verificationProofPath(root))
  return Object.freeze({ state: 'cleared' })
}

export async function preCommitReviewLedger(root, options = {}) {
  const active = await validateReviewLedger(root, options)
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
    throw new Error('HEAD moved after npm run check; run it again and record a new clean verdict before committing')
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
    throw new Error('no clean independent review verdict exists; record one with scripts/review-findings.mjs verdict')
  }
  if (verdict.head !== head || verdict.fingerprint !== expected.fingerprint) {
    await removeIfPresent(verificationVerdictPath(root))
    throw new Error('the clean verdict does not belong to the verified candidate; it was retired, re-review the frozen candidate')
  }
  if (git(root, ['merge-base', '--is-ancestor', verdict.base, head], { allowFailure: true }) === undefined) {
    throw new Error('the clean verdict scope does not cover the current candidate; re-review it')
  }
  const evidencePath = path.join(verdictEvidenceDirectory(root), verdict.evidence.name)
  let evidenceHash
  try {
    evidenceHash = await exists(evidencePath) ? await fileSha256(evidencePath) : undefined
  } catch {
    evidenceHash = undefined
  }
  if (evidenceHash !== verdict.evidence.sha256) {
    throw new Error('the recorded independent review evidence is missing or changed; record the verdict again')
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
  if (command === 'verdict') {
    const recorded = await recordReviewVerdict(root, {
      base: option(args, '--base'),
      evidence: option(args, '--evidence'),
      expectFingerprint: option(args, '--expect-fingerprint'),
      expectHead: option(args, '--expect-head'),

    })
    console.log(`recorded clean verdict for ${recorded.verdict.head} ${recorded.verdict.fingerprint}`)
    return
  }
  if (command === 'verdict-clear') {
    await clearReviewVerdict(root)
    return
  }
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
