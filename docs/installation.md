# Installation

PTC Plus requires Node.js `^22.19.0 || >=24.0.0` and targets the latest available DSH release with TypeScript PTC mode. Compatibility with the preceding Host contract is retained through public capability detection; when both generations expose competing presentation evidence, the current DSH contract wins. Compatibility follows those live extension surfaces rather than a version allowlist.

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

The optional `cordisToolsEnabled` integration requires the current DSH installation to provide its shipped `cordis` preset plus the public preset, Skill, Cordis, settings, and tool-runtime packages. PTC Plus declares those host-owned DSH packages as unrestricted required peers instead of installing private runtime copies; runtime capability validation owns compatibility, and CI loads the packed plugin inside complete stable and alpha DSH installations. That load step runs `scripts/dsh-execution-seam-smoke.mjs`, which reads the execution service the installed tool runtime reads and requires the plugin to take it over, and `scripts/dsh-rpc-contract-smoke.mjs`, which registers the packed Remote descriptors with the installed TYPERT registry and evaluates the decoder that generation reads ([ADR 0030](adr/0030-serve-both-typert-codec-generations-from-one-codec.md)); an import alone cannot distinguish a loaded plugin from one whose injection is unsatisfied, because Cordis leaves the latter pending without an error, and it cannot show that the Host accepts a wire contract it validates only at registration. Service packages retain the dependency graph selected by their Host distribution rather than independently selecting each service's release tag. DSH's profile module fallback must resolve the peers from the active installation. Do not copy `SKILL.md` or add the Cordis preset's Skill directory to global roots. If the host surface is incomplete, plugin activation or enabling the setting fails instead of loading a second DSH core.

The plugin attaches to whichever program-execution service the installed DSH registers, and it presents the capabilities of the execution it performs ([ADR 0028](adr/0028-attach-to-the-host-ptc-execution-seam.md)). Cells run in the session kernel under the session's configured budgets, so `run_code` advertises neither a per-call deadline nor a file sandbox, and DSH rejects `timeoutMs` and `sandbox_permissions` with its own message instead of the plugin accepting an input it would then ignore.

Every installation path uses an unmodified official DSH distribution. Local plugin development packages this checkout; it does not build, patch, or substitute the Host. Missing public layout interfaces remain a feature limitation, not an instruction to customize DSH. See [ADR 0017](adr/0017-track-the-latest-dsh-public-surface.md) for distribution and acceptance requirements.

The Client root requires `settingsScope`, `slots`, `locale`, and `connection`. Contributions wait for their public slots and consume the supplied session hooks; the composer action additionally requires `remote.commands`. Neither an unused `ui-session` module nor a renamed conversation registry gates activation. Preset selection prefers `agentPreset` projection evidence, falling back only to the preceding public session summary field when that projection is absent. Binding values and draft capabilities always require their own projections. No private store or raw-log fallback is used. Slot and provider disposal withdraw the contributions they own.

## npm Release

Use this form after the selected version is available from the npm registry:

```sh
dsh plugin --profile <profile> add dsh-ptc-plus@0.4.2
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
dsh plugin --profile <profile> add /absolute/path/to/dsh-ptc-plus-0.4.2.tgz
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

To test this checkout in a separate DSH installation, double-click `scripts\run-dev-dsh.cmd`. It resolves the newest published DSH release by semantic version over all published versions, prereleases included, rather than following a dist-tag that a release can leave behind; it installs that exact version only when the cached version changes, creates the shipped `web` profile inside an isolated `DSH_HOME`, installs this checkout, and starts DSH. When no port is supplied, the default Web profile reuses its cached loopback port while that port is available; an invalid cache entry or occupied port is replaced with a free port. This keeps browser authentication stable across ordinary restarts without blocking another DSH on port 3080. The launched Host receives a 64 KiB HTTP request-header limit while retaining existing Node options to accommodate development authentication cookies and the combined Client plugin request during Web boot. The launcher does not modify the repository or your normal DSH home.

The launcher defaults to `https://registry.npmjs.org/` for version queries, npm installs and DSH's pnpm subprocesses, including the `@deepseek-ai` scope. This avoids mirror synchronization gaps where a new DSH package is available before its dependencies. It prints the selected registry and refreshes version metadata online; an unavailable version query can still reuse the previously cached version. Set `DSH_DEV_REGISTRY` to an absolute HTTP(S) registry URL to select another source explicitly. The choice applies only to the launcher process and its children; npm configuration files and persistent environment settings are unchanged. Other explicitly configured package scopes retain their own registries.

The default cache is `%LOCALAPPDATA%\dsh-ptc-plus-dev`. It contains the isolated `DSH_HOME`, DSH installations, immutable plugin snapshots, and a pnpm store. Cleanup aims to retain three DSH versions and plugin snapshots, always including the selected installation and snapshot even when another directory has a newer timestamp. Locked directories warn and remain for a later cleanup attempt; their installation marker is removed before deletion so partially deleted installations cannot be reused. Failed pnpm store pruning also warns and continues startup. Installation errors still stop the launcher. Set `DSH_DEV_CACHE` to move the cache, `DSH_DEV_PROFILE` to change the profile name, `DSH_DEV_VERSION` to pin an npm dist-tag or version instead of the newest published release, `DSH_DEV_PORT` to choose a fixed Web port, or `DSH_DEV_MAX_VERSIONS` to change the retention count (1-10).

The Windows launchers normalize the process, machine, and user `PATH` values in memory, remove duplicate entries, and add the Node/cache directories they need. They do not create drive mappings, junction trees, or persistent environment changes. If a genuinely unique PATH is still too long for `cmd.exe`, the launcher stops before npm or DSH runs and asks you to shorten the relevant PATH value.

## DSH Desktop

On Windows or macOS, choose **Open DSH Terminal** from the Desktop tray. Bare commands in that terminal target the active profile:

```sh
dsh plugin add github:muyuanjin/dsh-ptc-plus#main
dsh --dump-config
```

After an npm release, the package spec may instead be `dsh-ptc-plus@0.4.2`. For a local package, use its absolute tarball path. Restart DSH Desktop after installation. Linux Desktop is not a current DSH Desktop release target; use DSH CLI/Web on Linux.

## Session format upgrades

The public DSH Session format catalog can renumber events when converting historical assistant streams. It treats plugin result metadata as opaque, so its automatic conversion alone cannot preserve PTC sequence references. Before opening historical PTC sessions in the new Host, stop the processes using that profile and retain a backup of each original log.

From this source checkout, convert a source artifact with the destination Host's public catalog:

```sh
npm run session:migrate -- --dsh-entry /path/to/dsh/lib/bin.js --input /backup/session.jsonl --output /staging/session.v2.jsonl
```

The output header and command report identify the actual target **Session format**, independent of the DSH package version. Use the corresponding canonical filename `session.v<N>.jsonl` in that session's existing directory. Match the persistence provider's encoding: `.zstd` input/output uses the `zstd` executable, with separate header and event frames. The example names format 2; use the format reported by the selected catalog. Only place the validated output in the stopped profile after inspecting it. Keep the predecessor artifact for rollback; do not continue editing the same history through old and new Hosts in parallel.

The converter verifies that ordered tool records retain their identities, maps journal confirmations, edit targets and recovery boundaries, and revalidates the output. It leaves original model arguments, source, results and recorded effects unchanged. Input files are never overwritten, including through hard links; existing destinations require explicit `--force`. A current-format source needs no output. A Host without the public catalog cannot perform Host format conversion.

Already converted logs with stale PTC references cannot be repaired from their numeric values alone: use the original predecessor or backup. Preserve any newer activity separately. Logs containing retired `ptc-plus/recovery-boundary` events are refused by Host format conversion; the existing command without `--dsh-entry` remains the separate retired-event converter, whose output needs validation before a further upgrade. The migration tool does not modify a running persistence queue or silently repair unproved history.
