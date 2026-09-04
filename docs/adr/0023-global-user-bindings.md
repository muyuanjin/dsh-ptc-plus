# Keep Global User Bindings Source-Owned and User-Controlled

## Problem

Repeated project helpers are useful across sessions, but ordinary REPL bindings belong to one session and cannot be promoted losslessly from a runtime value back into TypeScript module source. A persistent helper feature must keep executable values, model-visible declarations, storage, and cold recovery aligned without turning helpers into DSH tools or granting the model a second authority path for persistent changes and candidate execution.

## Decision

Global User Bindings is an optional PTC Plus capability controlled by `userBindingsEnabled`, which defaults to `false`. Disabled mode is dark: the Host does not read storage, inject values or prompt context, register management RPC or commands, or render management UI. Enabling the capability does not change DSH authority, approval, scheduling, cancellation, sandbox, or the code-only direct-tool projection.

Each entry is a TypeScript module with named value exports, a stable ID, display/call name, `namespace` or `top-level` scope, selected symbols, purpose, and enabled state. Omitted symbol selection derives every named value export; an explicit selection limits the exposed API. One strict normalizer derives body-free declarations, binding kinds, durability, and fingerprints from source and rejects any supplied derivative that disagrees. Activated entries are ordinary writable REPL bindings; a model redeclaration follows the configured binding policy and shadows the default only for that session.

## Storage and Source Ownership

The Host owns one document at `$DSH_HOME/ptc-plus/bindings.json`. The store serializes mutations, holds a file lock, compares the last-read disk bytes, requires an expected revision, and atomically replaces the file with owner-only permissions. The complete enabled declaration budget is validated before replacement; an externally written document that exceeds the same budget is treated as damaged storage. A malformed document remains an explicit error, and stale or external changes require reload instead of blind overwrite. A new Agent draft uses create-only persistence so a concurrent entry with the same ID cannot be replaced.

Source is the only implementation authority. Both candidate execution and session activation resolve relative imports from the directory containing `bindings.json`; a session cwd therefore cannot change a persistent helper's dependency graph. The parser accepts named value exports and rejects default exports, re-exports, reserved bindings, invalid selected symbols, and conflicting enabled call names. Model-visible declarations retain useful annotations and bounded inferred shapes but omit implementation bodies and private helpers.

## Runtime, Prompt, and Recovery

Prompt assembly captures the current enabled snapshot as the desired input later passed through dispatch. The named `tools:ptc-plus-user-bindings` runtime context is narrower: it intersects that desired set with the current session worker's successfully activated snapshot and requires every call identifier in a complete entry to retain matching `user-global` provenance. A new or changed entry crosses one activation cell before the next model turn can see it. Binding contents do not modify the stable `tools:sdk` section, direct-tool schemas, or tool order. The context exposes only callable names, purposes, and source-derived declarations; ordinary requests receive neither source nor management operations.

The worker activates entries before the cell and reports entry-level failures without blocking independent code. A request-owned program namespace or error class takes precedence over a same-name user entry, which is excluded from that request's activated snapshot. Every current request namespace is also exposed to binding modules through a stable worker-global bridge, but each call resolves the AsyncLocalStorage execution lease that reached it; a continuation from a completed cell cannot borrow a later cell's capabilities. A request namespace that collides with any existing worker global fails before bridge installation because replacing a Node intrinsic cannot preserve both environments. BindingCatalog records `user-global` provenance and handles each entry atomically: if any of its call identifiers has a session-local shadow, the complete entry is omitted from activation and model projection. Namespace members and top-level exports read their live module values until assignment or a permitted redeclaration creates that shadow. Each settled cell persists the exact successfully activated snapshot in private result metadata, while journal version 5 records its fingerprint or an explicit `null` when no snapshot exists. If a failed initializer issued a program call, the cell becomes volatile because that snapshot cannot supply its replay source. Cold recovery validates the journal-to-snapshot relation and executes recorded source rather than consulting the current store; missing, malformed, or source-inconsistent evidence contracts the recoverable frontier under the existing fail-closed journal rules.

An exported function may escape into an ordinary session binding before its global entry is updated, disabled, or removed. Reachability cannot be proved inside the worker, so every successfully exposed binding module retains its relative-import parent mapping and dynamic program-namespace bridge until that worker ends. Failed modules that expose no value release their temporary mapping, and a worker that has never exposed a user binding retains the pre-feature global namespace.

Candidate execution runs in a separate bounded worker and never mutates the live session or its journal. The worker is lifecycle and state isolation, not a security sandbox: source and imports retain DSH process authority and can produce irreversible Node/OS effects before failure or cancellation.

## Agent-Assisted Authoring

An enabled PTC agent receives `/binding new <requirement>` and `/binding edit <id> <requirement>` through DSH's public command service. Eligibility follows the validated live prompt composition rather than a preset label; changing a blank session's preset revokes the previous command before the next assembly establishes the new composition. Either command starts a normal Agent turn and installs a request-specific authoring Skill plus one `submitBindingDraft` handoff tool in the exact agent scope. The first validated submission becomes one disabled memory draft and mints an opaque capability. PTC Plus places only that locator in private metadata on the accepting session's outer `run_code` result and folds it into a dedicated session projection; the source remains in owner memory. Connection RPC does not expose caller/session identity, so draft read, save, and discard require this capability instead of trusting a payload session ID. Acceptance, replacement, turn stop, agent error, capability disablement, or disposal revokes the handoff; agent disposal, session disposal, feature disablement, and owner disposal also invalidate any accepted draft capability.

The Agent can author a candidate but cannot persist, run, enable, remove, import, or inspect unrelated entries. Client actions remain separate: the session panel can inspect source, prefill authoring commands, save or discard an accepted draft, while the Settings workbench owns complete editing, validation, candidate execution, activation, import, and removal. Saving atomically claims the draft before checking the current catalog revision and leaves the entry disabled; a concurrent discard receives a busy conflict instead of reporting success for a draft that can still reach storage.

## Alternatives considered

**Register each helper as a DSH tool.** Rejected because it changes dispatch and approval semantics and duplicates DSH's capability ownership instead of extending the REPL value environment.

**Expose persistent management operations to the model.** Rejected because an ordinary model error could change every future session. A request-scoped draft handoff preserves assisted authoring while leaving durable and effectful actions under explicit user control.

**Promote a session binding into global storage.** Rejected because runtime values and bounded declaration provenance do not reconstruct complete module source, imports, comments, and types. Persisting a guessed representation would claim losslessness that the system cannot prove.

**Store source and metadata in separate files.** Rejected because source, symbol selection, purpose, and activation state would gain independent write and recovery histories. One atomically replaced document keeps identity and implementation under one owner while `.ts` import supports file-based authoring.

**Resolve helper imports from each session cwd.** Rejected because the same persistent entry could load different dependencies in candidate validation, live activation, and replay. The storage directory is stable across those paths.

## Consequences

Users can maintain typed helpers once and reuse them across sessions while models receive compact callable declarations and ordinary REPL values. Storage, prompt projection, execution, and replay share one source-derived identity, so recovery fails closed instead of substituting current external state. Session-local experimentation remains cheap and cannot silently overwrite the global default.

The cost is an opt-in management surface, a bounded declaration/context addition when entries are active, source evaluation at activation and replay, revision conflicts that require explicit reload, and a candidate runner whose external effects cannot be undone. Full management remains in Settings, so the narrower session panel deliberately does not duplicate source editing, execution, activation, import, or deletion.
