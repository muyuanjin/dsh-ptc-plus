# Run Coverage Only Before a New Release

## Problem

Collecting and merging instrumented coverage on every local verification and commit repeats release-readiness work during ordinary development. Behavioral verification, source-bound commit proof, and coverage thresholds establish different facts, so moving coverage must preserve the complete daily test suite and the independent-review gate.

## Decision

Coverage collection, coverage runner/report regression suites, and instrumented probes run only while preparing a new version for release. `npm run verify` and the `npm run check` proof path retain generated-build checks, syntax validation, Client verification, and the complete ordinary backend test suite without coverage instrumentation. Ordinary discovery selects root `test/*.test.js`; coverage-only suites and collection probes live under `test/coverage/`. The release coverage runner selects both inventories and owns `DSH_PTC_TEST_COVERAGE_SUITE=1` for mixed instrumented cases. Ordinary execution clears that marker. Both runners share the bounded concurrency calculation. Ordinary execution enables module mocks but does not preload coverage hooks or inherit coverage and temporary bytecode settings into the test process.

The Release workflow runs `npm run coverage` against its verified annotated tag before packing or npm staging. The full coverage gate retains compiler source remapping, plugin-source closure checks, 100% line and function coverage, and at least 95% branch coverage. A failure prevents staging. Normal CI keeps its portable runtime and official-Host contracts without collecting coverage. During release preparation, maintainers may run the full gate locally and use `npm run coverage:focus` to diagnose a failed coverage threshold; focused evidence cannot replace the full release gate.

This changes coverage scheduling, not findings-ledger readiness, independent review, source and index identity, or pre-commit authorization from [ADR 0016](0016-archive-resolved-review-findings.md) and [ADR 0026](0026-persist-the-delivery-verdict-against-the-verified-candidate.md). The release authority and immutable artifact path remain owned by [ADR 0022](0022-stage-npm-releases-with-oidc.md).

## Alternatives considered

**Keep coverage in every local verification and commit.** This preserves the old timing but forces development and review to pay the instrumentation and merge cost even when no new version is being prepared.

**Remove the coverage command without retaining the complete backend suite.** This shortens daily verification by silently dropping behavioral evidence. Ordinary verification instead retains every ordinary behavioral case while coverage-specific cases remain in the release inventory.

**Treat coverage regression fixtures as an exception to the daily prohibition.** Those test bodies can start collection or instrumentation even when the package command no longer invokes coverage. The scheduling boundary therefore owns test discovery and mixed-case selection as well as the top-level command.

**Require coverage only in a human release checklist.** This records the intended timing but lets the automated staging path publish a candidate without meeting the thresholds. The Release workflow enforces the gate before creating and staging the artifact.

## Consequences

Daily verification and commit proof no longer establish coverage thresholds. Those thresholds remain a new-version release requirement, and the release job needs enough time for the instrumented suite and report merge. Behavioral regressions still fail daily verification, while coverage deficits may first be discovered during release preparation. The maintained command and diagnostic contracts live in [release coverage](../release-coverage.md), [focused verification](../verification-optimization-work.md), and [publishing](../publishing.md).
