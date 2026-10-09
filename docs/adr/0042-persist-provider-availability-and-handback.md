# 0042 Persist Provider Availability And Handback

## Status

Accepted.

## Context

Historical capability plans, global API catalogs and computation journals can remain visible after PTC Plus releases its provider. Correct teardown of workers and registrations alone does not tell a later native request that these declarations are historical. A plugin that has already been destroyed cannot notify that request.

## Decision

Provider availability is a source-owned append-only fact, distinct from computation values, configuration receipts and capability-management enablement. A `plugin:ptc-plus` message with `form: runtime-availability` and `state: active | disabled | unloaded` has an exact validated body. Withdrawal makes earlier plugin continuous-computation instructions, capability plans, discovery and calling disclosures, and configured binding references inapplicable to the current runtime. It preserves tasks, Skill bodies, other producers, tool results and historical effects; it does not restore or undo a heap.

The passive runtime-message owner publishes disablement or resumed availability only through a witnessed, accepted, non-aborted Host step. Rejected, paused or cancelled proposals do not become delivery. Existing plugin declarations or a plugin journal namespace establish prior provider participation; journal presence does not prove any binding recoverable, initialized, live or known to the model. Repetition does not append a duplicate withdrawal. Re-enablement cannot restore a capability plan preceding the last validated withdrawal.

Complete plugin release first awaits the existing runtime controller's worker and registration cleanup, then persists unloaded availability while public session services remain available. Loaded sessions use their real Session append and Host flush. Unloaded stored sessions use the public persistence list and exclusive write handle, validate their surface with public pure interpreters, and append their own new withdrawal fact with append/flush/close. No Agent is created, model awakened, effect replayed, event sequence fabricated or second session coordinator introduced.

The lifecycle owner captures the public session, query and persistence services while they exist, rather than looking them up after removal. Loaded history uses a public immutable query cut. Offline handback is a new fact written by the releasing provider, not a Session resume: the exclusive public write handle supplies validated stored events and their next offset; `foldSurface` and `deriveEventMessage` apply installed first-party and live registered pure interpreters; `snapshotSessionEvent` validates the producer's own new `user/message` envelope; the extended surface is validated before `handle.append`, `flush` and `close`. It does not instantiate or publish an offline Session, invent a foreign resume marker, impersonate a user or command, or use deprecated synchronous readers. A loaded session whose query dependencies are already destroyed still reports that failure; retaining a service object does not recreate its dependencies.

Each session is independent. A writer conflict, damaged storage, flush refusal or unavailable public persistence ownership remains a real handback failure; cleanup continues for other sessions and aggregates these failures. The plugin never steals another process's writer. Successful in-memory append alone is not crash-durable evidence. Parent-service shutdown or external ownership can prevent persistence, so complete handback cannot be claimed in those cases. The failure must remain observable to the Host lifecycle owner; no promise is made that a destroyed dependency can still write.

User binding toggles publish a separate configuration receipt only after storage confirms the revision and entry. A public Conversation definition renders the source-validated receipt as its own visible node using current Client locale. The receipt proves saved enablement only; model catalog delivery still follows accepted-step publication and worker initialization still follows actual execution. It has no turn-trigger identity and does not wake a task. Capability command receipts similarly distinguish updated, pending first acceptance, unavailable, invalid usage, and globally saved but not applied states.

## Alternatives considered

**Erase historical messages or bindings on unload.** It destroys audit facts and implies rollback of effects. A new availability fact changes present applicability while retaining history.

**Notify from the next Agent after destruction.** The producer no longer exists; limiting handback to active Agents also misses loaded and offline sessions. Public Session and persistence owners can persist the transition before release without a task wakeup.

**Steal offline ownership or edit JSONL files.** It bypasses the Host's single-writer and validation contracts. Refusal is preserved and reported, not converted to successful handback.

**Use user/command/turn-trigger events for a binding toggle.** It confuses saved configuration with task initiation and may wake a model. A separately sourced fact and public renderer preserve both lifecycle and visibility.

## Consequences

Availability is reconstructable in native sessions after plugin removal without a plugin-specific projection interpreter. A declaration withdrawal cannot preserve the old continuous heap, prove source knowledge, provide missing Host tools or solve the independent top-level editor admission boundary. Persistence failures are explicit partial lifecycle outcomes.

## Evidence

`test/runtime-messages.test.js`, `test/capability-environment.test.js`, `test/user-bindings-owner.test.js` and `test/client-runtime.spec.js` exercise accepted publication, restoration, storage confirmation and locale rendering. Actual public JSONL persistence and full Loader removal require current packed-Host integration evidence; fixtures do not stand in for that boundary.
