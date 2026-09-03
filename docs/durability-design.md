# Durable / Volatile 恢复协议

## 状态

本文拥有 `dsh-ptc-plus` 的 journal、两阶段确认和冷恢复契约；`internal/session-journal.js` 与 `internal/session-runtime.js` 提供实现证据。

## 恢复承诺

PTC Plus 的正确承诺是：

> **只把可证明状态称为已恢复；历史最差可收缩到空 REPL，但当前合法 cell 仍可继续。**

- durable cell 的源码、tool transcript、结算顺序和 completion 足以精确重放；
- volatile cell 可使用 policy 允许但无法 journal 的 Node 能力，只保证当前 worker 生命周期内延续；
- 一旦进入 volatile，整个 live 后缀保持 volatile；
- restore 命名的 durable 状态可以显式丢弃 volatile 后缀；
- abort、timeout、worker exit、OOM、进程恢复和损坏的历史 PTC metadata 都收缩到最大可证明 frontier；没有非空 frontier 时从空 REPL 执行当前 cell；
- 历史恢复拒绝不可信状态证据，不因这项插件自有历史损坏而永久拒绝后续 `run_code`；当前请求自身的 DSH validation、policy、authority、approval 和 cancellation 仍可拒绝执行；
- 收缩不重新 dispatch、撤销或验证历史 effect；丢失的 binding 由一次 `PTC-R002` 明确提示模型按需重建；
- 可重建不是默认暴露 binding 的充分条件：恢复 frontier 还必须让 binding 的精确 provenance 保留在生成当前调用的模型可见 surface 中，或由显式选择的有界、模型可见结构化投影公开；不能只为延长隐藏状态而默认注入该投影，raw log 与 UI-only inventory 也不满足这项条件；
- `durableReplay: false` 时，新 kernel 从空状态开始且所有已执行 live cell 都是 volatile，作为
  用户怀疑恢复正确性时的显式逃生模式；
- 被跳过的源码仍保存在原始 `tool/call` 中。

这避免了两个错误极端：既不为追求恢复而删除正常 REPL 能力，也不把无法迁移的 heap 伪装成可确定重建。

## Journal

每个进入 CodeRuntime 的 cell 创建 mutable tentative journal：

```ts
{
  version: 4,
  bindingPolicy: {
    variableRedeclarations: boolean,
    functionClassRedeclarations: boolean
  },
  rewritePolicy: {
    autoRewriteImports: boolean,
    autoStripExports: boolean,
    autoSplitRedeclarations: boolean
  },
  moduleSemantics: {
    defaultExportBinding: "legacy-variable" | "live-readonly"
  },
  status: "durable" | "volatile" | "discarded" | "noop",
  calls: CapabilityCall[],
  operations: StateOperation[],
  confirms: number[],
  diagnostics: Diagnostic[],
  completion?:
    | { kind: "return", hasValue: false }
    | { kind: "return", hasValue: true, value: PtcValueGraphV1 }
    | { kind: "throw", error: { kind: string, message: string } },
  volatileReason?: string
}
```

字段含义：

- `durable`：创建可重放 node，推进 `durableHead`；
- `bindingPolicy`：记录该 cell 实际采用的变量重声明和 function/class 重声明语义；冷重放读取每个 node 的完整记录值，并用它重建 binding 可写性，不读取恢复时的 profile 配置；
- `rewritePolicy`：记录该 cell 解析和 lowering 时使用的三个 AST rewrite 开关；冷重放读取每个 node 的记录值，不读取恢复时的 profile 配置；
- `moduleSemantics`：记录不可由 profile 选择的源码 lowering 代际；当前 cell 固定写入 `live-readonly`，冷重放按记录值恢复 `export default` 的公开 binding 模型；
- `volatile`：只推进 live heap，不推进 `durableHead`；
- `discarded`：基础设施失败，calls 和 operations 必须为空；若中止时仍有未结算的 program binding call，则以首个 `global.member` 保留 `volatileReason`，恢复时不能把这个 possible-effect boundary 折叠为 no-op；
- `noop`：程序未执行，calls 和 operations 必须为空；
- `confirms`：以 `tool/call.seq` 确认此前无 journal 的 call 没有进入 runtime；
- `diagnostics`：本 cell 产生的封闭结构化诊断；
- `completion`：区分普通 return 与可重放的语义 throw；
- `volatileReason`：记录第一次运行时降级原因，或 discarded cell 中最先观察到的未结算 program binding。

`durableReplay` 不写入 journal，也不引入 schema 分支。它默认是 `true`。设为 `false` 时，
SessionRuntime 创建 kernel 时完全忽略历史 nodes、head、checkpoints 与 volatile suffix；之后实际
求值的 cell 无论静态分类如何都记录为 `volatile`。这是已知配置态，不是运行时降级，因此不
发送模型可见警告；system prompt 直接告知模型 binding 仅在当前进程可复用，`repl.state(list)`
返回同一状态。未进入 evaluator 的调用仍是 `noop`，取消、超时和 worker failure 仍是
`discarded`。关闭期间不能保存 durable named state；restore 后的下一 cell 仍被强制为 volatile。

journal、diagnostic、source、cause、call、operation、completion 和 completion error 都使用封闭字段集合；未知、symbol 或非枚举自有字段会使 journal 无效。capability-call `args`/`value` 与 return completion `value` 都是封闭、规范化的 `ptc-value-graph/v1` envelope。诊断结构、source frame 依赖和稳定代码见[架构说明](architecture.md#journal-与恢复)。

当前实现只写入 `version: 4` schema。v1-v3 作为封闭 predecessor 输入规范化为 v4：旧 `bindingMode` 精确映射到 `bindingPolicy.variableRedeclarations`，而 `functionClassRedeclarations` 固定为 `false`，因为旧 pipeline 不具备该语义；`moduleSemantics.defaultExportBinding` 固定迁移为 `legacy-variable`，使 loose 历史保留旧的可写生成 binding、strict 历史保留旧的 const 行为。v1 仍使用三个 rewrite 开关全关的历史默认值，并只在 session log 唯一证明 call identity 时迁移字符串 confirmation；v2/v3 保留自身 `rewritePolicy`，无法表示为非负 event sequence 的 confirmation 必须形成 unknown boundary 并触发状态收缩。包括 `bindingPolicy`、`rewritePolicy`、`moduleSemantics`、`diagnostics` 在内的必需字段缺失时 journal 必须失效，否则会削弱最终持久值与 tentative journal 的严格一致性确认；失效 journal 不证明旧 binding，但也不单独成为后续当前调用的 availability gate。profile 后续切换任一 binding 或 AST rewrite 开关只影响新 cell，历史 node 始终按自身记录的 policy 和 module semantics 重放。

## Capability Call Transcript

每个 native `tools.*` 或 cell program binding call 保存：

```ts
{
  global: string,
  member: string,
  args: PtcValueGraphV1,
  ok: boolean,
  value?: PtcValueGraphV1,
  error?: string,
  settle: number
}
```

`settle` 必须是从 0 开始的连续序列。重放按源码产生调用，但不重新 dispatch；它校验 global、member、args 和提交数量，再按 recorded settlement order 释放 recorded value/error。这个 `recorded-value` 承诺重建的是 REPL 计算状态，不表示外部 effect 被重做、撤销或验证。对进程内 Cordis 状态，恢复值明确只是历史数据：Cordis 可见时，固定 runtime context 要求在把旧 ID、Run、approval 或 capability observation 当作当前事实前完成一次新的成功 live Inspect。completeness、effect、authority 和 source evidence 属于 capability metadata，不伪装成 journal 字段。

journal 的 capability-call `args`/`value` 与 completion value 保存 `ptc-value-graph/v1` canonical envelope，不保存 decoded rich JS value，也不依赖递归 `JSON.stringify` 或 `structuredClone`。因此深层数组/对象、own `__proto__`、`undefined`、special number、BigInt、hole、shared identity 和 cycle 不会被外层 session JSON 改写。完整支持域和预算见 [PTC Value Graph V1](value-wire.md)。

## 两阶段确认

当前 DSH 公共扩展流水线是：

```text
pre-execute -> tools/execute -> post-execute
            -> content finalization -> tools/result
            -> persistent tool/result event
```

插件采用：

1. `tools/execute` 保存 execution 对象与 session context；
2. `CodeRuntime.run` 真正进入 kernel 时创建 tentative journal；
3. 成功结果由 `presentationMeta` 投影 journal，失败结果由 around hook 附加；
4. `tools/result` 规范化最终 `meta.dshPtcPlus` 与 runtime tentative journal；
5. 两者语义完全相同时确认 tentative 状态；
6. cell 已执行但 metadata 缺失、损坏或被替换时，live kernel 单调降为 volatile；
7. 从未进入 runtime 时，把 call id 加入 pending no-op；
8. 下一个成功 journal 通过 `confirms` 持久确认 pending no-op。

真值表：

| 观察 | Live 行为 | 冷恢复行为 |
| --- | --- | --- |
| valid journal | 按 status 提交 | 按 journal 折叠 |
| 已执行，最终 journal 被删除 | cell 与后缀 volatile | 收缩到此前可证明 frontier，继续当前 cell |
| 未进入 runtime | pending no-op | 后续 `confirms` 存在时忽略 |
| 无法判断且未被确认 | 保守处理 | 拒绝其状态证据；必要时空 REPL，继续当前 cell |

比较先严格规范化 journal，再使用 PTC value graph 的扁平 wire 表示，不对深层参数做递归遍历。额外无关 metadata 不影响确认，但 `dshPtcPlus` 自身任何可观察差异都拒绝确认。

`tools/result` 不修改结果。若 pending no-op 尚未被后续 journal 确认进程就退出，冷恢复保守形成 unknown boundary。

## Nested run_code

模型直接发起的 top-level `run_code` 与真实注册的 `edit_run_code` 派生执行都创建本 schema 的 cell journal。前者随 `run_code` result 持久化；后者随外层 edit result 的 derived metadata 持久化，并与模型原始 edit call 关联。隔离 child binding 不创建 child PTC journal，也不产生可合并到父 heap 的 binding。

父 cell 把隔离 child 当成普通 program binding call，记录 graph-encoded arguments、canonical result/error 和 settlement order。正常结算后，cold replay 返回 recorded child result，不重新执行 child 源码。若取消、超时或 worker failure 发生在调用结算前，`discarded` journal 以 `code.run` 保留 possible-effect boundary。这个结果来自所有 program binding 共用的 pending/settled 生命周期，不是 `code.run` 名称特例。它不注册第二个模型工具，也不伪造 UI、policy hook、调用树或事件。

## 日志折叠

恢复以当前请求需要的 head 为目标，沿可证明 parent 关系向更早 frontier 收缩；实现可以前向折叠 event 建图，但不得把 unknown boundary 两侧的日志位置当作状态依赖证据。恢复入口先把当前 call id 解析为持久化 `tool/call.seq`，再把该序号作为 live boundary 传入折叠器；对应的在途 call event 不属于历史。每个 `edit_run_code` 在其 call event 处，根据此前已经结算的调用确定并固定可编辑目标；之后出现的 result 只影响随后发起的 edit：

1. 用 `sourceEventSeqs[0]` 关联 `tool/result` 与 `tool/call`；
2. 预收集 valid journal 中的 `confirms`；
3. 排除与 live boundary 序号相同的在途 call，并让已确认 no-op 的无 journal call 不改变状态；
4. 缺失源码、缺失/损坏 journal 或无法验证的 call/result/prune 关联建立 untrusted boundary，不作为旧 binding 的证据；
5. `noop` 与不含 `volatileReason` 的 `discarded` 不改变语言状态；带 `volatileReason` 的 `discarded` 表示 heap 已回滚但外部 effect 未知，进入 untrusted suffix；
6. `volatile` 进入 untrusted suffix，只应用可独立持久的 delete/restore 操作；
7. `restore` 命名状态重新建立 trusted durable head；
8. 只有 ancestry 或独立性有插件自有机械证据的 post-boundary durable 记录才可保留；否则整个受影响 cell 与依赖后缀收缩；
9. durable node 保存 parent link，命名状态保存 node index；
10. `meta.dshPtcPlusRecoveryBoundaries` 在 `tool/result` event sequence 参与排序前完成规范化；损坏 boundary 被拒绝为状态证据并建立保守收缩点，合法 boundary 通过失败 call seq 选择 node，并要求记录的 frontier 恰好是该 node 的 parent；
11. 折叠器剪除不可证明的 node、binding 与依赖后代，按剩余记录重算 checkpoints；runtime 重置 worker 并验证候选 frontier，逐级收缩到最大可重放 frontier，必要时到空 REPL；
12. 当前 cell 只在 worker 实际拥有该 frontier 后执行，成为它的新 child 或空 REPL 的新 root；当前结果持久记录本次收缩并投影一次恢复诊断。

当前 journal 没有完整的逐 binding 读写与传递依赖图。源码存在、重放未抛错或 completion 相同，都不足以证明闭包捕获、属性 mutation、动态名称访问或运行时值与原执行一致。因此恢复不能任意挑选 unknown boundary 后看似独立的 binding；缺少机械证明时以 cell 为原子并丢弃受影响后缀。将来若要保留更细粒度状态，必须通过版本化、owner-owned 的依赖证据扩展契约，不能从名称或成功重放猜测。

第 12 步是可用性与真实性共同的不变量：旧 unknown 调用不能被伪装成已恢复 heap，也不能在每次重启时永久吞掉所有后续 `run_code`。当前 cell 是在已经实际物化的 frontier 上重新执行，所以它可以安全建立持久新分支；这不表示被剪除 cell 的外部 effect 没有发生。

## 模型可知状态

DSH session 同时提供两个不同投影：append-only event log 保存审计、journal 与 replay evidence；ordered surface/derived request history 是模型请求实际可见的消息历史。PTC Plus 的默认状态 frontier 是“结构可重建”和“模型可知”的交集，不能用 raw log 的存在替代 surface evidence。模型可知只采用外部可验证事实，不猜模型内部记忆：精确声明源码仍在当前 request surface，或插件/宿主通过有界结构把准确 binding identity 与 provenance 放入模型上下文。

surface replacement 是否删除状态取决于模型失去了什么，而不取决于是否出现 `compaction/prune` 这个名字。只替换过长 tool result、仍保留 assistant `run_code`/`edit_run_code` 调用及源码时，模型仍知道该 cell，可继续使用其 journal。若 replacement 或 summary 遮蔽了声明 provenance，raw journal 即使完整也不能让 binding 默认继续存在；自然语言 summary 不解析为依赖或 binding 证明。当前没有模型可见的完整 binding inventory，因此缺少精确 provenance 时按 cell 与依赖后缀收缩。

该规则也约束 live worker。runtime 在下一 cell 前观察 DSH public surface generation；发生 replacement 后，若现存 binding 超出模型可知 frontier，先重置 worker、重建交集 frontier，再执行当前 cell。Client header card 的 `dshPtcPlusBindings` 只帮助用户检查，不进入模型上下文，也不延长 binding 生命周期；相同 contraction 应让 UI inventory 进入不可确认状态。未来若新增模型可见状态投影，它必须由用户、模型或明确配置选择，有固定 schema、硬预算、append-only runtime-context 证据和明确清除条件，不能仅为延长隐藏状态而默认注入，也不能污染稳定 prompt prefix。

## Completion 校验

普通异常可能已经建立或修改 binding，所以 durable `throw` 属于语言历史。重放接受的语义结果只有：

- recorded `return` 再次 return；
- recorded `throw` 再次产生相同 error kind 和 message；

以下结果永远是恢复基础设施失败，不能因为 recorded completion 也是 error 而接受：

- abort；
- compute/wall timeout；
- output limit；
- worker exit/OOM；
- recovery divergence；
- durable replay 触发 volatile capability。

基础设施失败会终止当前 worker，并把 log-only recovery boundary 放入当前已结算 `tool/result` 的私有 metadata。kernel 从失败 node 的 parent 重新重放；若该 frontier 仍失败则继续向 parent 收缩，直到最大可验证 frontier 或空 REPL。触发恢复的当前 `run_code` 在候选 frontier 验证成功前不执行，验证后在同一次请求中继续。boundary 无效或历史本身无法完整折叠时，相关记录和可能依赖它的状态不得进入 frontier；这类历史 PTC metadata 损坏本身不返回永久 recovery error，而是继续收缩，最差用空 worker 执行当前 cell，并在其最终 result 持久表达新 ancestry。已经写入旧版自定义 boundary event 的日志必须先通过显式、非破坏迁移转换为 DSH 可加载的 metadata；迁移失败时不得覆盖原始日志。

## State Operations

```ts
type StateOperation =
  | { action: "save", name: string }
  | { action: "restore", name?: string }
  | { action: "delete", name: string }
```

- `save` 只可提交到 durable node；
- cell 静态判断 durable、但在 `save` 后运行时降级时，tentative save 会被删除；
- `delete` 可独立应用于命名索引；
- 无名称 `restore` 选择当前 cell 之前的最后 durable head，清除 volatile suffix；
- `restore` 把 head 切回已存在的 durable node，清除 volatile suffix；
- list 不写 operation，返回当前 checkpoint 名称、`mode` 和首次 `volatileReason`。

状态名称由 agent 选择，内部 node index、hash、revision 和日志位置不进入模型接口。

## Capability 规则

静态分类器理解 top-level、block、function、catch 和 loop binding。它只把实际未绑定的 ambient reference 作为降级候选；属性键和局部同名变量无影响。

运行时对以下访问标记 volatile。归因依据是 worker 当前 active execution，不使用异步回调继承的 `AsyncLocalStorage` store。active execution 从开始求值持续到 capability calls 结算、返回值 PTC value graph 编码或异常归一化全部完成；这些阶段的 getter、Proxy 或字符串转换仍可能执行用户代码。最终 durability 必须在转换后采样，纯 wire message 构造完成后才在最外层 `finally` 清除 active execution。只有此后发生的访问才暂存 reason 并使下一 cell volatile：

- Date、performance、fetch、WebSocket、crypto、Intl；
- setTimeout、setInterval、setImmediate；
- eval、Function、除捕获的 stdout/stderr 与 session-backed `cwd()` 外的 process 能力、require；
- `Math.random()`；
- durable allowlist 之外的 dynamic import，包括 `node:path`。

普通 `Math` intrinsic 保持完整。`process.stdout/stderr.write` 被捕获为 cell log，不因输出本身降级。

worker 不继承 Electron 的工作目录语义。插件通过现有 `tools/execute` context 读取不可变的 `agent.session.header.cwd` 并注入 session worker；`process.cwd()` 返回该值且保持 durable。header 未记录 cwd 时才回退宿主值并在运行时标记 volatile。
同一 session 中，`child_process` 的 `exec`、`execFile`、`fork`、`spawn` 及同步变体在未提供 `options.cwd` 时以该 cwd 启动；显式 cwd 保持调用方选择。worker 保留 Node、package manager 和 shell 所需的宿主环境变量，仅将 `TEMP`、`TMP` 和 `TMPDIR` 覆盖为该 session 的 scratch 目录。`node:fs`、`node:fs/promises` 和 glob 的相对入口统一以 session cwd 解析，绝对路径与显式路径选项保持原生语义。

直接访问 `worker_threads` 或 `cluster` 的常见 import/require 形式会被拒绝。直接 `process`、`require`、dynamic import 与 static import 取得的 `process.exit/abort/kill/chdir` 共享同一组拒绝函数，因为这些操作暴露或破坏 worker lifecycle control。该 gate 只维护 REPL 生命周期，不是恶意
代码安全沙箱；native tool 的安全依赖 DSH policy，ambient Node 的安全依赖进程隔离和操作系统权限。

## 恢复通知

构造 kernel 时若折叠结果含 volatile/unknown boundary、模型可见 surface 收缩，或本次重放产生 recovery contraction，第一次实际执行的 `run_code` 记录并投影 `PTC-R002`。它只统计当前 call 之前实际未恢复的历史 cell，并明确旧 binding 可能需要重新声明：

```text
warning[PTC-R002]: restored the durable head and skipped N unreconstructable historical cells
phase: recover
state: ...
help: ...
```

通知进入正常 CodeRuntime logs，结构化值进入当前 journal，因此成功结果和错误结果都能呈现并从 session log 重建。收缩边界随当前 result 持久化，后续 cold start 从新分支恢复，不重复撞击同一损坏历史；每个 kernel 只发送一次，避免污染后续上下文。

live kernel 首次进入 volatile 只更新 journal 的 `status` / `volatileReason` 和 `repl.state(list)`，不向模型投影 warning/note。该转换不要求当前任务采取行动；只有 cold recovery 已实际跳过 volatile、unknown 或 replay-abandoned 历史时才发送 `PTC-R002`。worker 在首次观察到直接 Node/OS 边界时立即通知主线程，因此后续 hard abort、timeout 或 worker exit 仍能把原因写入 discarded journal。

## 失败状态语义

诊断的 `stateEffect` 描述当前 cell 的 live/冷恢复状态事实，不由 severity 推断，也不表示当前 binding 是否仍可用：

- parse、无法安全放宽的跨 cell collision 在执行前失败，使用 `unchanged`，journal 为 `noop`；
- 求值开始后的普通 throw 使用 `partially-applied`，因为此前 binding mutation 可能已生效；
- PTC Value V1 输出超出支持域或预算时使用 `PTC-O001` 与 `partially-applied`，因为返回前的 binding/mutation 已经执行；`undefined`、special number、BigInt、hole、shared identity 和 cycle 属于受支持值，不要求模型为了 transport 改写；
- 冷恢复丢弃不可信后缀使用 `rolled-back`；
- 只有已知外部 dispatch 发生但 completion 无法确定时才使用 `unknown` 并附 `dispatchState: "unknown"`，插件不得在宿主未提供该事实时猜测。

模型可见文本与 `diagnostics` 必须由同一个结构确定性生成。恢复不通过解析既有 message 重建诊断；session export/import 和 replay 均保留结构化 code、cause、dispatch state 与 state effect。源码 frame 使用 `@babel/code-frame` 的无色投影。

## 插件边界

协议只依赖：

- `tools/execute`；
- `tools/result`；
- `CodeRuntime.run`；
- 当前 `CodeRuntime.run` request 的 public bindings 与 signal；
- `run_code.output.presentationMeta`；
- 标准 `tool/call` 与 `tool/result.meta`。

以上是当前已实现的 PTC journal 协议。native `tools.*` 保持 owner contract；cell program binding 不得变成新的模型 transport。

任何公共扩展面无法持久确认的状态都必须收缩为 volatile/unknown 边界，但边界否定的是旧状态证明，不是当前合法调用的可用性；最大可证明 frontier 为空时，插件仍应让当前 cell 从空 REPL 建立新分支。修改或 fork DSH、patch 私有
scheduler、复制 policy/event protocol 或伪造事件不属于本协议。若上游以后提供 owner-declared
typed binding，它可以使用 DSH nested dispatch，但不得伪装成 journal confirmation，也不得绕过
scope、policy 或 settlement。

## 已验证场景

- durable continuation 和仅凭持久 session-log JSON 的 cold recovery；
- tool call record/replay 与并发 settlement order；
- volatile live continuation、冷恢复跳过和 durable 重基；
- post-execute metadata 删除与 pre-dispatch no-op 确认；
- hard abort、冷 worker 启动取消和未结算 program binding 的 possible-effect boundary；
- replay timeout 逐级收缩到可验证 frontier；
- Math intrinsic、局部 ambient 名称、CWD 相关 `node:path`；
- 命名状态 save/restore/delete 与 volatile restore；
- 深层 graph value、own `__proto__` key、`undefined`、special number、BigInt、hole、alias 与 cycle；
- 独立的变量与 function/class 重声明 policy、不可写目标 preflight、声明位置替换及 cold replay；
- runtime throw、invalid output 和真实 recovery 的结构化诊断与模型可见投影；普通 volatile transition 保持安静；
- 未修改 DSH 的真实公共扩展面，并在全新 session runtime 中从日志恢复。
