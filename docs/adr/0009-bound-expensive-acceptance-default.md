# Bound The Expensive Acceptance Default

## Problem

The model-backed acceptance runner starts one independent DSH session per scenario. Each session repeats the full system prompt and model route, so adding a deterministic edge-case scenario increases token use even when the same behavior already has exhaustive keyless coverage. The default run must retain representative model-facing workflows without making every deterministic rewrite case a quota-consuming session.

## Decision

Each descriptor in `scripts/expensive-acceptance-scenarios.json` owns whether it belongs to the default run. The five defaults are rejected-cell editing, durable binding continuity, the typed program surface, direct Node volatile continuity, and static import conversion. The mixed redeclaration scenario remains selectable with `DSH_PTC_ACCEPTANCE_SCENARIOS=partial-redefinition-split`. The executable selection derives from those descriptor flags, so the manifest and runner cannot maintain a second default list.

Every expensive scenario and A/B task declares machine budgets for model requests, direct calls, source characters, repeated source, result characters, assistant characters, token traffic, and aggregate runtime-context characters. A model request is one logical loop step recorded by durable `step/start`; `request/header` records an initial, resume, or changed header epoch and is counted separately. Neither metric claims to count provider adapter attempts, because retries can make multiple attempts within one logical step without a distinct durable event. The shared acceptance contract treats an exceeded budget as a failure. It also attributes every aggregate runtime snapshot by named section, enforces allowed PTC Plus contribution names and bounds, and verifies required append, update, and clearance transitions. Edit-specific narration is never allowed.

For a trajectory whose configuration, model route, and native capability view remain stable, the shared acceptance contract canonicalizes every `request/header` by DSH rules and compares exact system text and ordered complete tool schemas. An initial epoch establishes the baseline, an equal resume epoch reaffirms it, and every unapproved change epoch fails acceptance. A scenario that changes route, configuration, or capability declares the exact condition and epoch in `headerPolicy.allowedTransitions`; a scenario that replaces history declares the exact `headerPolicy.historyReplacements` count without relaxing header equality. Fingerprints are report metadata only; acceptance compares the canonical values and reports the first differing field.

The edit canary covers both a completed cell whose result needs adjustment and a runtime-rejected cell in one session. It requires the model-visible direct sequence `[run_code, edit_run_code, run_code, edit_run_code]`, each exact delta, private target and derived-run metadata, and no model-authored retransmission of either materialized source. Successful static-import and mixed-redeclaration rewrites retain result provenance without creating runtime-context transitions. The typed program-surface task requires focused discovery, schema inspection, native reading, and isolated execution in that order while rejecting unrelated capability expansion.

Both model-backed runners complete keyless verification and resolved-config validation before model invocation. They then run one complete representative canary sequentially and audit its process result, session log, tool transport, runtime contexts, budgets, and task oracle before scheduling broader scenarios, replicates, or concurrency. A canary failure stops the run without starting the remaining paid work. Deterministic tests remain the authority for AST rewrite variants and the acceptance contract itself. The ordinary-task A/B canary is the stable fixture's fixed, cheap, machine-checkable transport task rather than a full repository test run; see ADR 0018.

Resolved tools settings are independently validated by DSH's public configuration schema, in addition to the runner's policy comparison. Workload-specific inspection symbols and operation limits belong to the scenario's `programWork` expectations. These limits use canonical argument evidence and include failed calls; identical arguments never authorize runtime deduplication or prove observation freshness. The fixed typed fixture permits one native read and reuse of that observation. Guarded edits reuse the canonical editor and dispatch-time target projection; explicitly expected guard mismatches require a non-executing result without derived metadata. Deterministic coverage of these contracts does not enlarge the default paid cohort.

Machine acceptance and stochastic comparison are separate from blind semantic review. A/B output reports machine pass or failure independently and keeps overall approval pending until the blind packets have been evaluated; producing packets is not evidence that their review is complete.

## Alternatives considered

**Run every scenario by default.** This maximizes model-sampled breadth but pays a complete prompt and session cost for behavior already covered deterministically. It is retained as an explicit scenario selection rather than the quota-consuming default.

**Delete the mixed redeclaration scenario.** This would lower maintenance and token use, but it would remove a useful model-facing probe. Keeping it selectable preserves that evidence without imposing its cost on every run.

**Shorten only the task prose.** This saves a small number of input tokens but does not remove the repeated per-session prompt and model setup cost. Scenario selection provides the larger reduction while preserving the important workflows; the typed-program task keeps semantic wording so the model-visible discovery contract remains under test.

**Run scenarios concurrently from the start.** This lowers elapsed time on a healthy build but spends quota after the first representative trajectory could already prove the transport or context contract invalid. A sequential canary provides the stopping boundary; concurrency remains available after it passes.

**Keep efficiency fields observational.** Reports would retain useful numbers, but a green outcome could coexist with repeated source, unbounded context, or excessive output. Explicit scenario budgets turn product value into acceptance without treating stochastic arm-to-arm deltas as deterministic requirements.

**Use header epochs as model-request counts and compare only header fingerprints or tool names.** A header epoch represents reconstructable request configuration, not each logical model step, so it can both undercount request traffic and misclassify a prefix change as traffic. Reduced comparisons can also admit schema-field or ordering changes and cannot identify the differing canonical field. Logical steps and complete headers remain separate evidence.

**Budget physical provider attempts from usage or assistant messages.** Usage may be absent on failed attempts, and retries may issue several adapter calls within one logical step. A physical-attempt budget requires a distinct durable upstream event rather than an inference from incomplete downstream evidence.

## Consequences

The default run spends one canary session before it can expand. A valid build then covers the five representative workflows; an invalid build stops at the first complete discriminator. Full or focused extension runs select additional scenario ids explicitly. Reports can establish machine acceptance and comparative measurements, while blind approval remains an independently completed artifact.
