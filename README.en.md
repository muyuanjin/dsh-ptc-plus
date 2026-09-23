<p align="center">
  <img src="assets/dsh-ptc-plus-banner-en.webp" width="100%" alt="PTC Plus: No need to start over! Update it. Keep computing!">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness PTC mode" src="https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb"></a>
  <a href="https://www.npmjs.com/package/dsh-ptc-plus"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-ptc-plus?logo=npm"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
  <a href="https://awesome-dsh-plugin.com/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

**Let the model keep computing and revise its work within a session, with less repeated setup and fewer avoidable tool-call errors.**

PTC Plus provides a stateful TypeScript computation environment for DSH's **PTC mode**. Built on a REPL, it keeps variables, functions, imports, and intermediate results available across tool calls. It extends declaration update rules and adapts module syntax, with call tolerance and code editing designed for models that repeatedly write and revise code.

- **Keep computing**: reuse data already loaded and processed in the session.
- **Revise directly**: update a variable or function under the same name; existing closures read the updated binding. Small changes can be sent as code deltas.
- **Avoid routine call failures**: use familiar module syntax, recover from identifiable call omissions, and receive correction suggestions for verifiable syntax errors.
- **Reuse common capabilities**: save functions as global bindings, provide their interfaces and usage notes to the model, and use them across sessions.

[Quick start](#quick-start) · [Feature overview](#feature-overview) · [Continuous computation](#continuous-computation-and-language-extensions) · [Editing and call tolerance](#code-editing-and-call-tolerance) · [Global bindings](#global-bindings-reuse-functions-across-sessions) · [Interface and settings](#interface-and-settings) · [Values and recovery](#value-transfer-and-state-recovery)

## Quick start

Requires Node.js `^22.19.0 || >=24.0.0` and the latest available official DSH release. Install into the profile you actually use:

```sh
dsh plugin --profile <profile> add dsh-ptc-plus
```

Replace `<profile>` with your profile name. Restart DSH and select **PTC mode** in the session. Continuous computation, call tolerance, and global bindings default to on. Explicitly disabled options in an existing configuration stay disabled.

With the default interface settings, the session has a **REPL** tab; wide screens also show a green **PTC Plus** header indicator. The sparkle button beside the composer opens the global binding menu and **PTC Plus settings**. You can also open **Plugins → Installed → dsh-ptc-plus → Configure** in the sidebar to check the main switch and all plugin settings.

Once installed, describe your task to the model as usual. The `run_code` and `edit_run_code` examples below show how the model uses these features. See the [installation guide](docs/installation.md) for other installation methods, Desktop, the local development launcher, upgrades, and troubleshooting.

## Feature overview

| What you want the model to do | What PTC Plus provides |
| --- | --- |
| Continue processing data | Retain variables, functions, imports, and intermediate results for later calls in the session |
| Revise an existing calculation | Update variables, functions, classes, and import bindings under the same names; existing closures read updated bindings |
| Change a small part of the code | Submit a delta through `edit_run_code`, then execute the complete revised code |
| Use familiar syntax | TypeScript, top-level `await` / `return`, and static `import` / `export` |
| Avoid interruptions from call format or syntax mistakes | Tolerate missing summaries, normalize uniquely identifiable misplaced native-tool calls, and suggest validated EOF syntax repairs |
| Work with the current project | Resolve relative file paths, session module imports, and default child-process directories from the session project directory |
| Find tools and parameters | List and search current capabilities in code, then inspect relevant interfaces |
| Transfer data beyond plain JSON | Preserve `undefined`, BigInt, cycles, and shared references within the supported value domain |
| Inspect computation state | View retained names, source definitions, reuse counts, and bounded value previews in the REPL tab |
| Reuse functions across sessions | Save TypeScript global bindings and supply their interfaces and usage notes to the model |
| Author and test global bindings | Ask the model for a draft to review, or run unsaved source in the workbench |
| Continue after a restart | Recover verifiable state from session records and report what cannot be recovered |

The following sections explain usage and limits. See the [runtime reference](docs/runtime-reference.md) for complete language rules, configuration fields, and diagnostics.

## Continuous computation and language extensions

The model executes the following code through `run_code`. Each call's code is a **cell**.

First, define the data and a calculation:

```ts
const amounts: number[] = [12, 8, 5]
function total() {
  return amounts.reduce((sum, value) => sum + value, 0)
}
return total() // 25
```

In the next call, revise the data and reuse the function:

```ts
const amounts = amounts.filter(value => value >= 8)
return total() // 20
```

There is no need to redefine `total` or invent another variable name to avoid a redeclaration error. `total()` reads the updated `amounts`.

The default **stateful semantics** (`bindingUpdates: 'stateful'`) extend JavaScript/TypeScript binding rules for continued revision:

- Variables, functions, classes, and import bindings in the same scope can be updated, including bindings declared with `const`. Same-name revisions also work within a single cell.
- Existing closures read updated bindings; a previously saved function value remains the original function.
- Blocks, functions, and loop iterations retain their separate scopes.
- Failed initialization does not permanently reserve a name that was never successfully established. Other changes made before the failure are not rolled back.

Cells support TypeScript, top-level `await` / `return`, and static `import` / `export`. To detect name overwrites instead, disable **Allow redeclarations and overrides** to select the `protected` policy. Protected runtime names such as `tools` remain unavailable for overwriting.

<details>
<summary>When static imports and local overrides take effect</summary>

Static imports take effect **before the entire cell body executes**. Assignments and ordinary declarations in the body can then override them. A static import in a later cell restores the binding's live module source. Writing an import below an ordinary declaration in the same cell does not restore it at that textual position. To retrieve the current exported value at a particular step, assign it explicitly:

```ts
join = (await import('node:path')).join
```

This captures the function value at that moment; a static import follows its module source. See the [runtime reference](docs/runtime-reference.md#cell-semantics) for more language rules.

</details>

`run_code`, edited code, and the global binding workbench follow the same language policy; the workbench's temporary state is separate from the model's session. Explicit `eval`, `Function`, `node:vm`, and independent runtimes retain their corresponding native boundaries. See the [language reference](docs/runtime-reference.md#cell-semantics) for scope, module interoperability, and historical session rules.

## Code editing and call tolerance

### Send only the change

The model can use `edit_run_code` to change the most recent editable cell in the current model turn without resending its complete source. If the second cell above has just completed and the same turn is still running, its filter can be changed to `value >= 10`:

```js
edit_run_code({
  edits: [{ old_string: 'value >= 8', new_string: 'value >= 10' }]
})
```

An edit **reruns the entire cell**; this example returns `12`. Earlier state changes are not rolled back. If the code writes files or calls external services, rerunning still requires considering duplicate effects. Edits can repair failed code or refine a successful computation.

### Recover from identifiable call problems

| Situation | PTC Plus behavior |
| --- | --- |
| `run_code` omits its outer `description` | Supply a display summary so code with otherwise valid arguments can execute |
| The model calls a native tool outside the PTC direct-tool list | Convert it to the corresponding `run_code` when current tool definitions uniquely identify the target and validate the arguments |
| Code fails to parse | Identify the source position; at EOF, suggest a target-bound edit if appending one or two closing delimiters has exactly one validated correction |

The first two behaviors default to on and can be disabled in settings. Syntax suggestions do not execute automatically or establish that the code matches the task's intent.

## Project files and tool capabilities

### Start from the session project directory

The model can use Node.js directly to read files, process data, and run programs. Relative file paths and imports in session code resolve from the recorded session project directory. Child processes use that directory when `cwd` is omitted; an explicit directory still takes precedence.

For example, in a project containing `package.json`, the first call reads its dependencies:

```ts
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

The next call works directly with the loaded data:

```ts
return deps.map(dep => dep + '@' + manifest.dependencies[dep])
```

This does not reread the file: it uses `manifest` already in the session. Direct file, network, and other external inputs can remain usable in the live environment without being guaranteed recoverable after a restart.

### Discover tools as needed

The model can still use DSH's current native tools through `tools.*`. To discover available capabilities, `capabilities.tree()` lists the catalog, `find()` searches names and descriptions, and `inspect()` provides parameter information for selected interfaces:

```ts
const matches = await capabilities.find('read')
return capabilities.inspect({
  symbols: matches.slice(0, 4).map(item => item.symbol),
  budget: 4,
})
```

Search uses lexical matching, so short keywords such as `read` or `session` work best. A miss does not prove that a tool is unavailable. Discovery grants no additional authority; DSH still validates and schedules calls. See [capability discovery](docs/runtime-reference.md#capability-discovery).

## Global bindings: reuse functions across sessions

Session variables serve the current task. **Global bindings** save common TypeScript functions for multiple sessions to load. For example, after saving a binding named `textTools`, the model can call `textTools.clean(text)`.

Global bindings and the sparkle shortcut default to on. Create entries manually, import `.ts` files, or ask the model to write and revise them:

```text
/binding new Create textTools to trim outer whitespace while preserving interior spaces
/binding edit <id> Add line-by-line trimming
```

`<id>` is the entry's identifier in the workbench. You can also select the binding to revise from the sparkle menu.

### Author, review, and enable

The model can test with in-memory examples before submitting a draft. The draft appears above the composer, where you review its source, interface, and model instructions, then choose **Save and enable**, **Save disabled**, or **Discard draft**. Submission alone neither saves nor enables a binding. If you close the panel, the sparkle button's draft badge lets you reopen it.

The sparkle menu lists and toggles entries even before the first message; these choices apply across sessions. Enabled entries' interfaces and usage notes are provided to the model in new sessions. Changes during a session are delivered on its next allowed request.

### Interface guidance and independent trial runs

Each entry can derive its public interface from source and include purpose, input constraints, or examples. Editing only its instructions does not reset its loaded runtime state. Assignment or redeclaration in a session overrides only the corresponding name and does not rewrite the saved global entry.

The workbench can run unsaved source and retain temporary variables across executions. Its computation state is separate from the model's session, making it useful for manual function checks; file and network operations still have real effects. Entries can be managed without an active PTC session. See the [global binding guide](docs/user-bindings.en.md) for source format, interface generation, storage, and the full workflow.

## Interface and settings

The **REPL tab** lets you search retained names, inspect definitions, see reuse counts and bounded value previews, and open the global binding workbench. Previews have type and size limits; missing, incomplete, or unreadable previews are identified explicitly, and display does not invoke user getters. The green **PTC Plus** header indicator offers a quick binding list on wide screens; use the REPL tab on narrow screens.

<details>
<summary>View the REPL interface</summary>

![Session state and the global binding workbench in the REPL tab](assets/ptc-plus-repl-workspace-en.png)

</details>

The sparkle menu beside the composer groups binding authoring, entry management, and **PTC Plus settings**. Its settings dialog and the sidebar plugin configuration page share the same configuration:

| Group | What you can adjust |
| --- | --- |
| Main switch | Enable or disable PTC Plus |
| Call tolerance | Missing call summaries and identifiable misplaced native-tool calls |
| REPL syntax | Allow same-name revisions or choose name protection |
| State and recovery | Restart recovery, contextual tips, and their frequency |
| Tool extensions | Global bindings and their management entry, official Cordis tool integration |
| Interface | Enhanced tool cards, the REPL tab, and the sparkle shortcut |
| Resource limits | Execution time, memory, and output budgets |

Everyday computation features default to on. **Cordis development tools default to off** and can be enabled when inspecting or developing DSH plugins; see the [integration notes](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md). Explicitly disabled options stay disabled, and each saved binding keeps its own enabled state.

Settings usually apply immediately. A worker's memory limit cannot be changed while that worker is active. See the [configuration reference](docs/runtime-reference.md#configuration) for fields, defaults, and full limits.

## Value transfer and state recovery

### Preserve values beyond plain JSON

Within the supported value domain, tool arguments, results, and recovery records preserve `undefined`, BigInt, `NaN`, infinities, sparse arrays, cycles, and shared references. Ordinary JSON results remain structured values; special values are displayed as readable text to the model, separately from their program values.

This does not make every JavaScript object transferable or persistent: functions, Promises, class instances, Date, Map, and Set are outside the value-transfer domain. Keeping a function in the REPL for later calls is different from returning that function as a tool result. Reuse session variables for continued computation; see the [value-transfer specification](docs/value-wire.md) for the complete supported domain.

### Recover state with verifiable history

Session state is not permanent memory. After a restart, runtime reset, or context compaction, only state verifiable from session records whose provenance remains in the model's context can be retained. Direct file or network inputs, damaged history, and compacted source provenance can reduce what remains available.

Unverifiable state is discarded with a diagnostic; if necessary, the current computation continues in an empty environment. Recovery neither redispatches recorded native-tool calls nor reverses historical external effects. See the [runtime reference](docs/runtime-reference.md) for recovery evidence and limits.

## Boundaries

- **Execution permissions**: primarily designed for `danger-full-access`. Code can access Node.js and the operating system directly; the plugin adds no security sandbox. DSH continues to own native-tool permissions, approvals, cancellation, and sandbox policy.
- **Failures and reruns**: a failed execution does not mean earlier statements had no effect. Process isolation, editing, and recovery do not guarantee that external operations are safe to repeat. Timeouts or output overflow can also release the computation environment.
- **Errors and cost**: language adaptation and call tolerance do not guarantee that every program succeeds. Actual call counts and token usage depend on the task and model; see the [evaluation notes](docs/evaluation.md#recorded-paired-observation) for a recorded comparison and its limitations.

PTC Plus is a community plugin, with no affiliation with or endorsement from DeepSeek or DSH.

## Further reading

[Installation and upgrades](docs/installation.md) · [Global bindings](docs/user-bindings.en.md) · [Runtime reference](docs/runtime-reference.md) · [Architecture and development](docs/architecture.md) · [Verification](docs/verification.md) · [All documentation](docs/README.md)

[MIT License](LICENSE)
