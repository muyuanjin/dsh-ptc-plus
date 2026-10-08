# 0038 Keep Session Capability Plans Stable

## Status

Accepted and integrated through the public prompt and execution seams. Frozen plans, scoped execution projection, shared loaders, persistent family statistics, refresh, description recovery and result previews have focused executable evidence in the [public-interface coverage](../context-public-interface-coverage.md). This ADR does not claim demonstrated ordinary-task token savings; the [implementation plan](../context-optimization-plan.md) distinguishes deterministic implementation from paid task calibration.

## Problem

PTC Plus can improve continuous computation while increasing the context consumed to complete ordinary tasks. Retaining the full native SDK and adding discovery instructions does not itself provide progressive disclosure. Conversely, hiding descriptions without making capabilities discoverable can cause additional exploration or incorrect calls. Shorter individual requests therefore do not establish a useful optimization.

Capabilities also constitute the model's working environment. Redistributing them whenever statistics or saved settings change makes that environment unpredictable, even if each new distribution looks efficient in isolation. A capability advertised as removed must be absent from the supplied discovery and execution surfaces; a callable placeholder that rejects later does not establish that absence.

## Decision

The managed domain is the task capabilities that DSH and its other plugins expose to the model, including tools, Skills and MCP resources or resource templates where public owner surfaces permit consistent integration. JavaScript/TypeScript, Node, the REPL, PTC Plus's own public APIs and Global User Bindings remain outside this management domain. DSH retains authorization, policy, dispatch and lifecycle ownership. The plugin uses published public extensions of the current official Host and does not create a parallel dispatch registry or patch Host packages.

Capability management has a total switch, independent statistics settings and independent manual configuration. There is no separate automatic/manual/off mode state. An explicit per-capability full, on-demand or closed selection wins over statistics. Invalid, disabled or unusable statistics leave manual configuration and its editable baseline effective. Automatic selection can choose full or on-demand disclosure; it cannot close a capability. Turning management off removes this feature's contribution while retaining DSH's authority and PTC Plus's separately configured computation behavior.

Full disclosure supplies the complete owner-defined calling contract. For a Skill it supplies the full catalog description, while the instruction body still loads on use. On-demand capabilities remain discoverable through bounded navigation and search, with matching full contracts preferably returned in one interaction. Closing a capability consistently removes its descriptions, discovery entries and applicable runtime exposure, including REPL members. Public integration gaps cannot be relabeled as successful closure or filled with a second permission system.

Automatic allocation uses session-family coverage rather than raw call volume. A root session and all its descendant agents contribute at most one use of a given capability. The denominator includes only families in which that capability was actually available. A tool use is a real call admitted to DSH’s around-execution pipeline with a final canonical outcome, including failed calls and valid wrapper-provided outcomes. It does not prove that the registered body ran or that an external effect occurred. Calls without execution admission and explicit pre-dispatch cancellation or unknown-tool outcomes do not create uses. Description inspection and cold replay do not create uses. Each capability and statistical scope uses its most recent configurable N eligible families, without wall-clock decay. Workspace evidence is primary; user-global evidence is a cold-start reference when local evidence is insufficient. An editable initial common set supplies the baseline when useful statistical evidence is absent, without fabricating observations.

Allocation considers both coverage and contract length within a configurable explanation budget. The directory has its own bound; every long-tail name need not remain in the prompt. Explicit full disclosure overrides the explanation budget, with an observable overage rather than silent truncation or demotion. A budget overage does not establish that a request fits a model's physical context limit.

A session capability plan records the effective enablement and disclosure choices when the session begins. Statistics and saved configuration do not redistribute an existing session, including after restoration. A user-triggered slash command explicitly refreshes the session. Refresh synchronizes descriptions, discovery and runtime exposure and supplies a durable, model-visible notification consistent with what actually became effective. A UI receipt alone is insufficient. Refresh uses Host lifecycle boundaries and does not require a paid model request merely to execute the human command. A stored plan cannot preserve a capability that its Host owner has actually removed or forbidden.

The existing prefix contract remains in force: unchanged configuration, model route and native capability view produce byte-stable plugin system text and ordered tool schemas. Statistical observations and session-plan facts belong in source-backed, reconstructable session contexts; treating a different plan as a new exception to prefix stability is not permitted. Reducing the original native SDK requires an owner-compatible public composition path, not a duplicate catalog appended beneath the unchanged full SDK.

Plans use the initial v1 format and are assembled before the first model request. Through the public accepted-step batch, the initial plan precedes task-dependent messages when no task history has been committed, after the Host-owned protected system head. Bounded navigation uses concise purpose guidance for available capability categories, rather than copying per-capability descriptions or selecting long-tail entries by identity and fit. It depends on configuration and inventory rather than automatic membership. Explicit full contracts precede selected baseline contracts and other automatic additions, with stable identity ordering and shared dependencies supplied once. Statistical counters and source digests do not enter rendered text. This extends reusable prefixes across different tasks and preserves earlier groups when statistics change; it does not promise provider cache hits. Full owner descriptions belong in full disclosure or requested discovery, not in the category directory. Existing sessions remain frozen, refresh and recovery append after retained history. Recovery validates the single initial format, derived plan and exact rendered body.

After compaction, a separate bounded description-recovery operation may restore recently actually used, previously expanded and still-valid API descriptions. It deduplicates against the model-visible surface, does not redistribute the session plan and does not automatically restore Skill bodies. This is not authorization to add a default REPL state projection or weaken binding provenance requirements.

Large model-facing results and logs use bounded previews with retrieval of retained complete presentation content through existing Host facilities. Omission does not alter canonical program values or turn successful computation into failure, and retrieval does not rerun the original operation. Formatted retained text is not a substitute for canonical typed values.

The acceptance target is non-regressing quality and lower complete-task token consumption than native PTC with PTC Plus disabled on representative ordinary tasks. Accounting includes actual descendant agents, exploration, retries and all observable model requests, with cached input, uncached input and output reported separately. Missing usage remains unknown. Plugin-specific success, fewer prompt bytes and a higher cache-hit rate cannot substitute for this target.

## Alternatives considered

**Keep the full SDK and add more discovery guidance.** This preserves easy direct access, but adds an explanation path without removing the original context cost. Current discovery remains a useful implementation input; its existence is not evidence of progressive disclosure or savings.

**Make every capability on demand.** This minimizes the initial catalog but can force repeated discovery for common work. A bounded common set with manual overrides and measured coverage addresses both initial cost and later interaction cost.

**Continuously redistribute active sessions.** Reacting immediately to statistics or saved settings makes allocation current, but changes the environment beneath ongoing computation and harms prefix stability. New-session planning plus explicit refresh preserves predictability.

**Expose three mutually exclusive management modes.** Automatic, manual and off outcomes are already derived from the total switch, statistics and manual settings. Persisting another mode introduces redundant state and obscures the independent validity of manual configuration.

**Hide descriptions and reject later calls.** This leaves the execution environment inconsistent with the advertised absence and adds a policy layer that DSH already owns. Closure requires removal from the supplied surfaces.

**Rank raw calls globally with time decay.** Repeated calls and large agent families can dominate the ranking, project differences disappear, and an idle project loses its baseline without new evidence. Bounded family contributions, workspace-first scopes and eligible-family windows address those specific distortions; they do not claim to measure latent task demand without bias.

**Restore every expanded contract or Skill after compaction.** This can recreate the context growth that compaction removed. Budgeted recovery of actual recent API use retains useful instructions while leaving other descriptions and Skill bodies on demand.

**Lower execution-output limits to constrain prompts.** An execution or transport failure has different consequences from a presentation omission. Separate preview budgets preserve computation and retrieval semantics.

## Consequences

The model receives a more predictable environment and users can inspect and override allocation. Implementation must jointly prove presentation, discovery, execution, refresh and restoration behavior rather than treating prompt editing as sufficient. Skills, shared MCP loaders, scoped tool registrations and retained runtime references require explicit public-surface evidence before complete coverage can be claimed.

Statistics require durable identity, bounded family accounting and a usable fallback. The [component contracts](../capability-planning-components.md) define family settlement and capability revision handling; `/capabilities refresh` implements the explicit session transition, with evidence in the [public-interface coverage](../context-public-interface-coverage.md). Contract budgets and discovery can themselves affect observed usage, so calibration must measure quality and whole-task cost rather than optimize coverage scores alone. Default parameters still require ordinary-task calibration; no unmeasured numeric default is established by this ADR.
