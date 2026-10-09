# 能力方案与统计组件

本文描述方案、统计及其会话接入。产品目标由 [ADR 0038](adr/0038-freeze-session-capability-plans.md) 拥有，执行证据见[覆盖矩阵](context-public-interface-coverage.md)。`internal/capability-environment.js` 将纯方案用于首轮目录、冻结环境、编译前成员投影、刷新和恢复；`internal/capability-statistics-store.js` 将真实家族事实接入锁定的原子存储。

## 方案计算

`internal/capability-plan.js` 导出 `createCapabilityPlan(input)`，返回递归冻结的 `ptc-capability-plan/v1` 读模型。

| 输入 | 契约 |
| --- | --- |
| `enabled`、`configurationRevision` | 独立管理开关和配置修订；关闭时条目选择为 `host`，不修改宿主 |
| `capabilities` | owner 提供的准确 `{id, revision, category, contract, dependencies?}`；依赖为 `{id, text}` |
| `manual` | 可编辑的 `baseline: string[]` 与 `overrides: { [id]: "full" \| "on-demand" \| "closed" }`；显式项始终优先 |
| `statistics` | `enabled`、正整数 `windowSize`、`minimumSamples` 和 `[0,1]` 范围的 `fullThreshold` |
| `coverage` | 按准确能力 ID 索引的 `{revision, workspace, global}`；覆盖证据形状由下述归约组件提供 |
| `budgetBytes`、`directoryBudgetBytes`、`navigationText` | 完整契约和目录分别按 UTF-8 字节计量；固定发现指引必须在目录预算内 |

受管类别为 `tool`、`skill`、`resource`、`resource-template`、`task`；`language`、`node`、`repl`、`ptc-plus`、`global-binding` 保持范围外。适配器必须提供真实来源身份和完整契约；本组件不从工具名字猜测来源，也不加载 Skill 正文。Skill 库存、完整契约、检索与设置来源元数据保留 owner 的 `modelInvocable`/`userInvocable`：模型可调用项说明 `tools.skill({name})`，用户专用项说明 `/name` 用户入口；两者关闭的项不进入可用目录。披露不能扩大加载权限。

统计不足时使用基线；工作区样本足够时优先采用，工作区不足时才参考全局，不将重叠家族相加。无效设置或不可用证据不撤销手动选择。纯描述或 schema 的修订继承尚未由公共适配器证明，因此当前不同 `revision` 隔离。

排序综合覆盖率和契约长度，采用确定性的 ID 裁决。预算计入实际 `catalogText` 的标题、完整契约、分隔和去重后的公共依赖。显式完整条目可超预算，`budgets.overageBytes` 明确报告；自动项不截断契约。目录保留固定检索指引，在独立预算内提供当前非关闭能力类别的简短用途导航（工具、Skill、MCP 资源/模板及任务），不复制单项完整描述或按 ID 抽取长尾条目。自动完整或按需选择变化不改变目录；未逐项列名的能力仍可通过检索发现。冲突的共享依赖不能合并成一个貌似完整的契约。

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

每个可用观察包含 `workspaceId`、能力 `id/revision/category`、当时的 `disclosure` 和 `planRevision`；只允许真实可用的 `full` 或 `on-demand`，关闭和未提供项不能进入分母。使用证据分别为工具/任务的 `host-execution-result`、Skill 的 `skill-body-accepted`、资源/模板的 `resource-access`。查询、cold replay 和权限阻止的请求不接受为使用证据。工具使用表示真实调用进入 DSH 的 around execution 管线并获得正式规范结果（包括失败和合法 wrapper 提供的结果）；不证明注册 body 或外部效果执行。失败或已准入的取消结果独立保留，明确的 dispatch 前取消、未知工具及未准入调用不算使用。

同一家族、能力、范围只贡献一个使用位。工作区观察和全局观察分别归约，跨工作区后代不增加全局权重。每项能力和范围使用最近 N 个合格家族；续接修改已有身份的使用事实，不改变原资格顺序。正在运行或结算未知的家族不形成负样本。淘汰前沿阻止旧观察重读后重新进入已有窗口；不使用自然时间衰减。

`capabilityCoverage` 返回样本量、使用量、窗口和覆盖率；没有样本时覆盖率为 `null`。窗口已淘汰旧证据后，近期家族恢复为运行中或结算未知，若剩余已结算样本不足 N，状态为 `incomplete-window`，样本量、使用量和覆盖率均为 `null`；不能把无法重建的窗口子集用于自动分配。再次具有 N 个已结算样本时恢复有效。超过显式容量上限后状态为 `capacity-exceeded`，覆盖依据为 `null`。这两种不可用证据均回退手动基线；未淘汰证据的正常冷启动仍可返回实际样本数。结构损坏由验证器拒绝，存储适配器将读取失败转为统计不可用诊断，保留手动配置并继续合法计算。

组件状态是可验证的 JSON 数据。存储适配器使用宿主 home 路径下的 `ptc-plus/capability-statistics.json`，以 `withFileLock` 和 `writeFileAtomic` 串行化跨实例更新，仅保存身份、资格、使用和结算元数据。续接修订原家族使用位，资格顺序保持不变。公开家族 census 不完整、未进入 step 或 turn 非正常完成时不产生负样本。

## 会话接入

`ptc-capability-environment/v1` 源消息记录设置、完整 owner inventory、统计依据与派生方案，digest、方案重算与精确正文共同校验恢复。新方案显式记录当前 `navigationText`；缺少该字段的既存 v1 方案按其原固定导航重算和核验，升级不重写历史正文。首次准备在模型请求之前完成，只产生待接受方案；尚无已提交任务历史时，通过公共 `agent/pre-step` 将新方案放在本次接受消息批次的任务之前，由 Host 在受保护 system head 之后提交一次。已有历史不重排，拒绝、取消或请求准备失败不构成方案恢复证据。已提交方案不重复追加，被压缩的正文不因原始日志仍有记录而复活。

宿主 prompt section 的空字符串或纯空白说明不形成契约依赖，但其 section 身份仍可证明 MCP server 归属。工具签名和资源契约保持可发现；非空说明原样保留并去重，非字符串等无效依赖仍由方案校验拒绝。

工具完整契约与程序检索元数据来自公共 `ToolRuntime.schemas(scope)` 与 `ToolRuntime.get(name, scope).output.schema` 的准确 JSON 快照，包含参数及返回值 schema；输出 schema 也参与修订身份和恢复比较。新 cell 的检索与 inspect 从同一份当前 SDK 快照派生结构化 schema、签名、依赖及修订，不将冻结方案中的旧签名覆盖到新返回值类型上；冻结的是启用与披露选择。每次准备与接受步骤重新读取 live owner 契约；同名工具的参数、输出或说明依赖变化，以及 Skill 调用资格变化或能力移除，以 `capability-contracts` 的 `ptc-capability-contracts/v1` 来源消息更新当前效力。消息记录原方案 digest、当前修订向量、变化项和当前完整说明超额，digest 与精确正文共同校验；不修改原方案。仍选完整的项提供完整新契约和去重依赖，按需项要求检索当前契约，移除项明确撤销。投递经 accepted step，拒绝与取消不提交；未变视图不重复追加，恢复按正式可见消息协调。实际可用和使用统计采用当时的契约修订，已准入调用保留捕获时的观察身份。顶层模型工具 schema、准入与调用规范化继续使用独立的 `ToolRuntime.schemas(scope)`，不向模型工具定义追加 SDK 输出字段。

保存普通设置不改已有会话；`/capabilities refresh` 在公共 maintenance 边界主动同步。`/capabilities list [all|skills|tools|mcp|mcp_tools] [query]` 只读检索当前受管库存，关闭项仍可查、可重新启用。`/capabilities set session|global <id> full|on-demand|closed|automatic|inherit` 明确操作范围：`session` 只改变本会话临时选择，`global` 以真实设置 namespace 和 revision CAS 保存并在同一次操作内更新本会话，不刷新其他已有会话；`inherit` 仅用于取消临时覆盖，`automatic` 撤销该项显式选择。MCP server 只接受关闭、恢复自动和取消临时覆盖，重新启用仍保留子项策略。ID 由命令草稿入口编码，输入匹配由正式 `input.hint` 声明。

`ptc-capability-environment/v2` 独立记录 `sourceSettings`、`sessionOverrides` 和合并后的 `settings`；恢复校验合并结果、完整方案及精确正文。普通刷新保留临时选择，全局单项快捷操作清除同项旧临时覆盖；命名配置只导出全局源设置。恢复后的首次检索、刷新或修改均从同一已验证输入来源读取，不要求先发一个模型请求。检索不准备方案或制造统计。

已初始化会话在完成所有可失败的 Skill 投影准备后，追加一次正式计划消息；准备或追加失败保留旧完整环境。首轮前不得越过受保护 system head；实际命令回执在 `CommandResult.text` 内保留结构化 pending 提案，由 Host 记录配对的 `command/run` 和成功 `command/done`，首次 accepted step 才将其通知投递给模型。取消、失败、缺少配对或损坏回执不能证明临时选择，也不能由迟到的 handler 返回值重新激活。只调用导出的 `appendPluginRecord` 仍违反外部插件禁令，故不采用。全局保存成功而后续读取或会话发布失败时报告 saved-only 及原因，不回滚已经确认的全局写入，不假称本会话已更新。历史无方案的会话保持原提供方式，损坏方案通过真实发布边界关闭管理并继续宿主环境，用户可主动刷新。

家族资格顺序和单调观察修订独立于可淘汰样本保存在统计文件的 `families` provenance 中；缺失或损坏的 provenance 不作为有效统计。

正式 `tool/result` 的 `dshPtcPlusCapabilities` 元数据记录 `ptc-capability-evidence/v1` 的方案 digest、展开与使用身份。恢复按原方案和当前 ordered surface 中完整契约及依赖的实际文本去重；计算内展开不等于模型可见，在独立预算内补回近期实际使用且已展开的 API 契约及依赖，不补回 Skill 正文，不改变 binding 保留规则。`run_code` 的正式 output presentation metadata 与 `edit_run_code` 的派生结果共同携带证据。

设置清单通过只读 `ptcPlusCapabilities/invoke` 的 `catalog` 操作读取 code agent 当前的公共工具与 Skill inventory，以及已捕获 prompt sections 的 MCP server 目录，不创建模型请求、发布方案或加载 Skill 正文；`inspect` 独立提供冻结会话方案。目录的 `name` 与 `source` 仅为 UI 展示：普通 Tool 说明来自 DSH 注册表，捕获的 MCP owner section 才能证明具体服务器；Skill 来源取公开 provider/source，跨 agent 来源冲突标为未确认。它们不进入冻结能力快照、修订或模型说明。没有可观察 code agent 时展示明确空状态，读取失败保留最后观察结果及已保存选择，可用状态改为未确认。

设置刷新按钮通过只读 `targets` 获取活跃 PTC 会话身份，并要求明确选择目标；星光按钮使用公共 slot 的当前会话。两处共享 `CapabilityRefreshButton` 和 authenticated `commands.execute`，委托同一 Host 刷新 owner。身份观察不读取或准备冻结方案，管理关闭时仍可主动同步关闭配置。目录/方案重读保持只读。Client 在取消、断线、preset 改变、会话切换、卸载或插件关闭后丢弃迟到回执；停止等待不表示撤销已提交的 Host 效果。

管理默认关闭。设置工作台将手动配置、独立统计、预算预览及配置与会话分为四个页签。手动列表区分 Tools、Skills 和按 server 分组的 MCP 工具与资源，以始终展开的筛选栏提供类型、来源、策略、常用与可用状态筛选，以及稳定排序；类型切换会清除不兼容来源，Tools 与 MCP 工具的浏览入口区分；常用星标与披露选择独立，详情区分保存值与所选会话结果。全部开关使用官方 capsule track、圆形 thumb、尺寸和主题 token。统计页同时显示所选活跃 PTC 会话的当前工作区与全局使用数、合格家族样本数和覆盖率；不完整窗口或不可用证据保持明确状态。预算页从该会话当前 SDK/Skill/MCP 清单、已保存配置与实际统计调用同一纯方案 owner，显示完整/按需/关闭选择、原因、正文大小、包含共享依赖的总预算和超额。观察通过 `allocation` RPC，使用只读 assembly observation，不准备或发布会话方案，不登记样本、读取 Skill 正文、调用工具或请求模型；目标退出和迟到回复会失效。配置序列化由 Client 完成，用户无需编写 JSON；最低样本数超过窗口等无效输入不提交。已有配置中暂不可用的能力选择保留并可撤销。配置与会话页把命名配置库和已初始化会话的冻结结果分开。`capabilityProfiles` 的 `ptc-capability-profiles/v1` 文档保存最多 100 份具名能力设置，支持命名保存、重命名、删除、文件导入导出和一次公共设置 mutation 切换；导入不自动应用，同名导入生成新名称。会话观察同时提供源设置，用户可读取并命名保存，不复制统计证据或计算状态。切换配置不刷新旧会话，明确选定目标的正式 Host 命令才提交刷新；原冻结方案继续展示选择、原因、覆盖率、显式超额和待刷新状态。格式与边界见 [ADR 0040](adr/0040-separate-capability-configurations-from-session-observations.md)。有界 `capabilities.search` 的原接口保持兼容，见[能力投影](capability-projection.md)。大结果和日志使用宿主 spill 服务保留完整展示，存储失败回退原文；canonical 程序值不受预览影响。

组件和接入证据见 `test/capability-plan.test.js`、`test/capability-statistics.test.js`、`test/capability-environment.test.js`、`test/plugin-program-bindings.test.js`、`test/context-result-preview.test.js` 与能力设置 Client 用例。固定 7 项普通任务加 1 项 canary 的 Command Goat / DeepSeek V4.1 Flash 付费配对已运行并完成 16 份盲评。插件侧盲评总分为 correctness 22/24、efficiency 15/24、clarity 21/24，原生基线为 22/24、10/24、21/24；机器验收因原生基线 3 项超过预设调用或 token 上限而阻止。全任务 traffic 为插件 132,332、基线 340,712（普通任务排除 canary 后为 122,933 对 325,862），这是一轮单 replicate 结果，不构成普遍收益保证。

MCP server 总开关复用手动覆盖中的 `mcpServers.<server>: closed` 配置身份，工具和资源仍保留其单项配置。纯方案先应用已捕获的 `mcpServer` 归属关闭，再处理子项披露；目录、共享资源 server 枚举和编译成员同取该冻结结果。来源以公共 server 目录/归属段与已注册限定命名空间为证，重叠且无法区分的命名空间在刷新前报告缺少准确 owner，不猜测删除。原有无归属字段的历史库存按原单项语义恢复。目录观察使用 `ptcPlusCapabilityObservation` 的公共 assembly context，直接 surface owner 在该只读路径跳过会话准备和绑定输入加载。
