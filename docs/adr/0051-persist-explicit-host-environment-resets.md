# Persist Explicit Host Environment Resets

## Problem

DSH calls the retained provider's public `release(owner)` both for explicit program reset and during Agent scope cleanup. Releasing only the original provider leaves PTC Plus variables live. Releasing only the worker allows its journal to revive them. Treating ordinary Agent disposal as reset would instead destroy valid session recovery.

## Decision

The public execution seam routes release to its installed adapter and original provider, waits for both, and propagates their failures. The runtime bridge owns the Agent lifecycle distinction: a session Agent whose public Cordis scope fiber `uid` is `null` is being disposed and retains proven journal recovery; a live session Agent requests explicit reset. Non-session owners keep original-provider delegation. This uses public lifecycle state, never release numbers, turn signals or notification text.

`SessionRuntime.resetEnvironment` releases the session kernel, then appends a public `user/message` with `surfaceOp: "append"` and source `{ kind: "plugin:ptc-plus", form: "environment-reset", version: 1 }`. The structured source proves the boundary independently of human-readable wording. The message states the computation change; DSH separately owns reset cancellation, serialization, completion notification and failed-reset retry. Cleanup or append failure rejects release. Plugin code adds no reset scheduler or permission system.

The shared session timeline retains historical log facts but records the latest reset position. Recovery starts after that position; old bindings, named checkpoints and editor targets have no computation eligibility. New cells start empty and configured Global User Bindings initialize normally. Projection state version 16 refolds older caches, and checkpoint admission derives the reset from the same source facts. Persistence and fork keep this ordinary public message. Reset neither deletes historical records nor redispatches, reverses or proves idempotence of completed effects. It does not change JavaScript language generations, global binding configuration, or ordinary Agent recovery.

An absent or unsupported reset source version invalidates prior recovery evidence. Its recovery receipt uses the closed alternative `{ failedResetSeq, frontierCallSeq: null }`, distinct from a failed executable call's `{ failedCallSeq, frontierCallSeq }`. Recovery accepts that receipt only for the latest damaged reset preceding its carrier and the empty frontier. The carrier starts independent computation; subsequent cold recovery consumes the receipt rather than contracting the same damage again. Both sequence migration and Client evidence validation preserve the target distinction. A missing or invalid receipt continues to deny unproved recovery.

## Alternatives considered

**Only terminate the worker.** Cold replay restores its earlier state and contradicts the reset receipt.

**Reset on every provider release.** Agent teardown also releases retained environments. Treating that cleanup as explicit reset makes ordinary resume and fork lose valid computation.

**Use a custom raw session event or experimental plugin record.** The released persistence reader rejects unknown required event types; DSH reserves experimental plugin records for its own packages. A plugin-owned message uses the published external extension contract and remains model-visible.

**Recognize the Host's reset sentence.** Notification text and delayed injection are presentation, not durable computation identity. They cannot prove a reset before release returns.

## Consequences

An explicit reset survives persisted cold recovery and fork without reviving earlier state. The live provider and historical journal remain separate owners, and DSH retains control of reset coordination. A reset adds one plugin message describing its computation boundary alongside the Host's completion receipt. Downgrading to a plugin generation that predates this contract does not establish reset-aware recovery.
