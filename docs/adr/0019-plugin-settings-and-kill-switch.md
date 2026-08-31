# 0019 Plugin Settings UI and Enabled Kill Switch

Date: 2026-05-21 (source snapshot `dsh-v0.1.1-rc.2`)

## Status

Accepted

## Context

PTC Plus 0.1.0 deliberately had no Client UI. The runtime surface was the DSH PTC mode `run_code`/`edit_run_code` transport, and adding a settings bundle was judged not to improve the core REPL path. The plugin also lacked a user-facing way to disable its runtime without removing the Cordis entry, and enabling/disabling state was invisible outside the session log. The operator now wants a plugin settings UI containing every Host Config field, a kill switch, and an explicit enabled marker. `dsh-element-inspector` demonstrates the supported DSH pattern: Host registers a settings namespace and the browser half contributes a card into `settings.plugin.item`. `deepseek-harness-rc2` defines the settings service, client `settingsScope`, and the slot contract.

## Decision

PTC Plus registers one DSH settings namespace `ptc-plus` with the same field list, defaults and validation as the Host Config schema. The field definitions live once in `internal/config-spec.js`; `index.js` builds the Cordis Config schema from it, and the esbuild client bundle imports the same module so the UI does not copy defaults or validation.

The configurable set is the Host runtime configuration plus `enabled: boolean` (default true). `enabled` is the kill switch: when false the Host registers only the settings namespace and keeps the client card available; it does not install the runtime bridge, edit transport, direct-surface owner, system prompt section, tool registrations or session hooks. When true the same runtime as pre-settings PTC Plus is installed. Every field is live when its owner can reconcile it: the Host observes the settings scope and installs, uninstalls, or reconfigures owners without replacing existing session-bound bindings. Node fixes a worker's V8 `maxOldGenerationSizeMb` limit at construction, so changing that field while a session worker is active is rejected and the settings provider is restored to the previous value; other reconfiguration failures use the same compensation path. The TypeScript language check occurs at activation, allowing disabled settings to load on a host using another code runtime while rejecting and rolling back an enable attempt. If the settings service is absent, the Host falls back to composition config and enables the runtime.

Every settings-card string — field labels and hints, header description, enabled state (“已启用/已停用”, or “Enabled/Disabled” in English), expand/collapse name, sync and result messages, and the session indicator tooltip — is registered into the DSH client locale namespace `settings.ptcPlus` and follows the active DSH client locale. Field copy exists in both locales from the single `internal/config-spec.js` source (`label`/`labelEn`, `description`/`descriptionEn`); card chrome copy is owned by the Client half. The stable REPL guidance remains plugin-owned protocol text without UI branding. The tool names remain `run_code`/`edit_run_code`; we do not rename DSH-owned transport names.

Runtime activation is transactional. If a live enable cannot complete, every owner acquired before the failing setup step is disposed, the failure is logged, and the settings provider is asked to persist `enabled: false`; a failed compensating write remains an explicit activation diagnostic rather than an unreported state mismatch.

## Alternatives Considered

1. Keep no Client UI. Rejected: the operator explicitly needs a settings surface and a kill switch. Away from settings, users cannot tell whether PTC Plus is actively installed because the only marker is application behavior.
2. Rely on DSH generic schema rendering without a `settings.plugin.item` card. Rejected: the generic tab renders only namespace cards supplied through the slot; shipping no card would leave the namespace invisible even though the schema is registered.
3. Rename the `run_code` tool or use a schema/name-level UI alias. Rejected: PTC Plus must preserve the DSH host tool names and their public pipeline semantics; presentation labels belong in Client-owned UI, not in transport identity or model-visible stable text.
4. Keep non-`enabled` fields restart-applied. Rejected: a settings UI that persists values without changing the active runtime is misleading. Runtime owners now accept live configuration updates; session kernels keep their bindings while applying new limits and policies to subsequent cells.
5. Keep the card copy Chinese-only, or let the card branch on the browser locale itself. Rejected: the plugin's own copy must follow the same Host-owned locale preference every other settings surface follows, so it registers both dictionaries under `settings.ptcPlus` and uses the `t` seat composed by the DSH slot renderer; duplicating per-locale text outside `internal/config-spec.js` would break the single-source rule for field copy.

## Consequences

The package gains a browser bundle (`src/client.js` → `client.js`), `dsh.client` metadata, a `./client` export and the `@deepseek-ai/dsh-settings` dependency. Host tests must cover the settings-disabled path and the live toggle path. Bundle loading follows DSH's public injected module and slot contracts; it does not advertise a literal DSH compatibility floor. Missing settings service degrades to the previous behavior instead of failing the plugin.
