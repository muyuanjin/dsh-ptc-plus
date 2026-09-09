# Add Fatigue-Aware Recovery Tips

## Problem

The persistent REPL contract must stay short enough for every request, while some failures need a model-visible recovery affordance. Repeated binding failures and platform-specific command errors benefit from a precise next action. A real `edit_run_code` call already carries its identity, arguments, and result; restating those facts wastes tokens. The former aggregate runtime-context path also repeated unrelated owner contributions whenever any PTC contribution changed. Long-cell failure guidance belongs in the current diagnostic, where pre-execution rejection and possibly effectful failure can be distinguished.

## Decision

PTC-owned dynamic information uses independently sourced, accepted DSH messages.
Unproved rewrite completion and Cordis recovery form a bounded `ptc-plus`
`snapshot` with named sections. Configured Global User Binding documentation uses
DSH's existing `catalog` form, independently of transient recovery state. A recovery tip is a `ptc-plus` `notice` whose
structured summary is its trigger/ordinal name. A snapshot supersedes only prior
PTC state snapshots, including PTC sections in historical DSH aggregate snapshots;
it never supersedes a binding catalog, authoring task, Skill instructions, a tool result, or
another producer. An empty snapshot explicitly invalidates earlier PTC state.

The binding catalog contains one bounded literal configuration document with a
fixed owner prefix; its reader recognizes that prefix only within a `ptc-plus`
`catalog` source. Only a later binding catalog replaces it; an explicit empty
catalog withdraws it. Host runtime-context clearances and PTC recovery snapshots
do not withdraw catalogs. Suppression prevents new delivery without changing the
meaning of a retained catalog. This is API documentation, not proof of successful
initialization, current values, or recoverable session-local state. The historical
snapshot reader remains intact: an accepted recovery snapshot retires old binding
sections once, while a catalog supplies the current configuration. No history or
journal is rewritten. Catalog and recovery changes never resend each other's text.

Model-visible wrappers state only the replacement scope. Binding entries supply
their call guidance, optional user prompt and selected declaration; checkpoint
instructions belong to `repl.state` discovery, and authoring instructions belong
to the `/binding` task. Readers accept the exact bounded historical wrappers as
well as the emitted form. A wording change does not reinterpret old records or
require journal migration. Catalog bodies are compared literally, so revised
documentation can cause one replacement on upgrade and is then deduplicated.

The public `systemPrompt.context` registry contains one empty PTC delivery witness.
DSH omits this contribution when `includeRuntimeContext` is false or a scoped
runtime-context suppressor applies; the empty text never enters its rendered
aggregate. The assembly listener captures that witness and the exact request's
PTC facts, leaving unrelated aggregate content unchanged. `agent/pre-step`
delegates its waterfall first and adds messages only to an accepted, non-cancelled
step matching that assembly. It neither calls `inject` after inbox claim nor wakes
the agent with `steer`, and it cannot override admission or runtime suppression.

Delivery is reconstructed from committed messages, never from a proposed step.
The public ordered Session surface identifies retained current-state snapshots;
historical aggregate state includes DSH's exact owner-sourced clearance marker.
An accepted step's pending aggregate replacement can withdraw an old PTC section,
requiring an independent current declaration in that same step.
Raw committed history identifies delivered tip ordinals and cooldown distance,
but cannot make hidden bindings model-visible. Compaction or removal of a state
snapshot requires a fresh eligible state or an explicit clear. Suppressed steps
send nothing; the next permitted step reconciles claims. Disabled PTC mode retains
only the settings surface and a passive presentation cleanup listener, which can
clear previously delivered claims without mounting runtime tools, reading binding
storage, or publishing new declarations. Plugin/agent disposal releases pending
assembly ownership. Resume reconstructs from the same durable source records.

PTC Plus keeps the stable REPL guidance limited to invariants, discovery entry points, and environment-neutral boundaries. `internal/session-log-view.js` projects immutable facts for edit targeting, successful-run reset, context distance, normalized Cordis call/inspection counts, canonical historical DSH snapshots, and formed PTC messages. `internal/runtime-contexts.js` renders rewrite feedback only when the rewritten cell lacks a valid journal, Cordis recovery while historical transcript lacks a newer successful live Inspect, and at most one recovery tip. Known failures already carry partial-execution and retry guidance in their result, so they do not generate duplicate rewrite feedback. `internal/runtime-messages.js` owns bounded message forms: snapshot sections total at most 65536 UTF-16 code units and recognize the two historical binding sections for retirement; a catalog body is at most 65536 code units, with the tighter configured-declaration budget still enforced by the binding owner; a notice is at most 8192 code units with a valid trigger/ordinal identity. Malformed records are not delivery evidence. Transparent rewrites remain result metadata. Edit provenance and target lifecycle remain in real call/results and private derived-execution metadata. These messages never change the tool list, tool schemas, or system sections.

The default triggers are a repeated binding failure and a failure whose diagnostic or structured cause identifies an executable, shell, or path problem. The first tip is concise. A matching trigger may produce another tip only after `tipCooldownMessages` model-context steps; unresolved matching tips reach the detailed form after `tipEscalationFailures` occurrences. A successful cell resets the unresolved escalation count. Every emitted tip name carries its stable trigger identity and next per-trigger ordinal. Reconstruction merges valid PTC notices and canonical historical sections from DSH's system-prompt owner, counting each delivered identity once across both sources. Unformed tasks and malformed plugin prose are not tip evidence. Visible wording does not determine cooldown or escalation identity; an exhausted safe-integer ordinal yields no further tip.

Platform wording names execution-world differences without assuming Windows, WSL, POSIX, a shell, or package-runner availability. Bounded multiline message/stderr facts may supply a missing cause, but generic exit failure alone does not prove an environment problem. Repeated lexical failures point to visible source, scope and initialization; discovery is reserved for worker-owned capability failures. Warning state describes the failed cell conservatively, not the act of emitting a warning. `edit_run_code` remains independently available as a fixed real tool and does not depend on a recovery-tip trigger; a validated result repair only proves syntax/preflight acceptance and retains the target guard and complete-cell execution contract.

The Cordis recovery context is not a failure tip and is not controlled by fatigue settings. It narrows the meaning of recorded values after a lifecycle boundary: they remain historical program data but cannot prove current process-local state. It clears only after a newly settled successful `cordis_inspect*` transcript, does not infer whether the original process survived, and never redispatches a historical effect.

## Alternatives considered

- **Keep all recovery instructions in the stable system prompt.** This makes every request pay for rare failures and makes platform-specific text look universally applicable.
- **Keep configured APIs inside recovery snapshots.** A short-lived recovery fact would resend unchanged interfaces on both entry and withdrawal. Catalogs already express the required public Host semantics; a new delta protocol or producer registry is unnecessary.
- **Emit a tip after every matching failure.** This repeats stale advice, consumes context, and can encourage blind retry loops.
- **Store mutable tip counters only in the kernel.** A worker restart or replay would then change model-visible behavior without a session-log source.
- **Infer tip identity from rendered prose or one fixed section name.** Wording changes would reset history, unrelated plugin text could create false matches, and an unchanged aggregate context would not persist repeated occurrences.
- **Change the available tools when a tip is needed.** This would break the fixed code-only direct-tool prefix and make failure state observable through schema churn.
- **Let each runtime-context renderer scan the event log.** Independent scans duplicate parsing and can disagree about call/result pairing, turn boundaries, repair consumption, or successful-run resets. A shared projection keeps event interpretation separate from presentation policy.
- **Mark all Cordis calls volatile.** This would discard reconstructable REPL bindings and special values merely because their external referents need revalidation. Recorded-value replay and live-state proof are separate contracts.

## Consequences

Normal requests receive only the persistent REPL invariants in stable system text. Renderers consume projected facts; accepted-step delivery rechecks committed history and the public surface before proposing bounded messages. A PTC transition appends no unrelated owner text, and another owner's aggregate transition does not resend unchanged PTC state. A new tip ordinal records a separate notice even when compact wording repeats, while repeated historical copies do not advance fatigue state. Tip thresholds are configurable; disabling tips stops future notices without removing `edit_run_code` or any native capability. Historical records require no migration.
