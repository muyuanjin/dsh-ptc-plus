# 能力方案与统计组件

本文描述方案、统计及其会话接入。独立组合规则由 [ADR 0043](adr/0043-compose-capability-and-context-policies.md) 拥有，冻结与权限边界由 [ADR 0038](adr/0038-freeze-session-capability-plans.md) 拥有，执行证据见[覆盖矩阵](context-public-interface-coverage.md)。`internal/capability-environment.js` 将纯方案用于首轮目录、冻结环境、编译前成员投影、刷新和恢复；`internal/capability-statistics-store.js` 将真实家族事实接入锁定的原子存储。

## 方案计算

`internal/capability-plan.js` 导出 `createCapabilityPlan(input)`，有 `contextEnabled` 输入时返回递归冻结的 `ptc-capability-plan/v3`，记录整体选择及有效管理状态；缺省该维度时，有 `policy` 输入使用 `v2`，否则使用 `v1`，保留历史精确校验。

| 输入 | 契约 |
| --- | --- |
| `contextEnabled` | 整组是否选用；false 通过 `effectiveCapabilitySettings` 暂停管理、采集、恢复和预览，不改写独立保存输入 |
| `enabled`、`configurationRevision` | 独立管理开关和配置修订；关闭时条目选择为 `host`，不修改宿主 |
| `capabilities` | owner 提供的准确 `{id, revision, category, contract, dependencies?}`；依赖为 `{id, text}` |
| `policy` | `ptc-capability-policy/v1`：默认、类别、MCP 来源、单项分别保存 availability 与 disclosure，allocation 分别选择 baseline/statistics/budget；见下文 |
| `manual` | 可编辑的 `baseline: string[]`；历史输入的 `overrides: { [id]: "full" \| "on-demand" \| "closed" }`；显式项始终优先 |
| `statistics` | `enabled` 控制采集而非分配；正整数 `windowSize`、`minimumSamples` 和 `[0,1]` 范围的 `fullThreshold` |
| `coverage` | 按准确能力 ID 索引的 `{revision, workspace, global}`；覆盖证据形状由下述归约组件提供 |
| `budgetBytes`、`directoryBudgetBytes`、`navigationText` | 完整契约和目录分别按 UTF-8 字节计量；固定发现指引必须在目录预算内 |

`internal/capability-policy.js` 统一校验和解析可复用规则。`defaults` 必须同时包含 `availability: enabled|closed` 和 `disclosure: host|full|on-demand|adaptive`；`categories`、`mcpServers`、`items` 可分别覆盖其中一个维度。默认 → 类别 → 已证明 MCP 来源 → 单项按维度覆盖；MCP 来源关闭是外层移除，优先于子项启用，但不删除子项偏好。每个派生条目保留两项原意、各自来源和兼容的有效 `selection`，关闭时仍保留 disclosure。未解析的非空单项 ID 保留为可撤销输入，只有真实受管库存使规则生效。管理关闭时所有实际能力沿用 host；未选用的关闭规则不参与库存过滤或归属诊断。

`host` 保留已有 PTC 提供方说明路径；纯启停不会让其余能力变成按需。共享说明只在没有沿用宿主的消费者时移除，SDK 仅保留 host 披露的可用工具与始终可调用的编辑传输成员（`edit_run_code` 不属于管理域，每次渲染都保留其宿主签名）；全体仍为 host 时保留原 SDK。Skill 全部沿用时保留宿主目录；混合披露时完整保留 host Skill 的目录说明并隐藏按需说明，不加载正文。按需项始终可获取完整契约。策略世代与旧版覆盖方案同样区分 Skill 原生准入与有效调用路径：关闭模型 loader 不关闭独立用户入口；无可用入口时派生不可用而保留偏好，管理关闭也不将缺失入口计入实际供给或统计资格；未选用的关闭偏好不参与该事实。哪一层写下这个关闭不改变它的含义——保存策略里的一条规则，与策略世代之前冻结、至今未刷新的方案所带的旧版覆盖记录，都由同一个判据读成关闭。条目因此也带 `reason: 'invocation-path'`：它对应策略世代的 `availabilitySource: 'invocation-path'`，说的是「库存已证明这条自身调用路径不可达」，而不是某个人工规则（`mcp-server-disabled`）或基线未选（`baseline-not-selected`）；旧版方案重算时这一类条目已被判为 closed，不会把「本会话已无路可走」的能力继续当成完整契约陈述一遍。MCP 资源契约只列实际可用且未关闭的操作；旧版层把整条路径写成一句话，操作仍齐全时保留那句话，缺一个时只列剩下的并说明一种都不剩。这句话由同一个函数（`resourceOperationNotice`）为组合与可探索的读法各生成一次，所以未被变更的会话读到的字节不变；资源 server 行的供给就是「还剩一个操作可陈述」。派生行的读法比成员行多一个输入：`metadata` 接受本 cell 程序的成员集（装配侧把桥算出的那一份交给它），所以「这句话说的是哪几个操作」是组合交付过、记录没关掉、这一步真的交给了程序三者的交集；没有观察过准入的调用方读到的是组合。宿主那张 `mcp-resource-servers` 目录由同一个归属集合重写：它列的名字只能作为 `server` 参数交给三个资源操作，所以这一步一个都没交付时目录列不出任何 server（段落整段离开），`mcp:<server>` 说明随它所属的行离开或留下，同 server 仍有工具交付时保留；没组成立方案时没有行可归属，目录只按准入判定。准入收窄的是本插件自己的契约视图而不是替换它：宿主发布的定义是面向模型的投影，不带 output schema，照它记录契约会把结果写成 `unknown`，并产生一个没有活动库存能对上的 revision。开关关闭或暂停时不应用记录里的关闭：两者都委托宿主能力与展示，组合与环境都不成立，记录仍保留、重开后再生效。全部功能未选用或只使用预览时不强制读取能力库存。

只有 adaptive 项消费 `allocation.baseline`、`allocation.statistics` 和 `allocation.budget`；关闭预算约束时允许全部选中的分配候选，仍计量正文与超额。显式 full 不因任一预算选择被降级或截断。统计采集由 `capabilityStatistics.enabled` 单独拥有，不取决于管理或分配是否选用；管理关闭时从公共 live inventory 取得真实资格，记录 host 披露；Host 增删沿真实 live inventory 更新统计资格，不变更冻结配置。停止采集后仍可选用留存有效证据。只读观察既不采集也不需要启用统计分配。

配置格式与纯方案组件接受 `tool`、`skill`、`resource`、`resource-template`、`task` 五类。当前宿主库存仅产出 `tool`、`skill`、`resource`，定义由 `internal/capability-policy.js` 的 `CAPABILITY_INVENTORY_CATEGORIES` 统一供库存与类别控件消费。MCP 资源与模板共用每个服务器的 `resource` 条目；没有独立模板或任务库存，执行任务的 SDK 工具仍归 `tool`。设置仅显示这三类，但保存和历史方案仍保留五类契约；`language`、`node`、`repl`、`ptc-plus`、`global-binding` 保持范围外。适配器必须提供真实来源身份和完整契约；本组件不从工具名字猜测来源，也不加载 Skill 正文。Skill 库存、完整契约、检索与设置来源元数据保留 owner 的 `modelInvocable`/`userInvocable`：模型可调用项说明 `tools.skill({name})`，用户专用项说明 `/name` 用户入口；两者关闭的项不进入可用目录。披露不能扩大加载权限。

adaptive 选择统计依据时，统计不足可回退到已选用的基线；工作区样本足够时优先采用，工作区不足时才参考全局，不将重叠家族相加。无效设置或不可用证据不撤销手动选择。纯描述或 schema 的修订继承尚未由公共适配器证明，因此当前不同 `revision` 隔离。

排序综合覆盖率和契约长度，采用确定性的 ID 裁决。预算计入实际 `catalogText` 的标题、完整契约、分隔和去重后的公共依赖。显式完整条目可超预算，`budgets.overageBytes` 明确报告；自动项不截断契约。存在按需项时，目录保留固定检索指引，在独立预算内提供输入库存中非关闭能力类别的简短用途导航（纯组件支持工具、Skill、MCP 资源/模板及任务；当前宿主接入前三类），不复制单项完整描述或按 ID 抽取长尾条目。存在按需项时，完整或按需分配变化不改变目录结构；未逐项列名的能力仍可通过检索发现。冲突的共享依赖不能合并成一个貌似完整的契约。

完整契约依次排列显式完整、已选基线、其余自动完整三组，组内按 ID 排列；每组先放尚未提供的共享依赖，全目录仅提供一次。统计用于分配，不用于重排已选条目。目录先于完整契约，使统计分配变化尽量保留导航与显式完整契约前缀。统计数字、配置 digest 和会话身份仅在来源元数据中，不进入说明正文。目录只承担用途发现，完整 owner 描述由完整披露或实际检索提供。

输出还包含每项选择及原因、统计范围与样本数、未解析的配置 ID、范围外集合和字节计量。这里的字节不是模型 token；设置页显示方案和预算，任务收益仍须独立校准。没有推荐列表或数字被伪装成实际使用。

## 家族统计归约

`internal/capability-statistics.js` 导出：

```js
createCapabilityStatistics({ windowSize, maxFamilies, maxScopes, maxCapabilitiesPerFamily })
reduceCapabilityStatistics(state, familyObservation)
validateCapabilityStatistics(state)
capabilityCoverage(state, { userId, workspaceId, id, revision })
```

输入事实为 `type: "family-observation"`，包含真实 `userId`、`familyId`、单调 `observationRevision`、`settlement`、不可变 `eligibleOrder` 和累计 `observations`。结算状态为 `active`、`settled` 或 `unknown`；只有已结算且具有正整数资格序号的家族可用于分配。适配器必须证明资格，不能把 root idle 或缺少后代用量当成家族结束。

每个可用观察包含 `workspaceId`、能力 `id/revision/category`、当时的 `disclosure` 和 `planRevision`；只允许真实可用的 `host`、`full` 或 `on-demand`，关闭和未提供项不能进入分母。使用证据分别为工具/任务的 `host-execution-result`、Skill 的 `skill-body-accepted`、资源/模板的 `resource-access`。查询、cold replay 和权限阻止的请求不接受为使用证据。工具使用表示真实调用进入 DSH 的 around execution 管线并获得正式规范结果（包括失败和合法 wrapper 提供的结果）；不证明注册 body 或外部效果执行。失败或已准入的取消结果独立保留，明确的 dispatch 前取消、未知工具及未准入调用不算使用。

同一家族、能力、范围只贡献一个使用位。工作区观察和全局观察分别归约，跨工作区后代不增加全局权重。每项能力和范围使用最近 N 个合格家族；续接修改已有身份的使用事实，不改变原资格顺序。正在运行或结算未知的家族不形成负样本。淘汰前沿阻止旧观察重读后重新进入已有窗口；不使用自然时间衰减。

`capabilityCoverage` 返回样本量、使用量、窗口和覆盖率；没有可用样本时覆盖率为 `null`。尚无任何相关记录时状态为 `no-samples`，窗口内已有记录但家族当前未结算时状态为 `pending-settlement`，两者样本量、使用量和覆盖率均为 `null`，界面显示破折号和证据状态而不是零。窗口已淘汰旧证据后，近期家族恢复为运行中或结算未知，若剩余已结算样本不足 N，状态为 `incomplete-window`，样本量、使用量和覆盖率均为 `null`；不能把无法重建的窗口子集用于自动分配。再次具有 N 个已结算样本时恢复有效。超过显式容量上限后状态为 `capacity-exceeded`，覆盖依据为 `null`。这些不可用证据均回退手动基线；未淘汰证据的正常冷启动仍可返回实际样本数。结构损坏由验证器拒绝，存储适配器将读取失败转为统计不可用诊断，保留手动配置并继续合法计算。

组件状态是可验证的 JSON 数据。存储适配器使用宿主 home 路径下的 `ptc-plus/capability-statistics.json`，以 `withFileLock` 和 `writeFileAtomic` 串行化跨实例更新，仅保存身份、资格、使用和结算元数据。续接修订原家族使用位，资格顺序保持不变。公开家族 census 不完整、未进入 step 或 turn 非正常完成时不产生负样本。

## 会话接入

历史 `ptc-capability-environment/v3`：`sourceSettings` 保存采用的复用配置，`sessionOverrides` 保存独立临时维度，`settings` 与 v2 `plan` 为验证后的派生值；其中 `recoveryEnabled` 和 `previewEnabled` 冻结额外说明恢复与插件预览选择。旧 v1/v2 环境仍用原方案计算和正文恢复，保留其管理耦合行为，不套新默认值。配置迁移把旧完整/按需/关闭选择转为规则，并保留原 adaptive 默认、统计分配及已开启管理的恢复/预览；新配置默认 host，恢复/预览关闭。

独立命令为 `/capabilities set session|global <id> availability enabled|closed|automatic|inherit` 与 `/capabilities set session|global <id> disclosure host|full|on-demand|adaptive|automatic|inherit`。`automatic` 仅撤销该维度单项覆盖、重新消费上层规则；`inherit` 仅取消该维度临时选择，恢复冻结源。同项全局保存只清除对应临时维度，保留其它维度。原组合命令仍兼容：closed 关闭且保留说明偏好，full/on-demand 恢复可用并选用说明，automatic 撤销两项单项选择。

以下 v1/v2 描述保留旧代际恢复依据；v3 采用上述独立职责。

`ptc-capability-environment/v1` 源消息记录设置、完整 owner inventory、统计依据与派生方案，digest、方案重算与精确正文共同校验恢复。新方案显式记录当前 `navigationText`；缺少该字段的既存 v1 方案按其原固定导航重算和核验，升级不重写历史正文。首次准备在模型请求之前完成，只产生待接受方案；尚无已提交任务历史时，通过公共 `agent/pre-step` 将新方案放在本次接受消息批次的任务之前，由 Host 在受保护 system head 之后提交一次。已有历史不重排，拒绝、取消或请求准备失败不构成方案恢复证据。已提交方案不重复追加，被压缩的正文不因原始日志仍有记录而复活。

宿主 prompt section 的空字符串或纯空白说明不形成契约依赖，但其 section 身份仍可证明 MCP server 归属。工具签名和资源契约保持可发现；非空说明原样保留并去重，非字符串等无效依赖仍由方案校验拒绝。

工具完整契约与程序检索元数据来自公共 `ToolRuntime.schemas(scope)` 与 `ToolRuntime.get(name, scope).output.schema` 的准确 JSON 快照，包含参数及返回值 schema；输出 schema 也参与修订身份和恢复比较。新 cell 的检索与 inspect 从同一份当前 SDK 快照派生结构化 schema、签名、依赖及修订，不将冻结方案中的旧签名覆盖到新返回值类型上；冻结的是启用与披露选择。每次准备与接受步骤重新读取 live owner 契约；同名工具的参数、输出或说明依赖变化，以及 Skill 调用资格变化或能力移除，以 `capability-contracts` 的 `ptc-capability-contracts/v2` 来源消息更新当前效力。消息记录原方案 digest、当前修订向量、变化项和当前完整说明超额，digest 与精确正文共同校验；不修改原方案。仍选完整的项提供完整新契约和去重依赖，按需项合并为一条调用前检索当前完整契约的提示及变化身份列表，移除项逐项明确撤销。历史 v1 消息保留原有逐项正文，新 v2 按分组正文核验；两代均校验 digest 与精确正文，保留的有效旧通知仍参与恢复去重，未知代际不作为证据。投递经 accepted step，拒绝与取消不提交；未变视图不重复追加，恢复按正式可见消息协调。实际可用和使用统计采用当时的契约修订，已准入调用保留捕获时的观察身份。顶层模型工具 schema、准入与调用规范化继续使用独立的 `ToolRuntime.schemas(scope)`，不向模型工具定义追加 SDK 输出字段。冻结方案只为冻结时已捕获的身份保存选择；宿主随后 live 提供且未被显式关闭的新成员保持宿主声明（工具保留 SDK 命名成员与类型化签名，Skill 保持可加载），刷新才把它折入方案，刷新边界不把成员身份从声明、检索或分派面移除。

Skill 目录的 `snapshot.complete` 由公共 registry 拥有，表示本次 provider 发现与 revision 稳定性已证明。暂时不完整不证明某个 Skill 已撤下：已有冻结环境保留最近完整观察或已校验、已接受的本会话 `capability-contracts` 更新所证明的 Skill 视图，不发布未完整证明的新 Skill，也不把这轮 Skill 观察计为新的统计资格。工具与 MCP 继续消费当前 live owner。冷恢复沿同一已接受契约来源保留确证撤下结果，不能由初始快照复活旧 Skill。新环境和显式刷新仍要求完整目录，失败保留旧环境；取消和真实 Host 错误保持原语义。session Skill projection 仅在实际输出变化时调用 registration-scoped `invalidate()`，不因每次父子会话准备使全局 revision 无意义变化。

保存普通设置不改已有会话；`/capabilities refresh` 在公共 maintenance 边界主动同步。`/capabilities list [all|skills|tools|mcp|mcp_tools] [query]` 只读检索当前受管库存，关闭项仍可查、可重新启用；它逐行重述面板同一列的同一陈述，因此能力行分别陈述启用与披露、服务行只陈述启用，某维度记录没写下时写 `automatic`（本会话两列写 `inherit`），不拿别的层的答案替它作答，不把整行压成一个词去替未记录的维度作答。`/capabilities set session|global <id> full|on-demand|closed|automatic|inherit` 明确操作范围：`session` 只改变本会话临时选择，`global` 以真实设置 namespace 和 revision CAS 保存并在同一次操作内更新本会话，不刷新其他已有会话；`inherit` 仅用于取消临时覆盖，`automatic` 撤销该项显式选择。旧组合命令的 MCP server 只接受关闭、恢复自动和取消临时覆盖；新维度命令支持独立可用性与说明规则，重新启用仍保留子项策略。ID 由命令草稿入口编码，输入匹配由正式 `input.hint` 声明。

新环境 `ptc-capability-environment/v4` 冻结总选择 `settings.contextEnabled` 与原子项，即使整组暂停也通过 accepted 计划消息保存来源；新会话和明确刷新使用最新设置。历史 v1-v3 不接受这一新维度，保持原代际解释。

`ptc-capability-environment/v2` 独立记录 `sourceSettings`、`sessionOverrides` 和合并后的 `settings`；恢复校验合并结果、完整方案及精确正文。普通刷新保留临时选择，全局单项快捷操作清除同项旧临时覆盖；命名配置只导出全局源设置。恢复后的首次检索、刷新或修改均从同一已验证输入来源读取，不要求先发一个模型请求。检索不准备方案或制造统计。

已初始化会话在完成所有可失败的 Skill 投影准备后，追加一次正式计划消息；准备或追加失败保留旧完整环境。首轮前不得越过受保护 system head。会话选择由本会话日志中的选择记录（`ptc-capability-selection/v1`）决定，与命令回执无关：回执只报告该记录、待投递方案或保存结果，缺少、失败、未配对或损坏的回执既不能证明也不能撤销一项选择，迟到的 handler 返回值同样不能重新激活它。日志没有任何选择记录时（0.5.4 及更早没有这条记录，只把选择写进方案快照的 `sessionOverrides`），同一条读（`capabilitySelectionOf`）把最新一条以 `user/message` 投递的方案消息的 `sessionOverrides` 折算为该记录的等价形态并返回 `decided`（整选择词与维度规则两种拼写同义，比较按决定而不是拼写），使升级后的首次准备原地恢复那条方案、不从空集重算、不静默撤销旧选择；有记录时仍以记录为准，读到该旧形态后的下一次写入把全部选择重述进新记录。只存在于命令回执提案里的方案不由这条读覆盖：它仍由 `recordedPlan` 在恢复路径读取，首次准备只在该读到的选择与那条方案的选择逐项相等时原地恢复它，否则按该组合自己的 `sourceSettings` 与记录重算，那条提案自己的会话选择因此不被恢复（`docs/panel-concept.md` §9 记作未交付）。命令已组合出尚未 accepted 的方案时，才在 `CommandResult.text` 内保留结构化 pending 提案，由 Host 记录配对的 `command/run` 和成功 `command/done`，冷启动据此恢复该方案消息；该提案就是那条方案消息，其快照携带当时的 `sessionOverrides`：在当前代际它重述已记录的选择，在 0.5.4 及更早它可能就是那个会话选择唯一的载体；无论哪种，它都不新增也不代替记录。只调用导出的 `appendPluginRecord` 仍违反外部插件禁令，故不采用。全局保存只按读取到的 revision 写入 saved 列（`capabilityOverrides`/`capabilityPolicy`），不发布也不重算本会话方案，方案由下一步从记录与其来源设置重算（已有冻结来源的会话仍以该来源为准，直到用户显式刷新），因此保存之后不存在「全局已存、会话失败」的中间状态。历史无方案的会话保持原提供方式，损坏方案通过真实发布边界关闭管理并继续宿主环境，用户可主动刷新。

家族资格顺序和单调观察修订独立于可淘汰样本保存在统计文件的 `families` provenance 中；缺失或损坏的 provenance 不作为有效统计。

正式 `tool/result` 的 `dshPtcPlusCapabilities` 元数据记录 `ptc-capability-evidence/v1` 的方案 digest、展开与使用身份。恢复按原方案和当前 ordered surface 中完整契约及依赖的实际文本去重；计算内展开不等于模型可见，选用说明恢复时在独立预算内补回近期实际使用且已展开的 API 契约及依赖，不补回 Skill 正文，不改变 binding 保留规则。`run_code` 的正式 output presentation metadata 与 `edit_run_code` 的派生结果共同携带证据。

设置清单与面板读的是同一条读：只读 `ptcPlusCapabilities/invoke` 的 `session-catalog` 操作。指名会话时目录取自该会话的 header，供给来自该会话作用域自己的声明（或该会话记录的冻结面）+ 已保存配置 + 该会话自己的日志；未指名时只读 `hostSupply({})`，那是宿主在进程作用域的声明（不含 preset 在 agent 作用域注册的条目），不是任何会话的陈述，因此不充作会话的行集。会话作用域还在时，清单读该作用域的注册表视图、Skill 层与该作用域贡献的 prompt sections；作用域已不在时读会话记录的冻结方案，并因此不需要可刷新的运行时；记录没有冻结过面时（没有方案、方案损坏、组合时没有要求库存——最后一种由记录自己的 `settings` 经 `requiresCapabilityInventory` 判定，与组合时同一个判据）这次读失败并点名缺失的记录，不返回空行集。它不创建模型请求、发布方案或加载 Skill 正文；`inspect` 独立提供冻结会话方案。目录的 `name` 与 `source` 仅为 UI 展示：普通 Tool 说明来自 DSH 注册表，捕获的 MCP owner section 才能证明具体服务器；Skill 来源取公开 provider/source，调用资格取该次供给的声明；冻结面只带 id、name、category 与调用资格，不带 provider/source 桶，所以冷会话的 Skill 行来源写「技能」而不写桶名——一份供给只有一个工作目录，因此不存在需要标注的跨 agent 冲突。它们不进入冻结能力快照、修订或模型说明。某一来源读不出时整次读失败，页面在表格上方给出原始错误与重试并保留上一次成功结果，不把没读到的供给画成空表，也不给条目另加「未确认」这类状态。

设置刷新按钮通过只读 `targets` 获取当前 live 会话身份，并要求明确选择目标；星光菜单从公共 slot 读取当前会话的命令可用性，与绑定编写共用输入框保护，将 `/capabilities refresh` 预填到空输入框并关闭菜单，等待用户发送。设置按钮由 `CapabilityRefreshButton` 通过 authenticated `commands.execute` 直接执行；最终都委托同一 Host 刷新 owner。身份观察不读取或准备冻结方案，管理关闭时仍可主动同步关闭配置。目录/方案重读保持只读。Client 在取消、断线、preset 改变、会话切换、卸载或插件关闭后丢弃迟到回执；停止等待不表示撤销已提交的 Host 效果。

管理默认关闭。设置工作台分为能力配置、提示设置、使用统计、提示文本和配置方案五个页签。能力页挂的是唯一能力面（见 [能力面：概念契约](capability-surface.md)）：设置入口陈述保存·启用与保存·披露两格并可写（服务行的保存·披露格陈述 `各成员自定`，没有控件，§8.1a），本会话两列整列不存在；单项详情弹窗与筛选小窗随该契约删除。搜索、类别与来源筛选仍在页内工具条上，页面默认按供给顺序列出，每个可比较值的列表头都提供升序、降序、回供给顺序三态排序（回执列陈述整句，不参与）。清单逐行勾选多个条目，表头不提供全选；批量设置打开一次性小弹窗，把所选能力行各自被改的维度提交为逐项写入，确认才写入（服务行不参与，它自己的保存格编辑 `mcpServers.<server>`，§8.1a）；会话能力面板在同一入口选定一次维度，确认后对每条已勾选目标提交同一条会话命令，不暂存；默认、类别和来源的持久继承规则使用独立入口。类型切换清除不兼容来源，Tools 与 MCP 工具的浏览入口区分，来源规则只使用已证明的 server 身份。上下文页以能力说明、说明恢复、结果与日志三个固定目的地组织双栏设置，各项开关及额度独立，关闭保留参数；预算预览位于能力说明详情。全部开关使用官方 capsule track、圆形 thumb、尺寸和主题 token。统计页可切换查看所选活跃 PTC 会话的当前工作区或全局使用数、合格家族样本数和覆盖率；不完整窗口或不可用证据保持明确状态。能力说明的预算预览从该会话当前 SDK/Skill/MCP 清单、已保存配置与实际统计调用同一纯方案 owner，显示完整/按需/关闭选择、原因、正文大小、包含共享依赖的总预算和超额。观察通过 `allocation` RPC，使用只读 assembly observation，不准备或发布会话方案，不登记样本、读取 Skill 正文、调用工具或请求模型；目标退出和迟到回复会失效。配置序列化由 Client 完成，用户无需编写 JSON；最低样本数超过窗口等无效输入不提交。已有配置中暂不可用的能力选择保留并可撤销。配置页以左侧命名配置库、右侧所选详情组织；唯一保存当前设置、导入和更多动作在列表下方，会话观察另行展开，与已保存配置分开。`capabilityProfiles` 的 `ptc-capability-profiles/v1` 文档保存最多 100 份具名能力设置，支持命名保存、重命名、删除、文件导入导出和一次公共设置 mutation 切换；导入不自动应用，同名导入生成新名称。会话观察同时提供源设置，用户可读取并命名保存，不复制统计证据或计算状态。切换配置不刷新旧会话，明确选定目标的正式 Host 命令才提交刷新；原冻结方案继续展示选择、原因、覆盖率、显式超额和待刷新状态。格式与边界见 [ADR 0040](adr/0040-separate-capability-configurations-from-session-observations.md)。有界 `capabilities.search` 的原接口保持兼容，见[能力投影](capability-projection.md)。大结果和日志使用宿主 spill 服务保留完整展示，存储失败回退原文；canonical 程序值不受预览影响。

组件和接入证据见 `test/capability-plan.test.js`、`test/capability-statistics.test.js`、`test/capability-environment.test.js`、`test/plugin-program-bindings.test.js`、`test/context-result-preview.test.js` 与能力设置 Client 用例。固定 7 项普通任务加 1 项 canary 的 Command Goat / DeepSeek V4.1 Flash 付费配对已运行并完成 16 份盲评。插件侧盲评总分为 correctness 22/24、efficiency 15/24、clarity 21/24，原生基线为 22/24、10/24、21/24；机器验收因原生基线 3 项超过预设调用或 token 上限而阻止。全任务 traffic 为插件 132,332、基线 340,712（普通任务排除 canary 后为 122,933 对 325,862），这是一轮单 replicate 结果，不构成普遍收益保证。

历史 MCP server 总开关复用手动覆盖中的 `mcpServers.<server>: closed` 配置身份，工具和资源仍保留其单项配置。纯方案先应用已捕获的 `mcpServer` 归属关闭，再处理子项披露；目录、共享资源 server 枚举和编译成员同取该冻结结果。来源以公共 server 目录/归属段与已注册限定命名空间为证，重叠且无法区分的命名空间在刷新前报告缺少准确 owner，不猜测删除。原有无归属字段的历史库存按原单项语义恢复。目录观察使用 `ptcPlusCapabilityObservation` 的公共 assembly context，直接 surface owner 在该只读路径跳过会话准备和绑定输入加载。
