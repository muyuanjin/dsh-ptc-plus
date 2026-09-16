# Run the session kernel in a killable helper process

## Problem

The session kernel previously executed user cells in a `node:worker_threads` worker owned by the DSH process. Reclaiming a stuck or unresponsive kernel required `worker.terminate()` inside that process; on Node 24 and 26 that teardown can reach an upstream cppgc finalizer defect (`node::contextify::ContextifyScript` or `ContextifyContext`) that writes through a destroyed `node::Realm`. Because the worker lived in the DSH process, the fault ended the whole process. The available Windows reproductions and stacks identify the defect on Node 24 and 26; the fix below does not depend on proving which other Node lines can reach it, so reclamation cannot rely on downgrading Node, retrying CI, or claiming that an in-host kill is safe.

## Decision

The session kernel runs inside a plugin-owned helper process that the host may kill without killing DSH. `internal/kernel-child.js` receives one `init` message over process IPC, creates the existing kernel worker with the supplied `workerData` and `resourceLimits`, keeps that worker's private `MessagePort` inside the helper, and relays only plain data in both directions. Kernel output reaches the host through the helper's own platform stdio pipes, so no output byte is duplicated into IPC messages or counted by two owners.

`internal/isolated-worker.js` exposes the worker-shaped transport that existing callers already use: `message`, `error`, `exit`, `close`, `stdout`, `stderr`, `postMessage` to the worker's parent port, and `terminate()`. The handshake exposes a process-local port adapter for the private kernel channel; the real `MessagePort` never crosses the process boundary. The transport records the real child exit immediately for stop deadlines, then publishes its worker-shaped `exit` event only after child `close` proves the platform output pipes drained; outward `exit` still precedes outward `close`. Every close has cutoffs anchored at its start: a release grace, a kill of the helper process, then a positive window for the real child exit. A shutdown acknowledgement proves that the helper released its own machinery, but it does not reclaim the instance.

`internal/isolated-worker.js` also owns every started transport until its real exit, cleanup, and output close. The kernel client, the workbench console, and the candidate runner each create one owner. `releaseAll()` frees current instances while the owner remains usable for reconfiguration; `dispose()` is terminal and refuses new starts. Reclamation failures remain visible to every aggregation and to later disposal instead of becoming unhandled rejections.

Caller and helper environment boundaries are explicit. Each creation site projects the host environment with `normalizeWorkerEnvironment`, which keeps the user-visible contract and strips host-only instrumentation such as `NODE_V8_COVERAGE`. `IsolatedWorker` snapshots that projected object before `child_process.fork`; the fork call may mutate its own env object by copying `NODE_V8_COVERAGE` into the helper, so the pre-fork snapshot is what `kernel-child.js` passes to `new Worker({ env: ... })`. The helper itself may retain the coverage variable, but the inner user Worker and the child processes it creates receive only the projected environment. An explicit transport/coverage test can opt into instrumentation to verify worker branches; production paths do not change the user environment to collect coverage.

The helper answers an on-demand utilization-sample request from its own loop, and `IsolatedWorker` exposes `sampleUtilization()`. `SessionCellExecutor` starts the wall bound at request submission, awaits that fresh baseline, then starts the compute interval before it posts the prepare or run frame, so work completed before submission is excluded while prepare blocking remains counted. The exception owned by [ADR 0024](0024-repl-console-observation.md) is a confirmed unfinished observation on the same worker: the executor may post prepare before starting budgets so the observation can finish, and the matching observation-completion/readiness acknowledgement starts them. A sample that times out, cannot be sent, disconnects, or exits is a bounded worker-exit failure: pending requests are cleared and no prepare/run frame is dispatched. The ready handshake still contributes an additional startup sample, but it is not the per-cell baseline and it does not reset or defer budgets.

## Alternatives considered

**Keep the worker in the DSH process and only improve cooperative shutdown.** Asking user code to release its own realms cannot bound a wedged kernel, and any fallback in-host kill reaches the same upstream teardown path that ends DSH.

**Kill the in-host worker through an inspector or another thread-level mechanism.** Those paths still tear down the same isolate and cppgc graph inside the DSH process, so they do not remove the host-fatal fault.

**Create a child process per cell instead of one long-lived helper per session.** This gives up continuous bindings and the existing private-channel protocol, and it turns every cell into a new process-startup and environment-reconstruction problem. It also expands the change into scheduling and process governance that DSH owns.

**Downgrade Node or retry the native crash in CI.** This leaves installed users on supported Node lines exposed and treats a reproducible host crash as a test flake.

**Move all user computation into a general child-process sandbox or permission layer.** That would replace DSH authority and sandbox decisions with a second system, which the project explicitly does not own.

## Consequences

A synchronously stuck kernel is reclaimed by killing a plugin-owned helper process; DSH survives and observes a real child exit, output close, and cleanup outcome. This containment removes the plugin's in-host kill path, but it does not repair, characterize, or claim the same cause for every upstream Node teardown path.

The transport gains one process and an IPC hop. Ports, shared memory, and transferred buffers cannot cross the process boundary, so they stay inside the helper or become plain data; output continues over the helper's stdio pipes. The helper's own `execArgv` is emptied so it does not inherit host startup arguments.

Environment provenance is now explicit in code: the user Worker receives the caller's projected environment, while coverage instrumentation stays on the helper side except in the explicit transport test. A reclamation refusal stays owned and observable instead of being reported as success or surfacing as an unhandled rejection.
