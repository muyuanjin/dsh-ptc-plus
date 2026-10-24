# Gate the Commit With the Semantic-Evidence Tier

## Problem

`npm run check` is the pre-commit gate: it classifies the candidate, runs the appropriate verification, and binds a source proof to the tree. Its full branch ran two complete inventories at once — the whole ordinary backend suite (every root `test/*.test.js`, one Node process per file) plus the complete browser visual suite. On a 24-CPU Windows workstation the backend inventory alone measured 880–908 s, so the gate took about 15 minutes before any failure surfaced, and it was not reliable there: two backend cases hard-coded a POSIX workspace cwd, which makes the kernel worker reject the derived filename on Windows, so the gate could never pass on that platform. A gate that is both slow and platform-red is not used as a gate: contributors either skip it or run it after the change is already pushed.

## Decision

The commit gate runs the static prerequisites plus the **semantic-evidence backend tier**; the complete behavioral inventories stay behind `npm run verify`.

- `npm run check` records its proof from `npm run verify:check`: `review:validate`, `host:baseline:verify`, `semantic:check`, `build:check`, the syntax checks and `deterministic-test-groups.mjs --check`.
- `--check` selects `test:backend:fast`: the test files that `semantic-obligations.json` names as evidence for at least one obligation, minus coverage-only paths and the verification-tooling probes that fail by construction outside their own harness. Each obligation keeps at least one executable owner, and the fast tier is derived from the ownership graph rather than a hand-maintained list.
- `npm run verify` keeps the complete gate: `test:client:visual` plus the whole ordinary backend inventory. CI runs `verify:ci`, release preparation runs `verify` (and coverage), and any change that touches a semantic owner missing from the graph must extend the graph — which extends the fast tier at the same time.
- Browser suites are no longer part of the commit gate. They remain the complete visual contract and run in `verify`, in CI, and on demand.
- The backend runner rejects `--file` together with `--fast`, so a caller cannot mistake a focused selection for the tier.

Measured on the same Windows workstation: `verify:check` completes in 103 s (fast tier 96 s, static prerequisites 7 s); the complete gate remains ~900 s for the backend inventory plus ~186 s of browser suites. Linux/WSL runs the complete backend inventory in 376 s at `DSH_PTC_TEST_CONCURRENCY=2`, so the tier split is a Windows-scale decision, not a suite that is inherently slow.

Two portability defects surfaced while making the gate reliable and are part of this decision's evidence: the two `plugin-settings` fixtures used `cwd: '/workspace'`, which produced a `file:///workspace/repl` worker filename that Windows rejects; they now use a platform-neutral cwd. The failing assertion also prints the runtime's own diagnostic instead of a bare boolean.

## Alternatives considered

**Keep the complete inventories in the commit gate.** Rejected: 15 minutes on the target workstation, and the same gate cannot be green there at all while a fixture is platform-specific. Contributors route around a gate they cannot run.

**Skip the two Windows-failing cases with a platform reason.** Rejected: the failures were a fixture defect, not a platform-specific behaviour. Fixing the fixture keeps the protection and removes the red.

**Run the whole backend inventory in one process (`--test-isolation=none`).** Rejected after measurement: the suite hung when files that own workers and kernels shared one process, so isolation is load-bearing.

**Move only the browser suite out.** Rejected after measurement: browsers cost 186 s, the backend inventory costs ~900 s. Moving browsers alone leaves the gate far outside its budget.

**Keep a hand-maintained fast list.** Rejected: it drifts from the ownership graph and silently stops covering new owners. Deriving the tier from `semantic-obligations.json` makes coverage and the gate the same fact.

## Consequences

The commit gate proves the static contract and the semantic-evidence tier, not the complete inventories; complete behavioral validation moves to `verify`, CI and release preparation. A regression that only a non-evidence test file can detect now surfaces there rather than at the commit gate. Adding an obligation or an evidence file widens the fast tier, so expanding protection remains a one-line graph change. [ADR 0036](0036-separate-focused-development-from-delivery-verification.md) still owns scheduling, [ADR 0033](0033-gate-client-visual-usability-in-a-browser.md) still owns complete browser validation, and [ADR 0035](0035-run-coverage-only-before-a-new-release.md) still owns release coverage.
