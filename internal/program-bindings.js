/** Deterministic capability metadata derived from the current DSH tool view. */
import { record, text } from './record-utils.js'
import { createHash } from 'node:crypto'

const COMPLETENESS = new Set(['complete', 'bounded', 'incremental', 'open-world', 'unknown'])
const SOURCE_KINDS = new Set(['authored', 'runtime', 'tests', 'docs'])
const REPLAY = new Set(['recorded-value', 'owner-replay', 'volatile', 'unknown'])


function metadataSnapshot(value, label) {
  let clone
  try {
    clone = structuredClone(value)
  } catch (error) {
    throw new TypeError(`ptc-plus: ${label} must be structured data: ${error.message}`)
  }
  if (clone === null || typeof clone !== 'object') return clone
  const pending = [clone]
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (seen.has(current)) continue
    seen.add(current)
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') pending.push(child)
    }
    Object.freeze(current)
  }
  return clone
}

function sourceRef(value, label) {
  if (value === undefined) return undefined
  const source = record(value, label)
  const kind = text(source.kind, `${label}.kind`)
  if (!SOURCE_KINDS.has(kind)) throw new TypeError(`ptc-plus: ${label}.kind is invalid`)
  const path = text(source.path, `${label}.path`)
  const result = { kind, path }
  if (source.symbol !== undefined) result.symbol = text(source.symbol, `${label}.symbol`)
  if (source.revision !== undefined) result.revision = text(source.revision, `${label}.revision`)
  return Object.freeze(result)
}

/** Convert DSH's live tool schemas into descriptive metadata without wrapping invocation. */
export function toolCapabilityMetadata(schemas, annotations = {}) {
  if (!Array.isArray(schemas)) throw new TypeError('ptc-plus: tool schemas must be an array')
  const overrides = record(annotations, 'tool annotations')
  const members = schemas
    .filter(schema => schema?.name !== 'run_code')
    .map((schema) => {
      const value = record(schema, 'tool schema')
      const name = text(value.name, 'tool schema name')
      const annotation = overrides[name] === undefined ? {} : record(overrides[name], `${name} annotation`)
      return Object.freeze({
        name,
        ...(value.description === undefined ? {} : { description: text(value.description, `${name} description`) }),
        parameters: metadataSnapshot(value.parameters ?? {}, `${name} parameters`),
        returns: metadataSnapshot(value.output ?? {}, `${name} output`),
        effect: annotation.effect ?? 'unknown',
        authority: annotation.authority ?? 'dsh-tool-dispatch',
        completeness: annotation.completeness ?? 'unknown',
        replay: annotation.replay ?? 'unknown',
        ...(annotation.sourceRef === undefined ? {} : { sourceRef: sourceRef(annotation.sourceRef, `${name} sourceRef`) }),
        ...(annotation.revision === undefined ? {} : { revision: text(annotation.revision, `${name} revision`) }),
        ...(annotation.fingerprint === undefined ? {} : { fingerprint: text(annotation.fingerprint, `${name} fingerprint`) }),
      })
    })
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const member of members) {
    if (!COMPLETENESS.has(member.completeness)) {
      throw new TypeError(`ptc-plus: ${member.name}.completeness is invalid`)
    }
    if (!REPLAY.has(member.replay)) {
      throw new TypeError(`ptc-plus: ${member.name}.replay is invalid`)
    }
  }
  return Object.freeze([{ namespace: 'tools', members: Object.freeze(members) }])
}

function metadataEntries(metadata) {
  if (!Array.isArray(metadata)) throw new TypeError('ptc-plus: capability metadata must be an array')
  return metadata.map((entry) => {
    const value = record(entry, 'capability metadata entry')
    const namespace = text(value.namespace, 'capability namespace')
    const members = Array.isArray(value.members)
      ? value.members.map((member) => {
          const item = record(member, 'capability member')
          return { ...item, name: text(item.name, `${namespace} capability member name`) }
        })
      : []
    return { ...value, namespace, members }
  })
}

function searchTokens(value) {
  const separated = value
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
  return separated.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function includesTokenSequence(tokens, queryTokens) {
  if (queryTokens.length === 0 || queryTokens.length > tokens.length) return false
  return tokens.some((_, start) => queryTokens.every(
    (token, offset) => tokens[start + offset] === token,
  ))
}

function capabilityMatchRank(namespace, member, query, queryTokens) {
  const normalizedNamespace = namespace.toLowerCase()
  const normalizedMember = member.name.toLowerCase()
  const symbol = `${normalizedNamespace}.${normalizedMember}`
  if (symbol === query) return 0
  if (normalizedNamespace === query) return 1
  if (normalizedMember === query) return 2
  if (includesTokenSequence(searchTokens(`${namespace}.${member.name}`), queryTokens)) return 3
  if (typeof member.description === 'string'
    && includesTokenSequence(searchTokens(member.description), queryTokens)) return 4
  return undefined
}

/** Deterministic hierarchy only. Details remain behind inspect. */
export function capabilityTree(metadata) {
  return metadataEntries(metadata).map((value) => {
    return {
      namespace: value.namespace,
      members: value.members.map(member => member.name),
      ...(value.revision === undefined ? {} : { revision: value.revision }),
      ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }),
    }
  })
}

/** Find lightweight candidates without returning full schemas or source. */
export function capabilityFind(metadata, query) {
  const trimmedQuery = text(query, 'capability query').trim()
  const normalizedQuery = trimmedQuery.toLowerCase()
  const queryTokens = searchTokens(trimmedQuery)
  const candidates = []
  let order = 0
  for (const entry of metadataEntries(metadata)) {
    for (const member of entry.members) {
      const rank = capabilityMatchRank(entry.namespace, member, normalizedQuery, queryTokens)
      if (rank !== undefined) {
        candidates.push({
          rank,
          order,
          value: {
            symbol: `${entry.namespace}.${member.name}`,
            ...(member.description === undefined ? {} : { description: member.description }),
            completeness: member.completeness ?? 'unknown',
            effect: member.effect ?? 'unknown',
            replay: member.replay ?? 'unknown',
          },
        })
      }
      order += 1
    }
  }
  return candidates
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map(candidate => candidate.value)
}

/** Batch, budgeted inspection; omitted items remain explicit to the caller. */
export function capabilityInspect(metadata, symbols = undefined, budget = 50) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('ptc-plus: capability inspection budget must be a positive integer')
  const entries = metadataEntries(metadata)
  const requested = symbols === undefined
    ? entries.flatMap(entry => entry.members.map(member => `${entry.namespace}.${member.name}`))
    : symbols
  if (!Array.isArray(requested)) throw new TypeError('ptc-plus: capability symbols must be an array')
  const bySymbol = new Map(entries.flatMap(entry => entry.members.map(member => [
    `${entry.namespace}.${member.name}`,
    { namespace: entry.namespace, ...member },
  ])))
  const selected = requested.slice(0, budget).flatMap((symbol) => {
    const key = text(symbol, 'capability symbol')
    const found = bySymbol.get(key)
    return found === undefined ? [] : [found]
  })
  return {
    symbols: selected,
    omitted: Math.max(0, requested.length - budget),
    unknown: requested.slice(0, budget).filter(symbol => !bySymbol.has(symbol)),
    budget,
  }
}

const SEARCH_DEFAULT_BYTES = 16_384
const SEARCH_MIN_BYTES = 512
const SEARCH_STOP_WORDS = new Set('a an and are as at be by can could do for from how i in is it me of on or please that the this to use using with would you 我 帮 帮我 请 的 了 和 与 在 如何 怎么 可以'.split(' '))
const SEARCH_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' })

function taskTerms(value) {
  const separated = value.normalize('NFKC')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
  return [...new Set([...SEARCH_SEGMENTER.segment(separated)]
    .filter(part => part.isWordLike && !SEARCH_STOP_WORDS.has(part.segment))
    .map(part => part.segment))]
}

function searchKeywords(value) {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join(' ')
  throw new TypeError('ptc-plus: capability search keywords must be a string or string array')
}

// Search budgets measure JSON, so non-JSON metadata cannot be silently converted or dropped.
function searchJson(value) {
  const ancestors = new Set()
  const visit = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object') throw new TypeError('ptc-plus: capability search metadata must be lossless JSON data')
    if (ancestors.has(item)) throw new TypeError('ptc-plus: capability search metadata must be lossless JSON data')
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== (Array.isArray(item) ? Array.prototype : Object.prototype) && prototype !== null) {
      throw new TypeError('ptc-plus: capability search metadata must be lossless JSON data')
    }
    ancestors.add(item)
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('ptc-plus: capability search metadata must be lossless JSON data')
      }
      visit(descriptor.value)
    }
    if (Array.isArray(item) && (Object.keys(item).length !== item.length
      || Object.keys(item).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) {
      throw new TypeError('ptc-plus: capability search metadata must be lossless JSON data')
    }
    ancestors.delete(item)
  }
  visit(value)
  return JSON.stringify(value, (_key, item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}

function searchDigest(value) {
  return createHash('sha256').update(value).digest('base64url')
}

function measuredSearchPage(value) {
  value.usedBytes = 0
  let bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  while (value.usedBytes !== bytes) {
    value.usedBytes = bytes
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  }
  return value
}

/** Derive one request-local lexical index from owner metadata; never owns invocation. */
export function createCapabilitySearcher(metadata) {
  const seen = new Set()
  const snapshot = JSON.parse(searchJson(metadata))
  const catalog = metadataEntries(snapshot).flatMap((entry) => {
    const { members, ...owner } = entry
    return members.map((member) => {
      const symbol = `${entry.namespace}.${member.name}`
      if (seen.has(symbol)) throw new TypeError(`ptc-plus: capability search has ambiguous symbol ${symbol}`)
      seen.add(symbol)
      const value = metadataSnapshot(JSON.parse(searchJson({ symbol, owner, contract: member })), 'capability search metadata')
      const names = new Set(taskTerms(symbol))
      const terms = new Set(taskTerms([
        symbol, member.description ?? '', owner.description ?? '',
        searchKeywords(member.keywords), searchKeywords(owner.keywords),
      ].join(' ')))
      return { value, names, terms }
    })
  }).sort((left, right) => left.value.symbol < right.value.symbol ? -1 : left.value.symbol > right.value.symbol ? 1 : 0)
  const catalogId = searchDigest(JSON.stringify(catalog.map(item => item.value)))

  return (args) => {
    const params = record(args, 'capability search arguments')
    const allowed = new Set(['query', 'budgetBytes', 'limit', 'cursor'])
    if (Reflect.ownKeys(params).some(key => typeof key !== 'string' || !allowed.has(key)
      || !Object.prototype.propertyIsEnumerable.call(params, key))) {
      throw new TypeError('ptc-plus: capability search has an unknown argument')
    }
    const query = text(params.query, 'capability search query').normalize('NFKC').trim().toLowerCase()
    const queryTerms = taskTerms(params.query)
    const budgetBytes = params.budgetBytes === undefined ? SEARCH_DEFAULT_BYTES : params.budgetBytes
    const limit = params.limit === undefined ? 10 : params.limit
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < SEARCH_MIN_BYTES) {
      throw new TypeError(`ptc-plus: capability search budgetBytes must be an integer of at least ${SEARCH_MIN_BYTES}`)
    }
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('ptc-plus: capability search limit must be a positive integer')
    const queryId = searchDigest(JSON.stringify({ query, terms: queryTerms }))
    const ranked = catalog.flatMap((candidate) => {
      const { symbol, owner, contract } = candidate.value
      const coverage = queryTerms.filter(term => candidate.terms.has(term)).length
      const nameCoverage = queryTerms.filter(term => candidate.names.has(term)).length
      const rank = symbol.normalize('NFKC').toLowerCase() === query ? 0
        : owner.namespace.normalize('NFKC').toLowerCase() === query ? 1
        : contract.name.normalize('NFKC').toLowerCase() === query ? 2
        : coverage === 0 ? undefined
        : nameCoverage === queryTerms.length ? 3
        : coverage === queryTerms.length ? 4 : 5
      return rank === undefined ? [] : [{ ...candidate, rank, coverage, nameCoverage }]
    }).sort((left, right) => left.rank - right.rank || right.coverage - left.coverage
      || right.nameCoverage - left.nameCoverage
      || (left.value.symbol < right.value.symbol ? -1 : left.value.symbol > right.value.symbol ? 1 : 0))

    let offset = 0
    if (params.cursor !== undefined) {
      if (typeof params.cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(params.cursor)) {
        throw new TypeError('ptc-plus: capability search cursor is invalid')
      }
      let cursor
      try { cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) } catch {
        throw new TypeError('ptc-plus: capability search cursor is invalid')
      }
      if (cursor?.version !== 1 || cursor.catalog !== catalogId || cursor.query !== queryId
        || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= ranked.length
        || Buffer.from(JSON.stringify(cursor)).toString('base64url') !== params.cursor) {
        throw new TypeError('ptc-plus: capability search cursor is invalid or catalog/query changed')
      }
      offset = cursor.offset
    }

    const page = (matches, oversized, next) => measuredSearchPage({
      matches, oversized, total: ranked.length, remaining: ranked.length - next,
      cursor: next < ranked.length ? Buffer.from(JSON.stringify({
        version: 1, catalog: catalogId, query: queryId, offset: next,
      })).toString('base64url') : null,
      budgetBytes, unit: 'utf8-json-bytes', usedBytes: 0,
    })
    let result = page([], [], offset)
    for (let next = offset; next < ranked.length && next - offset < limit; next += 1) {
      const candidate = ranked[next].value
      const expanded = page([...result.matches, candidate], result.oversized, next + 1)
      if (expanded.usedBytes <= budgetBytes) {
        result = expanded
        continue
      }
      const alone = page([candidate], [], next + 1)
      if (alone.usedBytes <= budgetBytes) break
      const omitted = {
        symbol: candidate.symbol, requiredBytes: alone.usedBytes,
        inspect: { symbols: [candidate.symbol], budget: 1 },
      }
      const bounded = page(result.matches, [...result.oversized, omitted], next + 1)
      if (bounded.usedBytes > budgetBytes) {
        if (next === offset) throw new RangeError(`ptc-plus: capability search needs at least ${bounded.usedBytes} budgetBytes for its continuation and inspect reference`)
        break
      }
      result = bounded
    }
    if (result.usedBytes > budgetBytes) throw new RangeError(`ptc-plus: capability search needs at least ${result.usedBytes} budgetBytes for its continuation`)
    return result
  }
}

/** Return whole owner contracts within a UTF-8 JSON byte budget, including the envelope. */
export function capabilitySearch(metadata, args) {
  return createCapabilitySearcher(metadata)(args)
}
