# 未测量 cell 的恢复修复方案：收益、成本与边界

状态：工作包 A 已在本工作区落地并有可执行证据，B 部分落地（B1/B2/B4），C 维持现有策略，D 未启动；本文其余部分仍是设计依据，不要把未完成项读作当前能力。

已落地：派生未执行结算的可信证明（`internal/session-journal.js` 的共用规范化与两个入口、`internal/edit-transport-owner.js` 的 provenance、`internal/session-journal-recovery.js` 的折叠与编辑目标选择），证据为 `test/session-journal.test.js` 的「proves a deferred edit whose revision never ran without granting it an execution」与 `test/plugin-nested-edit.test.js` 的「an unmeasured derived execution keeps its root provable and leaves the edit target unchanged」（含冷启动重放）。B1 的三条早退用例、B2 的重启不重复计数、B4 的迟到回答隔离同样已有测试。

未完成：B3（当前 cell 被阻断的 `skipped > 0` 变体）与 B5（真实 IPC 分片 fixture）仍按 §5 的方式保留为限制；D 未评估。

## 1. 推荐决策

推荐采用「补全未执行结算的恢复证据 + 补齐关键故障测试 + 保留现有自动回收策略」作为本轮交付。

核心收益是：一次派生 `edit_run_code` 没有进入执行，不再连带否定已经执行完成的外层 root cell；恢复时只跳过没有运行的修订代码。其次，以有针对性的故障注入覆盖通知和阻断分支，不增加第二套调度或恢复机制。

连续两次未测量后的自动回收暂不改变。保留任意 volatile 状态与销毁它所在的 worker 不能同时成立；本轮明确报告这个代价，不用提高阈值、静默重试或旧采样缓存假装解决。需要优先保状态的用户场景列为独立后续决策。

| 工作包 | 本轮决策 | 收益 | 相对成本 | 完成判据 |
| --- | --- | --- | --- | --- |
| A：派生未执行结算 | 必做 | 阻止单次派生失败扩大为 root 恢复资格丢失 | 中；涉及 transport、规范化、恢复和编辑目标选择 | root 可冷恢复，derived 无执行、无 binding、无重复工具效果 |
| B：通知与迟到消息证据 | 必做；复用已有三条早退测试 | 保护恢复说明和请求结算边界 | 低至中；以测试为主 | 覆盖剩余组合；区分完整消息测试与真实 IPC 分片测试 |
| C：volatile 丢失 | 保留当前策略，核验说明和实际状态一致 | 保持自动解卡，避免引入新生命周期策略 | 低 | 丢失范围、恢复范围和重置失败均可观察 |
| D：优先保留 live 状态 | 本轮不默认启用 | 避免仅因重复未测量而丢失 volatile 状态 | 中；需要产品取舍和相应配置契约 | 不再按次数回收，但每次请求仍有界；真实失败仍受管 |

这里的成本是改动责任和验证范围的比较，不是工时承诺。A 的主要成本在恢复与历史兼容证据，B 的主要不确定成本在真实 IPC 分片 fixture。

## 2. 问题与当前边界

### 2.1 已有能力与保留限制

当前普通 cell 在 run 帧发出前无法取得计算基线时，以 `budget-unavailable` 和 `noop` journal 结算。第一次保留 live worker；连续第二次丢弃 worker，只保留可证明的恢复 frontier。transport 明确报告退出、断连或发送失败时，仍按 worker failure 回收。

修复前派生 edit 具有以下断点（第 4、5 项已由工作包 A 消除）：

1. root 已经执行，并收到 `{ accepted: true, scheduled: true, target_call_seq }`。
2. 正式派生 `run_code` 调用进入 Host pipeline，但 run 帧没有发出，得到有效 `noop` journal。
3. 正式 dispatch settlement 已记录该 journal。
4. （修复前的断点）edit transport 拒绝 `noop`，不生成 root 的派生关系证据；现已由工作包 A 消除：transport 只对未测量路由发布该关系，其余 noop 仍被拒绝。
5. （修复前的断点）冷恢复看到接受收据却不能证明它的后续结算，因而不能使用 root 作为恢复证据；现由恢复 owner 用同一派发关系证明未执行结算并保留 root。

当前规则写在 [ADR 0027](adr/0027-run-the-session-kernel-in-a-killable-helper-process.md) 的 Consequences 中关于未测量 cell 的段落（第 49 行，原文以 “An unmeasured cell keeps the state earlier cells proved” 开头），以及 [ADR 0005](adr/0005-temporary-rejected-cell-edit-transport.md) 的 Edit and settlement 段。实际修改点见 [edit transport](../internal/edit-transport-owner.js)、[journal 规范化](../internal/session-journal.js)和[恢复 owner](../internal/session-journal-recovery.js)。

已有测试直接覆盖「收缩后取消」「收缩后连续未测量」「收缩后因回收失败阻断重放」，以及重启后不重复计数（`test/kernel-worker-settlement.test.js` 的「does not recount a recorded contraction after a restart」）。尚需补齐当前 cell 阻断的特定变体与真实 IPC 分片证据。已有迟到回答测试只覆盖完整 `message` 交付边界；迟到的旧回答不会结算新请求这一点已有直接测试。

### 2.2 不可混淆的事实

| 事实 | 可以证明 | 不能证明 |
| --- | --- | --- |
| editor 返回接受收据 | 修订请求被接受并排队 | 修订代码已经执行 |
| 派生调用进入 Host pipeline | 正式执行尝试存在 | worker 收到了 run 帧 |
| 有效 `noop` journal | 该 cell 的源码没有执行，calls/operations 为空 | 同一次请求没有发生恢复收缩或 worker 更换 |
| `discarded` journal | 已按失败路径结算 | 没有外部效果，或等价于 `noop` |
| 内存中 root 仍可用 | 当前 live 状态存在 | 重启后可以重建 |
| transport 未交付完整回答 | 请求没有观察到可用回答 | helper 没写回答、worker 已死亡或没有半包在途 |

修复必须分别处理源码执行、请求结算、worker 生命周期和历史恢复资格。不能用其中一个替代另一个。

## 3. 必须保持的不变量

1. DSH 继续拥有原生工具的验证、权限、调度、取消和结果策略。保留 `run_code`、`edit_run_code` 的真实名称、参数和调用身份。
2. 未发送 run 帧的修订源码不执行，不发布声明、不产生成功修订，也不获得新的可复用 binding。
3. 保留 root 的前提是 root 自己的 journal、派生未执行结算和模型可见来源均可验证。root 原本 volatile、来源不可见或 metadata 缺失时，不能因本修复升级为 durable。
4. 冷恢复仅消费已记录的结果；不重新派发 editor、派生执行或外部工具来补证。
5. 正式 editor 与 derived dispatch 各自只有一个完整 start/settle pair，且位于同一个 root 到最终 result 的窗口内。
6. 只有最终 Host 结果接受了所需 metadata，tentative settlement 才能按现有确认机制完成。被策略移除的证据不能从 raw log 或 sidecar 静默补回。
7. `noop` 不掩盖同次请求携带的 recovery boundaries，也不取消已经发生的 worker 回收或 volatile 状态丢失。
8. 回收失败必须留在 kernel owner，当前 cell 可结算，后续计算保持阻断；不得同时启动替代 helper。
9. 迟到回答不能复活已结算请求，也不能导致补发源码。旧请求的清理不能删除新请求。
10. 新行为不得反向改变历史语言代际、历史顶层 editor 契约或旧 journal 的解释。

语义依据为 [CONTEXT](../CONTEXT.md)、[ADR 0025](adr/0025-use-versioned-logical-binding-identities.md)、[stateful computation proposal](stateful-binding-updates-proposal.md)、[ADR 0005](adr/0005-temporary-rejected-cell-edit-transport.md)和[durability design](durability-design.md)。

## 4. 工作包 A：可信的派生未执行结算

### 4.1 最小表示

优先复用现有 root 私有 `dshPtcPlusPostEdit` 关系及其内嵌 journal：

- `startSeq`：editor 的真实 start。
- `executionStartSeq`：实际派生 `run_code` 尝试的真实 start。
- `rootCallSeq`、`subCallId`：现有因果关系。
- `meta.dshPtcPlusEdit`：实际捕获的目标。
- `meta.dshPtcPlusDerivedRun`：拟运行的完整修订源码及 description。
- `meta.dshPtcPlus.status === 'noop'`：该次尝试没有执行源码。

`DerivedRun` 内的源码不单独证明执行；是否执行由已验证的 journal 结算事实决定。本轮目标是不新增 journal 字段、不引入另一份 append-only 日志，也不新增顶层工具。

实现内可以派生 `executed` / `not-executed` 判别值，供不同消费者处理；该判别只从规范化 journal 产生，不额外写入一份可能与 journal 不一致的布尔值。

### 4.2 规范化与历史兼容

建议提取共享的 target/source/journal 规范化步骤，再提供两个语义明确的入口。以下名称为建议，实施时服从已有命名：

- 历史 `normalizeDerivedEditResult` 继续维持原来的「派生执行」契约，仍拒绝 `noop`。
- 当前 deferred edit 的结算入口允许验证 `noop`，但必须由当前 post-edit 关系校验使用，不能让历史顶层 editor 无条件获得新语义。

不采用全局 `allowNoop` 开关散布到调用点。若选择内部参数，也必须由单一当前 deferred owner 封装，所有读取、比较和快照验证走同一套规则。

对于未执行结算，除了 journal 的封闭字段和 calls/operations 为空，还要求：

1. 有实际 derived dispatch pair，不能只有 root 的一段自称没有运行的 metadata。
2. settle 的 canonical journal 与 root 内嵌 journal 规范化后完全一致。
3. canonical `isError` 与 completion 对齐。对于本次 `budget-unavailable` 场景，必须是 throw/error；不能把成功返回值嫁接到未执行失败上。
4. 目标、修订参数、派生源码和 description 仍由同一次精确变换推导。
5. root journal 中的接受收据及其参数与 editor dispatch 一致。
6. 同样验证 recovery boundaries、用户绑定快照及其他必需关系；可选展示 metadata 不能替代它们。

不要只按错误文案识别未执行，也不要把全部失败都当成 `noop`。已进入 run 帧的失败维持原有 `discarded` 或语义 throw 路径。

### 4.3 transport 与 root 呈现

[edit transport](../internal/edit-transport-owner.js)应在可信 `noop` 路径返回：

- 保持 `edited: false`，因为修订源码没有执行。
- 返回真实错误和 Host 已投影的内容。
- 同时提供有效未执行结算的 provenance，让最终 root result 能证明接受请求的后续结果。
- 按现有最终确认机制释放目标 claim 和 pending acceptance，不引入额外重试。

[runtime bridge](../internal/runtime-bridge-owner.js)继续保留 root 的 canonical value/error，向用户说明「修订未执行」。root 成功不能掩盖派生失败，派生失败也不能伪造 root 本身的异常。

`POST_EDIT_KEY` 关系存在，不再等同于修订已经执行。应检查所有使用 `provenance !== undefined` 的消费者：最终确认可以确认一个可信未执行结算；值展示、binding inventory 和成功修订选择必须按结算类别分支。

### 4.4 恢复与编辑目标选择

[恢复 owner](../internal/session-journal-recovery.js)的处理顺序：

1. 验证 root 自己的 journal、editor 收据和完整关系。
2. 验证派生未执行结算；不满足关系则保持现有 unknown-boundary 收缩。
3. 应用由有效 evidence 证明的 recovery boundaries，不能因 journal 为 `noop` 而遗漏它们。
4. root 按原有 durable/volatile 资格参与恢复。
5. 派生 `noop` 不建立状态 node，不执行修订源码，不推进 binding catalog 或 durable head。
6. cold replay 读取 root 已记录的 editor 收据，不再次发起编辑。

`latestRun`、`successfulRun`、`editableRun` 等选择必须显式忽略派生 `noop` 的拟运行源码。root 按自己已有的普通结算规则参与选择；不要为了保留旧编辑目标而另造一套目标回退规则。接受过修订请求本身不改变编辑源码身份。

### 4.5 materialized timeline 与比较

当前恢复包含事件折叠和 materialized timeline 校验，不能只修 raw event 的一个入口。必须检查：

- post-edit 事实的规范化和重建是否使用同一入口。
- 根结果、publication、settled-results cache 和 timeline snapshot 的相等性校验。
- 内容替换、compaction、fork 和新的冷读取是否仍核验相同的源关系。
- metadata 保留但源码被隐藏、最终 metadata 被删除时，是否仍保守收缩。

只扩展当前 deferred 关系中已存在的 journal status，优先保持现有 journal 数据格式。若闭合 timeline 格式无法无歧义表示新的结算类别，应在其真正的格式 owner 中版本化；不能为了「不升级」接受本来无法区分的历史数据。

## 5. 工作包 B：剩余证据缺口

### 5.1 已有测试直接复用

保留 [settlement tests](../test/kernel-worker-settlement.test.js) 中三条真实收缩后的早退测试。它们分别证明取消、连续未测量和 admission block 路径的通知及剩余 frontier，不另建一套重复 fixture。

新增断言与场景只补现有测试不能证明的部分，优先扩展 `contractOnceThenReplay` 或相邻现有 fixture。对 prototype 的故障注入必须在 `finally` 或测试清理中恢复；清理必须停止该测试拥有的 helper，并把已确认的回收拒绝与真实资源清理分开。

### 5.2 持久化及下一请求

至少补两种连续观察：

1. 一次收缩后早退，将实际返回的 settlement 按 Host 确认路径落入正式 session events，再创建冷 runtime。验证剩余 frontier、边界和通知不被丢弃。
2. 保持同一个 live runtime 再提交一个正常 cell。验证之前的收缩不会被再次计数为新的收缩，已丢失 binding 不会被重新发布。

「通知一次」按同一次收缩和它的报告关系定义，不禁止新 lifecycle 对实际恢复状态作必要说明。测试不能仅计数一段字符串就假定跨重启去重契约已经成立。

### 5.3 当前 cell 被阻断的 `skipped > 0` 变体

目标是验证正常重放循环结束之后，当前 cell 的 `CellAdmissionBlocked` 结算仍附带之前的收缩说明。fixture 要控制以下顺序：

1. 发生可证明的历史回放失败。
2. 进入无法再收缩或收缩失败的 fallback，得到空 frontier 和 `skipped > 0`。
3. 存在被 kernel owner 记录的回收失败。
4. 当前 cell 在 `prepareWorker()` 被拒绝，而不是又进入重放循环的提前返回。

优先从已有 kernel/client seam 注入故障，断言真实调用顺序；不要只手动向结果中塞 `PTC-R002`。若可达性分析证明该组合在现有 owner 下不可能发生，应记录最小反证并清理不成立的测试要求，不能为了覆盖率构造产品永远到不了的状态。

验收包括：当前 cell 没有 run 帧、结果正常结算、准确的一份收缩说明、持久化边界和实际 frontier 一致、回收失败仍阻止后续计算、owned helper 数量不增加。

### 5.4 transport 的两层证据

第一层是插件对完整消息交付的契约，复用 [transport tests](../test/isolated-worker.test.js)：

- 到判定点没有完整回答，请求以 `UNANSWERED_SAMPLE_CODE` 失败。
- 稍后同一请求的完整回答只更新缓存，已结算结果保持失败。
- 已删除的 pending entry 不重新出现。
- 再发起新请求时，旧 id 的回答不能结算新请求，也不能清除新请求的 timer/immediate。

第二层是真实 IPC 分片 fixture：

- 使用隔离的测试 peer 和真实字节通道，控制一个消息只到达前半部分，待采样结算后再释放剩余部分。
- 保持与生产相同的 serialization 模式；必须有证据表明暂停时 parser 尚未产出完整消息。
- 验证迟到完整回答、后续新请求以及 child close 的行为。
- 使用明确的 ready/release 同步，禁止依赖碰巧的大 payload、任意 sleep 或机器负载来宣称确定性分片。
- 不在生产 transport 引入 Node 私有通道依赖。若 fixture 必须了解底层 framing，将其限制在测试 peer，明确 Node 契约范围，并继续保留第一层测试。

真实分片 fixture 是 B 中单独可验收的子项。在完成之前，文档仍明确「完整消息边界有直接测试，Node 半包路径尚无直接证明」，不得提前宣布该限制消失。

## 6. 工作包 C：保留自动回收，准确报告状态后果

### 6.1 本轮策略

维持第一次未测量保留、连续第二次回收的现有行为。不能将采样超时单独描述为 worker 已死；它是自动恢复策略的触发条件，不是 OS 已证明的死亡事实。

只在现有结果和诊断中补足可证明的状态事实，不新建 UI、遥测服务或后台协调器：

- 当前 cell 未执行。
- worker 是否保留、已经完成回收、还是回收失败。
- 只恢复已证明 frontier；不承诺 volatile 状态可重放。
- 外部效果可能继续存在，不因回收而撤销。
- 回收失败时明确后续计算被阻止，不能同时承诺「下一个 cell 会恢复成功」。

提示不得声称已丢失某个具体值，除非 catalog 或恢复证据能证明该值只存在于被丢弃部分；无法精确枚举时说明范围即可。

### 6.2 回收失败与 pending 请求

所有新增 reset 路径继续经过 `SessionKernel.resetWorker()`。测试包括拒绝、真实退出晚到和 dispose 聚合，不绕过 `reclamationRecords`，也不以清空失败记录来模拟修复成功。

还应检查 cell 的 wall timer、compute interval 和 abort listener 已释放，而尚未收到回答的采样请求仍有自己的截止与退出清理。不能把「cell 已结算」误写成底层所有 I/O 都已完成。

### 6.3 保留限制的准确表达

本轮完成后仍允许以下结果：用户在一个 live worker 中形成不可重放状态，连续两次请求无法在 run 帧前取得可用预算，自动回收后该状态不可用。可重放部分继续按正式历史恢复。

这项代价应由 ADR 0027、runtime reference 和双语用户说明共同表述，不能只留在开发者 review 文件。运行失败后的结果应给出下一步，但不能指导用户无条件重跑可能已有外部效果的整段历史。

## 7. 工作包 D：可选的优先保状态策略

本轮不新增默认配置。若另行选择保状态优先，最小可行变化是取消「仅按未测量次数」的自动回收：每次请求仍按各自 wall/sample bound 结束，保持同一个 worker，真实退出、确定传输故障和明确终止继续走现有回收 owner。

它的代价是：一个一直不能重新派发代码的 worker 可以持续占有会话状态，后续请求仍失败，需要明确重置才能解卡。新增 health ping 也只能提供另一种可观察事实，不能保证保存状态和强制恢复同时成立。

该选项独立验收，不附带以下能力：

- 任意 V8 heap、闭包、原生连接或文件句柄的快照迁移。
- 把 volatile 自动升级为 durable。
- 重放外部调用来修复状态。
- 新的权限、审批、跨插件调度或 session coordinator。

若未来做成可配置策略，必须经过现有 config owner、配置冻结/更新约束、ADR 和双语说明，不从错误文案、helper 是否碰巧回答 ping 或维护者本机环境推导模式。

## 8. 文件与责任清单

以下是预计触及的责任范围，不表示必须修改每个文件。先检查实际消费者再落补丁。

| owner 或消费者 | 预计改动 | 必须保留 |
| --- | --- | --- |
| [edit-transport-owner.js](../internal/edit-transport-owner.js) | 输出可信未执行结算的 provenance；维持 `edited: false` | Host canonical outcome、目标 claim、正式 dispatch |
| [session-journal.js](../internal/session-journal.js) | 提取共用字段校验；区分历史执行与当前 deferred 结算 | 封闭 schema、历史拒绝规则、快照核验 |
| [session-journal-recovery.js](../internal/session-journal-recovery.js) | root 关系验证、noop 折叠、publication 和目标选择 | source visibility、真实时序、边界收缩 |
| [runtime-bridge-owner.js](../internal/runtime-bridge-owner.js) | 核对 provenance 存在时的值、确认及展示消费者 | canonical root 值、最终 metadata 策略、tentative 确认 |
| [session-runtime.js](../internal/session-runtime.js) | 仅修复测试证实的通知/回收问题；C 默认不改次数策略 | `resetWorker()` owner、admission block、真实状态后果 |
| [isolated-worker.js](../internal/isolated-worker.js) | 原则上仅新增测试；有反例才改判定 | 新鲜基线、bounded read-out、请求 id、迟到回答隔离 |
| [semantic-obligations.json](../semantic-obligations.json) | 扩展真实新 observable、依赖和 executable evidence | `unknown: 0`，不以登记代替测试 |
| [ADR 0005](adr/0005-temporary-rejected-cell-edit-transport.md)、[ADR 0027](adr/0027-run-the-session-kernel-in-a-killable-helper-process.md) | 更新 deferred 结算契约与保留限制 | 历史规则和当前规则有明确边界 |
| [architecture](architecture.md)、[durability design](durability-design.md)、[runtime reference](runtime-reference.md) | 跟进 owner 的新关系与状态说明 | 不把 noop 写成已执行，不夸大 IPC 测试 |
| [README](../README.md)、[English README](../README.en.md) | 同步用户可见的恢复改善和保留代价 | 双语一致，工具名称与参数不变 |

## 9. 验收测试矩阵

下列名称中的 A/B/C 是本文验收编号，不是拟新增的生产错误码。实现可以扩展现有测试，不要求一个编号对应一个新测试文件。

### 9.1 派生结算与恢复

| 编号 | 场景 | 关键断言 | 主要 evidence owner |
| --- | --- | --- | --- |
| A1 | root 创建 durable binding，derived 第一次采样未回答 | root canonical 结果不变；derived `edited: false`；noop 关系完整；live binding 仍在 | `test/plugin-nested-edit.test.js` |
| A2 | 持久化 A1 后销毁 runtime，再冷恢复 | root binding 可用；修订 binding 不存在；editor/外部工具不重派发 | 同上及 `test/plugin-durability-recovery-boundaries.test.js` |
| A3 | root 接受编辑后还更新 root 自己的值，再遇到 derived noop | 恢复得到 root 最终值；不被原目标或修订代码覆盖 | 同上 |
| A4 | 派生未执行同时携带合法恢复边界 | noop 不执行；边界仍应用；不恢复已被收缩的 binding | journal/recovery tests |
| A5 | 最终 Host 删除 post-edit metadata | 不从 raw dispatch 自动恢复被移除的证据；保持保守收缩 | plugin edit/recovery tests |
| A6 | 缺 settle、重复 id、参数变更、目标变更或 journal 不匹配 | 每个篡改单独拒绝，不把 root 的恢复资格建立在模糊关系上 | `test/session-journal.test.js` |
| A7 | noop journal 带 calls、operations、错误用户绑定事实或成功值伪装 | 规范化或 canonical outcome 关联失败 | journal tests |
| A8 | 当前 noop 派生与历史顶层 editor 并存 | 新 deferred 结算有效；历史入口仍按原契约拒绝 noop | journal tests |
| A9 | 下一次编辑目标选择 | noop 修订源码不成为 editableRun；root 按普通规则选择 | journal 与 plugin edit tests |
| A10 | 相同事件从 raw fold 与 materialized timeline 恢复 | 结算、head、目标选择一致；损坏快照被拒绝 | journal/recovery tests |
| A11 | root 原本 volatile，或 root/target 来源不可见 | 不因 derived noop 升级恢复资格；保持已有可见性收缩 | recovery tests |
| A12 | 之后一次正常 edit 成功、discarded 或语义 throw | 原有执行顺序、内容投影、结果确认和冷恢复均不回归 | plugin edit tests |

### 9.2 通知、transport 与生命周期

| 编号 | 场景 | 关键断言 | 主要 evidence owner |
| --- | --- | --- | --- |
| B1 | 收缩后取消、连续未测量、回放 admission block | 复用已有三条测试；精确 frontier 和一份通知 | `test/kernel-worker-settlement.test.js` |
| B2 | B1 结果正式持久化后继续/冷恢复 | 边界保持；同一收缩不被重新计数，也不重复通知（`test/kernel-worker-settlement.test.js` 的「does not recount a recorded contraction after a restart」）；收缩单元自身的通知由 `test/plugin-durability-recovery-boundaries.test.js` 的持久化用例断言 | settlement/recovery tests |
| B3 | 无法继续收缩的 fallback 后当前 cell admission block | 走到当前 cell catch；结果结算，`skipped > 0` 通知保留 | settlement/fault tests |
| B4 | 采样已失败后旧回答到达，同时新请求待回答 | 旧结果不变；旧回答仅更新缓存；新 pending 不受干扰 | `test/isolated-worker.test.js` |
| B5 | 真实 IPC 只交付部分消息，稍后完整到达 | 可证明分片暂停；迟到回答与下一请求隔离；正常关闭 | `test/isolated-helper.test.js` 及专用 fixture |
| C1 | 单次未测量和连续第二次未测量 | 保留/回收符合策略；新 worker 的计数独立 | `test/isolated-entrance.test.js` |
| C2 | volatile binding 随回收丢失，durable frontier 可重放 | 丢失范围与实际值一致；外部 effect 计数不因恢复增加 | entrance/settlement tests |
| C3 | 回收拒绝 | 当前结果报告；后续 admission block；helper 不增加；dispose 保留失败 | settlement/fault tests |
| C4 | 迟到回调、取消与 timeout 交错 | 只结算一次；timer/listener 释放；不能越过 lease 执行 | entrance/transport tests |

### 9.3 反向区分能力

对核心补丁做少量可控反向检查，证明测试能区分问题：

- 去掉新的 noop provenance 支持，A2 应再次丢失 root 恢复资格。
- 让 noop 修订参与编辑目标选择，A9 应失败。
- 放松 dispatch pair 或 journal equality 的某一项，A6 的对应反例应失败。
- 去掉某条早退路径的通知，B1/B3 的对应场景应失败。
- 用旧 id 结算或清理新 pending，B4 应失败。

这些是实施验收时的定向实验，不在生产增加开关，也不要求全仓 mutation 框架。不得通过编辑共享候选后忘记恢复来获得结果；使用隔离候选或已有测试 seam，并在恢复稳定候选后重跑相关聚焦测试。

## 10. 实施顺序与停止条件

### 阶段一：冻结事实与回归反例

1. 记录本次修复的语义边界：当前 deferred edit 的未执行结算，不扩展历史顶层 editor。
2. 用真实 Host fixture 复现 A1/A2；确认失败来自证据缺口，不是 root 原本 volatile 或来源已不可见。
3. 确认 B1 已有测试保留；确定 B3 可达性和 B5 的 fixture 成本。

退出条件：A2 在原实现失败；原因与 root/derived journal 和正式事件可对应。缺少条件时先修 fixture，不能把无效复现作为契约依据。

### 阶段二：完成 A 的最小垂直链路

按「规范化入口 → transport provenance → recovery fold → 目标选择 → Host 最终确认」顺序做小批量改动。先让 A1/A2/A9 形成端到端证据，再补篡改、历史和 materialized timeline 反例。

退出条件：root 冷恢复成功、derived 没执行、没有外部工具重派发，最终 metadata 删除仍会保守失败。若需要大量重构 compiler、journal schema 或增加新的 runtime，则先缩回关系 owner，重新核对必要性。

### 阶段三：补齐 B 与 C 的直接证据

补 B2、B3、B4 和 C2/C3。B5 单独核验真实分片；不因测试 fixture 成本高而扩写生产协议，也不把尚未完成的 B5 写成已覆盖。

退出条件：已声明支持的每个结果都有可执行证据；真实半包若仍未证明，交付说明保留该项。不得用降低采样精度、延长等待或自动重复编辑来使测试变绿。

### 阶段四：同步契约并独立审查

在 A 的 executable evidence 完成后，再更新 ADR 0005/0027、相应运行与恢复文档、语义 owner graph 和双语用户说明。删除已消除的派生限制，保留 volatile 与尚未证明的 IPC 边界。

按 [review procedure](review-procedure.md) 记录具体候选、计划和 owner/consumer 边界，再并行独立审查：

- 派生结算、Host canonical result 与最终确认。
- journal/timeline、恢复、可见来源和历史兼容。
- transport、生命周期、通知及文档事实。

只重审输入或依赖已失效的 lane。不用本方案的存在替代执行证据，也不把 clean review state 单独当成完整验证。

## 11. 验证命令与交付边界

先按具体测试名执行 owner 与直接消费者的聚焦检查。以下命令只使用已存在的 npm script；新增测试名称在实施时补入精确 selector。

```bash
npm run test:backend:focus -- --file test/plugin-prompt-edit-execution.test.js --test-name-pattern="deferred|derived|edit"
npm run test:backend:focus -- --file test/plugin-nested-edit.test.js --test-name-pattern="unmeasured derived execution"
npm run test:backend:focus -- --file test/session-journal.test.js --test-name-pattern="deferred|derived|post-edit|timeline|noop|never ran"
npm run test:backend:focus -- --file test/plugin-durability-recovery-boundaries.test.js --test-name-pattern="derived|contraction|no-op"
npm run test:backend:focus -- --file test/kernel-worker-settlement.test.js --test-name-pattern="reports a contraction|refused reclamation|unmeasured"
npm run test:backend:focus -- --file test/isolated-worker.test.js --test-name-pattern="sample|answer|read-out"
npm run test:backend:focus -- --file test/isolated-helper.test.js --test-name-pattern="helper answer"
npm run semantic:check
git diff --check HEAD --
```

这些 pattern 是责任范围的起点，不是最终覆盖承诺。新增 B5 的测试名若不匹配，必须加入专门 selector；Node 未选中测试不能算验收通过。慢文件先选择单例，不能用完整 gate 发现问题。

稳定的可交付 executable 候选按 [verification](verification.md) 选择一次相称的 `check` 或复用匹配 proof；未解决 findings 的候选按 owner 程序处理。发布 coverage、付费模型评测、提交、推送和发布均不属于本方案的默认执行范围。

如果只新增本文而工作区还有他人的 executable 改动，文档 gate 会把它识别为 mixed candidate。此时保留全部现有改动，对本文使用仓库已有文档校验函数作定向检查，并明确它不是完整 source-bound proof；不为通过文档 gate 撤销或暂存其他人的代码。

## 12. 兼容、失败后果与交付清单

### 12.1 兼容原则

- 完整且可关联的当前 deferred noop 才获得新的恢复资格；旧记录没有必要事实时继续按 unknown boundary 处理，不猜补历史。
- journal 的语言、transform、执行目录、用户绑定策略等代际不变。
- 不把旧的 `discarded` 重新解释成 `noop`，不把 root 的返回值替换成 editor 收据或派生错误。
- Host policy 删除、替换或拒绝结果时，维持正式 canonical 与 metadata 契约。
- raw log、UI inventory 和自然语言摘要都不能替代模型可见的精确来源。

### 12.2 若实现出现问题

运行时遇到无法验证的新关系，继续采用现有保守收缩路径，不重试历史外部效果、不伪造成功。已经发生的外部效果不回滚。

若需要撤回发布的修复，旧读取方可能拒绝新写入的 noop post-edit 关系并收缩更多历史，因此撤回不承诺继续保留这些 binding。交付说明必须区分「代码可撤回」与「任意历史状态可无损恢复」。本轮不新增只为回滚服务的全局策略开关。

### 12.3 本轮完成清单

- [x] A：root 与派生未执行结算可验证，live 与 cold 的用户可见结果一致（`test/plugin-nested-edit.test.js`）。
- [x] A：历史入口仍有直接反例（`test/session-journal.test.js` 的「proves a deferred edit whose revision never ran…」）。
- [x] A：最终 Host 策略与重复/歧义派发对有直接反例（`test/plugin-nested-edit.test.js` 的 damage 矩阵：删除 `POST_EDIT_KEY` 后要求 `/unproved deferred edit:/`）。
- [ ] A：可见来源与 materialized timeline 的对等反例尚未单独补齐（现有覆盖来自相邻 lane 测试，未按本矩阵逐项断言）。
- [x] A：派生 noop 不建立 binding、不成为成功修订或编辑目标、不重派发外部效果（同上两条测试）。
- [ ] B：已存在的三种早退测试保留；B2 已完成（重启不重复计数），当前 cell 阻断证据仍缺。
- [x] B：迟到旧回答与新 pending 隔离（`test/isolated-worker.test.js`）；真实 IPC 分片未完成，按 §5.4 单独保留。
- [ ] C：两次未测量的回收代价、volatile 丢失和回收拒绝均与实际状态一致。
- [ ] 文档、双语用户说明和语义 owner graph 同步，未实现能力不作完成声明。
- [ ] 聚焦测试、相称交付检查、独立审查与最终空白检查完成；没有未经授权的提交或发布。

建议交付边界为 A + B 的关键分支 + C 的明确状态后果。D 只有在明确选择保状态优先、接受失去这条自动解卡路径之后再实施；真实 IPC 分片证据若未完成，单独保留限制，不能与派生恢复修复混为同一完成状态。
