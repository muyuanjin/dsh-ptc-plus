<p align="center">
  <img src="assets/dsh-ptc-plus-banner-en.webp" width="100%" alt="PTC Plus">
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

**Stateful computation across a DSH PTC session, with less repeated setup and fewer avoidable tool-call errors.**

PTC Plus uses a TypeScript REPL to keep variables, functions, imports, and intermediate results available across model tool calls. It adapts declarations, module syntax, and code revision for continuous computation, so the model can keep using familiar names without getting stuck on redeclarations, omitted call fields, or small syntax mistakes.

- **Keep computing**: reuse data already loaded and processed in the session.
- **Revise directly**: update a variable or function under the same name; existing closures read the updated binding. Small changes can be sent as code deltas.
- **Avoid routine call failures**: use familiar module syntax, recover from identifiable call omissions, and receive correction suggestions for verifiable syntax errors.

[Computation example](#computation-example) · [Quick start](#quick-start) · [Fewer tool-call errors](#fewer-tool-call-errors) · [Settings and extensions](#settings-and-extensions) · [Boundaries](#boundaries)

## Computation example

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

The default **stateful semantics** allow variables, functions, classes, and import bindings in the same scope to be updated, including bindings declared with `const`. Blocks, functions, and loop iterations retain their separate scopes. Familiar JavaScript/TypeScript syntax is supported, with extended binding rules for continued revision. To detect name overwrites instead, disable **Allow redeclarations and overrides** in settings.

## Quick start

Requires Node.js `^22.19.0 || >=24.0.0` and the latest available official DSH release. Install into the profile you actually use:

```sh
dsh plugin --profile <profile> add dsh-ptc-plus
```

Replace `<profile>` with your profile name. Restart DSH and select **PTC mode** in the session. Stateful computation and call tolerance are enabled by default.

With the default interface settings, the session has a **REPL** tab; wide screens also show a green **PTC Plus** header indicator. The sparkle button beside the composer opens **PTC Plus settings** and the global binding menu. You can also open **Plugins → Installed → dsh-ptc-plus → Configure** in the sidebar to check the main switch and all plugin settings.

See the [installation guide](docs/installation.md) for other installation methods, Desktop, the local development launcher, upgrades, and troubleshooting.

## Fewer tool-call errors

### Familiar code works directly

Cells support TypeScript, top-level `await` / `return`, and static `import` / `export`. Redeclarations can revise an existing computation. When initialization fails, names that were not successfully established do not permanently block later declarations. The model can also use `capabilities.find` / `inspect` to look up current tools and their parameters as needed.

<details>
<summary>When static imports and local overrides take effect</summary>

Static imports take effect **before the entire cell body executes**. Assignments and ordinary declarations in the body can then override them. A static import in a later cell restores the binding's live module source. Writing an import below an ordinary declaration in the same cell does not restore it at that textual position. To retrieve the current exported value at a particular step, assign it explicitly:

```ts
join = (await import('node:path')).join
```

This captures the function value at that moment; a static import follows its module source. See the [runtime reference](docs/runtime-reference.md#cell-semantics) for more language rules.

</details>

### Recover from identifiable call problems

| Situation | PTC Plus behavior |
| --- | --- |
| `run_code` omits its outer `description` | Supply a display summary so code with otherwise valid arguments can execute |
| The model calls a native tool outside the PTC direct-tool list | Convert it to the corresponding `run_code` when current tool definitions uniquely identify the target and validate the arguments |
| Code fails to parse | Identify the source position; at EOF, suggest a target-bound edit if appending one or two closing delimiters has exactly one validated correction |

The first two behaviors default to on and can be disabled in settings. Syntax suggestions do not execute automatically or establish that the code matches the task's intent.

### Send only the change

The model can use `edit_run_code` to change the most recent editable cell in the current turn without resending its complete source. For example, change the second cell's filter to `value >= 10`:

```js
edit_run_code({
  edits: [{ old_string: 'value >= 8', new_string: 'value >= 10' }]
})
```

An edit **reruns the entire cell**; this example returns `12`. Earlier state changes are not rolled back. If the code writes files or calls external services, rerunning still requires considering duplicate effects.

## Settings and extensions

Core computation features work with the defaults. The plugin configuration page provides settings for binding updates, call tolerance, recovery, interface display, and resource limits. Global bindings and the sparkle shortcut default to on; **PTC Plus settings** in that menu opens the same settings. Explicitly disabled options in an existing configuration stay disabled. The [configuration reference](docs/runtime-reference.md#configuration) lists fields, defaults, and limits.

**Inspect session state.** The REPL tab lets you search retained bindings, inspect their definitions, and view bounded value previews. Incomplete or unreadable previews are identified explicitly; display does not invoke user getters.

<details>
<summary>View the REPL interface</summary>

![Session state and the global binding workbench in the REPL tab](assets/ptc-plus-repl-workspace-en.png)

</details>

**Reuse helpers across sessions.** Global User Bindings default to on. Save TypeScript helpers and provide their interfaces and usage instructions to the model. The sparkle menu lists entries and lets you toggle them. You can also ask the Agent to author a helper:

```text
/binding new Create textTools to trim outer whitespace while preserving interior spaces
```

The submitted draft appears above the composer for you to review, save, and optionally enable. The workbench can run unsaved code with temporary computation state separate from the Agent session. See the [global binding guide](docs/user-bindings.en.md).

**Extend the available tools.** Optional official Cordis tool integration defaults to off and supports inspecting or developing DSH plugins. See the [integration notes](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md).

## Boundaries

- **Execution permissions**: primarily designed for `danger-full-access`. Code can access Node.js and the operating system directly; the plugin adds no security sandbox. DSH continues to own native-tool permissions, approvals, cancellation, and sandbox policy.
- **State retention**: session state is not permanent memory. After a restart, runtime reset, or context compaction, only state that can be verified from the session record and remains known to the model can be retained. Recovery neither redispatches recorded native-tool calls nor reverses historical external effects.
- **Errors and cost**: language adaptation and call tolerance do not guarantee that every program succeeds. Actual call counts and token usage depend on the task and model; see the [evaluation notes](docs/evaluation.md#recorded-paired-observation) for a recorded comparison and its limitations.

PTC Plus is a community plugin, with no affiliation with or endorsement from DeepSeek or DSH.

## Further reading

[Installation and upgrades](docs/installation.md) · [Global bindings](docs/user-bindings.en.md) · [Runtime reference](docs/runtime-reference.md) · [Architecture and development](docs/architecture.md) · [Verification](docs/verification.md) · [All documentation](docs/README.md)

[MIT License](LICENSE)
