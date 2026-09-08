<p align="center">
  <img src="assets/dsh-ptc-plus-banner-en.webp" width="100%" alt="dsh-ptc-plus banner">
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <strong>English</strong>
</p>

<p align="center">
  <a href="#what-default-ptc-mode-gets-wrong">Problems</a> ·
  <a href="#three-scenes-that-matter-most">Scenes</a> ·
  <a href="#settings">Settings</a> ·
  <a href="#scope">Scope</a> ·
  <a href="#install">Install</a> ·
  <a href="#documentation">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness PTC mode" src="https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb"></a>
  <a href="package.json"><img alt="Node.js ^22.19.0 || >=24.0.0" src="https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-5fa04e?logo=nodedotjs&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/dsh-ptc-plus"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-ptc-plus?logo=npm"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

---

**PTC Plus gives DSH PTC mode a session-bound persistent TypeScript REPL.** Every `run_code` continues in the same session. Variables, imports, and results from one `run_code` are still available in the next one.

> [!NOTE]
> Community plugin, no affiliation with or endorsement from DeepSeek or DSH.

> [!IMPORTANT]
> Built for `danger-full-access`: direct Node.js and OS access with no extra sandbox. Use it only where that permission scope is acceptable.

![PTC Plus settings card](assets/ptc-plus-settings-en.png)

*The settings card exposes live configuration and the `enabled` kill switch.*

## What default PTC mode gets wrong

DSH PTC mode starts every `run_code` in a fresh environment. The model computes something, then has to send the same setup code again. One bad line means the whole thing is resent. This plugin attaches `run_code` to a session-backed environment, so later calls reuse what was already there.

| Situation | Default PTC mode | With PTC Plus |
| --- | --- | --- |
| State | starts from zero, setup resent ❌ | previous `run_code` results stay ✅ |
| Fixing | wrong result resends the code ❌ | one diff ✅ |
| Modules | `import` / `export` cannot be written ❌ | written normally, AST handles it ✅ |
| Values | JSON changes or loses special values ❌ | those values stay intact ✅ |
| Restart | everything is lost ❌ | recoverable parts come back ✅ |
| Output and errors | printing floods, errors point elsewhere ❌ | output trimmed, errors map to your line ✅ |
| Tools | list invisible, miscalls fail ❌ | can inspect; known miscalls become `run_code` ✅ |
| Paths | relative paths can drift ❌ | session remembers the project directory ✅ |
| Agent tools | tools needing the agent are rejected ❌ | context restored, goal works ✅ |

## Three scenes that matter most

### State carries over

First `run_code`:

```ts
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

The next one keeps going:

```ts
return deps.map(dep => dep + '@' + manifest.dependencies[dep])
```

`deps` and `manifest` are still there. The setup code is sent only once.

### Fix without resending

By default, a wrong result or a failure sends the whole code block again.

With PTC Plus, it sends one line:

```ts
edit_run_code({ edits: [{ old_string: 'deps.length', new_string: 'deps' }] })
```

The model submits only delta arguments. The plugin materializes and executes the complete cell in the Host, retaining its full source in private recovery metadata without sending it back to the model in the tool result body. Exact replacements and regular expressions both have limits, so a bad pattern cannot hang.

When a rejected cell has exactly one validated missing closing token at the end, its diagnostic includes the complete `edit_run_code(...)` call without requiring a separate recovery context. Validation proves syntax and preflight acceptance; the correction still needs to match the task's intent, and edit executes the complete cell. The generated call carries an `expected_target_call_seq` precondition, so it is rejected without execution if another cell becomes the edit target first. PTC Plus never applies the suggestion automatically; ambiguous repairs or repairs without a persistent target identity still require corrected source.

### Module syntax

DSH PTC mode executes each `run_code` as an async function body, where static `import` and `export` declarations are invalid. PTC Plus adapts those forms before execution with AST analysis.

The model writes normally:

```ts
import { readFile } from 'node:fs/promises'
```

Imports resolve from your project, and named/default imports stay live and read-only. After module syntax adaptation, the cell still executes as an async function body, supports top-level `await`, and exposes results through explicit `return` or printed values.

## One measured A/B

One identity-blind paired run used `opencode-go/deepseek-v4-flash`. Both arms used the same versioned fixture, task prompts, permissions, and two replicates per task, so 18 sessions per arm.

| Across all 9 tasks | PTC Plus | DSH PTC mode (PTC Plus disabled) | Observed change |
| --- | ---: | ---: | ---: |
| Model requests | 66 | 88 | 25.0% fewer |
| Tool calls | 50 | 79 | 36.7% fewer |
| Token traffic | 729,642 | 942,901 | 22.6% fewer |
| Identity-blind rubric score | 138 / 162 | 118 / 162 | +12.3 percentage points |

The module-syntax task separated the two arms most clearly. PTC Plus finished both replicates with one `run_code` each. DSH PTC mode without PTC Plus satisfied neither static-import requirement and used eight tool calls in total.

This is one stochastic paired observation, not a performance guarantee. Machine budgets were exceeded in 2 of the 18 PTC Plus sessions and 5 of the 18 sessions without PTC Plus, so the matrix as a whole did not pass machine acceptance. Token traffic includes input, cache-read, cache-write, and output tokens. The fixture, pairing rules, metrics, and blind-review protocol are documented in [Evaluation](docs/evaluation.md).

![Rejected run_code and the follow-up edit_run_code repair](assets/ptc-plus-repair-en.png)

*A real session: the `edit_run_code` call carries only the repair delta, which the plugin uses to execute the complete cell.*

## Settings

Open **Settings → Plugin configuration** to use the card shown above. The card follows the DSH UI language: it renders in English when the harness is set to English, and in Chinese when set to Chinese. The `enabled` switch is live: turning it off stops the runtime, keeps the card and that switch, and withdraws earlier PTC state declarations at the next Host-permitted request. Turning it on restores the session runtime and `run_code`/`edit_run_code`.

The plugin switch appears first, followed by settings grouped by purpose: Tool call tolerance, REPL syntax, State and recovery, Tool extensions, Interface display, and Resource limits. Execution without a summary and top-level tool call repair belong to Tool call tolerance; redeclarations and module syntax belong to REPL syntax. Recovery tips, their interval, and their threshold appear together under State and recovery. Global bindings and official Cordis tools belong to Tool extensions, with the binding management action directly below the global bindings switch.

“Use enhanced PTC Plus tool cards” is on by default and provides expandable source, results, execution state, and feature markers. When disabled, `run_code` and `edit_run_code` use DSH's native tool cards. This setting affects presentation only.

“Allow `run_code` execution without a summary” is on by default. Code still executes when the model omits the outer `description`; with enhanced tool cards enabled, the UI shows a fallback summary. When this setting is disabled, DSH validates the field normally. This setting does not change model requests or original call arguments.

“Allow top-level function/class redeclarations” is independent from the variable-redeclaration switch and defaults to on. A later cell can use an ordinary named `function` or `class` declaration to replace an existing writable binding. Replacement takes effect at the declaration position and does not emulate function hoisting. Imports, immutable `const` bindings, reserved names, and bindings with unknown provenance are still rejected before execution. Disabling the setting rejects top-level function and class redeclarations before execution. Live changes affect subsequently submitted cells; cold recovery always uses the policy recorded for each cell.

“Global User Bindings” is off by default. When enabled, the Settings card's “Manage global bindings” button opens a large in-app modal sharing the complete workbench with the REPL tab's global bindings section. Management works without a current PTC session. The workbench can create, import, validate, save, enable, disable, remove and execute TypeScript helpers with named exports. The interface declaration appears first; implementation source is collapsed and read-only with syntax highlighting. Edit enables changes to source and entry configuration. Entries are written atomically to `$DSH_HOME/ptc-plus/bindings.json`, and a changed revision rejects an overwrite. The exports field can explicitly limit exposed symbols; leaving it blank derives them again from the current source. `namespace` scope injects an object under the entry name; `top-level` scope injects selected exports directly. Activation conflicts are rejected before a write.

In read-only mode, Reload synchronizes the selected source, declaration and save revision; a deleted entry clears the editor. During editing, Reload retains unsaved source and fields while updating the save revision and the baseline restored by Cancel. Review the draft and click Save again to retry; reload never submits it automatically. A catalog change during the read requires another reload. Namespace and selected export names must be exact valid identifiers, including supported Unicode names, without added whitespace, comments or escaped spellings.

The Code console runs the current entry's unsaved draft: enter `readText("./example.txt")` to inspect its result, or use declarations and top-level `await`. Later commands can reuse temporary variables. Ordinary errors preserve prior changes; stop, reset, entry switching, saving changed source or leaving the workbench releases the environment. The next execution after a source change also starts fresh. The environment is created on first execution and released after ten minutes without execution; displayed history remains and is never replayed automatically. Clear history and Reset environment are separate actions. The console does not access Agent session variables or write to its journal; code still runs file, network and other Node/OS operations with DSH process permissions.

“Show REPL tab” and “Show binding authoring button” default to on and control the session tab and composer shortcut separately. Hiding the tab leaves Settings management available; hiding the authoring button leaves `/binding` commands available. The existing Global User Bindings switch controls the whole capability.

Each entry's Model context section contains Include API declaration in model context and Prompt for the model. Both can be edited directly, then saved or cancelled without first editing source. The interface always comes from the source, and its checkbox defaults to on. The prompt can describe when to use the tool, constraints or examples; leave it empty to omit it. These settings are independent: unchecking the declaration still supplies a nonempty prompt. Uncheck it and clear the prompt to omit both without disabling execution. Enabled entries are visible from the first turn of a new session. Saving and enabling a `/binding` draft, enabling an entry mid-session or changing its prompt also updates the next request, without requiring a new session or a preliminary tool execution. `/binding` asks the Agent to write the prompt and choose the declaration setting alongside the source; the draft card preserves both for review.

Prompts and selected interfaces arrive as an appended global binding API catalog, updated independently of transient recovery guidance. Errors and recovery do not resend unchanged interfaces. Saving, toggling, removing entries or editing prompts updates or withdraws the catalog on the next Host-permitted request without rewriting the system prompt or message history. DSH runtime-context suppression defers new delivery; a retained catalog still describes its recorded configuration. Delivery resumes with the current configuration. The catalog documents APIs, not successful initialization or current variable values.

Enabled entries attempt activation as ordinary writable REPL bindings in the next `run_code`. First-turn declarations describe configured APIs and do not prove successful initialization. Configured documentation is the single source of binding prompts and interfaces. Successful initialization does not append an activation announcement or repeat the interface; unchanged documentation is not reinjected while it remains model-visible. Execution results and diagnostics describe actual availability. A request-owned program namespace or error class takes precedence over a same-name global entry; that entry fails activation for the request with a diagnostic but cannot replace the Host value or block independent code. If a program namespace needed by a binding module has the same name as an existing worker global, the cell fails explicitly without replacing the Node intrinsic. A failed initializer that issued a program call makes the cell volatile, so cold recovery cannot treat a call record without that initializer's source as replayable history. A same-name assignment or redeclaration shadows the default for the current session only. Cold recovery uses the exact snapshot recorded in result metadata instead of guessing from current disk content. Relative imports in entry source resolve from the binding-storage directory during both candidate runs and activation; an exported closure saved in an ordinary session binding retains that resolution base and the program-namespace bridge for the current worker lifetime.

Examples such as `{{name}}` in prompts and interfaces reach the model literally. Changing only the prompt, declaration checkbox or purpose preserves the active module's state and does not repeat initialization. Changing source, scope, namespace call name or selected exports reinitializes the module at the next execution. Reconstructable history uses each cell's recorded reuse policy.

Global binding snapshots record the TypeScript transform generation. Older nonempty snapshots without that identity cannot guarantee unchanged recovered values after an upgrade. Recovery returns to the nearest earlier verified state, skips the affected cell and its dependent suffix, and reports the contraction once; it continues from an empty REPL when no state is provable. Historical tool calls are not redispatched, saved binding source and configuration remain on disk, and the current valid cell still executes with current configuration. Older snapshots with no activated global bindings are unaffected by this restriction.

When enabled, a sparkle action appears in the composer toolbar before the first turn whenever the exact session command directory provides `/binding`. It prefills `/binding new ` without replacing an existing draft. You can also type `/binding new <requirement>` or `/binding edit <id> <requirement>` directly; DSH provides command matching and the argument hint. The command completes and clears the composer as soon as Agent authoring starts. One command card in the conversation preserves the requirement, status, and TypeScript source; every lifecycle label follows the interface language. The Agent receives field definitions, a complete example, and the dependency resolution base, then hands off one disabled memory draft through the stable `code.submitBindingDraft({requestId, entry})` API inside `run_code`. Each request accepts one valid submission; ordinary REPL declarations do not create global drafts. Starting and ending authoring preserve the system and tool declarations under unchanged configuration.

The card offers Save as disabled, Save and enable, and Discard draft as explicit user actions. After saving or discarding, the exact accepted source remains inspectable and the receipt can be reconstructed from the log; later changes to the same ID do not replace that history. Save and enable atomically persists an enabled entry, while the runtime separately proves session activation. The model receives the persistence fact and current configured documentation on the next permitted request; execution results report initialization failures. `repl.state` manages named checkpoints, not a binding inventory. Catalog conflicts refresh authoritative state and retain valid drafts for user review and retry.

The PTC Plus header popover has Session and Global tabs. Session shows reusable REPL bindings; Global shows stored enabled/disabled state, inspects source, and prefills `/binding edit`. Enabled in the catalog does not mean activated in this session. Complete management is available in the REPL tab and the Settings management modal; Agent-assisted authoring still requires an available session. An opaque locator in the current session's private projection controls draft UI operations; saving, discarding, or ending the owning Agent, session, feature, or owner revokes writable access. The candidate worker isolates session state, but code retains DSH process authority and may produce irreversible Node/OS effects.

While the plugin is enabled and the current session uses the `ptc` or compatible `code` preset, a top-level **REPL** tab appears alongside Conversation and Trajectory. Switching to an ineligible session or disabling the plugin removes it. “Session bindings” shows names, definition sources, and bounded values observed after cell settlement, with observation time, truncation, and unreadable states. Entries outside display limits are omitted without suppressing previews for visible bindings. Value previews read only primitives and the first five own array slots. Plain objects, TypedArray, Buffer, boxed String and other unsupported values are unreadable; no preview enumerates the complete property set. Primitive strings retain their bounded text previews. Previews do not invoke getters, Proxy traps, user formatters, or session code. They are not complete live snapshots, never enter model context or the journal, and do not change recovery or binding retention rules.

REPL shows session bindings and the complete global bindings workbench on one page, without internal tabs. Search session names or filter declaration kinds, then select a binding to inspect its highlighted, copyable definition and value preview. Empty inventories use a compact full-width state. Optional values are collected after subsequent execution only while the session observation region is visible; opening the page itself never evaluates observations. The workspace hides the ordinary message composer and disables transcript width dragging. Returning to Conversation restores the composer and unsent draft. Host approvals and questions remain available.

![REPL workspace with session binding inspection and global binding management](assets/ptc-plus-repl-workspace-en.png)

*The REPL workspace shows session bindings above global binding management and the TypeScript code console.*

The settled result waits at most 250 ms for a preview. Only unfinished observation is exempt from the next cell's compute and wall budgets; other blocking work, including background user callbacks, retains timeout protection, and waiting remains cancellable. Preview time cannot cause the next cell to time out and lose its bindings.

In an enabled `ptc` session, the header shows a green `PTC Plus` indicator. Hover, focus, or click it to inspect the variables, functions, classes, and imports available to the next cell and expand their bounded definition source. The card reads submitted source only; it does not inspect runtime values, trigger getters, or execute code. `run_code` and `edit_run_code` remain expandable in the conversation body. A feature marker appears only when result metadata proves that the feature affected that execution.

![Reusable REPL bindings](assets/ptc-plus-bindings-en.png)

*A real session: “Reusable REPL bindings” shows the bindings available to the next cell.*

Every setting applies live and keeps existing bindings. A submitted cell uses one configuration for its complete execution; changes made while it runs apply to cells submitted afterward. A failed change rolls back. Node fixes a worker's V8 old-generation limit when the worker starts, so that one setting is rejected while a session worker is active and can be changed after the session is disposed. A failed enable is rolled back and persisted as disabled.

`cordisToolsEnabled` is off by default. Turning it on atomically adds DSH's official Cordis tools, owner guidance, and exactly the `cordis-plugin-development` companion Skill to PTC agents; sibling Skills in the shipped preset are not exposed. Turning it off removes all three. It neither switches presets nor changes the direct `run_code`/`edit_run_code` surface. Cordis runs model-written plugins against the live DSH runtime, so enabling it requires shell-level trust.

When a Cordis call fails while the worker stays live, source bindings assigned before the failure can be reused in a later short cell. A call may throw after an external effect; retry decisions must follow the Cordis owner's execution facts and idempotence contract. A smaller cell does not itself prove retry safety. Timeouts and aggregate output overflow terminate the worker, so bindings from the failed cell cannot be relied on.

Objects and member references captured from `tools` in the REPL expire with the submitting cell's lease. Reusable helpers should resolve the current namespace when called, for example `async function inspectNow() { return tools.cordis_inspect_list({}) }`. The dynamic bridge in Global User Binding modules also checks the invoking cell's lease; an old continuation cannot borrow a new cell's capabilities.

After cold recovery or re-enabling Cordis, recorded Cordis values remain journal data but do not prove that process-local Plugins, Runs, approvals, or earlier Inspect observations are still live. PTC Plus adds a bounded recovery declaration until a new successful Cordis Inspect call validates the current process. Recovery declarations, configured global-binding documentation, and on-demand tips use independently sourced PTC Plus messages that honor Host runtime-context suppression. Their changes do not resend other plugins' unchanged context, and obsolete state declarations are explicitly withdrawn.

See [Client UI](docs/client-ui.md), [ADR 0019](docs/adr/0019-plugin-settings-and-kill-switch.md), [ADR 0020](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md), and [ADR 0023](docs/adr/0023-global-user-bindings.md).

## Scope

Capability discovery uses the SDK's declared `capabilities.tree/find/inspect`. `find` is deterministic lexical matching: exact `namespace.member` symbols rank first, and short complete tokens such as `read` also work. Multiple tokens must occur contiguously. After an empty match, narrow the query or traverse `tree()` namespace entries and their members, then inspect only relevant symbols in the current view. See [Capability Discovery](docs/runtime-reference.md#capability-discovery).

PTC Plus provides the session-bound persistent `run_code` layer. DSH and the operating system continue to own native-tool authority, policy, approval, cancellation, sandboxing and process governance.

## Install

Requires Node.js `^22.19.0 || >=24.0.0` and DSH with TypeScript PTC mode. Install the published package from npm into the profile you use:

```sh
dsh plugin --profile <profile> add dsh-ptc-plus
dsh --profile <profile> --dump-config
```

Restart that DSH profile after installation. Version-pinned npm, GitHub, local-checkout, and tarball installs are covered in the [installation guide](docs/installation.md).

For Windows development, double-click `scripts\run-dev-dsh.cmd` to launch an isolated DSH installation from the latest `alpha` dist-tag with only this plugin installed. DSH, plugin snapshots, and the pnpm store are cached and old entries are pruned automatically. The launcher de-duplicates Windows `PATH` in the current process only; it creates no drive mappings or junction trees and does not change the system environment. If a genuinely unique PATH remains too long for `cmd.exe`, it stops before npm or DSH runs and asks you to shorten PATH. When no Web port is supplied, the launcher selects a free loopback port so an existing service on 3080 cannot block the test instance. The default cache is `%LOCALAPPDATA%\dsh-ptc-plus-dev`, outside this repository. See the [installation guide](docs/installation.md) for overrides.

The development launcher uses the official npm registry for queries and installs by default, avoiding missing dependencies while mirrors synchronize a new release. Set `DSH_DEV_REGISTRY` to select another registry. The choice applies to npm and DSH's pnpm subprocesses without changing global npm configuration.

Locked old cache files or failed pnpm store pruning produce warnings and startup continues, preserving the selected DSH installation and plugin snapshot. Interpret peer dependency warnings alongside the subsequent Host load: DSH supplies these packages from its active installation, and failed cache cleanup does not mean plugin installation failed.

Compatibility selects the old or new tools mode and Client session interfaces through public capabilities, without DSH version branches. Before upgrading and continuing old sessions, read [Session format upgrades](docs/installation.md#session-format-upgrades): when the Host renumbers events, PTC edit targets and recovery references also need migration. The script preserves the original log and never re-executes historical tool calls.

`danger-full-access` is the primary supported experience. The worker isolates lifecycle, not malicious code.

## Documentation

[Installation](docs/installation.md) · [Runtime reference](docs/runtime-reference.md) · [Architecture](docs/architecture.md) · [Publishing](docs/publishing.md) · [All docs](docs/README.md)

MIT licensed. See [LICENSE](LICENSE).
