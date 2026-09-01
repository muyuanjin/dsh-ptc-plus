# PTC Plus Agent Contract

This file contains project-specific obligations for changes to PTC Plus. General contributor or agent methodology belongs outside the repository.

## Authority And Sources

PTC Plus turns DSH's top-level `run_code` into a session-bound TypeScript REPL. It preserves DSH-owned authority and native tool policy, keeps bindings continuous across cells, and records enough journal data to recover durable state. It does not add a second permission system, sandbox, scheduler, approval layer, session coordinator, name-dispatch registry, or cross-plugin Work Map.

Read [CONTEXT.md](CONTEXT.md) before changing behavior. Use repository sources by responsibility:

- `CONTEXT.md` owns project boundaries and non-negotiable invariants.
- ADRs own durable architecture, contracts, data formats, and project process decisions.
- Code, schemas, tests, and scripts provide executable evidence.
- `README.md` (Chinese default) and `README.en.md` (English) serve users; `docs/` owns detailed integration, runtime, installation, publishing, and operational material.

When these sources disagree, resolve the canonical owner and update affected dependents. A passing test does not preserve behavior that contradicts the project contract.

## Product Obligations

- DSH owns authorization, native-tool scope, policy, scheduling, cancellation, approval, and sandboxing. `danger-full-access` is the primary supported experience, but the worker is not a malicious-code sandbox.
- Target the latest available DSH release through public extension surfaces. A literal DSH version may appear only as historical source evidence and must not control current behavior, configuration, tests, installation, or compatibility claims.
- Preserve continuous REPL bindings and the session journal contract. Cold replay may return recorded values without redispatching external effects; it does not establish live retry idempotence or undo an effect.
- Keep model and UI presentation separate from canonical program values and completeness. Unknown metadata remains unknown; bounded data is not promoted to lossless data.
- Keep plugin-owned system text and ordered tool schemas byte-stable under unchanged configuration, model route, and native capability view. Changing session facts belong in append-only runtime contexts reconstructable from the session log. See [Prompt Prefix Stability](docs/architecture.md#prompt-前缀稳定性).
- Preserve `run_code` and `edit_run_code` names and arguments through DSH's public host pipeline. A top-level native call outside the declared direct surface may be normalized only when the live schema uniquely proves the intended member and the repair preserves JSON arguments, call identity, DSH validation, and result semantics.
- Every Cordis registration uses `ctx.effect()` or `ctx.on()`; registry `register()` methods return their disposer.
- Validate deployment-varying configuration at the earliest resolvable point. Provider, model, and credential-variable choices are explicit configuration, not repository defaults derived from one maintainer's environment.
- Use maintained dependencies and platform primitives for parsers, protocols, state machines, and serializers when they cover the required semantics.
- Comments and diagnostics state contracts, ownership, failure, and recovery consequences. They do not retain review discussion, implementation diaries, or local execution records.

Add or update an ADR only when a durable architecture, contract, data-format, or project process decision changes. Update `README.md` (Chinese default) and `README.en.md` (English) together for user-facing behavior. Installation and release procedures belong in [docs/installation.md](docs/installation.md) and [docs/publishing.md](docs/publishing.md).

## Local Review Ledger

`REVIEW_FINDINGS.md` is checkout-local and must never be staged or committed. Create it only with `npm run review:new`; `.agents/templates/REVIEW_FINDINGS.md` owns its schema and `scripts/review-findings.mjs` owns its lifecycle.

Before implementing a captured finding, record its chosen correction, canonical owners, affected dependents, and discriminating verification in `implementationPlan`. Update the plan before continuing when evidence changes the diagnosis or scope. Record factual completed evidence in `resolutionEvidence`; do not turn the ledger into a chronological transcript.

A finding becomes terminal only when its root cause and dependents are corrected and relevant verification passes, or when evidence establishes `invalid` or a durable tracked owner records `accepted`. Set `ledgerStatus: resolved` only when every finding is terminal. `npm run check` verifies an unchanged source tree, archives a terminal ledger under checkout-local Git metadata, and writes the commit proof consumed by the pre-commit hook. Do not manually delete a resolved ledger.

Install the tracked pre-commit hook explicitly with `npm run hooks:install`. Hook installation must not replace another hook owner or occur as a package-install side effect.

## Verification And Delivery

Use `npm ci` only when dependencies are unavailable or the lockfile changes. Against a stable tree, run one final deterministic command:

- `npm run verify` while an active ledger contains unresolved findings.
- `npm run check` when no active ledger exists or every active finding is terminal.

Finish with `git diff --check HEAD --`. `npm run verify` validates the ledger, performs syntax checks, and enforces 100% line and function coverage with at least 95% branch coverage. `npm run check` includes that verification and additionally binds the result to the unchanged source and prospective index trees.

Model-backed checks are opt-in, consume quota, and require explicit provider, model, and credential-variable configuration:

```sh
npm run test:expensive
npm run test:ab
```

Do not claim checks that were not run. Never commit generated `artifacts/`, coverage output, the active ledger, credentials, local paths, or local evaluation records. Commit or rewrite history only when explicitly authorized; never push without explicit authorization.

## Repository Conventions

- `index.js`: public plugin entry point and Cordis integration.
- `internal/`: runtime kernel, worker transport, journal, analysis, canonicalization, and value helpers.
- `test/`: focused contract and acceptance tests.
- `scripts/`: deterministic and opt-in model-backed runners.
- `docs/`: architecture, runtime, data-plane, installation, publishing, and ADR owners.
- `artifacts/`, `coverage/`, and runtime output: generated local material, not source.

Use modern ESM JavaScript, two-space indentation, descriptive `camelCase`, `PascalCase` classes, and `UPPER_SNAKE_CASE` constants. Use `PTC mode` in English and `PTC 模式` in Chinese. Reserve `strict` for an actual binding, language, or policy contract; call the model-visible projection the `code-only direct-tool projection`.
