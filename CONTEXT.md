# PTC Plus Project Context

PTC Plus 是个人维护的社区实验插件。它把 DSH PTC 模式的顶层 `run_code` 变成 session-bound TypeScript REPL；它不复制 DSH 的权限、sandbox、nested dispatch、调度、取消、审批或跨平台进程治理。

## Core constraints

1. `danger-full-access` 是一等体验：保留模型熟悉的 Node、process、filesystem、network、shell、生态 SDK 与 DSH native typed `tools.*`。其他 profile 的 native tool surface 只按 live request 简单降级，不模拟缺失能力；更窄 tool view 不构成 Node ambient sandbox。
2. 后续 cell 直接复用 binding，不搬运源码、不嵌套转义、不增加普通继续求值的模型往返。
3. DSH/宿主拥有 authority 和 policy。PTC Plus 始终面向最新可用 DSH release 的公共扩展面，不 fork DSH、不接入私有 scheduler、不伪造 session event，也不以版本号白名单替代能力和契约验收。验收脚本在运行时记录实际 DSH 版本；上游升级后，当前 release 立即成为兼容目标。
4. 无法由 session log 重建的 Node/OS 输入与 effect 进入 sticky volatile；live worker 继续可用，cold recovery 回到最后 durable frontier。volatile 是恢复分类，不是权限。
5. shell 是解释命令文本的通用入口，不是 REPL、权限系统或普通 argv spawn 的前置条件。PTY/ConPTY 只用于交互进程；Windows、WSL 与 POSIX execution world 必须分别探查。
6. 透明性要求 action、authority、effect、result completeness、replay 与 settlement 不被混淆；不要求暴露无决策意义的 provider 内部细节。

## Program surface

- cell 直接调用 DSH 原生 `tools.<name>(args)` / `tools["name"](args)`。该 program surface 不按工具名过滤，不翻译已提供的参数、canonical result、错误或 owner guidance。完全省略 JavaScript 参数时，只有 live DSH object schema 正式验证 `{}` 合法的 native member 才在 value encoding、journal 和 dispatch 前把 omission 规范为 `{}`；显式 `undefined`、需要输入的工具和非 `tools` program binding 保持原语义。PTC 模式的 code-only direct-tool projection 只声明模型可直接调用 `run_code` 与 `edit_run_code`。若模型误发当前 live scope 中可证明存在的顶层 native call，插件可在持久化前将这个无效 direct call 规范为调用同一 member 的 `run_code`；原始 JSON 参数、call identity 和 DSH 正式 validation 保持不变。未知、畸形或不一致输入不猜测修复。合法的 `edit_run_code` 绝不进入该归一化路径。
- live `run_code` 在精确源码 EOF 处解析失败时，插件只尝试追加一个 `}`、`)` 或 `]` 的固定候选集；候选必须唯一通过该 cell 提交时的完整 preparation context、没有 binding collision，并能由现有 editor 以有界唯一尾部精确表达，`PTC-C001` 才把对应的一次 `edit_run_code(...)` 调用作为 validated repair 输出。该调用以可选 `expected_target_call_seq` 前置条件绑定被拒 cell 的持久事件身份；edit dispatch 捕获了其他目标时必须在派生执行前拒绝。该证据仅证明语法/preflight correction，不证明业务意图，不自动编辑或执行，不改写模型原始 call，也不新增 journal/config；无法证明候选或目标身份时继续使用按源码长度选择的通用恢复指引。
- 每个 cell 创建统一 lease。native tools、`capabilities.*`、`repl.state` 和 `code.run` 在 cell 结束后一起失效；下一次 dispatch 仍由 DSH 重新治理。
- `capabilities.tree/find/inspect` 描述当前 agent scope 的 live tool schemas 以及插件自有 `repl.state` / `code.run` 契约，不调用 capability、不提升权限、不触发辅助模型请求。默认 SDK 只展开 explorer，不主动展开两个低频高级 API。
- PTC journal 为所有已结算的 program binding call 提供 `recorded-value` replay：cold replay 校验调用序列并返回 recorded canonical value，不重新 dispatch capability。这不表示外部 effect 被重做、撤销或验证。
- live tool schema 没有 owner-proven effect/completeness/source 注解时保持 `unknown`。不能从工具名、UI rendering 或自然语言摘要推测完整性。
- CodeRuntime request 已携带的 owner-provided program namespace 会原样保留并共享 cell lease；PTC Plus 不翻译其领域契约。与插件保留的 `capabilities`、`code` 或 `repl` 同名时 request 明确失败，不能静默合并；普通 cell 局部变量可以自然 shadow 这三个低频 namespace，需要时仍可从 `globalThis` 访问。native `tools` 不允许 shadow，因为那会切断主要能力面。当前公共 request surface 没有用于发现额外服务的 program-binding registry，因此插件不增加名称分发总线或私有 registry。
- cell 包裹前的 AST 重写适配模块语法（cell 是 async function body，模块声明在函数体内非法），全部默认开启（`autoRewriteImports` / `autoStripExports` / `autoSplitRedeclarations`，可关闭）：原始 Program 在 lowering 与 preload 前完成 scope validation，同一 cell 的 value import 重名按模块 binding 规则拒绝；worker 按源码顺序从 session cwd 预加载并静态链接 `import`，session 未记录 cwd 时回退到 process cwd；cell 通过持久 module namespace slot 捕获结果，named/default alias 保持 live read 与只读 binding 语义；value import alias 活跃时，无法由静态 AST 保真的 direct `eval` 与 `with` 在任何 module preload 前拒绝；顶层 `export` 修饰符剥离（声明保留、default 转 `__default`、re-export 转预加载的副作用模块、type-only 擦除）。跨 cell 重声明属于 REPL 便利策略，由 `internal/repl-convenience.js` 隔离实现；混合新旧名称的顶层解构在该策略开启时按插件定义的兼容规则 lowering，关闭时保持原文走既有解析失败路径。改写来源平行记录在 `meta.dshPtcPlusRewrites`（journal 封闭 schema）；成功改写不产生 runtime context，失败或缺少有效 journal 时才用 `tools:ptc-plus-rewrite-info` 告知不确定的后续动作。
- `require(...)` 与动态导入按同一白名单分类：白名单内置模块保持 durable，其余 volatile，`worker_threads`/`cluster` 等内核控制模块在执行前以 `PTC-C002` 拒绝，非字面量参数为 dynamic module resolution。durable 只表示冷恢复可以重放已结算历史，不表示失败 cell 没有外部副作用或可以安全重试。

## Data boundaries

- `canonical` 表示程序收到的结构化值，不表示完整世界快照。结果必须区分 `complete`、`bounded`、`incremental`、`open-world` 和 `unknown`。
- 当前 DSH `tools.read` 契约是 bounded inspection，不是 lossless whole-file API；这项使用注意不构成 PTC metadata 注解。需要完整文件时，一等 profile 使用 `node:fs/promises.readFile` 或 stream；该直接 I/O 没有 call transcript，因此进入 volatile。
- model/UI rendering 与 canonical program value 是不同层；展示被裁剪不能证明 program value 被裁剪，反之亦然。
- `code.run` 在隔离 child runtime 执行 source，不合并父 binding。正常结算后记录并重放结果；若基础设施终止时调用仍未结算，discarded journal 以 `code.run` 记录 possible-effect boundary。该规则由所有 program binding 共用的 pending/settled 生命周期决定，不由 capability 名称决定。
- PTC 模式的 code-only direct-tool projection 固定暴露 `[run_code, edit_run_code]`，但 DSH 默认只投影 `run_code` 不是插件必须继承的架构约束。DSH owner 为一个 agent composition 选择一次 `native`、`code` 或 `both`；PTC Plus 必须在自己的 agent-scoped presentation effect 生效前捕获首次可证明的 composition mode，并在该 agent 生命周期内只从这项事实派生 direct projection、native-call normalization 与 dispatch rejection。非空 `tools:code-only` rule 证明 `code`，同名空 section 证明 `both`；插件为执行 `edit_run_code` 调用的 `tools.presentAs('both')` 只是宿主执行效果，不能成为后续模式证据。PTC Plus 通过 DSH 的公共工具注册与 agent 级呈现接口真实注册并呈现 `edit_run_code`；无关 native tools 仍只作为程序内 `tools.*` 能力提供。`edit_run_code` 保留模型原始调用与参数，使用独立 editor 对同一未结束 turn 中调用发起时最近的可编辑 cell 原子应用至多 16 个唯一、非重叠的字面替换，或至多 16 条带显式预期匹配数的正则替换；发起后的其他 settlement 不追溯改变该目标。普通 edit 可省略目标前置条件；携带 `expected_target_call_seq` 时，捕获目标的 call sequence 必须相同，否则不编辑、不执行。目标既可以是被拒绝或失败的 cell，也可以是已成功执行但仍需微调的 cell；成功 edit 的派生源码成为下一目标。完整物化源码只进入插件派生的 `run_code` 执行和可恢复日志元数据，不替换或重复进入模型 assistant history；执行结果由外层 `edit_run_code` result 表达。调用身份、派生执行、journal、恢复与 UI 展示必须保持可区分；`llm/stream` 不得重命名合法的 `edit_run_code`，也不得添加 edit 专用 runtime context。所有匹配、长度、capture、展开和 CPU 预算仍由 editor 统一拥有；失败、取消、未知 effect 与冷恢复语义必须从 session log 重建。

## Journal facts

`version: 3` journal 是封闭 schema，只包含：binding mode、rewrite policy、status、call transcript、state operations、confirmed no-op call sequences、diagnostics、completion 与 optional volatile reason。rewrite policy 固化该 cell 的三个 AST rewrite 开关，冷恢复不读取当前 profile 的开关。call transcript 包含 namespace/member、PTC Value Graph 编码的 args/value 或 error，以及连续 settlement 序号；不包含推测的 effect、completeness 或 fingerprint。基础设施终止时 calls 清空；若仍有未结算 binding，`discarded.volatileReason` 保存最先观察到的 `global.member` possible-effect boundary。

两阶段确认通过 `run_code.output.presentationMeta` 与 `tools/result` 完成。已执行但最终 journal 缺失或变化时，live state 单调降为 volatile；未进入 runtime 的 call 由后续 `confirms` 证明为 no-op。损坏或缺失历史形成 unknown suffix，cold recovery 不越过它。

durable node 重放失败时，插件把本次收缩记录为当前已结算 `tool/result` 的私有 `meta.dshPtcPlusRecoveryBoundaries`，记录失败 call 与其已验证 parent frontier；原有 call/result 不修改。boundary 必须在 event sequence 参与排序前完成规范化，损坏 boundary 使 cold recovery fail closed。日志折叠删除失败 node 及依赖后代，重算仍可重建的 checkpoints，重置 worker 后逐级验证更早 frontier，成功后当前 live cell 才会执行。新 durable node 必须连接到实际重建的 frontier；历史 program binding effect 不重新派发。旧版 `ptc-plus/recovery-boundary` 事件只能通过显式、非破坏迁移转换后再交给 DSH persistence reader。

自动重写以 `meta.dshPtcPlusRewrites` 平行 key 记录（`{ kind: import|export|redeclaration, description, source? }`，校验与冻结同 journal 风格），不进入封闭的 journal schema，也不参与 `journalsEqual`；只对真实执行过的 cell 出现，preflight 拒绝的 cell 不带。`tools/result` 两阶段确认不受该平行 key 干扰。

宿主工具调用经 worker 回调回到主线程时，DSH 的 AsyncLocalStorage initiator 上下文在回调中为空。插件注入 `agents` 服务并在 `invokeBinding` 处用 `withInitiator(精确活跃 agent, ...)` 建立边界：要求 driver 内精确调用 agent 的宿主工具（如 goal 跟踪）可从 cell 内 `tools.*` 直接调用。`edit_run_code` 的外层注册和派生 `run_code` dispatch 也必须复用这条宿主工具流水线，不得通过模型流中间件伪造调用。

## Presentation

DSH 原生 tool guidance 与 typed SDK 保持 owner 提供的内容。PTC Plus 修改 `run_code` 的连续 REPL 说明，只追加 `capabilities` explorer 声明，并在使用 code-only direct-tool projection 的 session-bound PTC request 中增加真实注册的 `edit_run_code` schema。稳定指引只保留 cell async body、模块适配、binding continuity、能力发现和 execution-world 边界；不假设 Windows、WSL、POSIX、shell、package runner 或某个 native tool 存在。改写反馈和按需恢复 tip 只有在事实不已由 call/result 表达且确实改变下一步决策时才使用 named runtime context；edit 身份、参数、结果和目标消费不再通过 runtime context 补叙事。恢复 tip 受 `tipCooldownMessages` 与 `tipEscalationFailures` 约束；成功 cell 重置未解决计数。新 agent 或 Cordis 重新启用代际若从规范 journal 观察到历史 Cordis transcript，则用固定命名 context 将 recorded value 限定为历史数据，并要求在依赖旧 ID、状态或 capability observation 前执行新的成功 Cordis Inspect；该 context 不重放 effect，也不声称进程内状态必然丢失。

普通顶层误调用的 transport recovery 是确定性协议归一化，不调用模型、不增加 authority，也不注入动态纠错 context。它只修复 declared direct surface 之外、但由 live schema 可证明的 native call；无法证明时保留原调用，由宿主报告真实错误。参数在 canonicalizer 中解析一次，普通 JSON 原样生成 JavaScript 参数，含 own `__proto__` 的值改用安全字面量保持执行语义；超过可安全解析语法深度的 JSON 改用浅层 `JSON.parse` 表达式，避免派生 cell 在 DSH validation 或 dispatch 前耗尽 TypeScript parser 栈。派生 cell 不携带额外 provenance 或纠错提示，使规范化对模型透明。已声明的 `run_code` 与 `edit_run_code` 不是误调用，不能通过该机制互相改名。

普通成功 cell 不产生 PTC warning/note。宽松重声明和首次进入 volatile 都是正常运行状态；后者只进入 journal 与 `repl.state(list)`。只有执行失败或 cold recovery 实际跳过历史状态时才投影可行动诊断。同一失败指纹在单个 kernel 内连续出现 3 次时，失败 cell 追加一次分类提示：可证明的 binding 错误使用 `PTC-W001` 并允许恢复 tip 建议 live capability 探查，其他错误使用 `PTC-W002` 且只要求重新检查其具体 cause。成功或不同失败会重置计数；提示不重写原始错误。

当前公共扩展面没有跨 prompt assembly 与 runtime dispatch 的冻结 capability token。插件在两个阶段使用同一 agent scope，但以实际 request binding 为执行事实，不承诺不存在定义漂移。

## 设置 UI

PTC Plus 注册 `ptc-plus` settings namespace，字段来源于 `internal/config-spec.js`，client half 通过 `settings.plugin.item` 卡片暴露全部配置。
`enabled` 是 kill switch：关闭时宿主只保留 settings 注册和设置卡片，不安装 runtime、hook、tool surface 或 prompt section；
关闭状态不产生 `run_code`/`edit_run_code` 模型表面，设置卡片只允许操作 `enabled`。所有配置字段都由 settings watch 即时生效；运行时 owner 更新配置时保留已有 session-bound REPL、binding、journal 和 native DSH authority，失败则回滚到上一个已应用配置。已提交的 cell 在完整生命周期内绑定提交时的同一份配置，更新后的限额和策略用于随后提交的 cell，不能让一次执行混用两个配置代际。Node worker 的 V8 old-generation 上限在创建时固定，因此活动 worker 存在时修改该字段会明确失败并回滚，而不会静默报告为已应用。
`cordisToolsEnabled` 默认关闭且即时生效。开启时，官方 `@deepseek-ai/dsh-tool-cordis` 与 shipped `cordis` preset 的 `cordis-plugin-development` Skill 作为同一个 agent-scoped mount 进入可见 `run_code` 的 agent；Skill 根通过公共 `agentPresets.resolve()` 定位，官方 filesystem provider 继续拥有解析、资源基址、watch、invalidation 与加载，PTC Plus 只在公共 provider 注册边界精确保留 companion Skill，不能让同目录 sibling 自动扩展 PTC surface，也不复制内容或切换 preset。普通 agent 不继承，code-only direct-tool projection 仍为 `[run_code, edit_run_code]`。agent 创建早于 `run_code` 可见时，插件会在工具 surface 变化后重试挂载；preset、精确 Skill、所需服务或任一 child fiber 在首轮前不可用时，启用失败并完整回滚。Cordis 工具名、数量、schema 和 guidance 只由官方 tool fiber 的 live surface 拥有，PTC Plus 不复制或枚举。官方 fiber 的 Host inspect provider 注册属于进程级资源：PTC Plus 在自己的 runtime owner 内合并同一 manifest 的 agent-fiber lease，并在最后一份 lease 释放时注销，避免多 agent 或关闭后重开重复占用 provider ID；查询实现始终委托给仍存活的官方 fiber。
设置卡片的全部文案注册到 DSH client 的 `settings.ptcPlus` locale 命名空间，随界面语言在中文与 English 之间切换；字段名称与说明的双语文本由 `internal/config-spec.js` 拥有，卡片 chrome 文案由 client half 拥有。稳定 REPL 指引保持插件拥有的协议文本，不携带 UI 品牌名。选择 `code` preset 且插件启用时，Client 会在会话头部单独显示 `PTC Plus` 指示器。DSH settings 服务缺省时回退 composition config，原行为不变。

## Scope boundaries

- 插件不自建跨平台权限、安全沙箱、通用进程治理或命令 DSL；
- program binding 由 live request 直接提供，不经过名称反射或私有 adapter；
- bounded window 不拼接成伪 lossless reader，unknown metadata 不升级成 complete、durable 或 effect-free；
- capability map 的机械探索不消耗模型 token；语义增强必须由用户主动触发或预先授权并受硬预算约束；
- Work Map、跨插件聚合和统一 registry 属于上游协调层，不在本插件复制。
