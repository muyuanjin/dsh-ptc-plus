# Close semantic obligations by owner

## Problem

Focused tests and coverage can prove their selected examples executed, but they cannot show that every plugin-owned semantic transformation or execution boundary has an owner, contract and independent oracle. Adding more examples to a single compiler or realm matrix leaves module, transport, recovery, host and client boundaries outside that matrix, while treating all Node behavior as one fidelity surface erases intentional PTC differences and bounded external assumptions. An unregistered source boundary therefore needs a deterministic failure before review, not a reviewer remembering to extend a list.

## Decision

`semantic-obligations.json` is the tracked graph of plugin-owned semantic boundaries. Each obligation records one semantic owner, exact implementation files, disposition, owning contract, preserved observables or declared differences, execution entries, lifecycle states, language or data generations, platform bounds, consumers, oracle, executable evidence and upstream obligations. Dispositions distinguish behavior preserved from an external owner, intentional PTC differences and bounded external surfaces; an omitted or uncertain obligation is unknown and fails validation rather than being relabeled as preserved.

`scripts/semantic-obligations.mjs` validates the graph before build and coverage in `npm run verify`. The exact inventory covers every JavaScript implementation file in `internal/` and `src/`, the public `index.js` and `client.js` entries, and the journal migration entry, with exactly one semantic owner per file. Adding, removing or assigning a source twice fails closed until the graph changes. Contract and evidence files must exist, every obligation needs executable test evidence, dependencies must resolve without cycles, journal versions must remain a contiguous recorded range, and declared language and module generations must equal their executable owners. The command emits counts for preserved, intentional-difference, bounded-external and unknown obligations; zero unknown means closure over the declared plugin source boundary, not equivalence with all current or future Node or DSH behavior.

The graph complements, rather than replaces, focused tests, coverage and independent review lanes. A boundary-specific registry can enforce a stronger relation where the implementation supplies one: worker realm mutations use their classified installation entry and AST check, journal generations use their closed schema, and language/module generations use exported sets. Other records bind exact owner files and evidence so a new boundary cannot enter the tracked source inventory silently; review still evaluates whether an edit inside an existing owner changes its obligation or dependencies.

`docs/semantic-validation.md` explains how to choose an oracle and extend evidence. `REVIEW_PLAN.json` remains the checkout-local snapshot partition: its lanes may split or combine tracked obligations for review cost, but must preserve the graph's owner dependencies and changed-path coverage. A clean graph report establishes declared coverage only; deterministic verification and clean independent lane verdicts remain separate delivery requirements.

## Alternatives considered

**Expand the Test262 or compiler matrix until it appears comprehensive.** Those matrices are strong independent oracles for selected language behavior, but they do not own worker transport, program bindings, journals, host integration or client projection and cannot detect an omitted entry outside their axes.

**Use line and function coverage as the global model.** Coverage shows code execution, not which observable must be preserved, whether a difference is contractual, or whether the expected value came from an independent source.

**Make the worker realm inventory the global registry.** Realm mutation is only one boundary. Folding compiler, module, wire, recovery and host behavior into Node surface rows would obscure their owners and recreate a manually sampled API matrix.

**Derive ownership only from each temporary review plan.** Review plans are candidate-specific and checkout-local. They cannot serve as the durable source inventory or contract graph required before a plan exists.

## Consequences

New implementation files and generation changes require an explicit obligation update, and stale evidence blocks the normal gate early. The graph is intentionally bounded to plugin-owned JavaScript sources and declared platform contracts; dependency internals, arbitrary Node APIs and future DSH behavior remain outside the equivalence claim. Exact file assignment adds maintenance cost, but makes source growth and ownership movement reviewable instead of silent.
