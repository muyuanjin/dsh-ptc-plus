import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capabilityFind,
  capabilityInspect,
  capabilitySearch,
  capabilityTree,
  createCapabilitySearcher,
  toolCapabilityMetadata,
} from '../internal/program-bindings.js'

test('exploration is descriptive, deterministic, and budgeted', () => {
  const metadata = [{
    namespace: 'files',
    members: [
      { name: 'read', completeness: 'bounded', replay: 'recorded-value' },
      { name: 'write', completeness: 'complete', replay: 'volatile' },
    ],
  }]
  assert.deepEqual(capabilityTree(metadata), [{ namespace: 'files', members: ['read', 'write'] }])
  assert.deepEqual(capabilityFind(metadata, 'files.read'), [{
    symbol: 'files.read', completeness: 'bounded', effect: 'unknown', replay: 'recorded-value',
  }])
  assert.deepEqual(capabilityInspect(metadata, undefined, 1), {
    symbols: [{ namespace: 'files', name: 'read', completeness: 'bounded', replay: 'recorded-value' }],
    omitted: 1,
    unknown: [],
    budget: 1,
  })
})

test('find ranks symbols and matches only complete identifier or description tokens', () => {
  const metadata = [
    {
      namespace: 'tools',
      members: [
        { name: 'edit', description: 'Replace one exact range.' },
        { name: 'todo_write', description: 'REPLACES the complete todo list.' },
        { name: 'write', description: 'Write or replace a file.' },
      ],
    },
    {
      namespace: 'repl',
      members: [
        { name: 'state', description: 'Inspect persistent REPL state.' },
        { name: 'saveState', description: 'Save one named checkpoint.' },
      ],
    },
    {
      namespace: 'docs',
      members: [
        { name: 'lookup', description: 'Inspect tools metadata.' },
        { name: 'HTTPServerStatus', description: 'Inspect one service.' },
      ],
    },
  ]

  assert.deepEqual(capabilityFind(metadata, 'repl').map(value => value.symbol), [
    'repl.state',
    'repl.saveState',
  ])
  assert.deepEqual(capabilityFind(metadata, 'REPL.STATE').map(value => value.symbol), [
    'repl.state',
  ])
  assert.deepEqual(capabilityFind(metadata, 'save state').map(value => value.symbol), [
    'repl.saveState',
  ])
  assert.deepEqual(capabilityFind(metadata, 'persistent repl').map(value => value.symbol), [
    'repl.state',
  ])
  assert.deepEqual(capabilityFind(metadata, 'http server status').map(value => value.symbol), [
    'docs.HTTPServerStatus',
  ])
  assert.deepEqual(capabilityFind(metadata, 'serverStatus').map(value => value.symbol), [
    'docs.HTTPServerStatus',
  ])
  assert.deepEqual(capabilityFind(metadata, 'tools').map(value => value.symbol), [
    'tools.edit',
    'tools.todo_write',
    'tools.write',
    'docs.lookup',
  ])
})

test('rejects malformed metadata and replay classifications', () => {
  assert.throws(() => capabilityFind([], ''), /query must be a non-empty string/)
  assert.throws(() => toolCapabilityMetadata([null]), /tool schema must be an object/)
  assert.throws(
    () => toolCapabilityMetadata([{ name: 'read', parameters: { transform() {} }, output: {} }]),
    /parameters must be structured data/,
  )
  assert.throws(
    () => toolCapabilityMetadata([{ name: 'read', parameters: {}, output: {} }], { read: { replay: 'maybe' } }),
    /read\.replay is invalid/,
  )
})

test('short lexical queries and tree member traversal discover capabilities after a prose miss', () => {
  const metadata = [
    { namespace: 'tools', members: [{ name: 'read', description: 'Read a bounded file window.' }] },
    { namespace: 'code', members: [{ name: 'run', description: 'Run isolated source already held as data.' }] },
  ]
  assert.deepEqual(capabilityFind(metadata, 'read file content'), [])
  assert.deepEqual(capabilityFind(metadata, 'isolated execution run code child'), [])
  assert.deepEqual(capabilityFind(metadata, 'rea'), [])
  assert.deepEqual(capabilityFind(metadata, 'read window'), [])
  assert.deepEqual(capabilityFind(metadata, 'read').map(item => item.symbol), ['tools.read'])
  assert.deepEqual(capabilityFind(metadata, 'CODE.RUN').map(item => item.symbol), ['code.run'])
  assert.deepEqual(capabilityFind(metadata, 'bounded file').map(item => item.symbol), ['tools.read'])
  const symbols = capabilityTree(metadata).flatMap(entry => entry.members.map(member => `${entry.namespace}.${member}`))
  assert.deepEqual(symbols, ['tools.read', 'code.run'])
  assert.deepEqual(capabilityInspect(metadata, [...symbols, 'tools.missing'], 3).unknown, ['tools.missing'])
  assert.equal(capabilityFind(metadata, 'read')[0].completeness, 'unknown')
})

test('projects live tool schemas as unknown unless an explicit annotation proves more', () => {
  const metadata = toolCapabilityMetadata([
    { name: 'write', description: 'Write a file.', parameters: { type: 'object' }, output: { type: 'object' } },
    { name: 'read', description: 'Read a page.', parameters: { type: 'object' }, output: { type: 'object' } },
    { name: 'run_code', description: 'Transport.', parameters: {}, output: {} },
  ], { read: {
    completeness: 'bounded',
    replay: 'owner-replay',
    effect: 'filesystem.read',
    sourceRef: { kind: 'runtime', path: 'tool:read' },
    revision: 'r2',
    fingerprint: 'read-f2',
  } })
  assert.deepEqual(metadata[0].members.map(member => [member.name, member.completeness]), [
    ['read', 'bounded'], ['write', 'unknown'],
  ])
  assert.equal(metadata[0].members[0].effect, 'filesystem.read')
  assert.equal(metadata[0].members[0].replay, 'owner-replay')
  assert.deepEqual(metadata[0].members[0].sourceRef, { kind: 'runtime', path: 'tool:read' })
  assert.equal(metadata[0].members[0].revision, 'r2')
  assert.equal(metadata[0].members[0].fingerprint, 'read-f2')
  assert.equal(metadata[0].members[1].authority, 'dsh-tool-dispatch')
  assert.equal(metadata[0].members[1].replay, 'unknown')
  assert.throws(
    () => toolCapabilityMetadata([{ name: 'read', parameters: {}, output: {} }], {
      read: { completeness: 'entire-ish' },
    }),
    /read\.completeness is invalid/,
  )
})

test('preserves every replay classification through find and inspect', () => {
  const replay = ['recorded-value', 'owner-replay', 'volatile', 'unknown']
  const metadata = [{
    namespace: 'tools',
    members: replay.map((value, index) => ({ name: `call${index}`, replay: value })),
  }]
  assert.deepEqual(
    capabilityFind(metadata, 'tools').map(member => member.replay),
    replay,
  )
  assert.deepEqual(
    capabilityInspect(metadata).symbols.map(member => member.replay),
    replay,
  )
  assert.deepEqual(capabilitySearch(metadata, { query: 'tools' }).matches.map(member => member.contract.replay), replay)
})

function assertSearchBudget(page, budgetBytes) {
  assert.equal(page.unit, 'utf8-json-bytes')
  assert.equal(page.budgetBytes, budgetBytes)
  assert.equal(page.usedBytes, Buffer.byteLength(JSON.stringify(page), 'utf8'))
  assert.ok(page.usedBytes <= budgetBytes)
}

test('search retrieves complete owner contracts for non-contiguous English and Chinese tasks', () => {
  const metadata = [{
    namespace: 'files', owner: 'public-files-owner', revision: 'r2', keywords: ['repository'],
    members: [{
      name: 'readFile', description: 'Read a bounded file window. 读取文件的指定窗口。',
      keywords: ['content', '内容'], parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      returns: { type: 'string' }, sourceRef: { kind: 'authored', path: 'public/files.ts' },
      completeness: 'bounded', replay: 'owner-replay', effect: 'filesystem.read',
    }],
  }, { namespace: 'state', members: [{ name: 'read', description: 'Read checkpoint names.' }] }]
  for (const query of ['Please read file content from the repository', '请帮我读取文件的内容', 'read window']) {
    const page = capabilitySearch(metadata, { query, budgetBytes: 4096 })
    assertSearchBudget(page, 4096)
    assert.equal(page.matches[0].symbol, 'files.readFile')
    assert.deepEqual(page.matches[0].contract, metadata[0].members[0])
    assert.deepEqual(page.matches[0].owner, {
      namespace: 'files', owner: 'public-files-owner', revision: 'r2', keywords: ['repository'],
    })
    assert.equal(page.cursor, null)
    assert.equal(page.remaining, 0)
  }
  assert.deepEqual(capabilitySearch(metadata, { query: 'rea' }).matches, [])
  assert.deepEqual(capabilitySearch(metadata, { query: 'unrelated' }).matches, [])
  assert.deepEqual(capabilityFind(metadata, 'read window'), [])
})

test('search ranks exact identities before task words and distinguishes same names across namespaces', () => {
  const metadata = [
    { namespace: 'b', members: [{ name: 'read', description: 'Read a read file.' }] },
    { namespace: 'a', members: [{ name: 'read', description: 'Read file.' }] },
    { namespace: 'b', members: [{ name: 'lookup', description: 'Read file.' }] },
    { namespace: 'other', members: [{ name: 'a', description: 'Read file.' }] },
  ]
  assert.equal(capabilitySearch(metadata, { query: 'A.READ' }).matches[0].symbol, 'a.read')
  assert.equal(capabilitySearch(metadata, { query: 'b' }).matches[0].symbol, 'b.lookup')
  assert.deepEqual(capabilitySearch(metadata, { query: 'read' }).matches.map(item => item.symbol), [
    'a.read', 'b.read', 'b.lookup', 'other.a',
  ])
  assert.equal(capabilitySearch(metadata, { query: 'read file' }).matches[0].symbol, 'a.read')
  assert.deepEqual(capabilitySearch(metadata, { query: 'read' }), capabilitySearch([...metadata].reverse(), { query: 'read' }))
  assert.throws(() => capabilitySearch([...metadata, metadata[0]], { query: 'read' }), /ambiguous symbol b\.read/)
})

test('search bounds thousands of members including wrappers and resumes without missing or repeating matches', () => {
  const metadata = [{
    namespace: 'tools', members: Array.from({ length: 2500 }, (_, index) => ({
      name: `read${String(index).padStart(4, '0')}`, description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    })),
  }]
  const search = createCapabilitySearcher(metadata)
  let page = search({ query: 'read file', budgetBytes: 2048, limit: 7 })
  assert.equal(page.total, 2500)
  assert.ok(page.matches.length > 0 && page.matches.length <= 7)
  const visited = []
  do {
    assertSearchBudget(page, 2048)
    visited.push(...page.matches.map(item => item.symbol))
    assert.deepEqual(page.oversized, [])
    if (page.cursor === null) break
    const cursor = page.cursor
    page = search({ query: 'read file', budgetBytes: 2048, limit: 7, cursor })
    assert.deepEqual(page, search({ query: 'read file', budgetBytes: 2048, limit: 7, cursor }))
  } while (page.remaining >= 0)
  assert.equal(visited.length, 2500)
  assert.equal(new Set(visited).size, 2500)
  assert.deepEqual(visited, metadata[0].members.map(item => `tools.${item.name}`))
})

test('search reports oversized schemas without truncation and counts Chinese, escaping and continuation bytes', () => {
  const parameters = {
    type: 'object', $defs: { shared: { type: 'string', description: '中文🙂\\\"'.repeat(500) } },
    properties: { value: { $ref: '#/$defs/shared' } }, required: ['value'],
  }
  const metadata = [{ namespace: 'tools', members: [
    { name: 'readA', description: 'Read a file.', parameters },
    { name: 'readB', description: 'Read a file.', parameters: {} },
  ] }]
  const page = capabilitySearch(metadata, { query: 'read file', budgetBytes: 1024 })
  assertSearchBudget(page, 1024)
  assert.deepEqual(page.matches.map(item => item.symbol), ['tools.readB'])
  assert.deepEqual(page.oversized[0].inspect, { symbols: ['tools.readA'], budget: 1 })
  assert.ok(page.oversized[0].requiredBytes > 1024)
  assert.deepEqual(capabilityInspect(metadata, page.oversized[0].inspect.symbols, 1).symbols[0].parameters, parameters)
  const expanded = capabilitySearch(metadata, { query: 'tools.readA', budgetBytes: 20000 })
  assertSearchBudget(expanded, 20000)
  assert.deepEqual(expanded.matches[0].contract.parameters, parameters)
  assert.ok(Buffer.byteLength(JSON.stringify(expanded), 'utf8') > JSON.stringify(expanded).length)
  assert.equal(expanded.unit.includes('token'), false)
  assert.deepEqual(metadata[0].members[0].parameters, parameters)
})

test('search rejects malformed parameters, changed cursors and non-JSON contracts without changing legacy APIs', () => {
  const metadata = [{ namespace: 'files', members: [{ name: 'read' }, { name: 'readAll' }] }]
  for (const params of [undefined, null, [], {}, { query: null }, { query: '' }, { query: ' ' },
    { query: 'read', budgetBytes: 1 }, { query: 'read', budgetBytes: 1024.5 }, { query: 'read', budgetBytes: null },
    { query: 'read', limit: 0 }, { query: 'read', limit: null }, { query: 'read', limit: Infinity },
    { query: 'read', surprise: true }, { query: 'read', cursor: null }, { query: 'read', cursor: 'broken' }]) {
    assert.throws(() => capabilitySearch(metadata, params), TypeError)
  }
  const first = capabilitySearch(metadata, { query: 'read', limit: 1 })
  assert.ok(first.cursor)
  assert.throws(() => capabilitySearch(metadata, { query: 'readAll', cursor: first.cursor }), /catalog\/query changed/)
  assert.throws(() => capabilitySearch([{ namespace: 'files', members: [{ name: 'read', revision: 'changed' }, { name: 'readAll' }] }], {
    query: 'read', cursor: first.cursor,
  }), /catalog\/query changed/)
  assert.deepEqual(capabilitySearch(metadata, { query: 'read', limit: 1, cursor: first.cursor }).matches.map(item => item.symbol), ['files.readAll'])
  const reordered = [{ members: [{ name: 'read' }, { name: 'readAll' }], namespace: 'files' }]
  assert.deepEqual(capabilitySearch(reordered, { query: 'read', limit: 1, cursor: first.cursor }).matches.map(item => item.symbol), ['files.readAll'])
  const camelMetadata = [{ namespace: 'files', members: [{ name: 'readFile' }, { name: 'other', description: 'Read a file.' }] }]
  const camelPage = capabilitySearch(camelMetadata, { query: 'readFile', limit: 1 })
  assert.ok(camelPage.cursor)
  assert.throws(() => capabilitySearch(camelMetadata, { query: 'readfile', cursor: camelPage.cursor }), /catalog\/query changed/)
  for (const parameters of [{ impossible: undefined }, { impossible: 1n }, { impossible: new Date() }, { impossible: NaN },
    { impossible: new Map() }, { impossible: [, 1] }]) {
    const value = [{ namespace: 'files', members: [{ name: 'read', parameters }] }]
    assert.throws(() => capabilitySearch(value, { query: 'read' }), /lossless JSON data/)
    assert.deepEqual(capabilityInspect(value).symbols[0].parameters, parameters)
  }
  const hugeName = `read${'字'.repeat(1000)}`
  assert.throws(() => capabilitySearch([{ namespace: 'files', members: [{ name: hugeName }] }], {
    query: hugeName, budgetBytes: 512,
  }), /needs at least.*inspect reference/)
})

test('search retains an immutable request-local catalog snapshot', () => {
  const metadata = [{ namespace: 'files', members: [{ name: 'read', parameters: { type: 'object' } }] }]
  const search = createCapabilitySearcher(metadata)
  metadata[0].members[0].parameters.type = 'string'
  const first = search({ query: 'read' })
  assert.equal(first.matches[0].contract.parameters.type, 'object')
  assert.throws(() => { first.matches[0].contract.parameters.type = 'number' }, TypeError)
  assert.deepEqual(search({ query: 'read' }), first)
})

test('search validates original owner member and nested JSON structure before normalization', () => {
  for (const level of ['owner', 'member', 'parameters']) {
    for (const kind of ['accessor', 'non-enumerable', 'prototype']) {
      let reads = 0
      const parameters = { type: 'object' }
      const member = { name: 'read', parameters }
      const owner = { namespace: 'files', members: [member] }
      const target = level === 'owner' ? owner : level === 'member' ? member : parameters
      if (kind === 'prototype') Object.setPrototypeOf(target, { description: 'Read file.' })
      else Object.defineProperty(target, 'description', kind === 'accessor'
        ? { enumerable: true, get() { reads += 1; return 'Read file.' } }
        : { enumerable: false, value: 'Read file.' })
      assert.throws(() => createCapabilitySearcher([owner]), /lossless JSON data/, `${level}: ${kind}`)
      assert.equal(reads, 0, `${level}: ${kind} must not invoke accessors`)
      // Existing discovery retains its historical metadata acceptance boundary.
      assert.equal(capabilityTree([owner])[0].members[0], 'read')
      assert.equal(capabilityInspect([owner]).symbols[0].name, 'read')
    }
  }
  for (const level of ['catalog', 'members', 'parameters']) {
    let reads = 0
    const parameters = ['native']
    const metadata = [{ namespace: 'files', members: [{ name: 'read', parameters }] }]
    const target = level === 'catalog' ? metadata : level === 'members' ? metadata[0].members : parameters
    const prototype = Object.create(Array.prototype)
    Object.defineProperty(prototype, 'toJSON', {
      get() { reads += 1; return () => ['changed'] },
    })
    Object.setPrototypeOf(target, prototype)
    assert.throws(() => createCapabilitySearcher(metadata), /lossless JSON data/)
    assert.equal(reads, 0, `${level} array must not invoke inherited toJSON`)
    Object.setPrototypeOf(target, null)
    assert.deepEqual(createCapabilitySearcher(metadata)({ query: 'read' }).matches[0].contract.parameters, ['native'])
  }
})


test('search rejects invalid keyword evidence and paginates oversized inspect references within the byte budget', () => {
  for (const keywords of [42, ['read', 2]]) {
    assert.throws(() => createCapabilitySearcher([{ namespace: 'files', members: [{ name: 'read', keywords }] }]), /keywords must be a string or string array/)
    assert.throws(() => createCapabilitySearcher([{ namespace: 'files', keywords, members: [{ name: 'read' }] }]), /keywords must be a string or string array/)
  }
  const names = [0, 1, 2].map(index => `read${index}${'x'.repeat(240)}`)
  const search = createCapabilitySearcher([{ namespace: 'files', members: names.map(name => ({ name, description: 'read ' + 'large '.repeat(1000) })) }])
  let cursor
  const found = []
  do {
    const page = search({ query: 'read', budgetBytes: 1024, cursor })
    assert.ok(page.usedBytes <= 1024)
    assert.equal(page.matches.length, 0)
    assert.equal(page.oversized.length, 1)
    found.push(page.oversized[0].symbol)
    cursor = page.cursor ?? undefined
  } while (cursor)
  assert.deepEqual(found, names.map(name => `files.${name}`))
})
