# 0043 Compose Capability and Context Policies

## Status

Accepted. Extends ADR 0038 and ADR 0040 for newly created environments.

## Context

A single full/on-demand/closed choice loses disclosure preferences when disabled, while a management switch also selects recovery and previews. Users need to compose those responsibilities without inheriting unrelated changes.

## Decision

Capability availability and disclosure are separate inputs. A `ptc-capability-policy/v1` policy contains `defaults`, `categories`, `mcpServers`, `items` and `allocation`. Rules contain independently optional `availability` (`enabled` or `closed`) and `disclosure` (`host`, `full`, `on-demand` or `adaptive`). Defaults contain both dimensions. Category, proven MCP server and item rules override defaults in that order, independently for each dimension. An MCP server closure is an enclosing removal and wins over child enablement without deleting child preferences. Ambiguous server ownership cannot establish closure. Nonempty unresolved item identities remain removable configuration inputs; only actual managed inventory can give them effect.

`host` retains the existing PTC owner-provided explanation path for available members. `full` supplies complete contracts, `on-demand` retains bounded discovery, and `adaptive` permits allocation. Only adaptive choices consume the independently selected `allocation.baseline`, `allocation.statistics` and `allocation.budget` inputs. No allocation closes a capability. Explicit full contracts remain complete even when over budget. The policy applies only when capability management is selected; it never replaces DSH authority or the PTC code-only direct-tool projection.

Statistics collection uses `capabilityStatistics.enabled`; consuming those observations uses `allocation.statistics`. Either may be selected independently, and read-only observation requires neither. Collection without management derives eligibility from the actual live public inventory, including Host additions and withdrawals, never an empty disabled plan. Allocation may consume retained valid observations after collection stops. Host disclosure is recorded as such, not relabeled as on-demand. Existing family settlement, admission, revision and workspace evidence rules continue to apply.

`capabilityRecoveryEnabled` independently selects bounded recovery of recently used, expanded, currently valid API explanations after compaction. It does not control necessary navigation, contract withdrawal or environment change notices. It never restores Skill bodies or changes binding provenance. `modelPreviewEnabled` independently selects the plugin's result and log presentation budget. Unselected presentation delegates to the Host, preserving any existing Host policy, canonical values and execution outcomes.

Fresh settings retain host disclosure and do not select statistics allocation, explanation recovery or plugin previews. Migration of an older saved configuration preserves its former choices, including adaptive disclosure and management-coupled recovery/previews. Named configurations store all these reusable inputs atomically, never observations or session state.

New sessions record `ptc-capability-environment/v3` and `ptc-capability-plan/v2`, including source settings, independent temporary overrides and effective derivation. Existing environment v1/v2 snapshots retain their original planner, rendering and coupled behavior; current defaults never reinterpret them. Saved settings do not change active sessions until explicit refresh. Dimension-specific session choices can remove only their saved dimension (`automatic`) or resume the frozen source (`inherit`); neither changes unrelated preferences. Existing combined commands retain their documented meaning.

## Alternatives considered

**Add more booleans around the combined choice.** Downstream switches cannot recover the disclosure preference that the combined representation discarded. Independent dimensions preserve that information at its owner.

**Split the feature into capability control and context optimization modes.** Each mode still bundles statistics, allocation, recovery and presentation. Structured responsibilities allow useful combinations without another mutually exclusive mode state.

**Reinterpret existing snapshots with current defaults.** That would change frozen environments and recovery semantics. A new recorded generation retains exact validation for historical plans.

## Consequences

The same rule resolver owns planner inputs, configuration inspection and all available-member consumers. Presentation may retain host contracts for one subset while using complete or on-demand contracts for others; shared owner instructions must remain wherever a retained member needs them. Operational inventory is required by selected management, collection or recovery, not by the presence of a policy generation. All unselected features and preview alone delegate the Host inventory lifecycle. In managed environments, Skill native eligibility remains recorded separately from effective invocation paths: removing the model loader preserves an independent user invocation. Resource contracts list only their available selected operations. Absence of every invocation path derives unavailability independently of management selection, without deleting preferences; it cannot establish statistics eligibility. Unselected policy closures never remove an actual Host path. Configuration controls expose dimensions and precedence rather than mutually exclusive feature modes. Combination support does not establish task quality or token savings.
