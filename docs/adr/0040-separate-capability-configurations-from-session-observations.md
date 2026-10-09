# 0040 Separate Capability Configurations From Session Observations

## Status

Accepted.

## Context

The settings must distinguish reusable user choices, actual statistical evidence and a session’s frozen effective environment. Configuration-only statistics and budgets cannot explain allocation, and a session-plan list alone cannot provide named portable configurations.

## Decision

Named capability configurations are reusable settings, separate from a session's frozen effective plan and from actual usage evidence. The `capabilityProfiles` setting contains a `ptc-capability-profiles/v1` document with a `profiles` array. Each entry has a unique `id`, a unique trimmed `name` of at most 80 characters, and a `configuration` containing only management enablement, manual baseline/overrides, statistics settings and context budgets. The library contains at most 100 entries. The runtime configuration owner validates the format and settings. It contains no session identity, usage observations, program values, messages, provider choices or credentials.

Saving under an existing name explicitly replaces that configuration. Renaming and deleting change the library only. File import validates before writing, assigns fresh identities and disambiguates duplicate names; it never switches the active settings. Export includes the selected configuration or the whole library. Import files are limited to 2 MB. The Client serializes these documents; users do not enter JSON.

Switching a configuration applies its complete capability settings through one public DSH settings mutation. The library itself does not enter capability configuration revisions, system text or model context. Existing sessions retain their frozen plans until an explicit Host-owned refresh. Inspection returns the recorded source settings alongside the effective plan so users can name and save a copy; copying excludes usage evidence and computation state. Settings containing invalid statistical parameters cannot become a reusable configuration until corrected, while runtime allocation retains its existing manual fallback.

The read-only `allocation` operation observes an explicitly selected active PTC session's current public capability inventory and workspace/global statistical coverage, then calls the existing pure capability planner with the settings being previewed. The observation context skips session preparation and binding loading. It does not freeze, publish or refresh a plan, register sample eligibility or use, load Skill bodies, execute capabilities or start model requests. A removed target or cancelled observation cannot publish a preview. Client replies are invalidated when target, settings, visibility or plugin state changes.

Statistics display actual uses and eligible session-family counts, with unavailable and incomplete evidence explicitly distinguished from zero use. Budget preview displays exact shared contract totals, allocation choices and reasons. Per-item body sizes exclude shared dependencies and rendered headings; the overall total includes them. Recovery and result-preview budgets cannot predict future content and are presented as limits, not fabricated forecasts.

## Alternatives considered

**Treat frozen session plans as reusable configurations.** A frozen plan includes inventory revisions and usage-derived choices that are specific to that session. Saving its source settings preserves user choices without presenting old evidence as current.

**Refresh or prepare a session to preview allocation.** Those operations publish model context and register eligibility. Read-only observation through the existing inventory and planner provides the preview without changing the session.

**Apply each configuration field separately.** Intermediate settings can form an unintended combination. One public settings mutation applies the complete configuration together.

## Consequences

Configuration libraries introduce a bounded validated settings format and explicit file import/export. Observation requires an active PTC session to supply its actual inventory and workspace; without one, the UI asks for a target rather than inventing statistics or allocation. Existing sessions still require explicit refresh after settings change.

## Evidence

The configuration, observation, Client lifecycle and browser contracts are exercised by `test/runtime-config.test.js`, `test/capability-environment.test.js`, `test/client-runtime.spec.js` and `scripts/client-fallback-smoke.mjs`. [ADR 0038](0038-freeze-session-capability-plans.md) continues to own freezing, statistics and explicit refresh semantics.
