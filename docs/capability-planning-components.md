# 能力方案与统计组件

本文描述方案、统计及其会话接入。产品目标由 [ADR 0038](adr/0038-freeze-session-capability-plans.md) 拥有，执行证据见[覆盖矩阵](context-public-interface-coverage.md)。`internal/capability-environment.js` 将纯方案用于首轮目录、冻结环境、编译前成员投影、刷新和恢复；`internal/capability-statistics-store.js` 将真实家族事实接入锁定的原子存储。

## 方案计算

`internal/capability-plan.js` 导出 `createCapabilityPlan(input)`，返回递归冻结的 `ptc-capability-plan/v2` 读模型；显式 `schema: "ptc-capability-plan/v1"` 仅供历史方案按原代际重算。

| 输入 | 契约 |
| --- | --- |
| `enabled`、`configurationRevision` | 独立管理开关和配置修订；关闭时条目选择为 `host`，不修改宿主 |
| `capabilities` | owner 提供的准确 `{id, revision, category, contract, navigation?, dependencies?}`；依赖为 `{id, text}` |
| `manual` | 可编辑的 `baseline: string[]` 与 `overrides: { [id]: "full" \| "on-demand" \| "closed" }`；显式项始终优先 |
| `statistics` | `enabled`、正整数 `windowSize`、`minimumSamples` 和 `[0,1]` 范围的 `fullThreshold` |
| `coverage` | 按准确能力 ID 索引的 `{revision, workspace, global}`；覆盖证据形状由下述归约组件提供 |
| `budgetBytes`、`directoryBudgetBytes`、`navigationText` | 完整契约和目录分别按 UTF-8 字节计量；固定发现指引必须在目录预算内 |

受管类别为 `tool`、`skill`、`resource`、`resource-template`、`task`；`language`、`node`、`repl`、`ptc-plus`、`global-binding` 保持范围外。适配器必须提供真实来源身份和完整契约；本组件不从工具名字猜测来源，也不加载 Skill 正文。

统计不足时使用基线；工作区样本足够时优先采用，工作区不足时才参考全局，不将重叠家族相加。无效设置或不可用证据不撤销手动选择。纯描述或 schema 的修订继承尚未由公共适配器证明，因此当前不同 `revision` 隔离。

排序综合覆盖率和契约长度，采用确定性的 ID 裁决。预算计入实际 `catalogText` 的标题、完整契约、分隔和去重后的公共依赖。显式完整条目可超预算，`budgets.overageBytes` 明确报告；自动项不截断契约。v2 目录保留固定检索指引，在独立预算内按 ID 加入可容纳的非关闭、非显式完整能力导航，自动完整或按需选择变化不改变目录。未逐项列名的能力仍可通过检索发现。冲突的共享依赖不能合并成一个貌似完整的契约。

v2 完整契约依次排列显式完整、已选基线、其余自动完整三组，组内按 ID 排列；每组先放尚未提供的共享依赖，全目录仅提供一次。统计用于分配，不用于重排已选条目。目录先于完整契约，使统计分配变化尽量保留导航与显式完整契约前缀；代价是自动完整项可能另占一条有界导航。统计数字、配置 digest 和会话身份仅在来源元数据中，不进入说明正文。v1 保留原来的依赖优先、契约按 ID、目录仅列按需项的渲染。

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

新的 `ptc-capability-environment/v2` 源消息记录设置、完整 owner inventory、统计依据与派生方案，digest 和对应代际重算共同校验恢复；历史 v1 保留其原始正文与排序。首次准备在模型请求之前完成，只产生待接受方案；尚无已提交任务历史时，通过公共 `agent/pre-step` 将新方案放在本次接受消息批次的任务之前，由 Host 在受保护 system head 之后提交一次。已有历史不重排，拒绝、取消或请求准备失败不构成方案恢复证据。已提交方案不重复追加，被压缩的正文不因原始日志仍有记录而复活。

工具完整契约与程序检索元数据来自公共 `ToolRuntime.sdkSchemas(scope)`，包含参数及返回值 schema；输出 schema 也参与修订身份和恢复比较。新 cell 的检索与 inspect 从同一份当前 SDK 快照派生结构化 schema、签名、依赖及修订，不将冻结方案中的旧签名覆盖到新返回值类型上；冻结的是启用与披露选择。顶层模型工具 schema、准入与调用规范化继续使用独立的 `ToolRuntime.schemas(scope)`，不向模型工具定义追加 SDK 输出字段。

保存设置不改已有会话；`/capabilities refresh` 在已初始化会话的公共 maintenance 边界以单次消息追加提交新方案及通知。消息追加失败或取消保留旧环境。尚未接受首轮的会话刷新后仍待首个 accepted step，命令回执明确说明通知待接受，不声称已记录模型通知。历史没有方案的会话保留原提供方式，损坏方案通过同一发布边界通知关闭管理并继续宿主环境，用户可主动刷新。

家族资格顺序和单调观察修订独立于可淘汰样本保存在统计文件的 `families` provenance 中；缺失或损坏的 provenance 不作为有效统计。

正式 `tool/result` 的 `dshPtcPlusCapabilities` 元数据记录 `ptc-capability-evidence/v1` 的方案 digest、展开与使用身份。恢复按原方案和当前 ordered surface 中完整契约及依赖的实际文本去重；计算内展开不等于模型可见，在独立预算内补回近期实际使用且已展开的 API 契约及依赖，不补回 Skill 正文，不改变 binding 保留规则。`run_code` 的正式 output presentation metadata 与 `edit_run_code` 的派生结果共同携带证据。

管理默认关闭。设置提供基线与显式选择的 JSON 草稿、独立统计输入和预算，展示有效方案、原因、覆盖率、显式超额和待刷新状态。有界 `capabilities.search` 的原接口保持兼容，见[能力投影](capability-projection.md)。大结果和日志使用宿主 spill 服务保留完整展示，存储失败回退原文；canonical 程序值不受预览影响。

组件和接入证据见 `test/capability-plan.test.js`、`test/capability-statistics.test.js`、`test/capability-environment.test.js`、`test/plugin-program-bindings.test.js`、`test/context-result-preview.test.js` 与能力设置 Client 用例。固定 7 项普通任务加 1 项 canary 的 Command Goat / DeepSeek V4.1 Flash 付费配对已运行并完成 16 份盲评。插件侧盲评总分为 correctness 22/24、efficiency 15/24、clarity 21/24，原生基线为 22/24、10/24、21/24；机器验收因原生基线 3 项超过预设调用或 token 上限而阻止。全任务 traffic 为插件 132,332、基线 340,712（普通任务排除 canary 后为 122,933 对 325,862），这是一轮单 replicate 结果，不构成普遍收益保证。
