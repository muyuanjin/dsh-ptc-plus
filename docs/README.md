# Documentation

## Getting Started

- [Installation](installation.md): npm, Git, source, tarball, development snapshot, and Desktop installation, plus upgrades, troubleshooting, and Session format migration.
- [Global binding guide](user-bindings.en.md) ([中文](user-bindings.md)): author, review, save, configure, and test reusable helpers.
- [Runtime Reference](runtime-reference.md): cell behavior, capability discovery, configuration, diagnostics, and limits.
- [Evaluation](evaluation.md): paired ordinary-task protocol, metrics, configuration, and limitations.

## Design

- [Architecture](architecture.md): ownership boundaries, prompt-prefix stability, runtime lifecycle, journals, and recovery.
- [Capability Surface](capability-projection.md): typed program bindings and progressive discovery.
- [Program Data Plane](program-data-plane.md): canonical values and result completeness.
- [Durable / Volatile Recovery](durability-design.md): replay model and external-input boundaries.
- [PTC Value Graph V1](value-wire.md): supported JavaScript value encoding.
- [Global User Bindings](adr/0023-global-user-bindings.md): persistent helper ownership, model projection, runtime activation, recovery, and Agent-assisted authoring.
- [Binding Review Placement](binding-review-placement-design.md): the implemented full draft panel above the current composer, using the published input dock and one review controller.
- [Logical Binding Identities](adr/0025-use-versioned-logical-binding-identities.md): stateful declarations, scope, candidate publication and language generations.
- [Stateful Binding Updates](stateful-binding-updates-proposal.md): target stateful-computation semantics and their acceptance boundaries.
- [Architecture Decisions](adr/): stable design constraints and their consequences.

## Maintenance

- [Deterministic Verification](verification.md): complete checks, backend test concurrency, coverage, and focused diagnostics.
- [Incremental Review Verdict](adr/0026-persist-the-delivery-verdict-against-the-verified-candidate.md): predeclared parallel lanes, dependency-scoped invalidation, and the composite commit verdict.
- [Focused Verification](verification-optimization-work.md): bounded coverage diagnostics and their relationship to the final verification gate.
- [Semantic Validation](semantic-validation.md): pinned Test262 cases, dialect contracts, native differential matrices and their limits.
- [Publishing](publishing.md): release checks, package contents, permissions, and platform validation.
- [GitHub Release Notes](release-notes.md): user-perspective priority order, required sections, bilingual style, and a worked example for release notes.
- [Client UI](client-ui.md): current UI boundary and reevaluation criteria.
