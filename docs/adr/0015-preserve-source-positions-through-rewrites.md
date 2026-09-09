# Preserve Source Positions Through Rewrites

## Problem

PTC cells are prepared by several source-to-source passes before they reach the worker: module syntax lowering, REPL redeclaration lowering, and return control flow lowering. A generated statement can therefore be longer than the original statement. Reporting the worker's raw line and column against the original cell then points past the source or at the wrong token, especially when rewritten syntax and the failing expression share a line.

## Decision

Each source edit carries a compact segment map from generated text back to the original cell. Unchanged text retains exact offsets; generated module bindings and source literals carry token-level anchors to their originating AST nodes, while other introduced text maps to the replaced source span. [`internal/source-position-map.js`](../../internal/source-position-map.js) validates and sorts one pass of non-overlapping edits, then assembles source and composed segments in one traversal. Binary segment lookup handles repeated or non-monotonic explicit token anchors without rescanning the complete map. Maps compose through every preparation pass. Mixed-destructuring generation emits copied pattern, initializer, and binding ranges through the same mapped representation instead of one opaque replacement string. [`internal/cell-parser.js`](../../internal/cell-parser.js) is the single executable-parse entry: it relocates AST ranges to original-cell coordinates and reports parse failures in those coordinates, so no downstream pass applies a wrapper offset. [`internal/cell-analysis.js`](../../internal/cell-analysis.js) maps parse failures raised against the module-rewrite output, preflight spans, and collision spans back to original-cell coordinates before returning a prepared program; runtime exception positions use the same map after worker execution, except a module-load failure that already carries an original-cell position.

## Alternatives considered

**Report generated coordinates.** This is simple, but the displayed source is the original cell, so the diagnostic is not actionable when a rewrite changes a line's width.

**Generate and persist full source maps.** A standard source-map artifact would support richer tooling, but it adds serialization and lifecycle surface to a diagnostic-only concern whose required mapping is local and internal.

**Pad every rewrite to the original width.** Padding can preserve some columns, but it cannot represent generated statements that need more space and would distort execution source or require unrelated formatting constraints.

**Apply edits from right to left and rebuild the map after each edit.** Reverse application avoids offset adjustment, but repeats whole-source concatenation and whole-map traversal for every edit on the host thread. A batch owns the shared input coordinate system already, so one validated assembly is both simpler and bounded by the actual input and output artifacts.

**Represent a generated helper as one proportional span.** This keeps generation call sites short but loses the identity of copied expressions and identifiers. A mapped builder makes copied source explicit at generation time and prevents later diagnostic code from reconstructing provenance heuristically.

## Consequences

Parse, preflight, collision, and runtime exception diagnostics all reach rendering in original-cell coordinates while the worker still executes the direct generated program. Mapping storage grows with rewrite segments and semantic token anchors rather than cell length; batch assembly avoids per-edit copies of both artifacts. The mapping is not part of journal metadata or model-visible prompt text, so replay and prompt-prefix stability are unchanged. Copied helper expressions retain exact source positions, while syntax that has no original token remains anchored to the rewritten declaration.
