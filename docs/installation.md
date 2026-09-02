# Installation

PTC Plus requires Node.js `^22.19.0 || >=24.0.0` and targets the latest available DSH release with TypeScript PTC mode. Compatibility with the preceding Host contract is retained through public capability detection; when both generations expose competing presentation evidence, the current DSH contract wins. Compatibility follows those live extension surfaces rather than a version allowlist.

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

The optional `cordisToolsEnabled` integration requires the current DSH installation to provide its shipped `cordis` preset plus the public preset, Skill, Cordis, settings, and tool-runtime packages. PTC Plus declares those host-owned DSH packages as unrestricted required peers instead of installing private runtime copies; runtime capability validation owns compatibility, and CI imports the packed plugin against both the current and preceding release channels. DSH's profile module fallback must resolve the peers from the active installation. Do not copy `SKILL.md` or add the Cordis preset's Skill directory to global roots. If the host surface is incomplete, plugin activation or enabling the setting fails instead of loading a second DSH core.

## npm Release

Use this form after the selected version is available from the npm registry:

```sh
dsh plugin --profile <profile> add dsh-ptc-plus@0.2.4
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
dsh plugin --profile <profile> add /absolute/path/to/dsh-ptc-plus-0.2.4.tgz
dsh --profile <profile> --dump-config
```

Windows development checkouts can create and install an immutable content-addressed snapshot. The profile defaults to `web` when omitted:

```bat
scripts\install-dev.cmd <profile>
```

## Isolated latest-DSH development launcher

To test this checkout in a separate DSH installation, double-click `scripts\run-dev-dsh.cmd`. It resolves the current `@deepseek-ai/dsh@alpha` dist-tag, installs that exact version only when the cached version changes, creates the shipped `web` profile inside an isolated `DSH_HOME`, installs this checkout, and starts DSH. If no port is supplied, it selects a free loopback port automatically, so another DSH on port 3080 does not block the test instance. The launcher does not modify the repository or your normal DSH home.

The default cache is `%LOCALAPPDATA%\dsh-ptc-plus-dev`. It contains the isolated `DSH_HOME`, DSH installations, immutable plugin snapshots, and a pnpm store. Only the newest three DSH versions and plugin snapshots are retained, and the dedicated pnpm store is pruned after each install. Set `DSH_DEV_CACHE` to move the cache, `DSH_DEV_PROFILE` to change the profile name, `DSH_DEV_VERSION` to select another npm dist-tag or version, `DSH_DEV_PORT` to choose a fixed Web port, or `DSH_DEV_MAX_VERSIONS` to change the retention count (1-10).

## DSH Desktop

On Windows or macOS, choose **Open DSH Terminal** from the Desktop tray. Bare commands in that terminal target the active profile:

```sh
dsh plugin add github:muyuanjin/dsh-ptc-plus#main
dsh --dump-config
```

After an npm release, the package spec may instead be `dsh-ptc-plus@0.2.4`. For a local package, use its absolute tarball path. Restart DSH Desktop after installation. Linux Desktop is not a current DSH Desktop release target; use DSH CLI/Web on Linux.
