# Attach To The Host's PTC Execution Seam Across Generations

## Problem

PTC Plus supplies the session-bound REPL by taking over the program-execution
seam DSH uses for `run_code`. DSH registers that seam as a Cordis service and
has renamed it between releases: the preceding generation published
`ctx.codeRuntime` (`@deepseek-ai/dsh-code-runtime`) and the current one publishes
`ctx.ptcRuntime` (`@deepseek-ai/dsh-ptc-runtime`). A plugin that declares the
removed name as a required injection never applies on the current host. Cordis
does not fail such a plugin: the fiber stays pending, the plugin's entry points
are never registered, and `run_code` silently keeps executing in the host's own
runtime instead of the session REPL.

The current seam also differs in more than its name. It resolves a request before
running it (`resolve(request)` → `run(spec)`), it publishes provider descriptors
(`executionInstructions`, `sandboxMode`, `timeout`) that gate host inputs, and it
reports file-confinement facts on the result. Its provider resolves a file policy
for every request and refuses to run without one, so an override that merely
forwards a bare request to the wrapped provider fails, and an override that
accepts a confinement request it cannot enforce silently weakens DSH's policy.

## Decision

One owner attaches the plugin to the seam: `internal/execution-seam-compat.js`.
It selects the seam from the registered service, not from a version string, and
presents the same seam-neutral contract to the runtime bridge whatever the host
generation is.

**Selection is a live capability.** The plugin's static injection names only the
services both generations provide; the seam owner waits through `inject` for
whichever execution service the host registers, in a scope that also requires the
plugin's own services, and owns one live attachment at a time. When both are registered, the current
generation wins, including when it appears after a preceding-generation attachment.
That transition first disposes the legacy injected fiber and its complete effect
tree, then attaches in the current service's scope; cleanup from the retired scope
cannot clear the new owner. If that attach fails, the owner marks the current
service object unusable, re-arms the preceding-generation attachment
immediately, and reports the failure instead of leaving the plugin with no
execution seam; the failed object is never retried, while a replacement current
service supersedes the restored attachment. The preceding generation therefore
attaches only when the current one is absent or is the recorded unusable object.
Attachment runs in the injected scope, so
the plugin is unloaded when the host unregisters that service and reattaches when
it is registered again. A service that satisfies the name but not the contract
(`run` or `resolve` missing) follows the same path and is reported as a load
failure naming the service; when a preceding-generation attachment exists, the
report accompanies its restoration so `run_code` never silently returns to the
host provider.

**Execution is one neutral call shape.** The owner publishes `invokeUpstream`,
which reproduces each generation's own call shape — directly for
`run(request)`, and as `run(resolve(request))` for the two-step seam — and
`takeOver(execute)`, which replaces the single execution entry and restores the
exact descriptor it replaced. The plugin's entry receives exactly `program`,
`bindings`, and `signal`: the fields PTC Plus has always consumed. A resolved
spec's directory, deadline, and authority describe the provider whose execution
was replaced; they are neither forwarded to the session kernel nor re-derived.

**The seam describes the execution the plugin performs.** While the plugin owns
the seam it also answers the descriptors with its own behavior: no
`executionInstructions` from the wrapped provider (each cell reuses the session
kernel rather than starting a fresh process, and the plugin's own guidance is
delivered through the system prompt), and neither `timeout` nor `sandboxMode`,
because the REPL applies the session's configured budgets instead of a per-call
host deadline and performs no file confinement. DSH gates `timeoutMs`, file-policy
resolution, and sandbox escalation on those descriptors, so withholding them keeps
DSH's authority decisions with DSH instead of accepting an input the plugin would
then ignore. Withdrawal is unconditional rather than generation-conditional,
because the rule belongs to the plugin's execution rather than to a generation:
the preceding generation's contract defines none of these members and nothing in
its install closure reads them, so withdrawing there is inert, while a provider
that did publish them cannot outlive the takeover. Every takeover and every
withheld descriptor is released together, and a release leaves a descriptor that
another owner replaced in the meantime.

## Alternatives considered

**Compare a DSH version and branch on it.** A version is not the contract that
broke; the registered service is. A gate also misreports the deployments between
the two known releases and reopens the same failure at the next rename.

**Keep `ctx.codeRuntime` as a required injection and add `ptcRuntime` as a
second requirement.** Cordis injections are conjunctions, so the plugin would
require an execution service the current host no longer provides and stay pending
on it.

**Register both services from the plugin and translate between them.** The
plugin would publish a service it does not implement, making this a provider
rather than a consumer, and would have to model the wrapped provider's resolution
semantics for callers that never reach its REPL.

**Forward the resolved spec's directory, deadline, and policy to the session
kernel.** The kernel has its own directory, budgets, and journal semantics; a
per-call host deadline would have to be reconciled with the configured budget,
and confinement the plugin cannot enforce would be reported as if it applied.

**Accept a confinement request and report it without enforcement.** That is the
silent bypass this decision exists to prevent: DSH would stop offering the
escalation it thinks it is offering.

## Consequences

The plugin activates on both the current and the preceding host generation, and
one test owner covers the selection rules, the neutral call shape, the descriptor
takeover, and the release semantics for both. A host that registers neither
execution service cannot be served, and its activation settles with a bounded
diagnostic naming the missing seam — `no host execution seam (ptcRuntime or
codeRuntime) is registered` — after the attachment window instead of staying
pending: the host awaits loader settlement before it becomes usable, so an
unbounded wait would park every agent, native tool, and unrelated plugin rather
than failing this entry.

A current-generation service that fails to attach cannot leave the plugin
unattached while the preceding service is still registered: the preceding
attachment is restored and the failure is reported through the plugin's own
logger in addition to the injected fiber's activation result.

`run_code` on the current host no longer advertises a per-call deadline or file
sandbox, and DSH rejects those arguments with its own message instead of the
plugin silently ignoring them. Deployments that need confinement in `run_code`
therefore need a PTC execution environment other than this plugin's session
kernel; this is a real limitation of that environment and is reported as one.
