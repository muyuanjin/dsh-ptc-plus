# Track The Latest DSH Public Surface

## Problem

PTC Plus integrates with DSH services, request bindings, prompt assembly, session events, and CLI/profile installation through public extension surfaces. A literal compatibility version can become stale independently of those contracts, misrepresent newer releases as unsupported, and defer integration failures until maintainers manually update a label.

## Decision

The compatibility target is the latest available DSH release. Production behavior, configuration, tests, installation guidance, and current compatibility claims depend on public extension contracts and observed live schemas, never on a DSH version allowlist or comparison. An upstream default projection is not an extension ceiling: when public scoped registration and presentation support a plugin-owned capability, PTC Plus preserves that capability and its model-visible identity instead of deleting or renaming it to match the default. Deterministic normalization remains valid for a call that is outside the declared direct surface when the live schema proves one native target and the lowering preserves arguments, call identity, authority, and result semantics. Deterministic tests exercise the consumed contracts; model-backed and packaging acceptance runners use the installed DSH and record `dsh --version` in generated reports so failures remain attributable without turning the observed value into policy. Concrete DSH release numbers may appear only in source comments that identify historical integration or evaluation evidence and cannot influence execution or acceptance.

Preceding public contracts remain supported where capability detection is
unambiguous. Tools presentation is selected by the installed public schema;
Client contributions depend on their slots and supplied hooks rather than unused
package gates. Preset projection evidence takes precedence over the preceding
public session-summary field, and the current composer currency takes precedence
over the earlier session/interactions currency. This compatibility does not
extend to private stores or inferred binding state.

## Alternatives considered

**Pin one verified DSH release.** A pin makes one historical environment reproducible but turns normal upstream progress into an artificial incompatibility and allows the implementation to drift from the release users actually install.

**Maintain a supported-version range.** A range communicates broader intent, but semver cannot prove compatibility with evolving extension contracts. Maintaining the range duplicates evidence already produced by contract and end-to-end tests while still requiring every new release to be evaluated.

**Treat the upstream default tool projection as an immutable plugin limit.** This avoids scoped presentation work, but discards capabilities that the public registry supports and can force valid model calls through lossy aliases. Defaults describe the host's built-in product choice; public extension contracts define what a plugin may add. Invalid out-of-surface calls may still be normalized when their intended native target is provable.

**Silently accept any installed version without recording it.** This avoids a gate but weakens failure attribution and benchmark reproducibility. Recording the observed version in generated acceptance output preserves evidence without coupling behavior to it.

## Consequences

Each upstream DSH release becomes the immediate compatibility target and must pass the public-surface, packaging, and model-backed checks appropriate to the change. Users are not blocked by stale version metadata. Historical reports remain attributable through generated runtime metadata or source comments, while a passing older run never substitutes for validation against the latest release.
