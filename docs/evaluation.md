# Evaluation

## Host prerequisites

The model-backed runners support native Windows paths and WSL repositories mounted as `/mnt/<drive>/...`. They invoke the Windows DSH installation through `pwsh.exe`; the Windows process environment must resolve `dsh --version` and a drive-qualified `DSH_HOME` or user-profile `.dsh` directory. Native Linux and macOS DSH execution are not supported by these runners.

Both entrypoints validate path conversion, PowerShell startup, the installed DSH command, and the Windows DSH home before creating evaluation artifacts or installing the development plugin. A public Node preload runs a keyless real-worker probe before the DSH version command: it checks persistent bindings, syntax rejection, synchronous and awaited exceptions, and explicit return. The probe owns and cleans its worker scratch directory. A failure uses `PTC-EVAL-PREREQ` and prevents model work.

The actual `process.version`, `process.execPath`, DSH JavaScript entry, and observed release are recorded in manifests; subsequent DSH invocations use that exact Node executable and entry. Do not launch a probe through `npm exec node`, which can resolve a different runtime. The release is evidence, not a behavior selector or compatibility gate. Keep the selected installation and repository DSH dependencies current.

## Stable ordinary-task A/B fixture

`npm run test:ab` uses a versioned, zero-dependency Node.js fixture as the primary ordinary-task workload. The fixture lives in `fixtures/ab-node-project-v1` and is copied independently into each arm workspace. Both arms receive byte-identical working trees, the same deterministic Git history, and the same deterministic uncommitted dirty state prepared by the runner.

The fixture manifest, `fixtures/ab-node-project-v1/benchmark-manifest.json`, owns:

- `fixtureName` and `fixtureVersion`;
- a content SHA-256 over the fixture tree (excluding the manifest itself);
- the Git identity, commit message, and date used when materializing each arm;
- the deterministic dirty-state entries applied after the initial commit.

The current series is `ab-node-project-v1` / `1.0.0` with content SHA-256 `807580baf64e367bb2dc047c389edf471e13077d54d50ee4b3a143c38f0cebd1`. Reports written by the A/B runner record the fixture path, version, and hash.

Self-hosting acceptance against the active PTC Plus checkout is a separate track: `npm run test:expensive` covers plugin-specific model workflows and integration edges. Comparable ordinary-task reports are grouped only by the fixture version and content hash.

## Protocol

The paired run uses the latest installed DSH release, a configured model, PTC mode's code-only direct-tool projection, and `danger-full-access`. The A/B task set contains ordinary project tasks plus a cheap machine-checkable canary that directly invokes `run_code` once and exercises the transport first. After the canary pair passes, the remaining pairs run with the configured concurrency.

Resolved configurations are identical except for `ptc-plus.disabled`. Agent instructions, skills, auxiliary title generation, and local identity extensions are disabled. The model route, permission mode, neutral persona, injected initial context, fixture bytes, and resolved tool surface stay paired within each run.

The shared overlay selects `tools.mode: ptc` and explicitly projects `sandbox-policy.mode` and `approval.policy`. Before any model work, both runners validate the resolved tools row with the public `ToolRuntime.Config` schema from `@deepseek-ai/dsh-tools`, then check the selected evaluation policy. A successful config dump alone does not validate plugin settings; agreement with a runner-supplied expected string cannot bypass the Host schema. `CONFIG_ONLY` also performs this zero-model schema check. The runners do not rely on child-process environment variables to project these policies across the WSL-to-Windows execution boundary.

Each arm executes in an independently named, opaque scratch tree outside the evaluator artifact tree. Treatment names are confined to evaluator-owned records. Blind packets replace the session workspace in descriptions, source, results, and final answers, including Windows, forward-slash, and JSON-escaped spellings, before the arm map is written.

Machine budgets are per session and are enforced as failures. Machine evidence comes from exact tool-result JSON, workspace postconditions, or runner-owned subprocess results. Free-form final answers are never interpreted with prose or negation matching; their correctness remains `blind-pending` until the blind packet is reviewed. The transport canary separately requires the observed `run_code` result to equal the fixture package name, so workspace state alone cannot admit the paid matrix.

For `test-gate`, a successfully completed runner-owned subprocess is valid evidence whether the tested project exits zero or nonzero. The observed exit code is recorded, while blind semantic review decides whether the answer reports it correctly. Failure to start or complete the oracle remains a runner failure.

Acceptance metrics follow durable session-log semantics. `modelRequests` counts `step/start` events, each representing one logical model loop step. `headerEpochs` counts `request/header` events, while `headerChanges` counts the subset whose reason is `change`; initial and equal resume epochs remain distinct epochs without being changes. `historyReplacements` counts events whose `surfaceOp.op` is `replace`. Provider retries can issue multiple adapter attempts within one logical step, and the current durable log does not expose a complete physical-attempt count, so no report field infers one from headers, assistant messages, or usage.

Stable-header acceptance canonicalizes empty fields by DSH rules and compares the exact system value and ordered complete tool-schema JSON across every header epoch. Any unapproved change fails with the first differing field. `headerPolicy.allowedTransitions` names the exact epoch and route, configuration, or capability condition; `headerPolicy.historyReplacements` declares an exact replacement count and never permits header drift. Hashes remain diagnostic report data rather than the correctness test.

The shared Host contract recognizes `series` as an unchanged request header beginning a distinct message series, not a new schema or an inferred provider call. Usage evidence supports both historical standalone `assistant/chunk` events and compact streams in `assistant/message` or `assistant/attempt`. An embedded stream's last usage agrees with its message's accounting; formally linked duplicate storage is counted once, conflicting evidence fails, and reported usage from attempts without a surface message remains part of quota consumption. Logical steps, header epochs and physical attempts remain distinct. Missing usage is not a zero-cost claim.

Runtime-context audits track the binding catalog independently of recovery snapshots. They detect unchanged binding text repeated inside an otherwise changed snapshot, while allowing one reassertion after a formal surface replacement removed its evidence. Model-authored ambient declarations are not plugin catalog injections.

### Focused Program Work

The typed program-surface descriptor owns `expect.programWork`: `inspectionSymbols` limits schema expansion, and each `callLimits` entry declares a namespace/member's `maxCalls` and optional `maxCallsPerArguments`. Counts include unsuccessful calls. The fixed fixture is immutable during this task, so its native read is limited to one observation; the parent passes the observed marker into the isolated child as source data. Tree retrieval is limited to one, and find/inspect counts are bounded without requiring one exact source or cell sequence.

The shared trajectory collector validates the journal and decodes nested arguments as `args` for in-memory use. JSON reports preserve `argsWire`, a canonical PTC Value Graph that retains undefined, omitted object properties, explicit null, bigint, and cycles. Auditing decodes this evidence and uses structured equality, independent of source spelling or object-key order; missing or corrupt evidence fails. `programWork.observations` reports call counts and `repeatedArgumentCalls` separately from `machineMetrics.repeatedSourceCalls`. A workload needing fresh observations must explicitly allow its counts; these limits never suppress runtime calls or establish effect idempotence.

### Guarded Edit Acceptance

Every edit is validated by the canonical editor against the target reconstructed at dispatch from the session log. Both literal and regex deltas accept an optional valid `expected_target_call_seq`; successful edits must preserve the captured target and the editor's exact derived source and description. Scenario-specific literal deltas and source privacy remain separately checked by `editTransports`.

`expect.guardMismatchEdits` lists the one-based edit ordinals intentionally targeting a different call. Such an edit passes only with the structured `{ edited: false, reason }` result and no journal or derived execution metadata. Other edits still require their execution journal. Deterministic tests execute diagnostic-generated EOF closures and reject stale guards through the existing Host tool pipeline; the default paid cohort stays at five workflows.

## Reporting

### Binding Workflow

`scripts/binding-workflow-scenario.json` owns the constant-helper authoring, user save, and availability scenario. `scripts/binding-files-workflow-scenario.json` separately covers a file helper with write/delete capabilities and a pre-existing directory and sentinel. `test/binding-workflow.test.js` runs both through public CommandRuntime, AgentLoop, ToolRuntime, Session, and prompt assembly with a deterministic adapter. It checks saving, availability observation, preservation of pre-existing content, and rejection of write/delete probes. The constant workflow also checks ordinary history, stable system/tools, and restart. These fixtures prove the Host and audit contracts, not stochastic model behavior or provider cache gains.

The packed Client can also be checked in a real isolated DSH Web profile without model requests:

```sh
npm run test:client:web -- --dsh-entry <installed-dsh-cli-js> --binding-workflow
```

Use `--browser-channel <channel>` when testing with an installed Chromium browser. The local adapter drives public command and tool execution; Playwright saves and discards drafts through the UI, checks English and Chinese lifecycle labels, refreshes saved source, and measures settled desktop and narrow layouts including dark mode. Screenshots and measurements are written to `artifacts/client-web-smoke`; the temporary Host and home are cleaned up. `npm run test:client:layout` separately checks focused card, list, and REPL-tab geometry.

For an explicitly authorized model check, use an isolated DSH home and workspace with the selected provider, model, and credential-variable configuration. Run the keyless worker probe with the same resolved Node executable before starting DSH. First send an ordinary message, then run the scenario command, review the generated source, choose Save and enable in the command card, and send its status question. Export that session log for `auditBindingWorkflow(events, scenario)` in `scripts/acceptance-contract.mjs`; `inspectLog` accepts the same descriptor as `expect.bindingWorkflow`. This interactive workflow remains separate from the five default paid scenarios because the headless single-task runner cannot perform the user save action.

The audit owns completeness: matching command and successful admission, accepted candidate and its successful SDK transcript, a formally linked save before the exact status question, settled calls, and a completed answer must all exist. Results distinguish `incomplete`, `unproved`, and `machine-passed`; all nonpassing results include failures. Final prose always retains `semantic-review-required` and must be checked against actual model-visible facts.

The oracle rejects routine host/storage scanning and checkpoint reflection. `constantExports` optionally proves only nullary synchronous exports returning declared primitive literals, from the exact accepted source, save relation, and the status cell's validated active snapshot and journal fingerprint. A bounded AST proof tracks local values and only marks catch unreachable after proving its try body cannot throw. Unsupported syntax, object coercion, source mismatch, and shadowing remain insufficient evidence; a name allowlist cannot authorize calls. Export metadata alone does not prove a runtime value's type. Reports distinguish `recorded-dispatch`, `potential-source`, and `unreachable-source`; neither potential source nor insufficient evidence claims an effect happened. The next real user message ends the status scope. These rules belong solely to acceptance, not runtime permission or interception.

An effectful follow-up test needs separate task authorization. Its fixture must acquire an exclusive temporary directory with the platform primitive, preserve any pre-existing same-name directory and unrelated sentinel, and clean only its owned directory. For a status-only workflow any write/delete test is a failure, regardless of cleanup success. Historical logs can be audited offline; stochastic model quality and cache improvements remain unmeasured until an explicitly configured model run is performed.

Both runners require an explicit model route and credential-variable name before any host probing or artifact creation. The referenced credential variable must also contain a value:

```sh
DSH_PTC_ACCEPTANCE_PROVIDER=<provider> \
DSH_PTC_ACCEPTANCE_MODEL=<model> \
DSH_PTC_ACCEPTANCE_API_KEY_ENV=PROVIDER_API_KEY \
PROVIDER_API_KEY=<credential> \
npm run test:expensive

DSH_PTC_AB_PROVIDER=<provider> \
DSH_PTC_AB_MODEL=<model> \
DSH_PTC_AB_API_KEY_ENV=PROVIDER_API_KEY \
PROVIDER_API_KEY=<credential> \
npm run test:ab
```

`npm run test:ab` writes `report.json`, `report.md`, per-session trajectory artifacts, and blind-review packets under `artifacts/ab-trajectories/`. Both commands invoke the configured model and consume quota.

Token traffic is the sum of input, cache-read, cache-write, and output tokens. Model behavior is stochastic, so comparable new results establish a reproducible observation rather than a universal performance claim.
