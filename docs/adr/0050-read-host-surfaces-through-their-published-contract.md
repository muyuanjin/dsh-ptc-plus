# Read and write the host's surface only through the contract it publishes

## Status

Accepted (0.5.3).

## Problem

Three of this plugin's host interactions cross a boundary the plugin does not own, and each had settled on a proof that is really an assumption about one host implementation:

1. A transport-owning executor keeps the reserved `run_code` definition inside itself. Reading it by probing every zero-argument member identifies the surface by shape, but it *invokes* host code: an executor with `cancel()` and `flush()` had both called during prompt assembly, and an executor that publishes the definition through a reader taking an argument was judged "no executor" with no diagnostic, which silently removed every feature that needs execution.
2. A derived edit dispatched as one model batch is handed to a host that assigns the execution identity itself. The relation was proved by comparing the parent token the plugin holds with the token on the execution the host runs — a token the host mints for itself and the batch contract never carries, so the accepted edit was admitted as its own root, the nested result arrived without an execution journal, and the model read "failed after acceptance" while the revision never applied.
3. The user's editable `run_code` description and parameter texts were written onto the host's live definition by assignment. On a getter-only definition that write throws, so the text never reached the model and nothing reported it; on a writable one it survived disposal, leaving PTC Plus prose on a host object the plugin no longer owned.

## Decision

Each interaction names the fact the plugin owns and the fact the host owns, and proves the relation with the former:

- **Reading an executor.** Which member may be invoked is not a shape question. Prompt assembly asks an executor exactly one declaration reader — `describe([])`, which says which reserved names it owns — and then the plugin's three contracted definition readers, `requirePtcTransport`, `requireTransport` and `transport`. No other member of a host executor is ever called. A host that declares the reserved name in `describe()` and publishes no definition through those readers is reported as *declared but unreadable* (an operator warning) instead of being folded into "this host has no executor"; the answer is recorded per executor as a property of the executor, and the readers are asked again on a later assembly because a scope can mount their service afterwards.
- **A batch-dispatched derived execution.** The dispatch records the submission on the execution object the plugin built, before the host runs it. The relation is then proved by the call id the plugin chose (which the host matches its batch result back to) together with the derived source; the parent token and root call are compared only on the registry contract, where the host runs the very object the plugin built. A batch host's own identity is never required to reproduce a token it never received.
- **Writing the editable slots.** The plugin installs an owned property definition and records the descriptor it replaced, once per definition. Both the writable and the accessor-only shape therefore carry the delivered text; a definition whose slot cannot be replaced keeps all of its own text rather than half of the plugin's; and disposal restores the recorded descriptors, so the host's own model-facing definition is exactly what it published before the attachment.

## What this does not claim

- The reader names are the plugin's published contract with a transport-owning executor. A host that publishes the definition under another name is unreadable to this plugin until that name is added here — reported, not guessed at.
- Identifying a batch execution by its call id trusts the host to run the call it was given. The plugin already refuses a batch result that does not name the submitted id, so the alternative is refusing to relate the derived edit at all.
- Restoring a descriptor cannot succeed against a host that made the slot non-configurable after the plugin replaced it. That case keeps the last written text and is not reported as a host fault.

## Alternatives considered

- **Probe every zero-argument member, with a denylist of lifecycle names.** Rejected: the denylist is a list of words, not a property of the members actually invoked, so any executor with an unlisted side-effecting member is executed during assembly.
- **Infer the parent token from the batch payload.** Rejected: it requires the host to adopt a field the batch contract does not define, and a host that ignores it leaves the relation unprovable — the defect returns whenever the optional executor package is a different revision.
- **Assign the slot and swallow the failure.** Rejected: silently not delivering the text the user edited is worse than a documented limitation, and it is the failure this decision exists to remove.
- **Restore the slot by writing the host's old text back.** Rejected: a host that published an accessor keeps reading its own state, so writing text back leaves a data property where an accessor was, and the model-visible definition changes shape because the plugin was unloaded.

## Consequences

- Prompt assembly no longer invokes any host executor member beyond the declaration reader `describe([])` and the contracted definition readers, and a declared-but-unreadable transport is a visible operator warning rather than a set of features that quietly disappear.
- A derived edit settles as the root cell's derived execution on both dispatch contracts, so the deferred settlement, the pre-policy projection and the root cell's own durability decision are exercised on a batch host too.
- Disabling or unloading the plugin leaves the host's `run_code` definition with the text its owner published.
- `compat/channels.json` records every host package an install receives: a package outside the release train is pinned at the version the release's own dependency range resolves to, with that tarball's integrity, and a package the release neither publishes nor depends on is recorded as absent. A publish inside a declared range is therefore a recorded drift that the channel proof reports.

## Related

- ADR 0017 owns tracking the newest published host surface.
- ADR 0049 owns proving a settlement against the record it published.
- [docs/runtime-reference.md](../runtime-reference.md) describes the executor reader contract.
- [docs/installation.md](../installation.md) describes the channel manifest a consumer install is proved against.
