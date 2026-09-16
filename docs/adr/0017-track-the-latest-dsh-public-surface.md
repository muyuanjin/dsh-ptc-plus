# Track The Latest DSH Public Surface

## Problem

PTC Plus integrates with DSH services, request bindings, prompt assembly, session events, and CLI/profile installation through public extension surfaces. A literal compatibility version can become stale independently of those contracts, misrepresent newer releases as unsupported, and defer integration failures until maintainers manually update a label.

## Decision

PTC Plus must remain independently installable on unmodified official DSH distributions. Host source is read-only research evidence, not an implementation workspace for plugin features. Plugin changes must not patch host source or installed packages, introduce install-time host patches, or require a custom host build. Plugin-owned components, panels, styling, portals and public renderer replacements are valid UI choices within the consumed contracts; integration does not require every visual element or layout to be native. A locally invented extension declaration is not a published public capability. Choose among published surfaces according to the required user experience rather than assuming that a UI feature must become a historical message node. If none can satisfy the required behavior, record the actual limitation; do not substitute a custom distribution or present a compatibility fallback as delivery.

The compatibility target is the latest available DSH release. Production behavior, configuration, tests, installation guidance, and current compatibility claims depend on public extension contracts and observed live schemas, never on a DSH version allowlist or comparison. An upstream default projection is not an extension ceiling: when public scoped registration and presentation support a plugin-owned capability, PTC Plus preserves that capability and its model-visible identity instead of deleting or renaming it to match the default. Deterministic normalization remains valid for a call that is outside the declared direct surface when the live schema proves one native target and the lowering preserves arguments, call identity, authority, and result semantics. Deterministic tests exercise the consumed contracts; model-backed and packaging acceptance runners use the installed DSH and record `dsh --version` in generated reports so failures remain attributable without turning the observed value into policy. Concrete DSH release numbers may appear only in source comments that identify historical integration or evaluation evidence and cannot influence execution or acceptance.

Preceding public contracts remain supported where capability detection is
unambiguous. Tools presentation is selected by the installed public schema;
Client contributions depend on their slots and supplied hooks rather than unused
package gates. Preset projection evidence takes precedence over the preceding
public session-summary field, and the current composer currency takes precedence
over the earlier session/interactions currency. This compatibility does not
extend to private stores or inferred binding state.

Compatibility decisions have one owner per public contract and execution
environment. `src/client-host-compat.js` owns Client preset reads and subscriptions
and composer compatibility. UI consumers own feature eligibility and slot
registration. `scripts/dsh-host-contract.mjs` owns selected-installation package
resolution, tools presentation and persona field adaptation for development and
acceptance commands. Host runtime contracts remain in their existing focused
owners, including `internal/session-events.js`, `internal/settings-compat.js`, and
`internal/execution-seam-compat.js`, which owns which program-execution service the
plugin attaches to and the call shape and provider descriptors it presents for it
([ADR 0028](0028-attach-to-the-host-ptc-execution-seam.md)).
`internal/host-rpc.js` owns UI Remote service registration and withdrawal;
`src/client-rpc.js` owns Client mounting and result unwrapping. Both consume the
executable wire definitions in `internal/rpc-contract.js`. Binding and observation
owners supply operation handlers and retain their domain validation. Consumers
use these operations instead of repeating transport or field-generation checks.
Adapters preserve unknown evidence and public subscription disposal; they do not
cache session capabilities globally. Test-only persistence fixtures and explicit
offline journal migration retain their own lifecycles and validation contracts.

## UI communication

Plugin UI calls use DSH's public Typert Remote and Gateway over the existing
`/api` carrier. The shared contract defines `ptcPlusBindings.invoke` and
`ptcPlusRepl.invoke`, each with an operation string, JSON payload, optional
cancellation signal and the domain result envelope. The Client unwraps only the
Gateway result layer. The Host owns authentication, origin checks, transport
cancellation and dispatch; a connection identity does not confer a draft locator.

The communication owner contributes one package definition containing the active
services. Disabling Global User Bindings withdraws its service and invocation;
REPL observation has its own eligibility checks. Service removal aborts pending
calls and invalidates retained references. Provider replacement cancels the old
requests and republishes active definitions through Cordis injection. Client
Remote mounting belongs to its calling fiber and is released with that fiber.
Writes are never retried by the adapter. Business owners preserve revision,
capability, storage and observation rules independently of transport.

## Alternatives considered

**Pin one verified DSH release.** A pin makes one historical environment reproducible but turns normal upstream progress into an artificial incompatibility and allows the implementation to drift from the release users actually install.

**Maintain a supported-version range.** A range communicates broader intent, but semver cannot prove compatibility with evolving extension contracts. Maintaining the range duplicates evidence already produced by contract and end-to-end tests while still requiring every new release to be evaluated.

**Treat the upstream default tool projection as an immutable plugin limit.** This avoids scoped presentation work, but discards capabilities that the public registry supports and can force valid model calls through lossy aliases. Defaults describe the host's built-in product choice; public extension contracts define what a plugin may add. Invalid out-of-surface calls may still be normalized when their intended native target is provable.

**Silently accept any installed version without recording it.** This avoids a gate but weakens failure attribution and benchmark reproducibility. Recording the observed version in generated acceptance output preserves evidence without coupling behavior to it.

## Consequences

Feature completion requires evidence from the actual packaged plugin running on the selected unmodified Host, including the affected user flow. Component fixtures and public-interface unit tests validate narrower properties; they do not prove that a required renderer exists or is loaded in that distribution. A clean code review and passing deterministic checks are separate from product acceptance. Both must cover the final change before a feature is described as delivered; commit and publish authorization remain separate user decisions.

Each upstream DSH release becomes the immediate compatibility target and must pass the public-surface, packaging, and model-backed checks appropriate to the change. Users are not blocked by stale version metadata. Historical reports remain attributable through generated runtime metadata or source comments, while a passing older run never substitutes for validation against the latest release.
