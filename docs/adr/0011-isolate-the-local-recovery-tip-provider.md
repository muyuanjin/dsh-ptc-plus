# Isolate the Local Recovery Tip Provider

## Problem

Recovery tips are a presentation policy, while PTC Plus owns the REPL, diagnostics, journal, and prompt-prefix contract. A future decision-table plugin may need session, project, model, vendor, platform, environment, tool, and output facts, but its public facts and decision interface is not yet stable.

## Decision

Keep the current deterministic recovery policy in `internal/recovery-tips.js` as a replaceable local provider. The provider consumes the immutable facts produced by `internal/session-log-view.js`; it does not traverse raw events, pair calls, parse journals, or query the core through callbacks. The core calls it for one bounded named tip, delivered as an independent PTC notice under [ADR 0010](0010-session-log-derived-recovery-tips.md). The provider does not change execution, journal semantics, tool schemas, or stable system text. Defer an external adapter until a public facts and decision contract exists; the adapter must be optional, fail closed, and leave the local provider or disabled mode available when absent.

## Alternatives considered

- **Embed a multi-scope decision table in PTC Plus now.** This would couple the REPL core to unowned project, model, vendor, and global policy semantics before their data and precedence contracts are defined.
- **Guess the external plugin API.** This would create an unstable cross-plugin dependency and make prompt behavior depend on an interface that cannot yet be verified.
- **Remove recovery tips until the external plugin is ready.** This would discard a bounded, tested recovery aid even though the core can provide it without changing its execution contract.
- **Pass the complete session log to each provider.** This would expose persistence mechanics as a policy API and let providers derive incompatible lifecycle facts. A projected fact model keeps event ownership in the REPL core and makes a future adapter narrower.

## Consequences

The local provider remains useful and independently testable, while the core has a clear replacement boundary for a future decision plugin. Until that plugin publishes a stable interface, integration remains an explicit TODO rather than an implicit dependency. Any future provider must consume the same projected lifecycle facts and preserve session-log reconstruction, bounded context injection, fatigue control, and stable tool/system prefixes.
