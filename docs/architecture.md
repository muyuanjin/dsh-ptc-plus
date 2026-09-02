# Architecture

PTC Plus 把 DSH PTC 模式的顶层 `run_code` 变成与 session 绑定的连续 TypeScript REPL。它负责 cell 求值、binding continuity、诊断、journal 和 cold replay；权限、sandbox、工具调度、取消、审批和跨平台进程治理仍属于 DSH 与操作系统。

## 运行边界

| 层 | 所有者 | PTC Plus 的工作 |
| --- | --- | --- |
| Authority / policy | DSH / 宿主 | 不复制；每次 native tool dispatch 仍经过原流水线 |
| Capability view | DSH 当前 scope | 保留 native typed `tools.*`，为一个 cell 建立统一 lease |
| Evaluation | session worker | 连续求值、顶层 binding、预算与输出编码 |
| Journal / replay | PTC Plus + session log | 记录 call transcript、settlement、completion 和恢复边界 |
| Presentation | DSH + PTC Plus | 保留 native guidance，并追加 REPL 指引与最小 explorer 声明 |

主入口接管模型直接发起的顶层 `run_code`，并通过 DSH tool registry 真实注册 `edit_run_code`。
使用 code-only direct-tool projection 的 PTC request 始终按固定顺序暴露 `[run_code, edit_run_code]`；插件用 agent scope 的
`tools.register()` 真实注册 edit transport，并用同一 scope 的 `tools.presentAs('both')` 放行这两个 provider tool call，再把其他 native tool 保留在 program SDK。首次可判定的 prompt assembly 在安装这项 presentation effect 前建立 agent composition owner；注册与 mode 记录都在所属 session、agent 或插件释放时撤销，native-mode 与无关 agent scope 不继承 `edit_run_code`。
DSH 为一个 agent composition 固定选择 `native`、`ptc` 或 `both`。首次 assembly 的非空 `tools:ptc-only` section text 证明 `ptc`，同名空 section 证明 `both`；`tools:code-only` 仅在 `tools:ptc-only` 缺失时作为兼容别名，两者同时存在时以 `tools:ptc-only` 为准。只有缺少 owner signal 时才能从 tool shape 推断。后续 assembly 不重新解释插件自己的 `tools.presentAs('both')` 效果，而是从 agent composition owner 派生 presentation。`ptc` 独占 direct-tool collapse、顶层 native-call normalization 和 native dispatch rejection；`both` 保留 native direct tools。`ptc` 与 `both` 都适配 PTC `run_code` schema、program SDK 和 session runtime contexts，只有 `ptc` 安装并直接执行 `edit_run_code`。model stream 将完整 call 的 session 与 call ID 绑定到由 composition mode 派生的 request policy，dispatch wrapper 替换 cancellation signal 不改变执行判定；result settlement 和 session、agent 或插件释放分别撤销单次 call 与整个 lifecycle。
若模型误发 live schema 可证明的顶层 native call，stream canonicalizer 会把这个 out-of-surface 调用规范为与模型本应生成的同一 member `run_code`；未知、畸形或不一致输入原样透传。派生 cell 不携带 provenance、纠错提示或其他模型可见标记；普通参数保留原始 JSON，含 own `__proto__` 的参数使用安全字面量，超过 TypeScript parser 安全深度的参数才使用浅层 `JSON.parse` 表达式。该规范化只修复无效 direct call。已声明的 `run_code` 与 `edit_run_code` 原样通过，因此 session history、UI 与下一轮 model context 保留合法调用的实际 tool name 和参数。

`edit_run_code` 对其持久化 `tool/call` 事件出现时当前 open turn 最近的可编辑 cell 生效，无论该 cell 被拒绝、运行失败，还是成功执行但结果需要微调。执行通过 call event sequence 读取该快照，后续 settlement 或 handler 调度不改变目标；派生 cell 则按外层 `tool/result` event sequence 进入恢复历史，使 cold replay 保持 live kernel 的实际结算顺序。
调查 tool 不擦除目标；edit 发起后的其他 settlement 不追溯改变其目标；一次成功 edit 生成的新 cell 成为下一次 edit 的目标。调用方必须且只能提交 `edits` 或
`regex_edits` 之一，并可携带 `expected_target_call_seq` 作为目标前置条件；它与 call event 已捕获目标不一致时，在任何派生 dispatch 前返回未编辑结果。`internal/rejected-cell-editor.js` 统一拥有 schema、匹配、replacement 语义、预算和原子源码组装；
所有位置都针对原始目标源码解析，全部范围不得重叠，预算通过后才以单次线性扫描物化结果。

注册工具通过 DSH 公共 `tools.execute()` 将完整修改后源码派生执行为 `run_code`。外层历史仍是模型真实发出的
`edit_run_code(delta)`；模型可见 result 只包含 `{ edited, value, error, logs }` 或拒绝原因。完整派生源码、journal 和目标 call sequence 只写入
外层 tool result 的私有 metadata，供审计和 cold replay 使用，不进入下一轮模型上下文，也不伪装成 assistant-authored
`run_code`。无目标或参数不合法时不执行，返回 `{ edited: false, reason }` 并保留原目标。
进程内 claim 区分 executing 与 settled：抛错、取消或缺少有效 PTC journal 的派生结果立即释放；已由 journal 证明进入 runtime 的派生执行继续占用旧 target，直到外层 result 的私有 metadata 通过最终 policy 并由 session log 投影为新 target。最终 result 丢失 metadata 时由 `tools/result` 释放。session log 投影在 edit call event 处记录 eligible target，只接受 target call sequence 匹配该快照且 journal 有效、非 noop 的派生源码，因此 live 与 cold recovery 从同一持久关系决定可编辑目标。

`internal/session-log-view.js` 单次前向扫描 session events，分别投影最新执行、可编辑目标、rewrite metadata、规范 journal 中的 Cordis transcript 计数和恢复 tip
所需事实。`edit_run_code` 不产生专用 runtime context：真实 call/result 已完整表达操作身份和结果，额外 contribution
只会触发 DSH 聚合 runtime-context 全量快照并重复无关 policy 文本。只有失败或完成状态不可信的 rewrite feedback 才保留独立生命周期；成功的透明改写不产生 runtime context。

插件卸载时恢复仍由自己持有的 `CodeRuntime.run` 与 `presentationMeta` 属性；若外层插件仍持有旧 wrapper，已卸载 wrapper 会透明委托原 provider，不会恢复已释放的 session 状态。
稳定 REPL 指引说明 cell 是 async function body、module 使用 dynamic import 或 require，并要求显式
return 或打印需要展示的值。失败恢复先按状态分类：解析或 preflight 失败且 `state: unchanged`、无外部效果证据时，
禁止重发完整源码，优先使用 `edit_run_code` 做精确修正并重放完整 cell；`state: partially-applied` 或可能已有外部 effect 时新建短
`run_code` 并复用已有 binding，完整重写只保留给结构性改动或超出编辑预算的修正。能力和命令执行依赖当前 request
与 execution world，模型必须先探查 live binding、实际 executable 和路径语义，不假设某个平台、shell 或 package runner。

live `PTC-C001` 若精确落在源码 EOF，独立的 bounded analyzer 只把追加单个 `}`、`)`、`]` 的三个源码分别送入该 cell 提交时的同一 preparation context。仅当唯一候选通过、无 binding collision，现有 exact editor 能从不超过固定预算的唯一尾部物化同一源码，并且 runtime 已取得该 rejected `run_code` 的持久 call sequence 时，诊断才输出一行可直接调用的 `edit_run_code({ edits: [...], expected_target_call_seq })`。edit transport 把该 sequence 与其 call event 捕获的目标比较，目标已变化时不编辑也不派生执行。这项 validated repair 优先于长度阈值，但只证明语法/preflight 接受；插件不自动 dispatch，也不改写原始 `run_code`。非 EOF、多候选、多 token、超预算、缺少目标身份或后续 preparation 拒绝均使用 length-adaptive help。

稳定指引保留这些跨任务不变量和失败恢复的优先动作。长 cell 失败的短提示直接作为当前 `PTC-X001` 的结构化 `help` 输出，避免一次性建议触发完整 runtime-context 快照；重复绑定失败和当前 execution world 中由诊断确认的 executable、shell 或 path 错误仍由当前 session log 派生为 `tools:ptc-plus-tip/<trigger>/<ordinal>` runtime context，分别提示能力探查或重新确认环境。投影只接受 DSH system-prompt owner 的规范快照，并按命名 section 的有效状态变化重建提示；聚合快照重复同一 section 不增加次数，正文不参与身份判断。
相同提示受 `tipCooldownMessages` 间隔约束，连续未解决时才升级为详细版本，成功 cell 会重置未解决计数；提示不会改变
system sections、tool schema 或 tool order，也不假设 Windows、WSL、POSIX、shell 或 package runner。

当前策略位于独立的 `internal/recovery-tips.js` local provider，核心只消费其有界的 named context。另一个固定名称 `tools:ptc-plus-cordis-recovery` 只在新 agent 或 Cordis 重新启用代际观察到历史 Cordis transcript 时出现，将 replay value 限定为历史数据，并保持到 session log 出现新的成功 `cordis_inspect*` settlement；它不受疲劳阈值控制、不重放调用，也不推断 live process 是否实际丢失。外部决策插件必须提供稳定的 facts/decision contract 才能接入；缺少该契约时，核心不猜测跨插件 API，并继续使用 local provider。

## 设置与启用开关

Host half 通过 DSH 公共 settings 服务注册 `ptc-plus` 命名空间，优先使用 provider-owned `installSection()`，并兼容根模块的 `installSettingsSection()`；两条路径共享同一 fallback、watch、rollback 与 disposal 语义。字段清单、默认值与校验来自 `internal/config-spec.js`。
Client half 通过 `settings.plugin.item` 卡片呈现全部配置。`enabled` 是 kill switch：关闭时只保留 settings 注册和设置卡片；`enhancedToolView` 是默认开启的正文展示开关，关闭时只交还 DSH 原生 `run_code`/`edit_run_code` generic row，
不注册 runtime、hook、tool surface 或 system prompt section；`ptc` 与兼容 `code` preset 会话在头部单独显示 `PTC Plus` 指示器。设置卡片显示“已启用/已停用”，稳定指引不包含 UI 品牌名。
`autoDescribeRunCode` 默认开启且只控制请求绑定的本地执行策略。开启时，缺少外层 `run_code.description` 的调用使用派生参数通过本地 DSH 校验，备用摘要仅进入 presentation metadata；关闭时由 DSH 校验原始参数。两种状态的模型可见 tool schema、tool order 和 system sections 保持字节稳定并包含 required `description`；原始调用参数、cell 与嵌套 native 参数保持不变。
所有字段都由 settings watch 即时交给各自 owner，且不替换已有 session-bound binding。每个已提交 cell 固定其提交时的配置代际，timer、worker 消息、program binding bridge、结果校验和诊断共同消费该快照；重配置更新随后提交 cell 的默认值。`maxOldGenerationSizeMb` 在活动 worker 存在时因 Node 的创建期限制而拒绝并回滚。settings 服务缺失时 Host 回退到 composition config，并保持相同的运行时语义。

`cordisToolsEnabled` 默认关闭且即时生效。Host 只在可见 `run_code` 的 agent scope 中挂载官方 `@deepseek-ai/dsh-tool-cordis`，并通过公共 `agentPresets` service 定位 shipped `cordis` preset，再用维护中的 Skill filesystem plugin 把其 companion Skill 目录发布到同一 scope。两个 child fiber、tool guidance 与 `cordis-plugin-development` Skill 是一个 mount；首轮 request 等待完整发布和 scoped Skill load 验证，关闭、agent/runtime 释放或任一激活失败时逆序卸载。工具名、数量、schema 和 guidance 直接来自 official tool fiber，Skill 内容直接来自 shipped preset，Host 均不复制。官方插件同时向 process-global `cordisInspect` 注册 Host provider；owner 将 manifest 相同的 per-agent 注册合并为引用计数 lease，查询委托给当前仍存活的官方 registration，最后一份 lease 释放后才注销 provider。manifest 不一致时启用失败。该开关不切换 preset，也不改变 code-only direct-tool projection。

## Prompt 前缀稳定性

对当前 DSH 公共扩展面的集成，模型 request 由重复的 system prompt、完整有序 tool schemas 和从 session log 派生的消息历史组成。缓存契约按变化位置分类，而不以某次 provider 是否命中作为判断依据：

| 类型 | 本项目约束 |
| --- | --- |
| Stable repeated prefix | 插件配置、模型 route 与 native capability view 不变时，插件拥有的 system text、schema 内容和 tool order 在每次 request 中保持字节一致。 |
| Append-only growth | tool call/result、诊断和动态 runtime context 只追加到已保留历史之后，不修改 `request/header` 或更早的消息。 |
| Replacement | 只有 DSH 拥有的 compaction 或其他显式 surface replacement 可以替换已保留历史；PTC Plus 不用 replacement 表达瞬时状态。 |
| Independent request | 新的辅助模型调用必须单独说明 route、prefix 和 token 影响，不能用它的缓存表现证明主会话前缀稳定。当前插件不发起辅助模型请求。 |

一次性或会变化的 session 状态必须作为 `PromptAssembly.contexts` 的命名贡献交给 DSH。DSH 将完整快照记录为带来源的 `user/message` 并追加到历史尾部；值未变时不重复，值变化或全部消失时追加更新或 clearance。完整快照携带当时所有 owner 的命名 context，因此任一贡献变化都会使未变化贡献在新的尾部消息中再次出现；这会增加 append-only history token，但不会改写已有前缀。PTC Plus 不通过绕过 prompt assembly 的私有消息通道规避这项宿主聚合成本。Cordis 恢复 context 使用规范 journal 的历史 transcript 与当前 agent/enable generation 作为事实源，不能从进程内 Plugin registry 直接生成未记录输入。此类状态不得进入 `PromptAssembly.sections`，也不得通过增删 tool、改变 schema 字段或调整 tool order 传递。

所有模型可见输入都必须能从 session log 重建。静态 system/schema 由 `request/header` 保存，动态 context 由带来源的 `user/message` 保存；进程内临时状态不能直接成为未记录的模型输入。在同一插件版本与配置下，普通执行结果、可编辑目标、诊断和其他插件拥有的运行期变化都不得改变 header；`edit_run_code` 的身份与结果由真实 call/result 表达，不生成 edit feedback context。插件升级、显式配置变化、provider/model route 变化、真实 native capability schema 变化，以及 DSH 拥有的 history replacement 可以使缓存从首个变化 token 起失效。

缓存稳定性必须有 keyless contract test：跨每个相关生命周期状态序列化并比较完整 system text 与有序 tool schemas，同时断言 edit 不增加 runtime context。真实模型的 `cacheReadTokens` 只作为端到端补充；“不破坏缓存”表示插件保留已有可复用前缀，不承诺 provider 建立、保留或命中缓存。

## 能力表面

cell 直接使用 DSH 为当前 request 提供的 `tools.*`，不按工具名过滤，不翻译已提供的 program-call 参数或 canonical result。只有完全省略参数且 DSH 的 live object schema 验证 `{}` 合法时，worker 才在 encoding 前把 omission 规范为 `{}`；显式 `undefined`、需要输入的 member 与其他 namespace 不变，调用方携带的内部 metadata 不能扩大这项集合。模型 direct-call 边界与这个 data-plane contract 分离：声明的顶层 transport 是 `run_code` 和 `edit_run_code`；可证明的误发 native call 可先规范为 `run_code`，native member 随后在 cell 内 nested dispatch。所有 native member、`capabilities.*`、`repl.state` 和 `code.run` 共享 cell lease；cell 结束后，捕获的函数统一失效。调用时仍由 DSH 检查 scope、policy、取消和 scheduler。

`capabilities.tree/find/inspect` 是描述 API，不是反射调用入口。默认 SDK 只展开这个导航器；`repl.state` 与 `code.run` 保持可调用，但其完整契约只在 explorer 中按需返回。explorer 合并 live tool schema 与插件自有 program-binding 描述；可证明的 metadata 包括名称、描述、输入/输出 schema、authority 和 replay。effect 与 result completeness 没有 owner 证据时保持 `unknown`。探索不会授予权限或触发额外模型调用。

当前公共扩展面没有跨 prompt assembly 与 cell dispatch 的冻结 view token。PTC Plus 使用同一 agent scope 分别读取 prompt 和 runtime view，并让实际 request binding 成为执行事实；能力在两阶段之间变化时，不伪造原子快照保证。

CodeRuntime request 已携带的 owner-provided program namespace 会被原样保留并共享 cell lease，PTC Plus 不翻译其参数或结果。与插件保留的 `capabilities`、`code` 或 `repl` 同名时 request fail-fast，避免主线程与 worker 绑定分叉；普通 cell 局部变量允许自然 shadow 这三个低频 namespace，必要时可通过 `globalThis` 访问。`tools` 仍是保留名称，因为 shadow 它会切断主要能力面。当前公共扩展面没有用于发现额外服务的 program-binding registry；插件不提供名称分发总线或私有 provider registry。若 DSH 以后提供统一 registry，PTC Plus 只消费实际 request 中的 live binding，不复制 authority 或 discovery。

## REPL 生命周期

每个顶层 `run_code` 是同一 session kernel 的下一格。顶层 binding 跨 cell 保留；默认宽松模式允许一个完整 declarator 全部替换已有变量，严格模式拒绝重声明，关闭 `autoSplitRedeclarations` 时混合新旧名称的解构也在执行前拒绝。cell 始终作为 async function body 求值，支持 block scope、top-level `await` 和普通控制流 return；return lowering 通过顶层 `this` receiver 访问每个 cell 独立生成并在 settlement 清理的 worker-global signal property，因此 lexical `globalThis` 与 `with` object environment 都不能重定向控制流。worker 启动时验证该 receiver 指向 evaluator 的 global context。跨 cell 重声明是 REPL 便利策略，由 `internal/repl-convenience.js` 独立实现；它不是 cell 语言或原生 JavaScript 语义的组成部分。

包裹前的 AST 重写适配模块语法（cell 是 async function body，模块声明在函数体内非法）：全部默认开启且可用 config 关闭（`autoRewriteImports` / `autoStripExports` / `autoSplitRedeclarations`）。原始 Babel Program 在任何 lowering 或 preload 前完成 scope validation；同一 cell 的 value import 与 lexical、hoisted `var`、function 或其他 import 重名会按模块 binding 规则拒绝，block shadow 和 type-only 名称仍合法。静态 `import` 声明产生有序 module preload record；worker 通过短生命周期 ESM adapter 让 Node 从 session cwd 完成解析和 export linkage，再在 cell 编译前通过生成的临时 global identifier 把 namespace 交给另一个持久 lexical identifier。两者都避开当前源码、持久 binding、program binding 与活跃 private namespace，生成的 prologue 直接引用临时 identifier，因此 lexical `globalThis` shadowing 不参与 host capture；临时 global 在 cell settlement 清理。session 未记录 cwd 时，解析基准回退到 worker process cwd；目标模块的依赖保持各自的自然 parent。scope-aware alias lowering 保留 named/default binding 的 live read、只读、shadowing 和跨 cell 重放语义。value import alias 活跃时，原始 Program 上的 direct `eval` 与 `WithStatement` 在任何 preload record 生效前拒绝，因为生成的 namespace property read 无法复现它们的动态 lexical resolution；没有 value alias 的非严格 `with`、type-only import 和局部 shadow 的 `eval` 仍使用普通 JavaScript 语义。顶层 `export` 修饰符剥离（声明保留、`export default` 转为 `__default` 绑定、re-export 转为预加载的副作用模块、type-only export 擦除）；REPL 便利层在 `autoSplitRedeclarations` 开启时按插件定义的兼容规则 lowering 混合新旧名称的顶层解构，关闭时保持原文走既有解析失败路径。无法精确适配的形态在执行前拒绝。改写来源以 `meta.dshPtcPlusRewrites` 平行记录（journal schema 封闭）。成功改写不改变下一步决策，因此不产生 runtime context；改写后失败或缺少有效 journal 时，`tools:ptc-plus-rewrite-info` 才在下一轮说明恢复边界。

可确定的计算和 recorded-value capability call 可以推进 durable head。未进入 journal 的 Node/OS 能力、环境输入、时钟、随机数和 timer 进入 sticky `volatile`；live worker 继续可用，cold replay 回到最后 durable frontier。`require(...)` 与动态导入按同一白名单分类：白名单内置模块（assert/buffer/querystring/string_decoder/stream/util/url/zlib）保持 durable，其余 volatile，`worker_threads`/`cluster` 等内核控制模块在执行前以 PTC-C002 拒绝。durable 只描述冷恢复对已结算历史的重放能力；失败 cell 仍可能已经修改 binding 或产生外部 effect，不能由 durability 推导出安全重试。worker thread 是生命周期隔离，不是安全沙箱。

宿主工具调用经 worker 回调回到主线程时，DSH 的 AsyncLocalStorage initiator 上下文在回调中为空。插件注入 `agents` 服务并在 `invokeBinding` 处用 `withInitiator(精确活跃 agent, ...)` 建立边界，因此要求 driver 内精确调用 agent 的宿主工具（如 goal 跟踪的 `goalToolExecution` 检查）可从 cell 内直接调用；`edit_run_code` 的派生 `run_code` 也复用该宿主流水线，不通过 stream canonicalizer 伪造模型调用。

## Journal 与恢复

每个进入 evaluator 的 cell 写入版本化 journal：

```ts
{
  version: 3,
  bindingMode: "loose" | "strict",
  rewritePolicy: { autoRewriteImports, autoStripExports, autoSplitRedeclarations },
  status: "durable" | "volatile" | "discarded" | "noop",
  calls: CallTranscript[],
  operations: StateOperation[],
  confirms: number[],
  diagnostics: Diagnostic[],
  completion?: Completion,
  volatileReason?: string
}
```

`calls` 只保存 global、member、PTC Value Graph 编码的 args/result 或 error，以及 settlement 序号。cold replay 校验调用名称、参数、数量和提交顺序，并按 recorded settlement order 释放 recorded result；不会重新 dispatch program binding 或重做外部 effect。该规则同样适用于 native tools、owner-provided namespace 和 `code.run`，不按名称分支。Cordis 的进程内对象不会因此被宣称已恢复；presentation 可以从已验证 transcript 派生重新检查要求，但不能改变 replay。若基础设施终止时仍有未结算 binding，heap 回滚到 durable frontier，discarded journal 以最先观察到的 `global.member` 保留 possible-effect boundary。effect、completeness 和 source metadata 属于 capability explorer，不伪装成 journal 字段。

journal 通过 `run_code.output.presentationMeta` 附着到最终 result，再由 `tools/result` 做两阶段确认。缺失、损坏或被替换的 journal 形成 unknown/volatile 边界；未进入 runtime 的 call 由后续 `confirms` 以对应 `tool/call.seq` 证明为 no-op。volatile 源码保留在原 session log，但不参与 cold replay。

durable replay 无法验证某个 node 时，当前已结算 `tool/result` 的私有 `meta.dshPtcPlusRecoveryBoundaries` 记录失败 call 与其 parent frontier，不修改冻结的历史 result。boundary 在进入排序前必须完成 schema 与 event-sequence validation；损坏 metadata 使恢复 fail closed，不能从 fold 中静默消失。折叠器剪除该 node 及依赖后代、重算可重建 checkpoints；kernel 重置 worker 并逐级验证更早 frontier，随后执行当前 live cell。新 durable node 的 parent 始终是 worker 实际拥有的 frontier。自定义 boundary event 不由运行时生成，迁移工具必须在 DSH restore 前显式转换它。

诊断由封闭结构确定性渲染，包括语法、preflight、绑定冲突、输出、运行异常和恢复边界。普通成功与首次进入 volatile 不投影 warning/note；恢复分类保留在 journal 和 `repl.state(list)` 中。

更详细的结果边界见 [Program Data Plane](program-data-plane.md)，能力元数据见 [Capability Surface](capability-projection.md)，恢复协议见 [Durable / Volatile](durability-design.md)。

## Decisions

- [Delegate Governance to DSH](adr/0001-delegate-governance-to-dsh.md)
- [Limit Work Map Scope](adr/0002-limit-work-map-scope.md)
- [Prefer Native Program Surfaces](adr/0003-prefer-native-program-surfaces.md)
- [Declare Program Bindings At The Owner](adr/0004-declare-program-bindings-at-the-host.md)
- [Register Edit And Run As A Truthful Composite Tool](adr/0005-temporary-rejected-cell-edit-transport.md)
- [Track The Latest DSH Public Surface](adr/0017-track-the-latest-dsh-public-surface.md)
- [Plugin Settings UI and Enabled Kill Switch](adr/0019-plugin-settings-and-kill-switch.md)
- [Optional Cordis Tools in PTC Mode](adr/0020-optional-cordis-tools-in-ptc-mode.md)
- [Separate Host Bootstrap From Session Runtime](adr/0021-separate-host-bootstrap-from-session-runtime.md)
