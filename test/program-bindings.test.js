import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capabilityFind,
  capabilityInspect,
  capabilityTree,
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
})
