# Runtime Reference

## Cell Semantics

Each top-level `run_code` input is parsed as an async function body using modern JavaScript and erasable TypeScript syntax. Top-level bindings survive across cells, block scope and top-level `await` work normally, and only explicit `return` or printed values appear in the result. Static `import` and `export` declarations are adapted when their corresponding `auto*` options are enabled; named and default imports remain live, read-only bindings across later cells. Otherwise use dynamic `import()` or `require()` and omit module declarations.

The default loose binding mode lets a complete top-level `const` or `let` declarator replace existing names. New declarators create bindings. With `autoSplitRedeclarations` enabled, mixed new/existing destructuring is split while preserving its assignment semantics; disabling that option, function/class redeclaration, or any redeclaration in strict binding mode is rejected before execution.

Every capability namespace is leased to one cell. Captured `tools`, `capabilities`, `repl`, `code`, or member functions expire when that cell ends.

For PTC mode requests using the code-only direct-tool projection, PTC Plus presents two tools in stable order: `run_code` and `edit_run_code`. It recognizes the current Host's `tools:ptc-only` owner section and the preceding Host's `tools:code-only` alias, with the current section authoritative if both appear. The latter tool edits the most recent eligible cell visible when the edit call is dispatched, including a cell that completed successfully but needs a small adjustment. That target remains fixed while the call is in flight; later tool settlements cannot retarget it. The edit accepts exactly one atomic `edits` or `regex_edits` array and an optional `expected_target_call_seq` precondition. Invalid, unavailable, or mismatched-target edits return `{ edited: false, reason }` without executing source or consuming the target.

`edit_run_code` is a real registered tool call. Session history and later model requests retain its original name and delta arguments. The plugin executes the materialized source as a host-derived `run_code`, returns only the edit status, value, and logs to the model, and keeps the complete source plus journal in private replay metadata. It does not rewrite assistant history or emit edit-specific runtime context.

When a live parse error occurs exactly at the cell EOF, PTC Plus checks the three single-closing-token corrections `}`, `)`, and `]` with the same preparation context. If exactly one correction succeeds, the existing editor can express it from a bounded unique suffix, and the rejected call has a persistent event identity, `PTC-C001` includes a directly callable `edit_run_code({ edits: [...], expected_target_call_seq })` invocation. The guard must match the target captured when the edit call is persisted, so a later editable cell suppresses execution even when the same literal replacement would match it. The plugin does not apply or execute the correction automatically; ambiguous, broader, and unbound repairs keep the ordinary length-adaptive guidance.

Only values explicitly returned or printed appear in a cell result:

```ts
const records = [{ id: 1 }, { id: 2 }]
return records.map(record => record.id)
```

Parse, filter, and aggregate large results in the cell before returning them; oversized output is truncated by the host, so expose only what the next step needs.

Prefer executing work directly in the current cell; reserve `code.run` for source already held as data. When nested source must be written inline, escape quotes, backslashes, and newlines exactly — its parse errors point only at the generated text, not at a position in the outer cell.

## Capability Discovery

The default SDK keeps navigation compact. Use `capabilities.tree/find/inspect` when the required member is not already visible:

```ts
const matches = await capabilities.find('session')
return capabilities.inspect({
  symbols: matches.slice(0, 8).map(item => item.symbol),
  budget: 8,
})
```

Discovery covers current `tools` plus the advanced `repl` and `code` namespaces. It is read-only and does not grant authority. Calls still use the typed member declared by the capability owner. Use ordinary Node.js and current-cell `tools.*` directly; reserve isolated `code.run` for source already held as data.

For commands, prefer project-declared scripts and use an available typed tool. When direct host process access is more appropriate, inspect the executable that is actually installed and invoke it through Node.js `child_process`. Child processes inherit the recorded session cwd when `options.cwd` is omitted, while an explicit `cwd` remains authoritative; the worker preserves the host execution environment needed to resolve package runners and shells. Add a shell or package runner only when the command requires its syntax or resolution; do not assume a particular shell exists.

## Configuration

The configuration uses `ptc-plus` as the DSH plugin ID and `dsh-ptc-plus` as the package name. The distinction is intentional: the former is the runtime/settings identity, while the latter is the repository and npm package identity.

`enhancedToolView` defaults to `true` and controls only the browser presentation of `run_code` and `edit_run_code`. Turning it off unregisters PTC Plus's keyed tool views so DSH's native generic row renders the calls; turning it on restores the compatibility renderer without changing execution, prompt, or session behavior.

`autoDescribeRunCode` defaults to `true`. When the outer `run_code.description` is missing, the execution bridge derives the fixed summary only for local DSH validation, and presentation metadata alone persists that UI-only summary. The original call arguments, existing summaries, cell source, and nested native-tool JSON remain unchanged. Toggling the setting does not change the model-visible tool schema, tool order, or system sections: both states retain DSH's native required `description` declaration. When disabled, DSH continues to enforce the required outer field.

```yaml
- id: ptc-plus
  name: dsh-ptc-plus
  config:
    enabled: true
    enhancedToolView: true
    canonicalizeToolCalls: true
    autoDescribeRunCode: true
    looseTopLevelRedeclarations: true
    autoRewriteImports: true
    autoStripExports: true
    autoSplitRedeclarations: true
    durableReplay: true
    tipsEnabled: true
    cordisToolsEnabled: false
    computeMs: 60000
    maxWallMs: 600000
    maxOldGenerationSizeMb: 512
    maxNestedRunCodeDepth: 8
    maxOutputBytes: 67108864
    maxValueNodes: 100000
    maxValueEdges: 1000000
    maxValueArrayLength: 1000000
    maxValueBigIntDigits: 100000
    tipCooldownMessages: 3
    tipEscalationFailures: 2
```

`enabled: false` is the settings-based kill switch: the Host keeps only the settings namespace and client card, and removes every runtime hook, prompt section, and tool surface. Every setting is applied live when its owner can reconcile it. A submitted cell retains one configuration snapshot through preflight, execution, binding calls, completion validation, and diagnostics; an update accepted while it runs applies to cells submitted afterward. Node fixes a worker's V8 old-generation limit at creation, so changing `maxOldGenerationSizeMb` while a session worker is active is rejected and rolled back rather than reported as applied. Other non-`enabled` updates reconfigure existing owners without replacing session-bound bindings. The settings card is available under Settings → Plugin configuration, shows “已启用” or “已停用”, and disables every control except `enabled` while the plugin is off. If a live enable or reconfiguration cannot install a complete runtime, PTC Plus unwinds or restores every owner and persists the last applied settings; a failed compensating settings write is surfaced as an activation diagnostic. The TypeScript language check is deferred until runtime activation, so a non-TypeScript host can load the plugin in disabled mode but cannot enable it.

`cordisToolsEnabled: true` atomically mounts the official `@deepseek-ai/dsh-tool-cordis` plugin and exactly the shipped `cordis-plugin-development` companion Skill in PTC agent scopes. PTC Plus resolves the official `cordis` preset through DSH's public preset service, lets the maintained filesystem provider own its Skill root, and filters that provider at the public registration boundary so sibling Skills are never published to the PTC scope. It does not copy the Skill or switch the agent's preset. The first request waits until the Cordis tool fiber, owner guidance, exact Skill provider, and scoped Skill load are all ready. A missing or broken preset, Skill/tool service, declared Cordis service, inconsistent inspect manifest, or rejected activation fails the setting change and removes every provisional contribution. Disable and agent/runtime disposal remove both fibers. Native agents inherit neither the resulting `tools.*` members nor the Skill, and the code-only direct-tool projection remains `[run_code, edit_run_code]`. Agents whose `run_code` surface appears after creation are retried on the DSH tools-change signal. Cordis can evaluate model-written plugins against the live runtime, so enabling it grants shell-equivalent trust.

Keep large Cordis host or client source in a top-level binding before calling a Cordis tool. A parse or validation rejection is a runtime failure, so bindings assigned before it remain live for a short retry cell; reuse the binding instead of resending the source.

Cordis Plugins and Runs are process-local. On a resumed agent or after Cordis is re-enabled, normalized journal calls can restore their recorded return values but do not prove that prior IDs, approvals, Runs, or Inspect observations are live. The fixed `tools:ptc-plus-cordis-recovery` context remains present until a new successful `cordis_inspect*` call is settled. Use that live read-only inspection before a stateful Cordis decision; do not rerun a mutating historical call merely to rebuild state.

`durableReplay: false` starts new kernels without historical REPL state while preserving live bindings in the current process. It does not delete session logs.

Recovery tips are disabled with `tipsEnabled: false`. When enabled, a bounded runtime context in the reserved `tools:ptc-plus-tip/<trigger>/<ordinal>` name family may appear after a repeated binding failure or a diagnostic that identifies an executable, shell, or path problem in the current execution world. The trigger and per-trigger ordinal are reconstructed from canonical named system-prompt snapshots; repeated aggregate copies and visible wording do not advance the history. A tip is subject to `tipCooldownMessages` and becomes detailed only after `tipEscalationFailures` unresolved matches; it never changes the code-only direct-tool list or schema. `edit_run_code` does not emit a runtime context because its real call and result already carry the relevant fact.

The three `auto*` toggles control text-level AST rewriting applied before cell wrapping, all on by default:

- `autoRewriteImports` adapts static `import` declarations (`import x from 'm'`, named, namespace, side-effect, mixed, and type-only forms) through worker-preloaded module namespaces. Static and dynamic imports use Node's ESM resolver from the session cwd, or the worker process cwd when the session has no recorded cwd; relative project files, bare packages, conditional exports, URL imports, and import attributes retain Node semantics. Modules resolve in source order before the cell body is compiled, and a missing requested export fails during linking before that target module evaluates. Named and default aliases keep live reads and reject assignment; a later explicit loose-mode declaration may replace an alias for future cells while closures compiled earlier retain the import. Unsupported destructuring, loop, and delete writes are rejected before execution. Direct `eval` and `with` are unavailable while value import aliases are active because their dynamic name resolution cannot be preserved by alias rewriting; rejection occurs before module preload. Indirect or locally shadowed eval, `with` without active value aliases, and cells containing only type imports retain ordinary JavaScript behavior.
- `autoStripExports` strips top-level `export` modifiers: declarations survive without the keyword, `export default` becomes a local `__default` binding, re-exports become side-effect imports, and type-only exports are erased. A cell that separately declares the fixed public name `__default` and also has a default export is rejected before execution; a default function or class already named `__default` needs no alias.
- `autoSplitRedeclarations` allows a top-level destructuring declaration to mix existing and new names. The original pattern runs under native JavaScript initialization semantics, then existing names are committed and fresh names remain available to later cells.

Rewrites are recorded as `meta.dshPtcPlusRewrites` on the tool result (parallel to the journal, a closed schema). Successful rewrites do not emit runtime context. If the rewritten cell fails or has no valid journal, `tools:ptc-plus-rewrite-info` describes the recovery boundary in the next model request.

`require(...)` is classified exactly like a dynamic import: allowlisted builtins (`node:assert`, `node:buffer`, `node:querystring`, `node:string_decoder`, `node:stream`, `node:util`, `node:url`, `node:zlib`) stay durable, other modules are volatile, `node:worker_threads`/`node:cluster` are rejected before execution (`PTC-C002`), and non-literal arguments are dynamic module resolution.

## Diagnostics

| Code | Meaning | State effect |
| --- | --- | --- |
| `PTC-C001` | The cell cannot be parsed | Not executed; REPL unchanged; a uniquely validated and target-bound single-token EOF closure includes a directly callable declared `edit_run_code` repair; otherwise retry a short corrected cell with `run_code`, use edit for a localized long-cell correction, and resend with `run_code` for broad, ambiguous, or unbound repairs |
| `PTC-C002` | Preflight rejected a kernel-control import | Not executed; REPL unchanged |
| `PTC-N001` | Top-level binding conflict | Not executed; REPL unchanged |
| `PTC-O001` | Unsupported or over-budget output | Cell executed; earlier mutations may exist |
| `PTC-X001` | Uncaught runtime exception, located at the cell source line | Mutations before the throw may exist |
| `PTC-R002` | Cold recovery skipped volatile, unconfirmed, or replay-abandoned history | Restored the last reconstructable durable frontier |
| `PTC-W001` | The same cell failed 3 consecutive times with an identical binding error | One-shot binding-recovery warning appended to the failing cell's logs; no state change |
| `PTC-W002` | The same cell failed 3 consecutive times with another identical error | One-shot cause-specific warning appended to the failing cell's logs; no state change |

Durability describes how the session can recover after a kernel restart; it does not certify that a failed cell is side-effect-free or safe to execute again. A failing cell can mutate bindings or produce an external effect before the exception, so inspect the current state and retry only work whose execution status is known. Host tool calls from inside a cell restore the DSH initiator boundary, so tools that require the exact live calling agent (for example goal tracking) work through `tools.*`.

Known top-level native calls outside the declared direct surface may be normalized into `run_code` when the live schema proves the intended tool. The canonicalizer parses arguments once: ordinary JSON is embedded as JavaScript, while values with own `__proto__` keys use safe literals, so the derived cell needs no `JSON.parse` and keeps execution semantics. The normalization adds no provenance or correction text visible to the model. Unknown, malformed, or internally inconsistent calls remain on the DSH host diagnostic path. The two declared direct tools, `run_code` and `edit_run_code`, are never renamed by this recovery path.

Inside a cell, omitting the JavaScript argument of a native `tools` member is accepted only when DSH's live object schema validates `{}`. The worker canonicalizes that omission to `{}` before encoding, so dispatch, the durable call transcript, and cold replay observe the same arguments. This supports natural calls such as `tools.cordis_inspect_list()` without a tool-name exception. Passing `undefined` explicitly, omitting required input, or calling another program namespace retains its existing behavior.

## Limits

- The runtime is identified as `typescript`. Type annotations, interfaces, and type aliases are erased before executable JavaScript analysis. TypeScript syntax that requires JavaScript generation, including enums, namespaces, and parameter properties, remains unsupported; JSX and decorators are also rejected.
- `tools.read` is a bounded inspection window in the current DSH tool contract. Whole-file computation in `danger-full-access` should use `node:fs/promises.readFile` or streams and becomes `volatile`.
- Relative Node filesystem entry points, including `node:fs/promises` helpers and globbing, resolve from the recorded session cwd. Absolute paths and explicit filesystem options remain unchanged; sessions without a recorded cwd use the worker's native cwd and are classified as volatile when the access is ambient.
- The durable import allowlist is `node:assert`, `node:buffer`, `node:querystring`, `node:string_decoder`, `node:stream`, `node:url`, `node:util`, and `node:zlib`. Other Node imports remain usable but make the cell volatile.
- Direct `node:worker_threads` and `node:cluster` imports are rejected inside the worker. Calls to `process.exit`, `process.abort`, `process.kill`, and `process.chdir` are rejected through direct `process`, `require`, and dynamic or static `node:process` imports.
- Cold recovery replays journals from the session log; there are no compressed checkpoints or worker-LRU eviction.
- DSH services or plugin APIs not exposed as a native tool or owner-provided program binding are not made callable through name-based reflection.
