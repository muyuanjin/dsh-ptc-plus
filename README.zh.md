<p align="center">
  <img src="assets/dsh-ptc-plus-banner.webp" width="100%" alt="dsh-ptc-plus 横幅">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#%E9%BB%98%E8%AE%A4-ptc-%E6%A8%A1%E5%BC%8F%E7%9A%84%E9%97%AE%E9%A2%98">问题</a> ·
  <a href="#%E4%B8%89%E4%B8%AA%E6%9C%80%E7%9B%B4%E6%8E%A5%E7%9A%84%E5%9C%BA%E6%99%AF">场景</a> ·
  <a href="#%E8%AE%BE%E7%BD%AE">设置</a> ·
  <a href="#%E8%8C%83%E5%9B%B4">范围</a> ·
  <a href="#%E5%AE%89%E8%A3%85">安装</a> ·
  <a href="#%E6%96%87%E6%A1%A3">文档</a>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness PTC mode" src="https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb"></a>
  <a href="package.json"><img alt="Node.js ^22.19.0 || >=24.0.0" src="https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-5fa04e?logo=nodedotjs&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/dsh-ptc-plus"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-ptc-plus?logo=npm"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com/zh/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

---

**PTC Plus 给 DSH 的 PTC 模式一个会话绑定的持久 TypeScript REPL。** 每次 `run_code` 都在同一个会话里继续。上一次 `run_code` 的变量、导入和结果，下一次还能直接用。

> [!NOTE]
> 社区插件，与 DeepSeek 或 DSH 无隶属、无背书。

> [!IMPORTANT]
> 面向 `danger-full-access` 设计：可直接访问 Node.js 与操作系统，不另加沙箱。仅在可接受此权限的环境使用。

![PTC Plus 设置卡片](assets/ptc-plus-settings.png)

*设置卡片展示即时配置和 `enabled` 开关。*

## 默认 PTC 模式的问题

DSH 的 PTC 模式让每次 `run_code` 都从新环境开始。模型算过的东西，下一次还要重发。写错一行，整段代码重发。这个插件把 `run_code` 接到一个会话级环境里，后面的调用直接复用之前的东西。

| 场景 | 默认 PTC 模式 | PTC Plus 之后                |
| --- | --- |----------------------------|
| 状态 | 每次从零开始，setup 重发 ❌ | 上一次 `run_code` 的结果直接能用 ✅   |
| 修错 | 结果不对或失败，整段重发 ❌ | 只发一行 diff ✅                |
| 模块 | `import` / `export` 不能写 ❌ | 照常写，后台 AST 重写 ✅            |
| 值 | JSON 改掉或丢失特殊值 ❌ | 这些值原样保留 ✅                  |
| 重启 | 重启后一切丢失 ❌ | 能恢复的会回来 ✅                  |
| 输出报错 | 大打印刷屏，报错指到别处 ❌ | 输出裁剪，报错回错的行 ✅              |
| 工具 | 列表看不见，顶层误发失败 ❌ | 可查看；可确定的误发自动转 `run_code` ✅ |
| 路径 | 相对路径可能跑偏 ❌ | session 记住项目目录 ✅           |
| agent 工具 | 需要当前 agent 的工具被拒绝 ❌ | 恢复上下文，goal 等可调 ✅           |

## 三个最直接的场景

### 状态跨调用

第一个 `run_code` 算完：

```ts
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

第二个直接接着用：

```ts
return deps.map(dep => dep + '@' + manifest.dependencies[dep])
```

`deps` 和 `manifest` 还在。setup 代码只发一次。

### 修错不重发

默认情况下，结果不对或执行失败，模型只能把整个代码块再发一遍。

PTC Plus 下它只发这一行：

```ts
edit_run_code({ edits: [{ old_string: 'deps.length', new_string: 'deps' }] })
```

模型只发改动，完整源码留在对话之外。精确文本替换和正则替换都有限制，坏的正则不会卡住。

当被拒 cell 的末尾可唯一验证为缺少一个闭合符时，诊断会直接给出应用该修正并重运行所需的完整 `edit_run_code(...)` 调用。生成的调用带有 `expected_target_call_seq` 前置条件；如果另一个 cell 已先成为 edit 目标，它会拒绝且不执行。PTC Plus 不会自动应用这项建议；有歧义或没有持久目标身份的修复仍需提交修正后的源码。

### 模块语法

DSH 的 PTC 模式把每个 `run_code` 当作 async function body 执行，静态 `import` 和 `export` 声明在这个函数体里无效。PTC Plus 会在执行前用 AST 分析适配这些形式。

模型照常写：

```ts
import { readFile } from 'node:fs/promises'
```

依赖从项目解析，具名和默认导入保持 live 且只读。模型不需要知道 `run_code` 其实是一个函数体。

## 一次配对实测

一次身份盲化的配对实验使用了 `opencode-go/deepseek-v4-flash`。两个 arm 使用同一版本夹具、任务 prompt、权限，每个任务重复两次，每个 arm 共 18 个 session。

| 9 个任务合计 | PTC Plus | DSH PTC 模式（未启用 PTC Plus） | 本次观测变化 |
| --- | ---: | ---: | ---: |
| 模型请求 | 66 | 88 | 减少 25.0% |
| 工具调用 | 50 | 79 | 减少 36.7% |
| Token 流量 | 729,642 | 942,901 | 减少 22.6% |
| 身份盲评量表得分 | 138 / 162 | 118 / 162 | 提高 12.3 个百分点 |

模块语法任务的区分最清楚：PTC Plus 两次都只用一次 `run_code` 完成；未启用 PTC Plus 的 DSH PTC 模式两次都未满足静态 import 要求，尝试过程合计用了 8 次工具调用。

这是一次有随机性的配对观测，不是性能保证。预设机器预算在 PTC Plus 的 18 个 session 中有 2 个超限，未启用 PTC Plus 的 18 个 session 中有 5 个超限，因此整组矩阵没有通过 machine acceptance。Token 流量包含 input、cache-read、cache-write 和 output token。夹具、配对规则、指标与盲评流程见[评测说明](docs/evaluation.md)。

![被拒的 run_code 与随后的 edit_run_code 修复调用](assets/ptc-plus-repair.png)

*真实会话：长代码与真实的 `edit_run_code` 修复调用；修复从未重发源码。*

## 设置

打开 **设置 → 插件配置** 使用上面的设置卡片。卡片跟随 DSH 界面语言：界面设为 English 时显示英文，设为中文时显示中文。`enabled` 是即时生效的总开关：关闭后只保留卡片和这个开关，开启后恢复 session runtime 以及 `run_code`/`edit_run_code`。

所有设置都会实时应用，并保留已有 binding。已提交的 cell 在完整执行期间使用同一份配置；执行期间发生的更新用于随后提交的 cell。更新失败会回滚。Node 在 worker 创建时固定 V8 old-generation 上限，因此活动 session worker 存在时修改这一项会被拒绝，释放 session 后才能修改。启用失败时，运行时会回滚并把设置保持为停用。

`cordisToolsEnabled` 默认关闭。打开后，DSH 官方 Cordis 工具、owner guidance 与精确的 `cordis-plugin-development` companion Skill 会作为一个整体加入 PTC agent；同一 shipped preset 目录中的其他 Skill 不会随之暴露。关闭时这三项也会一起移除；它不切换 preset，也不改变 `run_code`/`edit_run_code` 的直接调用面。Cordis 能在实时 DSH runtime 中运行模型编写的插件，开启它需要接受 shell 级信任。

如果 Cordis 调用在 cell 已经赋值大段 host 或 client 源码之后才失败，这些顶层 binding 仍会保留。后续只需在短 cell 中重试 Cordis 调用并复用该 binding，无需再次传输源码。

cold recovery 或重新启用 Cordis 后，已记录的 Cordis value 仍是历史数据，但不能证明进程内 Plugin、Run、approval 或先前 Inspect observation 仍然存活。PTC Plus 会提供有界恢复 context，直到一次新的成功 Cordis Inspect 调用验证当前进程。

详见 [客户端 UI](docs/client-ui.md)、[ADR 0019](docs/adr/0019-plugin-settings-and-kill-switch.md) 与 [ADR 0020](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md)。

## 范围

PTC Plus 提供会话绑定的持久 `run_code` 层。原生工具的权限、策略、审批、取消、sandbox 和进程治理仍由 DSH 与操作系统负责。

## 安装

要求 Node.js `^22.19.0 || >=24.0.0`，并已安装带 TypeScript PTC 模式的 DSH。把 npm 正式包安装到你实际使用的 profile：

```sh
dsh plugin --profile <profile> add dsh-ptc-plus
dsh --profile <profile> --dump-config
```

安装后重启对应的 DSH profile。固定 npm 版本、GitHub、本地 checkout 和 tarball 安装方式见[安装指南](docs/installation.md)。

`danger-full-access` 是首要支持方式。worker 只隔离生命周期，不隔离恶意代码。

## 文档

[安装指南](docs/installation.md) · [运行时参考](docs/runtime-reference.md) · [架构](docs/architecture.md) · [发布](docs/publishing.md) · [全部文档](docs/README.md)

使用 [MIT License](LICENSE)。
