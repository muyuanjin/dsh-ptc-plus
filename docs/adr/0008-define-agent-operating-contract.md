# Keep The Agent Contract Project-Specific

## Problem

PTC Plus needs a tracked instruction surface for product boundaries, source ownership, verification, and release safety. Generic reasoning methods, editorial playbooks, editor settings, and private branch conventions have different owners and lifetimes. Publishing them as mandatory project policy enlarges the contributor contract and makes local maintainer workflow appear necessary for product correctness.

## Decision

`AGENTS.md` contains only obligations whose subject is PTC Plus: DSH authority, runtime and journal invariants, public source ownership, checkout-local review state, deterministic verification, documentation parity, generated-material exclusions, and delivery safety. It links the canonical product and architecture documents rather than duplicating their detailed behavior.

Reusable maintenance methods remain outside tracked project sources. Local editor state and branch topology also remain checkout-owned. They may guide an individual maintainer, but project code, tests, hooks, and acceptance do not require their names, installation, or presence.

The tracked findings-ledger and review-plan templates and their lifecycle script remain because they enforce repository-specific commit invariants: unresolved findings cannot be committed, changed paths need declared semantic coverage, lane evidence follows dependency-scoped invalidation, and a verified source tree must match the prospective Git tree. The tracked hook is limited to those invariants and is installed explicitly.

## Alternatives considered

**Publish the complete maintainer environment.** This makes one checkout reproducible but exposes private workflow as public policy and couples contributors to tools unrelated to PTC Plus behavior.

**Remove the project contract entirely.** `CONTEXT.md` owns product semantics, but it does not own source routing, ledger lifecycle, verification commands, bilingual documentation, or generated-material exclusions. Those repository-specific obligations still need one concise entry point.

**Keep generic methods as optional tracked references.** Optional wording does not change their public ownership or maintenance cost. Methods without a PTC Plus-specific executable consequence stay outside the repository.

## Consequences

Contributors can determine the obligations needed to preserve PTC Plus without adopting a maintainer's agent stack, editor, model route, or branch workflow. Product semantics retain their canonical owners, while the public operating contract remains small enough to audit for contradictions and private-environment leakage.
