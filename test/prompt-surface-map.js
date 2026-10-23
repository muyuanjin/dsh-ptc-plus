import { anchorSlotMap } from '../internal/prompt-text.js'

/**
 * Captured anchors and the slots they deliver.
 *
 * Derived from the registry through `anchorSlotMap()`, so the mapping has one
 * source of truth: registering a slot cannot leave the surface map behind, and the
 * map cannot invent an anchor the registry does not own.
 *
 * Anchors without a capture lane are listed in `KNOWN_GAPS` below and, when they are
 * also not wired, carried by the registry as `wired: false` anchors that the panel
 * shows as 通道未接通. Registration, capture and wiring are three different states:
 * this module owns the capture one, so an anchor here is never assumed delivered.
 */
export const ANCHOR_ASSETS = Object.freeze({
  ...anchorSlotMap(),
  // The plugin appends into this host section, so the host anchor itself owns no
  // registry slot; the appendix segment below it is the registered anchor.
  'tools:sdk': Object.freeze([]),
})

/**
 * Anchors the registry owns but no capture lane reaches yet.
 *
 * A gap is a statement about coverage, not about registration: the anchor exists,
 * the panel lists it, and its bytes are delivered — there is simply no lane that
 * hashes those bytes. The gate refuses to let a channel sit in this state silently,
 * because "we forgot to look" is exactly how the previous design lost whole
 * surfaces.
 */
export const KNOWN_GAPS = Object.freeze([
  Object.freeze({
    anchor: 'tools:ptc-plus-user-binding-defaults',
    channel: 'prompt',
    reason: 'the assembly fixture runs without global bindings, so the section this anchor adds is never assembled there; capturing it needs a bindings-enabled fixture',
  }),
  Object.freeze({
    anchor: 'binding-catalog',
    channel: 'runtime',
    reason: 'the catalog is appended to the session log at request time; capturing it needs a runtime-context lane, not the assembly fixture',
  }),
  Object.freeze({
    anchor: 'runtime.recovery-snapshot',
    channel: 'runtime',
    reason: 'the snapshot is a runtime context rebuilt from the journal, so it has no assembly-time bytes to hash yet',
  }),
  Object.freeze({
    anchor: 'runtime.tip',
    channel: 'runtime',
    reason: 'tips are triggered notices delivered at request time; no runtime capture lane exists yet, so their bytes are pinned by the per-branch tip tests instead',
  }),
  Object.freeze({
    anchor: 'result.rewrite-feedback',
    channel: 'result',
    reason: 'rewrite descriptions travel inside cell results, so they need a result-channel lane rather than an assembly capture',
  }),
  Object.freeze({
    anchor: 'result.diagnostics-and-budget',
    channel: 'result',
    reason: 'diagnostics and the output envelope are emitted with a failed cell; capturing them needs the result lane',
  }),
])
