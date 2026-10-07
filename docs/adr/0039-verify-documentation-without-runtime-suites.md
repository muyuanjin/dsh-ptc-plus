# Verify documentation without runtime suites

## Problem

A document-only commit previously ran every backend and browser test to obtain its source-bound proof. Those suites cannot establish whether prose, links or contributor instructions are correct, and unrelated environment failures can block a documentation correction. Moving procedures out of the default agent entry also has little benefit if every verification action reloads review coordination and release instrumentation details.

## Decision

`check` compares the complete source inventory against HEAD, including additions, deletions, untracked source files and Git modes. Only regular non-executable Markdown changes under `docs/` or in the four root documents `AGENTS.md`, `CONTEXT.md`, `README.md` and `README.en.md` select documentation verification. Every other change, an unborn HEAD or an unchanged candidate selects full verification. Templates and test fixtures are executable inputs to their consumers and are not classified by their Markdown extension alone.

Documentation verification checks diff whitespace, local link target existence and literal npm script references in changed documents and their referrers. It does not execute examples or contact external services. Independent review establishes semantic accuracy, instruction routing and heading-anchor correctness. `verify:docs` exposes this path for development and rejects a mixed candidate before launching any runtime suite. `verify` continues to request full behavioral validation explicitly; `check --full` requests full validation with a source proof even for documentation changes.

Both `check` branches retain ledger readiness and source/`HEAD` stability, but `check` does not enforce independent review or staged-tree identity. `review:finalize` enforces the recorded independent review plan and lane evidence after the proof exists, and pre-commit enforces exact prospective-index identity against the staged tree. The verification proof records the chosen scope as `documentation` or `full`; a documentation proof makes no claim about runtime test success. Existing proof identity and review invalidation rules remain in [ADR 0026](0026-persist-the-delivery-verdict-against-the-verified-candidate.md). This changes the documentation delivery branch of [ADR 0036](0036-separate-focused-development-from-delivery-verification.md); executable changes retain the complete delivery gate.

The default agent entry routes verification selection to `docs/verification.md`, review-state actions to `docs/review-procedure.md`, and release coverage to `docs/release-coverage.md`. Applicable requirements stay mandatory at their action boundary. Old verification section links remain as short forwarding sections. Test descriptions state the operation and observed contract; exact APIs, source fixtures, diagnostics and security properties remain accurate.

## Alternatives considered

**Run all runtime suites for every document change.** This spends time on an unchanged implementation while leaving documentation correctness to the same review still needed afterward.

**Permit manual hook skipping for documentation.** An exception can finish one commit but supplies no durable classification, source proof or repeatable validation path. The scoped check preserves those checks without requiring another exception.

**Classify every Markdown file as documentation, or inspect only the staged diff.** Test fixtures, templates, modes and unstaged source changes can affect executable behavior. The complete source inventory and explicit path boundary keep these changes on full verification.

**Automatically treat all test-name and comment edits as documentation.** Names participate in selectors and fixture exports, and source-looking comments or strings may themselves be test inputs. Development uses focused evidence; test-file changes retain full delivery verification.

## Consequences

Documentation delivery no longer depends on browser, runtime or cross-platform evaluation prerequisites. The checker proves mechanical references only; reviewers still need the affected contract owners. Executable changes can still expose cross-suite failures at the final gate. Reference routing reduces default reading without changing who owns a requirement, and does not establish provider acceptance rates or actual model-token savings.
