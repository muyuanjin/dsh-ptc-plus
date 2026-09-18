# Global binding guide

[简体中文](user-bindings.md) · English

Global bindings save reusable TypeScript helpers for use across sessions. For example, a binding named `textTools` lets the model call `textTools.clean(text)` inside `run_code`.

## Create and use a binding

1. Open the PTC Plus settings card (current DSH: the plugin's **Configure** on the side-bar **Plugins** page; preceding DSH: **Settings → Plugin configuration → PTC Plus**) and enable **Global User Bindings**.
2. In a PTC session, open the sparkle menu by the composer and choose **Write a new binding**, or enter `/binding new <requirement>`.
3. Inspect the draft's source, interface, and model prompt in the panel above the composer.
4. Choose **Save and enable**. Subsequent `run_code` calls load the binding; initialization failures appear in execution results.

During authoring, the Agent starts with a small in-memory check of the core behavior, then adds normal, edge, and failure assertions with `node:assert/strict`. Bulk tests report totals and a few representative failures instead of printing every successful case into the context. Tests must not modify external files or services. File and network helpers use in-memory substitutes to verify argument forwarding and error propagation; the answer identifies integration behavior that remains untested. Submission delivers a draft for your review. You decide whether to save and enable it.

To revise a saved binding, use `/binding edit <id> <requirement>`. Its storage `id`, shown in the workbench, may differ from its call name. You can also select the Agent editing action from the binding list.

## Draft panel

A new draft opens above the composer. Click the title bar or use Enter/Space to collapse and expand it. Long content scrolls inside the panel.

- **Save as disabled**: keep the entry in the global list without loading it.
- **Save and enable**: save it and allow subsequent calls to load it.
- **Discard draft**: abandon this unsaved candidate.
- **Close panel**: hide it without saving or discarding.

The sparkle button shows a PTC Plus tooltip on hover or focus that names it as the Global User Binding entry; a pending draft changes the tooltip to the draft state. The button shows a badge for pending drafts. Open its menu by hovering, clicking, or using the keyboard, then select the draft to show it again. Each session retains one current candidate. A confirmed save or discard closes the panel; failures leave the draft available for retry.

The sparkle menu is available before the first message, and opens once the pointer dwells on the entry: crossing the composer no longer drops a menu over it. A hovered menu closes as soon as the pointer leaves it; clicking keeps it open until you click again, click elsewhere, or press Escape. Global bindings show their names, purposes, and enabled states using text and a checkmark. Click an entry to toggle it for all sessions. The catalog refreshes in the background, and the entries stay usable while it does; toggles are disabled only while saving, and reload after a conflict or failure before trying again. **Manage global bindings** opens the full workbench. **Write a new binding** and **Revise a binding** appear when the authoring command is available; the revision step lists existing entries and prefills `/binding edit <id> `. The reusable REPL binding list shows how many later cells reused each binding, with the total in the section title; the count comes from static references in each later cell's compiled source, and a redeclaration counts as neither a reuse nor a reset of the accumulated count.

The original binding request retains its requirement, status, and accepted source in history. Historical inspection does not restore permission to save that draft. When another edit changes the catalog, reload its current state before deciding whether to save.

## Interface and model prompt

Each entry has two independent settings:

| Setting | Purpose |
| --- | --- |
| Include interface declaration for the model | On by default. Names, parameters, return types, and API comments come from source; no separate declaration is needed |
| Prompt for the model | Optional. Add usage conditions, input constraints, or examples missing from the types |

For example, a size formatter might add: “Input is in bytes; display using IEC units.” Usage already clear from the interface need not be repeated.

The model receives one line identifying `run_code` and the updated API reference, followed by entry names, configured prompts and selected interfaces. Ordinary calls do not resend unchanged documentation.

Omitting the interface leaves a separate prompt available. Omitting both does not disable execution. Enabled entries are described from the first request in a new session. Saving, enabling, disabling, deleting, or editing an entry updates the next permitted request. DSH runtime-context suppression defers delivery.

Changing only the prompt, interface switch, purpose, or top-level display name preserves loaded module state. Changing implementation source, scope, namespace call name, or selected exports reloads the module on subsequent execution.

## Manual management and testing

Open **Manage global bindings** in settings or use the session's **REPL** tab. Manual creation, `.ts` import, interface inspection, editing, enablement, and removal are available without an active PTC session.

Source must be a TypeScript module with named value exports. Default exports and re-exports are unsupported. `namespace` exposes selected exports under one object; `top-level` exposes them directly. Leaving the export list empty selects all named value exports. Conflicting names are rejected before enablement.

The code console runs the entry's unsaved source draft. It supports top-level `await` and retains temporary variables between commands. Its state is separate from the Agent session, but it has the same process permissions: file and network operations you run have real effects. Stopping, resetting, switching entries, or leaving the workbench releases the environment. After source changes, the next execution starts fresh. Ten minutes without execution also releases it while preserving the displayed input and output history.

Bindings are stored in `$DSH_HOME/ptc-plus/bindings.json`. Relative imports in binding modules resolve from that file's directory; ordinary session REPL imports resolve from the session's project directory.

## Limits

Enabled configuration allows loading but does not guarantee successful initialization. Assigning or redeclaring a same-name variable can override the global default in the current session without modifying its saved entry.

Restart recovery retains only verifiable session state. External files and services may have changed. Recovery does not repeat historical tool operations; diagnostics identify state that could not be recovered. See the [runtime reference](runtime-reference.md#global-user-bindings) for source formats, resource limits, and recovery, and [Client UI](client-ui.md) for workbench details.
