# Capability Surface

PTC Plus 保留 DSH 原生 typed `tools.*`，不建立工具名称特例层、参数适配表或反射调用总线。`danger-full-access` 是一等体验；其他 profile 只暴露当前 DSH request 实际拥有的能力，缺少的能力不由插件模拟。

## Native tools

工具参数、canonical result、错误、policy、取消和调度语义均由 DSH owner contract 决定。PTC Plus 只为每个 cell 包一层统一 lease，并把 call 的 args/result 与 settlement 写入 journal。captured member 在 cell 结束后失效，不能绕过下一次 scope/policy 检查。

`canonical` 只表示交给程序的结构化值，不表示完整世界快照。结果完整性分为：

| 类别 | 含义 |
| --- | --- |
| `complete` | 对契约声明范围完整 |
| `bounded` | 明确窗口、预算或上限 |
| `incremental` | 自上次读取后的增量或消费结果 |
| `open-world` | 来源空间不可穷尽，只表示当前查询 |
| `unknown` | 现有契约不足以证明 |

当前 live tool schema 不携带 owner-proven completeness/effect 注解，所以 explorer 对所有工具默认返回
`unknown`，不按名称补写 metadata。当前 DSH `tools.read` 的返回值是有界 inspection window，这是一项
owner contract 使用注意，而不是 PTC 推导出的 capability annotation。需要无损整文件计算时，一等
profile 使用 `node:fs/promises.readFile` 或 stream，并接受该直接 I/O 使 cold replay 进入 volatile。
降级 profile 没有无损入口时，明确报告不支持。

## Descriptive explorer

```ts
await capabilities.search({ query: "read file content", budgetBytes: 8192 })
await capabilities.tree()
await capabilities.find("session")
await capabilities.inspect({ symbols: ["tools.session_search"], budget: 8 })
await capabilities.inspect({ symbols: ["repl.state", "code.run"], budget: 2 })
```

- `search({ query, budgetBytes?, limit?, cursor? })` 用中英文词项、名称及当前索引的 owner 描述/关键词查找；一次返回完整索引条目，包括参数、返回 schema 和已有 metadata。精确 symbol/name 优先，多词不要求连续；它是词法检索，不是模型语义推断。它不读取未公开的 Skill、资源或服务，也不补造 owner 指引。
- `search` 默认 16384 UTF-8 JSON 字节、至少 512 字节，默认每页考虑 10 个匹配项。这些是检索响应边界，不是已校准的 token 最优值。`usedBytes` 计入整个返回 JSON 的包装、游标和省略指针；外层 `run_code` 格式及值图展示另有成本。契约无法容纳时不截断 schema，返回 `oversized` 与单项 `inspect` 参数；调用者可提高字节预算，或显式使用原有无字节预算的 inspect。
- `cursor` 在相同 query 与索引内容下继续；契约/目录变化时拒绝旧游标。`remaining` 表示还未考虑的匹配项，不表示缺少的 API。每个 cell 构建一次派生索引，调用不执行被描述的能力、不请求模型，并沿用 cell lease 和 recorded-value replay。
- search 在规范化前校验并快照原始 owner/member 及嵌套 schema 的无损 JSON 数据；accessor、非枚举字段和非普通对象会被拒绝，校验不调用 getter。这个新增边界不改变 tree/find/inspect 的原有元数据接受规则。
- `tree()` 返回 `tools`、`repl`、`code` namespace 与 member 名称，适合低成本定位；
- `find(query)` 在 symbol 与 description 中做确定性查找，返回 completeness、effect 和 replay 摘要；
- `inspect({ symbols?, budget? })` 批量返回 live JSON schema 与 metadata，并显式返回 `omitted`、`unknown` 和实际 budget；不传 symbols 时检查当前 view 的前 50 项。

当前 replay 分类为 `recorded-value`：PTC journal 会在 cold replay 返回已记录的 canonical value，不重新 dispatch tool。它不表示外部 effect 被撤销、重做或验证。`owner-replay`、`volatile` 与 `unknown` 已属于 metadata vocabulary，但只有 owner/DSH 提供证据后才能声明。

explorer 不调用 capability、不提升 authority、不读取隐藏服务、不触发辅助模型请求。`tools` metadata 来自执行时 agent scope 的 live schemas；`repl.state` 与 `code.run` metadata 由插件自身契约提供。模型若要根据探索结果决定下一步，仍会发生正常的后续 turn。当前公共扩展面没有跨 prompt assembly 与 runtime dispatch 的冻结 token，因此定义变化不能被描述成原子 snapshot。

能力管理开启时，同一冻结方案拥有启用与披露选择，当前宿主契约拥有首轮说明、按需检索及编译前实际成员投影。可用性与说明分别选择；host 项继续保留原说明路径，只有完整或按需项由方案替代其 SDK 说明。分配、统计采集、恢复与预览各自独立；见 [ADR 0043](adr/0043-compose-capability-and-context-policies.md)。配置保存不重排已有会话；`/capabilities refresh` 同步环境并提交持久通知。search 的字节边界不能独自证明完整任务 token 降低；接入证据见[公共接口覆盖](context-public-interface-coverage.md)，格式和恢复路径见[组件说明](capability-planning-components.md)。

`code.run` 返回 `{ logs: string[], result?: unknown }`：`logs` 按发出顺序保存 child console 输出，child 返回 `undefined` 时省略 `result`。该结构描述不改变其中任意值的 completeness，也不表示 child 无外部 effect。

## Non-tool APIs

执行缝 request 已携带的 owner-provided program namespace 会原样进入 cell，并与 native tools 共享 lease；插件不翻译其领域契约。与插件保留的 `capabilities`、`code` 或 `repl` 同名时 request 明确失败，避免两套 binding 静默分叉；普通 cell 局部变量可以 shadow 这些低频 namespace，需要时从 `globalThis` 访问。`tools` 仍保持保留，因为 shadow 它会移除主要 typed 能力面。`code.run` 只隔离执行已经作为数据持有的 source；当前 cell 能直接完成的 Node、fetch 或 native tool 工作不需要嵌套。当前公共扩展面没有发现额外 DSH/插件服务的 registry，PTC Plus 不猜测隐藏服务，也不保留未来脚手架。显式注册、生成 manifest、装饰器或扫描只是可能的发现机制，不能替代类型、authority、lease 和 settlement 契约。

explorer 本身只做 deterministic inspection，不调用模型。任何 Agent 生成的语义摘要都必须由用户主动触发，或由用户预先授权且有硬预算、用量记录和取消能力的 policy 触发；它不属于当前运行时。
