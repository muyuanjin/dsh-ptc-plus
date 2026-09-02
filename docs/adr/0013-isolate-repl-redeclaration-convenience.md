# Isolate REPL Redeclaration Convenience

## Problem

The persistent REPL uses one worker lexical environment so later cells can refer to earlier top-level bindings. That convenience is not JavaScript's module or function semantics. Mixed old/new destructuring needs a policy for combining declaration and assignment, while ordinary iterative work also needs an explicit policy for replacing an earlier function or class declaration. Keeping either policy inside `internal/cell-analysis.js` makes core parsing and durability analysis depend on one replaceable persistence strategy.

## Decision

`internal/cell-analysis.js` owns cell parsing, binding inventory, durability classification, return rewriting, and execution preparation. Shared binding-pattern traversal lives in `internal/binding-pattern.js`. `internal/repl-convenience.js` owns two independent, optional cross-cell policies: variable replacement (including mixed destructuring lowering) and named function/class replacement. It returns executable source, collisions, redeclaration metadata, and rewrite provenance through one narrow function. The variable policy remains enabled by default; function/class replacement is disabled by default and must be enabled with `looseTopLevelFunctionClassRedeclarations`.

Only a top-level named `FunctionDeclaration` or `ClassDeclaration` whose name existed before preparation is eligible. Its catalog provenance must prove that the existing binding is writable: `let`, `var`, function, and class are writable; a source `const` is writable only when that cell's variable policy lowered it to `let`; imports and reserved/private bindings are not writable. Unknown provenance fails closed. A function is lowered at its declaration position to assignment of an anonymous function expression, so recursive reads resolve through the replaceable outer binding. A class is lowered to assignment of a named class expression, preserving its inner self-reference and ensuring a throw during class evaluation leaves the old outer value unchanged. Both forms deliberately take effect at the declaration position rather than acquiring native declaration hoisting. A terminated `void 0` statement prevents the assignment value from becoming the cell completion.

The original Program is validated before lowering. Same-cell duplicates, nested or block declarations, parsing, TypeScript scope rules, and source positions therefore remain owned by the language pipeline. A future state/frame persistence implementation can replace these policies without changing the cell language analyzer.

## Alternatives considered

**Keep redeclaration lowering in cell analysis.** This keeps calls local, but couples the language analyzer to one REPL implementation and makes a future independent cell scope harder to introduce or verify.

**Delete loose redeclaration convenience.** This would give the smallest semantic surface, but repeated top-level declarations are an intentional PTC Plus workflow and removing them would make ordinary iterative model use less effective.

**Create a full compiler pipeline immediately.** A general destructuring compiler could cover more syntax, but it would add a larger dependency and semantic surface before the persistence boundary is settled. Isolating the existing policy leaves that decision reversible.

## Consequences

The core analyzer has no redeclaration lowering helpers and can be tested independently of the REPL convenience policy. The compatibility module remains responsible for its custom replacement semantics and focused tests; neither policy is native JavaScript semantics. Binding assignability is reconstructed from prepared source and each cell's persisted policy rather than runtime-value inspection. Future persistence work can introduce fresh cell lexical frames while retaining or replacing the convenience adapter at one explicit boundary.
