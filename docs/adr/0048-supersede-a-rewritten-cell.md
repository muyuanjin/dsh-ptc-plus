# Supersede a rewritten cell

## Status

Accepted (0.5.3).

## Problem

An accepted `edit_run_code` receipt schedules a derived execution: after the outer cell settles, the whole target source runs again in its revised form and is recorded as one more cell. The 0.5.2 fold treated both records as environment members, so "append" became the meaning: the edited cell kept building the environment and the revision stacked on top of it.

Appending is invisible in the common case, because the revision declares the same names and overwrites the old values. It leaves one state the plugin cannot state: a name the target declared and the revision no longer declares still exists in the environment, while no cell in the log declares it any more. The plugin then has no producible evidence for a name it reports to the model: the source no longer contains that declaration, and a restart removes it by a different rule.

## Decision

The edited cell and its revision are related by **supersession**, not by deletion.

- The log does not change: the edited cell and the revision both stay recorded, each with its own journal and source.
- The fold decides the environment: with `editRewritesHistory` on, the revision folds as an ordinary recorded cell and **takes the edited cell's place** — it continues from that cell's parent, and the cells recorded after the edited cell continue from the revision. The superseded cell keeps its node but leaves the head's parent path; the head stays the latest recorded cell.
- The relation does not depend on how the revision itself settled: a revision that settled volatile is installed from its recorded values and still replaces its target; a revision the fold contracts (its recorded values cannot be installed) is absent from the environment, and the relation the record states still holds, so the target's provable names are still reported as superseded. A contracted revision has no node to continue from, so its successors continue from the superseded cell's parent. A `discarded` settlement is no evidence that the revision ran, so it states no relation and keeps append semantics; a `noop` derived settlement never becomes a record and states none either.
- The relation is reconstructable from the log: the fold reports `supersessions` (`supersededCallSeq` / `supersedingCallSeq`) and `supersededBindings`, attached to the recovery result like `deletedBindings` and without changing the enumerable shape of §history.
- Reporting: one relation states `PTC-R007` once per runtime, naming which cell replaced which, together with the names the log can prove and the revision no longer supplies.
- Off by default. When it is off, the fold keeps 0.5.2's append semantics exactly, so neither existing cases nor the reading of earlier session logs changes.

## What it claims and what it refuses to claim

`supersededBindings` contains only names the log can prove: the `values` a volatile settlement recorded, `unrecordedBindings`, and `binding` save operations. A durable cell's declared names are not in its journal — replay produces them by executing the source — so the fold never guesses a name for the model, and `PTC-R007` states only the relation when there is no name to report.

The live worker and the durable fold keep their existing division of labour: the environment recovery replays is the environment the supersession applies to, while the live cache keeps the values it executed. This matches how `PTC-R005` (a recorded rewind ended these bindings) is handled: the record states the ending, the notice names it, and the live cache is not described as already emptied.

## Alternatives considered

- **Keep append semantics and report the leftover names as lost.** Rejected: the log does contain a cell that declared them, so "lost" would be false, and the model would be told to redeclare a name whose replacement it never saw.
- **Delete the superseded cell from the log.** Rejected: the session log is append-only evidence, and history replacement belongs to DSH. Supersession is a fold-time relation, and the record has to keep proving what happened.
- **Refuse the edit unless the revision redeclares every name the target declared.** Rejected: an accepted edit is the user's decision about the cell's source, and a revision that intentionally drops a name is legal JavaScript. Refusing it would make the transport decide the source.
- **Report the relation on every later fold instead of once per runtime.** Rejected: the relation is a durable fact of the log, not a per-cell event; repeating it on every recovery is noise the model cannot act on twice, and the names it withdraws are reported by their own diagnostics.
- **Adopt the relation for a `discarded` settlement too.** Rejected: a discarded settlement is not evidence that the revision ran, so claiming it replaced the target would state an execution the log denies.

## Consequences

- With the switch on, the set of cells in the environment no longer equals the set of cells in the log; the difference is the supersession relation, not a loss.
- Later cells read the revised value, and so do they after recovery.
- A session log written while the switch was off folds under the same relation once it is on, because the relation lives in the log rather than in the configuration.
- A runtime that supersedes a cell reports `PTC-R007` beside any restore notice the same recovery produces, and each consecutive recovery states the facts it replayed.

## Related

- ADR 0025 owns logical binding identity and language generations.
- [durability-design.md](../durability-design.md) §「日志折叠」 and §「恢复通知」 describe the fold order and the diagnostics.
