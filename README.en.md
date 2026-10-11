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
</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

**Let the model keep computing and revise its work within a session, with less repeated setup and fewer avoidable tool-call errors.**

PTC Plus provides a stateful TypeScript computation environment for DSH's **PTC mode**. Built on a REPL, it keeps variables, functions, imports, and intermediate results available across tool calls. It extends declaration update rules and adapts module syntax, with call tolerance and code editing designed for models that repeatedly write and revise code.

- **Keep computing**: reuse data already loaded and processed in the session.
- **Revise directly**: update a variable or function under the same name; existing closures read the updated binding. Small changes can be sent as code deltas.
- **Avoid routine call failures**: use familiar module syntax, recover from identifiable call omissions, and receive correction suggestions for verifiable syntax errors.
- **Reuse common capabilities**: save functions as global bindings, provide their interfaces and usage notes to the model, and use them across sessions.

In one paired [Command Goat / DeepSeek V4.1 Flash experiment](docs/evaluations/command-goat-deepseek-v4.1-flash-20261006.md), PTC Plus completed 28/30 tasks versus 25/30, with 2 versus 4 direct tool errors. Across 13 ordinary tasks, both arms completed 24/26 and PTC Plus used 18.04% more token traffic including subagents. Broad cost savings remain unproved.

[Quick start](#quick-start) · [Feature overview](#feature-overview) · [Continuous computation](#continuous-computation-and-language-extensions) · [Editing and call tolerance](#code-editing-and-call-tolerance) · [Global bindings](#global-bindings-reuse-functions-across-sessions) · [Interface and settings](#interface-and-settings) · [Values and recovery](#value-transfer-and-state-recovery)

PTC mode declares only `run_code` as a top-level tool. Code edits use `tools.edit_run_code` inside a cell and run through DSH's native tool pipeline. See the [editor contract](docs/adr/0005-temporary-rejected-cell-edit-transport.md).

## Quick start

Requires Node.js `^22.19.0 || >=24.0.0` and the latest available official DSH release. Install into the profile you actually use:

```sh
dsh plugin --profile <profile> add dsh-ptc-plus
```

Replace `<profile>` with your profile name. Restart DSH and select **PTC mode** in the session. Continuous computation, call tolerance, and global bindings default to on. Explicitly disabled options in an existing configuration stay disabled.

Session history uses DSH's public reader, and the Host incrementally projects prompt facts. Missing read surfaces or malformed historical event arrays produce explicit diagnostics, not a claim that unavailable history was successfully recovered as an empty session.

With the default interface settings, the session has a **REPL** tab; wide screens also show a green **PTC Plus** header indicator. The sparkle button beside the composer opens the global binding menu and **PTC Plus settings**. Both the menu and the revision list mark enabled bindings in green and disabled bindings in gray. You can also open **Plugins → Installed → dsh-ptc-plus → Configure** in the sidebar to check the main switch and all plugin settings.

To upgrade an installed plugin, run `dsh plugin --profile <profile> add dsh-ptc-plus@latest` and restart that Host. Use `add` with an absolute tarball or pinned Git revision to replace the profile dependency.

Once installed, describe your task to the model as usual. The `run_code` and in-program `tools.edit_run_code` examples below show how the model uses these features. See the [installation guide](docs/installation.md) for other installation methods, Desktop, the local development launcher, upgrades, and troubleshooting.

For Windows source testing, double-click `scripts\run-upstream-dsh.cmd` to fetch the official DSH default branch, reuse an isolated build cache, and load this plugin checkout. The first run installs dependencies and builds DSH; see [upstream source testing](docs/installation.md#upstream-source-development-launcher-windows).

Windows development scripts check that local esbuild can execute. If dependencies are missing or were installed by WSL, they install and pack in a Git-ignored `win_node_modules` directory without replacing the checkout's `node_modules`.
The sparkle menu opens a session capability workbench. Search Skills, ordinary tools, MCP servers and their capabilities by type, source, and state, then inspect current global settings, the frozen session inheritance source, temporary choices, and effective choices separately. Saving global settings without refreshing a session leaves its inheritance source unchanged; clearing a temporary choice still uses that frozen source. An automatic strategy does not predict the final allocation. Edit one shared draft, then use Discard changes, Apply to session, or Save and apply in the footer. Save and apply saves global defaults and updates the current session. Clearing a temporary override is a session-only operation. Multiple pending choices run as individual human commands; unconfirmed drafts remain available to retry after a partial failure. Ordinary refresh preserves temporary choices, while a global dimension action clears only that dimension's temporary choice for the same identity. The workbench preserves unsent composer text and starts no model task. Refresh and status receipts show only one outcome line, such as “Session capabilities updated.”, without repeating the command, completion status, or original-result disclosure. Capability queries still offer expandable complete lists and original results. Named configuration copies exclude temporary choices. On disablement, an accepted step withdraws old plugin declarations; complete unload persists provider handback through public session ownership and reports persistence failures. See [provider lifecycle](docs/adr/0042-persist-provider-availability-and-handback.md).


## Feature overview

Default PTC mode starts every execution in a fresh environment: variables from the previous call are gone, and a change that depends on earlier results means resending the setup code. PTC Plus turns `run_code` into a session-bound TypeScript REPL and closes the gaps below.

| Scenario | Default PTC mode | With PTC Plus |
| --- | --- | --- |
| Continue processing data | Each call starts fresh, so setup code must be sent again | Variables, functions, imports, and intermediate results stay in the session for the next call |
| Revise an existing name | No established binding can be updated, so the whole cell has to be resent | Revise variables, functions, classes, and import bindings under the same names; existing closures read updated bindings |
| Change a small part of the code | A one-line change means resending the complete source | Submit a delta through `edit_run_code`, then execute the complete revised cell |
| Use module syntax | Static `import` and `export` are invalid inside the function body | Write them directly in a cell; the plugin adapts the module syntax |
| Omit a call summary | Missing `run_code.description` fails validation | Supply a display summary automatically so otherwise valid code proceeds |
| Provider rejects malformed tool JSON | The whole turn ends with a provider error | Repair or preserve a buffered tool-call tail containing only tool framing and at most one usage event; route every other buffered tail through schema rejection so the model continues |
| Recover a misplaced top-level tool call | Undeclared top-level calls are rejected in PTC mode | Convert the call to `run_code` when the live tool definitions uniquely identify the target and validate its arguments |
| Locate a code error | Return the native error and stack | Map the error to the cell source; suggest an edit when a missing trailing delimiter has one verified correction |
| Work with the current directory | Execute in the directory resolved by the Host for the current call | New-cell file operations, imports, and default child processes use the current execution directory; existing modules and import closures retain their source base |
| Find tools and parameters | Read through the tool interfaces already supplied to the model | Retrieve matching interfaces in one byte-budgeted `capabilities.search` response, or list and inspect members |
| Transfer data beyond plain JSON | JSON cannot fully represent `undefined`, BigInt, cycles, and similar values | Preserve supported special values and reference relationships for further computation and recovery |
| Inspect computation state | No reusable session variables remain after a call | View retained names, source definitions, reuse counts, and bounded value previews in the REPL tab |
| Reuse functions across sessions | Save the code yourself and reload it in later calls | Save TypeScript global bindings and supply their interfaces and usage notes to the model |
| Author and test global bindings | No dedicated workbench for global bindings | Ask the model for a draft to review, or run unsaved source in the workbench |
| Continue after a restart | No computation state spans calls, so there is nothing to recover | Recover verifiable state from session records and report what cannot be recovered |

The following sections explain usage and limits. See the [runtime reference](docs/runtime-reference.md) for complete language rules, configuration fields, and diagnostics.

Inside `run_code`, use `await capabilities.search({ query: "read file content", budgetBytes: 8192 })` to retrieve complete contracts within a response budget; oversized entries provide an individual retrieval reference. In settings, search the list and check common capabilities. Availability and disclosure are separate: control only Tools, Skills or MCP availability while retaining Host explanations, or select full, on-demand or evidence-based disclosure. Default, category, proven MCP source and item rules override each dimension separately; closing retains disclosure preferences. Common-set, statistics and budget allocation are independently selected. Usage statistics, Prompt recovery and Output excerpts are also separate choices. The switch beside Capabilities and context pauses these features and Capability configuration (including Initial prompt) together, retaining every saved choice. Re-enabling restores that combination. Selected children show Paused while the group is off; unselected children remain Not selected. Named configurations retain the group choice. It applies to new sessions or explicit refreshes. The group defaults on without selecting any child feature. Fresh settings retain Host disclosure with recovery and previews off; older configuration migration preserves prior behavior. Each MCP source has independent availability and disclosure choices that can return to parent rules; its tools retain their own preferences. No JSON entry is required. Enable Capability configuration to apply saved availability and disclosure rules; other features remain independent. Statistics use a switch, sample counts and a percentage input. Independent statistics use actual session-family coverage and preserve manual choices when disabled or damaged. New sessions assemble capability descriptions before the first request and place them before task text. Concise category-purpose navigation and manually pinned contracts precede statistically selected descriptions to improve cross-session prefix reuse; actual cache hits depend on the provider. Existing sessions retain their enablement and disclosure choices. Host contract revisions or removals are announced through appended context without waiting for a settings refresh. User-only Skills describe their /name entry and never recommend model loading through tools.skill; `/capabilities refresh` synchronizes saved settings, runtime members and a durable model notification. Like binding authoring, Refresh session capabilities in the sparkle menu fills an empty composer with `/capabilities refresh` for you to send; existing drafts are preserved. The refresh button in capability settings executes the official Host command for an explicitly selected session without starting a model task. Capability configuration opens directly to search and availability switches, with exact IDs under names. Context editors and advanced filters open on request in their own windows; type and source selections remain compatible. The Capability, Type, Source, Enabled and Context headers cycle through ascending, descending and default order; the session list uses the same columns and sorting. Batch settings opens a small dialog for one-time item changes to the currently filtered available capabilities: confirmation saves, while cancellation writes nothing. Persistent inheritance rules have a separate entry. Prompt navigation shows the selected configuration, and allocation criteria, limits, current allocation and statistics settings stay visible. Usage statistics show workspace and global eligible-family counts and coverage. Budget preview recomputes the current inventory using the same allocation rules. Configurations use a library and detail layout. The single save-current-settings action, import and more actions sit below the library. Prompt settings separates Initial prompt, Prompt recovery and Output excerpts. Navigation and summary share Selected, Not selected, Paused and Use DSH states. Initial prompt applies through Capability configuration; recovery and excerpts are independent choices. Statistics show used and eligible family counts and coverage, with collection parameters displayed directly in Statistics settings. Existing session observations and explicit refresh have a separate entry; frozen source settings can be copied into a named configuration. Changing a configuration does not implicitly refresh existing sessions. All switches use the official DSH appearance. Selected plugin previews retain complete result and log presentation through the Host spill service without changing program values; otherwise the Host presentation remains in effect.

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

Cells support TypeScript (including runtime `enum` and namespaces), top-level `await` / `return`, and static `import` / `export`. To detect name overwrites instead, disable **Allow redeclarations and overrides** to select the `protected` policy. Protected runtime names such as `tools` remain unavailable for overwriting.

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

The model can use `tools.edit_run_code` inside a new `run_code` cell to change the most recent editable cell in the current turn without resending its complete source. If the second cell above has just completed and the same turn is still running, its filter can be changed to `value >= 10`:

```js
const receipt = await tools.edit_run_code({
  edits: [{ old_string: 'value >= 8', new_string: 'value >= 10' }]
})
return receipt
```

An `accepted: true, scheduled: true` receipt means the edit is scheduled. After the outer cell finishes, the entire target cell reruns; its derived result is reported with that `run_code` result, and the next cell reads the revised value (`12` here). Reads later in the accepting cell still see the old state. Earlier state changes are not rolled back. If the code writes files or calls external services, rerunning still requires considering duplicate effects. Edits can repair failed code or refine a successful computation.

Each regular-expression edit requires `pattern`, `flags`, `replacement`, and `expected_matches`. `flags` must be a string; pass `""` explicitly when no flags are needed:

```js
await tools.edit_run_code({
  regex_edits: [{ pattern: "value >= 8", flags: "", replacement: "value >= 10", expected_matches: 1 }]
})
```

Republishing a historical result as a compacted display entry is not another execution and does not make the older cell the new edit target. A newer failed cell remains available for correction.

### Recover from identifiable call problems

| Situation | PTC Plus behavior |
| --- | --- |
| `run_code` omits its outer `description` | Supply a display summary so code with otherwise valid arguments can execute |
| The model calls a native tool outside the PTC direct-tool list | Convert it to the corresponding `run_code` when current tool definitions uniquely identify the target and validate the arguments |
| Argument validation reports a missing `description` | Distinguish outer and nested tool arguments and provide correction guidance, saved as a complete message so session history remains loadable |
| Code fails to parse | Identify the source position; at EOF, suggest a target-bound edit if appending one or two closing delimiters has exactly one validated correction |

The first two behaviors default to on and can be disabled in settings. Syntax suggestions do not execute automatically or establish that the code matches the task's intent.

A volatile state cannot be saved as a durable checkpoint, but a save rejection leaves current variables usable. Explicit restore discards state beyond its target; an unnamed restore empties the REPL when there is no durable head. Restore does not undo external effects or change global binding configuration.

## Project files and tool capabilities

### Start from the current working directory

The model can use Node.js directly to read files, process data, and run programs. New cells resolve relative file operations, imports and child processes without an explicit `cwd` from DSH’s current working directory. Switching directories preserves existing bindings and modules; escaped import closures and captured `require` retain their source bases. Recovery uses each cell’s recorded directory. Explicit paths and directory options still take precedence.

Ordinary module computations can run directly in a cell and be reused by later cells. Use a process or host tool when the task needs a separate process, a particular execution environment, or an external engine check.

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

The model can still use DSH's current native tools through `tools.*`. `capabilities.search()` finds and returns complete indexed entries in one call:

```ts
return capabilities.search({ query: 'read file content', budgetBytes: 8192 })
```

Search uses English/Chinese lexical matching. A miss does not prove that a tool is unavailable. The byte budget includes the response JSON envelope; oversized interfaces remain complete and receive individual retrieval references. Existing `tree()`, `find()` and `inspect()` remain available; inspect's budget counts entries. Discovery grants no additional authority; DSH still validates and schedules calls. See [capability discovery](docs/runtime-reference.md#capability-discovery).

## Global bindings: reuse functions across sessions

Session variables serve the current task. **Global bindings** save common TypeScript functions for multiple sessions to load. For example, after saving a binding named `textTools`, the model can call `textTools.clean(text)`.

Global bindings and the sparkle shortcut default to on. Create entries manually, import `.ts` files, or ask the model to write and revise them:

```text
/binding new Create textTools to trim outer whitespace while preserving interior spaces
/binding edit <id> Add line-by-line trimming
```

`<id>` is the entry's identifier in the workbench. You can also select the binding to revise from the sparkle menu.

### Author, review, and enable

The model can test with in-memory examples before submitting a draft. The draft floats above the composer; expanding or collapsing it leaves the conversation in place. Opening a draft from the composer menu or original request goes directly to the large dialog. Choose **Enlarge binding draft** to review the complete source in a large dialog with independent scrolling and save/discard actions at the bottom. The header separates resize and close controls; **Shrink binding draft** returns to preview. Review its source, interface, and model instructions, then choose **Save and enable**, **Save disabled**, or **Discard draft**. Submission alone neither saves nor enables a binding. If you close the panel, the sparkle button's draft badge lets you reopen it.

The sparkle menu lists and toggles entries even before the first message; these choices apply across sessions. Enabled entries appear first with compact state pills; the disabled group uses a neutral disclosure row with its count and starts collapsed. Authoring and utility actions share a two-column layout with centered labels, aligned icons and a soft fill without borders. Only the binding list scrolls, keeping the footer actions visible. Enabled entries' interfaces and usage notes are provided to the model in new sessions. Changes during a session are delivered on its next allowed request.

### Interface guidance and independent trial runs

Each entry can derive its public interface from source and include purpose, input constraints, or examples. Editing only its instructions does not reset its loaded runtime state. Assignment or redeclaration in a session overrides only the corresponding name and does not rewrite the saved global entry.

The workbench can run unsaved source and retain temporary variables across executions. Its computation state is separate from the model's session, making it useful for manual function checks; file and network operations still have real effects. Entries can be managed without an active PTC session. See the [global binding guide](docs/user-bindings.en.md) for source format, interface generation, storage, and the full workflow.

## Interface and settings

The **REPL tab** lets you search retained names, inspect definitions, see reuse counts and bounded value previews, and open the global binding workbench. Previews have type and size limits; missing, incomplete, or unreadable previews are identified explicitly, and display does not invoke user getters. The green **PTC Plus** header indicator offers a quick binding list on wide screens; use the REPL tab on narrow screens.

Hover for 400 ms over a collapsed enhanced execution card for a quick peek at its recorded source, result, and feature notices; keyboard focus also opens it. The preview prefers the right of the pointer, falling back above or below the row when space is limited. Disable “Preview execution content on hover” under Interface display in Settings if desired (enabled by default). Long content is labeled as an excerpt. The preview never captures pointer or wheel input and hides when scrolling; passing rows during scrolling does not open it. Click or press Enter/Space to expand the full content and copy code, or tap on touch devices. Expand a folded process group first.

Workbench controls provide visible keyboard focus and disabled feedback, and REPL names remain readable in light and dark themes. See the [visual contract](docs/client-visual-contract.md) for browser regression checks and their coverage limits.

![Session state and the global binding workbench in the REPL tab](assets/ptc-plus-repl-workspace-en.png)

The sparkle menu beside the composer groups binding authoring, entry management, session capability refresh, and **PTC Plus settings**. The sparkle entry opens a large settings window with a navigation rail and settings cards on wide screens, and one column on small screens. The main switch shares one borderless row with the **PTC Plus** navigation title. Core workspace, extensions and tolerance, interface and resources, and experimental modules organize the form, starting with REPL syntax; experimental capability controls follow with a clear label. The settings dialog and the sidebar plugin configuration page share the same configuration. Both the page and dialog scroll settings independently of navigation; section selection keeps the navigation rail and surrounding page in place. Small static module captions differ from section links with icons, arrows and selection markers:

| Functional module | Group | What you can adjust |
| --- | --- | --- |
| Plugin switch | PTC Plus title switch | Enable or disable PTC Plus |
| Core workspace | REPL syntax | Allow same-name revisions or choose name protection |
| Core workspace | State and recovery | Restart recovery, contextual tips, and their frequency |
| Extensions and tolerance | Tool extensions | Global bindings and their management entry, official Cordis tool integration |
| Extensions and tolerance | Tool call tolerance | Missing call summaries and identifiable misplaced native-tool calls |
| Interface and resources | Interface display | Enhanced tool cards, the REPL tab, and the sparkle shortcut |
| Interface and resources | Resource limits | Execution time, memory, and output budgets |
| Experimental | Capabilities and context | Experimental capability management (off by default), independent statistics, common baseline, individual choices, and presentation budgets |

Everyday computation features default to on. **Cordis development tools default to off** and can be enabled when inspecting or developing DSH plugins; see the [integration notes](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md). Explicitly disabled options stay disabled, and each saved binding keeps its own enabled state.

A persistent New session settings summary lists Capability configuration, Initial prompt, Prompt recovery, Output excerpts and Usage statistics, grouped by capabilities, prompts and statistics. Initial prompt manages the first-turn capability descriptions, common-set allocation and budgets through capability configuration; the other three features are independent. Summary and editor names and states match, and each status opens its corresponding setting. Compare an existing session requires an explicit target and shows the last observed frozen plan, recorded or pending notification, saved-source differences and temporary overrides. Saving does not apply to existing sessions, and a refresh receipt does not prove the model received its notification. Failed reads retain earlier observations with an unconfirmed status; reading again does not refresh. Allocation applies only to available members whose final disclosure choice is adaptive. Valid historical statistics remain usable after collection stops, and budgets cannot demote explicit full contracts.

Capabilities and context has four tabs: Capability configuration, Prompt settings, Usage statistics and Configurations. The capability list opens to search and independent availability switches, with exact IDs beneath names and separate type/source columns. Context editors and combined filters open on request in their own windows. Prompt settings uses fixed navigation for Initial prompt, Prompt recovery and Output excerpts with one editor at a time; allocation criteria, limits and the current allocation preview remain visible. Navigation and summary share selected, unselected, paused and Host-default states. Statistics show used and eligible family counts and coverage, with collection parameters displayed directly in Statistics settings. Configurations use a library/detail layout, with one save-current-settings action, import and more actions below the library. Click Capability, Type, Source, Enabled or Context to cycle through ascending, descending and default order. Batch settings opens a separate one-time dialog for the currently filtered available capabilities; persistent inheritance rules have their own entry. Category rules cover Tools, Skills, and MCP resources and templates; resources and templates are managed together per server. Default, category, MCP source and item rules independently select availability and disclosure, with source and item choices removable to inherit parent rules; server closure takes precedence and re-enabling retains child preferences. Common stars and manual strategies are independent; details distinguish saved preferences from the selected session’s frozen plan. Full Skill disclosure does not preload its body. Unavailable preferences can be retained or removed, and catalog failures retain the last observed entries. Core execution capabilities are outside the managed settings list. Frozen session sources can be inspected independently of feature selection; turning all off still permits observation and retains saved preferences. Capability inputs are frozen per session; saved changes apply to new sessions or `/capabilities refresh`. Other settings usually apply immediately. A worker's memory limit cannot be changed while that worker is active or a submitted cell is preparing to execute. See the [configuration reference](docs/runtime-reference.md#configuration) for fields, defaults, and full limits.

The host execution provider must use TypeScript. Changing it to another language during reload withdraws the active PTC runtime and reports a diagnostic; returning to TypeScript reactivates it without changing the plugin setting.

![PTC Plus settings window](assets/ptc-plus-settings-en.png)

## Value transfer and state recovery

### Preserve values beyond plain JSON

Within the plugin graph IPC domain, program arguments, results, and recovery records preserve `undefined`, BigInt, `NaN`, infinities, sparse arrays, cycles, and shared references. Ordinary JSON results remain structured values; special values are displayed as readable text to the model, separately from their program values. Return supported values directly without `JSON.stringify`. Plugin-owned isolated `code.run` delivers an actual value graph to the parent while keeping their bindings separate; native delegation keeps its original contract.

This does not extend native `tools.*` JSON argument or result contracts: DSH can still reject BigInt inputs, and explicit `JSON.stringify` and mixed BigInt/Number arithmetic retain native JavaScript behavior. Date, Map and similar values remain usable in live bindings but are outside the current transfer domain; explicitly select the data needed for output. Transfer failures distinguish unsupported values from budget excess. See the [value contract](docs/value-wire.md).

This does not make every JavaScript object transferable or persistent: functions, Promises, class instances, Date, Map, and Set are outside the value-transfer domain. Keeping a function in the REPL for later calls is different from returning that function as a tool result. Reuse session variables for continued computation; see the [value-transfer specification](docs/value-wire.md) for the complete supported domain.

To inspect special values, directly return the needed fields or type observations. Explicit `JSON.stringify` omits object fields containing `undefined`, changes `NaN` and infinities to `null` and `-0` to `0`, and rejects BigInt; choose that format when JSON text is required.

### Recover state with verifiable history

Session state is not permanent memory. After a restart, runtime reset, or context compaction, only state verifiable from session records whose provenance remains in the model's context can be retained. Direct file or network inputs, damaged history, and compacted source provenance can reduce what remains available.

Unverifiable state is discarded with a diagnostic; if necessary, the current computation continues in an empty environment. Recovery neither redispatches recorded native-tool calls nor reverses historical external effects. See the [runtime reference](docs/runtime-reference.md) for recovery evidence and limits.

Subagents reuse continuous computation state from their own session history. When the recoverable range becomes smaller, one full notice is shown; on failure, recovery guidance accompanies the error while console output retains what the code actually printed.

## Boundaries

- **Execution permissions**: primarily designed for `danger-full-access`. Code can access Node.js and the operating system directly; the plugin adds no security sandbox. DSH continues to own native-tool permissions, approvals, cancellation, and sandbox policy.
- **Failures and reruns**: a failed execution does not mean earlier statements had no effect. Process isolation, editing, and recovery do not guarantee that external operations are safe to repeat. Timeouts or output overflow can also release the computation environment.
- **Errors and cost**: language adaptation and call tolerance do not guarantee that every program succeeds. Actual call counts and token usage depend on the task and model; see the [evaluation notes](docs/evaluation.md#recorded-paired-observation) for a recorded comparison and its limitations.

PTC Plus is a community plugin, with no affiliation with or endorsement from DeepSeek or DSH.

## Further reading

[Installation and upgrades](docs/installation.md) · [Global bindings](docs/user-bindings.en.md) · [Runtime reference](docs/runtime-reference.md) · [Architecture and development](docs/architecture.md) · [Verification](docs/verification.md) · [All documentation](docs/README.md)

[MIT License](LICENSE)
