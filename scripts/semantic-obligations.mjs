import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANGUAGE_SEMANTICS } from '../internal/language-semantics.js'
import { MODULE_TRANSFORMS } from '../internal/module-transform-contract.js'
import { JOURNAL_VERSION, JOURNAL_VERSIONS } from '../internal/session-journal-schema.js'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const VALID_DISPOSITIONS = new Set(['preserved', 'intentional-difference', 'bounded-external'])
const REQUIRED_ARRAYS = Object.freeze([
  'implementation', 'observables', 'entries', 'lifecycle', 'generations',
  'platforms', 'consumers', 'evidence', 'dependsOn',
])

async function sourceFiles(root) {
  const files = ['client.js', 'index.js', 'scripts/migrate-session-log.mjs']
  for (const directory of ['internal', 'src']) {
    const entries = await readdir(join(root, directory), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:c?js)$/u.test(entry.name)) files.push(`${directory}/${entry.name}`)
    }
  }
  return files.sort()
}

function sameSet(actual, expected, label) {
  const left = [...actual].sort()
  const right = [...expected].sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} differs from its executable owner: expected ${JSON.stringify(right)}, got ${JSON.stringify(left)}`)
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function visitDependencies(byId) {
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`semantic obligation dependency cycle reaches ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id).dependsOn) {
      if (!byId.has(dependency)) throw new Error(`${id} depends on unknown semantic obligation ${dependency}`)
      visit(dependency)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) visit(id)
}

export async function readSemanticObligations(root = DEFAULT_ROOT) {
  return JSON.parse(await readFile(join(root, 'semantic-obligations.json'), 'utf8'))
}

export async function validateSemanticObligations(value, options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  if (value?.schema !== 'dsh-semantic-obligations/v1' || !Array.isArray(value.obligations)) {
    throw new Error('semantic obligations must use dsh-semantic-obligations/v1')
  }
  sameSet(value.languageGenerations, LANGUAGE_SEMANTICS, 'language generations')
  sameSet(value.moduleTransforms, MODULE_TRANSFORMS, 'module transforms')
  const journalVersions = [...JOURNAL_VERSIONS].sort((left, right) => left - right)
  if (journalVersions.length !== JOURNAL_VERSION
    || journalVersions.some((version, index) => version !== index + 1)) {
    throw new Error('journal generations are not a closed contiguous range')
  }

  const byId = new Map()
  const sourceOwners = new Map()
  for (const obligation of value.obligations) {
    if (!nonEmptyString(obligation?.id) || byId.has(obligation.id)) {
      throw new Error(`invalid or duplicate semantic obligation id: ${obligation?.id}`)
    }
    if (!VALID_DISPOSITIONS.has(obligation.disposition)) {
      throw new Error(`${obligation.id} has unknown disposition ${obligation.disposition}`)
    }
    for (const field of ['owner', 'contract', 'oracle']) {
      if (!nonEmptyString(obligation[field])) throw new Error(`${obligation.id} is missing ${field}`)
    }
    for (const field of REQUIRED_ARRAYS) {
      if (!Array.isArray(obligation[field])
        || (field !== 'dependsOn' && obligation[field].length === 0)
        || obligation[field].some(item => !nonEmptyString(item))) {
        throw new Error(`${obligation.id} has invalid ${field}`)
      }
    }
    byId.set(obligation.id, obligation)
    for (const source of obligation.implementation) {
      if (sourceOwners.has(source)) {
        throw new Error(`${source} has multiple semantic owners: ${sourceOwners.get(source)} and ${obligation.id}`)
      }
      sourceOwners.set(source, obligation.id)
    }
  }
  visitDependencies(byId)

  const expectedSources = options.sources ?? await sourceFiles(root)
  sameSet(sourceOwners.keys(), expectedSources, 'semantic source inventory')
  for (const obligation of value.obligations) {
    for (const path of [obligation.contract, ...obligation.evidence]) {
      let facts
      try { facts = await stat(join(root, path)) } catch {
        throw new Error(`${obligation.id} references missing evidence ${path}`)
      }
      if (!facts.isFile()) throw new Error(`${obligation.id} evidence is not a file: ${path}`)
    }
    if (!obligation.evidence.some(path => path.startsWith('test/'))) {
      throw new Error(`${obligation.id} has no executable test evidence`)
    }
  }

  const dispositions = Object.fromEntries([...VALID_DISPOSITIONS].map(disposition => [
    disposition,
    value.obligations.filter(obligation => obligation.disposition === disposition).length,
  ]))
  return Object.freeze({
    schema: value.schema,
    sources: expectedSources.length,
    obligations: value.obligations.length,
    dispositions,
    unknown: 0,
    journalGenerations: `1..${JOURNAL_VERSION}`,
  })
}

export async function semanticObligationReport(root = DEFAULT_ROOT) {
  return validateSemanticObligations(await readSemanticObligations(root), { root })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const report = await semanticObligationReport()
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
