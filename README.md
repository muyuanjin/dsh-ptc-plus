<p align="center">
  <img src="assets/dsh-ptc-plus-banner-zh.webp" width="100%" alt="dsh-ptc-plus 横幅">
</p>

<p align="center">
  <strong>简体中文</strong> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="#%E9%BB%98%E8%AE%A4-ptc-%E6%A8%A1%E5%BC%8F%E7%9A%84%E9%97%AE%E9%A2%98">问题</a> ·
  <a href="#%E4%B8%89%E4%B8%AA%E6%9C%80%E7%9B%B4%E6%8E%A5%E7%9A%84%E5%9C%BA%E6%99%AF">场景</a> ·
  <a href="#%E8%AE%BE%E7%BD%AE">设置</a> ·
  <a href="#%E8%8C%83%E5%9B%B4">范围</a> ·
  <a href="#%E5%AE%89%E8%A3%85">安装</a> ·
  <a href="#%E6%96%87%E6%A1%A3">文档</a>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness PTC mode" src="https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb"></a>
  <a href="package.json"><img alt="Node.js ^22.19.0 || >=24.0.0" src="https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-5fa04e?logo=nodedotjs&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/dsh-ptc-plus"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-ptc-plus?logo=npm"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com/zh/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

---

**PTC Plus 给 DSH 的 PTC 模式一个会话绑定的持久 TypeScript REPL。** 每次 `run_code` 都在同一个会话里继续。上一次 `run_code` 的变量、导入和结果，下一次还能直接用。

> [!NOTE]
> 社区插件，与 DeepSeek 或 DSH 无隶属、无背书。

> [!IMPORTANT]
> 面向 `danger-full-access` 设计：可直接访问 Node.js 与操作系统，不另加沙箱。仅在可接受此权限的环境使用。

![PTC Plus 设置卡片](assets/ptc-plus-settings-zh.png)

*设置卡片展示即时配置和 `enabled` 开关。*

## 默认 PTC 模式的问题

DSH 的 PTC 模式让每次 `run_code` 都从新环境开始。模型算过的东西，下一次还要重发。写错一行，整段代码重发。这个插件把 `run_code` 接到一个会话级环境里，后面的调用直接复用之前的东西。

| 场景 | 默认 PTC 模式 | 使用 PTC Plus                 |
| --- | --- |----------------------------|
| 状态 | 每次从零开始，setup 重发 ❌ | 上一次 `run_code` 的结果直接能用 ✅   |
| 修错 | 结果不对或失败，整段重发 ❌ | 只发一行 diff ✅                |
| 模块 | `import` / `export` 不能写 ❌ | 照常写，后台 AST 重写 ✅            |
| 值 | JSON 改掉或丢失特殊值 ❌ | 这些值原样保留 ✅                  |
| 重启 | 重启后一切丢失 ❌ | 能恢复的会回来 ✅                  |
| 输出报错 | 大打印刷屏，报错指到别处 ❌ | 输出裁剪，报错回错的行 ✅              |
| 工具 | 列表看不见，顶层误发失败 ❌ | 可查看；可确定的误发自动转 `run_code` ✅ |
| 路径 | 相对路径可能跑偏 ❌ | session 记住项目目录 ✅           |
| agent 工具 | 需要当前 agent 的工具被拒绝 ❌ | 恢复上下文，goal 等可调 ✅           |

## 三个最直接的场景

### 状态跨调用

第一个 `run_code` 算完：

```ts
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

第二个直接接着用：

```ts
return deps.map(dep => dep + '@' + manifest.dependencies[dep])
```

`deps` 和 `manifest` 还在。setup 代码只发一次。

### 修错不重发

默认情况下，结果不对或执行失败，模型只能把整个代码块再发一遍。

PTC Plus 下它只发这一行：

```ts
edit_run_code({ edits: [{ old_string: 'deps.length', new_string: 'deps' }] })
```

模型只提交差量参数；插件在宿主中重建并执行完整 cell，将完整源码保存在私有恢复 metadata 中，不作为工具结果正文再次发送给模型。精确文本替换和正则替换都有限制，坏的正则不会卡住。

当被拒 cell 的末尾可唯一验证为缺少一个闭合符时，诊断会直接给出应用该修正并重运行所需的完整 `edit_run_code(...)` 调用，无需等待额外 recovery context。这只证明语法与 preflight 可接受，仍需确认修正符合任务意图；edit 会执行完整 cell。生成的调用带有 `expected_target_call_seq` 前置条件；如果另一个 cell 已先成为 edit 目标，它会拒绝且不执行。PTC Plus 不会自动应用这项建议；有歧义或没有持久目标身份的修复仍需提交修正后的源码。

### 模块语法

DSH 的 PTC 模式把每个 `run_code` 当作 async function body 执行，静态 `import` 和 `export` 声明在这个函数体里无效。PTC Plus 会在执行前用 AST 分析适配这些形式。

模型照常写：

```ts
import { readFile } from 'node:fs/promises'
```

依赖从项目解析，具名和默认导入保持 live 且只读。模块语法适配后，cell 仍按 async function body 执行，支持顶层 `await`，通过显式 `return` 或打印提供结果。

## 一次配对实测

一次身份盲化的配对实验使用了 `opencode-go/deepseek-v4-flash`。两个 arm 使用同一版本夹具、任务 prompt、权限，每个任务重复两次，每个 arm 共 18 个 session。

| 9 个任务合计 | PTC Plus | DSH PTC 模式（未启用 PTC Plus） | 本次观测变化 |
| --- | ---: | ---: | ---: |
| 模型请求 | 66 | 88 | 减少 25.0% |
| 工具调用 | 50 | 79 | 减少 36.7% |
| Token 流量 | 729,642 | 942,901 | 减少 22.6% |
| 身份盲评量表得分 | 138 / 162 | 118 / 162 | 提高 12.3 个百分点 |

模块语法任务的区分最清楚：PTC Plus 两次都只用一次 `run_code` 完成；未启用 PTC Plus 的 DSH PTC 模式两次都未满足静态 import 要求，合计使用了 8 次工具调用。

这是一次有随机性的配对观测，不是性能保证。预设机器预算在 PTC Plus 的 18 个 session 中有 2 个超限，未启用 PTC Plus 的 18 个 session 中有 5 个超限，因此整组矩阵没有通过 machine acceptance。Token 流量包含 input、cache-read、cache-write 和 output token。夹具、配对规则、指标与盲评流程见[评测说明](docs/evaluation.md)。

![被拒的 run_code 与随后的 edit_run_code 修复调用](assets/ptc-plus-repair-zh.png)

*真实会话：`edit_run_code` 调用只携带修复差量，插件据此执行完整 cell。*

## 设置

打开 **设置 → 插件配置** 使用上面的设置卡片。卡片跟随 DSH 界面语言：界面设为 English 时显示英文，设为中文时显示中文。`enabled` 是即时生效的总开关：关闭后停用 runtime，保留卡片和这个开关，并在下一次宿主允许的请求中撤销先前的 PTC 状态声明；开启后恢复 session runtime 以及 `run_code`/`edit_run_code`。

设置按插件开关、界面显示、核心功能、可选能力、高级行为和资源限制分区。增强工具卡片、REPL 页签和绑定编写按钮位于“界面显示”；缺少摘要的执行与顶层工具误调用修复位于独立的“核心功能”区。

“使用 PTC Plus 增强工具卡片”默认开启，提供可展开的源码、结果、执行状态和功能标记。关闭后，`run_code` 与 `edit_run_code` 使用 DSH 原生工具卡片；这个开关只影响显示。

“允许执行缺少摘要的 `run_code`”默认开启。模型没有提供外层 `description` 时，代码仍会执行；启用增强工具卡片时，界面显示备用摘要。关闭本设置后按 DSH 原生规则校验。这个开关不改变模型请求或原始调用参数。

“允许顶层函数/类重声明”与变量重声明开关相互独立，默认开启。后续 cell 可以用普通 named `function` / `class` 声明替换已有的可写 binding；替换在声明所在位置生效，不模拟函数提升。import、不可写 `const`、保留名称和来源不明的 binding 仍会在执行前拒绝。关闭后，顶层函数和类的重声明会在执行前拒绝；开关变化只影响随后提交的 cell，cold recovery 始终按每个 cell 已记录的策略重放。

“全局用户绑定”默认关闭。开启后，设置卡片中的“管理全局绑定”按钮打开大尺寸应用内弹窗，与 REPL 页签的全局绑定区复用完整工作台；没有当前 PTC 会话也能管理。工作台可以创建、导入、验证、保存、启停、删除和执行具名导出的 TypeScript helper。接口声明排在最前，实现源码默认折叠、只读并提供高亮，点击“编辑”后才能修改源码与条目配置。条目原子写入 `$DSH_HOME/ptc-plus/bindings.json`，revision 已变化时会拒绝覆盖。导出字段可显式限制公开符号，留空则根据当前源码重新推导。`namespace` scope 把条目名称作为对象注入，`top-level` scope 直接注入选定导出；启用冲突会在写入前拒绝。

只读状态点击“重新加载”会同步所选条目的源码、声明和保存 revision；已删除条目会从编辑区清除。编辑中重新加载会保留未保存的源码和字段，并更新保存 revision 与取消编辑后的基线。检查后再次点击保存即可重试，刷新不会自动提交草稿；读取期间目录再次变化时需重新加载。namespace 名称及选定导出必须是精确的合法标识符，允许 Unicode 名称，不接受附加空白、注释或转义拼写。

“代码控制台”运行当前条目的未保存草稿：直接输入 `readText("./example.txt")` 即可查看结果，也支持变量声明和顶层 `await`，后续命令可以复用临时变量。普通报错保留已发生的修改；停止、重置、切换条目、保存修改后的源码或离开工作台会释放环境，源码变更后的下一次运行也会重新开始。首次运行才创建环境，连续 10 分钟未执行代码后自动释放，界面记录保留且不会自动重放。可分别清空记录或重置环境。控制台不连接 Agent 会话变量，也不写入其 journal；代码仍以 DSH 进程权限执行文件、网络等 Node/OS 操作。

“显示 REPL 页签”和“显示绑定编写按钮”默认开启，分别控制会话页签与输入框快捷入口。隐藏页签后仍可从设置管理全局绑定；隐藏编写按钮后仍可使用 `/binding` 命令。整个全局绑定能力仍由“全局用户绑定”开关控制。

每个条目的“模型上下文”包含“将接口声明提供给模型”开关和“给模型的提示词”文本，可直接修改后保存或取消，无需先点击“编辑”源码。接口声明始终从源码生成，开关默认开启；提示词可描述何时使用这个工具、调用约束或示例，留空则不添加。两者独立配置：取消声明勾选仍会提供已填写的提示词，两者都清空或关闭才完全省略该条目的模型上下文，不影响绑定执行。已启用条目在新会话首轮就可见；通过 `/binding` 保存并启用、会话中途启用或修改提示词后，下一轮请求也会收到当前配置，无需新建会话或先执行一次工具。`/binding` 会要求 Agent 随源码填写提示词和声明开关，草稿卡片保留这些配置供检查。

已启用条目在下一次 `run_code` 中尝试激活为普通可写 REPL binding；首轮接口描述的是已配置 API，不证明初始化成功。只有 worker 已成功激活、仍与当前配置同源且未被 session-local binding 覆盖的完整条目，才在随后一轮获得活动声明。提示词配置不变时，激活状态不会改变 system 前缀；保存、启停或修改提示词在下一请求生效。请求自带的 program namespace 或 error class 优先于同名全局条目；该条目只在本次请求中激活失败并产生诊断，不会覆盖宿主值或阻止其他代码。binding module 所需的 program namespace 若与既有 worker global 同名，本次 cell 会显式失败且不会替换 Node intrinsic。失败 initializer 已发起 program call 时，cell 进入 volatile，避免 cold recovery 把缺少该源码的调用记录当作可重放历史。同名赋值或重声明只覆盖当前 session；cold recovery 使用结果 metadata 中记录的精确快照，不从当前磁盘内容猜测历史值。条目源码中的相对 import 在候选试运行和正式激活时都以 binding 存储目录为解析基准；已经保存到普通 session binding 的导出闭包会在当前 worker 生命周期内保留该解析基准和 program namespace bridge。

提示词和接口中的 `{{name}}` 等示例会原样提供给模型。仅修改提示词、接口注入开关或用途说明，不会重置已激活模块的状态，也不会重复执行初始化；修改源码、scope、namespace 调用名或导出列表后，下一次执行会重新初始化。旧会话按每一步当时的复用规则恢复，升级前因修改说明或顶层显示名称而发生的模块重置也会保留。

开启后，只要当前 session 的实际命令目录提供 `/binding`，输入框工具栏就会在首轮前显示星光图标；点击可预填 `/binding new `，已有输入不会被覆盖。也可以直接输入 `/binding new <需求>` 或 `/binding edit <id> <需求>`，DSH 会提供命令匹配和参数提示。命令启动 Agent 编写后立即完成并清空输入框；对话中的唯一绑定命令卡片保留完整需求、编写状态与 TypeScript 源码，各阶段状态随界面语言切换。Agent 收到完整字段说明、调用范例和依赖解析基址，通过 `run_code` 内稳定的 `code.submitBindingDraft({requestId, entry})` 交接一个停用内存草稿；每次请求仅接受一次有效提交，普通 REPL 声明不会成为全局草稿。进入和结束编写不改变同配置下的 system 与工具声明。

草稿就绪后，卡片提供“保存为停用”“保存并启用”和“丢弃草稿”，均由用户决定。保存或丢弃后仍可展开检视当时接受的精确源码，回执可随日志重建，后续同 ID 的修改不会替换这份历史。保存并启用原子写入启用条目，但当前会话是否成功激活仍由 runtime 证明。模型收到保存事实，只有成功激活且未被会话局部定义遮蔽的条目才产生活动声明；`repl.state` 管理命名 checkpoint，不能当作绑定目录。目录版本冲突后，卡片重新读取权威状态，保留仍有效的草稿供用户检视并重试。

PTC Plus 顶部弹窗包含 Session 和 Global 页签：Session 查看可复用的 REPL 绑定，Global 展示持久条目的启停状态、检查源码并预填 `/binding edit`；目录中的“启用”不代表当前会话已激活。完整管理在 REPL 页签和设置管理弹窗中提供，Agent 辅助编写仍需要可用会话。Host 通过当前 session 私有 projection 的 opaque locator 约束草稿 UI 操作；保存、丢弃或所属 Agent、session、功能、owner 结束都会撤销可写资格。候选 worker 隔离 session 状态，但代码仍拥有 DSH 进程权限，可能产生不可回滚的 Node/OS effect。

当前会话使用 `ptc` 或兼容的 `code` preset 且插件启用时，会话增加与“对话”“轨迹”同级的 **REPL** 页签；切换到其他会话或关闭插件时自动移除。“会话绑定”展示名称、定义来源和结算后的有界值预览，并标注观察时间、截断与不可读取状态。超出展示限额的条目会被省略，其他条目的预览照常显示。值预览仅读取基本值和数组前五个自有槽位；普通对象、TypedArray、Buffer、String 包装对象等其他值标为不可读取，不枚举全部属性。普通字符串仍提供有界文本预览。预览不触发 getter、Proxy trap 或用户格式化代码，也不执行会话代码；它不是实时完整快照，不进入模型上下文或 journal，不影响恢复与 binding 保留规则。

REPL 在同一页展示会话绑定和完整全局绑定工作台，无需切换内部页签。会话清单支持名称搜索和类型筛选，选中后在检查区查看带高亮与复制按钮的定义及对应值预览；空清单使用紧凑的全宽空状态。只有会话观察区可见时，后续执行才采集可选值预览，打开页面本身不会执行观察代码。工作区隐藏普通消息输入框，也不响应对话宽度拖拽；切回对话后恢复输入框和未发送草稿，审批、提问等宿主交互仍正常显示。

![REPL 工作区：会话绑定检查与全局绑定管理](assets/ptc-plus-repl-workspace-zh.png)

*REPL 工作区：上方检查会话绑定，下方管理全局绑定并使用 TypeScript 代码控制台。*

预览最多等待 250 ms，未及时完成时先返回已结算的结果。只有仍在执行的观察不计入下一 cell 的计算与墙钟预算；后台用户回调等其他阻塞仍受超时保护，等待期间可取消。预览耗时不会导致下一 cell 误超时并清空绑定。

插件启用且会话使用 `ptc` preset 时，会话头部显示绿色 `PTC Plus` 标识。悬浮、聚焦或点击后可以查看下一 cell 可复用的变量、函数、类和 import，并展开其有界定义源码。卡片只读取已提交的源码，不读取运行时值、不触发 getter，也不执行代码。正文中的 `run_code` 与 `edit_run_code` 仍可展开查看源码和结果；只有结果 metadata 能证明某项功能确实生效时，预览才显示对应标记。

![REPL 可复用绑定](assets/ptc-plus-bindings-zh.png)

*真实会话：“REPL 可复用绑定”卡片展示下一 cell 可直接复用的 binding。*

所有设置都会实时应用，并保留已有 binding。已提交的 cell 在完整执行期间使用同一份配置；执行期间发生的更新用于随后提交的 cell。更新失败会回滚。Node 在 worker 创建时固定 V8 old-generation 上限，因此活动 session worker 存在时修改这一项会被拒绝，释放 session 后才能修改。启用失败时，运行时会回滚并把设置保持为停用。

`cordisToolsEnabled` 默认关闭。打开后，DSH 官方 Cordis 工具、owner guidance 与精确的 `cordis-plugin-development` companion Skill 会作为一个整体加入 PTC agent；同一 shipped preset 目录中的其他 Skill 不会随之暴露。关闭时这三项也会一起移除；它不切换 preset，也不改变 `run_code`/`edit_run_code` 的直接调用面。Cordis 能在实时 DSH runtime 中运行模型编写的插件，开启它需要接受 shell 级信任。

如果 Cordis 调用失败但 worker 仍存活，失败前赋值的源码 binding 可以在后续短 cell 中复用。调用抛错可能发生在外部 effect 之后；是否重试应依据 Cordis owner 的执行状态和幂等契约，缩短 cell 本身不能证明安全重试。终止 worker 的 timeout 或合计输出超限则不能依赖失败 cell 的 binding。

REPL 中捕获的 `tools` 对象或成员引用会随提交 cell 的 lease 到期。需要跨 cell 复用的 helper 应在调用时读取当前 namespace，例如 `async function inspectNow() { return tools.cordis_inspect_list({}) }`。全局用户绑定模块的动态 bridge 同样按调用所属 cell 检查 lease，旧 continuation 不能借用新 cell 的能力。

cold recovery 或重新启用 Cordis 后，已记录的 Cordis value 仍是历史数据，但不能证明进程内 Plugin、Run、approval 或先前 Inspect observation 仍然存活。PTC Plus 会提供有界恢复声明，直到一次新的成功 Cordis Inspect 调用验证当前进程。恢复声明、已激活全局绑定声明和按需 tip 通过带 PTC Plus 来源的独立消息投递，遵守宿主的上下文抑制设置；自身变化不会重发其他插件未变的上下文，失效的状态声明会被明确撤销。

详见 [客户端 UI](docs/client-ui.md)、[ADR 0019](docs/adr/0019-plugin-settings-and-kill-switch.md)、[ADR 0020](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md) 与 [ADR 0023](docs/adr/0023-global-user-bindings.md)。

## 范围

能力发现使用 SDK 已声明的 `capabilities.tree/find/inspect`。`find` 是确定性词法匹配：优先精确的 `namespace.member`，也支持 `read` 这样的完整短词；多个词必须连续出现，不能当作自然语言搜索。空结果可缩短查询或查看 `tree()` 的 namespace 与 members 层级，再只 inspect 当前视图中相关的 symbol。详见[能力发现](docs/runtime-reference.md#capability-discovery)。

PTC Plus 提供会话绑定的持久 `run_code` 层。原生工具的权限、策略、审批、取消、sandbox 和进程治理仍由 DSH 与操作系统负责。

## 安装

要求 Node.js `^22.19.0 || >=24.0.0`，并已安装带 TypeScript PTC 模式的 DSH。把 npm 正式包安装到你实际使用的 profile：

```sh
dsh plugin --profile <profile> add dsh-ptc-plus
dsh --profile <profile> --dump-config
```

安装后重启对应的 DSH profile。固定 npm 版本、GitHub、本地 checkout 和 tarball 安装方式见[安装指南](docs/installation.md)。

Windows 开发时可双击 `scripts\run-dev-dsh.cmd` 启动一个独立的 DSH alpha 最新版并只安装本插件。脚本会缓存 DSH、插件快照和 pnpm 依赖，仅在版本或源码内容变化时更新，并自动清理旧缓存；它会在当前进程内去重 Windows `PATH`，不会创建盘符映射、目录联接或修改系统环境；如果去重后仍超过 `cmd.exe` 限制，会在运行 npm/DSH 前直接提示缩短 PATH。Web 未指定端口时会自动选择空闲回环端口，不会因 3080 被占用而失败。缓存默认位于 `%LOCALAPPDATA%\dsh-ptc-plus-dev`，不会写入本仓库。详细选项见[安装指南](docs/installation.md)。

开发启动流程默认从 npm 官方源查询和安装，避免镜像尚未同步新版本依赖导致失败；可通过 `DSH_DEV_REGISTRY` 指定其他源。这个选择同时用于 npm 和 DSH 的 pnpm 子进程，不修改全局 npm 配置。

`danger-full-access` 是首要支持方式。worker 只隔离生命周期，不隔离恶意代码。

## 文档

[安装指南](docs/installation.md) · [运行时参考](docs/runtime-reference.md) · [架构](docs/architecture.md) · [发布](docs/publishing.md) · [全部文档](docs/README.md)

使用 [MIT License](LICENSE)。
