# Register Edit And Run As A Truthful Composite Tool

A small correction to a long `run_code` cell should not require the model to emit the complete
source again. This applies both to cells rejected by the runtime and to cells that completed but did
not achieve the intended result. PTC Plus therefore registers `edit_run_code` as a real DSH tool:

```ts
edit_run_code({
  edits: Array<{ old_string: string; new_string: string }>,
  expected_target_call_seq?: number
})

edit_run_code({
  regex_edits: Array<{
    pattern: string
    flags: string
    replacement: string
    expected_matches: number
  }>,
  expected_target_call_seq?: number
})
```

PTC mode requests using the code-only direct-tool projection expose `[run_code, edit_run_code]` in
that order. The first conclusive prompt assembly creates one per-agent composition owner before any
plugin-owned presentation effect changes the nearest DSH scope. A non-empty `tools:ptc-only`
section proves `ptc`, an empty section proves `both`, and the preceding generation's
`tools:code-only` alias proves the same composition; the current section wins when both appear, and
only a missing owner signal permits a tool-shape inference. For a code composition, the same owner
registers `edit_run_code` through `agent.ctx.tools.register()` and uses the same scope's
`tools.presentAs('both')` to admit both direct calls. It retains both exact disposers and releases
registration and presentation together with the owning session, agent, or plugin. Native-mode and unrelated agent
scopes never inherit the tool. Unrelated native tools remain in the program SDK. A top-level native call is outside that
valid direct protocol. The stream canonicalizer may deliberately replace it with the equivalent
`run_code` transport when the live schema uniquely proves the native member; otherwise the call
remains unchanged for host diagnosis. A nested native call from a cell continues through the
ordinary DSH pipeline. Each assembly derives its `native`, `code`, or `both` presentation from the
lifecycle owner rather than inferring composition mode again from the plugin-modified scope. Only
`code` collapses direct tools, normalizes top-level native calls, or
rejects native dispatch. Both PTC presentations adapt `run_code`, append the program SDK, and
project session runtime contexts, while `both` also preserves native direct calls. The initial
transport-only shape may bootstrap the first scoped registration, but the resulting
`tools.presentAs('both')` declaration is only the executor-enabling effect for the two transports
and cannot become a second mode owner. Each completed prompt assembly therefore preserves the
agent composition's direct projection without releasing the per-agent registration. The
model stream binds every complete tool call's session and call ID to that assembly policy, and
execution consumes this stable relation even when another public wrapper replaces the cancellation
signal. A settled result retires the relation. The retained registration does not authorize the
tool outside a code composition, and one shared session lifecycle revokes outstanding request and
call records on session, agent, or plugin disposal.

`edit_run_code` targets the most recent editable cell in the current turn when its persisted
`tool/call` event is recorded. Execution resolves that snapshot through the event sequence rather
than reading the latest target when the handler begins. Intervening inspection tools do not erase
the target, and later settlements or handler scheduling do not retarget the in-flight edit. A call
that could otherwise edit a cell but lacks a unique persisted event is rejected instead of using
the latest target. The derived cell enters replay history at the outer `tool/result` event, so a
delayed handler is recovered after every cell that settled before it executed. A successful edit
creates a new derived cell, which
becomes the next editable source, so successive small adjustments do not require a full resend.
Invalid edit arguments return `{ edited: false, reason }` and leave the target unchanged.
Process-local target claims distinguish executing and settled derived dispatches. A rejection,
cancellation, or result without a valid PTC journal releases the claim because no owned fact proves
that the derived cell entered the runtime. A journaled dispatch retains the claim through outer
result projection, closing the interval before the session log exposes the derived edit as the new
target. If final policy removes that private metadata, `tools/result` releases the claim. The
session-log projection captures the eligible target at the edit call event and accepts a derived
source only when its target sequence matches that snapshot and its journal is valid and non-noop,
so live and recovered eligibility derive from the same persisted relation.

The caller sends exactly one of `edits` or `regex_edits`, plus an optional non-negative
`expected_target_call_seq` precondition. The precondition must equal the call sequence of the target
captured for the persisted edit event; a mismatch returns an unedited result before derived
dispatch. Ordinary model-authored edits omit it and retain latest-target selection. Exact edits
contain at most 16 items; each
non-empty `old_string` must differ from `new_string` and occur exactly once in the target. Regular
expression edits also contain at most 16 items, use unique `gimsu` flags, reject zero-length matches,
and require an exact `expected_matches` count. All ranges resolve against the original target and
must not overlap. Search work, match count, capture records, replacement templates, expansion,
materialized replacement text, final source size, and regular-expression CPU time have fixed
budgets.

`internal/rejected-cell-editor.js` owns the schema, validation, range collection, replacement
semantics, budgets, and atomic linear assembly. The registered tool passes the materialized source
to DSH's public `tools.execute()` as a derived `run_code`. DSH remains the owner of validation,
authorization, scheduling, cancellation, execution, and result projection.

The session history preserves the model-authored call:

```text
assistant/tool-call: edit_run_code(delta)
tool/result:          { edited: true, value?, error?, logs }
```

The complete derived source, its journal, and its target call sequence are stored only in private tool-result metadata, including
when the derived cell fails after entering the runtime. Cold
recovery folds that explicitly marked derived run into the durable REPL history. The source is not
copied into the model-visible edit result, and assistant stream chunks for the two declared
transports pass through unchanged.
Consequently the UI and later model requests do not attribute a generated `run_code` call to the
model.

No edit-specific runtime context is emitted. The truthful call/result pair already carries the
operation and outcome; changing an aggregate runtime-context snapshot merely to restate that fact
would repeat unrelated policy context. Rewrite feedback and unrelated recovery tips retain their
own independently justified lifecycles.

A live `PTC-C001` at the exact source EOF may carry a validated one-call repair. The analyzer tries
only the three single-token suffixes `}`, `)`, and `]` against the same binding catalog, reserved
bindings, redeclaration mode, rewrite policy, and import state as the rejected cell. Exactly one
candidate must complete preparation without a binding collision, and the existing exact editor
must be able to express it from a bounded unique source suffix. The rejected call must also have a
persistent event sequence. The diagnostic then renders those already-validated
`edit_run_code({ edits: [...], expected_target_call_seq })` arguments on one help line. At dispatch,
the precondition binds the proof to that rejected cell even if another matching source has become
editable. This evidence takes precedence over the generic source-length recommendation, but remains
conditional on
`edit_run_code` being declared for that request. Zero or multiple candidates, non-EOF errors,
editor budget failures, missing target identity, and candidates rejected later in preparation
retain the generic guidance.
The plugin never applies this repair itself: syntax/preflight acceptance does not prove model
intent, and explicit edit dispatch preserves DSH authority and truthful history.

## Alternatives considered

**Rewrite `edit_run_code` to `run_code` before persistence.** This reuses DSH's default `run_code`-only
transport, but falsifies the model-authored history, duplicates complete source in model context,
and requires later prose to reinterpret the stored call. It is rejected.

**Return the materialized source in the edit result.** This makes the derivation visible, but sends
the same large source back into the next model request. Private derived metadata gives recovery the
required bytes without paying that context cost.

**Limit editing to pre-execution failures.** That avoids retrying an effectful failed cell, but it
also prevents the common case where execution succeeded and only the intended result needs a small
adjustment. The tool edits the recorded source and performs a new explicit execution; it does not
claim that the earlier execution was undone or idempotent.

**Forbid all stream normalization.** A valid declared call and an invalid
out-of-surface call are different protocol facts. Rewriting a real `edit_run_code` destroys a valid
identity; normalizing a live-schema-proven native miscall to the declared `run_code` transport gives
an otherwise invalid call its executable representation. Native-call canonicalization therefore
remains available while the two declared transports pass through unchanged.

## Consequences

Tool name, schema, and order remain stable regardless of target availability. `edit_run_code` is a
normal provider tool call, not a synthetic wire alias. The derived run is auditable and replayable,
but is explicitly host-generated and excluded from model-visible history. This adds no editor DSL,
authority layer, or retry guarantee; it only avoids re-emitting source already owned by the session.
Provable top-level native-call repair remains a separate, intentionally history-normalizing transport
feature.
