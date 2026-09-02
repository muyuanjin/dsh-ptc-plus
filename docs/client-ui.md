# Client UI

PTC Plus 在 DSH Web/Desktop 的 Settings → Plugin configuration 中提供**插件设置卡片**。

## 设置命名空间

Host half 通过 DSH 公共 `settings` 服务注册命名空间 `ptc-plus`。字段清单、默认值和校验来自 `internal/config-spec.js`，
由 `index.js` 的 `Config` schema 与设置注册共用；client half 构建时把同一份字段清单打进 bundle，不在 UI 中复制默认值。卡片先连续显示布尔开关，再连续显示数值输入。

## 可用设置

| 分组 | 字段 | 说明 |
| --- | --- | --- |
| 开关 | `enabled` | 关闭后不注册 `run_code`/`edit_run_code`、不修改 system prompt、不创建 session runtime；只保留设置 UI。 |
| 展示 | `enhancedToolView` | 默认开启；关闭后注销 PTC Plus 的两个 keyed tool view，恢复 DSH 原生 generic row。 |
| Transport | `canonicalizeToolCalls` / `autoDescribeRunCode` | 默认开启；修复 schema 可唯一确认的顶层 native 工具误调用，并为缺少外层摘要的 `run_code` 请求生成固定 UI 摘要。 |
| REPL | `looseTopLevelRedeclarations` / `autoRewriteImports` / `autoStripExports` / `autoSplitRedeclarations` / `durableReplay` | 默认开启；控制跨 cell 重声明、模块语法适配与 worker 重启后的状态恢复。 |
| 提示 | `tipsEnabled` | 默认开启；在符合条件的重复失败后显示恢复提示。 |
| Cordis | `cordisToolsEnabled` | 默认关闭；开启后为 PTC agent 加入官方 Cordis 工具、指引与精确的 `cordis-plugin-development` companion Skill，不发布同目录 sibling。 |
| 计算 | `computeMs` / `maxWallMs` | 单 cell CPU 与总耗时预算。 |
| Worker | `maxOldGenerationSizeMb` / `maxNestedRunCodeDepth` | kernel worker 内存与嵌套执行深度。 |
| 输出 | `maxOutputBytes` | 单 cell 日志与返回结果的合计字节上限。 |
| 返回值 | `maxValueNodes` / `maxValueEdges` / `maxValueArrayLength` / `maxValueBigIntDigits` | Value Graph 与大数组、BigInt 的返回上限。 |
| 提示阈值 | `tipCooldownMessages` / `tipEscalationFailures` | 同类提示间隔与详细提示阈值。 |

## enabled 开关与正文功能标记

所有字段都是实时设置：Host 在 settings watch 中安装、卸载或重配置 runtime。已提交的 cell 固定使用提交时的配置快照，运行中的更新从随后提交的 cell 开始使用；这不会替换 session-bound REPL 或已有 binding。`maxOldGenerationSizeMb` 在活动 worker 存在时因 Node 的创建期限制而拒绝并回滚，其他可重配置字段照常交给 owner。关闭后唯一的宿主副作用是注册 settings 命名空间，
保证设置卡片仍然可读；此时只有 `enabled` 可写，其他控件被禁用。运行时重配置失败时回滚到上一次已应用值。

`cordisToolsEnabled` 默认关闭并即时生效。它不切换 preset，而是把官方 Cordis 工具、owner guidance 与 `cordis-plugin-development` Skill 作为一个 agent-scoped mount 加入或移出 PTC agent；顶层仍为 `run_code` / `edit_run_code`，普通 agent 不继承。Host 缺少 official preset、Skill/Cordis service 或任一 contribution 加载失败时，启用会完整回滚。完整运行要求见 [运行时参考](runtime-reference.md)。

`enhancedToolView` 默认开启并即时生效。开启时 PTC Plus 通过公共 keyed tool-view surface 为 `run_code` 与 `edit_run_code` 提供增强行，并在可用时使用 DSH 公共 `DisclosureRow`/`CodeBlock` primitive，缺少某项 capability 时使用插件自有的等价降级；关闭时立即注销这两个 keyed view，完全恢复 DSH 原生 generic row，让 Host 自己拥有布局、状态、代码高亮、输入/输出卡片和后续视觉更新。该开关只影响 Client 展示，不改变工具、prompt、runtime 或 session 语义。

`autoDescribeRunCode` 默认开启并即时生效。schema 投影允许省略顶层 `run_code.description`，执行桥向 DSH 参数校验器提供派生的固定摘要，并仅将该摘要的持久副本写入 presentation metadata；原始调用参数、已有摘要、cell 源码和嵌套 native 工具参数均保持原样。关闭时继续由 DSH schema 严格要求外层摘要。

设置卡片、正文 tool view 与 REPL 可复用 binding 卡片的全部文案都注册到 DSH client locale 的 `settings.ptcPlus` 命名空间，随当前界面语言在中文与 English 之间切换；字段名称与说明的两种语言文本同样来自 `internal/config-spec.js`（`label`/`labelEn`、`description`/`descriptionEn`，某一字段的说明要么两种语言都有，要么都没有），展示 chrome 文案由 client half 拥有。稳定 REPL 指引不承载 UI 品牌名。启用且会话选择当前 `ptc` 或旧 Host `code` preset 时，`conversation.session.header.actions` 以稳定 id `ptc-plus-active` 显示原有的简洁 `PTC Plus` 标识；当前 session projection 与旧顶层字段冲突时以前者为准。关闭时不注入任何 PTC 指引或工具 surface。

绿色 `PTC Plus` 活动标识支持鼠标悬浮、键盘聚焦和点击。卡片通过浏览器 Popover top layer 脱离普通 stacking context，按触发器和当前视口的可用空间在上方或下方定位，因此不受会话侧栏覆盖；长列表只在卡片内部滚动。变量、函数、类和导入使用可区分的类型色彩。卡片读取公共 `sessionProjections` 携带的 `projectionValues.ptcPlusRepl`，展示当前 runtime owner 已证明可供该 agent 后续 cell 复用的 binding 名称、类别、单行定义预览以及原始行列；点击整行即可在卡片内展开有界 TypeScript 声明源码，并以抽屉式过渡动画显示。声明来源由 AST preparation 从已经提交的 cell 文本确定，BindingCatalog 在替换和 replay 时更新，不读取值、不执行代码、不触发 getter。Host 在每个结算结果的并行私有 `meta.dshPtcPlusBindings` envelope 中写入 runtime generation 和完整的 value-independent inventory；最多携带 128 项、名称最长 128 字符、每段声明源码至多 1024 个 UTF-16 code unit、声明源码合计至多 16384 个 code unit，同时保留精确有效总数和省略数。volatile cell 的 live binding 继续显示；restore 或 discarded settlement 重置 worker，在后续 cell 重新物化有效 binding surface 前显示不可确认。

清单按最近声明或重声明优先的栈顺序排列，同一 cell 内靠后的声明位于靠前声明之上。BindingCatalog 保留这个顺序，presentation snapshot 和 projection 原样传递，不根据名称重新排序。

投影通过 DSH 正式的 `tool/call.data.callId` / `tool/result.data.message.source.callId` 身份配对 `run_code` 与 `edit_run_code`，不依赖可选 `sourceEventSeqs`。它只接受当前 runtime generation 的 envelope，并在 `session/end-seed` 清除旧 lifecycle 的 live 证明；缺少、损坏、其他 generation 的 metadata、无关 tool result 与 surface replacement 都不能覆盖仍有效的最后已证明清单。旧 metadata、旧日志、Host 缺少 projection service 或不兼容的 registration contract 时只显示不可确认，不主动读取历史、不迁移日志，也不影响继续会话。DSH header-action 公共 kit 没有打开 tool call 或 source location 的导航 capability 时，这里不使用私有 store 或 DOM selector 伪造跳转；只有 Host 提供对应公共 capability 后才可增加真正的跳转。

`enhancedToolView` 开启且插件启用时，Client 通过公共 keyed `tool.call.toolview` 注册 `run_code` 与 `edit_run_code`；任一开关关闭时实时 dispose 两个注册，让 owner 恢复 DSH 原生 fallback。这个正文 slot 只依赖 Host 提供的 key、`toolName`、`sessionId`、`useSessions`、运行中/已结算 `block` 与 `inspect` 公共契约。增强行保留 Code / Code edit 标题、可展开的原始源码（`arguments` 与 `argsRaw` 任一公共形态均可读）、结果、可见且可访问的运行/失败/中断状态和 Inspect 入口；在提供时优先使用公共 `DisclosureRow` 与 `CodeBlock`，缺少 `DisclosureRow` 时回退到插件自有行，缺少 `CodeBlock` 时回退为纯文本源码。`DisclosureRow` 路径把运行/失败/中断状态、摘要和已证明的功能标记放进同一行始终可见的单行预览；完成态不再重复显示状态文字（标题与摘要已表达），运行/失败/中断状态由文字 chip 承担并保持可访问。预览间距由插件自有类对称提供，并按单行内容布局，不依赖 Host primitive 的行内几何；源码、结果和 Inspect 只出现在展开主体。结果内容与原生 ioCard 采用相同的灰色圆角背景（`--dsw-alias-markdown-code-block` 加 12px 圆角与边框），失败态使用错误色文字；代码块的语言/复制栏保持原生 CodeBlock 的常亮可见；`检查调用` 入口采用原生 inspectButton 同款胶囊样式，默认 opacity 0，仅在卡片 `:hover` 或 `:focus-visible` 时淡入（opacity .1s），不触发任何布局位移。窄屏下回退路径的摘要允许换行。

功能标记不是计数，也不把“插件已启用”冒充成一次功能收益。Client 只在完整 v1-v3 journal 和对应附属 metadata 能证明时显示：自动改写 import（附模块名）、自动剥离 export、自动拆分混合重声明（附已有 binding）、带完整 target/derived-run/non-noop/可选恢复边界关系且与调用目标前置条件一致的安全编辑执行、成功的 `code.run`、由 `PTC-R002` 的 `warning/recover/rolled-back` 语义元组证明本次确实发生的持久重放，以及 `repl.state` 操作。进程保留或 discarded 状态不作为正文功能标记。普通宽松重声明、顶层 native 调用是否来自 canonicalizer、`cordis_*` 成员是否由官方可选 Cordis mount 提供，以及是否实际选择了 prompt 恢复提示没有独立的 Client-only 事实，因此不根据可复制的代码形状、工具名前缀或设置默认值推测；恢复边界本身不展示。

这条路径不检查或改写宿主 DOM，不调用 Host、不主动加载历史。binding 卡片只消费随结果持久化的 value-independent presentation metadata，其中源码只是已提交 cell 的有界声明片段，不是运行时值；它不改变 canonical result、tool schema、system prompt、runtime context、journal schema 或迁移器。未知 journal 版本、未知 metadata 字段和损坏 metadata 只会让对应功能标记或 binding 列表缺席，不会隐藏源码或结果；无法脱离 session call identity 解析非空 legacy v1 `confirms` 时同样只省略标记，不触发历史读取或迁移。因此 UI 是否安装、能否渲染以及用户是否悬浮、聚焦或展开正文行，都不会改变模型请求或会话继续语义。

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
