# Client UI

PTC Plus 在 DSH Web/Desktop 的 Settings → Plugin configuration 中提供**插件设置卡片**。

Client 根入口只依赖 `settingsScope`、`slots`、`locale` 和 `connection`。会话贡献等待公共 `uiSession`；绑定编写的数据定义通过独立子 scope 使用 `uiConversation.events`，composer 入口再等待 `remote.commands`。缺失、卸载或迟到的可选 provider 只影响对应贡献，settings 和独立正文 tool view 继续可用；当前实现不保留旧 `conversationEvents` 或 raw Session snapshot 适配。

组件通过 renderer 提供的 `useProjection` 和注入 `hooks` 读取外部状态，设置写入与 RPC 由 apply 层注入 callback。业务组件不自行构造 external-store hook。设置、slot、provider 与插件释放共同拥有注册和订阅的生命周期；开关关闭时撤销相关贡献。

## 设置命名空间

Host half 通过 DSH 公共 `settings` 服务注册命名空间 `ptc-plus`。字段清单、默认值和校验来自 `internal/config-spec.js`，
由 `index.js` 的 `Config` schema 与设置注册共用；client half 构建时把同一份字段清单打进 bundle，不在 UI 中复制默认值。卡片按“常用与兼容性”“可选能力”“高级行为”“资源限制”分区显示，用户需要主动决策的选项位于前面。

## 可用设置

| 分组 | 字段 | 说明 |
| --- | --- | --- |
| 开关 | `enabled` | 关闭后不注册 `run_code`/`edit_run_code`、不修改 system prompt、不创建 session runtime；保留设置 UI，Host 在下一允许步骤撤销旧 PTC 声明。 |
| 展示 | `enhancedToolView` | 默认开启；关闭后注销 PTC Plus 的两个 keyed tool view，恢复 DSH 原生 generic row。 |
| 常用与兼容性 | `autoDescribeRunCode` / `canonicalizeToolCalls` | 默认开启；允许缺少外层摘要的 `run_code` 执行，并修复 schema 可唯一确认的顶层 native 工具误调用。 |
| 可选能力 | `cordisToolsEnabled` | 默认关闭；开启后为 PTC agent 加入官方 Cordis 工具、指引与精确的 `cordis-plugin-development` companion Skill，不发布同目录 sibling。 |
| 可选能力 | `userBindingsEnabled` | 默认关闭；开启后加载跨会话 TypeScript helper，并显示设置工作台、会话 Global 页签与 `/binding` Agent 编写入口。 |
| 高级行为 | `looseTopLevelRedeclarations` / `looseTopLevelFunctionClassRedeclarations` / `autoRewriteImports` / `autoStripExports` / `autoSplitRedeclarations` / `durableReplay` / `tipsEnabled` | function/class 重声明默认开启，其余默认开启；分别控制变量重声明、可写 function/class binding 的声明位置替换、模块语法适配、worker 重启后的状态恢复与失败提示。 |
| 计算 | `computeMs` / `maxWallMs` | 单 cell event-loop active（包括同步阻塞）与总耗时预算；前者不证明 CPU 消耗。 |
| Worker | `maxOldGenerationSizeMb` / `maxNestedRunCodeDepth` | kernel worker 内存与嵌套执行深度。 |
| 输出 | `maxOutputBytes` | 单 cell 日志与返回结果的合计字节上限。 |
| 返回值 | `maxValueNodes` / `maxValueEdges` / `maxValueArrayLength` / `maxValueBigIntDigits` | Value Graph 与大数组、BigInt 的返回上限。 |
| 提示阈值 | `tipCooldownMessages` / `tipEscalationFailures` | 同类提示间隔与详细提示阈值。 |

## enabled 开关与正文功能标记

所有字段都是实时设置：Host 在 settings watch 中安装、卸载或重配置 runtime。已提交的 cell 固定使用提交时的配置快照，运行中的更新从随后提交的 cell 开始使用；这不会替换 session-bound REPL 或已有 binding。`maxOldGenerationSizeMb` 在活动 worker 存在时因 Node 的创建期限制而拒绝并回滚，其他可重配置字段照常交给 owner。关闭后唯一的宿主副作用是注册 settings 命名空间，
保证设置卡片仍然可读；此时只有 `enabled` 可写，其他控件被禁用。运行时重配置失败时回滚到上一次已应用值。

`cordisToolsEnabled` 默认关闭并即时生效。它不切换 preset，而是把官方 Cordis 工具、owner guidance 与 `cordis-plugin-development` Skill 作为一个 agent-scoped mount 加入或移出 PTC agent；顶层仍为 `run_code` / `edit_run_code`，普通 agent 不继承。Host 缺少 official preset、Skill/Cordis service 或任一 contribution 加载失败时，启用会完整回滚。完整运行要求见 [运行时参考](runtime-reference.md)。

## 全局用户 Binding 工作台

`userBindingsEnabled` 关闭时不渲染任何 Global User Binding 管理界面，Host 也不注册对应 RPC 或 Agent 命令。开启后，设置卡片追加完整工作台：条目列表、源码编辑与 TypeScript 预览、scope 和用途、派生模型声明、验证、revision-checked 保存、启停、删除、从本地 `.ts` 文件导入、以及候选导出调用。编辑、条目操作和候选测试分别位于独立区段；候选运行区折叠展示 Node/OS effect 警告与输出，独立 worker 不等于安全 sandbox。

Client 的所有管理操作都通过 DSH Connection RPC `/ptc-plus-bindings` 发给 Host owner；Connection 在分派前执行 Host/Origin 检查与浏览器认证。Client 不直接读写 `$DSH_HOME/ptc-plus/bindings.json`，不自行判断冲突，也不把 settings 同步当作通用 RPC。Host 返回 revision、结构化条目视图和错误；外部文件变化或过期 revision 会拒绝写入，用户重新加载后再决定如何合并。

PTC session 的头部弹窗在功能启用时增加 Session 与 Global 页签。Session 保留当前可复用 binding 的只读检查；Global 展示持久化目录的启停状态，可展开精确源码并预填 `/binding edit <id> `。目录“启用”不证明当前会话已成功激活。composer 已有非空草稿时保留原文并显示反馈；公开接口不提供 focus 时，Client 不访问宿主 DOM 强制聚焦。名称和成员被限制在各自 grid 列内，长名称与成员列表提供完整 title；编辑动作保持独立点击区域。窄弹窗不复制设置工作台的完整编辑、候选运行、启停、导入或删除功能。

接受候选时，Host 生成不可猜测的 locator，并把 locator、精确 candidate 源码和请求/命令身份放入接受结果的私有 metadata。`ptcPlusBindingDraft` projection 分别拥有可写草稿定位与只读历史；历史源码不从当前 catalog 重读。Connection RPC 没有 caller/session identity，所有草稿操作凭 locator，不信任 payload session ID。Binding 命令卡片通过公共 `conversation.chat.commandview` 的 `binding` key 接管宿主命令行，直接读取宿主折叠后的 CommandNode；不再额外注册 turn-tail 展示或重复关联命令事件。卡片使用公共 `Button` 和 `CodeBlock` 呈现保存、丢弃与源码；缺少原语时才降级。源码区不嵌套另一层卡片边框，已结束状态紧凑排列，源码可通过原生 details 继续展开。

“保存为停用”和“保存并启用”均原子认领草稿并校验 catalog revision，后者同时写入启用状态；两者都不运行候选。并发丢弃返回 busy。保存/丢弃后立即撤销操作入口，但保留精确源码和结果；Host 的公共 action notice 引用接受结果，供日志 projection 和卡片重挂载恢复。保存回执不宣称当前会话已激活。回执未持久化且 Host 已重启时保持未知，不凭空 locator 猜测保存。目录冲突会重读 catalog、draft 和 review，保留仍有效的草稿供用户重试，不自动重复写入；权威空 draft 才撤销操作。会话结束、功能关闭或 agent disposal 撤销内存 locator；正常轮次结束只撤销未完成交接资格，已经接受的草稿继续等待用户决定。

编写中、就绪、保存和丢弃等 chrome 从结构化事实在渲染时通过 `settings.ptcPlus` 翻译，已有回执随 locale 切换。Host admission 只返回 `kind: success`，非 GUI consumer 仍能观察成功结算；历史成功 text 不参与状态渲染。原始错误、用户需求与候选源码保持原文。

`enhancedToolView` 默认开启并即时生效。开启时 PTC Plus 通过公共 keyed tool-view surface 为 `run_code` 与 `edit_run_code` 提供增强行，并在可用时使用 DSH 公共 `DisclosureRow`/`CodeBlock` primitive，缺少某项 capability 时使用插件自有的等价降级；关闭时立即注销这两个 keyed view，由 DSH 原生 generic row 负责布局、状态、代码高亮和输入/输出卡片。该开关只影响 Client 展示，不改变工具、prompt、runtime 或 session 语义。composer 星光入口与 Global 页签的 author-edit 入口同样只在使用公共 `Tooltip`/`Toast`/`IconSparkle16` 时采用原生实现：缺失 `Tooltip` 时不包 wrapper，缺失 `IconSparkle16` 时降级为纯文本按钮，缺失 `Toast` 时使用插件自有的内联状态提示。

`autoDescribeRunCode` 的设置名称是“允许执行缺少摘要的 run_code”，默认开启并即时生效。缺少外层 `run_code.description` 时，调用使用派生参数通过本地 DSH 校验，备用摘要仅进入 presentation metadata；关闭时由 DSH 校验原始参数。两种状态的模型请求保持字节稳定并包含 required `description`，原始调用参数、已有摘要、cell 源码和嵌套 native 工具参数保持不变。

设置卡片、正文 tool view 与 REPL 可复用 binding 卡片的全部文案都注册到 DSH client locale 的 `settings.ptcPlus` 命名空间，随当前界面语言在中文与 English 之间切换；字段名称与说明的两种语言文本同样来自 `internal/config-spec.js`（`label`/`labelEn`、`description`/`descriptionEn`，某一字段的说明要么两种语言都有，要么都没有），展示 chrome 文案由 client half 拥有。稳定 REPL 指引不承载 UI 品牌名。启用且会话选择 `ptc` 或兼容的 `code` preset 时，`conversation.session.header.actions` 以稳定 id `ptc-plus-active` 显示简洁的 `PTC Plus` 标识；preset 与 binding inventory 都直接读取 `uiSession` 的公共 `useProjection`，不回退到旧顶层字段。关闭时不注入任何 PTC 指引或工具 surface。

绿色 `PTC Plus` 活动标识支持鼠标悬浮、键盘聚焦和点击。卡片通过浏览器 Popover top layer 脱离普通 stacking context，按触发器和当前视口的可用空间在上方或下方定位，因此不受会话侧栏覆盖；长列表只在卡片内部滚动。变量、函数、类和导入使用可区分的类型色彩。卡片通过标准 `useProjection("ptcPlusRepl")` 读取公共 session projection，展示当前 runtime owner 已证明可供该 agent 后续 cell 复用的 binding 名称、类别、单行定义预览以及原始行列；点击整行即可在卡片内展开有界 TypeScript 声明源码，并以抽屉式过渡动画显示。声明来源由 AST preparation 从已经提交的 cell 文本确定，BindingCatalog 在替换和 replay 时更新，不读取值、不执行代码、不触发 getter。Host 在每个结算结果的并行私有 `meta.dshPtcPlusBindings` envelope 中写入 runtime generation 和完整的 value-independent inventory；最多携带 128 项、名称最长 128 字符、每段声明源码至多 1024 个 UTF-16 code unit、声明源码合计至多 16384 个 code unit，同时保留精确有效总数和省略数。volatile cell 的 live binding 只在其精确 provenance 仍属于模型可见 state frontier 时继续显示；restore、discarded settlement 或 model-visible surface contraction 会收缩 worker，在后续 cell 重新物化有效 binding surface 前显示不可确认。

清单按最近声明或重声明优先的栈顺序排列，同一 cell 内靠后的声明位于靠前声明之上。BindingCatalog 保留这个顺序，presentation snapshot 和 projection 原样传递，不根据名称重新排序。

投影通过 DSH 正式的 `tool/call.data.callId` / `tool/result.data.message.source.callId` 身份配对 `run_code` 与 `edit_run_code`，不依赖可选 `sourceEventSeqs`。它只接受当前 runtime generation 的 envelope，并在 `session/end-seed` 清除旧 lifecycle 的 live 证明；缺少、损坏、其他 generation 的 metadata、无关 tool result 与不影响 binding provenance 的 result-only replacement 都不能覆盖仍有效的最后已证明清单。若 surface replacement 遮蔽了声明 provenance，runtime 与 projection 共用的 model-visible frontier 判定会让相关 inventory 失效。缺少有效 metadata、projection service 或兼容 registration contract 时只显示不可确认，不主动读取历史、不迁移日志，也不影响继续会话。来源跳转要求 Host 提供打开 tool call 或 source location 的公共 capability；缺少该 capability 时，卡片只提供内联检查，不访问私有 store 或宿主 DOM。

`enhancedToolView` 开启且插件启用时，Client 通过公共 keyed `tool.call.toolview` 注册 `run_code` 与 `edit_run_code`；任一开关关闭时实时 dispose 两个注册，让 owner 恢复 DSH 原生 fallback。这个正文 slot 只依赖 Host 提供的 key、`toolName`、`sessionId`、`useSessions`、运行中/已结算 `block` 与 `inspect` 公共契约。增强行保留 Code / Code edit 标题、可展开的原始源码（`arguments` 与 `argsRaw` 任一公共形态均可读）、结果、可见且可访问的运行/失败/中断状态和 Inspect 入口；在提供时优先使用公共 `DisclosureRow` 与 `CodeBlock`，缺少 `DisclosureRow` 时回退到插件自有行，缺少 `CodeBlock` 时回退为纯文本源码。`DisclosureRow` 路径把运行/失败/中断状态、摘要和已证明的功能标记放进同一行始终可见的单行预览；完成态由标题与摘要表达，运行/失败/中断状态由文字 chip 承担并保持可访问。预览间距由插件自有类对称提供，并按单行内容布局，不依赖 Host primitive 的行内几何；源码、结果和 Inspect 只出现在展开主体。结果内容与原生 ioCard 采用相同的灰色圆角背景（`--dsw-alias-markdown-code-block` 加 12px 圆角与边框），失败态使用错误色文字；代码块的语言/复制栏保持原生 CodeBlock 的常亮可见；`检查调用` 入口采用原生 inspectButton 同款胶囊样式，默认 opacity 0，仅在卡片 `:hover` 或 `:focus-visible` 时淡入（opacity .1s），不触发任何布局位移。窄屏下回退路径的摘要允许换行。

功能标记不是计数，也不把“插件已启用”冒充成一次功能收益。Client 只在完整 v1-v5 journal 和对应附属 metadata 能证明时显示：自动改写 import（附模块名）、自动剥离 export、自动拆分混合重声明（附已有 binding）、带完整 target/derived-run/non-noop/可选恢复边界关系且与调用目标前置条件一致的安全编辑执行、成功的 `code.run`、由 `PTC-R002` 的 `warning/recover/rolled-back` 语义元组证明本次确实发生的持久重放，以及 `repl.state` 操作。Client 对 v4 同时封闭校验 `bindingPolicy`、`rewritePolicy` 与 `moduleSemantics`，对 v5 还要求 `userBindingsFingerprint`；任一缺失或畸形都不产生功能标记。进程保留或 discarded 状态不作为正文功能标记。普通变量或 function/class 重声明、顶层 native 调用是否来自 canonicalizer、`cordis_*` 成员是否由官方可选 Cordis mount 提供，以及是否实际选择了 prompt 恢复提示没有独立的 Client-only 事实，因此不根据可复制的代码形状、工具名前缀或设置默认值推测；恢复边界本身不展示。

这条路径不检查或改写宿主 DOM，不调用 Host、不主动加载历史。binding 卡片只消费随结果持久化的 value-independent presentation metadata，其中源码只是已提交 cell 的有界声明片段，不是运行时值；它不改变 canonical result、tool schema、system prompt、runtime context、journal schema 或迁移器，也不向模型公开状态。未知 journal 版本、未知 metadata 字段和损坏 metadata 只会让对应功能标记或 binding 列表缺席，不会隐藏源码或结果；无法脱离 session call identity 解析非空 v1 `confirms` 时同样只省略标记，不触发历史读取或迁移。因此 UI 是否安装、能否渲染以及用户是否悬浮、聚焦或展开正文行，都不会改变模型请求或会话继续语义，也不能作为在模型 surface 收缩后继续保留 runtime binding 的证据。

live 配置若因宿主能力缺失或 runtime 安装/重配置失败，会先回滚所有已创建或更新的 owner，再把持久设置回写为上一次已应用值；回滚写入失败时 Host 记录 activation diagnostic，避免静默把配置显示成不存在的 runtime。

## Client bundle

浏览器入口为 `src/client.js`，构建为 `client.js`：

```sh
npm run build
```

`package.json` 声明 `dsh.client` 与 `./client` export，并声明当前公共 UI 模块的依赖图。`npm run build` 从 `src/client.js` 生成 `client.js`，`npm run build:check` 比较确定性产物；`prepack` 会阻止陈旧 bundle 发布。

`npm run test:client` 使用 DSH 发布的 Cordis、SlotTestRuntime、renderer 和 conversation registry/assembler 验证激活、Location 关联、响应式更新和释放。测试 loader 只适配发布的 ModuleLoader 格式，并为上游 test-runtime 缺失的两个源码引用暴露同一发布 renderer 的函数，不复制其行为。打包后的浏览器启动另由 `npm run test:client:web` 验证，前置条件与命令见 [安装指南](installation.md)。

`npm run test:client:layout -- --browser-channel msedge` 从真实 Client renderer 生成包含公共 Button/CodeBlock CSS 的固定视图，再用 Playwright 检查 320、390、1440 px viewport 下的长中英文条目、保存前后、源码展开、横向溢出、控件矩形与键盘展开。截图和测量保留在 ignored `artifacts/binding-layout/`。这是几何与原生 details 验收；RPC、冲突和 locale 行为由 `test:client` 执行，完整打包宿主由 `test:client:web` 执行。

## 回退

如果 DSH settings service 不可用，Host half 不会因缺少设置服务而加载失败：设置卡片不可用时直接回退为 composition `config`，
`enabled` 默认开启，运行时按 composition config 工作。
