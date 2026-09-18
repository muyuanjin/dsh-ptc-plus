# 0029 Keep Plugin Unavailability out of the Host Agent Lifecycle

Date: 2026-09-18

## Problem

PTC Plus publishes its optional companion tooling into agent scopes it does not own. DSH composes each scope, and a third-party profile may load this plugin while composing only part of DSH's native tool set, so a scope can expose `run_code` and still omit the Skill tool, the preset service, or the Skill service this plugin publishes through. DSH 0.1.6 announces `agent/created` through a serial dispatch whose contract is that a listener rejection rejects `agents.create()`; earlier releases dispatched that event in parallel and only logged the failure. A scope could therefore turn this plugin's own unavailability into a failed subagent creation for an unrelated plugin, and report the same diagnostic once per scope. The preceding owner deferred one surface only (`run_code`), so the same reachable condition still threw from a listener the host now awaits.

## Decision

An agent scope decides which surfaces it exposes, so an absent companion surface is not an error. `internal/cordis-tools-owner.js` keeps an agent whose scope omits `run_code`, the Skill tool, the `agentPresets` service, or the `skills` service pending, publishes nothing there, reports nothing, and retries the mount when the scope changes: on the DSH tools-change signal and on every later prompt assembly. The scope's composition belongs to the host and its user, a session creates many scopes, and an absent surface may appear later as a tool is registered or a service is provided.

A host-driven call never rejects for this plugin's own unavailability. `agent/created` and the prepended `system-prompt/assemble` waterfall install through one contained entry point: a scope whose exposed preset, services, publication, or child-fiber activation contradicts the DSH contract withdraws from that scope, reports one warning for that scope, and stops retrying it while the owner lives. Withdrawal does not hide a defect — it reports the scope in which the plugin could not serve, at the volume one diagnostic per scope produces.

Install-time enumeration keeps one disposition per scope and adds one outcome. A scope present at installation whose exposed surfaces contradict the contract rejects `ready`, so enabling the setting fails and rolls back instead of reporting success for a mount that never happened. A scope that merely omits a surface defers there exactly as it does later, because the missing member can still appear while the plugin is loaded, so `ready` resolves and the setting stays enabled. When every scope a host enumerates omits a surface, enabling the setting therefore publishes nothing and reports nothing: an absent surface is not a defect in this plugin, and one diagnostic per scope would repeat for every scope a session creates.

## Alternatives Considered

1. **Contain at the `agent/created` listener only and keep install-time throwing for an absent service or tool.** Rejected: the same precondition would then have two outcomes decided by when the agent appeared, and the absent surface is a per-scope fact rather than a host-level one. One disposition per scope keeps the judgment in the place that owns it.
2. **Treat every activation failure as a deferral.** Rejected: a scope whose exposed preset or services contradict the DSH contract is not repaired by a later tool registration, so retrying it would repeat a failing mount and its diagnostic every turn — the reporting volume the reported defect complains about.
3. **Let the host log the rejection, as releases before 0.1.6 did with a parallel dispatch.** Rejected: the current host awaits creation listeners, which makes this plugin's unavailability the failure of an operation another plugin requested. Depending on one dispatch mode would also break again on the next host change.
4. **Reject the agent and let the calling plugin decide what to do.** Rejected: the calling plugin enabled neither PTC mode nor its companion tooling, and cannot withdraw a contribution it does not own.
5. **Require every agent scope to expose the companion surfaces, and report the ones that do not.** Rejected: a whitelist composition is a supported host configuration, and PTC mode must remain usable in the scopes that do expose `run_code`.

## Consequences

A PTC agent scope that omits a companion surface keeps PTC mode and simply does not receive the official Cordis tool, owner guidance, or companion Skill; the plugin reports nothing and stays silent there, so the absence is observable through the missing model-visible surface rather than a repeated log line. `cordisToolsEnabled` therefore describes the scopes that expose every companion surface rather than every scope that exposes `run_code`; [ADR 0020](0020-optional-cordis-tools-in-ptc-mode.md) owns that setting and now states the same condition. Enabling the setting still fails and rolls back when a scope present at installation has the surfaces but cannot be mounted, so a broken host stays visible at the configuration change. Withdrawing from a created scope also stops the attempt, so an unusable scope inside a long session produces one warning rather than one per turn.
