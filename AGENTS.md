# PTC Plus Agent Contract

This file contains project-specific obligations for changes to PTC Plus. General contributor or agent methodology belongs outside the repository.

## Product Purpose

**PTC Plus exists so the model can perform stateful computation conveniently and continuously. The REPL is an implementation device that lowers implementation cost, not a semantic goal the product must obey.**

Later cells reuse and revise earlier computation. If each revision requires remembering how a name was first declared, continued work depends on declaration history that the plugin can own. Name adaptation, state continuity, and execution preparation are therefore the plugin's responsibility. Internal storage choices must not force the model to rename, wrap in blocks, query existing bindings, or spend an extra turn to continue an otherwise valid computation.

Interpret source against the selected PTC language contract, rather than the forms the current implementation happens to support. If that contract gives the cell an admissible, unambiguous meaning, missing parser, lowering, or storage support is a product defect. Unusual source has the same claim to adaptation as conventional source. When required input is missing or its meaning cannot be determined, the diagnostic must identify what is missing.

This responsibility does not erase selected `protected` restrictions, historical language semantics, DSH decisions, or real execution failures. Preserve the native syntax targets of explicit `eval` and `Function` and the results of independently created external engines as specified by the language contract. A plugin-owned entry that omits required adaptation remains an implementation gap; relabeling it as external does not discharge that responsibility.

## Conceptual Design

**A concept is the distinction that decides.** Every concept in this project must be stateable as four things: the question it answers, the boundary of what belongs to it, the consequences that follow from belonging, and the neighbour it must never be confused with. A word without those four is a naming habit, not a concept.

**Concepts precede their encodings.** The concept owns the meaning; a term is only its label; a type, table, field, or enum is one encoding of it. An encoding that already exists — a shared table, a reused field, an existing enum — must not decide the concept. That is how concept drift starts: the shape is reused because it is there, and the meaning is dragged along behind it.

**Conceptual design fixes the distinctions of a domain before any mechanism exists.** It asks, in order: which decisions must this area make? which of those change independently? what has to be distinguishable for those decisions to come out right? Each answer is a candidate concept. Two candidates that never lead to different decisions are one concept; one candidate whose decisions change independently is two. Only after that are ownership, representation, and reuse decided at all.

**Accept a concept only when it survives four questions.**
1. *Removal*: which decision becomes impossible if this concept is deleted? If none, it is a phrasing, not a concept.
2. *Distinction*: in which concrete case do this concept and its neighbour give different results? If none, they are one concept wearing two names.
3. *Closure*: can every decision of this kind be derived from it? If a rule or exception has to be added beside it, either the concept is incomplete or the layering is wrong.
4. *Counterexample*: what does a legal counterexample look like? If none can be stated, the concept may be a tautology that cannot fail and therefore cannot guide anything.

Design starts from what a thing **is**, not from what it can reuse. Before writing code, a change must answer in one sentence: which layer it belongs to, what question it answers, and who owns it. When that sentence cannot be written, the problem is not in the implementation.

**Separate concepts before considering reuse.** A mechanism is reusable only when two objects answer the same question, are owned by the same maintainer of that relationship, and share a lifecycle. A shared table, a shared component, or a shared word is not evidence of a shared concept. Borrowing an existing term requires checking its meaning: `automatic` means "the host derives this", not "inherit the default value"; calling the latter by the former makes every later reader pay for the difference.

**Four layers may not answer for each other**: supply (what the product declares exists), adoption (what a session chooses to use), materialization (what the runtime actually installed), and proof (what can be verified). A global switch cannot stand in for a session choice, a session choice cannot stand in for an install result, and "saved" cannot stand in for "usable". Report the layer that actually holds.

**Illegal states should be unrepresentable.** A design that needs an extra rule to forbid a state — "an override must not revive a deleted entry" — has placed its layers wrongly. That state should not exist in the concept at all. When such a patch appears, re-derive the layering instead of writing the patch into the specification. Rules that keep accumulating exceptions are evidence about the concept, not about the cases.

**Concepts land as vocabulary, then as types.** A new concept enters the data shape, the diagnostic wording, and the documentation together; when they disagree, the concept decides, and the shape and wording change to match.

**A design states what it does not change.** Without a non-goal, scope creep is undetectable. Before reusing something, ask what the two objects would look like if they were built separately; if the answer is "different questions", stop reusing.

## Authority And Sources

PTC Plus supplies the continuous computation environment through DSH's top-level `run_code`. DSH retains authority and native tool policy. The plugin does not add a second permission system, sandbox, scheduler, approval layer, session coordinator, name-dispatch registry, or cross-plugin Work Map.

Read [CONTEXT.md](CONTEXT.md) before changing behavior. Use repository sources by responsibility:

- `CONTEXT.md` owns project boundaries and non-negotiable invariants.
- ADRs own durable architecture, contracts, data formats, and project process decisions.
- Code, schemas, tests, and scripts provide executable evidence.
- `README.md` (Chinese default) and `README.en.md` (English) serve users; `docs/` owns detailed integration, runtime, installation, publishing, and operational material.

For binding, compilation, or replay changes, read [ADR 0025](docs/adr/0025-use-versioned-logical-binding-identities.md) for current ownership and language generations, and the [stateful computation proposal](docs/stateful-binding-updates-proposal.md) for the semantic choices and execution boundaries. [Semantic validation](docs/semantic-validation.md) distinguishes retained JavaScript behavior, PTC dialect behavior, and compiler-boundary evidence. These sources determine which behavior an implementation and its tests must preserve.

When sources disagree, identify which source owns the disputed contract or fact, then update its affected dependents. Code and test results establish current behavior; they do not make a conflicting implementation the required behavior. A proposed capability still needs executable evidence before it can be reported as implemented.

For a recurring compiler, binding, or recovery failure, trace the failing entry through its semantic owners. An entry missing the shared preparation step or a stale consumer requires completing the integration or migration. If an admissible input follows the shared rules correctly and still violates the contract, the rules or representation need correction. Follow that correction through its bounded dependents so later entries obtain the intended behavior from the same owner, without accumulating their own exceptions.

`semantic-obligations.json` is the tracked owner graph for plugin-owned semantic boundaries. A new JavaScript implementation file, generation, entry, lifecycle path, observable, oracle, or dependency must update that graph and its executable evidence; `npm run semantic:check` must retain `unknown: 0`. The graph bounds the claim and routes review. It does not replace focused counterexamples, coverage, or independent review.

## State And Recovery

The runtime, journal, and model-visible surface establish different facts. A value in a worker does not prove that the model still knows its source; a parsed declaration does not prove successful initialization. Catalog publication must follow the initialization or instantiation evidence required by the language contract. Keep UI previews and model presentation separate from canonical program values and completeness; unknown or bounded metadata does not establish complete values.

A binding retained across compaction or recovery needs reconstructable journal ancestry and exact provenance on DSH's model-visible request surface. An explicitly selected bounded state projection may provide the latter; it does not replace the former. Do not add such a projection by default merely to retain hidden state. Use DSH's public ordered surface and formal source relations: the append-only raw log, UI-only inventory, and natural-language compaction summaries do not prove model knowledge. A result-only replacement need not remove a binding while the assistant call containing its source remains visible.

Live volatile state may remain usable within its existing model-visible environment even when cold replay is unproved. Recovery selects the recorded language and transform generations, rather than reinterpreting old source with current settings. Cold replay may return recorded values without redispatching external effects; it neither proves live retry idempotence nor undoes an effect. Matching recorded completions alone cannot justify changing historical semantics.

Damage to historical PTC Plus metadata invalidates recovery evidence, not future computation. Reject unproved cells and bindings as recovery evidence, contract to the greatest verified frontier, and discard anything that may depend on an unknown boundary. If no non-empty frontier is provable, reset to an empty REPL and execute the current valid cell. Persist and report the contraction once, without replaying or claiming to undo historical effects. Current-request validation and DSH policy, authority, approval, cancellation, and sandbox decisions remain authoritative errors.

## Product Obligations

- DSH owns authorization, native-tool scope, policy, scheduling, cancellation, approval, and sandboxing. `danger-full-access` is the primary supported experience. The worker provides computation state isolation, not a security boundary; Node access remains subject to the host environment.
- Target the latest available official DSH release through published public extension surfaces; never patch DSH source or installed packages or require a custom host build. Plugin-owned UI and public renderer replacements are permitted within those contracts. A literal DSH version may appear only as historical source evidence and must not control current behavior, configuration, tests, installation, or compatibility claims. See [ADR 0017](docs/adr/0017-track-the-latest-dsh-public-surface.md) for delivery requirements.
- Keep plugin-owned system text and ordered tool schemas byte-stable under unchanged configuration, model route, and native capability view. Changing session facts belong in append-only runtime contexts reconstructable from the session log. See [Prompt Prefix Stability](docs/architecture.md#prompt-前缀稳定性).
- Preserve `run_code` and `edit_run_code` names and arguments through DSH's public host pipeline. A top-level native call outside the declared direct surface may be normalized only when the live schema uniquely proves the intended member and the repair preserves JSON arguments, call identity, DSH validation, and result semantics.
- Every Cordis registration uses `ctx.effect()` or `ctx.on()`; registry `register()` methods return their disposer.
- `internal/worker-realm-surfaces.js` owns the classified write boundary for worker globals, process surfaces, and native prototypes. Route stable divergences, temporary compiler names, per-cell program bindings, user declarations, and restoration writes through that boundary; the structured source check must reject supported direct write forms. Record every stable divergence in its contract and in `docs/runtime-reference.md`, and keep the keyless conformance comparison with a plain Node worker. Temporary and per-cell mutations retain their semantic lifecycle owners even though they share the write boundary.
- Validate deployment-varying configuration at the earliest resolvable point. Provider, model, and credential-variable choices are explicit configuration, not repository defaults derived from one maintainer's environment.
- Use maintained dependencies and platform primitives for parsers, protocols, state machines, and serializers when they cover the required semantics.
- Comments and diagnostics state contracts, ownership, failure, and recovery consequences. They do not retain review discussion, implementation diaries, or local execution records.

Add or update an ADR only when a durable architecture, contract, data-format, or project process decision changes. Update `README.md` (Chinese default) and `README.en.md` (English) together for user-facing behavior. Installation and release procedures belong in [docs/installation.md](docs/installation.md) and [docs/publishing.md](docs/publishing.md). Before writing GitHub Release notes, read [docs/release-notes.md](docs/release-notes.md) for the required user-perspective priority order, sections, bilingual style, and worked example. State product facts; that owner, rather than past releases or commit order, determines their presentation.

## Task Context

Describe PTC Plus work by its concrete responsibility: TypeScript compilation, JavaScript language conformance, continuous bindings, journal recovery, or public DSH integration. For example, a test that changes `Map.prototype.get` checks whether later compilation and user-visible JavaScript retain their respective semantics. Use the affected object, operation, and observable result in explanations and new test descriptions. Preserve exact API names, configuration values, diagnostics, source examples, and genuine security findings when they are relevant.

Load project references by the current task. Read `CONTEXT.md` before behavior changes and the language sources above before binding, compilation, or replay changes; start with the relevant sections and follow their dependencies until the affected contract is understood. Read the verification procedures below before their corresponding actions. This routing changes when details enter the conversation, not their authority or applicability.

Search the named owner and its consumers first; expand when an unresolved dependency requires it. Request file names or match locations before reading large source files, generated bundles, test logs, historical evaluations, or handoffs in full. Reuse unchanged evidence already read in this conversation. Progress updates and handoffs retain the failing case, affected contract, changed paths, verification result, and unresolved question with source references; repeated background material need not be copied. Preserve the exact failure evidence needed to reproduce a result.

## Verification And Review

Use `npm ci` only when dependencies are unavailable or the lockfile changes. During implementation and independent review, select tests by the changed semantic owner and its consumers. A development turn ends after relevant focused checks and independent review; executable edits alone do not trigger a complete gate. Do not use `test:backend`, `test:semantics`, `test:client:visual`, `verify`, or `check` for failure discovery.

| Responsibility | Diagnostic command |
| --- | --- |
| Backend | `npm run test:backend:focus -- --file test/<owner>.test.js --test-name-pattern="<case>"` |
| Client behavior | `npm run test:client:focus -- "<test-name pattern>"` |
| Browser layout | `npm run test:client:layout:focus -- --case <id>` |
| Native/fallback browser behavior | `npm run test:client:fallback:focus -- --case <id>` |

Backend and browser entries accept `--list`; list the inventory when the exact selection is unknown. Repeat `--file` or `--case` for dependent responsibilities. Narrow a slow file by case before expanding it. Supplied browser fixtures must come from the current candidate.

For documentation-only work, use `npm run verify:docs` and review claims against their owners. For test wording, inspect selectors, fixtures and assertions, then run only cases needed to settle a possible behavior change. Read [Change classification](docs/verification.md#change-classification) before choosing delivery checks; `check` records a scoped source proof and still requires independent review.

Read the corresponding procedure before its first action; its obligations remain required:

| Action | Required procedure |
| --- | --- |
| Findings, independent review or any review-state command | [Findings and independent review](docs/review-procedure.md); create local state through its commands, record the plan, then review independent lanes in parallel. |
| Delivery/commit verification | [Change classification](docs/verification.md#change-classification); finish focused checks, freeze the candidate, run one appropriate `check` or reuse its matching proof. Use `verify` with unresolved findings. |
| Commit finalization | [Review finalization](docs/review-procedure.md#incremental-independent-review); require the scoped proof, effective lanes and exact index, and explicitly install the tracked hook without replacing another owner. |
| New-version preparation | [Publishing](docs/publishing.md) and [Release coverage](docs/release-coverage.md); coverage belongs only to release preparation. |
| Model-backed evaluation | [Configuration Preflight](docs/evaluation.md#configuration-preflight); explicit authorization and provider/model/credential-variable configuration precede the isolated configuration-only check and any paid run. |

Finish with `git diff --check HEAD --`. Do not claim checks that were not run. Never commit generated `artifacts/`, coverage output, active review files, credentials, local paths, or local evaluation records. Commit or rewrite history only when explicitly authorized; never push without explicit authorization.

## Repository Conventions

- `index.js`: public plugin entry point and Cordis integration.
- `internal/`: runtime kernel, worker transport, journal, analysis, canonicalization, and value helpers.
- `test/`: focused contract and acceptance tests.
- `scripts/`: deterministic and opt-in model-backed runners.
- `docs/`: architecture, runtime, data-plane, installation, publishing, and ADR owners.
- `artifacts/`, `coverage/`, and runtime output: generated local material, not source.

Use modern ESM JavaScript, two-space indentation, descriptive `camelCase`, `PascalCase` classes, and `UPPER_SNAKE_CASE` constants. Use `PTC mode` in English and `PTC 模式` in Chinese. Reserve `strict` for an actual binding, language, or policy contract; call the model-visible projection the `code-only direct-tool projection`.
