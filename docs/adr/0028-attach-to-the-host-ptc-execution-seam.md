# Attach To The Host's PTC Execution Seam Across Generations

## Problem

PTC Plus supplies the session-bound REPL by taking over the program-execution
seam DSH uses for `run_code`. DSH registers that seam as a Cordis service and
has renamed it between releases: a historical request-only generation published
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

`internal/execution-provider-owner.js` owns public provider composition;
`internal/execution-seam-compat.js` owns live selection and the request/spec
boundary. Selection uses the registered capability, not a version string.

**Composition owns the routing relationship.** The shipped bundle preserves the
original `ptc-runtime` row's module and configuration and gives its `ptcRuntime`
service a named isolation. A separate execution-provider row observes that
original entry through public Loader resolution and injection, then registers a
plugin-owned global provider through Cordis. The main plugin installs its
execution callback only in that provider's private entry. The original service
is never modified and may be frozen or sealed. Custom compositions configure
the original entry ID and matching isolation explicitly. Entry IDs resolve in the
provider row’s owning Loader tree, including the profile’s Include subtree;
they are not assumed to be root-tree IDs.

The execution-provider row remains present when the main plugin is disabled;
without a callback it delegates native execution and capability getters to the
original. Its stable adapter follows original-generation replacement, but a
resolved spec remains bound to the generation that produced it and cannot run
after that generation retires. Before bundle removal changes the original isolation,
the public Loader lifecycle withdraws only the plugin's provider registration
synchronously, leaving the global service slot available for the original to
return. Cleanup cannot retire a newer registration. A plain, uncomposed provider
is a deployment error, not a reason to fall back to descriptor mutation.

Activation reads the current original generation's language through the live seam.
The adapter's stable identity does not make its first language a permanent fact;
an unsupported or unavailable current generation cannot authorize activation.
The original-generation observer also notifies the installed controller after source
replacement. An incompatible language retires the active PTC runtime without changing
the user's enabled setting; returning to TypeScript reconciles it again. Descriptor,
resolve/run and upstream delegation entries reject an installed-language mismatch
while that cleanup is pending, so SDK preparation cannot describe a different
language from the callback's execution. A TypeScript replacement retains the existing
session runtime. The subscription and its disposer belong to the injected controller.

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

**New requests and resolved execution specs remain distinct.** The owner publishes `invokeUpstream`,
which reproduces each generation's own call shape — directly for
`run(request)`, and as `run(resolve(request))` for the two-step seam — and
`installExecute(execute)`, which owns only the plugin provider's private callback
and returns its disposer. The plugin's entry receives the complete input.
`runUpstream(spec)` delegates an already resolved spec directly to the original
provider, retaining its object identity, cwd, deadline, sandbox policy and future
execution fields. Non-session callers use this path without resolving again.
Fresh isolated requests still use `invokeUpstream(request)`. Session cells consume
their program, bindings and signal under the session's own execution contract;
the boundary never drops fields before choosing which consumer owns execution.

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
its install closure reads them, so withdrawing there is inert. These values are
derived getters on the plugin provider, not replacement descriptors on the
original. Releasing the private callback restores native delegation and its
original capability values without any write to the original service.

**The tool-result bridge has a separate accepted compatibility boundary.**
`internal/runtime-bridge-owner.js` retains its wrappers on the registered
`run_code` definition's `execute` and `output.presentationMeta`. The latter
publishes execution-local journal, recovery, binding and presentation evidence;
the former supplies derived execution arguments when an omitted description is
generated, while the persisted model-authored arguments remain unchanged.
This bounded use of a shared tool definition is accepted even though public
lookup does not guarantee mutation support. It requires those properties to be
redefinable: frozen definitions or outputs reject execution and are not a
supported compatibility claim. Frozen original execution providers remain
supported through the independent composition described above.

The bridge retains call-local settlement isolation, native canonical values,
output limits, original callback receivers, and descriptor/ownership restoration
on rollback or disposal. DSH continues to own validation, policy, approval,
cancellation and final result projection. Acceptance retains this bridge rather
than claiming that a public per-execution metadata carrier or raw/derived input
protocol has been implemented. Replacing it becomes necessary if an official
Host changes this dependency or publishes an equivalent result/input contract.
The direct-tool projection has its own accepted boundary in
[ADR 0005](0005-temporary-rejected-cell-edit-transport.md).

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

**Replace descriptors on the registered original.** Public service lookup does
not grant mutation ownership. Such attachment fails on frozen providers and
cannot establish a durable extension contract; it is not a compatibility fallback.

**Forward the resolved spec's directory, deadline, and policy to the session
kernel.** The kernel has its own directory, budgets, and journal semantics; a
per-call host deadline would have to be reconciled with the configured budget,
and confinement the plugin cannot enforce would be reported as if it applied.

**Accept a confinement request and report it without enforcement.** That is the
silent bypass this decision exists to prevent: DSH would stop offering the
escalation it thinks it is offering.

## Consequences

The frozen Host graphs exercise the `ptcRuntime` resolve/run shape. The
`codeRuntime` request-only shape is a historical compatibility branch with
fixture coverage, not a second frozen Host generation. The evidence boundary is
recorded in [Installation](../installation.md#compatibility-evidence).
Seam tests cover selection and input preservation for both shapes. Real public
Loader tests cover frozen originals, exact configuration and spec delegation,
main-plugin activation, source replacement and bundle removal. A host that registers neither
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
