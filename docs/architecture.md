# Architecture

PTC Plus 把 DSH PTC 模式的顶层 `run_code` 变成与 session 绑定的连续 TypeScript REPL。它负责 cell 求值、binding continuity、诊断、journal 和 cold replay；权限、sandbox、工具调度、取消、审批和跨平台进程治理仍属于 DSH 与操作系统。

## 运行边界

| 层 | 所有者 | PTC Plus 的工作 |
| --- | --- | --- |
| Authority / policy | DSH / 宿主 | 不复制；每次 native tool dispatch 仍经过原流水线 |
| Capability view | DSH 当前 scope | 保留 native typed `tools.*`，为一个 cell 建立统一 lease |
| Evaluation | session worker | 连续求值、顶层 binding、预算与输出编码 |
| User-global defaults | PTC Plus Host + session worker | 原子存储、源码派生快照、请求激活与 session-local shadow |
| Journal / replay | PTC Plus + session log | 记录 call transcript、settlement、completion 和恢复边界 |
| Presentation | DSH + PTC Plus | 保留 native guidance，并追加 REPL 指引与最小 explorer 声明 |

求值层由插件自有的 helper 进程承载：Host 只持有 `IsolatedWorker` transport，真实 `node:worker_threads` session worker 与其私有 `MessagePort` 都留在 helper 内，IPC 只传输 plain data。宿主回收卡住的计算时只强杀自己的 helper process，DSH 进程内没有需要终止的 session worker，因此不会触达已测得会落入 Node 24/26 cppgc teardown fault 的 in-host worker 强杀路径；`IsolatedOwner` 只在该实例的 real exit、output close 和 cleanup 都完成后释放。kernel、console、candidate 三个入口各自拥有 owner。helper 的 `init` 携带 fork 前 snapshot 的投影环境，user Worker 及其子进程保持原 env 契约，不会继承 `NODE_V8_COVERAGE` 等宿主 instrumentation；Electron Host 只在 helper fork 环境覆盖 `ELECTRON_RUN_AS_NODE=1`，该启动变量不进入 user Worker。inner Worker 的 compute budget 在每次请求提交时通过 helper 的 on-demand sample 取新鲜 `eventLoopUtilization` baseline，ready handshake 另有启动样本；采样失败按 worker-exit 有界失败且不派发 prepare/run。唯一例外由 [ADR 0024](adr/0024-repl-console-observation.md) 所有：同一 worker 已确认存在未完成的 observation 时，prepare 可先于预算启动，确认 observation 完成后才开始计时。

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
会重复已有事实；此类信息不进入独立 PTC 消息。只有缺少有效 journal、无法确认完成状态的 rewrite feedback 才保留独立生命周期；已结算失败的恢复指引由当前结果表达；成功的透明改写不产生 runtime context。

插件卸载时恢复仍由自己持有的执行缝 `run` 与 `presentationMeta` 属性；执行缝由 `internal/execution-seam-compat.js` 按宿主注册的服务选定，并同时收回该插件无法兑现的 provider 描述符（见 [ADR 0028](adr/0028-attach-to-the-host-ptc-execution-seam.md)）。若外层插件仍持有旧 wrapper，已卸载 wrapper 会透明委托原 provider，不会恢复已释放的 session 状态。
稳定 REPL 指引与执行共同从 `binding-update-policy.js` 取得语言代际。新代际说明 TypeScript、顶层 await/return、静态 import/export 与所选绑定更新策略；旧兼容态才按其独立开关说明支持的模块语法。显式结果使用 return，日志使用 console；原生表达式 completion 同样可以提供结果值。失败恢复先按状态分类：result 已证明解析或 preflight 未执行且提供符合任务意图的 validated repair 时，
优先直接使用带目标保护的 `edit_run_code`，无需等待 recovery context；该验证只证明语法/preflight 接受。其他小型修正可用 edit 执行完整 cell；
已执行或可能产生外部 effect 的目标，则必须依据操作 owner 的 retry/idempotence 契约和执行事实判断重跑。短 `run_code` 可以复用仍存活的 binding，但缩短源码不能证明幂等。能力和命令执行依赖当前 request
与 execution world，模型必须先探查 live binding、实际 executable 和路径语义，不假设某个平台、shell 或 package runner。

live `PTC-C001` 若精确落在源码 EOF，独立的 bounded analyzer 只把追加单个 `}`、`)`、`]` 的三个源码分别送入该 cell 提交时的同一 preparation context。仅当唯一候选通过、无 binding collision，现有 exact editor 能从不超过固定预算的唯一尾部物化同一源码，并且 runtime 已取得该 rejected `run_code` 的持久 call sequence 时，诊断才输出一行可直接调用的 `edit_run_code({ edits: [...], expected_target_call_seq })`。edit transport 把该 sequence 与其 call event 捕获的目标比较，目标已变化时不编辑也不派生执行。这项 validated repair 优先于长度阈值，但只证明语法/preflight 接受；插件不自动 dispatch，也不改写原始 `run_code`。非 EOF、多候选、多 token、超预算、缺少目标身份或后续 preparation 拒绝均使用 length-adaptive help。

稳定指引保留这些跨任务不变量和失败恢复的优先动作。长 cell 失败的短提示直接作为当前 `PTC-X001` 的结构化 `help` 输出；重复绑定失败和当前 execution world 中由诊断确认的 executable、shell 或 path 错误仍由当前 session log 派生为以 `tools:ptc-plus-tip/<trigger>/<ordinal>` 标识的独立 notice，词法失败指向可见源码与初始化，worker-owned capability 失败才指向能力探查，平台错误则提示重新确认环境。投影合并规范 PTC notice 与历史 DSH system-prompt snapshot sections，同一已投递 identity 跨两种来源只计一次，正文不参与身份判断。
相同提示受 `tipCooldownMessages` 间隔约束，连续未解决时才升级为详细版本，成功 cell 会重置未解决计数；提示不会改变
system sections、tool schema 或 tool order，也不假设 Windows、WSL、POSIX、shell 或 package runner。

当前策略位于独立的 `internal/recovery-tips.js` local provider，核心消费其有界 named tip，并按 ADR 0010 的独立消息契约投递。另一个固定名称 `tools:ptc-plus-cordis-recovery` 只在新 agent 或 Cordis 重新启用代际观察到历史 Cordis transcript 时出现，将 replay value 限定为历史数据，并保持到 session log 出现新的成功 `cordis_inspect*` settlement；它不受疲劳阈值控制、不重放调用，也不推断 live process 是否实际丢失。外部决策插件必须提供稳定的 facts/decision contract 才能接入；缺少该契约时，核心不猜测跨插件 API，并继续使用 local provider。

## 设置与启用开关

Host half 通过 DSH 公共 settings 服务注册 `ptc-plus` 命名空间，优先使用 provider-owned `installSection()`，并兼容根模块的 `installSettingsSection()`；两条路径共享同一 fallback、watch、rollback 与 disposal 语义。字段清单、默认值与校验来自 `internal/config-spec.js`。
Client half 通过宿主当前代的设置座位呈现全部配置：旧代际是 `settings.plugin.item`（keyed，按 namespace），当前 DSH 是 Plugins 页面的 `plugins.row.config`（keyed，键 `<包名>#<行 id>`），两者由 `src/client-host-compat.js` 同一次发布、由声明槽位的一代渲染，页面按 `summary`/`page` 视图分别取一句描述与完整表单（[ADR 0019](adr/0019-plugin-settings-and-kill-switch.md)）。`enabled` 是 kill switch：关闭时保留 settings 注册、设置卡片与撤销旧 PTC 声明所需的被动 presentation cleanup；`enhancedToolView` 是默认开启的正文展示开关，关闭时只交还 DSH 原生 `run_code`/`edit_run_code` generic row，
总开关关闭时不注册 runtime、执行 hook、tool surface 或 system prompt section，也不读取 binding 存储；`ptc` 与兼容 `code` preset 会话在头部单独显示 `PTC Plus` 指示器。设置卡片显示“已启用/已停用”，稳定指引不包含 UI 品牌名。
`autoDescribeRunCode` 默认开启且只控制请求绑定的本地执行策略。开启时，缺少外层 `run_code.description` 的调用使用派生参数通过本地 DSH 校验，备用摘要仅进入 presentation metadata；关闭时由 DSH 校验原始参数。两种状态的模型可见 tool schema、tool order 和 system sections 保持字节稳定并包含 required `description`；原始调用参数、cell 与嵌套 native 参数保持不变。
所有字段都由 settings watch 即时交给各自 owner，且不替换已有 session-bound binding。每个已提交 cell 固定其提交时的配置代际，timer、worker 消息、program binding bridge、结果校验和诊断共同消费该快照；重配置更新随后提交 cell 的默认值。`maxOldGenerationSizeMb` 在活动 worker 存在时因 Node 的创建期限制而拒绝并回滚。settings 服务缺失时 Host 回退到 composition config，并保持相同的运行时语义。

`bindingUpdates` 是新配置的统一入口，默认 `stateful`，也可选择 `protected`。Host schema 保留该字段原始缺省状态，再由 `runtime-config.js` 把完整旧策略映射到相应新策略；混合旧开关保留显式 `legacyBindingSettings` 兼容态。Client 复用同一 resolver，仅在兼容态展示旧开关；用户选择统一开关时，一次 settings update 同时写入新策略并清除兼容标记。

`cordisToolsEnabled` 默认关闭且即时生效。Host 只在同时暴露 `run_code`、`skill` 工具与 `agentPresets`/`skills` service 的 agent scope 中挂载官方 `@deepseek-ai/dsh-tool-cordis`，并通过公共 `agentPresets` service 定位 shipped `cordis` preset，再用维护中的 Skill filesystem plugin 把其 companion Skill 目录发布到同一 scope。两个 child fiber、tool guidance 与 `cordis-plugin-development` Skill 是一个 mount；首轮 request 等待完整发布和 scoped Skill load 验证，关闭、agent/runtime 释放或任一激活失败时逆序卸载。缺少其中任一 surface 的 scope 不是错误：owner 保持 pending、不在该 scope 发布内容，并在工具 surface 变化或下一次 prompt assembly 时重试；由宿主自身调用触达的不可用 scope 只从该 scope 撤出并记一条 warning，不使 `agents.create()` 或 prompt assembly 失败（[ADR 0029](adr/0029-keep-plugin-unavailability-out-of-the-host-agent-lifecycle.md)）。工具名、数量、schema 和 guidance 直接来自 official tool fiber，Skill 内容直接来自 shipped preset，Host 均不复制。官方插件同时向 process-global `cordisInspect` 注册 Host provider；owner 将 manifest 相同的 per-agent 注册合并为引用计数 lease，查询委托给当前仍存活的官方 registration，最后一份 lease 释放后才注销 provider。manifest 不一致时启用失败。该开关不切换 preset，也不改变 code-only direct-tool projection。

## Global User Bindings

`internal/user-bindings.js` 是条目、文档、请求快照和有界声明的严格规范化 owner。它从命名 value export 的 TypeScript 源码派生 symbols、binding kind、body-free declaration、durability 与 fingerprint，并封闭校验所有衍生字段；调用方不能提交一份与源码不一致的声明或 snapshot。源码声明保留未被遮蔽的环境类型，并收集公开签名引用的本地 interface、type alias 与 class 闭包；各条目使用独立声明 namespace，公开 class shape 包含实例字段与 constructor parameter property。无法形成自足声明的 imported type 在持久化前拒绝，不能静默替换为 `unknown`。`namespace` scope 产生一个条目名对象，`top-level` scope 产生选定导出；保留名称和启用集合中的调用标识符冲突在持久化或请求激活前拒绝。

可选 `modelContext` 与源码一起持久化，包含默认开启的接口注入开关 `includeDeclaration` 和独立注入的提示词 `instructions`。声明只有源码派生这一份，不另行编写。非空 metadata 参与条目 fingerprint；旧条目省略该字段时保持原序列化与 fingerprint，存储文档无需迁移。此前保存的 `enabled` / `declaration` 字段保留规范化形式以验证旧 fingerprint，但旧自定义声明不用于展示或注入；旧关闭状态映射为声明关闭、提示词为空，下一次编辑保存使用新字段。Client 安全的结构校验和偏好映射由 `internal/user-binding-model-context.js` 复用，预算和完整 schema 见 [ADR 0023](adr/0023-global-user-bindings.md)。

`internal/user-bindings-store.js` 独占 `$DSH_HOME/ptc-plus/bindings.json`。单一 JSON 文档避免源码与 metadata 双源；进程内队列、file lock、磁盘文本比较、expected revision 和 atomic replacement 共同防止并发覆盖。每次 mutation 在替换前验证完整 enabled snapshot 的声明预算；外部写入的超限文档按损坏输入处理。损坏输入保持显式 error，不会被空文档静默覆盖。候选与正式激活的相对 import 都以该文件所在目录为基准，因此 session cwd 不会改变 helper 的依赖解析。

prompt assembly 为每个 PTC request 取得一次当前启用条目快照，作为随后 dispatch 的期望集合。`tools:ptc-plus-user-binding-defaults` 从首轮通过追加的 PTC API catalog 展示条目提示词及按开关选择的源码派生接口，按稳定 ID 排序，只描述配置 API 与执行时初始化契约；组装不执行源码，也不读取激活状态或加入 revision。`/binding` 保存并启用、会话中途启停、删除或修改模型上下文后，下一次宿主允许且接受的步骤追加当前说明或撤销旧说明，无需等待激活。条目变化不改写 system、tool schema、顺序或旧消息；未变说明按已提交日志与公共 ordered surface 去重，重启后继续使用相同证据。停用条目不贡献内容，关闭声明且提示词为空的条目同样省略。

配置段是全局绑定提示词与接口的唯一注入来源，不包含实现源码；成功初始化、session-local shadow 和 worker 重建本身不生成活动公告，也不触发相同配置重发。执行结果与诊断拥有实际行为证据；需要验证可用性时只对已知名称做无副作用观察。历史 `tools:ptc-plus-user-bindings` 活动段保留读取支持，下一次允许且接受的快照撤销旧活动声明一次。`tools:sdk` 与 direct-tool schema 不随条目内容改变。配置 API 不证明当前值，也不延长被 compaction 遮蔽的 session-local 状态。runtime 在 cell preflight 前把期望集合映射到 BindingCatalog，再由 worker 激活：当前覆盖粒度为 `per-name`，同名 session-local binding 只覆盖对应全局名称，同条目的其他名称继续激活；v1-v7 历史 cell 保留整条 entry 退出的旧粒度。条目级失败产生诊断并从该 cell 排除，不阻塞独立代码。失败 initializer 一旦发起 program call，整个 cell 进入 volatile，因此只包含成功条目的结果 snapshot 不会被误作该调用的 cold replay source。

每个 session kernel 和 binding workbench 各自使用所在 worker 的原生 Node realm。cell、PTC 管理模块、provided `require` 与 binding module 因而共享 intrinsic identity 和 `globalThis`；用户显式创建的 `node:vm` context 或独立运行时保留自己的 realm。

worker 对 namespace 成员和 top-level 导出保留 ECMAScript module live read；对顶层名称的赋值或重声明将该名称转换为 session-local binding，并使该名称在后续全局激活中保持 session-local 覆盖，同一条目的其他名称不受影响；v1-v7 历史 cell 仍按整条来源条目退出。当前 `stateful-module-v2` binding module 通过编译后的 logical-root resolver 取得 program namespace，并为每个 cell 建立绑定原 lease 的 namespace view。`stateful-module-v1` 与 legacy binding module 保留其记录代际的 worker-global bridge。两条路径都使旧 continuation 无法借用后续 cell 的 authority，并在后续 request 反映 namespace 的新增与移除。需要安装历史 bridge 且名称与既有 worker global 冲突时，安装在写入前整体失败，避免覆盖 Node intrinsic 或留下部分 namespace。一个导出闭包一旦可能被普通 session binding 保存，worker 就无法证明其不可达，因此相应 synthetic-module 解析基准与历史 bridge 保守保留到 worker 结束。worker 从未成功暴露过需要 bridge 的条目时，disabled 或 empty activation 不安装 bridge；若本次尝试全部失败，则在执行 cell 前移除本次安装的 bridge。

配置段以消息文本直接投递，不进入 system renderer；提示词与声明中的 `{{...}}` 保持字面量，不被解释为宿主变量。投递遵守 runtime-context suppression、取消和步骤准入，解除屏蔽后的下一请求同步当前说明。worker 对同一条目 ID 只比较源码、scope、namespace 调用名和有序导出列表来决定模块复用；模型上下文、purpose 或 top-level 显示名称变化不重置模块状态，也不重复初始化。

每个结算 cell 把实际激活的完整 snapshot 放入私有 `meta.dshPtcPlusUserBindings`。包含模型上下文的完整 fingerprint 继续拥有快照校验与 provenance。snapshot v2 的 `transform` 由固定版本的 `internal/typescript-transform.js` 编译器 owner 提供，并参与快照 fingerprint；恢复先验证转换代际，不能用当前编译器替代未知历史转换器。未记录该代际的非空 v1 snapshot 按 unknown-boundary 规则收缩，空 v1 snapshot 保持原 fingerprint 和恢复资格。journal 的 `userBindingsReusePolicy` 为新 cell 记录 `implementation-v1`；v1-v5 则迁移为 `fingerprint-v1`，v6 保留其记录值。覆盖粒度与复用代际相互独立：`userBindingsShadowPolicy` 为新 cell 记录 `per-name`，v1-v7 迁移为 `whole-entry`；`userBindingNames` 按名称记录该 cell 结算时的 provider/local/absent/unknown 事实，provider 事实另带 `entryId`，`whole-entry`、noop 与 discarded cell 为显式 `null`，并与并行快照共同校验名称证据的完整性与来源。对仍可证明的历史，cold replay 重新验证源码及其所有派生字段，逐 cell 应用记录的复用策略，保留因 purpose 或 top-level 显示名称变化而发生的模块重置；接续的 live cell 使用新策略，不因策略切换本身重置模块。恢复不读取当前文件来替换过去状态，也不重新派发初始化中的宿主调用。缺失或未知策略与其他无法证明的 metadata 一样，按 session recovery 的 unknown-boundary 规则收缩。

`internal/user-bindings-owner.js` 只在 `userBindingsEnabled` 开启时经 `internal/host-rpc.js` 注册由宿主 Gateway、Host/Origin fence 与浏览器认证保护的管理 Remote。它从精确 agent scope 的公共 `run_code` tool view 判断资格，在 agent 创建和 `tools/change` 时协调 `/binding`，不依赖 preset 名称。命令 registration 由该 agent 的注入 fiber 持有；命令服务迟到时保留 pending fiber，回调若已失去资格则失败并清理占位。生命周期监听的安装代际独立于请求与 projection 代际，不能因 projection 就绪而跳过注册。Agent disposal 只清理该精确 Agent 的资源，session disposal 才按 session ID 清空。Client 从 Host command directory 判断首轮前的 composer 编写入口，已有文本不被覆盖。REPL 全局绑定区和 Settings 管理弹窗复用完整工作台，通过 RPC 管理持久条目，不依赖当前存在 PTC 会话；会话观察及其独立 UI metadata 边界见 [ADR 0024](adr/0024-repl-console-observation.md)。

`/binding new` 与 `/binding edit` 经 `agent.steer` 追加完整编写指引并启动普通 turn 后完成 admission；该成功不宣称草稿已生成。`internal/user-binding-authoring.js` 拥有稳定 `code.submitBindingDraft({requestId, entry})` SDK、发现 schema 与字段说明，候选校验仍由 `user-bindings.js` normalizer 拥有。runtime bridge 在 cell 创建时捕获请求，提交时核验精确 agent、requestId、代际、lease 与单次提交资格，并在异步验证后重查。SDK 存在性由配置决定，瞬时资格不通过挂卸 tool 或 Skill 表达。program transcript 的 cold replay 只返回旧交接结果，不再提交或恢复草稿。

接受结果的私有 metadata 同时保留 opaque locator 与完整 source-owned candidate，后者携带 requestId 和 commandId。`ptcPlusBindingDraft` projection 从真实 command、turn 和接受结果派生当前编写状态，并独立保存只读历史；历史可跨重挂载、seed 和 owner 代际重建，旧 locator 不恢复。管理 Remote 不提供 caller/session identity，因此草稿 RPC 只接受 capability。用户保存或丢弃完成后，Host 消费可写 locator，并用公共 `Session.append` 追加引用 accepting result 的结构化 action notice；正文只含身份与保存/启停事实，不含源码或 locator，也不宣称激活。回执 append 失败不能撤销已完成写入或恢复保存资格。`draft-review` 提供当前生命周期内的只读结果，持久关系由 projection 的精确 source relation 验证；不能用后来修改的同 ID 存储条目替换历史源码。完整格式由 [ADR 0023](adr/0023-global-user-bindings.md) 拥有。

Client 遇到冲突后重读 catalog、draft 和 review；只有权威空 draft 才撤销操作，仍有效的候选保留供用户决定重试。new draft 使用 create-only write，edit 保持原 ID；用户保存为停用或保存并启用都原子认领草稿并校验 revision，并发 discard 返回 busy。Agent、session、功能或 owner 结束撤销相关 locator 与内存 review，迟到的存储结算不能复活它们。仅撤销未保存草稿不追加持久化回执。

全局绑定代码控制台通过 `internal/user-binding-console.js` 按需创建 Node REPL worker，直接运行当前源码草稿并跨命令保留临时变量；普通错误保留此前状态。Host 生成 opaque handle，限制同时存在的环境和单环境并发，沿用执行时间、输出与内存预算；连续 10 分钟未执行、源码替换、离开工作台、停止或 owner 释放时终止环境。旧候选 `run` RPC 保持兼容。两条路径都不连接 Agent kernel 或写入 session journal；源码和 import 仍拥有 DSH 进程的 Node/OS 权限，外部 effect 不能回滚。`replViewEnabled` 与 `bindingAuthorButtonVisible` 仅控制各自 UI 入口，`userBindingsEnabled` 仍拥有整个全局绑定能力。模型没有常驻 binding 管理 API，插件也不从 session binding 反推模块源码：缺少完整源码 provenance 时，session-to-global promotion 无法无损实现。

## Prompt 前缀稳定性

对当前 DSH 公共扩展面的集成，模型 request 由重复的 system prompt、完整有序 tool schemas 和从 session log 派生的消息历史组成。缓存契约按变化位置分类，而不以某次 provider 是否命中作为判断依据：

| 类型 | 本项目约束 |
| --- | --- |
| Stable repeated prefix | 插件配置、模型 route 与 native capability view 不变时，插件拥有的 system text、schema 内容和 tool order 在每次 request 中保持字节一致。 |
| Append-only growth | tool call/result、诊断和动态 runtime context 只追加到已保留历史之后，不修改 `request/header` 或更早的消息。 |
| Replacement | 只有 DSH 拥有的 compaction 或其他显式 surface replacement 可以替换已保留历史；PTC Plus 不用 replacement 表达瞬时状态。 |
| Independent request | 新的辅助模型调用必须单独说明 route、prefix 和 token 影响，不能用它的缓存表现证明主会话前缀稳定。当前插件不发起辅助模型请求。 |

PTC 动态状态通过 DSH 公共 `agent/pre-step` 追加为 `source.plugin: ptc-plus` 的独立 `user/message`。未知完成状态的 rewrite feedback 与 Cordis recovery 构成有界 `snapshot`；全局绑定 API 说明使用独立 `catalog`；恢复 tip 是以 trigger/ordinal 为 identity 的 `notice`。恢复快照只替代 PTC 旧状态，空快照撤销旧状态，不替代绑定目录、authoring task、Skill、tool result 或其他 producer。PTC 更新不重发其他 owner 文本，其他 owner 的 aggregate 更新也不重发未变 PTC 信息。`systemPrompt.context` 中的空 witness 受 `includeRuntimeContext` 与 scoped suppression 管理且不渲染 aggregate 文本；assembly 捕获精确请求事实，pre-step 委托宿主 waterfall 后只对匹配且未取消的 accepted step 提议消息。已提交记录与公共 ordered surface 共同决定去重和状态重申；缺少公共 surface 时不推断可见状态，不投递。raw history 只可用于 tip identity/cooldown，不能让隐藏 binding 变成模型知识。关闭 PTC 后仅保留撤销旧声明所需的被动 presentation cleanup，不安装 runtime 或读取 binding 存储。Cordis 恢复使用规范 journal 与当前 agent/enable generation；绑定目录只描述当前启用配置，不要求激活证明。目录和恢复快照分别去重与撤销，Host aggregate 的撤销不适用于目录；暂停只限制新投递。历史快照中的绑定段由一次恢复快照退役。此类状态不得进入 `PromptAssembly.sections`，也不得通过 tool/schema/order 变化传递。来源、边界与历史兼容由 [ADR 0010](adr/0010-session-log-derived-recovery-tips.md) 拥有。

所有模型可见输入都必须能从 session log 重建。静态 system/schema 由 `request/header` 保存，动态 context 由带来源的 `user/message` 保存；进程内临时状态不能直接成为未记录的模型输入。在同一插件版本与配置下，普通执行结果、可编辑目标、诊断和其他插件拥有的运行期变化都不得改变 header；`edit_run_code` 的身份与结果由真实 call/result 表达，不生成 edit feedback context。插件升级、显式配置变化、provider/model route 变化、真实 native capability schema 变化，以及 DSH 拥有的 history replacement 可以使缓存从首个变化 token 起失效。

全局绑定条目属于可变的用户计算输入；修改其提示词、接口、源码或启用集合通过上述追加通道同步，不能套用静态插件配置变化的例外来重写 header。配置说明可从已提交 PTC catalog 重建，且不为保留隐藏的 session-local 状态提供额外证明。

缓存稳定性必须有 keyless contract test：跨每个相关生命周期状态序列化并比较完整 system text 与有序 tool schemas，同时断言 edit 不增加 runtime context。真实模型的 `cacheReadTokens` 只作为端到端补充；“不破坏缓存”表示插件保留已有可复用前缀，不承诺 provider 建立、保留或命中缓存。

## 能力表面

cell 直接使用 DSH 为当前 request 提供的 `tools.*`，不按工具名过滤，不翻译已提供的 program-call 参数或 canonical result。只有完全省略参数且 DSH 的 live object schema 验证 `{}` 合法时，worker 才在 encoding 前把 omission 规范为 `{}`；显式 `undefined`、需要输入的 member 与其他 namespace 不变，调用方携带的内部 metadata 不能扩大这项集合。模型 direct-call 边界与这个 data-plane contract 分离：声明的顶层 transport 是 `run_code` 和 `edit_run_code`；可证明的误发 native call 可先规范为 `run_code`，native member 随后在 cell 内 nested dispatch。所有 native member、`capabilities.*`、`repl.state` 和 `code.*` 共享 cell lease；cell 结束后，捕获的函数统一失效。调用时仍由 DSH 检查 scope、policy、取消和 scheduler。

`capabilities.tree/find/inspect` 是描述 API，不是反射调用入口。默认 SDK 展开这个导航器，Global User Bindings 开启时另声明稳定的 `code.submitBindingDraft`；`repl.state` 与 `code.run` 保持可调用，但其完整契约只在 explorer 中按需返回。explorer 合并 live tool schema 与插件自有 program-binding 描述；可证明的 metadata 包括名称、描述、输入/输出 schema、authority 和 replay。effect 与 result completeness 没有 owner 证据时保持 `unknown`。探索不会授予权限或触发额外模型调用。

当前公共扩展面没有跨 prompt assembly 与 cell dispatch 的冻结 view token。PTC Plus 使用同一 agent scope 分别读取 prompt 和 runtime view，并让实际 request binding 成为执行事实；能力在两阶段之间变化时，不伪造原子快照保证。

执行缝 request 已携带的 owner-provided program namespace 会被原样保留并共享 cell lease，PTC Plus 不翻译其参数或结果。与插件保留的 `capabilities`、`code` 或 `repl` 同名时 request fail-fast，避免主线程与 worker 绑定分叉；普通 cell 局部变量允许自然 shadow 这三个低频 namespace，必要时可通过 `globalThis` 访问。`tools` 仍是保留名称，因为 shadow 它会切断主要能力面。当前公共扩展面没有用于发现额外服务的 program-binding registry；插件不提供名称分发总线或私有 provider registry。若 DSH 以后提供统一 registry，PTC Plus 只消费实际 request 中的 live binding，不复制 authority 或 discovery。

## REPL 生命周期

每个顶层 `run_code` 在独立 native frame 中执行，session root 的逻辑身份跨 cell 保留。`repl-scope-normalizer.js` 用正式作用域归属归一化局部 activation；`stateful-root-compiler.js` 生成 root 读写、候选提交、模块依赖和源码映射，`stateful-root-runtime.js` 持有实际来源和值。`stateful` 下同 scope 的声明与赋值更新同一身份，包括 const、function、class 和 import；不同 block、function 与 iteration 保留各自身份。完整 declarator 成功后才发布，普通赋值保留真实部分写入。旧闭包观察同一逻辑身份的新值，保存的函数值保持自身身份。`protected` 保留原生局部限制并检测跨 cell 覆盖。详细语言与代际契约由 [ADR 0025](adr/0025-use-versioned-logical-binding-identities.md) 拥有。

`compiler-service.js` 是 cell、模块、动态源码、工作台 completion 与 binding-source metadata 的同步准备入口。编译器及其维护中的 JavaScript 依赖在私有 VM realm 中运行；`compiler-data.js` 复制数据集合与紧凑 source map，服务重建调用方诊断，`compiler-platform.js` 和 realm 内的 factory 只提供编译所需的捕获操作。平台原语在用户执行前固定，路径和压缩由编译器私有依赖处理，转换不发现外部配置。该 realm 不持有用户程序值、模块图、journal 或权限，源码反射查询只允许同步的字符串回调；编译仍受既有 worker 预算和生命周期约束。

纯模块转换由 `module-compilation.js` 返回代码、映射、导出描述和静态 link/source-registration 事实；`stateful-module-compiler.js` 在编译器外消费这些事实，负责 Node 公共 hooks、文件格式判定和运行时注册。`compiler-operations.js` 每次编译建立一次绑定索引，各 AST 分区独立记录新增名称、私有传输操作、生成调用外壳与用户值边界。静态和动态调用适配消费同一 planner；helper 参数中的用户表达式仍按源码处理，生成操作不会被重复当作用户调用适配。运行时的模块图、逻辑 root 和 legacy adapter 通过 `compiler-intrinsics.js` 消费内部事实，不重新进入用户的集合协议。可选 TypeScript 编译依赖由私有平台按需加载到同一 realm；平台成员、产物一致性和原预算下的实际执行分别由构建契约与行为测试核验，详细生命周期见 ADR 0025。

cell 的静态 import 与 remote re-export 产生有序 preload，Node 继续拥有解析、链接、attributes、缓存和模块效果。import 为逻辑身份提供 live 来源；成功写入形成局部覆盖，重新导入恢复模块来源。模块、绑定候选、正式激活、工作台和隔离 `code.run` 接入共同编译契约，各自保留独立状态与生命周期。模块公开接口选择 PTC 管理的稳定 namespace：读取沿正式来源关系取得逻辑值，原生导出仅承担所需传输，不把 provider 的动态来源复制成值镜像。传给外部函数的 namespace 同样保持实时读取；外部代码独立原生导入 compiled URL 的传输接口不承诺同一可写语义。实例化、TDZ、反射、全部入口与原生获取边界由 [ADR 0025](adr/0025-use-versioned-logical-binding-identities.md#managed-module-interface) 拥有。

用户主动动态编译保留原生语法目标与结果；调用环境仍须与源码一致。直接 eval 解析到调用处逻辑作用域，间接 eval 和 Function 家族使用各自 realm 的 root。`dynamic-scope-analysis.js` 为归一化和编译提供共同的声明归属、初始化查找与 eval activation 路径事实；`dynamic-environment-compiler.js`、`dynamic-environment-runtime.js` 与入口适配负责实际环境，`dynamic-binding-evidence.js` 核验动态声明的来源。这些职责不能用“外部编译”豁免，尚未通过的动态反例仍是实现缺陷。

`dynamic-native-runtime.js` 为 eval、四种 Function 构造器和 Function.prototype.toString 持有每个 owned realm 与语言代际的稳定接口。`dynamic-native-calls.js` 在源码的取值与调用边界选取接口，包括属性读取、原生调用结果和异步恢复结果；源码传出的接口在原生或不透明回调中继续使用所属环境和源码事实。`native-root-dynamic.js` 在冻结的 legacy 声明转换之后准备动态入口，通过既有 import namespace owner 保留 helper ancestry：legacy 动态源码使用原生 REPL 环境，并为缺少已初始化原生 lexical 存储的名称桥接目录证明的逻辑绑定；新代使用逻辑 root，两者均消费 managed module namespace。legacy 的实际初始化与结算同样回传逻辑来源和写入证据。全部全局与原型属性保持原生，kernel ambient getter 也只返回原值并记录 volatile 读取，因此旧闭包跨模式、异步与模块继续执行时仍保留原来的环境和已保存的接口身份。direct eval 以原始 intrinsic 执行显式调用环境；普通用户函数保持 canonical identity，用户改写不被接口准备覆盖。`callable-source-facts.js` 的编译器源码事实和已拥有 realm 的 intrinsic 关联跨 realm 共享；另外创建的用户 realm 保持独立。未编译 VM 源码自行读取原生 toString 时仍由原生引擎返回源码；要由不透明 observer 观察原始源码，可以向其传入所属代际的源码观察接口。

可确定的计算和 recorded-value capability call 可以推进 durable head。未进入 journal 的 Node/OS 能力、环境输入、时钟、随机数和 timer 进入 sticky `volatile`；live worker 继续可用，cold replay 回到最后 durable frontier。`require(...)` 与动态导入按同一白名单分类：白名单内置模块（assert/buffer/querystring/string_decoder/stream/util/url/zlib）保持 durable，其余 volatile，`worker_threads`/`cluster` 等内核控制模块在执行前以 PTC-C002 拒绝。durable 只描述冷恢复对已结算历史的重放能力；失败 cell 仍可能已经修改 binding 或产生外部 effect，不能由 durability 推导出安全重试。worker thread 是生命周期隔离，不是安全沙箱。

宿主工具调用经 worker 回调回到主线程时，DSH 的 AsyncLocalStorage initiator 上下文在回调中为空。插件注入 `agents` 服务并在 `invokeBinding` 处用 `withInitiator(精确活跃 agent, ...)` 建立边界，因此要求 driver 内精确调用 agent 的宿主工具（如 goal 跟踪的 `goalToolExecution` 检查）可从 cell 内直接调用；`edit_run_code` 的派生 `run_code` 也复用该宿主流水线，不通过 stream canonicalizer 伪造模型调用。

## Journal 与恢复

每个进入 evaluator 的 cell 写入版本化 journal：

```ts
{
  version: 10,
  languageSemantics: "legacy-v1" | "stateful-v1" | "protected-v1",
  moduleTransform: "amaro@1.1.11" | "stateful-module-v1+amaro@1.1.11" |
    "stateful-module-v2+amaro@1.1.11" | "protected-module-v1+amaro@1.1.11",
  bindingPolicy: {
    variableRedeclarations: boolean,
    functionClassRedeclarations: boolean
  },
  rewritePolicy: { autoRewriteImports, autoStripExports, autoSplitRedeclarations },
  moduleSemantics: {
    defaultExportBinding: "legacy-variable" | "live-readonly",
    importExpressionBoundary: "legacy" | "statement-safe"
  },
  userBindingsFingerprint: string | null,
  userBindingsReusePolicy: "fingerprint-v1" | "implementation-v1",
  userBindingsShadowPolicy: "whole-entry" | "per-name",
  userBindingNames: { name, state, entryId? }[] | null,
  status: "durable" | "volatile" | "discarded" | "noop",
  calls: CallTranscript[],
  operations: StateOperation[],
  confirms: number[],
  diagnostics: Diagnostic[],
  completion?: Completion,
  volatileReason?: string
}
```

`languageSemantics` 选择语言契约，`moduleTransform` 选择确切 parser、compiler 与 lowering generation；两者必须是允许的配对。v1–v8 固定迁移为 legacy transform，v9 按发布时映射恢复，其中 `stateful-v1` 使用 `stateful-module-v1`，不能按当前 transform 重解释。`bindingPolicy`、`rewritePolicy` 与 `moduleSemantics` 保留历史细分契约；新代际从统一策略派生它们，旧代际由冻结编译器消费。`userBindingsFingerprint` 以 `null` 证明不存在 Global User Binding 输入，或以 SHA-256 绑定并行私有快照；声明存在但快照缺失或不一致时，node 形成 unknown boundary。`userBindingsShadowPolicy` 固化该 cell 的 session-local 覆盖粒度，`userBindingNames` 以按名称排序的 `{name, state}` 记录结算时的 provider/local/absent/unknown 事实，因此 cold replay 按历史粒度重放覆盖关系，不从当前实现推断 v1-v7 cell 的整条 entry 语义；provider 事实必须对应并行快照的条目 ID，并覆盖该快照公开的每个名称，否则 node 形成 unknown boundary。`calls` 只保存 global、member、PTC Value Graph 编码的 args/result 或 error，以及 settlement 序号。cold replay 校验调用名称、参数、数量和提交顺序，并按 recorded settlement order 释放 recorded result；不会重新 dispatch program binding 或重做外部 effect。该规则同样适用于 native tools、owner-provided namespace 和 `code.run`，不按名称分支。Cordis 的进程内对象不会因此被宣称已恢复；presentation 可以从已验证 transcript 派生重新检查要求，但不能改变 replay。若基础设施终止时仍有未结算 binding，heap 回滚到 durable frontier，discarded journal 以最先观察到的 `global.member` 保留 possible-effect boundary。effect、completeness 和 source metadata 属于 capability explorer，不伪装成 journal 字段。

journal 通过 `run_code.output.presentationMeta` 附着到最终 result，再由 `tools/result` 做两阶段确认。live binding catalog 在 worker 结算时随实际状态更新，下一条排队 cell 使用这份目录准备；journal 确认只推进持久历史，迟到或逆序的确认不能覆盖较新的 live 目录，也不能恢复已重置的状态。缺失、损坏或被替换的 journal 形成 unknown/volatile 边界；未进入 runtime 的 call 由后续 `confirms` 以对应 `tool/call.seq` 证明为 no-op。volatile 源码保留在原 session log，但不参与 cold replay。

恢复从当前请求对应的 head 沿 parent 关系向更早状态收缩，而不是越过损坏记录继续假定原 heap 存在。候选 frontier 同时受两种证据约束：append-only session log 中的 journal 证明状态可重建；生成当前调用的 DSH ordered surface/derived request history 证明模型可以知道其精确 binding provenance。raw event 未删除不等于模型仍可见，Client 的 `dshPtcPlusBindings` inventory 也只是 UI presentation。只裁剪 tool result、仍把携带源码的 assistant call 留在模型 surface 中时不必删除对应状态；assistant provenance 被遮蔽且没有显式、有界、模型可见的结构化状态投影时，live worker 与 cold replay 都必须收缩。插件不从自然语言 compaction summary 推断 binding。

durable replay 无法验证某个 node 时，当前已结算 `tool/result` 的私有 `meta.dshPtcPlusRecoveryBoundaries` 记录失败 call 与其 parent frontier，不修改冻结的历史 result。boundary 在进入排序前必须完成 schema 与 event-sequence validation；损坏 metadata 不能从 fold 中静默消失，也不能证明任何旧状态。折叠器剪除结构不可证明或模型不可知的 node、binding 与依赖后代，重算可重建 checkpoints；只有 ancestry、独立性和模型可知 provenance 都有 owner evidence 的部分可以保留。现有 journal 没有完整的逐 binding 依赖图，因此不能证明细粒度剪枝时按 cell 与受影响后缀收缩。已经存在的 live kernel 在执行下一 cell 前检查 surface replacement generation；若模型可见历史已经收缩，先重置并物化对齐后的 frontier。

kernel 重置 worker 并逐级验证更早 frontier；最大非空 frontier 仍不可证明时使用空 REPL。这个最差情况会丢失全部旧 binding，但历史 PTC Plus metadata 损坏本身不得阻止当前合法 cell 执行。当前 cell 在实际重建的 frontier 上建立新分支，并通过一次 `PTC-R002` 说明哪些历史状态未恢复；收缩不重新派发或撤销历史 program binding effect，也不把未知状态说成已恢复。DSH 对当前请求的 validation、policy、authority、approval 与 cancellation 错误不属于该可用性降级。新 durable node 的 parent 始终是 worker 实际拥有的 frontier。自定义 boundary event 不由运行时生成，迁移工具必须在 DSH restore 前显式转换它。

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

- [Use Versioned Logical Binding Identities](adr/0025-use-versioned-logical-binding-identities.md)
