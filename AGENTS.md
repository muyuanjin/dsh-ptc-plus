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

`semantic-obligations.json` is the tracked owner graph for plugin-owned semantic boundaries. A new JavaScript implementation file, generation, entry, lifecycle path, observable, oracle, or dependency must update that graph and its executable evidence; `npm run semantic:check` must retain `unknown: 0`. The graph bounds the claim and routes review. It does not replace focused counterexamples, coverage, or independent review.

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
- `internal/worker-realm-surfaces.js` owns the classified write boundary for worker globals, process surfaces, and native prototypes. Route stable divergences, temporary compiler names, per-cell program bindings, user declarations, and restoration writes through that boundary; the structured source check must reject supported direct write forms. Record every stable divergence in its contract and in `docs/runtime-reference.md`, and keep the keyless conformance comparison with a plain Node worker. Temporary and per-cell mutations retain their semantic lifecycle owners even though they share the write boundary.
- Validate deployment-varying configuration at the earliest resolvable point. Provider, model, and credential-variable choices are explicit configuration, not repository defaults derived from one maintainer's environment.
- Use maintained dependencies and platform primitives for parsers, protocols, state machines, and serializers when they cover the required semantics.
- Comments and diagnostics state contracts, ownership, failure, and recovery consequences. They do not retain review discussion, implementation diaries, or local execution records.

Add or update an ADR only when a durable architecture, contract, data-format, or project process decision changes. Update `README.md` (Chinese default) and `README.en.md` (English) together for user-facing behavior. Installation and release procedures belong in [docs/installation.md](docs/installation.md) and [docs/publishing.md](docs/publishing.md). GitHub Release notes follow [docs/release-notes.md](docs/release-notes.md), which owns their user-perspective priority order, required sections, bilingual style, and worked example: rank every change by what users can actually observe (current-official-DSH usability first, then behavior changes, then fixes, then upgrade requirements) before writing; state product facts only, without authoring-time stamps, verification narration, or internal delivery process; and do not re-derive that judgement from past releases or from commit order.

## Local Review State

`REVIEW_FINDINGS.md` is checkout-local and must never be staged or committed. Create it only with `npm run review:new`; `.agents/templates/REVIEW_FINDINGS.md` owns its schema and `scripts/review-findings.mjs` owns its lifecycle.

`REVIEW_PLAN.json` is also checkout-local and must never be staged or committed. It is the sole active review-plan source: create it with `npm run review:plan:new`, replace every placeholder, and record it before independent review with `npm run review:plan -- --base <commit>`. Every later use or recording of a clean conclusion, finalization, and commit decision requires its normalized content to match the recorded plan. A missing, malformed, or semantically changed file blocks those decisions until `npm run review:plan` records the revision; formatting-only JSON changes do not. A findings or incomplete report instead retires its lane and declared dependent closure from the recorded plan before current-plan or source drift can preserve or revive the contradicted clean evidence. Define lanes by semantic responsibility, not file count: each lane names its scope, path inputs, upstream lane dependencies, obligations, owners, consumers, and a discriminating counterexample. Every path changed from the base must belong to at least one lane. Exclude a standard obligation only with a concrete non-applicability reason.

Plan recording, lane recording or retirement, finalization, clearing, and pre-commit authorization share one repository-local review-state lock. Do not bypass it with parallel script variants. The lock is never reclaimed automatically. If acquisition times out after a crashed command, first confirm that no review-state command is active, resolve the exact lock path with `git rev-parse --git-path review-findings/state.lock`, remove only that directory, and retry. A negative report waits for an older in-flight clean recorder, advances that lane's persistent invalidation `{epoch, revision}` even if the lane is temporarily absent from the plan, and then retires its current closure; at the largest safe revision, advancement rotates to a new random epoch with revision zero. Reports captured before advancement remain stale after `review:clear`, lane removal, or re-addition, while a clean review started afterward may authorize the repaired fingerprint. A missing or malformed generation file blocks authorization; explicit clear removes damaged generation state but preserves valid state, and plan reconstruction creates a new random epoch when needed so reports from the damaged lifecycle cannot match. Finalization and pre-commit revalidate the active plan, candidate, proof, effective lanes, and retained evidence before persisting or returning authorization.

Every active lane must have an explicit valid generation tuple. A negative report for a temporarily absent lane is accepted only when that lane ID already has a retained tuple; an unknown or mistyped ID is an input error and cannot create review state. An accepted finding's local `dispositionRef` must name one exact tracked file that is present in the source candidate being verified, not merely an index entry, missing file, directory, or pathspec match.

Keep `requiredOutcome` as the stable acceptance condition. Before implementing a captured finding, use `implementationPlan` to explain why the failure is reachable, which owners and dependents must change, and what observation would distinguish the correction from the existing failure. Update the plan before continuing when evidence changes the diagnosis or scope. Put completed observations and their results in `resolutionEvidence`, not a restatement of intended work.

The ledger validator checks structure and required evidence fields; it cannot establish that the recorded diagnosis or evidence is sound. Each disposition must remain independently verifiable from its cited sources and executed observations. Do not turn the ledger into a chronological transcript.

A finding becomes terminal when its root cause and dependents are corrected and relevant verification passes, or when evidence establishes `invalid` or a durable tracked owner records `accepted`. An accepted limitation remains a limitation. Set `ledgerStatus: resolved` only when every finding is terminal; this status alone does not establish implementation completeness or a clean independent review. Let `npm run check` archive a terminal ledger under checkout-local Git metadata; do not manually delete it.

Install the tracked pre-commit hook explicitly with `npm run hooks:install`. Hook installation must not replace another hook owner or occur as a package-install side effect.

## Verification And Delivery

For documentation-only work, check the actual diff, local links, referenced commands, and agreement with the sources that own the affected claims. Build and runtime suites do not establish whether these instructions are accurate or usable. If a changed claim needs execution to settle it, use the focused check that can distinguish the alternatives. Documentation checks alone do not produce the verification proof required for a commit.

Use `npm ci` only when dependencies are unavailable or the lockfile changes. For executable changes or when preparing a commit, run one final deterministic command against a stable tree:

- `npm run verify` while an active ledger contains unresolved findings.
- `npm run check` when no active ledger exists or every active finding is terminal.

Run the applicable final command once: `npm run check` already runs `npm run verify`, so do not run `verify` immediately before `check` on the same tree. Do not attach a concurrency, retry, or environment override inherited from a handoff; use the command above literally unless current owner documentation or reproduced evidence requires the override.

`npm run verify` validates the ledger, checks generated builds and syntax, runs client tests, and enforces 100% line and function coverage with at least 95% branch coverage. `npm run test:semantics` and `npm run coverage:focus` are focused diagnostic entries, not replacements for the final command. Before the first full gate, make the smallest relevant tests and focused coverage pass. After a full gate failure, reproduce and correct that failure with the narrowest distinguishing check before rerunning the full gate.

[Focused Verification](docs/verification-optimization-work.md) records the bounded coverage diagnostic contract. Keep transient run state, review findings, and delivery progress out of that design reference.

`npm run check` runs that verification while checking that the source tree and active ledger remain unchanged, then writes a proof for the verified source and current HEAD. The pre-commit hook consumes that proof and checks the prospective index tree against it. These mechanisms bind verification to an object; they do not prove the semantic obligations assigned to independent review lanes.

After focused checks pass, freeze the review plan and run independent lanes in parallel. `npm run review:status` prints each lane's `head` and content fingerprint; give a reviewer only its declared semantic boundary and normal project context. The candidate a lane reviews is the working tree it is given, not the checked-in revision: a reviewer sandbox that cannot run repository git must read those working-tree files directly, and historical copies under `.git/` or generated `artifacts/` are never candidate sources. A lane declares only paths the gate's source inventory covers; content that inventory hides, such as a checkout-local `.git/info/exclude` entry, is not candidate input and must not appear in a lane's paths or evidence. A clean report ends with `VERDICT: NO FINDINGS` and is recorded with `npm run review:lane -- --lane <id> --evidence <report> --expect-head <head> --expect-fingerprint <lane-fingerprint>`. Keep reports outside the checkout or ignored. Findings enter the local ledger; after a fix, rerun the failed lane plus every lane whose path input or declared upstream fingerprint changed. Unaffected clean lanes remain effective.

Do not silently expand or reassign a lane during review. If evidence exposes a missing owner, consumer, dependency, counterexample, obligation, or changed path, revise `REVIEW_PLAN.json` and run `npm run review:plan`; the command reuses the recorded base. Unchanged lane definitions and inputs retain their verdicts, while the changed lane and its dependency closure become incomplete. A coverage gap, insufficient evidence, or interrupted review is `VERDICT: INCOMPLETE`, never clean evidence.

When every lane is effective, run `npm run check` once against the stable tree, then `npm run review:finalize` to bind the composite verdict to that proof. The pre-commit hook requires the matching proof, plan hash, effective lane fingerprints, evidence hashes, source tree, and prospective index; there is no ledger-absent, plan-absent, proof-absent, review-absent, or documentation-only exemption. Once these and `git diff --check HEAD --` agree, commit without another complete-tree review. Only an invalidated lane, changed plan boundary, changed content, new counter-evidence, or invalidated proof reopens the corresponding gate.

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
