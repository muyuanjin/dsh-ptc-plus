# PTC Plus Agent Contract

This file contains project-specific obligations for changes to PTC Plus. General contributor or agent methodology belongs outside the repository.

## Product Purpose

**PTC Plus exists so the model can perform stateful computation conveniently and continuously. The REPL is an implementation device that lowers implementation cost, not a semantic goal the product must obey.**

Later cells reuse and revise earlier computation. If each revision requires remembering how a name was first declared, continued work depends on declaration history that the plugin can own. Name adaptation, state continuity, and execution preparation are therefore the plugin's responsibility. Internal storage choices must not force the model to rename, wrap in blocks, query existing bindings, or spend an extra turn to continue an otherwise valid computation.

Interpret source against the selected PTC language contract, rather than the forms the current implementation happens to support. If that contract gives the cell an admissible, unambiguous meaning, missing parser, lowering, or storage support is a product defect. Unusual source has the same claim to adaptation as conventional source. When required input is missing or its meaning cannot be determined, the diagnostic must identify what is missing.

This responsibility does not erase selected `protected` restrictions, historical language semantics, DSH decisions, or real execution failures. Preserve the native syntax targets of explicit `eval` and `Function` and the results of independently created external engines as specified by the language contract. A plugin-owned entry that bypasses required adaptation remains an implementation gap; relabeling it as external does not discharge that responsibility.

## Authority And Sources

PTC Plus supplies the continuous computation environment through DSH's top-level `run_code`. DSH retains authority and native tool policy. The plugin does not add a second permission system, sandbox, scheduler, approval layer, session coordinator, name-dispatch registry, or cross-plugin Work Map.

Read [CONTEXT.md](CONTEXT.md) before changing behavior. Use repository sources by responsibility:

- `CONTEXT.md` owns project boundaries and non-negotiable invariants.
- ADRs own durable architecture, contracts, data formats, and project process decisions.
- Code, schemas, tests, and scripts provide executable evidence.
- `README.md` (Chinese default) and `README.en.md` (English) serve users; `docs/` owns detailed integration, runtime, installation, publishing, and operational material.

For binding, compilation, or replay changes, read [ADR 0025](docs/adr/0025-use-versioned-logical-binding-identities.md) for current ownership and language generations, and the [stateful computation proposal](docs/stateful-binding-updates-proposal.md) for the semantic choices and execution boundaries. [Semantic validation](docs/semantic-validation.md) distinguishes retained JavaScript behavior, PTC dialect behavior, and compiler-boundary evidence. These sources determine which behavior an implementation and its tests must preserve.

When sources disagree, identify which source owns the disputed contract or fact, then update its affected dependents. Code and test results establish current behavior; they do not make a conflicting implementation the required behavior. A proposed capability still needs executable evidence before it can be reported as implemented.

For a recurring compiler, binding, or recovery failure, trace the failing entry through its semantic owners. A bypass or stale consumer requires completing the integration or migration. If an admissible input follows the shared rules correctly and still violates the contract, the rules or representation need correction. Follow that correction through its bounded dependents so later entries obtain the intended behavior from the same owner, without accumulating their own exceptions.

## State And Recovery

The runtime, journal, and model-visible surface establish different facts. A value in a worker does not prove that the model still knows its source; a parsed declaration does not prove successful initialization. Catalog publication must follow the initialization or instantiation evidence required by the language contract. Keep UI previews and model presentation separate from canonical program values and completeness; unknown or bounded metadata does not establish complete values.

A binding retained across compaction or recovery needs reconstructable journal ancestry and exact provenance on DSH's model-visible request surface. An explicitly selected bounded state projection may provide the latter; it does not replace the former. Do not inject such a projection by default merely to retain hidden state. Use DSH's public ordered surface and formal source relations: the append-only raw log, UI-only inventory, and natural-language compaction summaries do not prove model knowledge. A result-only replacement need not remove a binding while the assistant call containing its source remains visible.

Live volatile state may remain usable within its existing model-visible environment even when cold replay is unproved. Recovery selects the recorded language and transform generations, rather than reinterpreting old source with current settings. Cold replay may return recorded values without redispatching external effects; it neither proves live retry idempotence nor undoes an effect. Matching recorded completions alone cannot justify changing historical semantics.

Damage to historical PTC Plus metadata invalidates recovery evidence, not future computation. Reject unproved cells and bindings as recovery evidence, contract to the greatest verified frontier, and discard anything that may depend on an unknown boundary. If no non-empty frontier is provable, reset to an empty REPL and execute the current valid cell. Persist and report the contraction once, without replaying or claiming to undo historical effects. Current-request validation and DSH policy, authority, approval, cancellation, and sandbox decisions remain authoritative errors.

## Product Obligations

- DSH owns authorization, native-tool scope, policy, scheduling, cancellation, approval, and sandboxing. `danger-full-access` is the primary supported experience, but the worker is not a malicious-code sandbox.
- Target the latest available official DSH release through published public extension surfaces; never patch DSH source or installed packages or require a custom host build. Plugin-owned UI and public renderer replacements are permitted within those contracts. A literal DSH version may appear only as historical source evidence and must not control current behavior, configuration, tests, installation, or compatibility claims. See [ADR 0017](docs/adr/0017-track-the-latest-dsh-public-surface.md) for delivery requirements.
- Keep plugin-owned system text and ordered tool schemas byte-stable under unchanged configuration, model route, and native capability view. Changing session facts belong in append-only runtime contexts reconstructable from the session log. See [Prompt Prefix Stability](docs/architecture.md#prompt-前缀稳定性).
- Preserve `run_code` and `edit_run_code` names and arguments through DSH's public host pipeline. A top-level native call outside the declared direct surface may be normalized only when the live schema uniquely proves the intended member and the repair preserves JSON arguments, call identity, DSH validation, and result semantics.
- Every Cordis registration uses `ctx.effect()` or `ctx.on()`; registry `register()` methods return their disposer.
- Validate deployment-varying configuration at the earliest resolvable point. Provider, model, and credential-variable choices are explicit configuration, not repository defaults derived from one maintainer's environment.
- Use maintained dependencies and platform primitives for parsers, protocols, state machines, and serializers when they cover the required semantics.
- Comments and diagnostics state contracts, ownership, failure, and recovery consequences. They do not retain review discussion, implementation diaries, or local execution records.

Add or update an ADR only when a durable architecture, contract, data-format, or project process decision changes. Update `README.md` (Chinese default) and `README.en.md` (English) together for user-facing behavior. Installation and release procedures belong in [docs/installation.md](docs/installation.md) and [docs/publishing.md](docs/publishing.md).

## Local Review Ledger

`REVIEW_FINDINGS.md` is checkout-local and must never be staged or committed. Create it only with `npm run review:new`; `.agents/templates/REVIEW_FINDINGS.md` owns its schema and `scripts/review-findings.mjs` owns its lifecycle.

Keep `requiredOutcome` as the stable acceptance condition. Before implementing a captured finding, use `implementationPlan` to explain why the failure is reachable, which owners and dependents must change, and what observation would distinguish the correction from the existing failure. Update the plan before continuing when evidence changes the diagnosis or scope. Put completed observations and their results in `resolutionEvidence`, not a restatement of intended work.

The ledger validator checks structure and required evidence fields; it cannot establish that the recorded diagnosis or evidence is sound. Each disposition must remain independently verifiable from its cited sources and executed observations. Do not turn the ledger into a chronological transcript.

A finding becomes terminal when its root cause and dependents are corrected and relevant verification passes, or when evidence establishes `invalid` or a durable tracked owner records `accepted`. An accepted limitation remains a limitation. Set `ledgerStatus: resolved` only when every finding is terminal; this status alone does not establish implementation completeness or a clean independent review. Let `npm run check` archive a terminal ledger under checkout-local Git metadata; do not manually delete it.

Install the tracked pre-commit hook explicitly with `npm run hooks:install`. Hook installation must not replace another hook owner or occur as a package-install side effect.

## Verification And Delivery

For documentation-only work, check the actual diff, local links, referenced commands, and agreement with the sources that own the affected claims. Build and runtime suites do not establish whether these instructions are accurate or usable. If a changed claim needs execution to settle it, use the focused check that can distinguish the alternatives. Documentation checks alone do not produce the verification proof required for a commit.

Use `npm ci` only when dependencies are unavailable or the lockfile changes. For executable changes or when preparing a commit, run one final deterministic command against a stable tree:

- `npm run verify` while an active ledger contains unresolved findings.
- `npm run check` when no active ledger exists or every active finding is terminal.

`npm run verify` validates the ledger, checks generated builds and syntax, runs client tests, and enforces 100% line and function coverage with at least 95% branch coverage. `npm run test:semantics` is a focused diagnostic entry, not a replacement for the final command.

`npm run check` runs that verification while checking that the source tree and active ledger remain unchanged, then writes a proof for the verified source and current HEAD. The pre-commit hook consumes that proof and checks the prospective index tree against it. These mechanisms bind verification to an object; they do not prove all semantic obligations or replace an independent review required by the task. When a clean independent review is required, obtain one no-findings conclusion for the final complete change after all fixes; earlier partial reviews do not supply that conclusion.

Delivery is decided by a persisted verdict, not by a review transcript. After every known contract defect is resolved or excluded by evidence, freeze the candidate, run `npm run check`, and obtain one independent complete review of that frozen candidate whose report ends with `VERDICT: NO FINDINGS`. Record it with `node scripts/review-findings.mjs verdict --base <commit> --evidence <report> --expect-head <head> --expect-fingerprint <fingerprint>`; `npm run check` prints that verified `head` and `fingerprint` and writes the same values to the proof under Git's local `review-findings/verified-tree`, and the record binds them with the report hash. Keep the review report outside the checkout or ignored: the verified fingerprint covers every tracked and non-ignored checkout path, so placing it in the tree changes the candidate. The pre-commit hook requires a currently effective clean verdict for the same candidate as the proof and rejects a missing, stale, wrong-HEAD, wrong-fingerprint, out-of-scope or tampered-evidence verdict. There is no ledger-absent, proof-absent or documentation-only exemption.

The independent final review covers intrinsic handling, scope and declaration ownership, callable reconstruction, module and cross-entry contracts, and historical semantics and recovery. Each area needs its semantic owner, its consumers, and a discriminating counterexample; reused evidence states the conditions under which it stays valid. A coverage gap, insufficient evidence or an interrupted review is `VERDICT: INCOMPLETE`, never `VERDICT: NO FINDINGS`. Once an effective clean verdict, its matching `npm run check` proof and `git diff --check HEAD --` agree on one frozen candidate, commit it without further edits or reviews. Only changed content, a coverage gap, new counter-evidence or an invalidated proof reopens the gate, and the specific invalidation must be recorded; do not reopen a review merely to sample another angle.

Finish with `git diff --check HEAD --`. Do not claim checks that were not run. Never commit generated `artifacts/`, coverage output, the active ledger, credentials, local paths, or local evaluation records. Commit or rewrite history only when explicitly authorized; never push without explicit authorization.

### Model-Backed Evaluation

Model-backed checks consume quota and require explicit authorization, provider, model, and credential-variable configuration. Use an isolated DSH home and workspace; leave the normal profile and credential values untouched. Follow [Evaluation: Configuration Preflight](docs/evaluation.md#configuration-preflight) for configuration isolation and redacted evidence handling.

Run the matching configuration-only entry before the paid scenario:

| Command | Configuration-only variable, set to `1` |
| --- | --- |
| `npm run test:expensive` | `DSH_PTC_ACCEPTANCE_CONFIG_ONLY` |
| `npm run test:ab` | `DSH_PTC_AB_CONFIG_ONLY` |

The variables are runner-specific. A successful preflight proves configuration readiness, not model behavior or semantic correctness. Remove the configuration-only setting only when proceeding to the authorized model run.

## Repository Conventions

- `index.js`: public plugin entry point and Cordis integration.
- `internal/`: runtime kernel, worker transport, journal, analysis, canonicalization, and value helpers.
- `test/`: focused contract and acceptance tests.
- `scripts/`: deterministic and opt-in model-backed runners.
- `docs/`: architecture, runtime, data-plane, installation, publishing, and ADR owners.
- `artifacts/`, `coverage/`, and runtime output: generated local material, not source.

Use modern ESM JavaScript, two-space indentation, descriptive `camelCase`, `PascalCase` classes, and `UPPER_SNAKE_CASE` constants. Use `PTC mode` in English and `PTC 模式` in Chinese. Reserve `strict` for an actual binding, language, or policy contract; call the model-visible projection the `code-only direct-tool projection`.
