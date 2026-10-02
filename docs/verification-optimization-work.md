# Focused Verification

## Purpose

`npm run coverage:focus` provides a bounded diagnostic loop for executable
changes. It checks selected gate-owned sources with the smallest test set that
can distinguish a correction before the repository-wide release gate runs.

The focused command does not replace `npm run verify` or `npm run check` and
does not write a verified-tree proof. [Deterministic verification](verification.md)
owns command syntax, thresholds, generated evidence, and the final gate.

## Contract

- Every selected source and test must exist inside the checkout.
- Selected sources must belong to the full coverage gate, and selected tests
  must be `test/*.test.js` files.
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

Use focused coverage after the nearest behavioral test passes or after a full
gate identifies a narrow coverage deficit. Select every changed source whose
threshold matters and the tests that exercise its distinct paths. A passing
focused run establishes only that selected relation.

Run one final `npm run verify` while the local review ledger has unresolved
findings. Once every finding is terminal, run `npm run check` on a stable tree
to produce the proof consumed by the commit hook. Do not run `verify`
immediately before `check` on the same tree because `check` already invokes it.

Temporary concurrency overrides change scheduling only. Use one only when
current evidence identifies scheduling contention, and do not carry it into a
later run without that condition.
