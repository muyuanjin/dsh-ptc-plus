# Publishing

本仓库是普通 DSH bundle：`package.json` 声明 `dsh.bundle.patch`、入口、依赖、Node 范围和发布白名单，`cordis.patch.yml` 只插入 `dsh-ptc-plus`。插件自带的运行时依赖由 npm 包声明；必须与宿主共享实例的 DSH service 包声明为 peer dependencies，并由宿主按 `inject` 装配。

`npm run build` 生成 Client bundle，以及私有编译器使用的 `compiler-core.cjs`、`compiler-platform.cjs`、按需加载的 `compiler-amaro.cjs`、`compiler-typescript.cjs` 和对应 source maps。依赖中的大型字符串参数由构建提取为 `compiler-asset-*.txt`，`compiler-assets.json` 拥有精确加载清单，避免 WASM 等数据同时驻留于源码与字面量池。这些编译器产物由 `scripts/compiler-bundle.mjs` 从源码紧凑生成，并列入发布白名单；不能手工修改生成文件。构建同时核验编译器源码所导入的必需平台成员。`npm run build:check` 同时比较 Client、编译器和资源产物，`prepack` 通过该检查阻止陈旧产物进入 tarball。源码验证还须把私有 realm 的执行映射回原始编译器文件，不能只统计调用服务的外层代码。

## 命名约定

项目在不同集成层使用不同名称：

| 名称 | 用途 |
| --- | --- |
| `dsh-ptc-plus` | 仓库和 npm 包名；浏览器 bundle 的 module name 也从 `package.json` 取得它。 |
| `ptc-plus` | DSH 插件 ID、运行时 loader name 和 settings namespace。 |
| `PTC Plus` | 面向用户的产品名。 |

在 `cordis.patch.yml` 和解析后的 DSH 配置中，`id: ptc-plus` 标识插件配置项，`name: dsh-ptc-plus` 标识待加载的包。内部错误前缀、runtime context 名称和 worker 临时路径会按所属子系统使用 `ptc-plus` 或 `dsh-ptc-plus`；它们不是另外的公开产品名。

## 发布权限与流水线

npm 发布遵循 [ADR 0022](adr/0022-stage-npm-releases-with-oidc.md)，使用 `.github/workflows/release.yml` 声明的 Trusted Publisher，不向 GitHub 保存 npm write token。npm package settings 必须把 publisher 精确绑定到 `muyuanjin/dsh-ptc-plus`、workflow filename `release.yml` 和 environment `npm-release`，且只允许 `npm stage publish`。Publishing access 选择页面中最严格且标记为 recommended 的 2FA 选项；npm 文档称其为 `Require two-factor authentication and disallow tokens`，当前 npm 页面也可能显示 `Require two-factor authentication and disallow bypass 2fa tokens (recommended)`。不要从滚动变化的标签推断账户中已不存在传统 token。OIDC 只把经过验证的 tarball 放入 npm staging，维护者仍须在 npm CLI 或 npmjs.com 检查 staged package 并以 2FA approve，包才会进入公开 registry。

普通 `CI` 只响应 `main` push 与 pull request。发布前创建 annotated `v<package.version>` tag，原子推送 release commit 与 tag，等待该 commit 的 `CI` 成功，然后以该 tag 作为 ref 显式运行 `Release` workflow。workflow 不接受另一个 tag input，并会重新证明 dispatch 的 `GITHUB_REF`、`GITHUB_SHA`、annotated tag target、checkout HEAD、manifest 版本和成功 CI 的 SHA 完全一致；release job 使用 GitHub-hosted Node `24.15.0`、npm `12.0.2`、无 package-manager cache 和最小 `id-token: write` 权限，构建一个 tarball、执行 clean-consumer smoke，再对同一文件执行 `npm stage publish`。`package.json#allowScripts` 显式拒绝当前不需要的 `esbuild` install script；`replace-registry-host=always` 让 release install 将 lockfile 中的 registry tarball 路由到显式 npm 官方 registry，而不放宽 npm 12 的 Git/remote dependency 默认拒绝。

```powershell
git tag -a "v$((Get-Content package.json | ConvertFrom-Json).version)" -m "v$((Get-Content package.json | ConvertFrom-Json).version)"
git push --atomic origin main "v$((Get-Content package.json | ConvertFrom-Json).version)"
gh workflow run release.yml --ref "v$((Get-Content package.json | ConvertFrom-Json).version)"
```

workflow 成功只表示 package 已 staged，并非已经公开发布。维护者从 workflow 日志或 npmjs.com 的 Staged Packages 页面取得 stage id，检查 metadata 和下载的 tarball 后执行：

```powershell
npm.cmd stage view '<stage-id>' --json --registry=https://registry.npmjs.org/
npm.cmd stage download '<stage-id>' --registry=https://registry.npmjs.org/
npm.cmd stage approve '<stage-id>' --registry=https://registry.npmjs.org/
```

`npm stage approve` 必须完成 npm 2FA。approve 后 npm 会进行 publish-time malware scan；公开可安装通常延迟约 5 分钟，高峰或需进一步检查时可能超过 15 分钟。发布自动化必须轮询明确版本并允许该延迟，不能把 approve 返回等同于 registry 已可安装。扫描确认版本可用后再发布对应 GitHub Release。staged 内容错误时使用 `npm stage reject <stage-id>` 并完成 2FA，不能移动既有 tag 或用同一版本覆盖。

首次 OIDC staging 成功后，检查 npm 账户的 Access Tokens，并撤销所有仍可对本包执行 publish 或 stage 的 granular/automation token，尤其是 bypass-2FA token；在 Trusted Publisher 尚未实测成功前保留恢复路径，不能把未验证的凭据切换当成完成。后续 workflow 不保存或读取 npm token，定期清点用于发现账户侧重新引入的发布凭据。

## Release checklist

1. 在 Node `22.19.0` 与 Node 24.x 上运行 `npm ci`、`npm run build:check` 和 `npm run check`；Node 24.x 还应覆盖 Windows、Linux 与 macOS。仓库 CI 定义同一矩阵。
2. 运行 `npm audit`、`npx publint`、`git diff --check`、Markdown local-link check 和 `npm pack --silent --dry-run --json`。确认 tarball 只包含发布白名单内的运行时代码、文档和展示资产，不含凭据、本地路径、开发脚本或测试夹具，并从 tarball 安装到空目录执行 ESM import smoke。机器读取 `npm pack --json` 时保持 `--silent`，避免 lifecycle 输出混入 JSON stream。
3. 更新到最新可用 DSH release 并记录 `dsh --version`。分别从 npm 包、固定 Git commit、源码 checkout 和 tarball 安装到临时 profile，再执行 `dsh --profile <profile> --dump-config`，确认只新增 `ptc-plus` row。每个上游 release 都重新验证公共扩展面、CLI/Web 集成和 profile 装配，不设置版本白名单。
4. 在 Windows 与 Linux 运行无模型调用的 `npm run test:client:web -- --dsh-entry <latest-installed-dsh/lib/bin.js>`，验证 tarball 安装后的真实 Web Client、设置与对话 surface；浏览器前置条件见 [安装指南](installation.md)。`build:check`、Host ESM import 和 factory smoke 均不能替代浏览器激活验收。macOS 由原生 runner 验证 CLI/Web；Windows 与 macOS Desktop 从托盘打开当前 profile 的 DSH Terminal 安装，重启 Desktop 后做一次 PTC 模式 smoke。Desktop 当前发布平台不包括 Linux。
5. 只有在明确授权模型消耗后才运行 `npm run test:expensive` 与 `npm run test:ab`。发布结论以结构化测试结果为准，不把一次模型样本推广为普遍保证。
6. 确认 npm 包名可用、待发布版本高于 registry 版本、README 截图来自真实 DSH 会话，并核对 repository、homepage、bugs、license 与 `dsh-plugin` topic。
7. 最后检查 `npm pack --silent --json` 的名称、版本、大小与文件列表，创建 annotated release tag，并确认 tag commit 已通过 `CI`。运行 `Release` workflow 将同一源码产生的 tarball送入 npm staging；人工检查并以 2FA approve 后，等待 registry 扫描完成，再创建 GitHub Release。

远程仓库、registry、签名凭据、目标平台运行状态和模型额度都属于发布时事实，不能由本地 manifest 推断。

## Permission disclosure

PTC Plus 自身不配置外部 endpoint，也不读取 API key。它让模型代码使用当前 request 的 DSH native tools，并在 worker 进程和操作系统实际允许时直接使用 Node.js filesystem、process、network 与 child process API。DSH 负责 native-tool policy；ambient Node/OS access 不经过该 policy。worker thread 是生命周期隔离，不是恶意代码安全沙箱。

DSH 当前公共 bundle surface 未定义供插件使用的机器可读 permission-disclosure contract，因此这些权限边界记录在人类可读文档中。

## Client UI

发布包包含设置卡片和会话头部启用标识的 Client UI。发布截图必须来自 DSH Web 或 Desktop 中真实的 PTC 模式 surface；实现与构建边界见 [Client UI](client-ui.md)。
