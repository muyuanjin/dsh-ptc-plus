# Separate Focused Development From Delivery Verification

## Problem

Requiring a complete deterministic gate after every executable development turn repeats long backend and browser matrices while the candidate is still changing. A focused command that silently defaults to all tests creates the same cost when an agent forgets a selection. Full behavioral validation and source-bound delivery proof remain necessary, but neither is a useful failure-localization loop.

## Decision

Development and independent review select the changed semantic owner and its bounded consumers. Executable edits alone do not trigger a complete gate. Backend and browser focused package entries require exact file or case selections before execution; listing the inventory is permitted without executing it. Client focused execution requires a test-name pattern. Independent layout diagnostics generate fresh HTML from only the two Client test owners that export all states. The complete visual gate retains the full Client suite once, followed by every layout and fallback case.

Complete validation runs on a stable executable candidate when preparing delivery/commit proof, when explicitly requested for full validation or timing, or when a specific cross-suite risk cannot be settled with focused evidence. [ADR 0039](0039-verify-documentation-without-runtime-suites.md) selects documentation checks for a strictly classified documentation-only delivery candidate. Use `verify` with unresolved findings and `check` otherwise. A valid result for an unchanged candidate is reused rather than repeating its component suites. A full failure returns to a discriminating focused check before the next stable-candidate gate.

These rules change scheduling, not test obligations, ordinary/release discovery, coverage thresholds, independent review, ledger readiness or pre-commit authorization. Focused evidence never becomes a commit proof. [ADR 0026](0026-persist-the-delivery-verdict-against-the-verified-candidate.md) retains the review/proof contract, [ADR 0033](0033-gate-client-visual-usability-in-a-browser.md) retains complete browser validation and [ADR 0035](0035-run-coverage-only-before-a-new-release.md) retains release-only coverage.

Runners expose inventory, concurrency and elapsed stage time. Agents wait on the existing process in intervals no longer than 60 seconds, remain responsive to new input, and inspect stage output when elapsed time exceeds expectations. A slow complete run does not authorize retries or a second concurrent copy.

## Alternatives considered

**Run a complete gate at the end of every development turn.** This makes turn boundaries, rather than candidate stability or delivery needs, determine expensive work and repeatedly verifies intermediate trees.

**Remove complete backend or browser cases.** This reduces time by weakening acceptance. Bounded concurrency, disjoint semantic partitions and eliminating duplicated fixture generation preserve the original obligations.

**Rely only on an instruction to choose focused tests.** A missing selector can still start the entire suite. Selection-required package entries reject that error before starting any tests or browsers.

**Treat focused success as delivery authorization.** This conflates selected behavioral evidence with complete validation and source/index identity. The final gate and pre-commit proof remain required for delivery.

## Consequences

Development results explicitly cover selected responsibilities. Cross-suite regressions may first appear at the stable-candidate gate or CI. Contributors must select relevant owners and consumers rather than claiming whole-tree correctness from samples. Maintained commands and examples live in [verification](../verification.md); the agent entry rules live in `AGENTS.md`.
