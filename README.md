<p align="center">
  <img src="assets/dsh-ptc-plus-banner-zh.webp" width="100%" alt="PTC Plus">
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

**为 DSH 的 PTC 模式提供会话级有状态计算，减少重复准备与可避免的调用错误。**

PTC Plus 基于 TypeScript REPL，让模型在多次工具调用之间保留变量、函数、导入和中间结果。它还为连续计算适配了声明、模块语法和代码修订：模型可以沿用已有名称修改计算，少因重复声明、调用格式遗漏或局部笔误而中断任务。

- **接着算**：读取和整理过的数据留在会话里，下一次调用直接继续。
- **直接改**：同名修订变量或函数，已有闭包读取更新后的绑定；小改动可以只发送代码差异。
- **少些调用错误**：适配常用模块语法，处理可准确识别的调用遗漏，并为可验证的语法错误提供修正建议。

[连续计算示例](#连续计算示例) · [快速开始](#快速开始) · [减少调用错误](#减少调用错误) · [设置与扩展](#设置与扩展) · [使用边界](#使用边界)

## 连续计算示例

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

默认的 **有状态语义** 允许同一作用域内的变量、函数、类和导入绑定被更新，包括用 `const` 声明的绑定；不同块、函数和循环迭代的作用域仍然区分。它保留熟悉的 JavaScript/TypeScript 写法，并对连续修订所需的绑定规则作了扩展。需要检测名称覆盖时，可在设置中关闭“允许重声明和覆盖”。

## 快速开始

需要 Node.js `^22.19.0 || >=24.0.0` 和最新可用的官方 DSH。将插件安装到实际使用的 profile：

```sh
dsh plugin --profile <profile> add dsh-ptc-plus
```

将 `<profile>` 替换为实际 profile 名称。安装后重启 DSH，在会话中选择 **PTC 模式**，即可使用默认启用的连续计算与调用容错能力。

在默认界面设置下，会话中会出现 **REPL** 页签；宽屏顶部还会显示绿色 **PTC Plus** 标志。从侧边栏 **插件 → 已安装 → dsh-ptc-plus → 配置** 可检查插件总开关和全部设置。

其他安装方式、Desktop、本地开发启动器、升级和故障排查见[安装指南](docs/installation.md)。

## 减少调用错误

### 让常见代码写法直接可用

cell 支持 TypeScript、顶层 `await` / `return` 和静态 `import` / `export`。同名声明可以修订已有计算；声明初始化失败时，尚未成功建立的名称不会永久阻止后续声明。模型还可以通过 `capabilities.find` / `inspect` 按需查找当前工具及参数说明。

<details>
<summary>静态导入与局部覆盖的时机</summary>

静态导入在 **整个 cell 的正文执行前** 生效，正文中的赋值或普通声明随后可以覆盖它。要恢复跟随模块导出，可在后续 cell 中再次静态导入。同一 cell 中，即使把 import 写在普通声明后面，也不会在那个文本位置重新覆盖局部值；若要在某一步取回当前导出值，可以显式赋值：

```ts
join = (await import('node:path')).join
```

这会取得当时的函数值；静态导入则持续跟随模块来源。更多规则见[运行时参考](docs/runtime-reference.md#cell-semantics)。

</details>

### 自动处理可以确定的调用问题

| 情况 | PTC Plus 的处理 |
| --- | --- |
| `run_code` 漏填外层 `description` | 补充显示摘要，让其余参数合法的代码继续执行 |
| 模型误发 PTC 直接工具列表之外的原生工具调用 | 当前工具定义能唯一确认目标且参数合法时，转为对应的 `run_code` |
| 代码解析失败 | 标出源码位置；若错误在末尾，且追加一到两个闭合符只有一种通过验证的修正，给出绑定原调用的编辑建议 |

前两项默认开启，可在设置中关闭。语法建议不会自动执行，也不代表插件能判断代码是否符合任务意图。

### 小改动只发送差异

模型可以调用 `edit_run_code` 修改当前 turn 中最近的可编辑 cell，无需重新发送整段源码。例如，把刚才第二个 cell 的筛选条件改为 `value >= 10`：

```js
edit_run_code({
  edits: [{ old_string: 'value >= 8', new_string: 'value >= 10' }]
})
```

修改后会**重新执行整个 cell**，以上例子返回 `12`。已发生的状态修改不会回滚；如果代码涉及写文件或外部服务，重跑仍需考虑重复效果。

## 设置与扩展

核心计算能力默认可用。在插件配置页可以调整绑定更新策略、调用容错、状态恢复、界面显示和资源限额。开启全局绑定后，输入框旁还会出现星光入口，其中的 **PTC Plus 设置** 可打开同一套设置。[配置参考](docs/runtime-reference.md#configuration)列出了字段、默认值和限制。

**查看会话状态。** REPL 页签可搜索保留的绑定、查看定义来源和有界值预览。预览不完整或不可读取时会明确标注，不会为展示调用用户 getter。

<details>
<summary>查看 REPL 界面示例（已开启全局绑定）</summary>

![REPL 页签中的会话状态与全局绑定工作台](assets/ptc-plus-repl-workspace-zh.png)

</details>

**跨会话复用 helper。** 可选的全局用户 Binding 默认关闭。开启后，可保存 TypeScript helper，并向模型提供接口与使用提示；星光菜单可查看和启停条目。也可以让 Agent 帮忙编写：

```text
/binding new 创建 textTools，去掉文本首尾空白并保留内部空格
```

Agent 提交的草稿会显示在输入框上方，由你审阅、保存并决定是否启用。工作台支持试运行尚未保存的代码，临时计算状态与 Agent 会话分开。详见[全局绑定指南](docs/user-bindings.md)。

**扩展工具能力。** 可选的官方 Cordis 工具集成默认关闭，适用于需要检查或开发 DSH 插件的场景；详见[集成说明](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md)。

## 使用边界

- **执行权限**：主要面向 `danger-full-access`。代码可直接访问 Node.js 与操作系统；插件不额外提供安全沙箱。DSH 继续负责原生工具权限、审批、取消和沙箱策略。
- **状态保留**：会话级状态不等于永久内存。重启、执行环境重置或上下文压缩后，只保留能从会话记录验证、且其来源仍在模型上下文中的计算状态。恢复不会重新派发已记录的原生工具调用，也不会撤销历史外部效果。
- **错误与开销**：语言适配和调用容错不保证所有代码成功。实际调用次数与 token 用量取决于任务和模型；已有对照观察及限制见[评测说明](docs/evaluation.md#recorded-paired-observation)。

PTC Plus 是社区插件，与 DeepSeek 或 DSH 无隶属或背书关系。

## 进一步阅读

[安装与升级](docs/installation.md) · [全局绑定](docs/user-bindings.md) · [运行时参考](docs/runtime-reference.md) · [架构与开发](docs/architecture.md) · [验证指南](docs/verification.md) · [全部文档](docs/README.md)

[MIT License](LICENSE)
