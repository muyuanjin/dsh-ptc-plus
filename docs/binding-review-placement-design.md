# Binding 草稿在当前输入框上方展示

状态：已实现并通过官方打包浏览器验收。完整草稿由已发布的 `conversation.input.dock` 承载；历史命令位置只保留请求和只读来源。

## 产品目标与分发边界

`/binding new` 和 `/binding edit` 产生的完整草稿应直接出现在当前会话的最新操作位置，即普通用户输入框上方。每份新候选首次接受后自动展开，用户无需滚回命令起点、悬停或先打开弹窗，就能阅读源码、模型上下文并保存或丢弃草稿；此后可以主动折叠或关闭面板。

卡片是插件自己的当前草稿审阅区，可以是独立面板；不要求成为某个历史 Turn 内的消息节点，也不要求复用原生回答 renderer。后续回答继续追加时，未处理的当前草稿仍跟随输入区。历史记录用于追溯，当前操作区用于处理草稿，两者的位置不必相同。

会话历史中的 `/binding` 编写请求始终保留原来的初始样式：标题、状态标识、原始命令与需求、适用的失败说明。草稿生成后，该条目只更新状态，不再自动长成带源码和保存操作的完整卡片。迁移到 dock 的是接受候选后的详细内容与操作区，不是编写请求本身。

PTC Plus 必须独立安装到未经修改的官方 DSH，不能修改宿主源码或安装包、要求定制宿主，或把自行新增的宿主接口当作已发布能力。[CONTEXT.md](../CONTEXT.md) 与 [ADR 0017](adr/0017-track-the-latest-dsh-public-surface.md) 拥有此边界。插件自有组件、独立 div、CSS、Portal、页面浮层和公共 renderer 替换都是 UI 工具，不因偏离原生消息布局而被排除；选择依据是实际位置、可分发性、生命周期和宿主职责是否得到保留。

本功能的成功条件是：完整草稿默认展开、输入框仍可用、当前候选不会串会话或恢复过期操作权限、官方内容与其他插件继续共存。插件不额外接管审批、取消或绑定持久化，不为移动 UI 改变模型请求、journal 或绑定执行。

## 选定落点：`conversation.input.dock`

官方声明把该 slot 定义为 **“Full-width entries above the composer card”**：`kind: list`、`scope: session`，owner 为 `InputZone { session, input }`。原生 `ConversationRoot` 在普通 composer 栈中先渲染 dock，再渲染输入框。官方 Todo、Goal 和输入队列都通过独立 id 贡献到这里。

```text
会话历史
  绑定编写：/binding new 或 edit 的原始请求（保留初始样式，更新状态）
  后续正文与工具过程
原生回答尾部、文件产物与操作
──────────────────────────
当前输入区
  Todo / Goal / 输入队列等 dock 内容
  PTC Plus 完整 Binding 草稿卡片
    名称、用途、导出信息
    完整源码与模型上下文（默认展开，内部可滚动）
    保存为停用 / 保存并启用 / 丢弃
  用户输入框
```

插件以独立 id `ptc-plus-binding-review` 注册，初始 `order: 30`，跟随已核对的官方贡献顺序；这不是独占“最后一个子节点”的保证。其他插件仍可在本卡片与输入框之间追加内容，只要卡片属于当前输入区上方，就满足位置要求。

该落点不参与 Chat 节点排序，不占用 `turnTail` 的 chain，也不需要调用原生 renderer 再拆解其结果。宿主继续拥有正文、原生尾部、文件产物、分支和滚动容器；插件拥有面板内部渲染与样式。不得用额外的虚假事件把 UI 布局写进 session log。

| 方案 | 适用性与本次选择 |
| --- | --- |
| `conversation.input.dock` 中的独立面板 | 已发布的 session list，直接满足输入框上方的目标；本次采用。 |
| 页面浮层、Portal 或附加面板 | 可用于插件 UI；本需求已有准确落点，不必另行维护定位、遮挡和窗口尺寸同步。 |
| 替换公开 renderer，再组合公开组件 | 公共契约支持时可以使用；本需求无需接管原生回答渲染。没有公开的“下一个 renderer”入口时，不假定可以组合任意注册项。 |
| 独立 Conversation 节点 | 适合需要历史位置的业务内容；当前目标不需要，而且同轮尾部节点可能改变原生分支资格。 |
| 命令位置或原生操作行 | 前者位置过早，后者是紧凑操作区；不作为当前完整审阅的落点。 |

## 数据来源与当前草稿选择

复用 `internal/user-binding-draft-projection.js` 的 `ptcPlusBindingDraft`，以及 `internal/user-bindings-owner.js` 现有 RPC。当前 view 包含 `phase`、`capability`、`commandId` 和可选 `history`；历史记录保存 `acceptedSeq`、精确 candidate 及 action 的正式来源关系。源码、请求身份、版本和 `modelContext` 都已有 owner。

面板选择当前 projection 标识的编写请求。`commandId` 关联命令；candidate 的 `requestId` 和 `version` 区分草稿；当前 `capability` 仅用于现有 Host RPC。不能通过“history 最后一条尚未保存”或原始日志扫描推测可操作候选，也不能把历史 request 身份当作 locator。

匹配当前请求的已接受 history 可以立即提供只读完整内容；`draft` 与 `draft-review` RPC 则确认当前候选及操作状态，`list` 提供 catalog revision。RPC 返回的请求、命令和版本必须与正在展示的候选一致，才能启用写操作；不一致时刷新现有 owner 的证据，不能在 A 的源码下面放 B 的保存按钮。旧 metadata 没有历史源码时使用现有 RPC 读取路径，不从模型正文提取代码补齐。

草稿一旦被 Host 接受并投影即可显示，即使模型还在输出。`command/done` 只表达命令处理，不证明有草稿；`turn/end` 继续由既有 projection 用于编写失败等状态判断，不是面板出现的前置条件。成功接受后的输出、普通工具调用、无最终正文或后续取消，都不由 Client 自行推断为撤销草稿。

历史请求的状态与当前可操作草稿分别按证据派生。请求条目复用原有外观，但状态文案必须表达已有证据，不能为保留外观继续显示无法证明的“正在编写”或“编写失败”：

| 精确关联到该请求的证据 | 可展示的事实 |
| --- | --- |
| CommandNode 的命令处理错误 | 命令处理失败与宿主提供的错误；它不代表其他请求的草稿状态。 |
| CommandNode 的命令处理成功 | 请求已受理；单凭这一结果不能判定草稿已生成。 |
| 当前 projection 的 `commandId` 匹配，且 `phase` 为 `pending` 或 `failed` | 分别显示正在编写或未生成可保存草稿；该当前状态不能归到其他历史请求。 |
| 对应的已接受 candidate/history | 草稿已生成及其精确内容；没有当前 locator 时仍只是只读证据。 |
| 对应的 Host action 回执 | 已保存或已丢弃；跨重建只使用现有 RPC 或带正式来源关系的历史回执，不由 locator 消失推断结果。 |
| 没有候选或回执，当前 projection 也不再标识该请求 | 保留可证明的命令处理结果；编写结果显示未知，不推断仍在运行、已失败或已被替换。 |

已接受 candidate 和 action 分别拥有生成与处理结果；当前 projection 拥有当前编写状态和 locator。命令准入结果不覆盖这些事实。当前 RPC 确认的结果沿用既有展示规则，不被提升为已经持久化的历史回执。

例如 A 已有草稿，B 命令成功准入后整轮未接受候选，既有 projection 会恢复到 `A.ready`，并不保留 B 的编写终态。此时 A 按原展示选择恢复；B 在缺少独立终态证据时显示“请求已受理，编写结果未知”。重新挂载、分页和重连采用相同规则，不能通过 A 恢复、B 不在 history 中或临时 Client 缓存来证明 B 失败。此需求按现有证据明确表达未知即可，不新增日志事件或投影字段来补造结论。

本次位置调整不需要 `acceptedTurn`、新 Conversation Definition、额外位置 metadata、projection 升版或 journal 迁移。若实施发现现有数据不足以满足上述选择规则，先记录具体反例和最小 owner 修正，再调整计划；不能为布局预先增加恢复协议。

## 展示与操作生命周期

| 状态或事件 | 当前输入区的行为 |
| --- | --- |
| 没有可展示的当前候选或已确认回执 | dock 不占空间；历史请求及其已有候选仍可只读查看，不从历史挑一份升级为当前草稿。 |
| 编写中 | 原命令条目保留已有编写状态；dock 不重复展示一份编写请求，也不把上一份草稿冒充本次结果。 |
| 已接受，正在确认操作资格 | 新候选首次在 dock 展开，操作按钮暂不可用并说明正在载入。目录读取慢不应让已知源码消失；用户主动折叠或关闭后，读取完成不强制展开。 |
| 当前草稿可用 | 按用户选择保持展开、折叠或关闭；展开时显示完整内容和模型上下文，保留保存为停用、保存并启用、丢弃及既有 revision 冲突处理。 |
| 保存或丢弃成功 | 按下文显隐与结果组合表更新回执，保持用户的展开、折叠或关闭选择；历史保留精确候选和有证据的 action。保存不等于会话已激活。 |
| 编写失败或旧草稿恢复 | 原请求只显示上述证据规则支持的状态；缺少证据时显示编写结果未知。没有已接受候选就不产生完整 dock 卡片。Host 恢复旧草稿时沿用该候选的展示选择，不自行改变 fallback 规则。 |
| 资格撤销、Host 重启或只剩历史证据 | 对仍能证明属于当前显示内容的候选保留只读查看；撤下写操作。没有当前身份时不把历史重新挑成活动草稿。 |
| 开始下一次编写 | 当前区跟随新的 projection；旧候选留在历史位置，不能跨请求沿用 busy、错误、回执或 locator。 |
| 切换会话、断线重连、分支或 seed | 按新会话 projection 重建；加载期间禁止沿用旧会话内容和写权限。历史可见性与当前资格分别判断。 |
| 禁用功能、释放 slot 或卸载插件 | 释放本功能拥有的订阅、计时器和面板；不自动保存、丢弃或执行候选。 |

同一会话只保留一个当前完整审阅 controller，按会话、请求、版本和 locator 隔离异步读取与动作。`conversation.chat.commandview` 的 `binding` key 继续渲染原有编写请求，不能因 dock 已注册、已出现或被关闭而返回空内容。保留 `BindingCommandCard` 的请求外观和状态区，只移走候选详细内容及写操作。所需展示能力可用且该请求精确对应尚未处理的当前候选时，必须提供“打开草稿”入口，用于展开 dock，不重新执行 `/binding`；隐藏编写按钮的设置不影响该入口。历史主动查看仍可展开只读源码，但接受候选不得自动展开历史详情，也不能在历史中恢复保存或丢弃按钮。

现有页头 popover 的候选展示与保存/丢弃入口也应收拢：保留状态与管理入口，不再创建第二套当前草稿写入流程。历史只读内容可以复用展示组件，但不能恢复控制器或写权限。

抽取现有 `BindingCommandCard` 的展示和 RPC 行为时，分别保留请求条目、纯候选内容组件与当前审阅 controller。不要仅把依赖 `node.commandId` 的原组件直接塞入没有 Command node 的 dock，再伪造 node 参数。未处理草稿不因超时或下一条普通消息自动消失；用户主动调整面板只改变本地展示。

写操作仍使用 `save-draft` / `discard-draft`，传递现有 capability、version 及适用的 expected revision。请求切换、组件卸载或资格变动后的迟到响应不能恢复旧按钮；一次失败读取不证明候选已被撤销。待决写入按精确候选隔离：同一候选不重复提交，接受新候选后可独立读取资格和操作，旧响应不能阻塞新候选或清除其 busy 状态。已有必要的资格刷新可以复用，但不能为确定位置或等待回答结束新增轮询、事件订阅或第二套状态机。

## 折叠、展开、关闭与重新打开

面板标题栏提供明确的折叠/展开和关闭按钮；完整内容默认展开不等于禁止用户收起。

| 用户操作 | 展示结果与草稿状态 |
| --- | --- |
| 折叠 | dock 保留名称、状态、展开和关闭按钮，收起正文及保存/丢弃操作；不改变候选或编写事务。 |
| 展开 | 未处理候选在原 dock 位置恢复完整内容；已处理候选显示紧凑回执。写操作仍以当前 Host 证据为准。 |
| 关闭 | 隐藏整个 dock 面板，不保存、不丢弃、不取消编写，也不删除历史请求。 |
| 重新打开 | 输入框旁的“草稿”入口或当前历史请求的“打开草稿”展开同一当前候选；不重新发命令、生成候选或创建第二个操作 controller。 |
| 丢弃草稿 | 仅明确点击“丢弃”才调用既有 Host RPC；它与关闭面板是不同操作。 |

所需展示能力可用、普通输入区未被接管且未处理的当前面板被关闭时，必须在公开 `conversation.input.left` 显示紧凑“草稿”入口，使用户无需翻历史即可重新打开。它是当前草稿的访问入口，与“新建绑定”的编写按钮分开，不受隐藏编写按钮的偏好控制；它仍受插件与全局绑定功能开关控制。原请求条目中的入口只能打开其精确对应的当前候选；旧请求只允许查看自己的只读历史，不能意外打开另一请求的可写草稿。宿主接管或展示能力暂不可用时，不提供实际无法打开面板的操作。

展示选择以 `(sessionId, requestId, candidateVersion)` 归属，只有 `expanded`、`collapsed`、`hidden` 三种本地状态。当前 Client 内切换会话再返回、RPC 刷新、重连、普通消息追加以及审批临时接管，不重置同一候选的选择；真正接受的新候选默认展开。刷新页面或重新加载插件后按当前有效候选恢复默认展开，不要求把展示偏好写入持久存储。共享此选择只协调插件视图，不承载 locator 或 Host 事务资格，也不增加 session log、模型消息或管理 RPC。

业务结果与显隐是独立维度。异步结算只改变结果，不改变 `expanded`、`collapsed` 或 `hidden`，也不重新执行“新候选首次展开”：

| 结算时的展示选择 | 保存或丢弃已确认成功 | 写入失败或结果待确认 |
| --- | --- | --- |
| `expanded` | 原位显示紧凑回执，撤下写操作，可关闭；精确源码从原请求只读查看。 | 保留完整面板并展示错误或待确认状态；仅在重新证明可写后允许手动重试。 |
| `collapsed` | 保持折叠，标题状态更新为处理结果，不自动展开。 | 保持折叠，标题提示有错误或结果待确认，允许用户展开查看。 |
| `hidden` | 保持关闭，不弹回执；原请求展示有证据的处理结果。 | 保持关闭，保留就近重新打开入口并提示有待查看状态，不自动展开或重试。 |

关闭或折叠待决操作中的面板不取消已发出的保存/丢弃 RPC；操作结算仍由同一 controller 接收。未确认处理结果时保留当前候选的访问入口，但入口不证明可以再次写入；一次网络错误不能触发重新提交。已确认保存或丢弃后移除两个当前草稿打开入口，结果和精确候选继续从原历史请求只读查看。既已在 dock 展示且身份明确的回执可以保留到用户关闭或新编写请求替代；locator 撤销不否定已确认结果，也不能从历史列表自动挑选一条回执重新打开 dock。

用户关闭时，焦点移到就近的“草稿”入口；关闭已处理回执且没有该入口时回到输入框。异步成功移除当前聚焦的打开入口时也应保持合理焦点，不能将其留在已移除节点；宿主接管时不从审批界面抢焦点。折叠按钮提供 `aria-expanded`，被隐藏的内容不得继续接受键盘焦点。

## 输入区接管与布局边界

官方普通 composer 是 `conversation.composer` chain 的 fallback。当前实现使用 `overlay: true`：其他 contribution 被选中时，fallback 保持挂载但被 `display:none` 隐藏，因此 input dock 也会隐藏。**注册成功不等于任何时候都可见；隐藏也不等于已卸载。**

审批或其他宿主交互接管输入区时，草稿区和重新打开入口随普通输入框一起暂时让位，不通过 Portal 把保存按钮强行叠到审批上。PTC Plus 的 REPL 视图接管 composer 时也按此规则隐藏；回到普通输入区后恢复同一份有效草稿及其原有展开、折叠或关闭选择。重建时读取 projection 和 RPC，不依靠隐藏 DOM 保留权限。长驻 controller 必须能处理隐藏期间的撤销；用于刷新资格的任务仍受功能和会话生命周期约束，不能只依赖 unmount 清理。

普通对话中的正文继续流式输出、产生工具结果或开始下一轮，不是隐藏卡片的理由。所需边界是“普通输入区是否被宿主接管”，不能把 `input` 的任意 busy 状态当作隐藏条件，也不要求用户等待真实轮次结束。

面板采用插件自有样式和语义化 region，在 dock 内居中并以 `44rem` 限制阅读宽度，避免控件跨入会话两侧的原生拖拽区域，不固定到 `document.body` 坐标。长内容必须保留完整文本并在内部滚动，不能以截断源码换取高度。正文区以 `min(40dvh, 24rem)` 为上限，再用标准 DOM 几何、`ResizeObserver` 和 visual viewport 事件按实际 scrollport 空间收缩，为标题、操作、其他 dock 和输入框保留位置；隐藏、折叠、结算和卸载时释放观察。浏览器验收同时检查坐标和实际点击命中，避免按钮虽在视口内却被宿主页头遮住。不要把宿主未公开的 CSS 变量或私有类名提升为必需契约。

源码和模型上下文默认展开；当前卡片不采用 hover 才显现的布局，不自动抢焦点或持续调用 `scrollIntoView`。键盘可进入内容滚动区和所有动作，窄屏操作行允许换行，动态视口下仍能访问输入框与审批。共享 list 的顺序只管理本插件贡献，不重排其他插件。

## 集中兼容与实施顺序

一项公共能力由一个执行环境中的 owner 管理。Client 入口通过既有 `ctx.slots.inject` 等待 `conversation.input.dock`，沿用 `registerEnabled`、`ctx.effect()` 与 disposer 释放注册。root `apply` 注册 session-scoped contribution，由 renderer 的公共会话 props、projection hooks 和现有 RPC 注入提供数据；不另起 session coordinator。

本方案不消费 Conversation event registry，因此无需为了旧 `conversationEvents` 与后续 `uiConversation.events` 增加适配。确有公共 props 形态差异时集中到 `src/client-host-compat.js`，组件使用统一语义；不能以 DSH 版本号分支，也不为没有差异的 dock 包一层泛化框架。

slot 的迟到、释放、再次声明和功能开关必须测试。缺少所需展示能力时，历史中仍保留紧凑的编写请求与已有的只读历史，并显示“草稿审阅面板暂不可用”；不恢复历史里的完整操作卡片，不伪装成用户主动关闭，也不自动保存、丢弃或执行草稿。重新打开入口只在实际能打开面板时提供，能力恢复后按同一候选原有展示选择恢复。审批接管属于普通输入区暂时隐藏，不是公共能力缺失，不显示能力错误。

展示能力的就绪与释放由一处 Client 注册 owner 协调，包括 dock、重新打开入口和所需公共 props，不在组件中分别猜测能力或自行声明宿主落点。在目标官方分发中缺少这些能力意味着本方案尚不能通过产品验收；保留请求与提示不可用不等于已交付输入框上方的审阅功能。

实施记录：

1. 已在未经修改的官方 `0.1.3-alpha.2` 安装中注册最小 dock，并以真实浏览器确认其位于输入框上方。
2. 已复用 draft projection 与现有 RPC owner，历史命令卡片保留请求和只读候选，当前候选由单一 Client review controller 管理；页头不再提供第二套写操作。
3. 已实现折叠、展开、关闭、输入框旁重新打开、迟到响应隔离、跨会话隔离、待决写操作和 composer takeover 生命周期。
4. 已以最终 tarball 运行官方 Web smoke，覆盖长内容、窄屏、低视口、隐藏编写按钮和展示操作的 session-log 不变性，并同步更新 ADR、Client UI 与用户文档。

## 验收与交付证据

| 验收项 | 必须观察的结果 |
| --- | --- |
| 官方安装 | 正式 tarball 安装成功，Host 源码和安装文件不变，实际加载最终插件 bundle。测试 fixture 自行声明 slot 不能替代此项。 |
| 请求与位置 | `/binding new`、`edit` 发出时保留历史中原有的绑定编写请求样式；接受后只更新请求状态，完整详情和写操作首次在 dock 展开，原条目不消失也不变成完整操作卡片。 |
| 展示控制 | 折叠保留标题，展开恢复内容，关闭仅隐藏，输入框旁与当前请求都能重新打开；同一候选的 RPC 更新、重连、普通消息和审批接管不覆盖用户选择，新候选首次展开。 |
| 内容与操作 | 精确源码和模型上下文默认可读；保存为停用、保存并启用、丢弃、busy、冲突、失败及回执正确。 |
| 结算与显隐 | 保存或丢弃过程中分别保持展开、折叠和关闭，验证成功、失败及结果待确认组合。成功不强制重开或展开；已处理后的两个当前入口移除，回执与源码从原请求只读访问。 |
| 请求状态证据 | A 已有草稿，B 命令成功准入后未接受候选，projection 回到 A；B 在重新挂载、分页和重连后显示准入成功及编写结果未知，不能冒用 A 的 ready 或推断失败。命令处理错误、匹配 projection 的 failed、接受及 action 各自只归到对应请求。 |
| 候选与异步 | 新请求、旧请求恢复、跨会话、迟到 RPC、断线、重启、分支和 seed 不串候选，不以历史或旧 locator 恢复写权限。 |
| 唯一控制器 | 命令处和页头不再同时出现另一套当前保存控件；折叠或关闭期间的写操作不会丢失结算或重复提交。主动展开历史仅只读，分页不重新挂载活动控制器。 |
| 宿主共存 | 官方文件产物、Todo、Goal、队列和另一插件的 dock 内容继续显示；原生分支资格、目标与草稿 UI 无关。 |
| 接管与恢复 | 宿主审批及 REPL 接管时不遮挡接管界面，恢复普通输入框后草稿仍可读；隐藏期间撤销不会恢复旧操作权限。 |
| 浏览器 | 桌面、窄屏、中英文、长源码、键盘和焦点、多 dock 与小视口下内容和输入框可达，无强制滚动或页面溢出。 |
| 日志与请求 | 展示、展开、隐藏和历史查看不新增 event、模型提示词或声明，不影响前缀稳定性、journal 或模块初始化；真实保存沿用已有 notice/catalog 契约。 |
| 能力生命周期 | 验证既有与当前契约、迟到声明、释放、重挂载和开关。能力缺失时保留紧凑请求与明确不可用提示，没有历史写操作或无效的打开入口；恢复后沿用候选和显隐选择。审批接管不误报能力缺失，不以版本号或新造 slot 代替能力证明。 |

按项目 ledger 流程记录实施发现，最终在稳定树上运行 `npm run check` 和 `git diff --check HEAD --`。独立 reviewer 无缺陷、确定性测试通过、实际 UI 验收是不同证据；不能把其中任一项替代其余。提交与发布仍遵循用户授权及独立审查条件。

## 公共契约与历史证据

已核对官方源码中的 slot 声明、原生根布局和贡献实例，以及已安装官方包的类型声明与实际 Client bundle 中的 dock 渲染。它们证明接口存在及设计落点可用，尚不证明 PTC Plus 面板已实现或完成浏览器验收。

以下标签仅标识只读历史源码样本，不定义运行分支、测试白名单或当前兼容目标：

| 历史样本 | 与本方案相关的事实 |
| --- | --- |
| `dsh-v0.1.1-rc.2` | ui-conversation 声明 session/list 的 `conversation.input.dock`，根布局在输入框之前渲染它。 |
| `dsh-v0.1.2-rc.1` | 相同的公共 dock 与相对输入框位置；不依赖 Chat 拆包后的 registry。 |
| `dsh-v0.1.3-alpha.2` | 相同的公共 dock 与位置；已安装官方分发也包含该 slot。 |

公开规则与受检源码入口：

- [Slots 扩展规则](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/docs/subsystems/slots.zh.md)：基数、scope、selector 与生命周期。
- [输入区插槽声明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/packages/client/ui-conversation/src/client/contract/slots.ts)：`conversation.input.dock` 和 `InputZone`。
- [原生会话根布局](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx)：dock、普通输入框与 composer chain 的组合。
- [Slot 渲染契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/packages/client/ui-slots/src/index.ts)：`overlay` 隐藏而不卸载 fallback。
- [Todo](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx)、[Goal](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/packages/client/ui-goal/src/client/index.ts)、[输入队列](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/packages/client/ui-conversation/src/client/queue/QueueDock.tsx)：官方独立 list contribution 的实际用法。
- [早期根布局](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx)与[后续根布局](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx)：既有公开 dock 的位置证据。
