<p align="center">
  <img src="assets/dsh-ptc-plus-banner-zh.webp" width="100%" alt="PTC Plus：不用从头来，改一改，接着算！">
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness PTC mode" src="https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb"></a>
  <a href="https://www.npmjs.com/package/dsh-ptc-plus"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-ptc-plus?logo=npm"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
  <a href="https://awesome-dsh-plugin.com/zh/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

**让模型在同一会话中持续计算、直接修订，减少重复工作和可避免的工具调用错误。**

PTC Plus 为 DSH 的 **PTC 模式**提供有状态的 TypeScript 计算环境。它基于 REPL，让变量、函数、导入和中间结果跨工具调用复用；针对模型连续编写和修改代码的需要，扩展声明更新规则，并提供模块语法适配、调用容错和代码编辑能力。

- **接着算**：读取和整理过的数据留在会话里，下一次调用直接继续。
- **直接改**：同名修订变量或函数，已有闭包读取更新后的绑定；小改动可以只发送代码差异。
- **少些调用错误**：适配常用模块语法，处理可准确识别的调用遗漏，并为可验证的语法错误提供修正建议。
- **复用常用能力**：把常用函数保存为全局绑定，向模型提供接口与使用提示，在多个会话中使用。

[快速开始](#快速开始) · [功能概览](#功能概览) · [连续计算](#连续计算与语言扩展) · [代码编辑与容错](#代码编辑与调用容错) · [全局绑定](#全局绑定跨会话复用常用函数) · [界面与设置](#界面与设置) · [状态与恢复](#值传递与状态恢复)

## 快速开始

需要 Node.js `^22.19.0 || >=24.0.0` 和最新可用的官方 DSH。将插件安装到实际使用的 profile：

```sh
dsh plugin --profile <profile> add dsh-ptc-plus
```

将 `<profile>` 替换为实际 profile 名称。安装后重启 DSH，在会话中选择 **PTC 模式**。连续计算、调用容错和全局绑定默认开启；已有配置中显式关闭的选项会保持关闭。

在默认界面设置下，会话中会出现 **REPL** 页签；宽屏顶部还会显示绿色 **PTC Plus** 标志。输入框旁的星光按钮可打开全局绑定菜单和 **PTC Plus 设置**。也可从侧边栏 **插件 → 已安装 → dsh-ptc-plus → 配置** 检查插件总开关和全部设置。

安装完成后正常向模型描述任务即可，下面的 `run_code` 和 `edit_run_code` 示例说明模型如何使用这些能力。其他安装方式、Desktop、本地开发启动器、升级和故障排查见[安装指南](docs/installation.md)。

## 功能概览

| 你希望模型完成的事 | PTC Plus 提供的能力 |
| --- | --- |
| 接着上一次处理数据 | 会话内保留变量、函数、导入和中间结果，后续调用直接复用 |
| 修改已有计算逻辑 | 同名修订变量、函数、类和导入绑定，已有闭包读取更新后的绑定 |
| 只改一小段代码 | `edit_run_code` 提交差异，再执行修改后的完整代码 |
| 使用熟悉的代码写法 | 支持 TypeScript、顶层 `await` / `return`、静态 `import` / `export` |
| 少因调用格式或笔误中断 | 容忍缺少摘要的调用、修复可唯一识别的顶层工具误调用、提供经过验证的末尾语法修正建议 |
| 访问当前项目 | 按会话项目目录解析相对文件路径、会话模块导入和默认子进程目录 |
| 查找工具和参数 | 在代码中列出、搜索当前可用能力，按需查看接口说明 |
| 传递 JSON 不易表达的数据 | 在支持的值范围内保留 `undefined`、BigInt、循环引用和共享引用关系 |
| 查看当前计算状态 | REPL 页签展示保留的名称、定义来源、复用次数和有界值预览 |
| 跨会话使用常用函数 | 全局绑定保存 TypeScript 源码，并向模型提供接口与使用提示 |
| 编写和测试全局绑定 | 让模型生成待审阅草稿，或在工作台试运行未保存的源码 |
| 重启后继续工作 | 从会话记录恢复可验证的状态，无法恢复的部分明确提示 |

以下各节介绍具体用法和边界；完整语言规则、配置字段与诊断见[运行时参考](docs/runtime-reference.md)。

## 连续计算与语言扩展

以下代码由模型通过 `run_code` 执行。每次调用的代码称为一个 **cell**。

第一次，建立数据和计算函数：

```ts
const amounts: number[] = [12, 8, 5]
function total() {
  return amounts.reduce((sum, value) => sum + value, 0)
}
return total() // 25
```

下一次，直接修订数据并复用函数：

```ts
const amounts = amounts.filter(value => value >= 8)
return total() // 20
```

无需重新定义 `total`，也无需为了避开重复声明而另起变量名。`total()` 读取的是更新后的 `amounts`。

默认的 **有状态语义**（`bindingUpdates: 'stateful'`）为连续修订扩展了 JavaScript/TypeScript 的绑定规则：

- 同一作用域内的变量、函数、类和导入绑定可以更新，包括用 `const` 声明的绑定；同一 cell 内也允许同名修订。
- 已有闭包读取更新后的绑定；提前保存的函数值仍是原来的函数。
- 不同块、函数和循环迭代的作用域仍然区分。
- 声明初始化失败时，尚未成功建立的名称不会永久阻止后续声明；失败前已经发生的其他修改不会因此回滚。

cell 支持 TypeScript、顶层 `await` / `return` 和静态 `import` / `export`。需要检测名称覆盖时，可在设置中关闭“允许重声明和覆盖”，使用 `protected` 策略。`tools` 等受保护的运行时名称仍不能覆盖。

<details>
<summary>静态导入与局部覆盖的时机</summary>

静态导入在 **整个 cell 的正文执行前** 生效，正文中的赋值或普通声明随后可以覆盖它。要恢复跟随模块导出，可在后续 cell 中再次静态导入。同一 cell 中，即使把 import 写在普通声明后面，也不会在那个文本位置重新覆盖局部值；若要在某一步取回当前导出值，可以显式赋值：

```ts
join = (await import('node:path')).join
```

这会取得当时的函数值；静态导入则持续跟随模块来源。更多规则见[运行时参考](docs/runtime-reference.md#cell-semantics)。

</details>

`run_code`、编辑后的代码和全局绑定工作台采用相同的语言策略；工作台的临时状态与模型会话分开。显式使用 `eval`、`Function`、`node:vm` 或独立运行时仍受对应原生边界约束。详细的作用域、模块互操作与历史会话规则见[语言参考](docs/runtime-reference.md#cell-semantics)。

## 代码编辑与调用容错

### 小改动只发送差异

模型可以调用 `edit_run_code` 修改当前轮模型运行中最近的可编辑 cell，无需重新发送整段源码。假设前面的第二个 cell 刚执行完，且仍在同一轮运行中，可以把筛选条件改为 `value >= 10`：

```js
edit_run_code({
  edits: [{ old_string: 'value >= 8', new_string: 'value >= 10' }]
})
```

修改后会**重新执行整个 cell**，以上例子返回 `12`。已发生的状态修改不会回滚；如果代码涉及写文件或外部服务，重跑仍需考虑重复效果。编辑既可用于修复失败的代码，也可用于微调已成功的计算。

### 处理可以确定的调用问题

| 情况 | PTC Plus 的处理 |
| --- | --- |
| `run_code` 漏填外层 `description` | 补充显示摘要，让其余参数合法的代码继续执行 |
| 模型误发 PTC 直接工具列表之外的原生工具调用 | 当前工具定义能唯一确认目标且参数合法时，转为对应的 `run_code` |
| 代码解析失败 | 标出源码位置；若错误在末尾，且追加一到两个闭合符只有一种通过验证的修正，给出绑定原调用的编辑建议 |

前两项默认开启，可在设置中关闭。语法建议不会自动执行，也不代表插件能判断代码是否符合任务意图。

## 项目文件与工具能力

### 从会话项目目录开始

模型可以直接使用 Node.js 读取文件、处理数据和运行程序。相对文件路径与会话内的模块导入按会话记录的项目目录解析；子进程未指定 `cwd` 时，也使用这个目录。显式指定的目录仍然生效。

例如，在包含 `package.json` 的项目中，第一次调用读取依赖：

```ts
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

下一次直接整理已读取的数据：

```ts
return deps.map(dep => dep + '@' + manifest.dependencies[dep])
```

这里没有重新读文件，结果来自会话中已有的 `manifest`。直接文件、网络等外部输入可以在当前环境继续使用，但不保证能跨重启恢复。

### 按需发现工具

模型仍可通过 `tools.*` 使用 DSH 当前提供的原生工具。需要了解可用能力时，`capabilities.tree()` 列出目录，`find()` 搜索名称和描述，`inspect()` 查看选中接口的参数说明：

```ts
const matches = await capabilities.find('read')
return capabilities.inspect({
  symbols: matches.slice(0, 4).map(item => item.symbol),
  budget: 4,
})
```

搜索使用词法匹配，适合 `read`、`session` 这样的短关键词；没有匹配不代表工具一定不存在。发现工具不会增加权限，实际调用仍由 DSH 校验和调度。更多用法见[能力发现](docs/runtime-reference.md#capability-discovery)。

## 全局绑定：跨会话复用常用函数

会话变量服务于当前任务；**全局绑定**把常用 TypeScript 函数保存下来，供多个会话加载。例如，保存名为 `textTools` 的绑定后，模型可以使用 `textTools.clean(text)`。

全局绑定和星光入口默认开启。你可以手动创建、导入 `.ts` 文件，也可以让模型帮忙编写和修改：

```text
/binding new 创建 textTools，去掉文本首尾空白并保留内部空格
/binding edit <id> 增加逐行清理功能
```

`<id>` 是工作台中的条目标识，也可以从星光菜单选择要修改的绑定。

### 编写、审阅与启用

模型可先用内存样例测试，再提交草稿。草稿显示在输入框上方，由你检查源码、接口和给模型的提示词，并选择 **保存并启用**、**保存为停用** 或 **丢弃草稿**。提交草稿本身不会保存或启用绑定；关闭面板后，可从星光按钮的草稿角标重新打开。

星光菜单可在首条消息发出前查看、启停条目，选择对所有会话生效。已启用条目的接口和使用提示会提供给新会话中的模型；中途修改后，在现有会话的下一次允许请求中更新。

### 接口提示与独立试运行

每个条目可以从源码生成公开接口，并附加用途、输入约束或使用示例。仅修改提示词不会重置已加载函数的运行状态。会话中的同名赋值或重声明只覆盖对应名称，不会改写保存的全局条目。

工作台支持运行尚未保存的源码，并在连续执行间保留临时变量。它与模型会话的计算状态分开，适合手动检查函数；文件和网络操作仍会产生真实效果。没有当前 PTC 会话也可管理条目。源码格式、接口生成、保存位置和完整流程见[全局绑定指南](docs/user-bindings.md)。

## 界面与设置

**REPL 页签**可搜索当前保留的名称，查看定义来源、复用次数和有界值预览，也可打开全局绑定工作台。预览有类型和大小限制，未采集、不完整或不可读取时会明确标注，不会为展示调用用户 getter。宽屏顶部的绿色 **PTC Plus** 标志提供快捷绑定清单，窄屏可使用 REPL 页签。

<details>
<summary>查看 REPL 界面示例</summary>

![REPL 页签中的会话状态与全局绑定工作台](assets/ptc-plus-repl-workspace-zh.png)

</details>

输入框旁的星光菜单将绑定编写、条目管理和 **PTC Plus 设置** 分组提供。设置弹窗与侧边栏插件配置页使用同一套配置：

| 分组 | 可以调整的内容 |
| --- | --- |
| 插件总开关 | 启用或停用 PTC Plus |
| 调用容错 | 缺少摘要的调用、可准确识别的顶层工具误调用 |
| REPL 语法 | 允许同名修订，或选择名称保护策略 |
| 状态与恢复 | 重启恢复、按需提示与提示频率 |
| 工具扩展 | 全局绑定及其管理入口、官方 Cordis 工具集成 |
| 界面显示 | 增强工具卡片、REPL 页签与星光快捷入口 |
| 资源限制 | 执行时间、内存和输出上限 |

面向日常计算的功能默认开启。**Cordis 开发工具默认关闭**，适用于检查或开发 DSH 插件，按需开启即可；详见[集成说明](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md)。已有配置中显式关闭的选项会保持关闭，条目是否启用也由各自的保存状态决定。

设置通常即时生效；活动 worker 存在时不能修改其内存上限。字段、默认值和完整限制见[配置参考](docs/runtime-reference.md#configuration)。

## 值传递与状态恢复

### 保留超出普通 JSON 的值

在支持的值范围内，工具参数、结果和恢复记录可以保留 `undefined`、BigInt、`NaN`、无穷大、稀疏数组、循环引用和共享引用关系。普通 JSON 结果仍以结构化值返回；特殊值会以可读文本展示给模型，其程序内值与展示文本分别处理。

这不等于任意 JavaScript 对象都可传递或持久化：函数、Promise、类实例、Date、Map、Set 等不属于值传递的支持域。在 REPL 中保留函数供后续调用，与把函数作为工具结果返回，是不同的能力。需要继续计算时应复用会话变量；完整支持域见[值传递说明](docs/value-wire.md)。

### 恢复有依据的计算状态

会话级状态不等于永久内存。重启、执行环境重置或上下文压缩后，只保留能从会话记录验证、且其来源仍在模型上下文中的计算状态。直接读取外部文件或网络、历史记录损坏、来源被压缩等情况，都可能缩小可保留的范围。

无法证明的状态会被丢弃并给出提示，必要时从空环境继续当前计算。恢复不会重新派发已记录的原生工具调用，也不会撤销历史外部效果。恢复依据和限制见[运行时参考](docs/runtime-reference.md)。

## 使用边界

- **执行权限**：主要面向 `danger-full-access`。代码可直接访问 Node.js 与操作系统；插件不额外提供安全沙箱。DSH 继续负责原生工具权限、审批、取消和沙箱策略。
- **失败与重跑**：代码执行失败不代表此前语句没有生效。进程隔离、编辑和恢复都不保证外部操作可以安全重复；超时或输出超限等情况也可能释放计算环境。
- **错误与开销**：语言适配和调用容错不保证所有代码成功。实际调用次数与 token 用量取决于任务和模型；已有对照观察及限制见[评测说明](docs/evaluation.md#recorded-paired-observation)。

PTC Plus 是社区插件，与 DeepSeek 或 DSH 无隶属或背书关系。

## 进一步阅读

[安装与升级](docs/installation.md) · [全局绑定](docs/user-bindings.md) · [运行时参考](docs/runtime-reference.md) · [架构与开发](docs/architecture.md) · [验证指南](docs/verification.md) · [全部文档](docs/README.md)

[MIT License](LICENSE)
