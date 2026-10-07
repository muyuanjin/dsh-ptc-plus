# Focused Verification

## Purpose

`npm run coverage:focus` provides a bounded diagnostic loop for coverage
failures while preparing a new version for release. It checks selected
gate-owned sources with the smallest test set that can distinguish a correction
before the full release coverage gate runs again.

Coverage is not part of ordinary development, review, commit preparation,
`npm run verify`, or `npm run check`; coverage-specific suites and instrumented cases are also excluded from those daily entries. The focused command does not replace the
full release coverage gate and does not write a verified-tree proof.
[Release coverage](release-coverage.md) owns coverage command syntax, thresholds,
generated evidence, and the final gates; [ADR 0035](adr/0035-run-coverage-only-before-a-new-release.md)
owns coverage scheduling.

## Contract

- Every selected source and test must exist inside the checkout.
- Selected sources must belong to the full coverage gate, and selected tests
  must be `.test.js` files under `test/`.
- Selected but unexecuted sources remain in the report as uncovered.
- The report applies the full gate's 100% line/function and 95% branch
  thresholds.
- Compiler bytecode preparation, mock-dependent grouping, real Worker
  instrumentation, source-map filtering, TAP diagnostics, and isolated
  coverage collection match the full coverage runner.
- Node test options may follow a standalone `--` after the focused source and
  test selections.

Compiler instrumentation belongs to the test runner, not the compiler service.
The runner prepares bytecode without coverage, then preloads
`scripts/instrument-compiler-coverage.mjs` before the compiler captures Node's
`Script` constructor. Only the exact compiler bundle bypasses cached bytecode
consumption during that run; cache export uses the prepared, uninstrumented
bytes. The real-worker testing entry installs the same seam before importing
the production worker, removes its private entry locator and bytecode-path
environment variable, restores the ordinary worker's `process.argv[1]` through
the worker realm restoration boundary, and then runs the unchanged worker. Production compilation
does not read `NODE_V8_COVERAGE` or `DSH_PTC_COMPILER_BYTECODE` and never opens a
file selected by those variables.

The testing `Script` seam preserves the compiler's option prototype and property
descriptors while disabling only `cachedData`. Ordinary scripts keep their
original options. Descriptor conversion uses the shared compiler descriptor
owner; the seam captures its required primordials before user execution so
caller prototype and static-method mutations cannot reach private compilation.
Prepared cache export copies typed-array internal data through a captured native
constructor, without invoking public length getters on its private snapshot.
The shared compiler platform also uses captured native byte operations for
encoding and decoding, so first-use TypeScript lowering cannot invoke a caller's
replacement typed-array length getter in either ordinary or covered execution.
Covered and ordinary workers use the same absolute entry
normalization for URL objects, file-URL strings, and filenames; the testing
preload does not independently reinterpret a caller's entry.

## Workflow

During ordinary development, use the selection-required behavioral entries in
[verification](verification.md) without coverage. Executable changes alone do not
trigger a complete gate; [ADR 0036](adr/0036-separate-focused-development-from-delivery-verification.md)
owns the development versus delivery boundary.
During release preparation, use focused coverage after the full release coverage
gate identifies a narrow deficit. Select every changed source whose threshold
matters and the tests that exercise its distinct paths. A passing focused run
establishes only that selected relation; rerun the full coverage gate before
packing and staging.

When complete validation is requested for delivery, timing or an identified
cross-suite risk, run one final command on the stable candidate: `npm run verify`
with unresolved findings, otherwise `npm run check -- --full`. Terminal findings alone do
not trigger another gate. A still-matching proof is reused for delivery; focused
results never replace it. Do not run `verify` immediately before `check` on the
same tree because the full check already invokes it.

Temporary concurrency overrides change scheduling only. Use one only when
current evidence identifies scheduling contention, and do not carry it into a
later run without that condition.
