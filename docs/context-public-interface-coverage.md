# 上下文管理公共接口覆盖

同一冻结会话方案由 `internal/capability-environment.js` 拥有，供 prompt、检索与编译前 program bindings 使用。插件使用发布包的公共组合入口，不修改宿主源码或安装包；DSH 继续拥有正式 validation、dispatch、authority 和 cell lease。

| 责任 | 实施路径 | 可执行证据 |
| --- | --- | --- |
| 继承及 scope 自有工具 | 在 execution seam 提供的 `tools` descriptor 上移除关闭成员；仅调用宿主原函数 | `test/plugin-program-bindings.test.js` 的受管工具编译测试、`test/capability-environment.test.js` |
| 原生 SDK | `system-prompt/assemble` 将全量 SDK 替换为固定语言与发现 bootstrap，完整契约进入首轮源消息；保留 `complete` section | `test/plugin-program-bindings.test.js`、`test/context-host-contract.test.js` |
| Skill | 公共 scope provider 提供关闭条目的不可调用 winning entry；目录、加载和显式用户调用共用该视图；刷新枚举原 provider；稳定投影不重复 invalidate，父子并行目录读取不因无变化准备失效；暂时不完整保留已证明 Skill，不发布新资格 | `test/capability-environment.test.js` 的真实 SkillRegistry 测试 |
| MCP 工具 | 普通工具投影包含 `mcp__` 成员；server instructions 作为完整契约依赖按方案披露 | `test/capability-environment.test.js`、`test/context-host-contract.test.js` |
| MCP 资源和模板 | 以公共 server 目录为能力单元，筛选发现说明及共享加载器 selector；可用 server 为空时移除共享成员 | `test/capability-environment.test.js` 的共享 selector、空域与刷新反例 |
| 旧工具引用 | 捕获的 callable 继续受原 cell lease 约束；普通函数在下一 cell 读取重新投影的 program namespace | `test/plugin-program-bindings.test.js` |
| 首轮发布、刷新与通知 | 首轮方案在请求前组装，经 accepted-step 在受保护 system head 后、未提交历史的新任务前提交一次；导航和显式完整契约保持统计变化前缀；已初始化会话的 `/capabilities refresh` 经公共 `runMaintenance()` 以单次 `Session.append` 提交新方案及模型通知；首次接受前的刷新回执说明待接受，取消或写入失败不伪造提交 | `test/capability-environment.test.js` 的实际跨会话请求、统计变更前缀、真实 AgentLoop 与严格恢复 oracle |
| 恢复与压缩 | 从 source-backed 方案恢复冻结环境；已接受且校验的本会话契约更新保留最近 Skill 视图，目录暂时不完整不复活已撤下项；正式结果元数据记录展开和使用；ordered surface 决定说明去重 | `test/capability-environment.test.js` 的 Session round trip 与 replacement 测试 |
| 家族统计 | 公共 session lineage、turn/step 结算与家族 census，配合原子文件锁；未知结算不作负样本 | `test/capability-statistics.test.js`、`test/context-host-contract.test.js` |
| 结果和日志 | 独立 spill policy 事件上下文读取宿主 spill 服务；canonical 值保持完整，存储失败保留原展示 | `test/context-result-preview.test.js` |
| 设置观察 | 独立设置、可搜索能力选择、统计开关与数值输入、有效方案、选择原因、使用覆盖率、预算超额及待刷新状态 | `test/client-runtime.spec.js` 的能力设置测试 |

`tools.restrict()` 仅影响继承层，不能单独承担 scope 自有工具的移除。这一宿主行为由公共探针保留为对照；PTC Plus 的实际执行入口使用统一编译准备投影，因此它不再是本功能的实施阻塞。投影后的工具参数、canonical 结果和宿主错误保持原语义，没有第二套分派 registry。

资源和模板按 server 管理，同一 server 下的 URI 与模板继续由宿主列表与读取协议拥有。插件不为组装 prompt 枚举远程资源或读取 Skill 正文。无模型测试证明执行和生命周期关系；普通任务质量与全家族 token 收益仍需独立授权的任务对照，不能从 prompt 字节缩短推断。

能力刷新用户入口的证据：`test/context-host-contract.test.js` 从正式 CommandUiRuntime 的输入匹配进入公共 CommandRuntime，分别验证带参数刷新、裸命令检查、未知参数与零模型请求。`test/client-runtime.spec.js` 覆盖星光当前会话、设置明确目标、管理/绑定关闭、取消、失败及失效回执；`scripts/client-fallback-smoke.mjs` 使用候选的共享刷新组件检查实际按钮与目标。只读 `targets` 的无方案准备行为由 `test/capability-environment.test.js` 验证。

MCP 两级控制由 `test/capability-environment.test.js` 验证 server 工具/资源同步关闭、单工具配置保留、其它 server 独立及刷新边界；正式 Host 无首轮副作用观察由 `test/context-host-contract.test.js` 验证，Client server 分组和独立子项写入由 `test/client-runtime.spec.js` 验证。
