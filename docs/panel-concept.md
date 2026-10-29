# 能力与上下文面板：概念文档

## 0. 状态：设计意图与已交付范围

**这是一份设计文档，不是已发布契约。** 它描述面板应成为的形状；与代码冲突处一律以代码为准，本文中相应的句子标注为「未来工作」。

**0.5.4 交付的形状**（下列各条与当前代码一致；版本号只标明这些形状随哪个版本交付，不构成兼容性判断，也不描述发布通道的状态）

- **读不需要活会话。** `describeSessionCatalog` 找不到可刷新 agent 时不再失败，仍从绑定存储与会话日志给出绑定组，并把能力清单报成「未观察」（`internal/capability-environment.js:1445-1461`）。
- **「未观察」与「空」分开。** `live:false` + `entries:[]` 配 `capabilities.quick.notObserved` 文案，客户端不画空表（`src/client-capabilities-view.js:1545`、`:2038`、`src/client-copy.js:172`）。
- **绑定行 `{id, name, enabled, declined}`。** `enabled` 来自 `list()` 的条目，`declined` 来自本会话日志的最新取用记录；「本会话使用」就是 `declined` 读出来的同一个比特，不另发 `adopted`（`internal/capability-environment.js:531-535`）。
- **绑定行三种状态：** 本会话使用、本会话不使用、全局停用（`src/client-capabilities-view.js:1877`）。
- **绑定组缺席有两个原因：** `supply-off`（`userBindingsEnabled` 关闭）与 `unreadable`（`list()` 抛错、返回损坏文档，或本会话的取用记录读不出——日志读失败同样出不了行），各有一句文案（`internal/capability-environment.js:509`、`:515`、`:521-526`）。

**尚未交付（本文其余部分，按未来工作阅读）**

- `ptc-capability-session-catalog/v2` 与 `rows` 行模型、`capabilities:null` 契约：当前响应是 `/v1`，用 `entries` + `bindings`／`bindingsReason`。
- 删除 `subject.live`：`live` 仍在响应里，并被客户端读取（`src/client-capabilities-view.js:1545`）。
- `readUserBindings()` 返回 `{enabled, entries}`：当前注入的是 `userBindings.list()`（返回 `{revision, path, entries}`），插件开关由环境自己读 `currentConfig.userBindingsEnabled`。
- 行模型里的 `supply`／`choice`／`control{editable,blockedBy}` 与 `blockedBy` 枚举：当前行只有 `{id, name, enabled, declined}`；`command-unlisted` 由客户端从 `/binding` 命令可用性派生，不来自响应字段。
- `SessionCatalogReadFailure`、逐行 `editable`、`rows.bindings:null` 等 §4、§5、§8 的形状。

§1–§8 的行号按编写设计时的版本记录，用来指出当时依据的代码位置；它们不是当前候选的定位依据。当前代码的引用只由 §0 维护。

## 1. 面板是什么

面板回答**这个会话看到什么**：给定 `sessionId`，列出它取用的已供给绑定条目与受管能力，每个结论落在「已保存／已投递／已证明可用」某层。它不是能力目录浏览器（`describeCatalog` `capability-environment.js:1405`、`observeAllocation` `:1386`），也不是 REPL 控制台（`CONTEXT.md:53`）。

## 2. 不变式

- **I1 读不需要 agent** 唯一生产者是新增的 `readSessionCatalog({sessionId}, signal)`（§8；未来工作：当前由 `describeSessionCatalog` 的未观察分支承担，见 §0），只读日志、绑定存储与配置。证伪：无活 agent 时重读，行数与控件不变。
- **I2 保存不代答执行** `saved`／`temporary`／`effective` 只来自配置与方案记录；cell 结果只进 `usability`。
- **I3 供给边界每 kind 一条** 绑定行由条目 `enabled` 决定（§4）；能力行没有 agent-free 供给边界——host 是否仍声明它只由写入时的 `change()` `:1010` 判定，全局 `closed` 也可被会话改成 `enabled`（`sessionCapabilitySettings` `:91-98`），故不预判。
- **I4 三件事不互答** `saved`／`delivery`／`usability` 各有唯一来源，只在能承载它的行上出现（§4）；`saved:true` 不得显示为已投递或可用。
- **I5 没有整块不可用** `scope.*`／`plan` 只决定该层文案；行集存在时行区与控件仍在，写只由逐行 `control.editable` 收窄。
- **I6 字段要有 agent-free 生产者** 产不出就删（文末清单）。

## 3. 读取契约（v2 契约：未发布，见 §0）

`readSessionCatalog` 只调三处：`readSessionLog({id: sessionId}, sessionQuery)`（`session-events.js:49-77`）、**外部传入的 `readUserBindings()`**、`capabilityConfiguration(currentConfig)`（`capability-environment.js:118-133`）。

`readUserBindings` 必须新增：`createCapabilityEnvironment` 的 `store` 是 `CapabilityStatisticsStore`（`index.js:377-382`），够不到绑定存储；后者由 `createUserBindingsOwner` 私有（`user-bindings-owner.js:217`）。故由该 owner 暴露只读 `readUserBindings()`，返回 `{enabled, entries:[{id, enabled}], error?}`：`enabled` 是插件作用域的 `userBindingsEnabled`（`index.js:366` → `:222`，非条目级）；条目只经 `store.list()`（`user-bindings-store.js:150-153`，先 `load()`），**不经 `describe()`**——它在首次 `load()` 前给 `entries:[]` 且无 `error`（`:119`、`:141-153`），会被读成「没有条目」。注入点 `index.js:364-382` → `:444`；只读，写入口仍是 `mutate`（`user-bindings-store.js:177-219`）。（未来工作：当前注入的是 `userBindings.list()`，返回 `{revision, path, entries}`；`enabled` 不由它携带，见 §0。）

它不调 `assemble`（`:1488`）、`inventory`（`:604`）、`observeHistory`（`:450`）、`prepare` 或 `session.append`；`canRefresh`（`:663`）不是前置。活输入与会话侧替代：

| 活输入 | 会话侧生产者 |
| --- | --- |
| assembly sections（`:927`）| `sourcePlan(recordedPlan(events, id), id)`（`:449-470` → `:135-197`）冻结的 `snapshot.capabilities`／`snapshot.plan` |
| `toolSchemasForAgent`／`observeSkills`（`:541`、`:558`）| 同一 `snapshot.capabilities`（`toolCapability` `:350-356`、`skillCapability` `:367-375`）|
| `observeHistory(agent)`（`:442-448`）| `readSessionLog(...).events` |
| 本会话绑定取用 | `projectSessionLog({session:{events}})`（`session-log-view.js:306-332`）→ `readRuntimeMessage`（`runtime-messages.js:112-123`）→ `latestBindingAdoption`（`binding-adoption.js:99-113`）|

| 顶层字段 | 生产者 |
| --- | --- |
| `schema` | 恒 `ptc-capability-session-catalog/v2`；客户端 `:1520` 同步（未发布：当前为 `/v1`，客户端 `:1537`）|
| `subject` | 只有 `{sessionId}`：无 agent-free 生产者能表示活会话，`live` 已删（未发布：`live` 仍在响应中并被客户端读取，`:1540`）|
| `scope.log` | `observed`│`unreadable`（`session-events.js:51-56` 抛错即后者）|
| `scope.supply` | `observed`│`disabled`│`unreadable`：`disabled` 来自 `userBindingsEnabled`（`index.js:366` → `user-bindings-owner.js:222`，同闸 `list()` `:1024`、`snapshotForAgent()` `:1018`、`/binding` 注册 `:753`）；`unreadable` 只由 `describe()` 的 `error`（`:146`）判定 |
| `plan` | `recorded`（`:449-470` 找到方案且 `:135-197` 通过）│`absent`（没找到）│`damaged`（`sourcePlan` 在 `:152`、`:162`、`:174`、`:194` 抛错）│`unknown`（日志不可读）|
| `management` | `managed`│`paused`│`off`│`unknown`（`:943-946`；`plan:'absent'` 时只能 `unknown`）|
| `savedSettings` | `{enabled, contextEnabled}`（`:1379-1384`，只读配置）|
| `rows` | `{bindings, capabilities}`，各是行数组或 `null`。`capabilities` 只在「方案已记录且确实清点过」时是数组（`requiresCapabilityInventory(snapshot.settings)` `:317-318`、`:844`）；`absent`／`damaged`／`scope.log:'unreadable'`／记录但未清点 → `null`。`bindings:null` 当 `scope.supply` 非 `observed` |

## 4. 行模型（v2 行模型：未发布，见 §0）

**绑定行** `id, kind:'binding', supply, choice, control{editable, blockedBy}`（未来工作：当前行只有 `{id, name, enabled, declined}`；`enabled===false` 即「全局停用」）

| 字段 | 生产者 |
| --- | --- |
| `supply` | `readUserBindings().entries` 含该条且 `enabled===true` → `offered`，否则 `withheld`（`entryView` 保留 `enabled`：`user-bindings-store.js:64-77`）。写守卫只用启用条目（`:162-165` → `user-bindings.js:204`），`withheld` 行写入必被 `:347-349` 拒（"does not supply … cannot revive"）|
| `choice` | `declinedBindingEntries(latestBindingAdoption(ptcMessages))`（`binding-adoption.js:99-121`）含该 id → `skip`，否则 `use`；`scope.log:'unreadable'` → `null`（§5）|
| `control` | 有理由时 `editable:false` + `blockedBy`（§6，同时成立取第一个）；无理由时 `editable:true`、`blockedBy:null` |

**`use` 不陈述历史**：未声明与使用同态（`binding-adoption.js:8-13`），显式 `use` 只删 `declined` 里的 id（`:124-130`）。

**能力行** `id, kind:'capability', category, name, description, mcpServer?, mcpServerCandidates?, enclosingClosure‡, saved, savedRule?, temporary, temporaryRule?, effective, sourceRule?, sourceDimensions?, effectiveDimensions?, delivery†, usability†, pendingRefresh, control`（`?` 逐字段有因，见 `mcpServer`、rules 两行；`†` 只在非 `category:'server'` 行，`‡` 只在 server 行且恒 boolean——行只由记录方案生成，`:971` 的 `state===undefined` 不可达）

| 字段 | 生产者 |
| --- | --- |
| `category`／`name` | 记录里的 `category`；`name` 取 `schema.name`／`selector.name`／`selector.server`（`:352`、`:374`、`:584`），server 行取 server 名（`:979`）|
| `description` | `snapshot.capabilities[].description`（`:356`、`:374`、`:583`），server 行 `MCP server <name>`（`:979`）；客户端 `:1593`、`:1929` |
| `mcpServer`／`mcpServerCandidates` | `:962` 无条件转发 `capability.mcpServer`：唯一归属见 `:547`（`mcp__<server>__` 前缀）、`:578`，多 server 只记 `mcpServerCandidates`（`:548`）；与 policy 无关；server 聚合行不带它，以 `name` 标识（`:979`）|
| `saved`＋`savedRule` | `manual.overrides[id] ?? 'automatic'`（`:963`），policy 拼写按 `item:<id>` 补齐（`:1324-1327`）|
| `temporary`＋`temporaryRule` | `sessionOverrides[id]`（`:965`）：对象形（按维度）→ `inherit`，真值在 `temporaryRule`（`:955` → `:321-325`）；字符串形（旧拼写，可与 policy 共存 `:101-113`、`:842`）→ 原值 |
| `savedRule?`／`sourceRule?`／`sourceDimensions?`／`effectiveDimensions?`／`temporaryRule?` | `dimensions()`（`:947-959`）：保存配置与方案都无 policy 时 `:949` 提前返回；否则 `temporaryRule` 恒有（`:955`），`savedRule`／`sourceRule`＋`sourceDimensions`／`effectiveDimensions` 分别随保存配置 policy（`:953`）、方案 `sourceSettings.policy`（`:950`、`:954`）、方案 `settings.policy`（`:956`）|
| `effective` | 方案条目 `selection`（`:966-968`），`planManaged` 见 `:943` |
| `delivery`† | 不在 `plan.entries` 或 `selection:'closed'` → `absent`（`:1331-1333`），已提交 → `delivered`；`pending` 是内存态（`pendingCommand` `:873-875`），日志读无生产者 |
| `usability`† | `tool/result` 的 `meta.dshPtcPlusCapabilities`（`EVIDENCE_KEY` `:22-23`）满足 `schema`、`planDigest`、id ∈ `used` → `proven`（写 `:1287-1288`，读回 `:672-675`，判 `:1343`）；`restoreEvidence` 的 `supplied` 门槛（`:676`）属恢复预算 |
| `pendingRefresh` | `digest(capabilityConfiguration(currentConfig)) !== digest(snapshot.sourceSettings ?? snapshot.settings)`（`:1353`）|
| `enclosingClosure` | server 行：有 policy 时 `policy.mcpServers[server].availability==='closed'`，否则 `manual.overrides['mcpServers.'+server]==='closed'`（`:971-973`）|

**server 行是聚合行**：合成于 `:969-984`，不进 `plan.entries`（`capability-plan.js:152-153`）、不在 `snapshot.capabilities`（`:676`），故 `delivery`／`usability` 只能恒为同一值（`absent`／`unproven` 会把「成员已投递」读成「未投递」）；该 kind 只答成员是否被关闭：`enclosingClosure`＋`effective`。

**已保存 ≠ 本会话在跑。** `saved:true`＋`pendingRefresh:true` 才是「还没换上」（`CONTEXT.md:43,47`）；`saved:true`＋`delivery:'delivered'` 只说明方案已投递。

## 5. 行处境（按 v2 行模型描述：未发布，见 §0）

| 处境 | 取值 |
| --- | --- |
| 记录损坏 | `plan:'damaged'` + `rows.capabilities:null` + `SessionCatalogReadFailure`：行集未知 |
| 无方案记录 | `plan:'absent'` + `rows.capabilities:null` + 「本会话没有能力方案记录」+ `management:'unknown'`：从未记录方案，`:869` 的 `message:undefined` 后重启，进程态由 `:1432` 清 |
| 未清点能力 | `plan:'recorded'` 而 `requiresCapabilityInventory(snapshot.settings)` 为假（`:317-318`、`:844`）→ `rows.capabilities:null` + 「能力管理未启用，本会话未清点」：默认配置（`config-spec.js:21`）下会话仍看到整个 host 面 |
| 全局未供给（绑定） | `supply:'withheld'` + `editable:false` + `blockedBy:'entry-disabled'` |
| 供给关闭（绑定） | `scope.supply:'disabled'` + `rows.bindings:null` + 「全局绑定未启用」：`userBindingsEnabled:false`（`index.js:366`）下 `/binding` 不注册（`user-bindings-owner.js:753`）、worker 无目录（`:1019`）；已启用条目不得读成 `offered`／`editable` |
| 已保存未刷新（能力） | `saved` 有值 + `pendingRefresh:true`，`effective` 仍是旧方案 |
| 已投递未证明 | `delivery:'delivered'` + `usability:'unproven'` |
| 日志不可读 | `scope.log:'unreadable'` + `plan:'unknown'` + `rows.capabilities:null`；绑定行照常（`supply` 来自存储），`choice:null`——读不出的记录不能替它说「没有否决」（`binding-adoption.js:119-121` 会把 `undefined` 变成空 `declined`）|
| 存储不可读 | `scope.supply:'unreadable'` + `rows.bindings:null`；能力行照常 |

**空态各有生产者，互不串。** 无方案记录、未清点、读不出都是行组 `null`，各配一句；数组只意味着清点过，空数组才是真没有成员；筛选空只在原始行非空时出现（`:1632` → `:2029`）；结论未知另走 `choice:null`。

## 6. 唯一写通道

只有一条：**按行发起与人类输入相同的 DSH 命令事务**，不加写入器。能力行 → `/capabilities set session|global …`：`commands.run`（`src/client-capabilities-view.js:1683`）→ 处理器（`index.js:485-497`）→ `change()`（`:990-1074`）。绑定行 → `/binding use|skip|reset <id>`：`createBindingCommandAvailability`（`src/client-transport.js:192-194`）→ `remote.execute`（`:181`）→ `commandHandler`（`user-bindings-owner.js:702-711`）→ `stateAdoption`（`:339-351`），后者在 `requireEnabled()`（`:340`→`:307-309`）、供给成员校验（`:343`、`:347-349`）与活 `session.append`（`:331-333`）之下；面板不调 `recordAdoption`。

`blockedBy` 只列行上能观察到的值：绑定行 `entry-disabled`（§5）、`command-unlisted`（命令目录没列出 `/binding`：`client-transport.js:97`、`:126`、`:128-133`，`run` 抛错 `:178-180`）；能力行 `management-off`／`paused`（`:943-946`）、`saved-management-off`／`saved-context-off`（`:1438-1439` → 客户端 `:2007-2008`）、`command-unlisted`（`createCommandAccess(ctx,'capabilities')` `src/client.js:180` 给出 `available`，同一 `:128-133`／`:178-180`；§8 让 `:1569` 只留 `!open`，能力行照样渲染，故写在这里）。（未来工作：当前没有 `blockedBy` 字段；客户端从 `/binding` 命令可用性派生禁用与原因，见 §0。）

**不列在 `blockedBy` 的原因。** 行级 `bindings-disabled` 删：供给关断没有行可挂（`rows.bindings:null`），由 `scope.supply:'disabled'` 承担（§3、§5）；`direct-tool-absent`（`:755` → `host-tool-sdk.js:258`）只在 agent-scoped 注册闸判定，读看不到，删；`plan:'damaged'` 无行承载，交给 `SessionCatalogReadFailure`。`available:false` 上游有多种（`:753`、`:755`、`:97`、`:135-143`），面板只报「目录没列出这条命令」；「没有活会话」也不是理由。

## 7. 模型被告知什么

绑定取用由一条 `binding-adoption` 文本承担（`binding-adoption.js:64-66`），能力选择随方案投递，三分陈述只来自 `describeCapabilityProof`（`:1314-1345`）。**只追加、不改前缀**：system 文本与有序 tool schema 字节稳定（`docs/architecture.md:93-102`），追加凭日志与 ordered surface 去重（`:104`，ADR 0010）。

## 8. 改动落点（未发布：本节是待实施清单，见 §0）

服务端：在 `capability-environment.js` 增 `readSessionCatalog`，并在 `createCapabilityEnvironment`（`:444`）加 `readUserBindings` 选项（由 `index.js:364-382` 传入，§3）；它按方案记录判定是否清点过（`requiresCapabilityInventory` `:317-318`，与 `:844` 同一判据），否则默认配置把「未清点」画成空列表；`describeSessionCatalog`（`:1367-1385`）删 `:1370-1373`、`:1375-1378` 后改调它并升 `v2`；`catalogObservation`（`:925-986`）撤出读路径，仍供 `/capabilities list`（`index.js:500`）与回执（`:494`）。**不得复用 `:821-828` 的降级分支**：`:828`→`:759 publishPlan`→`:610 session.append` 会写日志，`:824-825` 把损坏记录画成「管理关闭 + 0 行」；改走 §5 的 `damaged`，只读。`index.js:467` 的 operation 名与 `RPC_CONTRACTS`（`rpc-contract.js:17-21`）不变。

客户端：`load` 读 `payload.rows`，`:1542` 改 `v2` 且允许任一行为 `null`；`:1569` 只留 `!open`（读不停，写由逐行 `blockedBy` 说明）；`:1501` 改 `setRows(null)`；`writesBlocked`（`:1587`）降为逐行 `control.editable`；`:2028` 的 `role="alert"` 换成同位置新增 `SessionCatalogReadFailure`（`role="status"` + 重读按钮），`error` 仍由 `:1531-1532`、`:1542` 产生；行组 `null` 时渲染 §5 选中的那句，不出 `:2029` 文案；`noMatches` 改「没有行符合当前筛选」，只在原始行非空时出现；来源列与筛选改由 `category`＋`mcpServer`／`mcpServerCandidates` 派生（`:1557-1563`、`:1931`），成员列表取 `row.mcpServer===server.name`、server 行以 `name` 定位（`:1945-1962`），`:1933`、`:1950-1952` 不再读已删的 `managementEnabled`／`sessionSourceSelection`（改用顶层 `management`：`managed`／`paused` 即开；以及 `sourceRule`，无则不显示该项）；绑定行写通道复用 `createBindingCommandAvailability`（`src/client.js:369`）。文案进 `settings.ptcPlus` locale（`CONTEXT.md:133`）。

## 9. 非目标

不跨会话检索能力（`describeCatalog`／`observeAllocation` 拥有）；不加写入器、RPC 写操作或第二写通道，不绕过 `store.mutate`；不改冻结语义，同步仍只能 `/capabilities refresh`（`CONTEXT.md:45`）；不展示 worker 内部、prompt 原文或恢复快照；不为绑定加存储或缓存（`binding-adoption.js:26-28`）；不改 REPL 控制台与工作台分工（`CONTEXT.md:53,57`）。

## 本次修订解决的点

**早前六项已解决**（细节在 §3–§6 正文）：删 `origin`；日志不可读时 `choice:null`；能力行补 `command-unlisted` 并删行级 `bindings-disabled`／`direct-tool-absent`／`plan-damaged`；绑定读的注入点；server 行不设 `delivery`／`usability`；`description` 入行模型。

**本轮（第四轮复审）**

| 项 | 改动 | 落到 |
| --- | --- | --- |
| A | `plan:'absent'`、记录但未清点、读不出 → `rows.capabilities:null` 并按因分句；数组只在清点过时存在，`:1918` 文案只给筛选空。默认配置（`config-spec.js:21`）因此读作「未清点」，不把整个 host 面读成「没有能力」 | §3、§5、§8 |
| B | `mcpServer` 改注生产者（`:547`、`:578`、`:962`）并补 `mcpServerCandidates`（`:548`）；`enclosingClosure` 恒 boolean（`:971-973`）；§8 的来源列、筛选、成员列表改由 `category`＋`mcpServer` 派生，`:1950-1952` 不再读已删的 `managementEnabled`／`sessionSourceSelection` | §4、§8 |
| C | 恢复供给级 `scope.supply:'disabled'`（`index.js:366` → `user-bindings-owner.js:222`，同闸 `:753`、`:1019`、`:1025`）＋ `rows.bindings:null` 与原因句；`readUserBindings()` 定死走 `store.list()`（`user-bindings-store.js:150-153`），不走首次 `load()` 前给 `entries:[]` 且无 `error` 的 `describe()`（`:119`） | §3、§5、§6 |
| 小项 | `temporary` 不再声称「有 policy 恒 `inherit`」——旧字符串形原样保留（`:101-113`、`:842`、`:965`）；`delivery:'pending'` 改注 `:873-875` | §4 |

**删除的字段／取值**：`choice.origin`；server 行的 `delivery`／`usability`；行级 `blockedBy` 的 `bindings-disabled`／`direct-tool-absent`／`plan-damaged`；早前已删：`installed`、能力行 `supply`、`applicable`、`source`、`sessionSourceSelection`、`notes[]`、行级 `managementEnabled`、`subject.live`。
