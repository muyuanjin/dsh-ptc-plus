import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { fixture, orderedSurfaceSession, ptcAgent } from './plugin-fixture.js'
import { PROMPT_SLOTS, PROMPT_TEXT_SCHEMA } from '../internal/prompt-text.js'
import { ANCHOR_ASSETS, KNOWN_GAPS } from './prompt-surface-map.js'
import { PROMPT_ANCHORS, PROMPT_CHANNELS } from '../internal/prompt-text.js'
import { LANES } from './prompt-surface-lanes.js'
import { PROMPT_SURFACE_COMPOSERS } from './prompt-surface-composers.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Ground truth for "every fixed text the model sees from this plugin".
 *
 * The baseline is what the host passes into assembly; the captured request is
 * what comes out. Their difference is the plugin's contribution, so the surface
 * cannot be under-reported by forgetting a composer: an unclaimed block fails,
 * and a claimed block whose bytes change fails on its recorded hash.
 *
 * Two assertions keep this honest:
 * - two-way emptiness: every captured anchor is claimed, every claim is visible;
 * - a canary appended to a claimed block must change its hash, which proves the
 *   gate reacts to unregistered text instead of trusting its own list.
 *
 * The recorded hashes and the plan golden live in test/prompt-surface-lanes.js, so a
 * channel is captured only when a lane file exists and reads its expectation from
 * that shared module; this file itself is the lane for the assembly channels.
 */
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex')

/** Recorded surface: anchors are the delivery names, hashes are the bytes. */
const SURFACE = Object.freeze({
  addedSections: [{ anchor: 'tools:ptc-plus-repl', hash: LANES.prompt.hashes['tools:ptc-plus-repl'] }],
  modifiedSections: [{ anchor: 'tools:sdk', hash: LANES.prompt.hashes['tools:sdk'] }],
  tools: [{ anchor: 'run_code', hash: LANES.prompt.hashes.run_code }],
  installTools: [{ anchor: 'edit_run_code', hash: LANES.install.hashes.edit_run_code }],
  appendices: [{ anchor: 'tools:sdk#capability-appendix', hash: LANES.prompt.hashes['tools:sdk#capability-appendix'] }],
  contexts: [],
})

async function capture(t, { canary = false } = {}) {
  const state = fixture({})
  t.after(() => state.dispose())
  const id = `prompt-surface-${Math.random().toString(36).slice(2)}`
  const agent = ptcAgent(id, orderedSurfaceSession(id))
  const baselineSections = [{ name: 'tools:sdk', text: renderToolsSdk([]) }]
  // The host definition is a live object: the plugin adapts the editable slots onto
  // the same object the executor projects, so a reference would describe the
  // delivered bytes instead of the bytes the host passed in. The baseline is a
  // snapshot taken before assembly for exactly that reason.
  const baselineTools = [structuredClone(state.runCodeDefinition)]
  const pluginSection = state.sections[0]
  const text = pluginSection.text({})
  const assembled = await state.assemble({
    sections: [...baselineSections, {
      name: pluginSection.name,
      text: canary ? `${text}\n\nCANARY unregistered sentence.` : text,
    }],
    contexts: [],
    variables: {},
    tools: baselineTools,
  }, { agent, scope: agent })
  const baseNames = new Set(baselineSections.map(section => section.name))
  const addedSections = assembled.sections
    .filter(section => !baseNames.has(section.name))
    .map(section => ({ anchor: section.name, hash: sha256(section.text) }))
  const modifiedSections = assembled.sections
    .filter(section => baseNames.has(section.name))
    .filter(section => section.text !== baselineSections.find(base => base.name === section.name).text)
    .map(section => ({ anchor: section.name, hash: sha256(section.text) }))
  const tools = assembled.tools
    .filter(tool => {
      const base = baselineTools.find(candidate => candidate.name === tool.name)
      return base === undefined || JSON.stringify(base) !== JSON.stringify(tool)
    })
    .map(tool => ({ anchor: tool.name, hash: sha256(JSON.stringify(tool)) }))
  const scoped = agent.ctx?.tools?.get?.('edit_run_code')
  const installTools = scoped === undefined ? [] : [{ anchor: 'edit_run_code', hash: sha256(JSON.stringify(scoped)) }]
  const contexts = (assembled.contexts ?? []).map(context => ({
    anchor: context.name ?? context.id, hash: sha256(JSON.stringify(context)),
  }))
  // An appendix is appended into a host-owned section, so it needs its own anchor:
  // hashing the whole section would hide which part the plugin contributed.
  const APPENDIX_MARKER = '## PTC Plus program capabilities'
  const appendices = assembled.sections
    .filter(section => typeof section.text === 'string' && section.text.includes(APPENDIX_MARKER))
    .map(section => ({
      anchor: `${section.name}#capability-appendix`,
      hash: sha256(section.text.slice(section.text.indexOf(APPENDIX_MARKER))),
    }))
  return { addedSections, modifiedSections, tools, contexts, installTools, appendices }
}

test('every fixed text the plugin contributes to a request is claimed, with its recorded bytes', async t => {
  const captured = await capture(t)
  for (const lane of ['addedSections', 'modifiedSections', 'tools', 'installTools', 'contexts', 'appendices']) {
    assert.deepEqual(captured[lane], SURFACE[lane],
      `${lane}: captured ${JSON.stringify(captured[lane])} does not match the recorded surface; `
      + 'register the new block in internal/prompt-text.js and record its hash deliberately')
  }
})

test('a declared gap may only name an anchor its lane leaves pending', () => {
  // A gap is a claim about capture, so it must agree with the lane: a gap whose
  // anchor the lane already pins would keep hiding work the gate can see, and a gap
  // for a channel without a lane is the only place that channel can say "not yet".
  for (const gap of KNOWN_GAPS) {
    assert.ok(Object.hasOwn(ANCHOR_ASSETS, gap.anchor), `${gap.anchor}: a gap must name a registered anchor`)
    const anchor = PROMPT_ANCHORS.find(candidate => candidate.id === gap.anchor)
    assert.ok(anchor !== undefined, `${gap.anchor}: a gap must name a registry anchor`)
    assert.equal(gap.channel, anchor.channel, `${gap.anchor}: state the channel`)
    // A gap is about capture, never about wiring. Once the anchor is wired, a reason
    // that still blames wiring is stale prose that hides why the lane is missing.
    if (anchor.wired === true) {
      assert.doesNotMatch(gap.reason, /not wired|未接通/iu,
        `${gap.anchor}: the anchor is wired, so the gap reason must name the missing capture, not wiring`)
    }
    const lane = LANES[anchor.channel]
    if (lane === undefined) continue
    assert.ok(!capturedAnchors(lane).includes(gap.anchor),
      `${gap.anchor}: channel ${anchor.channel} pins this anchor, remove the gap`)
    assert.ok(Object.hasOwn(lane.pending ?? {}, gap.anchor),
      `${gap.anchor}: the lane must list this anchor as pending while it is a gap`)
  }
})

test('every channel is either captured by a lane that pins each anchor, or named as uncaptured', async t => {
  const HASH = /^[0-9a-f]{64}$/u
  const captured = await capture(t)
  const capturedByAnchor = new Map([
    ...captured.addedSections,
    ...captured.modifiedSections,
    ...captured.tools,
    ...captured.installTools,
    ...captured.contexts,
    ...captured.appendices,
  ].map(entry => [entry.anchor, entry.hash]))
  // Every captured channel must be a registry channel; the evidence file and the
  // composer map must describe the same set, so a channel cannot be claimed by one
  // side alone.
  for (const channel of [...Object.keys(LANES), ...Object.keys(PROMPT_SURFACE_COMPOSERS)]) {
    assert.ok(PROMPT_CHANNELS.includes(channel), `${channel}: a captured channel must be a registry channel`)
  }
  const composedChannels = Object.keys(PROMPT_SURFACE_COMPOSERS)
  for (const channel of Object.keys(LANES)) {
    const lane = LANES[channel]
    if (lane.kind === 'bytes') {
      assert.ok(composedChannels.includes(channel),
        `${channel}: a byte lane must have a composer in test/prompt-surface-composers.js, `
        + 'because the gate refuses to take delivered bytes from the evidence file')
    }
  }
  for (const channel of PROMPT_CHANNELS) {
    const anchors = PROMPT_ANCHORS.filter(anchor => anchor.channel === channel).map(anchor => anchor.id)
    if (anchors.length === 0) continue
    const lane = LANES[channel]
    if (lane === undefined) {
      // Not captured yet: every anchor of the channel must still be declared as a
      // known gap, so an uncaptured channel cannot hide behind an empty list.
      for (const anchor of anchors) {
        assert.ok(KNOWN_GAPS.some(gap => gap.anchor === anchor),
          `channel ${channel} is not captured and ${anchor} is not a declared gap`)
      }
      continue
    }

    const capturedLane = capturedAnchors(lane)
    const pending = Object.keys(lane.pending ?? {})
    const hostAnchors = lane.hostAnchors ?? []
    // A host anchor the registry does not own is pinned beside the registry anchors;
    // the registered segment inside it is what the channel actually contributes.
    const hostOnly = hostAnchors.filter(anchor => !anchors.includes(anchor))

    // (a) the lane must be a real test file in this checkout.
    assert.match(lane.file, /^test\/[^/]+\.test\.js$/u, `${channel}: the lane is a repository test file`)
    assert.ok(existsSync(resolve(REPO_ROOT, lane.file)), `${channel}: lane ${lane.file} does not exist`)

    // (b) captured and pending must partition the channel, not overlap: an anchor is
    // either pinned by this lane or explicitly out of its reach with a reason. A host
    // anchor that the registry does not own is listed separately, because the appended
    // segment inside it is the registered one.
    assert.deepEqual([...new Set([...capturedLane.filter(anchor => !hostOnly.includes(anchor)), ...pending])].sort(), [...anchors].sort(),
      `${channel}: every anchor must be captured or pending, and the lane may not claim a foreign anchor`)
    for (const anchor of hostOnly) {
      assert.ok(capturedLane.includes(anchor), `${channel}: host anchor ${anchor} is claimed but not pinned by this lane`)
    }
    for (const anchor of capturedLane) {
      assert.ok(!pending.includes(anchor), `${channel}/${anchor}: an anchor cannot be captured and pending`)
    }
    for (const anchor of [...capturedLane, ...pending]) {
      const registered = PROMPT_ANCHORS.find(candidate => candidate.id === anchor)
      if (registered === undefined) {
        // A host-owned section the plugin appends into is hashed as a segment, not
        // registered as an anchor; it still needs its own recorded bytes.
        assert.ok(Object.hasOwn(lane.hashes ?? {}, anchor),
          `${channel}: host anchor ${anchor} is claimed but has no recorded hash`)
        continue
      }
      assert.equal(registered.channel, channel, `${channel}: lane claims ${anchor} of channel ${registered.channel}`)
    }
    for (const [anchor, reason] of Object.entries(lane.pending ?? {})) {
      assert.equal(typeof reason, 'string', `${channel}/${anchor}: state why the lane cannot capture it`)
      assert.ok(reason.length >= 20, `${channel}/${anchor}: the pending reason must say something`)
      const gap = KNOWN_GAPS.find(candidate => candidate.anchor === anchor)
      assert.ok(gap !== undefined, `${channel}/${anchor}: a pending anchor must be declared in KNOWN_GAPS`)
      assert.equal(gap.channel, channel, `${channel}/${anchor}: the gap belongs to another channel`)
    }
    for (const gap of KNOWN_GAPS.filter(candidate => candidate.channel === channel)) {
      assert.ok(pending.includes(gap.anchor),
        `${gap.anchor}: ${lane.file} captures it now, remove the gap`)
    }

    // (c) The gate captures the bytes itself: for an assembly channel from the
    // request it assembles here, for a byte channel by calling the composer map the
    // gate imports. The evidence file records expectations only — a lane that
    // supplies its own bytes could satisfy its own hash without touching the plugin.
    if (lane.kind === 'bytes') {
      assert.equal(lane.deliver, undefined,
        `${channel}: the evidence file must not supply delivery; the gate owns it`)
      const composer = PROMPT_SURFACE_COMPOSERS[channel]
      assert.equal(typeof composer, 'function',
        `${channel}: add the production composer to test/prompt-surface-composers.js`)
      const laneSource = readFileSync(resolve(REPO_ROOT, lane.file), 'utf8')
      assert.match(laneSource, new RegExp(`PROMPT_SURFACE_COMPOSERS\\.${channel}`, 'u'),
        `${channel}: ${lane.file} must exercise the same composer the gate hashes`)
      const delivered = await composer()
      assert.equal(typeof delivered, 'string', `${channel}: the composer must return the delivered text`)
      assert.equal(sha256(lane.golden.text), lane.golden.hash,
        `${channel}: the golden hash must match its recorded text`)
      assert.ok(lane.golden.text.length >= 32,
        `${channel}: a golden shorter than 32 bytes cannot carry an anchor fragment`)
      assert.equal(sha256(delivered), lane.golden.hash,
        `${channel}: the delivered bytes differ from the recorded golden; `
        + 'record the new text and hash in test/prompt-surface-lanes.js and say why')
      for (const anchor of capturedLane) {
        const evidence = lane.captured?.[anchor]
        assert.ok(evidence !== undefined, `${channel}/${anchor}: a captured anchor needs its own evidence`)
        assert.equal(typeof evidence.fragment, 'string', `${channel}/${anchor}: record the delivered fragment`)
        assert.ok(evidence.fragment.length >= 16,
          `${channel}/${anchor}: a fragment shorter than 16 bytes cannot prove delivery`)
        assert.ok(delivered.includes(evidence.fragment),
          `${channel}/${anchor}: the delivered bytes do not contain this anchor's fragment`)
      }
    } else {
      assert.ok(capturedLane.length > 0, `${channel}: the lane must pin at least one anchor`)
      for (const [anchor, hash] of Object.entries(lane.hashes)) {
        assert.match(hash, HASH, `${channel}/${anchor}: the recorded hash is a sha256`)
        assert.notEqual(hash, sha256(''), `${channel}/${anchor}: a recorded hash must not be the hash of nothing`)
        // Recompute from this run's own capture: a recorded hash that only has the
        // right shape proves nothing about the bytes the plugin delivers today.
        assert.equal(capturedByAnchor.get(anchor), hash,
          `${channel}/${anchor}: the recorded hash does not match the captured bytes; `
          + 'register the new block and record its hash deliberately')
      }
    }
  }
})

/** Anchors whose delivered bytes a lane pins, registry-owned or host-owned. */
function capturedAnchors(lane) {
  if (lane === undefined) return []
  return lane.kind === 'bytes' ? Object.keys(lane.captured ?? {}) : Object.keys(lane.hashes ?? {})
}

test('the surface gate reacts to text that no owner registered', async t => {
  const captured = await capture(t, { canary: true })
  assert.notDeepEqual(captured.addedSections, SURFACE.addedSections,
    'a sentence appended to a claimed block must change its hash')
  assert.equal(captured.addedSections[0].anchor, SURFACE.addedSections[0].anchor)
})

test('the editable run_code slots reach the model on either host definition shape', async t => {
  // A host publishes the definition it dispatches through either as writable data or
  // as getter-only accessors over its own text. The plugin owns the delivered slots,
  // so both shapes must carry them while the attachment lives, and both must give the
  // host its own text back when the attachment is disposed.
  const hostText = {
    description: 'Host text for the transport.',
    parameters: { type: 'object', additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Host parameter text.' },
        description: { type: 'string', description: 'Host summary text.' },
      },
      required: ['code', 'description'] },
  }
  for (const shape of ['writable', 'accessor', 'inherited', 'refused', 'half-refused', 'frozen-after-write']) {
    await t.test(shape, async t => {
      const state = fixture({})
      t.after(() => state.dispose())
      const definition = { name: 'run_code', output: { schema: {}, render: () => [] }, async execute() {} }
      if (shape === 'inherited') {
        // The host keeps its slot texts on the shape every definition inherits, so the
        // plugin must add own properties and remove them again on disposal.
        const base = { get description() { return hostText.description },
          get parameters() { return hostText.parameters } }
        Object.setPrototypeOf(definition, base)
      } else {
        for (const key of ['description', 'parameters']) {
          if (shape === 'writable' || shape === 'refused' || shape === 'half-refused'
            || shape === 'frozen-after-write') definition[key] = hostText[key]
          else Object.defineProperty(definition, key, {
            configurable: true, enumerable: true, get: () => hostText[key],
          })
        }
      }
      if (shape === 'refused') {
        // A slot the host published unconfigurable cannot be replaced at all, so the
        // definition keeps all of its own text rather than half of the plugin's.
        Object.defineProperty(definition, 'parameters', {
          configurable: false, enumerable: true, writable: false, value: hostText.parameters,
        })
      }
      if (shape === 'half-refused') {
        // Only the parameters can be replaced; a definition that cannot carry both
        // keeps its own text instead of ending up with half of the plugin's.
        Object.defineProperty(definition, 'description', {
          configurable: false, enumerable: true, writable: false, value: hostText.description,
        })
      }
      state.ctx.tools.get = name => (name === 'run_code' ? definition : undefined)
      const id = `prompt-slots-${shape}-${Math.random().toString(36).slice(2)}`
      const agent = ptcAgent(id, orderedSurfaceSession(id))
      const assembly = { sections: [], contexts: [], variables: {}, tools: [definition] }
      await state.assemble(assembly, { agent, scope: agent })
      if (shape === 'refused' || shape === 'half-refused') {
        assert.equal(definition.description, hostText.description,
          'a slot that cannot be replaced keeps the host text rather than half of ours')
        assert.deepEqual(definition.parameters, hostText.parameters)
        return
      }
      assert.notEqual(definition.description, hostText.description,
        'the delivered description must be the plugin text for this attachment')
      assert.match(definition.description, /session-bound persistent REPL/u)
      assert.notDeepEqual(definition.parameters, hostText.parameters,
        'the delivered parameter texts must be the plugin text for this attachment')
      assert.match(JSON.stringify(definition.parameters), /PTC/u)
      // The prompt document can change while the definition stays the same object, so
      // a second assembly re-applies the slots without mistaking them for the host's.
      await state.assemble(assembly, { agent, scope: agent })
      assert.match(definition.description, /session-bound persistent REPL/u)
      if (shape === 'frozen-after-write') {
        // A host that freezes the slot after delivery keeps the text this attachment
        // already wrote; the restore cannot be forced and must not throw on disposal.
        Object.defineProperty(definition, 'description', {
          configurable: false, enumerable: true, writable: false, value: definition.description,
        })
        await state.dispose()
        assert.match(definition.description, /session-bound persistent REPL/u)
        assert.deepEqual(definition.parameters, hostText.parameters)
        return
      }
      await state.dispose()
      assert.equal(definition.description, hostText.description,
        'disposal must give the host its own description back')
      assert.deepEqual(definition.parameters, hostText.parameters,
        'disposal must give the host its own parameter texts back')
      if (shape === 'accessor') {
        const descriptor = Object.getOwnPropertyDescriptor(definition, 'description')
        assert.equal(typeof descriptor.get, 'function', 'the host accessor is restored, not replaced by data')
        assert.equal(definition.description, hostText.description)
      }
      if (shape === 'inherited') {
        assert.equal(Object.hasOwn(definition, 'description'), false,
          'a slot the host inherited is removed again, so the inherited text is what the model reads')
        assert.equal(definition.description, hostText.description)
      }
    })
  }
})
test('two attachments in one process each deliver their own prompt document', async t => {
  // The prompt document is configuration, so it belongs to the attachment that
  // applied it. A process-wide holder would make the first attachment's delivery read
  // whichever document the last one installed.
  const slot = 'runCode.description'
  const stateFor = (text) => fixture({ promptText: JSON.stringify({
    schema: PROMPT_TEXT_SCHEMA, overrides: { [slot]: text },
  }) })
  const first = stateFor('First attachment text for the transport.')
  const second = stateFor('Second attachment text for the transport.')
  t.after(async () => { await Promise.all([first.dispose(), second.dispose()]) })
  for (const [state, own, other] of [
    [first, /First attachment text/u, /Second attachment text/u],
    [second, /Second attachment text/u, /First attachment text/u],
  ]) {
    const id = `prompt-attachment-${Math.random().toString(36).slice(2)}`
    const agent = ptcAgent(id, orderedSurfaceSession(id))
    await state.assemble({ sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
      { agent, scope: agent })
    assert.match(state.runCodeDefinition.description, own)
    assert.doesNotMatch(state.runCodeDefinition.description, other,
      'an attachment must never deliver another attachment\'s document')
  }
})

test('every registered slot belongs to a registry anchor', () => {
  const claimed = new Set(Object.values(ANCHOR_ASSETS).flat())
  for (const slot of PROMPT_SLOTS) {
    assert.ok(claimed.has(slot.id), `${slot.id} is registered but no anchor claims it`)
  }
  assert.deepEqual([...claimed].sort(), PROMPT_SLOTS.map(slot => slot.id).sort(),
    'the surface map and the registry must list the same slots')
})

test('every captured anchor is mapped, and each unmapped block is a declared gap', async t => {
  const captured = await capture(t)
  const anchors = [
    ...captured.addedSections.map(entry => entry.anchor),
    ...captured.modifiedSections.map(entry => entry.anchor),
    ...captured.tools.map(entry => entry.anchor),
    ...captured.installTools.map(entry => entry.anchor),
    ...captured.appendices.map(entry => entry.anchor),
    ...captured.contexts.map(entry => entry.anchor),
  ]
  for (const anchor of anchors) {
    // A host-owned section is claimed by the captured segment inside it: the
    // whole section differs from its baseline only because of that appendix.
    const segmentClaim = captured.appendices.some(entry => entry.anchor.startsWith(`${anchor}#`))
    const mapped = Object.hasOwn(ANCHOR_ASSETS, anchor) || segmentClaim
    assert.ok(mapped && (segmentClaim || ANCHOR_ASSETS[anchor].length > 0),
      `captured anchor ${anchor} is not registered`)
  }
  // Gaps are about uncovered channels, not about registration: the channel gate
  // below owns their bookkeeping, and the captured anchors above must all be
  // registered and claimed.
})
