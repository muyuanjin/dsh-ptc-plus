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

## enabled 开关与启用标识

所有字段都是实时设置：Host 在 settings watch 中安装、卸载或重配置 runtime。已提交的 cell 固定使用提交时的配置快照，运行中的更新从随后提交的 cell 开始使用；这不会替换 session-bound REPL 或已有 binding。`maxOldGenerationSizeMb` 在活动 worker 存在时因 Node 的创建期限制而拒绝并回滚，其他可重配置字段照常交给 owner。关闭后唯一的宿主副作用是注册 settings 命名空间，
保证设置卡片仍然可读；此时只有 `enabled` 可写，其他控件被禁用。运行时重配置失败时回滚到上一次已应用值。

`cordisToolsEnabled` 默认关闭并即时生效。它不切换 preset，而是把官方 Cordis 工具、owner guidance 与 `cordis-plugin-development` Skill 作为一个 agent-scoped mount 加入或移出 PTC agent；顶层仍为 `run_code` / `edit_run_code`，普通 agent 不继承。Host 缺少 official preset、Skill/Cordis service 或任一 contribution 加载失败时，启用会完整回滚。完整运行要求见 [运行时参考](runtime-reference.md)。

设置卡片的全部文案（字段名称与说明、折叠头部副标题、启用状态、展开/收起名称、同步与错误提示）都注册到 DSH client locale 的 `settings.ptcPlus` 命名空间，随当前界面语言在中文与 English 之间切换；字段名称与说明的两种语言文本同样来自 `internal/config-spec.js`（`label`/`labelEn`、`description`/`descriptionEn`，某一字段的说明要么两种语言都有，要么都没有），卡片 chrome 文案由 client half 拥有。稳定 REPL 指引不承载 UI 品牌名。启用且会话选择 `code` preset 时，`conversation.session.header.actions` 额外显示 `PTC Plus` 指示器，其 tooltip 也跟随界面语言。关闭时不注入任何 PTC 指引或工具 surface。

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
