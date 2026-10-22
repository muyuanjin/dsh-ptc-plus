# PTC Plus Project Context

PTC Plus 是个人维护的社区实验插件。它把 DSH PTC 模式的顶层 `run_code` 变成 session-bound TypeScript REPL；它不复制 DSH 的权限、sandbox、nested dispatch、调度、取消、审批或跨平台进程治理。

## Language

**任务总 token 消耗**：完成一项任务的全部模型请求所消耗的 token，包含主代理、实际子代理、能力探索和重试。缓存输入、未缓存输入与输出分别报告；提示词字节数、单次请求长度和调用轮次不能代替该总量。

**上下文优化收益**：在代表性普通任务上，相对关闭 PTC Plus 的原生 PTC，任务质量不下降且任务总 token 消耗降低的收益。局部提示词缩短或特定高级能力可用，不单独构成该收益。

**受管能力**：DSH harness 及其插件正式提供给模型的任务能力，是能力启用配置与披露策略的管理对象。JS/TS 语言、Node 环境、REPL、PTC Plus 自身公共能力和 Global User Bindings 不属于受管能力。

**能力与上下文总开关**：`capabilityContextEnabled` 整体暂停能力规则、统计采集、说明恢复和插件预览，保留子项选择、规则与额度；重开恢复原组合。默认开启此维度以兼容旧配置，不自动开启任何子功能。新会话和明确刷新采用保存选择，已有会话保持冻结；关闭委托宿主能力与展示，不影响计算状态或 DSH 权限。

**能力管理开关**：决定是否应用可用性和说明规则；统计采集、说明恢复、结果预览各自独立。新配置默认沿用宿主说明，不自动选用恢复和预览。旧配置迁移保留原行为，历史方案按原代际恢复。

**能力手动配置**：分别保存可用性（enabled/closed）与说明方式（host/full/on-demand/adaptive）。默认、类别、已证明 MCP 来源、单项依次按维度覆盖；MCP 来源关闭优先于子项启用，保留子项说明偏好。常用集是独立输入；只有 adaptive 选择消费所选分配依据与预算。

**能力统计设置**：capabilityStatistics.enabled 控制真实使用采集；policy allocation.statistics 独立选择是否参与说明分配，只读观察不要求两者开启。管理关闭时从真实公共库存证明采集资格。无效或不足证据不撤销有效手动选择，不伪造零使用。

**能力披露策略**：已启用项可沿用宿主说明、完整披露、按需披露或按依据分配；分配分别选择常用集、统计依据与预算约束，不自动关闭能力，也不降级显式完整契约。可用性与说明选择分开保存和派生，规则由 [ADR 0043](docs/adr/0043-compose-capability-and-context-policies.md) 拥有。

**完整披露**：默认向模型提供某项受管能力的完整调用契约；Skill 对应完整目录说明，正文仍在实际使用时加载，不因使用频率高而自动预加载。完整披露不使程序内能力成为顶层直接工具。

**按需披露**：通过有界能力目录保持某项能力可发现，需要时再提供完整调用契约。它描述说明的提供方式，不要求该能力名称逐项常驻上下文，也不改变能力本身的参数、结果与执行语义。

**有界能力目录**：在明确预算内向模型提供的能力导航，允许以用途导航与检索入口替代逐项常驻所有长尾能力名称。未逐项展示的按需能力仍可被发现和展开，不等于能力关闭。

**能力关闭**：用户显式将某项受管能力从当前有效能力集合中移除，能力说明、发现结果与执行环境（包括适用的 REPL 成员）一致体现其不存在。它不保留可调用占位，不以调用后拒绝代替移除，也不由使用频次自动触发。

**会话家族**：一个主会话与其全部子代理会话组成的使用统计单位。同一能力在一个会话家族中最多贡献一次使用，不因重复调用或增加子代理而增加权重。

**能力使用覆盖率**：同一统计范围内，实际调用过某能力的会话家族数占该能力实际可用的会话家族数的比例。未提供或已关闭该能力的会话家族不进入分母，查询能力说明与恢复时的历史重放不构成新的实际使用。

**能力统计范围**：用于计算能力使用覆盖率的一组会话家族，默认以工作区区分。工作区统计为主要依据，同一用户的全局统计只在该工作区样本不足时提供冷启动参考。

**能力统计窗口**：同一统计范围内，某项能力最近 N 个实际可用会话家族组成的样本集合，N 可配置。新样本逐步替换最旧样本，项目停用期间不因自然时间流逝降低历史样本权重。

**初始常用集**：一份可编辑的常用能力基线，仅供选用该依据的 adaptive 披露消费；在没有可用统计依据且没有单项显式选择时，完整披露其中当前实际可用且符合说明预算的能力，其余按需披露。初始推荐不计作真实使用记录，统计有效且充分后可参与新会话的自动分配，单项显式选择始终优先。

**能力说明预算**：用于约束选用预算的 adaptive 披露总量；分配按所选常用集、统计依据和说明长度决定。用户显式指定完整披露时仍优先，超预算需明确显示，不擅自降级或截断调用契约。

**会话能力方案**：会话开始时确定的受管能力启用配置及完整披露与按需披露分配，是该会话及其恢复后的稳定环境基线。使用统计和已保存设置的变化不自动改变已有会话，用户主动刷新后才同步最新方案，能力关闭同样遵循该生效边界。

**能力方案刷新**：用户通过 `/capabilities refresh`、星光菜单或设置中明确选定会话的刷新按钮同步最新能力方案的操作。刷新同步更新模型可见的能力说明、发现入口与 REPL 环境，并向模型提供与实际生效方案一致的变更通知；首个宿主接受步骤之前只替换初始方案，不发送或排队发送中间变更说明。

**会话能力工作台**：星光菜单打开的会话级管理界面，使用只读目录观察当前会话的能力来源、已保存、临时与生效状态。仅本会话和全局保存分属明确范围；待应用选择逐项通过 DSH 正式人类命令执行，并以重新读取的状态确认结果，部分失败时保留未确认草稿。目录观察不生成命令卡片；正式命令保留实际名称、参数和结果回执，且不覆盖输入框中未发送的草稿。

**能力说明恢复**：独立选用的压缩后说明恢复，在预算内补回近期实际使用、已经展开且当前仍有效的 API 说明，不重新分配会话方案。不重复仍可见说明，不补回 Skill 正文。关闭此项不关闭必要的导航、契约撤销和环境通知。

**模型结果预览**：独立选用的大返回值与日志有界展示，附带宿主保留完整展示的读取位置。未选用时委托现有宿主展示 policy，不改变 canonical 值、执行成功或错误；取回省略内容无需重新执行。

**REPL 控制台**：用于只读观察当前会话 REPL 状态与管理 Global User Bindings 的用户工作台。会话观察面向会话内的计算状态，全局绑定管理面向跨会话的持久化计算输入。

**有界值预览**：会话 binding 在明确观察时点、长度与结构限额内的只读值展示，与名称和定义来源共同描述该 binding。预览不为展示执行用户代码，截断或不可读取的部分保持明确标识，不代表完整值、可执行副本或模型已知状态。

**全局绑定工作台**：Global User Bindings 的统一管理界面，由 REPL 控制台和设置入口共同提供。持久化条目的管理不依赖当前存在 PTC 会话，Agent 辅助编写仍需要可用会话。

**全局绑定代码执行**：用户基于当前全局条目的源码草稿直接运行 TypeScript 并查看结果，无需先保存，临时变量可在多次执行之间连续复用，普通语法或运行错误不清空环境、不回滚此前发生的修改。执行环境与 Agent 会话的 REPL 状态分开，不读取或修改其会话变量，也不将执行记录写入该会话的 journal。

**临时执行状态**：当前工作台为选中全局条目保留的一份连续计算状态，折叠或展开界面不改变它，连续 10 分钟没有执行代码时自动释放并保留界面上的输入输出记录。源码草稿改动后的下一次运行、切换条目、保存修改后的源码、离开工作台、手动重置或因停止、超时、运行环境故障而终止执行环境时会清空旧状态；运行从当前源码草稿重新开始，不恢复或自动重放此前输入，编辑本身不触发执行。

## Core constraints

1. `danger-full-access` 是一等体验：保留模型熟悉的 Node、process、filesystem、network、shell、生态 SDK 与 DSH native typed `tools.*`。其他 profile 的 native tool surface 只按 live request 简单降级，不模拟缺失能力；更窄 tool view 不构成 Node ambient sandbox。
2. 后续 cell 直接复用 binding，不搬运源码、不嵌套转义、不增加普通继续求值的模型往返。 新 cell 使用宿主解析的当前执行目录；已加载模块和导入闭包保留自身来源，恢复逐 cell 消费 journal v11 的 `executionCwd`，v1–v10 保留历史 header/worker 基准（[ADR 0041](docs/adr/0041-record-cell-execution-directories.md)）。
3. DSH/宿主拥有 authority 和 policy。PTC Plus 是可独立分发的社区插件，始终面向未经修改的官方 DSH 最新可用 release 的已发布公共扩展面；不得修改 DSH 源码或安装包，或要求用户编译、安装定制宿主。插件可通过这些契约实现自有 UI、独立面板和 renderer 替换，不要求全部沿用原生组件或消息布局。宿主源码仅作为只读研究证据，缺失的公共能力不能通过本地补丁变成插件依赖。插件不接入私有 scheduler、不伪造 session event，也不以版本号白名单替代能力和契约验收。验收脚本在运行时记录实际 DSH 版本；上游升级后，当前 release 立即成为兼容目标。分发与交付判据见 [ADR 0017](docs/adr/0017-track-the-latest-dsh-public-surface.md)。
4. 无法由 session log 重建的 Node/OS 输入与 effect 进入 sticky volatile；live worker 继续可用。cold recovery 只保留 ancestry 或独立性可由插件自有证据证明的最大 frontier，保守丢弃可能依赖 unknown boundary 的状态；没有非空 frontier 时从空 REPL 继续当前合法 cell。历史 PTC Plus metadata 损坏只能否定旧 binding 的恢复资格，不能成为永久拒绝后续 `run_code` 的 availability gate。volatile 是恢复分类，不是权限，收缩不表示历史 effect 被撤销或可安全重试。
5. shell 是解释命令文本的通用入口，不是 REPL、权限系统或普通 argv spawn 的前置条件。PTY/ConPTY 只用于交互进程；Windows、WSL 与 POSIX execution world 必须分别探查。
6. 透明性要求 action、authority、effect、result completeness、replay 与 settlement 不被混淆；不要求暴露无决策意义的 provider 内部细节。
7. 插件提供的默认计算状态必须与模型可知状态对齐。binding 只有同时满足“journal ancestry 可重建”和“精确 provenance 仍在生成当前调用的 DSH model-visible surface 中，或由显式选择的有界、模型可见结构化状态投影公开”才默认保留；不能仅为延长隐藏状态而默认注入该投影。append-only raw log 与 UI-only inventory 都不构成模型知识；不得解析自然语言 compaction summary 猜测 binding。只替换 result、仍保留 assistant 源码 call 的剪裁不必丢弃对应状态；provenance 被遮蔽时收缩 live/cold runtime，最差从空 REPL 继续。
8. Global User Bindings 是默认开启的用户计算输入能力；未配置时启用，显式关闭设置和单个条目的启停状态保持有效。关闭时不得读取存储、注入值或新声明、注册管理 RPC/命令或显示管理 UI；下一次宿主允许且接受的步骤可撤销已投递的旧声明；开启时，源码派生的严格快照共同拥有冲突校验、worker 激活和 journal evidence。每个条目可用 `modelContext.includeDeclaration` 选择是否注入已有的源码派生接口（默认开启），用 `instructions` 编写独立提供给模型的提示词（默认空）；不另行编写接口。首次宿主接受步骤之前的全局启停只修改初始配置，不向会话追加或排队发送启停回执。已启用条目的非空提示词和所选接口从首轮通过追加的 PTC API catalog 投递；`/binding` 保存并启用、会话中途启停、删除或编辑后，下一次宿主允许且接受的请求追加当前配置或撤销旧说明，保持 system、tool schema 与顺序不变。已提交消息和公共 ordered surface 拥有投递、去重与恢复证据，配置未变时不重复追加。该配置只描述 API 与执行时初始化契约，不证明当前值或成功激活，不为组装提示词执行源码。配置段是新消息中全局绑定提示词与接口的唯一来源；成功激活、session-local shadow 或 worker 重建不单独追加公告或再次发送接口，执行结果与诊断继续说明实际行为。历史活动段仍可识别，并在下一次允许且接受的恢复快照中撤销一次，当前说明由独立目录提供。关闭接口注入不影响独立提示词或绑定执行。失败 initializer 已发起 program call 时，整个 cell 进入 volatile，不能把缺少该 initializer 源码的成功子集用作 cold replay evidence。模型不获得存储管理、工作台候选执行或启停权限；`/binding` 可通过普通 `run_code` 在会话内做内存测试，编写测试不得修改外部文件或服务。

9. Pathless preset 的包资源优先且排他地由 active Host 的公共 `pluginPackages.packageOf` service 定位；只在旧 generation 完全不提供该 service 时，才允许以 Host 的 `ctx.baseUrl` 为锚解析其历史复数 preset package。插件自身周围的 ambient Node package 不构成宿主来源证据；一旦 Host 提供 `pluginPackages`，空结果或无效结果都不能回退到旧布局。

## Program surface

- cell 直接调用 DSH 原生 `tools.<name>(args)` / `tools["name"](args)`。该 program surface 保留宿主提供的成员，仅按显式启用的冻结会话能力方案移除关闭成员，不翻译已提供的参数、canonical result、错误或 owner guidance。完全省略 JavaScript 参数时，只有 live DSH object schema 正式验证 `{}` 合法的 native member 才在 value encoding、journal 和 dispatch 前把 omission 规范为 `{}`；显式 `undefined`、需要输入的工具和非 `tools` program binding 保持原语义。PTC 模式的 code-only direct-tool projection 只声明模型可直接调用 `run_code`；注册的 editor 在程序内通过 `tools.edit_run_code` 调用。若模型误发当前 live scope 中可证明存在的顶层 native call，插件可在持久化前将这个无效 direct call 规范为调用同一 member 的 `run_code`；原始 JSON 参数、call identity 和 DSH 正式 validation 保持不变。未知或不一致输入不猜测修复。提供方以 terminal chunk 或 stream exception 报告精确的 invalid-tool-JSON `MALFORMED_RESPONSE` 时，插件必须把结尾降级为 `tool-calls`，不能让这类参数错误终止整个 turn。只有缓冲体完全由 tool-call-specific framing 加至多一个 `usage` 事件组成时，内部一致的完整 tool block 才保留原始 identity 和参数，进入 DSH 的普通 tool validation/execution/result/next-step 流程；若其中恰有一个已声明 direct call，且删除一个末尾 `}` 得到可解析对象并通过该请求的 live direct schema，则在降级前修复该参数。不完整、不一致、没有 tool block、夹杂其他缓冲事件或包含多个 `usage` 的流改为携带不可解析参数的确定性 `run_code` 调用，只能在 DSH schema validation 阶段产生普通拒绝结果并继续下一步，不能执行不可信的模型代码。其他 provider failure 原样保留。程序内合法的 `tools.edit_run_code` 不进入顶层 native-call 归一化路径。
- live `run_code` 在精确源码 EOF 处解析失败时，插件只尝试追加由 `}`、`)`、`]` 组成、长度为一或二的固定 12 项候选集；候选必须唯一通过该 cell 提交时的完整 preparation context、没有 binding collision，并能由现有 editor 以有界唯一尾部精确表达，`PTC-C001` 才把对应的 `await tools.edit_run_code(...)` 程序内调用作为 validated repair 输出。该调用以可选 `expected_target_call_seq` 前置条件绑定被拒 cell 的持久事件身份；edit dispatch 捕获了其他目标时必须在派生执行前拒绝。该证据仅证明语法/preflight correction，不证明业务意图，不自动编辑或执行，不改写模型原始 call，也不新增 journal/config；无法证明候选或目标身份时继续使用按源码长度选择的通用恢复指引。
- 每个 cell 创建统一 lease。native tools、`capabilities.*`、`repl.state` 和 `code.*` 在 cell 结束后一起失效；下一次 dispatch 仍由 DSH 重新治理。
- `capabilities.tree/find/inspect/search` 描述当前 agent scope 的 live tool schemas 以及插件自有 `repl.state` / `code.run` 契约，不调用 capability、不提升权限、不触发辅助模型请求。`search` 返回完整索引条目，以 UTF-8 JSON 字节预算约束包装和契约，并明确延续游标及过长条目的单项 inspect 入口；旧 tree/find/inspect 保留原接口。默认 SDK 展开 explorer，不主动展开两个低频高级 API；Global User Bindings 开启时另包含稳定交接成员。
- PTC journal 为所有已结算的 program binding call 提供 `recorded-value` replay：cold replay 校验调用序列并返回 recorded canonical value，不重新 dispatch capability。这不表示外部 effect 被重做、撤销或验证。
- live tool schema 没有 owner-proven effect/completeness/source 注解时保持 `unknown`。不能从工具名、UI rendering 或自然语言摘要推测完整性。
- 执行缝 request 已携带的 owner-provided program namespace 会原样保留并共享 cell lease；PTC Plus 不翻译其领域契约。与插件保留的 `capabilities`、`code` 或 `repl` 同名时 request 明确失败，不能静默合并；普通 cell 局部变量可以自然 shadow 这三个低频 namespace，需要时仍可从 `globalThis` 访问。native `tools` 不允许 shadow，因为那会切断主要能力面。当前公共 request surface 没有用于发现额外服务的 program-binding registry，因此插件不增加名称分发总线或私有 registry。
- 已激活的 Global User Binding 以 `namespace` 对象或选定 `top-level` 导出进入普通可写 REPL binding；模块导出保持 live read，同名赋值或重声明形成 session-local 覆盖且不写回全局存储。相对 import 在候选运行与正式激活时都从 `bindings.json` 所在目录解析；导出值被普通 session binding 保留后，其闭包所需的解析基准和动态 program namespace bridge 保留到 worker 结束。请求自带的 program namespace 与 error class 始终优先；同名全局条目只在该请求中激活失败并产生诊断，不能覆盖宿主值或阻止独立 cell。binding module 所需的 program namespace 若与既有 worker global 同名，本次 cell 显式失败，不能替换 Node intrinsic。其余名称按统一更新语义适配：语义明确的合法声明不因历史同名、旧声明类别或底层 lexical 不可重声明而拒绝，只有语义确实不明确的输入才可在执行前拒绝，并说明无法确定之处；内部适配限制属于实现缺陷。
- 新 cell 使用独立原生 frame 与连续逻辑 binding 身份；`bindingUpdates` 统一选择可更新或保护语义。真实模块使用 PTC 管理的 namespace 保持逻辑来源、实时读取与原值身份；外部代码独立原生导入 compiled URL 的互操作边界由 ADR 0025 拥有。`compiler-service.js` 在私有 realm 中同步准备源码，编译数据与捕获的平台操作跨越该边界；用户值、模块图与执行状态留在既有 runtime。作用域、root 与纯模块编译分别由 `repl-scope-normalizer.js`、`stateful-root-compiler.js` 和 `module-compilation.js` 拥有，`stateful-module-compiler.js` 对接 Node hooks 与模块注册，root runtime 和 worker/catalog 持有实际来源与提交事实。声明按完整 declarator 发布，普通赋值保留真实部分写入；import 作为同一身份的 live 来源，可被局部覆盖并重新导入，已有新代际闭包继续观察该身份。未执行 lexical 不成为有效目录状态。journal v10 分别固定语言契约和精确模块 transform；v1–v8 使用冻结 legacy 编译路径，v9 使用其发布时的 transform。绑定模块快照同样固定 transform。配置、编译入口及代际契约见 [ADR 0025](docs/adr/0025-use-versioned-logical-binding-identities.md)，目标语义与验收见[有状态计算提案](docs/stateful-binding-updates-proposal.md)。改写来源平行记录在 `meta.dshPtcPlusRewrites`，不进入封闭 journal；只有缺少有效 journal 时才投影不确定完成提示。
- `require(...)` 与动态导入按同一白名单分类：白名单内置模块保持 durable，其余 volatile，`worker_threads`/`cluster` 等内核控制模块在执行前以 `PTC-C002` 拒绝，非字面量参数为 dynamic module resolution。durable 只表示冷恢复可以重放已结算历史，不表示失败 cell 没有外部副作用或可以安全重试。

## Data boundaries

- `canonical` 表示程序收到的结构化值，不表示完整世界快照。结果必须区分 `complete`、`bounded`、`incremental`、`open-world` 和 `unknown`。
- 当前 DSH `tools.read` 契约是 bounded inspection，不是 lossless whole-file API；这项使用注意不构成 PTC metadata 注解。需要完整文件时，一等 profile 使用 `node:fs/promises.readFile` 或 stream；该直接 I/O 没有 call transcript，因此进入 volatile。
- model/UI rendering 与 canonical program value 是不同层；展示被裁剪不能证明 program value 被裁剪，反之亦然。
- `code.run` 在隔离 child runtime 执行 source，不合并父 binding。正常结算后记录并重放结果；若基础设施终止时调用仍未结算，discarded journal 以 `code.run` 记录 possible-effect boundary。该规则由所有 program binding 共用的 pending/settled 生命周期决定，不由 capability 名称决定。
- PTC 模式只把 `run_code` 声明为顶层工具；真实注册的 `edit_run_code` 经首轮即存在的 DSH typed SDK 在 cell 内调用。调用可用普通 JavaScript 表达式、别名或方括号访问，不依赖特定源码写法。正式 nested dispatch start 捕获同一 turn 最近的可编辑目标；普通 edit 可省略 `expected_target_call_seq`，携带时必须匹配捕获的目标 sequence。editor 对至多 16 个唯一、非重叠字面或正则替换做有界原子物化。接受收据为 `{ accepted: true, scheduled: true, target_call_seq }`，只表示外层 cell 结束后、根 `run_code` 结算前安排派生执行；同 cell 中的后续读取仍见旧状态，下一 cell 才见修订 binding。派生执行经 DSH 正式 `tools.execute`、policy 与调度；根结果保留外层 cell 的 canonical return 或 error，并转发派生执行经 Host 渲染的 content、images、additionalContexts 与成功根结果的 concludesTurn。真实派生 `tools.execute` 使用仍在运行的根 token 作为 parent，并通过公开 `Session.append` 记录其实际 start/settle；留存内容经过公开 scoped `tools/ptc-dispatch-log`，使用真实根 execution。完整源码、journal、editor cause 的 `startSeq`、实际执行的 `executionStartSeq`、目标与根源码关系写在根结果私有元数据；cold recovery 验证两个真实 start/settle pairs、canonical 结算事实、收据、变换和双重 model-visible provenance 后才保留状态，不虚构宿主执行、父关系或完成事实，也不重发外部 effect。成功修订成为下一目标；接受收据在 nested result 阶段被拒绝时不执行派生源码，取消或卸载也阻止未开始的派生执行。派生执行在 run 帧前因无法取得计算基线而未测量时，其 noop 结算可构成接受修订的后续证据：root 仍按自己的 journal 参与恢复，该修订不执行、不发布 binding、不成为成功修订或下一编辑目标，历史顶层 editor 关系仍要求已执行的派生运行。派生 effect 已发生后若最终根结果元数据损坏或 provenance 丢失，只收缩未证明的恢复 frontier，不声称撤销该 effect。详见 [ADR 0005](docs/adr/0005-temporary-rejected-cell-edit-transport.md)。

## Journal facts

`version: 10` journal 是封闭 schema，只包含：语言契约 `languageSemantics`、精确编译代际 `moduleTransform`、由 `variableRedeclarations` 与 `functionClassRedeclarations` 组成的 binding policy、rewrite policy、module semantics、Global User Binding snapshot fingerprint 或显式 `null`、其复用代际 `userBindingsReusePolicy`、session-local 覆盖粒度 `userBindingsShadowPolicy` 及其按名称证据 `userBindingNames`、status、call transcript、state operations、confirmed no-op call sequences、diagnostics、completion 与 optional volatile reason。`languageSemantics` 为 `legacy-v1`、`stateful-v1` 或 `protected-v1`；`moduleTransform` 固定该 cell 的确切 parser、compiler 与 lowering generation。v1–v8 固定迁移为 legacy transform；v9 按其语言字段映射到该版本发布时的 transform，其中 `stateful-v1` 使用 `stateful-module-v1`。两组 policy 固化该 cell 的 binding 与 AST rewrite 开关；在 `legacy-v1` 中，`moduleSemantics.defaultExportBinding` 固化 `export default` 采用 `legacy-variable` 或 `live-readonly` 绑定模型，`moduleSemantics.importExpressionBoundary` 固化模块引用写入的 lowering 采用 `legacy` 还是保持语句边界的 `statement-safe`；新语言的可写 alias、default 关联与候选提交由 `languageSemantics` 决定，不能从旧字段中的 `readonly` 推断当前 binding 不可写。冷恢复不读取当前 profile 的开关，也不从源码猜测 lowering 代际。`userBindingsShadowPolicy` 固化该 cell 的覆盖粒度：新 cell 为 `per-name`，只有同名 session-local binding 覆盖对应全局名称，同条目的其他名称继续激活；v1-v7 迁移的历史 cell 为 `whole-entry`，保留整条来源条目退出后续全局激活的旧语义。`userBindingNames` 只在 `per-name` 且 status 非 noop/discarded 时记录按名称排序的 `{name, state}` 证据，state 为 `provider`、`local`、`absent` 或 `unknown`，provider 事实另带 `entryId`；其余情况为显式 `null`。v1-v6 输入迁移时保留各自既有语义：`importExpressionBoundary` 固定为 `legacy`（v7 保留其记录值），v1-v5 的复用代际固定为 `fingerprint-v1`，v6 与 v7 保留其记录值，尚无 Global User Bindings 持久关系的历史格式把 fingerprint 固定为 `null`。call transcript 包含 namespace/member、PTC Value Graph 编码的 args/value 或 error，以及连续 settlement 序号；不包含推测的 effect 或 completeness。基础设施终止时 calls 清空；若仍有未结算 binding，`discarded.volatileReason` 保存最先观察到的 `global.member` possible-effect boundary。

Global User Binding 快照以并行私有 `meta.dshPtcPlusUserBindings` 保存；封闭 journal 只保存该快照的 fingerprint 或显式 `null`，从而验证并行 key 的存在性和内容关系。快照 v2 记录固定编译器的 `transform` 标识并纳入 fingerprint，恢复先验证转换代际，再从条目源码重新验证 identity、声明、binding 列表、durability 和 fingerprint。v1 未记录原生转换器代际，其非空快照不能证明历史模块值，必须收缩到此前可验证的 frontier；空 v1 快照保持原 fingerprint，可继续证明不涉及全局模块的历史。损坏、缺失、转换代际不受支持或与 journal/源码不一致的快照不能由当前磁盘内容补齐，也不能证明历史 binding，必须按相同的 unknown-boundary contraction 收缩。该过程不修改全局绑定存储，当前合法 cell 仍按当前配置执行。

两阶段确认通过 `run_code.output.presentationMeta` 与 `tools/result` 完成。已执行但最终 journal 缺失或变化时，live state 单调降为 volatile；未进入 runtime 的 call 由后续 `confirms` 证明为 no-op。损坏或缺失历史形成 unknown boundary，cold recovery 不把边界内外无法证明关联的 cell 或 binding 当作已恢复状态。恢复从当前请求所需的 head 向 parent 收缩到最大可证明 frontier；缺少更细粒度依赖证据时按 cell 与依赖后缀丢弃，最差重置为空 REPL，然后执行当前合法 cell 建立新分支并投影一次可行动提示。

durable node 重放失败时，插件把本次收缩记录为当前已结算 `tool/result` 的私有 `meta.dshPtcPlusRecoveryBoundaries`，记录失败 call 与其已验证 parent frontier；call/result 保持不变。boundary 必须在 event sequence 参与排序前完成规范化；损坏 boundary 不得静默消失、参与排序或证明任何旧状态，而应收缩可恢复状态，不能仅因历史插件 metadata 损坏而拒绝当前合法 cell。日志折叠删除失败或不可证明的 node、binding 与依赖后代，重算仍可重建的 checkpoints，重置 worker 后逐级验证更早 frontier，必要时到空 REPL，随后执行当前 live cell。新 durable node 必须连接到 worker 实际重建的 frontier；历史 program binding effect 不重新派发。日志中的 `ptc-plus/recovery-boundary` 事件只能通过显式、非破坏迁移转换后再交给 DSH persistence reader。

recovery frontier 还是结构可恢复状态与模型可知状态的交集。DSH append-only log 保留审计和 journal evidence，DSH ordered surface/实际 request history 拥有模型可见性；插件不能因为 raw event 仍存在或 Client 卡片仍能展示 binding，就把已被 surface compaction 遮蔽且没有模型可见结构化投影的状态继续暴露给代码。surface replacement 只裁剪 tool result 而保留携带源码的 assistant call 时，模型仍有精确 provenance，不能机械删除该 cell。surface generation 收缩必须在下一 cell 前同样作用于现存 live worker，而不只作用于 cold replay。

自动重写以 `meta.dshPtcPlusRewrites` 平行 key 记录（`{ kind: import|export|redeclaration, description, source? }`，校验与冻结同 journal 风格），不进入封闭的 journal schema，也不参与 `journalsEqual`；只对真实执行过的 cell 出现，preflight 拒绝的 cell 不带。`tools/result` 两阶段确认不受该平行 key 干扰。

宿主工具调用经 worker 回调回到主线程时，DSH 的 AsyncLocalStorage initiator 上下文在回调中为空。插件注入 `agents` 服务并在 `invokeBinding` 处用 `withInitiator(精确活跃 agent, ...)` 建立边界：要求 driver 内精确调用 agent 的宿主工具（如 goal 跟踪）可从 cell 内 `tools.*` 直接调用。`edit_run_code` 的外层注册和派生 `run_code` dispatch 也必须复用这条宿主工具流水线，不得通过模型流中间件伪造调用。

## Presentation

DSH 原生 tool guidance 与 typed SDK 保持 owner 提供的内容。PTC Plus 修改 `run_code` 的连续 REPL 说明，追加 `capabilities` explorer 声明，并在 Global User Bindings 配置开启时声明稳定的 `code.submitBindingDraft`，并让真实注册的 `edit_run_code` schema 在首轮 PTC program SDK 中可见，顶层 direct schema 仍只有 `run_code`。稳定指引只保留 cell async body、模块适配、binding continuity、能力发现、计算/值传输/native JSON 区别和 execution-world 边界；不假设 Windows、WSL、POSIX、shell、package runner 或某个 native tool 存在。改写反馈和按需恢复 tip 只有在事实不已由 call/result 表达且确实改变下一步决策时才使用带 `ptc-plus` 来源的独立消息；恢复状态用有界 `snapshot`，全局绑定 API 说明用独立 `catalog`，tip 用带 trigger/ordinal 的 `notice`。恢复快照只替代 PTC 旧状态，不替代绑定目录、task、Skill、tool result 或其他 producer；空恢复快照撤销旧状态；空目录撤销旧 API 说明。Host runtime-context 的撤销不适用于目录，暂停仅阻止新投递。投递经公共 assembly witness 与 accepted `agent/pre-step`，遵守 runtime-context suppression，从已提交历史和公共 ordered surface 重建，不把待投递消息算作已送达；edit 身份、参数、结果和目标消费由真实 call/result 表达，runtime context 不承载 edit 专用信息。恢复 tip 受 `tipCooldownMessages` 与 `tipEscalationFailures` 约束；成功 cell 重置未解决计数。新 agent 或 Cordis 重新启用代际若从规范 journal 观察到历史 Cordis transcript，则用固定命名 context 将 recorded value 限定为历史数据，并要求在依赖旧 ID、状态或 capability observation 前执行新的成功 Cordis Inspect；该 context 不重放 effect，也不声称进程内状态必然丢失。

普通顶层误调用的 transport recovery 是确定性协议归一化，不调用模型、不增加 authority，也不注入动态纠错 context。它只修复 declared direct surface 之外、但由 live schema 可证明的 native call；无法证明时保留原调用，由宿主报告真实错误。参数在 canonicalizer 中解析一次，普通 JSON 原样生成 JavaScript 参数，含 own `__proto__` 的值改用安全字面量保持执行语义；超过可安全解析语法深度的 JSON 改用浅层 `JSON.parse` 表达式，避免派生 cell 在 DSH validation 或 dispatch 前耗尽 TypeScript parser 栈。派生 cell 不携带额外 provenance 或纠错提示，使规范化对模型透明。已声明的顶层 `run_code` 不是误调用；程序内 `edit_run_code` 不经过这项顶层归一化。

普通成功 cell 不产生 PTC warning/note。宽松重声明和首次进入 volatile 都是正常运行状态；后者只进入 journal 与 `repl.state(list)`。只有执行失败或 cold recovery 实际跳过历史状态时才投影可行动诊断。同一失败指纹在单个 kernel 内连续出现 3 次时，失败 cell 追加一次分类提示：可证明的 binding 错误使用 `PTC-W001`，其中 lexical 错误指向可见源码、作用域与初始化，只有 worker-owned capability 错误建议 live capability 探查；其他错误使用 `PTC-W002` 且只要求重新检查其具体 cause。附加提示沿用失败 cell 的 stateEffect，不声称此前语句未生效。成功或不同失败会重置计数；提示不重写原始错误。

能力管理冻结启用与披露选择，不冻结宿主 calling contract。当前参数、结果、说明依赖及 Skill 调用资格由 live owner 拥有；变化经允许且接受的步骤追加一次 capability-contracts 消息，撤销或替换对应旧契约，不重分配选择或修改历史/稳定前缀。用户专用 Skill 保留用户配置与 /name 入口，不推荐模型加载。当前公共扩展面没有跨 prompt assembly 与 runtime dispatch 的冻结 capability token。插件在两个阶段使用同一 agent scope，但以实际 request binding 为执行事实，不承诺不存在定义漂移。

## 设置 UI

PTC Plus 注册 `ptc-plus` settings namespace，字段来源于 `internal/config-spec.js`。Client half 在侧栏 **插件 → 已安装 → dsh-ptc-plus** 的插件行配置页呈现全部设置，通过 `plugins.row.config`（keyed，键 `<包名>#<行 id>`）注册；旧宿主的插件设置使用 `settings.plugin.item`（keyed，按 namespace）。`src/client-host-compat.js` 等待对应页面声明槽位，并按 `summary`/`page` 分别渲染一句描述与完整表单，不向通用设置注册。星光菜单在应用内弹窗复用完整表单与写入 owner；包元数据的 `icon` 指向随包发布的 SVG，由宿主显示在插件列表与详情页（[ADR 0019](docs/adr/0019-plugin-settings-and-kill-switch.md)）。`toolHoverPreviewEnabled` 默认开启，控制增强执行卡片的悬停与键盘聚焦预览，关闭时即时取消预览并保留点击展开。预览优先位于鼠标右侧，当前空间不足时回退到行的上下方。
`enhancedToolView` 默认开启且只影响 Client 展示：开启时通过公共 keyed tool-view surface 组合可用的 DSH primitive，缺少某项 primitive 时使用插件自有的等价降级；关闭时注销 keyed view 并交还 DSH 原生 generic row。两种路径都不改变工具、prompt、runtime 或 session 语义。
`autoDescribeRunCode` 默认开启且只控制本地执行宽容度：开启时，缺少外层 `description` 的 `run_code` 使用派生参数通过本地 DSH 校验，备用摘要仅进入 presentation metadata；关闭时由 DSH 校验原始参数。两种状态的模型请求保持字节稳定并包含 required `description`，原始调用参数、代码、native 工具参数、权限、journal 和 session 语义保持不变。
设置按核心工作区（REPL 语法、状态与恢复）、扩展与容错（工具扩展、调用容错）、界面与资源（界面显示、资源限制）、实验性（能力与上下文）分组；配置页与弹窗将唯一总开关与导航顶部的 PTC Plus 标题合成一行，不显示重复的已启用标签；静态模块标题与带图标、箭头及选中标记的导航项分层，正文从 REPL 语法开始，旧折叠卡片仍将总开关置顶；宽屏设置工作台使用左侧导航和右侧内容的双列布局，小屏使用横向导航与独立正文；导航和正文分别滚动，滚动正文或选取分区不移动导航。能力与上下文包含手动配置、使用统计、上下文预算与会话方案页签；类型、来源、保存策略和冻结会话结果保持独立，列表提供组合筛选与稳定排序，Skill 正文不因查看设置而加载。任一能力或上下文功能选用时可读取冻结会话来源，手动配置与目录读取仍独立可用。恢复提示及其间隔、阈值集中在状态与恢复区，全局绑定管理入口紧随工具扩展区的全局绑定开关；功能模块与分组由 `CONFIG_MODULES`、`CONFIG_GROUPS` 拥有，与 Host schema 字段顺序独立，不改变默认值或执行语义。
`enabled` 是 kill switch：关闭时宿主保留 settings 注册、设置卡片，以及仅用于在下一允许步骤撤销旧 PTC 声明的被动消息清理；不安装 runtime、执行 hook、tool surface 或 prompt section，不读取 binding 存储；
关闭状态不产生 `run_code`/`edit_run_code` 模型表面，设置卡片只允许操作 `enabled`。配置保存后由 settings watch 更新 owner；能力与上下文的职责输入用于新会话，已有会话保持冻结方案并通过 `/capabilities refresh` 同步。其他可重配置字段即时生效，运行时 owner 更新配置时保留已有 session-bound REPL、binding、journal 和 native DSH authority，失败则回滚到上一个已应用配置。已提交的 cell 在完整生命周期内绑定提交时的同一份配置，更新后的限额和策略用于随后提交的 cell，不能让一次执行混用两个配置代际。Node worker 的 V8 old-generation 上限在创建时固定，因此活动 worker 存在时修改该字段会明确失败并回滚，而不会静默报告为已应用。
`cordisToolsEnabled` 默认关闭且即时生效。开启时，官方 `@deepseek-ai/dsh-tool-cordis` 与 shipped `cordis` preset 的 `cordis-plugin-development` Skill 作为同一个 agent-scoped mount 进入同时暴露 `run_code`、`skill` 工具与 `agentPresets`/`skills` service 的 agent；Skill 根先通过公共 `agentPresets.resolve()` 取得可用的绝对 composition path，pathless generation 则从该宿主安装的官方 `@deepseek-ai/dsh-agent-preset` 或 `@deepseek-ai/dsh-agent-presets` 包资源定位，并要求准确存在 `cordis-plugin-development/SKILL.md`。官方 filesystem provider 将该 Skill 根作为不可变的 bundled Host resource，继续拥有解析、资源基址、不完整观测与加载；打包目录不启用 watch。PTC Plus 只在公共 provider 注册边界精确保留 companion Skill，不能让同目录 sibling 自动扩展 PTC surface，也不复制内容或切换 preset。普通 agent 不继承，code-only direct-tool projection 仍为 `[run_code]`。agent scope 缺少其中任一 surface 不是错误：owner 保持 pending、不在该 scope 发布任何内容，并在工具 surface 变化或下一次 prompt assembly 时重试（[ADR 0029](docs/adr/0029-keep-plugin-unavailability-out-of-the-host-agent-lifecycle.md)）。已暴露的 preset、精确 Skill、所需服务或任一 child fiber 与 DSH 契约矛盾时才是配置错误：安装时枚举到的 scope 使启用失败并完整回滚；由宿主自身调用（`agent/created` 串行分发、prepended `system-prompt/assemble` waterfall）触达的不可用 scope 只从该 scope 撤出并记一条 warning，不使创建该 scope 的宿主操作失败。Cordis 工具名、数量、schema 和 guidance 只由官方 tool fiber 的 live surface 拥有，PTC Plus 不复制或枚举。官方 fiber 的 Host inspect provider 注册属于进程级资源：PTC Plus 在自己的 runtime owner 内合并同一 manifest 的 agent-fiber lease，并在最后一份 lease 释放时注销，避免多 agent 或关闭后重开重复占用 provider ID；查询实现始终委托给仍存活的官方 fiber。
`userBindingsEnabled` 默认开启且即时生效；显式配置 `false` 时保持关闭。开启时，Host 才读取 `$DSH_HOME/ptc-plus/bindings.json`，通过宿主 Gateway 注册经过 Host/Origin 检查与浏览器认证的管理 Remote，并按实际 PTC prompt composition 注册 agent-scoped `/binding` 命令；空会话切换 preset 时先撤销旧命令与 edit surface，再由下一次 assembly 确认新 composition。Client 同时显示设置工作台与 session Global 页签。设置工作台拥有完整管理；当前输入区的草稿审阅面板通过公开 dock 的零高度锚点定位 Portal 预览，展开/折叠不改变对话和输入框高度；放大审阅复用同一候选与写资格，通过公共 Modal 或已有回退组件显示独立滚动正文和固定操作区，输入入口不可见时弹窗让位；面板提供用户独占的保存与丢弃，历史命令卡片保留请求和只读来源。`code.submitBindingDraft({requestId, entry})` 是同配置下稳定的内部 program SDK，Host 在调用时核验精确 agent、请求代际、cell lease 和一次提交资格；编写指引通过追加 instructions 消息提供，开始和结束不挂卸 tool 或 Skill。首个有效提交成为停用内存草稿，交接调用不执行或持久化候选；提交前的内存测试使用现有会话 REPL。管理 Remote 不提供 caller/session identity，因而 draft 操作必须持有 Host 生成并只经 accepting session 私有 result metadata/projection 发布的 opaque locator，不得信任 payload session ID；agent/session disposal、功能关闭或 owner disposal 撤销该 locator。已接受源码与命令身份作为独立只读历史保留；用户保存或丢弃完成后，通过公共 Session append 写入引用接受结果的事实回执，保存不等于成功激活，UI 源码也不构成模型状态知识。候选 worker 只隔离 session 状态，不降低 DSH 进程权限或承诺 effect 可回滚。
设置卡片、正文 PTC Plus tool view 与 REPL binding 卡片的全部文案注册到 DSH client 的 `settings.ptcPlus` locale 命名空间，随界面语言在中文与 English 之间切换；字段名称与说明的双语文本由 `internal/config-spec.js` 拥有，展示 chrome 文案由 client half 拥有。稳定 REPL 指引保持插件拥有的协议文本，不携带 UI 品牌名。选择 `ptc` preset 或兼容的 `code` preset 且插件启用时，Client 会在会话头部以稳定 slot id `ptc-plus-active` 显示轻量 `PTC Plus` 标识（视口不超过 560px 时隐藏，会话绑定仍可从 REPL 页签访问）；悬浮或键盘聚焦时，从公共 `sessionProjections` 的 `ptcPlusRepl` value 显示当前 runtime owner 已证明可供该 agent 后续 cell 复用的 binding、variable/function/class/import 类别及其有界原始声明源码与行列，用户可在卡片内展开查看定义。定义来源由 AST preparation 和 BindingCatalog 从已提交 cell 文本拥有，不读取、调用或序列化 worker 中的 binding value/getter；每段源码至多 1024 个 UTF-16 code unit、单个 snapshot 合计至多 16384 个 code unit，清单至多 128 项。运行时把该有界 inventory 与 presentation-only runtime generation 写入并行私有 `meta.dshPtcPlusBindings`；volatile 只是 cold recovery 分类，只要 live worker 仍保留且 model-visible provenance 未被遮蔽，才继续发布该 binding inventory。该 UI-only snapshot 不进入模型请求，也不能单独证明模型知道某个 binding 或延长其 runtime 生命周期。restore、discarded settlement 或 model-visible surface contraction 会重置/收缩 worker，因而在下一次 cell 物化并证明有效 binding surface 前显示不可确认。投影以 DSH 公共 `tool/call.data.callId` 与 `tool/result.data.message.source.callId` 配对 `run_code` / `edit_run_code`，不要求可选的 `sourceEventSeqs`；只接受当前 runtime generation 的完整 snapshot，并在 `session/end-seed` 清除上一 lifecycle 的 live 证明。相关结果缺少、损坏或属于其他 generation 的 snapshot 时不覆盖最后一个仍有效的已证明清单；无关 tool result 与仍保留声明 provenance 的 result-only replacement 同样不覆盖。若 replacement 收缩 model-visible state frontier，runtime 与 UI projection 必须使用同一 owner decision：相关 binding 从默认计算环境移除，inventory 在下一份对齐 snapshot 前显示不可确认。DSH 的 header-action 公共 kit 不提供从卡片打开 tool call/source location 的导航能力，因此 Client 使用卡片内检查，不访问私有 store 或宿主 DOM；来源跳转要求 Host 提供公共 capability。该路径不执行代码、不增加模型可见内容。插件启用期间，Client 还通过公共 keyed `tool.call.toolview` 为 `run_code` 与 `edit_run_code` 保留源码/结果视图，并只在已有 presentation metadata 能证明时展示具体功能事件；关闭时注销这两个 key，交还 DSH 原生 fallback。正文不显示 cell、call、恢复边界等计数。该展示不请求历史、不检查宿主 DOM，也不增加或改变 canonical result、tool、prompt、runtime context、封闭 journal schema、replay 或迁移；缺少有效 metadata 或兼容 projection service 时不显示当前 binding inventory，继续会话和核心 runtime 语义不变。Client 从宿主 session slot 提供的公共 `useProjection` 读取会话状态；仅 preset 选择在缺少 `agentPreset` projection 时允许读取旧宿主公开会话摘要的 `agentPreset` 字段。binding inventory 与草稿资格必须保持各自的 projection 证据，各贡献按实际所需公共 slot 和服务注册，不使用私有 store。DSH settings 服务缺省时回退 composition config，运行时语义保持不变。

## REPL 控制台

REPL 控制台使用公开 `conversation.view`，由当前 Client 的会话选择、`agentPreset` projection 与插件开关共同决定注册；只有 `ptc` / `code` 会话拥有该页签，DSH 继续拥有导航与回退。会话观察只显示名称、定义来源及带观察时间、截断与不可读取状态的有界值预览。值检查属于 worker owner，新代际直接读取已提交且最终 catalog 可证明的普通本地值；旧 storage 只读取成功执行源码可证明的 lexical binding 或自有 data descriptor，并在反射前排除 Proxy；不触发 getter、Proxy trap 或用户 formatter，不使用 Inspector 连接。值预览不枚举对象属性集合，只对基本值和数组前五个自有槽位提供有界读取，其余对象保持不可读取。

cell 的执行结果与 journal 先结算，再以独立私有消息附加可选 UI 观察。可见 REPL 清单没有预览时，可经宿主认证的 Remote 请求一次有界观察：只读取现存、已结算且 surface generation 与清单一致的 worker，沿用 cell 队列与 readiness 握手，不启动 worker、不恢复或重放历史。按需结果只留在当前 Client 清单的展示状态，不回写日志；清单替换、取消或失效后丢弃旧响应。未采集与不可读取必须区分。预览失败、迟到或缺失不改变已结算结果、不重启 worker，也不构成模型知识、journal evidence 或保留隐藏 binding 的理由。它不是原子 heap snapshot 或实时监控，不增加会话代码输入、Agent 对象操作或克隆环境。`dshPtcPlusBindings` v5 的可选观察、名称清单与复用计数共享原有 generation、seed、restore/discard 和模型可见 frontier 失效规则；v3 源码清单与 v4 清单仍可读取展示。

旧原生路径的异步 lexical storage 由当前 worker 的真实 REPL 探测决定，失败只关闭相应预览，不影响执行；新逻辑 root 读取不依赖该探测，也不为观察执行 import 或关联来源 getter。函数内部 await 不影响外层变量证明。基本值预览含至多 128 位的 BigInt，超限只显示有界提示，不完整转换。数组的额外自有属性未被检查，即使所有索引都能展示也始终标记预览不完整。

Host 最多等待 250 ms 获取可选预览，但这不代表 worker 已结束原生检查。下一 cell 通过私有 `prepare` / `ready` 消息确认 worker 就绪后才派发代码。计算与墙钟预算通常从发送 `prepare` 前开始；只有同一 worker 已确认开始且尚未完成的观察可以暂缓计时。按需请求的发送不构成开始证明，worker 处理 `observe` 时先发送 `observation-started`，再同步观察；cell 结束后的观察由同一 worker turn 内的 `done.observing` 证明。观察完成或匹配的 `ready` 到达时启动暂缓的预算；迟到的开始确认不能暂停或重置已启动的预算。观察的执行身份与展示等待期限分别记录，后台用户回调导致的其他阻塞仍会超时并按原契约恢复。等待同时受请求取消、session disposal 与 worker failure 约束，不能因为预览迟到重置连续 binding。

完整全局管理由 REPL 全局绑定区和设置按钮打开的大尺寸应用内弹窗复用同一个工作台组件。设置卡片保留开关与管理按钮，普通管理不依赖当前 PTC 会话；Agent 编写仍需要会话命令资格。功能关闭时两处管理 UI 都释放，原有权限、revision 校验、持久化和激活语义继续由 Host owner 拥有。具体预算和协议见 [ADR 0024](docs/adr/0024-repl-console-observation.md)。

## Scope boundaries

- 插件不自建跨平台权限、安全沙箱、通用进程治理或命令 DSL；
- program binding 由 live request 直接提供，不经过名称反射或私有 adapter；
- bounded window 不拼接成伪 lossless reader，unknown metadata 不升级成 complete、durable 或 effect-free；
- capability map 的机械探索不消耗模型 token；语义增强必须由用户主动触发或预先授权并受硬预算约束；
- Work Map、跨插件聚合和统一 registry 属于上游协调层，不在本插件复制。
