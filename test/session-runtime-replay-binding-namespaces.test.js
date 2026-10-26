import assert from 'node:assert/strict'
import test from 'node:test'
import { replayBindingNamespaces } from '../internal/session-runtime.js'
import { encodeValueAtBoundary } from '../internal/value-wire.js'

// A capability the Host no longer supplies must stay visible to a replayed cell
// as a replay-only stub, and a zero-argument call must keep the recorded
// empty-object form so the argument wire still matches the journal. This pins
// that second half: the member is remembered as an empty-object receiver rather
// than only as a stub.
const LIMITS = { maxNodes: 1000, maxEdges: 1000, maxBytes: 65536, maxDepth: 8 }

function emptyArgs() {
  return encodeValueAtBoundary({}, LIMITS, 'parameter')
}

test('a replay-only member called with no arguments keeps its empty-object form', () => {
  const namespaces = [{ global: 'tools', members: ['kept'], functions: { kept: () => 1 }, emptyObjectMembers: [] }]
  const journal = { calls: [
    { global: 'tools', member: 'removed', args: emptyArgs() },
    { global: 'tools', member: 'kept', args: emptyArgs() },
  ] }

  const [namespace] = replayBindingNamespaces(namespaces, journal, LIMITS, emptyArgs())

  assert.deepEqual(namespace.emptyObjectMembers, ['removed'],
    'the zero-argument call for a removed member was not remembered as an empty-object receiver')
  assert.equal(typeof namespace.functions.removed, 'function', 'the removed member lost its replay-only stub')
  assert.throws(() => namespace.functions.removed(), /replay-only member tools\.removed/,
    'dispatching a replay-only member must fail loudly rather than run something else')
  assert.equal(namespace.functions.kept(), 1, 'a retained member was replaced by a stub')
})

test('a member the Host still supplies is not turned into a replay-only stub', () => {
  const namespaces = [{ global: 'tools', members: ['kept'], functions: { kept: () => 1 }, emptyObjectMembers: [] }]
  const journal = { calls: [{ global: 'tools', member: 'kept', args: emptyArgs() }] }

  const [namespace] = replayBindingNamespaces(namespaces, journal, LIMITS, emptyArgs())

  assert.deepEqual(namespace.emptyObjectMembers, [])
  assert.equal(namespace.functions.kept(), 1)
})

test('a journal for another global leaves the namespace untouched', () => {
  const namespaces = [{ global: 'tools', members: [], functions: {}, emptyObjectMembers: [] }]
  const journal = { calls: [{ global: 'other', member: 'removed', args: emptyArgs() }] }

  const [namespace] = replayBindingNamespaces(namespaces, journal, LIMITS, emptyArgs())

  assert.deepEqual(namespace, namespaces[0])
})
