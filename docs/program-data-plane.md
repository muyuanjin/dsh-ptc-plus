# Program Data Plane

程序取得数据、模型看到结果和 cold replay 重建值是三个不同问题。PTC Plus 保留这个区别，不用一个“安全工具”名单代替契约。

## Typed tools

浏览、搜索和 DSH 服务调用使用当前 scope 的 native `tools.*`。canonical result 直接进入 cell，不经过 PTC 参数翻译或结果裁剪。对完全省略参数的 native call，runtime 只在 DSH 的 live object schema 验证 `{}` 合法时把 omission 规范为 `{}`；该值随后统一进入 encoding、dispatch、journal 和 replay comparison。`tools.cordis_inspect_list()` 因而等价于显式传入 `{}`，但显式 `undefined`、需要输入的工具、`capabilities.*` 和 owner-provided namespace 不受影响。具体结果可能 complete、bounded、incremental、open-world 或 unknown；模型/UI rendering 的裁剪不能反推 program value 的完整性。

PTC 模式的 code-only direct-tool projection 只声明模型直接调用真实注册的 `run_code` 与 `edit_run_code`。模型误发的顶层 native call 不属于这个合法 direct protocol；当 live schema 能唯一证明该工具时，transport normalization 将它包装为 `run_code`，cell 再调用同一 `tools.*` member。canonicalizer 先解析并校验一次原始 JSON：普通参数原样嵌入 JavaScript，含 own `__proto__` 的值改用安全字面量；因此派生 cell 不需要 `JSON.parse`，同时保持参数执行语义。规范化不向模型暴露 provenance、纠错提示或额外标记。参数仍由 DSH owner contract 正式验证，未知、畸形或不一致调用原样交给宿主诊断。该历史规范化只适用于无效的 out-of-surface call，不适用于已经合法声明的 `edit_run_code`。

`edit_run_code` 是宿主 composite tool：外层 result 向模型返回精简的编辑状态、值与日志，完整物化源码和 journal 只进入标记为 derived 的私有 metadata。cold replay 消费该记录，不把完整源码重新投影给模型，也不把派生 `run_code` 归因给 assistant。

每次调用进入 journal：

```text
DSH authority/policy -> native dispatch -> canonical result
                                      |-> current cell
                                      `-> args/result + settlement transcript
```

cold replay 校验相同的调用序列并返回 recorded value，不重新执行工具。这保证 REPL 计算状态可重建，但不声称外部 effect 可逆或仍与历史相同。Cordis Plugin、Run 和 Inspect observation 属于进程内实时状态；恢复出的 Cordis value 只作为历史数据保留，后续状态性决策必须先按恢复 context 执行新的 live Inspect。

同一 settlement 规则适用于当前 request 中的全部 program binding，包括 owner-provided namespace 与 `code.run`。已结算的 value/error 可进入 durable transcript；若取消、超时或 worker failure 发生时调用仍未结算，cell heap 回滚，discarded journal 以实际 `global.member` 保留 possible-effect boundary。分类来自可观察生命周期，不来自 capability 名称表。

直接 Node/OS 输入没有 binding transcript。worker 首次观察到这类 volatile 边界时立即通知主线程；即使 cell 随后 hard abort、timeout 或 worker exit，discarded journal 仍保留已观察原因。该恢复事实不作为普通成功任务的模型可见警告。

## Native Node and processes

在 `danger-full-access` 下，模型可以使用熟悉的 Node、filesystem、process、network、child-process 和
生态 SDK。直接 ambient access 受 worker 进程与操作系统的实际约束，不经过 DSH tool policy；
PTC Plus 不另造 filesystem Consumer、跨平台权限系统或命令 DSL。更窄 profile 中缺少某个 native
tool，也不能被解释为相应 Node API 已被隔离。

记录了 session cwd 时，child process 在未提供 `options.cwd` 时继承该目录；显式 `cwd` 保持调用方选择。
worker 继承宿主的 Node、package manager 和 shell 所需环境变量，只把 `TEMP`、`TMP` 和 `TMPDIR`
覆盖为本 session 的 scratch 目录。`node:fs`、`node:fs/promises` 及 glob 的相对入口同样以 session cwd
为基准，绝对路径仍按原生语义处理。

完整文件读取示例：

```ts
import { readFile } from "node:fs/promises"

const source = await readFile("README.md", "utf8")
return source.length
```

这类直接能力不经过 tool transcript，因此当前 cell 与后续 live suffix 进入 sticky volatile；当前进程继续使用既有 binding，cold recovery 回到最近 durable frontier。其他 profile 不具备入口时应明确失败，不能拼接 bounded `tools.read` 窗口伪造无损文本。

普通已知程序优先 argv spawn；只有命令本身需要 shell 语义时才使用 shell。shell 不是权限系统，也不是 REPL 前置条件；PTY/ConPTY 只用于交互进程。Windows、WSL 与 POSIX 环境的 executable、路径、resolver、signal 和 TTY 必须分别探查，不能由一个 execution world 推断另一个。

## Stateful visibility

journal 值、模型请求和 Client 展示是三种不同的数据面。append-only session log 中存在完整 journal，只能证明插件有材料尝试重建；DSH ordered surface/derived request history 才证明生成当前调用的模型看到过哪些声明。Client 的 `meta.dshPtcPlusBindings` inventory 只对用户展示，不进入模型上下文；当前 `repl.state(list)` 只描述命名 checkpoint 与 durability mode，也不让隐藏 binding 自动变成模型可知状态。

因此默认 REPL frontier 必须同时可重建且模型可知。result-only 剪裁若仍保留带精确源码的 assistant call，不改变该 cell 的模型 provenance；若 compaction 遮蔽了声明 call，raw journal 不足以继续暴露其 binding。插件不解析自然语言 summary 推断名称、值或依赖，而是收缩相关 cell 与依赖后缀，必要时从空 REPL 继续当前 cell。未来可以用显式选择、有界、结构化的 model-visible state projection 保留被压缩的状态，但它必须从 session log 重建、进入实际 request context，并遵守稳定 prompt prefix；不能仅为延长隐藏状态而默认注入，UI metadata 也不能替代它。

## Metadata boundaries

能力 explorer 分别报告：

- `completeness`：结果能证明多少；
- `effect` 与 `authority`：owner 声明的外部状态与治理边界；
- `replay`：recorded value、owner replay、volatile 或 unknown；
- schema/source/revision：存在证据时用于解释定义。

当前 live tool schema 只足以机械取得 name、description、parameters 和 output。PTC Plus 可证明自己的 `recorded-value` 行为与 DSH tool dispatch authority；其余字段保持 unknown，不通过自然语言摘要升级为事实。
