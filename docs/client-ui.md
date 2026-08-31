# Client UI

PTC Plus 现在提供 DSH Web/Desktop 的**插件设置卡片**，位置在 Settings → Plugin configuration。

## 设置命名空间

Host half 通过 DSH 公共 `settings` 服务注册命名空间 `ptc-plus`。字段清单、默认值和校验来自 `internal/config-spec.js`，
由 `index.js` 的 `Config` schema 与设置注册共用；client half 构建时把同一份字段清单打进 bundle，不在 UI 中复制默认值。

## 可用设置

| 分组 | 字段 | 说明 |
| --- | --- | --- |
| 开关 | `enabled` | 关闭后不注册 `run_code`/`edit_run_code`、不修改 system prompt、不创建 session runtime；只保留设置 UI。 |
| Cordis | `cordisToolsEnabled` | 默认关闭；开启后为 PTC agent 加入官方 Cordis 工具、指引与精确的 `cordis-plugin-development` companion Skill，不发布同目录 sibling。 |
| 计算 | `computeMs` / `maxWallMs` | 单 cell CPU 与墙钟预算。 |
| 输出 | `maxOutputBytes` / `maxValueNodes` / `maxValueEdges` / `maxValueArrayLength` / `maxValueBigIntDigits` | Value Graph 与输出字节预算。 |
| Worker | `maxOldGenerationSizeMb` / `maxNestedRunCodeDepth` | kernel worker 内存与嵌套执行深度。 |
| 行为 | `canonicalizeToolCalls` / `looseTopLevelRedeclarations` / `durableReplay` | REPL 与 transport 策略。 |
| 模块 | `autoRewriteImports` / `autoStripExports` / `autoSplitRedeclarations` | AST 重写开关。 |
| 提示 | `tipsEnabled` / `tipCooldownMessages` / `tipEscalationFailures` | 恢复提示策略。 |

## enabled 开关与正文功能标记

所有字段都是实时设置：Host 在 settings watch 中安装、卸载或重配置 runtime。已提交的 cell 固定使用提交时的配置快照，运行中的更新从随后提交的 cell 开始使用；这不会替换 session-bound REPL 或已有 binding。`maxOldGenerationSizeMb` 在活动 worker 存在时因 Node 的创建期限制而拒绝并回滚，其他可重配置字段照常交给 owner。关闭后唯一的宿主副作用是注册 settings 命名空间，
保证设置卡片仍然可读；此时只有 `enabled` 可写，其他控件被禁用。运行时重配置失败时回滚到上一次已应用值。

`cordisToolsEnabled` 默认关闭并即时生效。它不切换 preset，而是把官方 Cordis 工具、owner guidance 与 `cordis-plugin-development` Skill 作为一个 agent-scoped mount 加入或移出 PTC agent；顶层仍为 `run_code` / `edit_run_code`，普通 agent 不继承。Host 缺少 official preset、Skill/Cordis service 或任一 contribution 加载失败时，启用会完整回滚。完整运行要求见 [运行时参考](runtime-reference.md)。

设置卡片和正文 tool view 的全部文案都注册到 DSH client locale 的 `settings.ptcPlus` 命名空间，随当前界面语言在中文与 English 之间切换；字段名称与说明的两种语言文本同样来自 `internal/config-spec.js`（`label`/`labelEn`、`description`/`descriptionEn`，某一字段的说明要么两种语言都有，要么都没有），展示 chrome 文案由 client half 拥有。稳定 REPL 指引不承载 UI 品牌名。启用且会话选择当前 `ptc` 或旧 Host `code` preset 时，`conversation.session.header.actions` 以稳定 id `ptc-plus-active` 显示原有的简洁 `PTC Plus` 标识；当前 session projection 与旧顶层字段冲突时以前者为准。关闭时不注入任何 PTC 指引或工具 surface。

插件启用时，Client 通过公共 keyed `tool.call.toolview` 注册 `run_code` 与 `edit_run_code`；关闭时实时 dispose 两个注册，让 owner 恢复 DSH 原生 fallback。这个正文 slot 在当前和前一代 DSH Client 中使用相同的 key、`toolName`、`sessionId`、`useSessions`、运行中/已结算 `block` 与 `inspect` 契约。PTC Plus 行保留可展开的原始源码（旧式 `arguments` 与当前 `argsRaw` 都可读）、结果、可见且可访问的运行/失败/中断状态和 Inspect 入口。当前 PTC 会话显示 PTC Plus 标题；非 PTC 会话只有带有效 PTC journal 的历史结果保留 PTC Plus 身份，否则使用中性的 Code 标题。

功能标记不是计数，也不把“插件已启用”冒充成一次功能收益。Client 只在完整 v1-v3 journal 和对应附属 metadata 能证明时显示：自动改写 import（附模块名）、自动剥离 export、自动拆分混合重声明（附已有 binding）、带完整 target/derived-run/non-noop/可选恢复边界关系且与调用目标前置条件一致的安全编辑执行、成功的 `code.run`、由 `PTC-R002` 的 `warning/recover/rolled-back` 语义元组证明本次确实发生的持久重放、`repl.state` 操作，以及分别表述的 volatile 状态保留或 discarded 状态未保留。普通宽松重声明、顶层 native 调用是否来自 canonicalizer、`cordis_*` 成员是否由官方可选 Cordis mount 提供，以及是否实际选择了 prompt 恢复提示目前没有独立的 Client-only 事实，因此不根据可复制的代码形状、工具名前缀或设置默认值推测；恢复边界本身不展示。

这条路径不检查或改写宿主 DOM，不调用 Host、不主动加载历史、不写 session log，也不改变 tool schema、system prompt、runtime context、journal schema 或迁移器。未知 journal 版本、未知 metadata 字段和损坏 metadata 只会让对应功能标记缺席，不会隐藏源码或结果；无法脱离 session call identity 解析非空 legacy v1 `confirms` 时同样只省略标记，不触发历史读取或迁移。因此 UI 是否安装、能否渲染以及用户是否展开正文行，都不会改变模型请求或会话继续语义。

live 配置若因宿主能力缺失或 runtime 安装/重配置失败，会先回滚所有已创建或更新的 owner，再把持久设置回写为上一次已应用值；回滚写入失败时 Host 记录 activation diagnostic，避免静默把配置显示成不存在的 runtime。

## Client bundle

浏览器入口为 `src/client.js`，构建为 `client.js`：

```sh
npm run build
```

`package.json` 声明 `dsh.client` 与 `./client` export。`npm run build` 从 `src/client.js` 生成 `client.js`，`npm run build:check` 比较确定性产物；`prepack` 会阻止陈旧 bundle 发布。Client half 只依赖 DSH 注入面提供的 settings、locale、session、slot 与 UI primitive 模块。

## 回退

如果 DSH settings service 不可用，Host half 不会因缺少设置服务而加载失败：设置卡片不可用时直接回退为 composition `config`，
`enabled` 默认开启，原有运行时行为保持不变。
