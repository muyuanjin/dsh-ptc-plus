# Installation

PTC Plus requires Node.js `^22.19.0 || >=24.0.0` and targets the latest available DSH release with TypeScript PTC mode. Historical interface branches are retained through capability detection, without promising a fully verified earlier Host installation; when both generations expose competing presentation evidence, the current DSH contract wins. Compatibility follows those live extension surfaces rather than a version allowlist.

The worker uses the Host's Node executable. Startup verifies native REPL framing, imports, syntax failures, synchronous throws, awaited rejections, and original return values. The adapter combines public eval callbacks with domain error events before REPL formatting; a source-end witness distinguishes empty completion from falsy rejection. A failed or timed-out probe reports a runtime prerequisite failure before user code executes. The engine range follows DSH; CI exercises Node 22.19, 24, and 26, without claiming that untested future releases have already passed.

Install the plugin into the profile that actually runs the target DSH surface. Do not assume a profile named `default` is active.

## Compatibility and Authority

| Component | Current contract |
| --- | --- |
| DeepSeek Harness | Latest available release; validate the live public extension surfaces after every upstream release |
| Runtime | DSH TypeScript PTC mode; cells currently accept modern JavaScript syntax |
| Node.js | `^22.19.0 || >=24.0.0` |
| Platforms | Windows CLI/Desktop and Linux CLI/Web verified locally; macOS package tests and import smoke run in CI, while live DSH integration and Desktop require release-time smoke testing |
| Recommended permission | `danger-full-access` |

`danger-full-access` is the primary supported experience. The worker isolates the REPL lifecycle; it is not a malicious-code sandbox. DSH continues to own native-tool scope, policy, approval, cancellation, sandboxing, and scheduling. Narrower profiles expose only their available capabilities; PTC Plus does not simulate missing authority or add another permission system.

The optional `cordisToolsEnabled` integration requires the current DSH installation to provide its shipped `cordis` preset plus the public preset, Skill, Cordis, settings, and tool-runtime services. PTC Plus declares the shared service packages as unrestricted required peers instead of installing private runtime copies. For a pathless preset it asks the Host's `pluginPackages.packageOf` service for the active generation's official preset package and requires the exact `cordis-plugin-development/SKILL.md` before mounting it; an older generation with no package service may resolve only its historical plural preset package relative to the Host's `ctx.baseUrl`. This compatibility path is disabled whenever `pluginPackages` exists, so packages merely reachable from the plugin profile cannot override an active Host result. Runtime capability validation owns compatibility, and CI loads the packed plugin against frozen official `latest` and `next` DSH graphs. That load step mounts the pathless Cordis companion from a separated active-host resource while a resolvable stale package is present beside the packed plugin, runs `scripts/dsh-execution-seam-smoke.mjs` to exercise public provider composition around the execution service the installed tool runtime uses, and runs `scripts/dsh-rpc-contract-smoke.mjs` to register the packed Remote descriptors with the installed TYPERT registry and evaluate the decoder that generation reads ([ADR 0030](adr/0030-serve-both-typert-codec-generations-from-one-codec.md)); an import alone cannot distinguish a loaded plugin from one whose injection is unsatisfied, because Cordis leaves the latter pending without an error, and it cannot show that the Host accepts a wire contract it validates only at registration. The same suite round-trips argument diagnostics through the selected Host's compressed JSONL Session persistence. Service packages retain the dependency graph selected by their Host distribution rather than independently selecting each service's release tag. DSH's profile module fallback must resolve the peers, while `pluginPackages` identifies the official preset resource from an active installation that publishes the service. Do not copy `SKILL.md` or add the Cordis preset's Skill directory to global roots. If the host surface is incomplete, plugin activation or enabling the setting fails instead of loading a second DSH core.

The plugin attaches to whichever program-execution service the installed DSH registers, and it presents the capabilities of the execution it performs ([ADR 0028](adr/0028-attach-to-the-host-ptc-execution-seam.md)). Cells run in the session kernel under the session's configured budgets, so `run_code` advertises neither a per-call deadline nor a file sandbox, and DSH rejects `timeoutMs` and `sandbox_permissions` with its own message instead of the plugin accepting an input it would then ignore.

Install the complete `cordis.patch.yml` bundle, not only its main plugin row. The bundle preserves the original `ptc-runtime` module and configuration, isolates its `ptcRuntime` service as `ptc-plus-original`, and adds the independent `dsh-ptc-plus/execution-provider` row before the main row. A custom composition must set that provider row's `originalEntryId` to its actual source row ID relative to the provider row's Loader tree (the profile Include subtree in standard installations) and its `isolation` to the same value as the source row's `isolate.ptcRuntime`; keep PTC Plus runtime settings on the main row. The adapter registers its own public provider and never writes to the original instance. Disabling the main row restores native delegation through the adapter; removing the complete bundle also restores the original global service. An uncomposed original produces an explicit composition diagnostic rather than a mutation fallback.

Supported installations use an unmodified official DSH release. Local plugin development packages this checkout. The release development launcher uses the published Host; the opt-in [upstream source launcher](#upstream-source-development-launcher-windows) builds the unmodified official repository for testing unreleased changes. Neither path patches the Host. Missing public layout interfaces remain a feature limitation, not an instruction to customize DSH. See [ADR 0017](adr/0017-track-the-latest-dsh-public-surface.md) for distribution and acceptance requirements.

The Client root requires `slots`, `locale`, `connection`, and `remote`; it adopts whichever public settings transport the installed Host exposes (`configForms` or `settingsScope`) through an optional injection and keeps its shipped `CONFIG_FIELDS` defaults while neither is available, so a renamed or withdrawn transport degrades the settings surface instead of suspending activation. Feature eligibility follows those defaults: only an explicit `enabled: false` withdraws a contribution. Contributions wait for their public slots and consume the supplied session hooks; the composer action additionally requires `remote.commands`. Neither an unused `ui-session` module nor a renamed conversation registry gates activation. Preset selection prefers `agentPreset` projection evidence, falling back only to a historical public session summary field when that projection is absent. Binding values and draft capabilities always require their own projections. No private store or raw-log fallback is used. Slot and provider disposal withdraw the contributions they own.

### Compatibility Evidence

The two frozen dependency graphs are installation cohorts, not proof of two distinct capability generations. `compat/latest/package-lock.json` and the root `package-lock.json` record the releases each smoke actually installs; their channel names do not prove the live npm dist-tags or compatibility with an adjacent earlier release. Both recorded cohorts exercise `ptcRuntime`, `configForms`, `plugins.row.config`, volatile configuration and `codec.create()`. `npm run host:baseline:verify` checks frozen graph consistency, not every historical fallback or current registry availability.

| Retained interface | Evidence and consequence of removal |
| --- | --- |
| `retainedBy.mainView`, `plugins.row.config`, volatile updates, `codec.create()`, composer props carrying their own `sessionId` | Required by the frozen graphs; these are current paths, not optional historical fallbacks. |
| `settingsScope`, `settings.plugin.item`, section-installer variants | Historical, unfrozen Host shapes, covered with fixtures. Removal loses their live settings, card seat or reconfiguration path. |
| `snapshot.current`, bare summary `agentPreset` | Historical, unfrozen selection and preset shapes. Removal can strand their session-specific views or PTC eligibility. Binding and draft evidence never use the preset fallback. |
| Historical icon names and missing primitives | Fixtures establish component fallback, not a complete earlier Client. Removal of icon candidates loses native glyphs; usable text/component fallbacks must remain. |
| Menu without a `children` region | Rendering probe plus a plugin-owned fallback. Removal makes binding actions unreachable on that historical primitive; JSX is not passed through the Host's string-only label field. |
| `codec.schema` | Historical, unfrozen registry shape. Removal rejects Remote registration on schema-only Hosts. The factory and schema share one decoder. |
| `codeRuntime.run(request)` | Historical, unfrozen execution shape. Removal leaves that Host without a session REPL attachment. Fixture tests preserve it; both frozen graphs exercise resolve/run instead. |
| Plural preset-package layout and Host-anchored resolution | Historical Hosts without `pluginPackages` need this companion-resource path. Removal breaks their Cordis companion; it must never override an available active-Host package service. |
| `sessionQuery.observeSession` and host-only `sessionProjections` | Current history and presentation owners; missing services are diagnosed, not treated as empty recovery evidence. The projection publishes no Client wire view. |
| Legacy session event arrays and V0 boundary migration | Read-only fixtures preserve historical ancestry and file conversion through the shared event transition. Removal can discard reconstructable older sessions; malformed arrays are diagnosed, and format conversion does not prove a complete older Host's live behavior. |

Capabilities select behavior, never a release number. Historical fixture success is not packed-Host evidence. Full Host smoke is bounded to its selected graph, and a clean build is not live browser activation. Public provider composition supports frozen original execution instances without changing their descriptors. Two integration boundaries are accepted: the result bridge requires mutable registered tool definitions ([ADR 0028](adr/0028-attach-to-the-host-ptc-execution-seam.md)), and the two-tool model projection retains a complete native registry and SDK through scoped `both` presentation plus assembly projection ([ADR 0005](adr/0005-temporary-rejected-cell-edit-transport.md)). Proven native miscalls are normalized before Host dispatch; an unnormalized root call can reach approval before the plugin rejects it. Frozen tool definitions remain unsupported. Acceptance preserves current behavior and DSH governance; it does not claim that the missing public metadata or independent direct-admission contracts have been implemented.

## npm Release

Use this form after the selected version is available from the npm registry:

```sh
dsh plugin --profile <profile> add dsh-ptc-plus@0.4.10
dsh --profile <profile> --dump-config
```

Until then, use a pinned Git revision, source checkout, or tarball.

## Pinned Git Revision

The repository ships runnable JavaScript and does not require a build step:

```sh
dsh plugin --profile <profile> add github:muyuanjin/dsh-ptc-plus#COMMIT_SHA
dsh --profile <profile> --dump-config
```

Replace `COMMIT_SHA` with a reviewed commit.

## Source Checkout

```sh
git clone https://github.com/muyuanjin/dsh-ptc-plus.git
cd dsh-ptc-plus
dsh plugin --profile <profile> add .
dsh --profile <profile> --dump-config
```

When DSH itself runs from a source checkout, use its launcher:

```sh
pnpm dsh plugin --profile <profile> add /absolute/path/to/dsh-ptc-plus
pnpm dsh --profile <profile> --dump-config
```

## Tarball

```sh
npm pack
dsh plugin --profile <profile> add /absolute/path/to/dsh-ptc-plus-0.4.10.tgz
dsh --profile <profile> --dump-config
```

Windows development checkouts can create and install an immutable content-addressed snapshot. The profile defaults to `web` when omitted:

```bat
scripts\install-dev.cmd <profile>
```

Installation and a successful Host import do not prove browser activation. Run the model-free packed Web smoke from this checkout with the latest DSH installed, its `pnpm` available, and a Playwright browser:

```sh
npx playwright install chromium
npm run test:client:web -- --dsh-entry /absolute/path/to/dsh/lib/bin.js
```

On Windows, `--browser-channel msedge` can use the existing Edge installation. The script packs the current source, installs the tarball through `dsh plugin` into a temporary `DSH_HOME`, starts Web on a free loopback port, and opens the conversation and PTC Plus settings surfaces. It closes its browser/Host and removes the temporary profile; screenshots and release evidence remain under ignored `artifacts/client-web-smoke/`. It makes no model request and does not use or update the normal profile. `npm run test:client` supplies the deterministic provider, renderer, projection, and disposal tests included in `verify`/`check`.

## Isolated latest-DSH development launcher

To test this checkout in a separate DSH installation, double-click `scripts\run-dev-dsh.cmd`. It orders all published DSH releases by semantic version, prereleases included, and selects the newest release whose complete dependency cohort npm can install, rather than following a dist-tag that a release can leave behind. If a newly published root package still has missing exact-version dependencies, the launcher warns and tries the preceding release; an explicit `DSH_DEV_VERSION` remains exact and fails instead of falling back. It installs only when the selected cached version changes, creates the shipped `web` profile inside an isolated `DSH_HOME`, installs this checkout, and starts DSH. When no port is supplied, the default Web profile reuses its cached loopback port while that port is available; an invalid cache entry or occupied port is replaced with a free port. This keeps browser authentication stable across ordinary restarts without blocking another DSH on port 3080. The launched Host receives a 64 KiB HTTP request-header limit while retaining existing Node options to accommodate development authentication cookies and the combined Client plugin request during Web boot. The launcher does not modify the repository or your normal DSH home.

The launcher defaults to `https://registry.npmjs.org/` for version queries, npm installs and DSH's pnpm subprocesses, including the `@deepseek-ai` scope. This avoids mirror synchronization gaps where a new DSH package is available before its dependencies. It prints the selected registry and refreshes version metadata online; an unavailable version query can still reuse the previously cached version. Set `DSH_DEV_REGISTRY` to an absolute HTTP(S) registry URL to select another source explicitly. The choice applies only to the launcher process and its children; npm configuration files and persistent environment settings are unchanged. Other explicitly configured package scopes retain their own registries.

The default cache is `%LOCALAPPDATA%\dsh-ptc-plus-dev`. It contains the isolated `DSH_HOME`, DSH installations, immutable plugin snapshots, and a pnpm store. Cleanup aims to retain three DSH versions and plugin snapshots, always including the selected installation and snapshot even when another directory has a newer timestamp. Locked directories warn and remain for a later cleanup attempt; their installation marker is removed before deletion so partially deleted or failed installations cannot be reused. Failed pnpm store pruning also warns and continues startup. Failure of every published candidate, or of an explicitly selected version, stops the launcher. Set `DSH_DEV_CACHE` to move the cache, `DSH_DEV_PROFILE` to change the profile name, `DSH_DEV_VERSION` to pin an npm dist-tag or version instead of the newest installable published release, `DSH_DEV_PORT` to choose a fixed Web port, or `DSH_DEV_MAX_VERSIONS` to change the retention count (1-10).

The Windows launchers normalize the process, machine, and user `PATH` values in memory, remove duplicate entries, and add the Node/cache directories they need. They do not create drive mappings, junction trees, or persistent environment changes. If a genuinely unique PATH is still too long for `cmd.exe`, the launcher stops before npm or DSH runs and asks you to shorten the relevant PATH value.

### Upstream source development launcher (Windows)

Double-click `scripts\run-upstream-dsh.cmd` to test unreleased official DSH code with this plugin checkout. Git, Node.js and npm must be on the Windows PATH. The launcher fetches the official repository's default-branch HEAD, prints its full commit, installs the exact pnpm declared by that commit, and follows the official `pnpm install --frozen-lockfile`, `pnpm run build`, and `pnpm run dsh` source workflow. It does not patch upstream source. First startup can take several minutes and substantial disk space; upstream build prerequisites and failures remain visible.

The source launcher shares plugin packaging, profile selection and port handling with `run-dev-dsh.cmd`, but uses an `upstream` subdirectory of the development cache. Its DSH home, profiles, authentication, pnpm store and build snapshots are separate from the release launcher and your normal DSH installation. `DSH_DEV_CACHE`, `DSH_DEV_REGISTRY`, `DSH_DEV_PROFILE`, `DSH_DEV_PORT`, and `DSH_DEV_MAX_VERSIONS` apply; `DSH_DEV_VERSION` does not select source commits. For example:

```bat
scripts\run-upstream-dsh.cmd web --no-open
```

Each build cache key includes the full commit, Node version/platform/architecture/ABI, upstream pnpm declaration, registry and inherited `DSH_CLIENT_*` / `DSH_BUILD_*` environment. A successful build is marked only after its CLI version check succeeds. Unchanged inputs reuse that build; failed builds have no completion marker and are retried. Tracked changes or a different HEAD in a completed checkout stop startup instead of overwriting edits. An interrupted initial checkout can be recreated on the next run.

A failed fetch warns and uses the last fetched commit if available; it never labels that fallback as current upstream HEAD. A failed install or build stops startup instead of silently launching an older successful revision. The launcher holds an exclusive OS file lock through Host shutdown, so another launch using the same cache fails clearly. The lock releases when the process exits; the remaining `source.lock` file is harmless and should not be removed to bypass a running process.

Cleanup retains the configured number of build snapshots and plugin tarballs (three by default), including the selected ones. Locked cleanup targets warn and are retried later. Git objects, exact pnpm runtimes and the shared pnpm store are retained to speed later revisions; their size is not bounded by the snapshot count. With this source launcher stopped, delete `upstream\builds` to force fresh builds while retaining downloads; remove `upstream\pnpm-store` as well to reclaim the shared download cache. The generated CMD shims use launcher-process environment variables to preserve Unicode paths and are not standalone entry points. Do not delete `upstream\dsh-home` unless you intend to remove this test environment's settings and sessions.

This is an opt-in upstream test environment. Published-release compatibility remains the plugin's supported delivery target.

## DSH Desktop

On Windows or macOS, choose **Open DSH Terminal** from the Desktop tray. Bare commands in that terminal target the active profile:

```sh
dsh plugin add github:muyuanjin/dsh-ptc-plus#main
dsh --dump-config
```

After an npm release, the package spec may instead be `dsh-ptc-plus@0.4.10`. For a local package, use its absolute tarball path. Restart DSH Desktop after installation. Linux Desktop is not a current DSH Desktop release target; use DSH CLI/Web on Linux.

## Upgrades

PTC Plus upgrades independently of the host. Replace the installed package with the new release the same way it was installed — `npm install dsh-ptc-plus@latest`, a new tarball, or an updated pinned Git revision in the profile patch — and restart the host so every profile reloads the plugin. The plugin never patches DSH and never requires a custom host build, so a host upgrade keeps the plugin working as long as the public surfaces it needs are still published.

Your settings document and session logs are not rewritten by an upgrade. A release that adds a configuration field applies its documented default until you choose a value. A release that raises the Session format generation requires the migration below before an older log is opened by the new Host; the plugin reports that condition instead of rewriting history on its own.

## Troubleshooting

Start from the exact diagnostic: every message below names the surface that is missing, and the plugin keeps the rest of its behavior intact while the condition holds.

- `ptc-plus: no host execution seam (ptcRuntime or codeRuntime) is registered` — the profile publishes no DSH code runtime, or that entry failed to activate. Repair or enable the runtime row and reload; the plugin attaches as soon as the service appears.
- PTC Plus says the settings service is unavailable, and its indicator and sparkle button are missing — a retained plugin dependency may lack the schema capability required by the current Host. Reinstall the current plugin package and restart DSH; the dependency range requires a builder that supports live settings. The development launcher performs that installation on its next launch. This message alone does not prove that runtime execution is disabled. A missing required `volatile()` builder now produces an explicit dependency diagnostic during plugin loading.
- `ptc-plus: Cordis companion tooling withdrew from an agent scope` — an exposed companion service, preset, Skill or child fiber failed its required contract. Repair the specific cause attached to the warning, or disable `cordisToolsEnabled` if that integration is unavailable. A scope missing optional companion surfaces instead waits silently and retries when its tool surface changes or its next prompt is assembled.
- A commit is refused with a verification or proof error — follow [deterministic verification](verification.md): resolve any incomplete lanes shown by `npm run review:status`, run `npm run check` on the frozen tree, then `npm run review:finalize`. Stage that verified candidate and retry. Use `npm run hooks:install` if the hook is missing; never bypass it.
- A historical PTC session cannot be resumed — follow the Session format upgrade below, keep the original log, and report the exact refusal message.

## Session format upgrades

The public DSH Session format catalog can renumber events when converting historical assistant streams. It treats plugin result metadata as opaque, so its automatic conversion alone cannot preserve PTC sequence references. Before opening historical PTC sessions in the new Host, stop the processes using that profile and retain a backup of each original log.

From this source checkout, convert a standalone source artifact with the destination Host's public catalog. An empty child set must be explicit:

```sh
npm run session:migrate -- --dsh-entry /path/to/dsh/lib/bin.js --no-children --input /backup/session.jsonl --output /staging/session.v2.jsonl
```

For a parent session, pass `--child-facts /backup/child-facts.json` instead. The JSON file must be the complete array of direct-child evidence produced through the selected Host's public historical catalog and child-fact APIs. Do not use `--no-children` merely because child artifacts are unavailable: newer format migrations use those facts to preserve or reconstruct the parent's child catalog and deliberately refuse to guess. Current-format inputs need neither option because no historical body migration runs.

The output header and command report identify the actual target **Session format**, independent of the DSH package version. Use the corresponding canonical filename `session.v<N>.jsonl` in that session's existing directory. Match the persistence provider's encoding: `.zstd` input/output uses the `zstd` executable, with separate header and event frames. The example names format 2; use the format reported by the selected catalog. Only place the validated output in the stopped profile after inspecting it. Keep the predecessor artifact for rollback; do not continue editing the same history through old and new Hosts in parallel.

The converter verifies that ordered tool records retain their normalized call arguments, result content, error status, PTC metadata, and recorded effects while allowing the public Host migration to update generation-specific message envelopes. It maps journal confirmations, edit targets and recovery boundaries, then revalidates the output. Input files are never overwritten, including through hard links; existing destinations require explicit `--force`. A current-format source needs no output. A Host without the public catalog cannot perform Host format conversion.

Already converted logs with stale PTC references cannot be repaired from their numeric values alone: use the original predecessor or backup. Preserve any newer activity separately. Logs containing retired `ptc-plus/recovery-boundary` events are refused by Host format conversion; the existing command without `--dsh-entry` remains the separate retired-event converter. That converter accepts only Session format 0 with a contiguous zero-based source log and, before writing, validates PTC recovery plus every sequence relation in that frozen Host vocabulary, including surface replacements, command sources, title sources and compaction shadows. It also subtracts removed boundary events from a seeded session's exact inherited-prefix cut. A different source format, missing, removed, forward, duplicate, wrong-kind or semantically inconsistent relation leaves the source unchanged and produces no output. Run the retired-event conversion first, then use its validated output as the input to any Host format upgrade. The migration tool does not modify a running persistence queue or silently repair unproved history.
