# Client UI

PTC Plus 在 DSH Web/Desktop 的 Settings → Plugin configuration 中提供**插件设置卡片**。

Client 根入口只依赖 `settingsScope`、`slots`、`locale` 和 `connection`。头部贡献直接消费公开 session slot 提供的 `useProjection`；REPL 注册另依赖 `sessions` 的当前选择和 projection face。命令卡片等待公开 command slot，composer 入口再等待 `remote.commands` 与公开输入 hooks，不依赖已改名的 conversation registry 或未使用的 `ui-session` 模块。缺失、卸载或迟到的 slot/provider 只影响需要它的贡献；没有 `useProjection` 时不挂载依赖它的会话视图，命令卡片保留宿主结果但不提供草稿操作。没有输入 hooks 时不挂载编写快捷按钮。preset 优先读取 `agentPreset` projection，仅在缺少该 projection 时读取旧宿主公开会话摘要中的 `agentPreset`；binding 值和草稿资格不采用该回退。设置和独立正文 tool view 继续可用，不读取私有 store 或自行重建会话状态。

组件通过 renderer 提供的 `useProjection`、旧宿主的公开 `useSessions` 和注入 `hooks` 读取外部状态，设置写入与 RPC 由 apply 层注入 callback。业务组件不自行构造 external-store hook。设置、slot、provider 与插件释放共同拥有注册和订阅的生命周期；开关关闭时撤销相关贡献。

REPL 对 composer 的接管优先使用当前公开 `sessionId`/`pendingInteraction` 参数；旧宿主仅在 `session.sessionId` 匹配且 `interactions` 为空数组时允许接管。审批、提问和无法确认的交互状态继续显示宿主 composer，不通过 DOM 隐藏输入框。

这些新旧接口差异由 `src/client-host-compat.js` 集中处理：组件使用 `useSessionPreset`，注册层使用 `watchCurrentSessionPreset` 跟随当前会话及其 projection，并用 `isIdleSessionComposer` 判断 composer 资格。适配模块负责证据优先级与订阅切换、释放；`src/client.js` 负责设置开关、PTC 功能资格和 slot 生命周期。当前会话变化时重新读取公共能力，不缓存全局宿主版本或会话能力。

## 设置命名空间

Host half 通过 DSH 公共 `settings` 服务注册命名空间 `ptc-plus`。字段清单、默认值和校验来自 `internal/config-spec.js`，
由 `index.js` 的 `Config` schema 与设置注册共用；client half 构建时把同一份字段清单打进 bundle，不在 UI 中复制默认值。`CONFIG_GROUPS` 独立拥有按用途排列的展示顺序：插件总开关单独置顶，其后为“调用容错”“REPL 语法”“状态与恢复”“工具扩展”“界面显示”“资源限制”。每个字段只展示一次，各组使用独立标题、留白与分隔线。

## 可用设置

| 分组 | 字段 | 说明 |
| --- | --- | --- |
| 开关 | `enabled` | 关闭后不注册 `run_code`/`edit_run_code`、不修改 system prompt、不创建 session runtime；保留设置 UI，Host 在下一允许步骤撤销旧 PTC 声明。 |
| 调用容错 | `autoDescribeRunCode` / `canonicalizeToolCalls` | 默认开启；允许缺少外层摘要的 `run_code` 执行，并修复 schema 可唯一确认的顶层 native 工具误调用。 |
| REPL 语法 | `looseTopLevelRedeclarations` / `looseTopLevelFunctionClassRedeclarations` / `autoRewriteImports` / `autoStripExports` / `autoSplitRedeclarations` | 默认开启；控制变量重声明、可写 function/class binding 的声明位置替换、模块语法适配与混合解构重声明。 |
| 状态与恢复 | `durableReplay` / `tipsEnabled` | 默认开启；控制 worker 重启后的状态恢复与失败恢复提示。 |
| 状态与恢复 | `tipCooldownMessages` / `tipEscalationFailures` | 同类提示间隔与详细提示阈值。 |
| 工具扩展 | `userBindingsEnabled` | 默认关闭；开启后加载跨会话 TypeScript helper，并在开关下方显示管理按钮，同时启用全局绑定工作台与 `/binding` Agent 编写入口。 |
| 工具扩展 | `cordisToolsEnabled` | 默认关闭；开启后为 PTC agent 加入官方 Cordis 工具、指引与精确的 `cordis-plugin-development` companion Skill，不发布同目录 sibling。 |
| 界面显示 | `enhancedToolView` | 默认开启；关闭后注销 PTC Plus 的两个 keyed tool view，恢复 DSH 原生 generic row。 |
| 界面显示 | `replViewEnabled` | 默认开启；控制顶级 REPL 页签，关闭时释放观察订阅，不影响设置中的全局管理入口。 |
| 界面显示 | `bindingAuthorButtonVisible` | 默认开启；控制输入框的绑定编写快捷按钮，不撤销 `/binding` 命令。 |
| 资源限制 | `computeMs` / `maxWallMs` | 单 cell event-loop active（包括同步阻塞）与总耗时预算；前者不证明 CPU 消耗。 |
| 资源限制 | `maxOldGenerationSizeMb` / `maxNestedRunCodeDepth` | kernel worker 内存与嵌套执行深度。 |
| 资源限制 | `maxOutputBytes` | 单 cell 日志与返回结果的合计字节上限。 |
| 资源限制 | `maxValueNodes` / `maxValueEdges` / `maxValueArrayLength` / `maxValueBigIntDigits` | Value Graph 与大数组、BigInt 的返回上限。 |

## enabled 开关与正文功能标记

所有字段都是实时设置：Host 在 settings watch 中安装、卸载或重配置 runtime。已提交的 cell 固定使用提交时的配置快照，运行中的更新从随后提交的 cell 开始使用；这不会替换 session-bound REPL 或已有 binding。`maxOldGenerationSizeMb` 在活动 worker 存在时因 Node 的创建期限制而拒绝并回滚，其他可重配置字段照常交给 owner。关闭后唯一的宿主副作用是注册 settings 命名空间，
保证设置卡片仍然可读；此时只有 `enabled` 可写，其他控件被禁用。运行时重配置失败时回滚到上一次已应用值。

`cordisToolsEnabled` 默认关闭并即时生效。它不切换 preset，而是把官方 Cordis 工具、owner guidance 与 `cordis-plugin-development` Skill 作为一个 agent-scoped mount 加入或移出 PTC agent；顶层仍为 `run_code` / `edit_run_code`，普通 agent 不继承。Host 缺少 official preset、Skill/Cordis service 或任一 contribution 加载失败时，启用会完整回滚。完整运行要求见 [运行时参考](runtime-reference.md)。

## 全局用户 Binding 工作台

`userBindingsEnabled` 关闭时不渲染任何 Global User Binding 管理界面，Host 也不注册对应 RPC 或 Agent 命令。开启后，REPL 页签中的“全局绑定”和设置管理按钮打开的大尺寸应用内弹窗复用同一个 `UserBindingsWorkbench`。设置卡片保留开关与管理按钮，不嵌入编辑器。普通管理不依赖当前存在 PTC 会话；Agent 辅助编写仍使用当前可用会话的 `/binding` 入口。

工作台默认载入首个条目，目录支持名称过滤和启停开关。内容依次为“接口声明”“模型上下文”“实现源码”“代码控制台”“条目配置”。接口只展示源码派生声明；实现源码默认折叠、只读，展开后使用公共 `CodeBlock` 提供 TypeScript 高亮与复制。点击“编辑”后开放源码与条目配置；源码使用 CodeMirror 提供高亮、行号、撤销与重做，保存或取消后恢复只读。模型上下文可直接修改，首次改动进入编辑状态，并在条目顶部显示验证、保存和取消操作。只改模型上下文保留接口预览，其他字段变化撤销旧派生声明，验证后再展示；草稿声明不证明模型已接收。操作反馈占用稳定位置，等待 RPC 不淡化整个工作台。目录保留 `.ts` 导入，保存保留 revision 校验。桌面使用目录与内容两列，窄容器改为单列；弹窗内部滚动，支持 Escape、关闭按钮和键盘焦点回环，关闭后恢复入口焦点。

“模型上下文”编辑 `modelContext.includeDeclaration` 和 `instructions`，对应“将接口声明提供给模型”和“给模型的提示词”。声明开关默认开启，只控制已有源码派生接口的注入；非空提示词独立注入，最多 4096 字符，Host 同时检查完整启用集合的 16384 字符模型内容预算。新会话首轮及会话中途保存或启用后的下一次请求均使用当前配置，不等待绑定激活。候选历史和命令卡片保留接受时的字段；草稿保存、取消、重新加载与 revision 规则覆盖源码和提示词。取消声明勾选且清空提示词可省略模型上下文，不关闭绑定激活。

代码控制台直接执行当前条目的未保存源码草稿。用户可输入 `readText("./example.txt")`、声明变量或使用顶层 `await`，通过运行按钮或 Ctrl/Cmd+Enter 执行；下一条命令可继续使用临时变量。控制台通过 `console-run` 取得 Host 生成的 opaque environment handle，并以 `console-release` 释放；单次候选导出调用通过兼容的 `run` RPC 提供。基于 Node `repl.start` 与内置 TypeScript 转换，不连接 Agent kernel，也不写入其 journal。模块导出可直接按名称调用，相对 import 从 binding 存储目录解析。运行、停止、重置环境、清空记录分别是独立动作；折叠不重置环境。普通语法或运行错误保留状态和此前修改，停止、超时、输出超限与 worker 故障会释放环境。执行代码具有 DSH 进程的 Node/OS 权限，这种状态隔离不构成 sandbox。

首次执行才创建 worker。源码草稿改动后的下一次执行、切换条目、保存修改后的源码、离开工作台或手动重置都会清空旧环境。连续 10 分钟没有执行代码时自动释放，输入输出记录保留；下一次从当前草稿开始，绝不自动重放旧命令。Host 最多保留 4 个临时环境，每个环境一次仅执行一个命令，并沿用 `maxWallMs`、`maxOutputBytes` 和 `maxOldGenerationSizeMb`。源码与单次命令各限制 1 MiB；Client 最多保留 40 条、合计 131072 个 UTF-16 code unit 的展示记录，单条最多 65536 个，截断有明确标记。关闭全局绑定功能或插件时释放全部临时环境。

每次执行的命令与输出分开展示。输出沿用会话工具结果的灰色背景、边框和 12px 圆角，带独立标签；长结果在至多 240px 高的内容区内滚动，窄屏自动换行，错误使用错误色。设置弹窗与 REPL 页复用同一输出组件。

Client 的所有管理操作都通过 DSH Connection RPC `/ptc-plus-bindings` 发给 Host owner；Connection 在分派前执行 Host/Origin 检查与浏览器认证。Client 不直接读写 `$DSH_HOME/ptc-plus/bindings.json`，不自行判断冲突，也不把 settings 同步当作通用 RPC。Host 返回 revision、结构化条目视图和错误；外部文件变化或过期 revision 会拒绝写入。编辑中也可重新加载目录与 revision，保留未保存的源码、条目字段和编辑器状态，再由用户明确重试保存；刷新不自动重复写入，也不把磁盘内容覆盖到草稿。

保存 revision 随已加载源码保存，单独更新目录不能使缓存源码取得更新的保存资格。非编辑状态重新加载时，同步选中条目的源码、声明和编辑基线；条目已删除则清除选中内容。编辑中重新加载会保留草稿，更新保存 revision 和取消编辑后的基线；取消时显示最近读到的磁盘条目。目录与条目读取的 revision 不一致时保留原状态，提示再次重新加载。过期请求和已释放工作台的响应不能覆盖当前内容。重新加载相同源码保留临时控制台环境，源码变化或条目删除则释放环境，不自动执行命令。

PTC session 的头部弹窗在功能启用时增加 Session 与 Global 页签。Session 保留当前可复用 binding 的只读检查；Global 展示持久化目录的启停状态，可展开精确源码并预填 `/binding edit <id> `。头部摘要在 Session 显示可复用绑定总数，在 Global 显示目录条目数；数据不可用时保留空摘要行，切换页签不改变头部高度。目录条目数与“启用”状态不证明当前会话已成功激活。composer 已有非空草稿时保留原文并显示反馈；公开接口不提供 focus 时，Client 不访问宿主 DOM 强制聚焦。名称和成员被限制在各自 grid 列内，长名称与成员列表提供完整 title；编辑动作保持独立点击区域。窄弹窗不复制设置工作台的完整编辑、候选运行、启停、导入或删除功能。

接受候选时，Host 生成不可猜测的 locator，并把 locator、精确 candidate 源码和请求/命令身份放入接受结果的私有 metadata。`ptcPlusBindingDraft` projection 分别拥有可写草稿定位与只读历史；历史源码不从当前 catalog 重读。Connection RPC 没有 caller/session identity，所有草稿操作凭 locator，不信任 payload session ID。Binding 命令卡片通过公共 `conversation.chat.commandview` 的 `binding` key 接管宿主命令行，直接读取宿主折叠后的 CommandNode，不注册 turn-tail 展示或重复关联命令事件。卡片使用公共 `Button` 和 `CodeBlock` 呈现保存、丢弃与源码；缺少原语时才降级。源码区不嵌套另一层卡片边框，已结束状态紧凑排列，源码可通过原生 details 继续展开。

“保存为停用”和“保存并启用”均原子认领草稿并校验 catalog revision，后者同时写入启用状态；两者都不运行候选。并发丢弃返回 busy。保存/丢弃后立即撤销操作入口，但保留精确源码和结果；Host 的公共 action notice 引用接受结果，供日志 projection 和卡片重挂载恢复。保存回执不宣称当前会话已激活。回执未持久化且 Host 已重启时保持未知，不凭空 locator 猜测保存。目录冲突会重读 catalog、draft 和 review，保留仍有效的草稿供用户重试，不自动重复写入；权威空 draft 才撤销操作。会话结束、功能关闭或 agent disposal 撤销内存 locator；正常轮次结束只撤销未完成交接资格，已经接受的草稿继续等待用户决定。

编写中、就绪、保存和丢弃等 chrome 从结构化事实在渲染时通过 `settings.ptcPlus` 翻译，已有回执随 locale 切换。Host admission 只返回 `kind: success`，非 GUI consumer 仍能观察成功结算；历史成功 text 不参与状态渲染。原始错误、用户需求与候选源码保持原文。

`enhancedToolView` 默认开启并即时生效。开启时 PTC Plus 通过公共 keyed tool-view surface 为 `run_code` 与 `edit_run_code` 提供增强行，并在可用时使用 DSH 公共 `DisclosureRow`/`CodeBlock` primitive，缺少某项 capability 时使用插件自有的等价降级；关闭时立即注销这两个 keyed view，由 DSH 原生 generic row 负责布局、状态、代码高亮和输入/输出卡片。该开关只影响 Client 展示，不改变工具、prompt、runtime 或 session 语义。composer 星光入口与 Global 页签的 author-edit 入口同样只在使用公共 `Tooltip`/`Toast`/`IconSparkle16` 时采用原生实现：缺失 `Tooltip` 时不包 wrapper，缺失 `IconSparkle16` 时降级为纯文本按钮，缺失 `Toast` 时使用插件自有的内联状态提示。

`autoDescribeRunCode` 的设置名称是“允许执行缺少摘要的 run_code”，默认开启并即时生效。缺少外层 `run_code.description` 时，调用使用派生参数通过本地 DSH 校验，备用摘要仅进入 presentation metadata；关闭时由 DSH 校验原始参数。两种状态的模型请求保持字节稳定并包含 required `description`，原始调用参数、已有摘要、cell 源码和嵌套 native 工具参数保持不变。

设置卡片、正文 tool view 与 REPL 可复用 binding 卡片的全部文案都注册到 DSH client locale 的 `settings.ptcPlus` 命名空间，随当前界面语言在中文与 English 之间切换；字段名称与说明的两种语言文本同样来自 `internal/config-spec.js`（`label`/`labelEn`、`description`/`descriptionEn`，某一字段的说明要么两种语言都有，要么都没有），展示 chrome 文案由 client half 拥有。稳定 REPL 指引不承载 UI 品牌名。启用且会话选择 `ptc` 或兼容的 `code` preset 时，`conversation.session.header.actions` 以稳定 id `ptc-plus-active` 显示简洁的 `PTC Plus` 标识；preset 与 binding inventory 优先读取 session slot 的公共 `useProjection`；只有 preset 在缺少 projection 时可读取旧宿主公开会话摘要，binding inventory 不回退。关闭时不注入任何 PTC 指引或工具 surface。

绿色 `PTC Plus` 活动标识支持鼠标悬浮、键盘聚焦和点击。卡片通过浏览器 Popover top layer 脱离普通 stacking context，按触发器和当前视口的可用空间在上方或下方定位，因此不受会话侧栏覆盖；长列表只在卡片内部滚动。变量、函数、类和导入使用可区分的类型色彩。卡片通过标准 `useProjection("ptcPlusRepl")` 读取公共 session projection，展示当前 runtime owner 已证明可供该 agent 后续 cell 复用的 binding 名称、类别、单行定义预览以及原始行列；点击整行即可在卡片内展开有界 TypeScript 声明源码，并以抽屉式过渡动画显示。声明来源由 AST preparation 从已经提交的 cell 文本确定，BindingCatalog 在替换和 replay 时更新，不读取值、不执行代码、不触发 getter。Host 在每个结算结果的并行私有 `meta.dshPtcPlusBindings` envelope 中写入 runtime generation 和完整的 value-independent inventory；最多携带 128 项、名称最长 128 字符、每段声明源码至多 1024 个 UTF-16 code unit、声明源码合计至多 16384 个 code unit，同时保留精确有效总数和省略数。volatile cell 的 live binding 只在其精确 provenance 仍属于模型可见 state frontier 时继续显示；restore、discarded settlement 或 model-visible surface contraction 会收缩 worker，在后续 cell 重新物化有效 binding surface 前显示不可确认。

清单按最近声明或重声明优先的栈顺序排列，同一 cell 内靠后的声明位于靠前声明之上。BindingCatalog 保留这个顺序，presentation snapshot 和 projection 原样传递，不根据名称重新排序。

投影通过 DSH 正式的 `tool/call.data.callId` / `tool/result.data.message.source.callId` 身份配对 `run_code` 与 `edit_run_code`，不依赖可选 `sourceEventSeqs`。它只接受当前 runtime generation 的 envelope，并在 `session/end-seed` 清除旧 lifecycle 的 live 证明；缺少、损坏、其他 generation 的 metadata、无关 tool result 与不影响 binding provenance 的 result-only replacement 都不能覆盖仍有效的最后已证明清单。若 surface replacement 遮蔽了声明 provenance，runtime 与 projection 共用的 model-visible frontier 判定会让相关 inventory 失效。缺少有效 metadata、projection service 或兼容 registration contract 时只显示不可确认，不主动读取历史、不迁移日志，也不影响继续会话。来源跳转要求 Host 提供打开 tool call 或 source location 的公共 capability；缺少该 capability 时，卡片只提供内联检查，不访问私有 store 或宿主 DOM。

`enhancedToolView` 开启且插件启用时，Client 通过公共 keyed `tool.call.toolview` 注册 `run_code` 与 `edit_run_code`；任一开关关闭时实时 dispose 两个注册，让 owner 恢复 DSH 原生 fallback。这个正文 slot 只依赖 Host 提供的 key、`toolName`、`sessionId`、`useSessions`、运行中/已结算 `block` 与 `inspect` 公共契约。增强行保留 Code / Code edit 标题、可展开的原始源码（`arguments` 与 `argsRaw` 任一公共形态均可读）、结果、可见且可访问的运行/失败/中断状态和 Inspect 入口；在提供时优先使用公共 `DisclosureRow` 与 `CodeBlock`，缺少 `DisclosureRow` 时回退到插件自有行，缺少 `CodeBlock` 时回退为纯文本源码。`DisclosureRow` 路径把运行/失败/中断状态、摘要和已证明的功能标记放进同一行始终可见的单行预览；完成态由标题与摘要表达，运行/失败/中断状态由文字 chip 承担并保持可访问。预览间距由插件自有类对称提供，并按单行内容布局，不依赖 Host primitive 的行内几何；源码、结果和 Inspect 只出现在展开主体。结果内容与原生 ioCard 采用相同的灰色圆角背景（`--dsw-alias-markdown-code-block` 加 12px 圆角与边框），失败态使用错误色文字；代码块的语言/复制栏保持原生 CodeBlock 的常亮可见；`检查调用` 入口采用原生 inspectButton 同款胶囊样式，默认 opacity 0，仅在卡片 `:hover` 或 `:focus-visible` 时淡入（opacity .1s），不触发任何布局位移。窄屏下回退路径的摘要允许换行。

功能标记不是计数，也不把“插件已启用”冒充成一次功能收益。Client 只在完整 v1-v6 journal 和对应附属 metadata 能证明时显示：自动改写 import（附模块名）、自动剥离 export、自动拆分混合重声明（附已有 binding）、带完整 target/derived-run/non-noop/可选恢复边界关系且与调用目标前置条件一致的安全编辑执行、成功的 `code.run`、由 `PTC-R002` 的 `warning/recover/rolled-back` 语义元组证明本次确实发生的持久重放，以及 `repl.state` 操作。Client 对 v4 同时封闭校验 `bindingPolicy`、`rewritePolicy` 与 `moduleSemantics`，对 v5 还要求 `userBindingsFingerprint`，对 v6 进一步要求 `userBindingsReusePolicy` 为 `fingerprint-v1` 或 `implementation-v1`；任一缺失或畸形都不产生功能标记。进程保留或 discarded 状态不作为正文功能标记。普通变量或 function/class 重声明、顶层 native 调用是否来自 canonicalizer、`cordis_*` 成员是否由官方可选 Cordis mount 提供，以及是否实际选择了 prompt 恢复提示没有独立的 Client-only 事实，因此不根据可复制的代码形状、工具名前缀或设置默认值推测；恢复边界本身不展示。

正文工具行和头部 Session 清单不检查或改写宿主 DOM，不调用 Host、不主动加载历史。头部卡片只展示随结果持久化的名称与定义源码，不使用值预览；全局管理操作单独使用前述 Connection RPC。这些展示不改变 canonical result、tool schema、system prompt、runtime context、journal schema 或迁移器，也不向模型公开状态。未知 journal 版本、未知 metadata 字段和损坏 metadata 只会让对应功能标记或 binding 列表缺席，不会隐藏源码或结果；无法脱离 session call identity 解析非空 v1 `confirms` 时同样只省略标记，不触发历史读取或迁移。因此 UI 是否安装、能否渲染以及用户是否悬浮、聚焦或展开正文行，都不会改变模型请求或会话继续语义，也不能作为在模型 surface 收缩后继续保留 runtime binding 的证据。

## REPL 顶级页签

Client 通过公开 `conversation.view` 注册 `ptc-plus-repl`（标签 `REPL`，order 20），与对话、轨迹同级。注册作用域订阅 `sessions.list` 的当前会话及其 `agentPreset` projection face：插件与 `replViewEnabled` 开启且当前 preset 为 `ptc` 或 `code` 时注册，其余情况注销。会话切换、preset 改变、设置关闭和 provider/plugin 释放都会清理对应订阅与注册。DSH 拥有页签选择与注销后的回退；列表属于当前 browser Client，插件不创建多会话导航器。空会话的页签可见性仍由宿主 shell 决定。

REPL 根元素使用官方轨迹页同样的 `data-conversation-composer-overlay` 布局标记，由宿主提供满高视口并禁用对话宽度拖拽条；工作区内部滚动。仅在该页挂载期间，通过公开 `conversation.composer` chain 注册当前 session 专属的空替代项，隐藏普通消息输入框。宿主 overlay 保留原输入框与草稿，离开 REPL、关闭插件或释放 provider 时恢复。存在 `pendingInteraction` 时替代项不参与选择，审批、提问等宿主交互保持优先。插件不查询或改写宿主 DOM，不覆盖宿主 CSS。

REPL 是单页工作区，上方为“会话绑定”，下方直接展示完整“全局绑定”工作台，不设内部页签。会话区使用紧凑表格和相邻的绑定检查区；名称为普通等宽文字，类别为文字列。名称搜索与类型筛选只过滤已有展示清单，不请求更多观察数据；清单保留来源顺序，默认检查首个匹配条目。选中条目的定义、行列和值在检查区展示，定义使用公共 `CodeBlock` 的 TypeScript 高亮与复制按钮，缺少该原语时降级为原文。长清单在固定高度区域内滚动，窄屏将清单、检查区、全局目录和编辑器纵向排列；筛选或检查会话绑定不会重置全局编辑区。

“会话绑定”使用 `useProjection('ptcPlusRepl')` 展示名称、类别、定义源码、原始行列和有界值预览。`dshPtcPlusBindings` metadata v4 与 projection state v4 包含来源清单及可选 `observation`；只含来源清单的 v3 metadata 仍可读。观察时间位于区块标题旁，值的截断状态标在对应预览旁，无法安全观察的值显示“不可读取”，尚无观察结果则显示“尚未观察”。定义仍为已记录的有界源码片段，复制只复制当前片段，不补读历史或执行代码。预览不表示完整快照，后续异步变化不会自动刷新这份观察。

空清单或恢复后暂无清单时只显示紧凑的全宽空状态，不保留空的表格与检查区。会话观察区通过 IntersectionObserver 和文档可见性持有公开 Connection `/ptc-plus-repl` 的可取消 `watch` 请求，Host 最多接受 64 个观察订阅。只有 live cell 分派时仍有该 session 的可见订阅，才发送结算后的值观察名称。请求意外结束时清理该请求，并在仍可见时按 1、2、4 秒间隔最多重试三次；达到上限后停止计时，后续可见性或连接生命周期变化可重新尝试。区域离开视口、文档隐藏、连接替换、关闭页签开关或 provider 释放都撤销订阅和待重试计时器，旧请求结束不能撤销新请求。

清单可见但没有观察时，同一 trusted-host RPC 通过 `observe` 请求一次有界读取。只接受现存、已结算且 surface generation 未改变的 worker，并校验请求清单与当前 binding catalog 一致；不启动 worker、不执行 cell、不恢复或重放历史。请求与 cell 共用队列及 readiness 握手，连同排队最多等待 250 ms。Host 最多接受 64 个按需请求，同一 worker 有活动读取时不再增加读取。结果只保存在对应 Client 清单的局部展示状态，不回写 metadata、projection 或日志；清单变化、取消及过期响应均不能恢复旧预览。不存在后台轮询。

成功执行后，Acorn 从实际 lowered program 中证明顶层变量的 storage：`var` 通过 REPL context 的自有 data descriptor 读取并拒绝根访问器；`let`/`const` 通过 `vm.runInContext` 读取合法裸标识符，其 lexical storage 优先于同名全局属性，包括未初始化时。worker 在用户执行前对真实 evaluator 探测 await 程序的 lexical storage，通过后才支持顶层 await 的声明预览；探测失败只降级预览，不阻断执行，也不按 Node 版本分支。函数内部 await 不排除外层变量。失败 cell 不增加证明，未证明的名称不会展示碰巧同名的全局属性。值观察不调用 REPL evaluator、不改变最后求值结果、不开放调试连接。`node:util.types.isProxy` 在任何反射操作前排除 Proxy，包括 revoked Proxy；对象通过自有 descriptor 生成浅层预览，不触发 getter、原型读取、`toJSON` 或自定义 formatter。函数、Symbol、模块 namespace 和无法证明 storage 的名称显示不可读取。

最多观察 128 个名称，每项文本最多 512 个 UTF-16 code unit。数组只按固定索引读取前 5 个自有槽位，空槽明确标识，嵌套值不展开；额外自有属性未被检查，因此即使短数组也保留不完整标记。除数组外的对象统一显示不可读取，包括普通对象、TypedArray、Buffer、String 包装对象和模块 namespace；预览不枚举任何值的完整属性集合。普通字符串提供有界文本预览；BigInt 在转换前比较固定范围，至多输出 128 位，超限只显示有界提示。Worker 在 100 ms 后停止新的 lexical read，单项 VM 读取上限为 25 ms。Host 最多等待 250 ms，随后显示没有预览的已结算结果。

执行 `done` 与后续 `observation` 是独立的私有消息。待观察名称先由 `createReplMemorySnapshot` 按展示清单的名称、定义来源、条目数量和源码总预算筛选，被省略的 binding 不占用观察名额，也不影响其他条目的预览。Host 先结束 cell 的计算预算、lease 与 journal 结算，再接收可选预览；遗漏、迟到或畸形预览不改变执行结果，不触发 worker 重启。预览按最终 catalog 的名称过滤，只附加到私有 UI metadata，不进入模型上下文、canonical value 或 journal，不作为 replay 或保留隐藏 binding 的证据。cold replay 不采集历史观察，restore/discarded 与原有 generation、模型可见 frontier 失效规则共用。完整边界见 [ADR 0024](adr/0024-repl-console-observation.md)。

250 ms 只是等待可选预览的上限，不表示 worker 已就绪。下一 cell 先经私有 `prepare` / `ready` 握手，匹配的首次 `ready` 才派发代码。`computeMs` / `maxWallMs` 预算通常在发送 `prepare` 前启动；仅同一 worker 已确认开始且尚未完成的观察暂缓计时，直到收到该观察的完成消息或匹配的 `ready`。按需读取通过 `observation-started` 确认，发送请求本身不提供预算豁免；迟到确认不能暂停或重置已经启动的预算。观察身份独立于 250 ms 的展示等待记录。等待期间仍可取消，并保留 session disposal 与 worker failure 的处理；过期、畸形或重复的就绪消息不能启动额外执行。后台用户回调造成的非观察阻塞仍会正常超时和重置 worker。

live 配置若因宿主能力缺失或 runtime 安装/重配置失败，会先回滚所有已创建或更新的 owner，再把持久设置回写为上一次已应用值；回滚写入失败时 Host 记录 activation diagnostic，避免静默把配置显示成不存在的 runtime。

## Client bundle

浏览器入口为 `src/client.js`，构建为 `client.js`：

```sh
npm run build
```

`package.json` 声明 `dsh.client` 与 `./client` export，并声明当前公共 UI 模块的依赖图。`npm run build` 从 `src/client.js` 生成 `client.js`，`npm run build:check` 比较确定性产物；`prepack` 会阻止陈旧 bundle 发布。

`npm run test:client` 使用 DSH 发布的 Cordis、SlotTestRuntime、renderer 和 conversation registry/assembler 验证激活、Location 关联、响应式更新和释放。测试 loader 只适配发布的 ModuleLoader 格式，并为上游 test-runtime 缺失的两个源码引用暴露同一发布 renderer 的函数，不复制其行为。打包后的浏览器启动另由 `npm run test:client:web` 验证，前置条件与命令见 [安装指南](installation.md)。

`npm run test:client:layout -- --browser-channel msedge` 从真实 Client renderer 生成包含公共 Button/CodeBlock/Modal 和 CodeMirror CSS 的固定视图，再用 Playwright 检查 320、390、1440 px viewport 下的长中英文条目、58 条会话绑定、横向溢出、控件矩形与折叠区，包含 REPL 观察区、完整工作台和设置弹窗。截图和测量保留在 ignored `artifacts/binding-layout/`。这是几何与原生 details 验收；筛选、选中、编辑撤销、RPC、冲突、页签生命周期和 locale 行为由 `test:client` 执行，真实编辑器高亮、键盘操作、保存、宿主布局和主题由 `test:client:web` 执行。

## 回退

如果 DSH settings service 不可用，Host half 不会因缺少设置服务而加载失败：设置卡片不可用时直接回退为 composition `config`，
`enabled` 默认开启，运行时按 composition config 工作。
