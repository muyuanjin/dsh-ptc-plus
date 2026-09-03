# Separate Host Bootstrap From Session Runtime

## Problem

PTC Plus needs to distinguish host-level work from the session-bound REPL. The
current entry point installs tool, prompt, worker, and journal behavior in an
agent/session scope. Moving that entry point earlier in the DSH composition
would make those owners global and could break binding, authority, and cleanup
boundaries.

An external reference, [DSH-EasyRewrite](https://github.com/Renzic-Stone/DSH-EasyRewrite),
shows a useful public extension pattern: a host entry point is mounted through
`cordis.patch.yml`, while a separate client entry point consumes browser slots
and session/workspace APIs. That project does not, however, intercept
`sessionPersistence` or migrate raw session artifacts before restore.

## Decision

Keep the existing PTC Plus entry point as the agent/session runtime owner. If a
host-level integration is needed later, add a narrow, separate bootstrap entry
point for host configuration, diagnostics, and an upstream-provided restore
preflight contract. The bootstrap must not create a second workspace/session
coordinator, duplicate DSH authority, or move worker and binding state out of
the session scope.

The plugin may consume a DSH public restore-preflight migrator or an atomic raw
artifact rewrite API when one exists. Until then, PTC Plus must not rewrite
files obtained from private storage paths or race the persistence provider's
append/flush queue. Legacy `ptc-plus/recovery-boundary` artifacts therefore
remain an explicit, startup-before-restore migration concern rather than a
runtime event handler concern.

The EasyRewrite host/client split is an architectural reference only; its
session and workspace UI APIs are not a persistence recovery mechanism.

## Alternatives considered

**Move the whole plugin earlier in the composition.** This would expose the
runtime before its required agent/session services and could turn isolated
workers, bindings, and hooks into shared state.

**Load a child plugin from the current entry point.** A Cordis child plugin is
loaded after its parent, so it cannot provide an earlier persistence hook.

**Rewrite raw artifacts directly from a host plugin.** DSH currently exposes
raw reads but not a public replacement operation. Direct path mutation depends
on private storage layout and can conflict with active persistence writes.

**Treat one failed session as a plugin-owned workspace failure.** DSH owns the
workspace registry and session lifecycle. PTC Plus must not replicate that
coordination layer; per-session load isolation belongs in the DSH persistence
contract.

## Consequences

The runtime remains correctly scoped and EasyRewrite's public host/client
assembly pattern remains available for future UI or host features. A plugin
update alone cannot repair an already-running DSH process that has failed while
loading legacy artifacts; the process must be stopped and the artifacts
migrated before restore. Existing valid sessions are unaffected by the
migration, while malformed legacy artifacts must remain unchanged and
diagnosable. This migration rule rejects an unsafe overwrite of the source
artifact; it does not authorize the session runtime to reject later valid cells
once DSH has supplied a loadable session. Runtime contraction follows
[ADR 0007](0007-separate-worker-transport-from-session-semantics.md).

The long-term upstream requirement is one of: a restore-preflight migration
hook, an atomic raw-artifact rewrite API, or a contract that isolates one bad
session from workspace registry initialization. None of these is emulated by
PTC Plus in the absence of a public DSH extension point.
