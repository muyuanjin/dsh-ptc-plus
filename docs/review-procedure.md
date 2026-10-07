# Findings and independent review

Read this procedure before findings, independent review or review-state commands. [Verification](verification.md) selects the checks appropriate to the candidate; this procedure owns review evidence and commit authorization.

## Findings ledger

`REVIEW_FINDINGS.md` is checkout-local and must never be staged or committed. Create it only with `npm run review:new`; [the tracked template](../.agents/templates/REVIEW_FINDINGS.md) owns its schema and `scripts/review-findings.mjs` owns its lifecycle. `REVIEW_PLAN.json` is also checkout-local and must never be staged or committed; its creation and recording procedure is below.

Keep `requiredOutcome` as the stable acceptance condition. Before implementing a captured finding, use `implementationPlan` to explain why the failure is reachable, which owners and dependents must change, and what observation would distinguish the correction from the existing failure. Update the plan before continuing when evidence changes the diagnosis or scope. Put completed observations and their results in `resolutionEvidence`, not a restatement of intended work.

The ledger validator checks structure and required evidence fields; it cannot establish that the recorded diagnosis or evidence is sound. Each disposition must remain independently verifiable from its cited sources and executed observations. Do not turn the ledger into a chronological transcript. An accepted finding's local `dispositionRef` must name one exact tracked file present in the source candidate being verified, not merely an index entry, missing file, directory, or pathspec match.

A finding becomes terminal when its root cause and dependents are corrected and relevant verification passes, or when evidence establishes `invalid` or a durable tracked owner records `accepted`. An accepted limitation remains a limitation. Set `ledgerStatus: resolved` only when every finding is terminal; this status alone does not establish implementation completeness or a clean independent review. Let `npm run check` archive a terminal ledger under checkout-local Git metadata; do not manually delete it.

Install the tracked pre-commit hook explicitly with `npm run hooks:install`. Hook installation must not replace another hook owner or occur as a package-install side effect.

## Incremental independent review

After focused checks pass, partition independent review and freeze the recorded plan before starting reviewers in parallel. Create the ignored working plan, replace every placeholder, then record it against the commit that defines the change scope:

```bash
npm run review:plan:new
npm run review:plan -- --base <base-commit>
```

The plan uses `dsh-review-plan/v1`, and the ignored root `REVIEW_PLAN.json` is its only active source. All five standard obligations from the template must remain present. Each standard or change-specific obligation is assigned to a lane or excluded with a concrete reason. A lane declares semantic scope, exact file paths or directory prefixes, upstream lanes, owners, consumers, and counterexamples. `.` selects the complete checkout. Paths only determine content inputs and changed-path coverage; they do not replace the semantic declarations. A lane fingerprint covers that declaration, its assigned obligations, selected raw Git entry identities, persistent invalidation generation, and upstream fingerprints. Dependencies must form a DAG. The plan command refuses missing standard obligations, placeholders, unknown obligations, dependency cycles, a non-ancestor base, and changed paths outside every lane.

The plan command prints one `review-lane <id> <head> <fingerprint>` line per lane. Reviewers use focused diagnostics; review alone does not start another complete gate. `npm run review:status` prints one current overall `HEAD` and each lane's content fingerprint; it does not invent a per-lane capture head for an incomplete lane. A recorded clean lane also includes the `HEAD` captured for that review. Record each clean external report with the identity captured before that review:

```bash
npm run review:lane -- \
  --lane <id> \
  --evidence <report-path> \
  --expect-head <head> \
  --expect-fingerprint <lane-fingerprint>
```

Give a reviewer its declared semantic boundary and normal project context. The candidate is the working tree it is given: a reviewer environment that cannot run repository Git must read those working-tree files directly. Historical copies under `.git/` and generated `artifacts/` are not candidate sources. Keep reports outside the checkout or ignored. A lane declares only paths covered by the gate's source inventory; checkout-local exclusions are not candidate input or review evidence. Every path changed from the base must belong to at least one lane. Define lanes by semantic responsibility, not file count.

A coverage gap, insufficient evidence, or interrupted review ends with `VERDICT: INCOMPLETE`. Do not silently expand or reassign a lane when review exposes a missing owner, consumer, dependency, counterexample, obligation, or changed path; revise and record the plan before continuing.

A clean report's last non-empty line must be `VERDICT: NO FINDINGS`. A readable findings or incomplete report retires the named lane and every declared dependent from the recorded plan before checking whether the current candidate drifted; restoring an earlier tree therefore cannot revive evidence that the report rejected. An unreadable or missing report path is a command-input error and does not retire valid evidence. Unrelated lanes remain effective. A clean report retains the captured `HEAD` as provenance; an unrelated concurrent edit or `HEAD` advance does not prevent recording. Direct input, upstream fingerprint, scope, obligation, owner, consumer, counterexample, or dependency changes do. Put findings in `REVIEW_FINDINGS.md`, fix them, and rerun only the incomplete lanes shown by `npm run review:status`.

Review-state mutations and authorization decisions use one atomic lock under checkout-local Git metadata. These mutations and authorization decisions must use this lock; parallel script variants must not establish a separate mutation path. Plan recording, clean or negative lane recording, finalization, clearing, and pre-commit therefore have one observable order. A negative report queued behind an older clean recorder advances the reported lane's persistent invalidation `{epoch, revision}`, including while that lane is temporarily absent from the current plan, before retiring its current dependent closure. Advancement increments the revision normally and rotates to a new random epoch with revision zero at `Number.MAX_SAFE_INTEGER`, so a valid tuple never becomes unretirable. A temporarily absent lane must already have a retained tuple; unknown or mistyped lane IDs are rejected rather than creating state. Every active lane must have an explicit tuple. The tuple participates in the lane fingerprint and propagates through dependency fingerprints, so an older clean report cannot be submitted after re-addition. It survives normal `review:clear` and temporary lane removal; only a review captured after retirement can authorize the repaired fingerprint. Missing, partial, or malformed generation state blocks status and authorization. Explicit clear preserves valid generations but removes damaged generation state; plan recording then creates a new random epoch, so old reports still cannot match. The lock records a PID and unique release token and bounds acquisition, but never reclaims another owner automatically. If a command crashed, confirm that no review-state command is active, obtain the exact checkout-local path with `git rev-parse --git-path review-findings/state.lock`, remove only that directory, and retry. `review:status` remains a diagnostic snapshot and does not grant authorization. Finalization and pre-commit also re-read the active plan, candidate, proof, lane records, and evidence before they persist or return a decision, so edits made outside the review commands fail closed.

Do not mutate a recorded boundary implicitly. Every status, clean lane verdict, finalization, and commit decision compares the normalized active file with the recorded plan. Missing, malformed, or semantically changed active content blocks clean authorization; it does not block a findings or incomplete report from retiring the recorded lane closure. Whitespace and object-key formatting alone do not change plan identity. When evidence reveals a missing path or semantic dependency, edit `REVIEW_PLAN.json` and run `npm run review:plan` without another `--base`; the command reuses the recorded base. The new plan hash invalidates its aggregate verdict, but clean lane records survive when their base, complete declaration, selected Git entries, upstream fingerprints, and evidence hashes are unchanged.

When delivery/commit finalization is requested and `review:status` reports `clean`, run the candidate-appropriate check once (or reuse its still-matching proof) and bind the composite verdict to it:

```bash
npm run check
npm run review:finalize
git diff --check HEAD --
```

The `check` proof binds verification to the source and current `HEAD` while requiring the source tree and active ledger to remain unchanged through verification; a resolved active ledger is archived only after those checks and before the proof is published. `check` itself does not prove the semantic obligations assigned to independent lanes or compare a prospective index. The final verdict uses `dsh-review-verdict/v2`. `review:finalize` verifies the recorded plan, lane fingerprints and evidence against that proof. Pre-commit separately verifies the whole source fingerprint, `HEAD` and prospective index. A later `HEAD` change retires the proof and aggregate verdict. Source or index drift blocks the gate while it differs; restoring the exact finalized candidate preserves those records, while keeping a changed candidate requires another `check` and `review:finalize`. Only lanes whose effective inputs changed need another independent review. `npm run review:clear` abandons the recorded plan, lane records, aggregate verdict, and verification proof while leaving the working `REVIEW_PLAN.json` available for revision; persistent invalidation generations remain so pre-retirement reports cannot revive in a rebuilt plan. Clearing is not a normal retry step. The prior single-report `verdict` command and `dsh-review-verdict/v1` records are not accepted. Both documentation and full checks require the same ledger readiness and source-bound proof; independent review is enforced afterward by `review:finalize`, and prospective-index equality afterward by pre-commit. The proof records which verification scope ran; documentation evidence does not claim runtime validation. Once the proof, effective review, prospective index and `git diff --check HEAD --` agree, an explicitly authorized commit needs no additional complete-tree review. Only an invalidated lane, changed plan boundary, changed content, new counter-evidence, or invalidated proof reopens the corresponding gate.
