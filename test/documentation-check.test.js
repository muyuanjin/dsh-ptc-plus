import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { documentationChanges, verifyDocumentation } from '../scripts/documentation-check.mjs'
import { checkReviewLedger, verifyCandidate } from '../scripts/review-findings.mjs'

const entry = (name, blob = 'old', mode = '100644') => ({ path: Buffer.from(name), identity: `${mode} blob ${blob}` })

test('documentation classification includes additions and deletions but rejects mixed, fixture and mode changes', () => {
  const before = [entry('README.md'), entry('docs/old.md'), entry('index.js')]
  assert.deepEqual(documentationChanges(before, [entry('README.md', 'new'), entry('docs/new.md'), entry('index.js')]),
    ['README.md', 'docs/new.md', 'docs/old.md'])
  for (const extra of [entry('index.js', 'new'), entry('test/fixtures/input.md'), entry('docs/run.md', 'new', '100755'),
    entry('docs/link.md', 'target', '120000'), entry('.agents/templates/REVIEW_FINDINGS.md')]) {
    assert.equal(documentationChanges(before, [...before, entry('README.md', 'new'), extra]), undefined)
  }
  assert.equal(documentationChanges([entry('docs/a.md', 'old', '120000')], [entry('docs/a.md', 'new')]), undefined)
  assert.equal(documentationChanges(before, before), undefined)
  const raw = { path: Buffer.from([100, 111, 99, 115, 47, 255, 46, 109, 100]), identity: '100644 blob new' }
  assert.equal(documentationChanges([], [raw]), undefined)
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ptc-docs-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(77)"' } }))
  await writeFile(join(root, 'README.md'), '[Guide](docs/guide.md)\n')
  await writeFile(join(root, 'docs/guide.md'), '# Guide\n\n`npm run verify`\n')
  await writeFile(join(root, 'index.js'), 'export const value = 1\n')
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=PTC Test', '-c', 'user.email=ptc@example.test', 'commit', '--quiet', '-m', 'base'], { cwd: root })
  return root
}

test('documentation verification catches missing targets, reference links and unknown commands in affected pages', async t => {
  const root = await fixture(t)
  const selection = { files: ['docs/guide.md'], inventory: ['README.md', 'docs/guide.md'] }
  assert.equal((await verifyDocumentation(root, selection)).documents, 2)
  await writeFile(join(root, 'docs/guide.md'), '[missing][target]\n\n[target]: missing.md\n\n`npm run absent`\n')
  await assert.rejects(() => verifyDocumentation(root, selection), /missing local link target.*\n.*unknown npm script absent/)
  await unlink(join(root, 'docs/guide.md'))
  await assert.rejects(() => verifyDocumentation(root, { ...selection, inventory: ['README.md'] }), /README.md:1: missing local link/)
})

test('documentation verification keeps dotted npm script names intact', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'docs/guide.md'), '`npm run verify.missing`\n')
  await assert.rejects(() => verifyDocumentation(root, { files: ['docs/guide.md'], inventory: ['docs/guide.md'] }),
    /unknown npm script verify\.missing/)
})

test('documentation checks do not execute Markdown code or contact external URLs', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'docs/guide.md'), '[external](https://invalid.example/unavailable)\n\n```sh\nnpm run verify\n```\n')
  assert.equal((await verifyCandidate(root, { documentationOnly: true })).kind, 'documentation')
})

test('candidate verification selects documentation from the entire working tree and routes mixed changes to full verification', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'docs/guide.md'), '# Updated guide\n')
  let fullRuns = 0
  const full = async candidate => { assert.equal(candidate, root); fullRuns += 1 }
  assert.equal((await verifyCandidate(root, { full })).kind, 'documentation')
  assert.equal(fullRuns, 0)
  assert.equal((await verifyCandidate(root, { forceFull: true, full })).kind, 'full')
  assert.equal(fullRuns, 1)
  await writeFile(join(root, 'new-source.js'), 'export default 42\n')
  await assert.rejects(() => verifyCandidate(root, { documentationOnly: true, full }), /requires only ordinary Markdown changes/)
  assert.equal(fullRuns, 1)
  assert.equal((await verifyCandidate(root, { full })).kind, 'full')
  assert.equal(fullRuns, 2)
})

test('documentation check writes an explicitly scoped source proof without starting the full command', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'docs/guide.md'), '# Updated guide\n')
  const result = await checkReviewLedger(root)
  const proof = JSON.parse(await readFile(result.proof, 'utf8'))
  assert.equal(proof.fingerprint, result.fingerprint)
  assert.deepEqual(proof.verification, { kind: 'documentation', files: ['docs/guide.md'], documents: 2 })
})

test('documentation whitespace checks include untracked additions without changing the real index', async t => {
  const root = await fixture(t)
  const index = () => execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
  const before = index()
  await writeFile(join(root, 'docs/new.md'), '# New page   \n')
  await assert.rejects(() => checkReviewLedger(root), /trailing whitespace/)
  assert.equal(index(), before)
  await writeFile(join(root, 'docs/new.md'), '# New page\n')
  const result = await checkReviewLedger(root)
  assert.equal(JSON.parse(await readFile(result.proof, 'utf8')).verification.kind, 'documentation')
  assert.equal(index(), before)
})
