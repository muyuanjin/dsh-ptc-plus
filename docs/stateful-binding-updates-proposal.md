# 面向 Agent 的有状态计算语言提案：从核心哲学推导语义、实现与验收

状态：调研与设计，尚未实施。本文替代原 `HANDOFF-import-collision.md`，保留已复现问题与研究证据。零重声明错误是必须满足的计算契约之一；完整目标是让模型以熟悉的语法持续修订计算，减少记忆负担，并在失败或上下文变化后正确继续。

本文只规定提案目标与实施要求，不把未来行为写成现有能力。涉及代码、规范、配置、journal 和用户文档的后续变更由第 10 节列出 owner；本提案本身不改变运行时或授权。

## 1. 从核心哲学到可检验的设计约束

**PTC Plus 的目的是让模型方便、连续地进行有状态计算。REPL 是降低实现成本的执行手段，不是产品必须服从的语义目标。**

### 1.1 推导的前提与限度

这句话决定产品为何存在，但不能单独证明某个 parser 能恢复全部错误、某个 Node hook 能拦截全部编译，也不能唯一决定所有新语法的求值顺序。完整推导需要区分四类依据：

| 依据 | 本文如何使用 |
| --- | --- |
| 核心目的 | 判断一种限制是否在帮助模型完成正确计算，还是把实现负担转给模型。 |
| 项目契约 | [AGENTS.md](../AGENTS.md) 与 [CONTEXT.md](../CONTEXT.md) 已明确 DSH authority、公共扩展面、状态来源和模型可见性；它们是本设计的明确前提。 |
| 可观察事实 | 模型以多次调用修订计算、上下文有界，当前代码与第 3 节探针暴露实际限制；这些事实可以被验证或推翻。 |
| 工程选择 | 在满足上述约束的候选方案中，选择语义明确、干预较小且容易验证的方案，并说明替代方案及验证条件。 |

因此，“当前实现如此”“语言标准如此”“以前已经写进提案”都不足以证明某项规则应保留。反过来，哲学也不能把未实现能力、缺失输入或未知效果变成已知事实。每项规范性选择必须能追溯到下列约束；具体实现仍需证据。

### 1.2 六项约束及其来源

| 标识 | 从目的与前提推出的约束 | 对设计的直接要求 |
| --- | --- | --- |
| C1：减少操作负担 | “方便”要求模型把注意力用于任务；记住声明次数和内部存储类型没有任务价值。 | 接受语义明确的 JS/TS 写法，包括少见写法；名称历史、parser 限制和内部保留名不得制造额外调用。 |
| C2：可持续修订 | “连续、有状态”要求后续计算能修改和复用前面的成果。 | 名称具有稳定逻辑身份；同作用域更新、不同作用域隔离；一次失败不能永久占据名称。 |
| C3：计算事实真实 | 错值、漏执行、重复外部效果会破坏计算目的，即使没有报错。 | 明确求值和提交顺序，保留真实效果与失败，不猜值、不吞错、不自动重跑已有执行。 |
| C4：状态可知 | 有界上下文中的 Agent 无法可靠使用来历不明的隐藏状态；项目已经规定模型可见性边界。 | 减少记忆声明历史的负担；在 compaction/recovery 边界只保留可证明、模型可知的状态。 |
| C5：能力与职责明确 | 实际任务依赖 Node 生态和 DSH 工具；插件便利不能夺取其 owner 的控制权。 | 保留宿主授权、租约和真实结果，使用官方公共接口，不通过限制正常能力伪造零错误。 |
| C6：源头实现可维护 | REPL 只是成本选择；一组不断扩大的例外会反复遗漏并增加维护成本。 | 采用共同语义与编译事实，复用维护中的工具；替换不合适的 REPL 内部表示，避免按症状叠加分支。 |

C1 不以写法是否常见为准入条件。输入按语言契约存在确定解释时，插件承担适配责任；无法完成适配是实现缺口。只有解释确实不确定时，输入诊断才需要说明缺少什么，例如 `const x = ;` 缺少表达式。模块不存在、网络失败或 DSH 取消属于执行事实，不能伪装成语法歧义。

C1–C6 共同约束结果。“没有错误”不能通过破坏 C2/C3/C4/C5 换取，也不能以 C6 的实现成本为由把目标内遗漏永久转嫁给模型。

### 1.3 推广为一种面向 Agent 的语言语义

模型的常见工作单位是“继续这次计算”或“修订这个定义”。由 C1/C2 推出，声明可以表达建立或更新状态；由 C3 推出，重新执行表达式仍然是真实求值，不能自动等同于幂等操作；由 C4 推出，状态的可用期不能与模型知识完全脱节。

因此，本方案形成一个沿用 JS/TS 前端的 PTC 计算方言：语法尽量利用模型已有能力，名称、更新、失败和恢复具有明确的新契约。修改语言规范是可采用的手段。新语法、独立解释器或新品牌都不是必需目标；是否增加它们，由 C1–C6 与实验结果决定。

“遗忘友好”有两个不同后果：

- 模型忘记名称是否声明过、原先用哪种声明方式，仍可直接声明、覆盖和继续；环境消化历史负担。
- 模型已经失去某个值的来源和含义时，环境按正式知识边界收缩，或通过用户明确选择的状态投影使其可知；不能仅因 heap 中还存在值就继续暴露。

有状态不等于永久保存所有值，遗忘友好也不等于猜测模型忘记的输入。普通 live 计算中的 volatile 值可以在既有有效环境中使用；恢复资格和跨知识边界保留资格另行证明，不能把 durability 变成当前计算的权限。

### 1.4 关键选择的推导索引

| 选择 | 依据与理由 | 规范位置 |
| --- | --- | --- |
| 同 scope 声明归为更新，普通绑定统一可写 | C1/C2：消除对旧类别和声明位置的记忆依赖。 | 第 5.1 节 |
| 局部作用域、闭包和原值身份保留 | C2/C3：持续修订不能导致名称串值或重造已有对象。 | 第 5.2 节 |
| 无值的裸名称声明只保证存在 | C1/C2/C3：未提供新值时不悄悄抹掉已有值；清空使用显式赋值。 | 第 5.1 节 |
| 声明按 declarator 完成后发布，赋值按实际写入生效 | C2/C3：新声明不制造半初始化公开状态，显式写入不假装可回滚。 | 第 5.3 节 |
| import 跟随模块，写入形成局部覆盖 | C1/C2/C3：复用值来源与修订名称兼容，不修改模块对象。 | 第 5.4 节 |
| 全局条目完整激活、公开名称分别覆盖 | C2/C3/C5：覆盖一个名称不撤销兄弟名称，不获得存储管理权。 | 第 5.6 节 |
| 模块语法成为默认语言能力，普通设置仅保留一个更新开关 | C1/C5/C6：语法实现方式没有独立用户价值；保护性选择与旧配置仍有明确表达。 | 第 4 节 |
| 独立编译单元与连续逻辑状态 | C2/C6：跨次持久性不再依赖原生重复声明限制。 | 第 6 节 |
| 失败结算、展示和恢复分别承担后果 | C2/C3/C4：一次局部问题不能制造不实状态或永久阻断后续计算。 | 第 7–9 节 |
| 证明内部性质，如实返回外部执行结果 | C3/C5：不以不可能的无界承诺掩盖内部遗漏或篡改外部事实。 | 第 2、11 节 |

这些是本方案选定的规则，其中裸声明、声明提交和特殊命名空间的次序属于明确的语言设计选择，并非由一句哲学唯一决定。改变选择时必须同步示例、转换、配置代际、恢复和验收，不能只改一段理念说明。

## 2. 产品承诺、执行边界与错误责任

依据 C1–C6，默认 PTC 计算应满足：**语义明确的代码不因插件的内部表示限制而失败；同名修订可直接进行；真实计算失败后，可继续状态与已发生效果仍有准确含义。**

### 2.1 完整覆盖责任

| 计算区域 | 本方案承担的责任 |
| --- | --- |
| run_code、edit_run_code 的派生执行 | 同一语言入口、状态机制、原始参数与 call identity。 |
| 同 cell、跨 cell、函数、块、参数、catch、switch、循环、类初始化 | 全部声明命名空间归一化，保留各自 scope 和 activation。 |
| eval、Function 家族、vm、alias、原型构造器、bound callable | 动态源码递归适配，不要求模型改写调用姿势。 |
| 模块图、静态/动态/data URL、ESM/CJS、模块内动态代码 | 在 PTC 执行环境内统一接入；不修改磁盘模块或安装包。 |
| 插件自有子计算、用户绑定 initializer、候选与工作台 | 编译契约一致，状态、权限与生命周期各自独立。 |
| 失败继续、配置切换、cold replay、模型可见状态收缩 | 实际状态与证据一致，不留下永久占位、混用语义或未知历史门禁。 |

这张表是覆盖责任索引，不是允许实现只支持所列示例的白名单。新语法节点和新编译入口由共同 owner 补齐；普通局部或动态代码不能被划为产品例外。

零重声明包括 parser/scope/native compiler 的重复名称拒绝、模块重复导出、参数/私有名称/标签冲突、生成代码碰撞与插件 preflight 的同类拒绝。把错误换成 `EvalError`、“不支持”或其他 PTC 错误码，不算完成。

### 2.2 内部保证与无界命题必须分开

可证明的目标是：在明确的 PTC 语法、更新策略、初始状态和执行边界内，任意计算轨迹都不因重复声明被拒绝；动态创建的新单元保持同一性质。证明不能附加“名称从未使用过”“不使用局部作用域”等规避目标的前提。

“任意外部引擎也绝不报重声明错误”在现有项目约束下不成立。模型可以通过已授权能力启动一个独立 Node 进程，令它解析重复 const；那个进程的解析器不由插件拥有。C3/C5 要求保留其真实结果，不能修改工具参数或吞掉输出。

因此，外部程序的无界命题是已被反例否定的命题，不是再多跑一些测试就能关闭的待办。内部可达的 raw compiler、原生扩展和新 realm 则属于入口封闭性问题：若它们绕过 PTC 编译器，内部全量保证仍未成立，必须明确记录缺口；不能把普通内部计算临时改名为“外部”来豁免。

自有闭合执行器或拥有完整编译入口的引擎嵌入，原则上可扩大内部证明范围，但仍有依赖假设和外部边界，并会增加 Node 兼容成本。第 6.8 节比较其取舍，第 11 节给出证明义务。

### 2.3 错误按原因承担后果

| 原因 | 目标行为 |
| --- | --- |
| 名称历史、存储不可重声明、import lowering、生成代码错误 | 插件负责适配和修正；实现失败不能被写成调用者应改名的规范。 |
| 源码按 PTC 规则有确定解释，但当前 parser/transform 不支持 | 记录编译器缺口，补足能力；不能把工具限制称作源码歧义。 |
| 输入缺失且无法确定解释 | 返回定位准确、指出缺失内容的诊断，不猜测计算数据或意图。 |
| 初始化、工具或模块真实失败 | 保留失败与已发生效果，明确后续可继续状态。 |
| DSH 权限、取消、租约或资源限制 | 由既有 owner 决定并如实报告，不增加第二套审批，也不绕过它。 |
| 历史 PTC 元数据损坏 | 否定不成立的恢复证据，收缩后继续当前有效计算。 |

用户自行抛出的同名 SyntaxError 和外部工具返回的文本保持原值。区分错误依靠阶段、来源和执行证据，不依靠英文消息匹配。

## 3. 当前问题与证据

### 3.1 已复现的行为

下表中的两个源码片段按顺序在同一会话执行。除特别说明外，现有变量重声明、函数/类重声明、混合解构开关均开启，静态 import 与 export 适配也开启。

| 场景 | 第一个 cell | 第二个 cell | 当前结果 |
| --- | --- | --- | --- |
| 重复 import | `import { basename as item } from 'node:path'` | 同一 import | `PTC-N001` |
| 变量变为 import | `let item = 2` | `import { basename as item } from 'node:path'` | `PTC-N001` |
| import 变为变量 | `import { basename as item } from 'node:path'` | `const item = 2` | 成功 |
| import 变为函数 | 同上 | `function item() { return 2 }` | `PTC-N001`，旧目标不可写 |
| 控制流内 var 后声明 let | `if (true) { var item = 1 }` | `let item = 2` | worker 原生 `Identifier 'item' has already been declared` |
| let 后使用控制流内 var | `let item = 1` | `if (true) { var item = 2 }` | 同上 |
| let 后使用循环 var | `let item = 1` | `for (var item = 0; item < 1; item++) {}` | 同上 |
| 普通默认名称变为默认导出 | `let __default = 1` | `export default 2` | `PTC-C001`，名称已声明 |

重复 `import { readFile } from 'node:fs/promises'` 同样复现 `PTC-N001`。旧交接对三个重声明开关的全部八种组合进行了 preparation 探针，重复 import 的冲突路径不受这些开关影响。该结论说明配置没有覆盖 import，不能据此推断所有 import 转换都失败。

旧交接的部分探针只传入 `knownBindings`，没有传入真实的 `importBindings`。其中“`const` 覆盖 import 不可写”的输出不代表宽松模式下的真实会话行为。真实会话已允许变量声明接替 import，见 [import 语言测试](../test/plugin-repl-language-imports.test.js) 中 `keeps explicit loose declarations replacing future alias reads only`；旧闭包仍读取旧 namespace。这里必须区分探针构造与实际 catalog。

这些证据验证的是现有缺陷和不一致。新的绑定存储、同 cell 更新、动态作用域适配与恢复方案尚未实现或验证，不得把现有探针写成新机制的通过证明。

### 3.2 根因与代码 owner

| Owner | 当前机制及问题 |
| --- | --- |
| [cell-analysis.js](../internal/cell-analysis.js) 的 `topLevelDeclarations` | 主要扫描直接位于 body 的声明，遗漏属于同一会话作用域的控制流内 `var`。 |
| 同文件的 `prepareProgram` | 把 request 保留名、私有 namespace 与“import 名称已存在”合在提前拒绝分支；import 冲突在便利策略之前返回。 |
| [repl-convenience.js](../internal/repl-convenience.js) | 分别处理变量、函数/类、混合解构，用旧存储可写性决定能否替换，声明位置与类别成为额外限制。 |
| [cell-rewriter.js](../internal/cell-rewriter.js) 的 `importEdits`、`rewriteImportReferences` | import 被转成私有 namespace 捕获与引用映射，公开 alias 不等于同名 worker lexical binding；写入被转换为只读错误，部分写入形式在 preparation 拒绝。 |
| 同文件的 `exportDefaultEdits` | 合成 `__default` 有独立可用性与提交规则，普通同名绑定会使 export 在解析阶段失败。 |
| [session-state.js](../internal/session-state.js) 的 `BindingCatalog` | 已持有名称、来源、类别、可写性和 import 映射。`advance` 只对具有提交依赖的声明检查实际提交，其他名称会从 `prepared.declarations` / `prepared.declared` 加入目录；需要将所有声明统一纳入执行证据，防止未执行名称影响下一次准备。 |
| [session-cell-executor.js](../internal/session-cell-executor.js) | preflight 冲突转为 `PTC-N001`；遗漏的 worker 编译错误落入执行错误路径，增加错误阶段与状态解释的摩擦。 |

删除 import 的提前拒绝只能修一个症状。把所有 `const` 改回不可写则会产生新的退化。源头修正是：完整识别声明所属的逻辑作用域，并让名称更新和实际执行证据通过同一套状态机制。声明尚未执行却被目录当成已有名称，也必须作为独立反例验证，例如提前 `return` 或抛错之后的 `const later = 1`；只修 parser 和 worker lexical 冲突不能防止这种误判。

### 3.3 解析与作用域研究

使用现有 Windows 工具链的 Node `v24.14.0` 与仓库安装的 `@babel/parser` `7.29.8` 进行了不修改项目源码的内存探针。这些版本只记录研究环境，不成为实现白名单或兼容判据。

| 输入类别 | `errorRecovery: true` 的结果 | 后续 Babel scope 的结果 |
| --- | --- | --- |
| 顶层/函数内重复 const、参数与 let、catch 与 let、switch 内 let、重复解构目标 | 保留 AST，报告 `VarRedeclaration`。 | 多数仍抛 `Duplicate declaration`。 |
| 重复参数 | 保留 AST，报告 `ParamDupe`。 | 可以建立 scope，但不代表原生函数能够编译。 |
| 外层块 let 与内层 var 的区域冲突 | 保留 AST，报告 `VarRedeclaration`。 | 可以建立 scope；仍需消解 engine early error。 |
| import 与普通声明同名 | 当前 script + TypeScript 解析选项下甚至可能没有 parser error。 | scope 仍能因重复名称失败。 |
| 重复私有字段/私有方法与字段 | 保留 AST，报告 `PrivateNameRedeclaration`。 | 普通 lexical scope 不负责消除私有名称冲突。 |
| 嵌套重复标签 | 保留 AST，报告 `LabelRedeclaration`。 | 普通 lexical scope 不负责标签命名空间。 |
| 重复 default/export/constructor | 在当前宽松解析配置下可能保留 AST 且没有 error。 | 不能据此推断输出代码能被 Node 编译。 |
| 裸 `const x;` | 保留 VariableDeclaration AST，报告 `DeclarationMissingInitializer`。 | 该扩展的完整 scope/执行转换尚未验证。 |
| `const x=1; const x=;` | `UnexpectedToken`，不能得到完整可用 AST。 | 不能把它按重复声明放行。 |

进一步对函数局部、重复参数、catch、var/lexical 区域重叠、import/local、解构和 switch 七类输入，在不创建 scope 的 AST 遍历中给每个声明 occurrence 分配临时唯一名称，再调用 Babel scope。七类均能建立 scope，且 var 与 block lexical 仍归属于不同 owner。这验证了“先唯一化声明，再利用维护中的 scope 实现归属分析”的可行切入点；尚未验证完整引用重定向、执行语义或全部语法。

结论：不能只检查 parser error 列表，也不能仅开启错误恢复。必须遍历所有声明命名空间，在归一化后重新做 parser、scope 和 native 编译验证。[Babel 官方文档](https://babeljs.io/docs/babel-parser#errorrecovery) 也明确说明错误恢复仍可能遇到不可恢复错误，并提供 `reasonCode`，而不是保证所有不合法程序都可修复。

### 3.4 执行入口研究

在同一个隔离 Node 探针进程注册 `module.registerHooks({ load })`，再分别提交包含重复 const 的源码：

| 入口 | 是否经过该 load hook | 结果 |
| --- | --- | --- |
| `eval` | 否 | 原生重声明 `SyntaxError`。 |
| `Function` | 否 | 同上。 |
| `vm.Script` | 否 | 同上。 |
| `vm.compileFunction` | 否 | 同上。 |
| `import(data URL)` | 是 | 没有源码归一化时仍报重声明。 |

另外确认了三个反例：只替换 `globalThis.Function`，`(function(){}).constructor(...)` 仍可调用原构造器；为 context 安装名称 getter/setter，重复 lexical 声明仍在访问 getter 前被拒绝；`codeGeneration.strings: false` 只把动态执行变成 `EvalError`，并未让代码可以运行。context 中的 lexical binding 还可以存在但不是 context 对象的 own property，枚举对象属性无法发现所有旧声明。

这些反例排除了“一个 load hook”“一个全局 wrapper”“一个可写对象”就能实现全量保证的判断。模块 hook、调用入口适配和独立编译单元需要共同工作，且必须检查是否仍有可绕行路径。

### 3.5 连续计算的其他实现事实

下列是当前源码提供的静态机制证据，不等于已完成对应的端到端复现。目标行为应由核心约束重新判断，不能仅因现有契约曾选择这些机制就永久保留。表中结算排空、回复解码与 name 级覆盖三项已作为独立修复先行落地，只描述当前实现事实，不构成本提案语言范围已经实施的证据：

| 当前 owner | 观察到的机制 | 对目标设计的含义 |
| --- | --- | --- |
| BindingCatalog.advance | 非提交门控的 prepared 声明可以直接进入目录。 | 第 7 节统一覆盖实际 scope instantiation、初始化和更新证据。 |
| [kernel-worker.js](../internal/kernel-worker.js) 的 runCell | 成功与失败都先排空本 cell 已发起的 program calls，再由同一次 `sendCompletion` 发送结算；异常只写入 outcome，不从 catch 直接发送。 | 成功与失败需要共同结算，不能让失败生成不完整 journal。 |
| 同文件的 reply listener | 解码使用该 call 创建时记录的 limits；解码失败在本地拒绝该 call，不向 message listener 抛出。 | 需要 call 所属配置与受控解码失败通道，防止迟到回复和异常终止破坏连续性。 |
| 同文件的 activateUserBindings | 任一公开名称被 shadow 时排除整个 entry；这是旧 ADR 的明确选择，现只由 v1-v7 迁移记录沿用。 | name 级覆盖已落地：只抑制同名覆盖，同条目其他名称继续激活，并按名称记录覆盖/来源事实。 |
| [cell-rewriter.js](../internal/cell-rewriter.js) | import 写入有单独只读异常和不支持路径，活动 import 还限制 eval/with。 | 需要共同读写与动态环境适配，消除与声明错误同源的其他摩擦。 |

## 4. 设置设计：用户选择语义，插件承担适配

依据 C1/C5/C6，设置只暴露有独立用户价值的选择。判断一个开关是否应存在，需说明用户改变了什么计算契约；“内部有一段独立 rewrite”不是理由。

### 4.1 默认语言能力与一个普通更新开关

普通“有状态计算”分组保留一项：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| **允许重声明和覆盖** / Allow redeclarations and overrides | 开启 | 在同一作用域中重复声明或赋值可更新变量、函数、类和导入。局部作用域与动态代码使用同一规则。 |

默认支持静态 import、顶层 export、TypeScript、顶层 await 和 cell return。具体入口仍有自己的语法目标，例如普通 Function body 不自动变成 async body，真正的模块仍由模块 linker 处理。不存在“同时开启三个修复开关才得到完整语言”的普通使用路径。

移除静态 import/export 的普通开关是经过重新论证的选择：它们只禁用两种模型已熟悉的输入形式，不能控制 require、动态 import 或模块效果，也不提供独立的权限保障。它们作为旧配置兼容事实保留读取，见第 8 节；不在新配置中继续充当语法能力门槛。

保留更新开关的理由是用户可能主动选择检测名称覆盖。关闭后，同 cell 按其语法目标的原生声明规则处理：原本合法的 var/function 重复仍合法，原本非法的 lexical 或其他重复不再扩展；跨 cell 对已有 root 身份的新声明在执行前拒绝，新建立的 const/import 在保护策略访问中只读。静态 import/export 仍可首次正常使用。这个选择保留普通语言行为并检测跨次覆盖，不能由各 lowering 分支自行决定，也不能用含糊的“严格 REPL”命名代替。

这一关闭路径是用户主动改变契约，不是实现遇到复杂语法时自动降级。关闭不冻结此前已按可写语义创建的身份，不重启 worker，不清空状态；重新开启后，旧普通不可写 storage 也不能阻止后续新代际代码按统一规则覆盖。捕获于旧语义代码中的行为按第 8 节兼容。

### 4.2 内部策略与稳定边界

建议将新执行策略规范化为单一字段 `bindingUpdates: 'stateful' | 'protected'`，同时记录固定语言语义代际。旧五个开关由入口的兼容 adapter 解码，不在新编译器各处组合。

以下不是新的便利开关：局部声明、import 赋值、混合解构、动态代码、失败后继续、正确 source map、准确结算。它们均为所选语义的完整实现责任。作用域隔离、真实结果、DSH authority 和模型可知性也不能被更新开关关闭。

Global User Bindings、资源预算与显式状态投影具有各自的数据、权限或知识成本，继续由既有 owner 配置。不能借本次归并顺手改变它们的默认启用状态。

## 5. 从持续修订推导计算语义

本节定义的是目标语言。C1/C2 决定更新必须可行，C3 决定更新如何发生，C4/C5 决定哪些状态与能力可用。超出原生 JS/TS 的行为是显式语义选择，只有实现和验证完成后才能对外声称可用。

### 5.1 逻辑名称、可写性与无值声明

一个普通名称由所属 scope、activation 和原始名称确定逻辑身份。首次建立身份，后续声明或赋值更新它；let、const、var、function、class、import 记录来源，不成为永久禁止更新的标签。session root 跨 cell 延续，局部 activation 按调用、块进入和迭代创建。

开启统一模式时，**普通源代码绑定在所有作用域内采用可更新语义**，不再以“顶层才可写”留下例外。这保留已有顶层 const 可写便利，并推广到局部代码。对象属性描述符、module namespace 对象、私有 brand 和 DSH 能力身份有不同 owner，不因普通名称可写而被改造成任意可变对象。

```js
// Cell A
const count = 1
const readCount = () => count

// Cell B
const count = count + 1
count += 3
return readCount() // 5
```

已有值可以在替换 RHS 中读取；替换成功才发布其候选值。若 RHS 自己执行了其他赋值或外部效果，它们仍按真实执行保留，不能把“候选未发布”误称为整段回滚。

对于没有 initializer 的裸标识符声明，选择一致的“保证存在”规则：`let x;`、`var x;`、`const x;` 在已有值时保留它，新建时为 undefined。明确清空使用 `x = undefined`。这减少模型重述名称时无意丢值的风险，也消除关键字带来的隐含历史差异；它是新语义代际，不能反用于旧 journal。第 3.3 节已证明裸 const 可恢复 AST，完整转换仍需 G1/G2 验证。

`const x = ;` 缺少表达式，不能猜成 undefined；没有 RHS 的解构也不能臆造输入。for-in/of 提供的迭代值则是明确输入。对一个从未初始化、也没有旧值的名称先做读取，仍可能缺少计算输入，不能为消除 TDZ 字样凭空补值。

源码语法目标原本允许的隐式全局赋值必须进入实际状态与来源记录，不能制造 catalog 看不见的第二套状态。读取未知名称不自动声明它，受保护能力也不因隐式赋值规则获得新入口。

globalThis 的对象属性与词法 binding 仍是不同目标，不把全部全局属性复制成一份变量表。反射定义、删除和属性更新按其真实目标与来源记录，不能因绕过声明语法而逃过状态边界，也不能把 context 的 own-property 枚举当成完整 lexical inventory。

### 5.2 作用域、闭包、提升与值快照

依据 C2/C3，名称相同不等于属于同一状态。保存函数或对象值也不等于保存对另一个名称的永久别名。

```js
const x = 10
function f() {
  const x = 1
  const x = 2
  { let x = 3; let x = 4 }
  return x
}
return [x, f()] // [10, 2]
```

```js
// Cell A
function helper() { return 1 }
const saved = helper
const callCurrent = () => helper()

// Cell B
function helper() { return 2 }
return [callCurrent(), saved()] // [2, 1]
```

| 形态 | 选定语义及理由 |
| --- | --- |
| 同一逻辑 scope 内不同种类的普通声明 | 更新同一身份，消除声明类别与历史存储差异。 |
| var 穿过块，与块 lexical 重名 | var 属于 function/root，lexical 属于块；物理名称不同，读取按正式 scope 解析。 |
| 参数与直接函数体的冲突声明 | 参数提供初始值，body 随执行更新；不把其他合法的参数环境或嵌套 shadow 合并。 |
| 重复参数、catch 参数与直接 body 的冲突 | 按参数位置或捕获值初始化，再执行 body 更新；default/rest 的求值顺序有独立验证。 |
| switch 的重复 lexical | 同一 switch activation 中按实际控制流更新，不执行未命中的 initializer。 |
| 循环 lexical 与闭包 | 每轮保持独立身份；旧闭包不能改读后续迭代的值。 |
| 只有 function 声明的首次合法声明组 | 保持已有合法提升与最后声明优先行为，避免破坏普通 JS 函数代码。 |
| 已有身份的函数/类替换 | 在声明位置更新，不让尚未执行的修订提前改变旧状态。 |
| 原本非法的 function/lexical 混合重复组 | 按声明执行次序初始化和更新，不凭空提前发布较后的替换；未初始化读取仍有明确结果或失败。 |
| using / await using 的重复名称与赋值 | 名称可更新，每次资源获取的原资源与释放次序另行记录，覆盖名称不能取消旧资源的释放责任。 |

var 和可提升函数在实际 scope instantiation 阶段建立的值，应有该阶段的执行证据。所谓“只登记实际建立的 binding”，不等于机械要求所有声明都走到文本位置。普通未初始化 lexical 和没有执行的 initializer 不能被目录假定为有效值。

函数表达式、类内部 self binding 与外层名称各有作用域；外层覆盖不遍历 heap 修改旧对象。普通读取必须保留 bare call、optional call、tagged template 的 this，函数 name/length、参数与 arguments 的关系、递归和类继承不能被生成的 storage 名称无意改变。

### 5.3 声明提交、解构与部分失败

C3 要求更新边界由操作定义，而非由“这一组目标中恰好几个名称存在”决定。新代际选择：

- 每个声明 declarator 先求 RHS，再完成其 binding pattern，成功后发布该 declarator 的全部候选绑定值。
- 多个 declarator 按源码顺序分别提交，后一个失败不撤销前一个。
- 普通赋值、解构赋值和循环写入按实际写入次序发生，保留部分失败后果。
- getter、iterator、默认值、计算属性、rest 与 await 的执行次数和顺序不因适配增加；IteratorClose 与资源释放仍有明确后果。

现有混合声明采用候选提交，可作为实现经验；不能仅因它已经存在而永久保留“混合声明与全旧名称声明有不同原子性”的偶然差异。旧行为由旧语义 adapter 重放。

重复声明 pattern 中，已取得的候选值可供后续默认值读取：

```js
const [x, x = x + 1] = [1, undefined]
return x // 2
```

初始化期间，外部已有闭包仍读已提交状态；pattern 内新创建的闭包捕获候选环境，成功提交后关联到相同逻辑身份，后续更新仍可见。失败时未发布的候选不进入公开目录，但已经经用户效果逃逸的对象或闭包不会被假装撤销。这需要候选环境与提交后关联的独立用例，临时改名本身不证明正确性。

### 5.4 import、模块准备与 export

import 是值来源，不是另一套永久不可更新的名称。每个 alias 有独立身份，读取有两种状态：

| 状态 | 读取 | 更新 |
| --- | --- | --- |
| 跟随模块 | 读取已链接 namespace 的导出。 | 成功写入切换为本计算环境中的局部值。 |
| 局部覆盖 | 读取最后一次成功写入的值。 | 后续写入更新；再次静态导入重新跟随指定来源。 |

同一 alias 的既有新代际闭包通过该身份观察覆盖与重新导入。两个 alias 即使最初指向同一导出，也不会因其中一个被赋值而一起覆盖。对 +=、逻辑赋值、自增减、解构和 for-in/of 使用同一写入规则；短路未写入或 RHS 失败不切换来源。

`ns = replacement` 更新名称；`ns.member = value` 操作对象。后者不通过复制 namespace 或绕过属性契约伪造成功。此区别来自更新目标不同，不来自偏好遵守模块规范。

静态模块依赖在 body 前准备，保留 Node 的解析、链接、缓存、attributes 和模块图身份。cell 的多个 import 按声明顺序准备；全部成功后安装本 cell 的 alias 更新。同名多次 import 全部参与链接，最后一项决定 body 开始时的来源，body 中普通声明再按执行位置更新。准备中已经发生的模块效果不能回滚或忽略。

`const item = 1; import { sep as item } from 'node:path'` 的最终 item 为 1，因为 import 安装发生在 body 前。重复导入不清缓存，也不声称模块一定再次执行。

cell 的 export 修饰符保留本地声明；remote re-export 保留模块依赖效果。default 通过普通可更新身份 `__default` 暴露：

- `export default expression` 保存表达式在该位置求得的值。
- 具名默认声明先建立或更新其本地身份，`__default` 跟随该身份，直到被单独覆盖；这是让默认入口与具名修订一致的选择。
- 默认声明本身就叫 __default 时使用同一身份，不能生成自引用读取环。
- 之前存在普通 __default、import 或 default 都不构成冲突；求值失败不发布尚未完成的替换。

真实模块仍需要 native export/linker，不能把 cell 的 __default 展示约定强加给模块用户。重复显式导出名映射到一个 native export，以最后一项映射为准，较早表达式初始化与依赖加载仍按声明语义执行。星号再导出的真实缺失或歧义需由模块图解决，不能吞掉链接结果。

### 5.5 类型与其他命名空间

C1/C6 要求扫描所有声明命名空间，不能只处理普通 lexical；C3 要求给原本不合法的重复组规定确定行为。

| 命名空间 | 选定的扩展规则与实现责任 |
| --- | --- |
| TypeScript 类型 | 擦除的重复类型不阻断计算。类型空间和值空间分离；合法声明合并复用维护中的工具，enum/namespace 等运行值仍进入更新计划。 |
| private 成员 | 同类同 target 的同名成员统一解析；重复定义采用最后定义的成员形态，字段 initializer 与 decorator 求值不因定义被替代而漏掉。实例与 static storage 分开，生成私有名唯一。 |
| private 的跨 target 重名 | 按接收者实际 brand 选择相应实例或 static storage，接收者只求值一次；若对象同时满足两个 target，采用该类中源码位置较后的目标。无匹配 brand 仍是真实访问失败。 |
| getter/setter | 合法配对保留；同种 accessor 的重复采用最后定义。字段、方法、accessor 混合组必须生成完整成员定义计划，不能直接让 Babel 的重复检查决定行为。 |
| constructor | 无 body 的 TS 签名属于类型；多个实现采用最后一个构造函数体。定义较早的函数体不因“保留效果”而被执行。 |
| label | 每个 label occurrence 有唯一物理标签；break/continue 解析到最近的同名有效目标，保留控制流归属。 |

“最后定义”来自模型修订定义的明确策略，不是对意图的猜测。成员定义、字段初始化、decorator 和实例构造是不同阶段；应在 G1/G2 原型中固化其完整交叉矩阵，再依赖维护中的 class transforms 生成代码。表中选择尚未由执行原型验证，不得宣称 Babel 自带这些扩展。

除已明确更改的声明、写入与重复规则外，普通 JS/TS 的对象、表达式、算术和控制流继续使用已有语义。依赖 const 赋值抛错的代码会观察到本方案主动改变的行为，不能声称与标准 JS 完全等价；也不能因此把所有源代码绑定重新设为只读。

### 5.6 Global User Bindings：完整激活，分别覆盖

持久条目是一份由用户管理的模块输入，会话中的公开名称是可修订的计算状态。C2/C3/C5 推出两个不同粒度：

- 模块源码、选定导出、初始化和激活证据仍按完整条目验证，不能把未成功激活的部分伪装成可恢复模块。
- 激活成功后，各个公开名称分别跟随模块或持有会话覆盖。覆盖 alpha 不使同条目的 beta 消失；整条目原子激活不推出整条目必须一起遮蔽。

namespace 形式只有一个公开 namespace 名称，覆盖该名称自然替换整个 namespace 入口。对象成员修改按对象契约处理，不自动扩大成全局配置更新。

整条目遮蔽是需要改变的旧语义，见 [ADR 0023](adr/0023-global-user-bindings.md)；当前代际的新 cell 已按名称粒度记录覆盖/来源事实。新代际应记录 entry 级激活证据和 name 级覆盖/来源证据，旧 journal 仍保留当时的整条目行为。新代际中条目更新、禁用或删除不得抹去已经明确形成的会话覆盖；未覆盖名称按条目生命周期调整，旧闭包实际持有的值按引用生命周期保留。

这不会给模型新增写全局存储、启停条目或执行用户候选的管理权限，也不会把 session runtime value 自动转成持久源码。

### 5.7 动态源码、反射与入口组合

动态源码使用同一语言代际和更新语义；语法目标仍由原调用定义。直接 eval 使用调用点逻辑环境，间接 eval 使用所属 realm 的 root，Function 家族使用构造器所属全局环境。非字符串 eval 输入、参数字符串转换、同步异常和 completion 都按明确契约执行一次。

eval 的 var 进入相应 var environment，lexical 按 eval 生命周期隔离；严格与普通环境的原有隔离规则不能被粗暴合并。with 使用真正的 object environment，保留 unscopables、receiver、getter/Proxy 的查找次数；不把所有引用静态指向外层槽。

别名、成员调用、call/apply/bind/Reflect、构造器原型和递归生成源码都要接入。识别依据是 callable identity 与 realm，不是 callee 的字符串拼写。普通同名函数不被劫持。

反射同样属于组合能力：函数 name/length、源码位置以及 Function.prototype.toString 被用于再次编译时，不能暴露无法解析的内部槽引用并制造新的执行失败。需要保留源码来源及再编译所需的映射；不能伪造 native 函数可重建，也不能自动捕获原本不会被字符串携带的用户闭包。相关 adapter 的覆盖属于 G2/G3，尚无全量证明。

### 5.8 普通名称与 request-owned 能力

C1/C5 要求区分名称适配与能力身份。插件生成的私有 storage、临时 namespace、return/commit helper 必须避开用户名称，不能靠不断增加禁名让模型迁就实现。

DSH 的 tools 与 request-owned program namespace 由宿主契约拥有，普通名称更新不能改写它们的身份或续用过期 lease。当前项目明确禁止 shadow 主工具入口 tools；capabilities、code、repl 允许的普通局部 shadow 保持可用。request namespace 之间真实冲突继续交给既有 owner，不能伪装成普通重声明，也不因本方案新增一套权限规则。

这种区分依据目标身份及正式能力契约，不依据名称看起来是否像工具。普通用户对象、同名函数和任意新标识符没有这种身份时，仍按普通计算规则处理。实现内部占用的名称不得被冒充为 DSH 保留能力。

## 6. 从语义选择实现：共同编译器与连续逻辑状态

C2 要求稳定身份，C6 要求一个 owner 完整处理，C3 要求执行与证据一致。因此选定主方案为：**作用域归一化编译器、独立原生编译单元、连续逻辑状态和统一提交事实**。继续使用现有 worker、transport、lease 和 DSH 调度，不增加第二套 session coordinator。

### 6.1 编译与执行的数据流

```text
原始源码 + 语法目标 + 语言代际 + 有效策略 + 可用逻辑环境
  → 可恢复 AST、原始 occurrence 与源码位置
  → 无 scope 遍历，临时唯一化声明
  → 维护中的作用域分析建立正式语法归属
  → 逻辑 scope / 名称空间 / 引用 / 初始化与更新计划
  → 唯一 native 声明、逻辑读写、动态入口适配
  → TypeScript 转换、生成代码、独立校验、native 编译
  → CompiledUnit
  → 既有 worker 执行一次
  → 实际初始化、更新、外部调用与完成事实
  → catalog、journal、恢复判定与展示投影
```

CompiledUnit 至少携带生成代码、语法目标、源映射、环境需求、静态依赖、声明/写入操作身份和校验结果。所有消费者使用同一计划；分析器、import lowering、worker 和 UI 不能分别猜测名称是否存在或可写。

原始调用参数和模型源码保持原样。适配只形成内部可追踪产物；不改写磁盘文件、第三方安装包、DSH 源码或模型已经发出的 call。

### 6.2 前端完整性与逻辑作用域

继续以维护中的 @babel/parser、@babel/traverse 和所需生成/变换组件为主，不能为减少依赖手写一套不完整 parser。errorRecovery 只提供研究入口，不能证明所有名称冲突可解析。

先在不创建 scope 的 AST 遍历中为声明 occurrence 分配唯一临时名，再建立正式 scope。记录原名、类型、源区间与 owner。临时名避开源码所有标识符和内部生成名；词法名称、private、export、label 和 TS 名称空间分别处理。

Babel scope 是语法事实，不直接等于新语言的逻辑 owner。参数与直接 body、catch 冲突、var 穿过块、循环每轮环境、pattern 候选环境都有明确映射；引用必须按其语法位置、逻辑 owner 与初始化阶段重写。只重命名声明不重写引用不会得到正确编译器。

输入端也必须覆盖：仅因本方言允许的重复声明、裸 const 等规则而被 parser 拒绝的源码，需要补齐结构化恢复或采用具备该能力的维护中实现。不能让“拿不到 AST”成为永久的调用者错误。语言升级时通过节点与语法目标的结构覆盖检查发现缺口，不以版本白名单代替。

### 6.3 运行时存储与稳定身份

session root 使用稳定的逻辑槽，读取来源可以是本地值、模块导出、具名默认声明的身份关联或旧语义 bridge。读取先确定目标，写入按对应操作完成后发布；避免 getter、动态环境或复合赋值重复确定目标。

普通静态局部优先使用唯一 native local，让引擎管理 activation 和闭包；需要 eval、with 或候选关联的区域使用显式 frame。存储选择属于编译决策，两条路径必须满足同一语义。不能把全部局部变量提升到会话，也不对模型产生的全部对象加 Proxy。

[BindingCatalog](../internal/session-state.js) 继续持有会话名称、来源、状态和依赖证据，worker 持有实际值和局部 activation。catalog 不记录每次函数调用的整个 heap，也不成为 capability 名称分发 registry。

新 cell 在独立编译单元中执行；原始用户名称不再次声明进共享 REPL lexical 环境。重复运行只更新逻辑槽。首次初始化失败留下可修复的内部状态，不发布已成功初始化的假象，不让 native TDZ 残骸占住后续声明。

同名更新复用身份，模块覆盖释放不再需要的读取来源。旧闭包实际持有的值仍可存活，不能为“清理”改写其引用。内部映射需有可达性或保守生命周期依据；无法证明释放时应明确资源成本，不能承诺依靠普通 JS 即可精确枚举所有逃逸引用。

### 6.4 原生执行与可观察行为

cell 使用公开 Node 编译能力创建与当前 context 对齐的 async body，保留原有 top-level this、return、await、completion、cwd 与模块解析。默认 node:repl evaluator 可以替换；是否保留其外壳由成本和兼容证据决定。

生成的 setter、提交操作或私有表达式不能成为意外返回值。source map 覆盖语句边界、类型擦除、import/export 和生成 helper。函数与类的身份、反射和重新编译关系按第 5 节验证；“运行成功”不能代替这些行为证明。

内部 helper 与 storage 访问有来源标记，durability 分析识别其已知语义，不把所有生成的 globalThis 访问都当成用户外部效果，也不能把原始用户 global/globalThis、动态输入或未知模块效果错判为可恢复纯值。

### 6.5 每个产物独立检查

输出必须通过另一条只读 AST 检查路径，验证所有声明、引用、命名空间和逻辑操作都有 owner，生成的名称不冲突；随后通过相应语法目标的 parser 和 native 编译。TS 变换及 class transforms 生成的声明也要检查。

这些检查针对编译缺陷，不是新的用户准入规则。检查发现遗漏意味着版本未达到产品契约；不能把拒绝内部产物包装成“已经消除重声明错误”。不得先执行失败，再自动改源码重跑。

校验结果绑定精确源码、目标、语义代际与环境结构。运行 transport 的临时 id 与可恢复计算身份分开；后者从已证明的前序状态和源码确定，不能依赖随机 worker 名称或 UI generation。

### 6.6 所有内部执行入口共同接入

| 入口 | 适配 owner 与关键证据 |
| --- | --- |
| run_code / edit_run_code | 同一 preparation 与 CompiledUnit；保留原始参数、派生关系、call identity 和 cell lease。 |
| code.run、插件子 worker | bootstrap 安装编译器，拥有独立 root；父子状态与原有能力关系不变。 |
| 用户绑定 initializer、候选、工作台 | 在类型变换和 native 编译之前接入；工作台独立状态，不写 Agent journal。 |
| 直接 / 间接 eval | 区分调用点 frame 与 realm root，保持同步性、非字符串输入和完成值。 |
| Function / AsyncFunction / GeneratorFunction / AsyncGeneratorFunction | 参数串和 body 作为一个编译请求；保持转换顺序、call/construct、new.target 与返回类型。 |
| constructor 原型、alias、call/apply/bind、Reflect | 按真实 callable identity 与 realm 路由；参数、callee、receiver 各求值一次。 |
| vm.Script、compileFunction、各 runIn* API | 对 context 关联逻辑环境，在 native 编译前适配，保持 filename、offset、timeout、options 与实例行为。 |
| vm.SourceTextModule 和字符串模块 | module 目标适配后交给真实 linker，保留 identity、循环依赖与 live export。 |
| ESM、动态/data URL、CJS、require/createRequire | 同步 load hook 处理实际读取的 source；保留原 URL、解析条件、缓存及同步/异步行为。 |
| 新 realm、子 worker、模块内再次动态编译 | 用户源码运行前递归 bootstrap，不能假定父环境 hook 自动继承。 |

Node 的公开 module.registerHooks 是模块入口工具，不能被描述成全部编译器的总入口。模块图缓存仍由 Node 的 URL/条件规则拥有；编译缓存另含源码、语法目标、语义代际和环境结构，不能把不同 context 的闭包混用。

受现有 DSH 或 Node context 代码生成策略禁止的能力仍由其 owner 决定。adapter 不绕过限制，也不能主动禁用原本可用的 eval、vm 或 worker 来使入口表看起来封闭。

### 6.7 Bootstrap、旧引用与内外边界

worker 先加载自身固定 bootstrap 与编译器，再安装当前 realm 的模块和 callable 适配，最后运行模型代码。内部捕获的原语只供实现使用，不作为 SDK 泄露；正常用户值保持原值，不以通用对象代理替代 Node 生态。

直接 eval 显式携带逻辑环境；替换全局 eval 为普通函数不能保留它的词法契约。Function 家族要覆盖原型 constructor 与 bound callable；vm context 在首次源码执行前建立映射。

旧 journal 使用独立旧语义 adapter，旧闭包不重造。新代码不因为共享旧 worker 而退回 raw REPL 路径；旧代码持有的编译器引用仍需审计。全局对象的替换不能使已缓存原生引用自动失效。

### 6.8 架构取舍

| 候选 | 从 C1–C6 作出的判断 |
| --- | --- |
| import 专用修补、按错误码过滤 | 没有统一状态与编译事实，不能覆盖同类遗漏。 |
| 机械把全部声明改成 var/赋值 | 缺少 scope、求值顺序、模块与恢复契约，不能单独使用。 |
| 每个 cell 独立执行但不共享逻辑身份 | 避开跨次冲突，却使旧闭包和后续名称脱节。 |
| 要求模型显式使用 state 对象、先查变量或先重置 | 将 bookkeeping 和内部限制转给模型。 |
| 共同编译器 + 独立单元 + 连续环境 | 主方案。复用 Node 计算与生态，统一名称及执行事实；完整动态封闭性仍待证明。 |
| 自有闭合解释器或可控嵌入引擎 | 能使内部语义和入口证明更直接，但增加生态桥接、语义、性能与维护成本；哲学不自动要求采用。 |

选择主方案不等于已经证明它足以覆盖所有内部入口。若原型证明现有公共能力无法完成 G3，就必须重新评估执行器或获得 owner 的公开能力；不能通过删去目标内入口把主方案宣告完成。

### 6.9 已知平台限制与待证明项

第 3 节已确认 load hook 不接管 eval、Function、vm 的所有源码。任意 native addon、缓存的原生编译引用或未接入 realm 可能绕过 JavaScript wrapper。当前研究没有证明普通 Node 插件能封闭全部内部可达入口。

V8 的 SetModifyCodeGenerationFromStringsCallback 属于 embedder API。Node 已安装自己的 callback 并用于 context 决策；直接覆盖它既不保证接管全部 vm 编译，也可能破坏 owner 检查。它不能成为普通插件的万能 hook，也不能要求用户修改 DSH 安装包。

本方案的 G1 是前端完整性，G2 是转换与环境正确性，G3 是内部动态入口封闭，G4 是生命周期与边界一致性。每项都有第 11 节的完成证据。无界外部零错误已在第 2 节判定不成立，不能与这四项混为一个永远等待更多测试的任务。

## 7. 将低摩擦推广到失败、结算与资源

由 C2/C3 推出，零重声明只是必要条件。新环境还必须消除“代码已经合理，但内部阶段、状态或展示机制让计算无法继续”的错误。

### 7.1 实际更新与失败边界

| 事件 | 必须成立的后果 |
| --- | --- |
| preparation 无法确定输入解释 | body 不执行，候选计划不冒充已建立状态；诊断指出真正缺失内容。 |
| 保护策略明确禁止重复声明 | 尽可能在模块/initializer 效果前拒绝；这是显式策略结果。 |
| scope instantiation | 已实际初始化的 var/函数记录提交，尚未初始化 lexical 不发布成有效值。 |
| 静态模块准备失败 | 未提交的 alias 保持旧状态；已完成的模块效果仍被承认。 |
| 普通声明或声明 pattern 失败 | 未完成的候选值不发布；此前 declarator、赋值、对象修改和外部效果不回滚。 |
| 赋值或赋值 pattern 部分完成后失败 | 已执行的写入保留，未执行部分保持原状态。 |
| 提前 return 或用户抛错 | 不登记尚未建立的名称；已建立的状态仍有证据并可继续。 |
| 首次初始化失败后再声明 | 新声明可以修复同名状态，不需要改名或重启。 |
| 取消、超时或 worker 终止 | 依既有 owner 与可证明 frontier 恢复；不能承诺保留未记录 heap 或撤销外部效果。 |

worker 报告的是已发生操作，不是源码中出现过哪些名字。Host 核验操作属于当前 cell、语义代际与更新计划；同名多次更新用 occurrence/operation 身份区分。catalog、journal、UI 与恢复共同消费这些事实。

编译前失败、模块准备失败、body 抛错和输出失败必须区分。仅凭 SyntaxError 名称不能断言本 cell 无效果，因为动态编译可能发生在 body 已执行其他操作之后。

### 7.2 成功与失败使用共同结算规则

C3/C5 要求所有已发起 program calls 都有明确归属。成功和失败进入同一结算 owner：停止接受该 cell 的新调用，在其既有取消和时间预算内完成已发起调用的结算；不能无限等待，也不能为 drain 重置预算。

已结算结果按实际顺序记录；尚未结算或结果未知的调用使用既有 discarded/volatile 和 possible-effect 边界。不得构造缺少字段的“durable journal”，也不能为完成 journal 而重派外部调用。

迟到回复依据 call/run/lease 身份处理，使用该 call 所属的解码与资源配置，不能借用下一 cell 的当前 limits。解码失败进入受控错误路径并保存其真实效果边界，不从 message listener 抛出无人处理的异常而无故杀死整个 worker。

新编译器不新增 scheduler、租约续期或后台权限。仍存活的用户回调不能借下一次 cell 的租约继续调用已经过期的能力。

### 7.3 计算完成、结果表示与状态存活

C2/C3/C4 要求分别描述：

- 代码是否执行以及完成到哪里。
- 哪些值和外部效果已经建立。
- canonical result 是否能在当前协议及预算内表示。
- 模型和 UI 实际收到了什么。

计算已完成但返回值无法编码、展示截断或预览失败，不能被说成“代码未执行”，也不能仅为格式问题清空仍可证明有效的 live 状态。可以返回准确的结果表示诊断，让模型后续对仍可用状态继续计算；不能把有界预览当成完整结果或恢复证据。

值观察不调用 getter、Proxy trap 或 formatter 来补齐信息。展示不可读不等于程序不可用，元数据缺失不等于名称已不存在；对真实 worker 故障或资源终止也不伪造状态仍然存活。

工作台采用同样区分：编辑和展示变化本身不执行代码，普通计算或展示错误不无故重置环境；显式源环境替换、释放、停止和真实终止具有独立生命周期含义。其具体 UI 行为由工作台 owner 固化，不借本提案改变 Agent 会话身份。

### 7.4 必须消除的更广错误与静默错误

| 问题 | 推导出的验收要求 |
| --- | --- |
| const/import 不能更新、解构或循环写入被专门拒绝 | 使用统一写入规则；不能再让语法位置决定便利是否可用。 |
| 幻影 binding、失败后永久 TDZ、无故丢失兄弟名称 | 实际建立证据、可修复状态与 name 级覆盖共同守护连续性。 |
| ASI、this、反射或 TS lowering 引入额外错误 | 源码边界和可观察语义验证，不能仅断言编译通过。 |
| 异步失败导致无效 journal、迟到消息串 cell | 所有完成路径共享归属和结算规则。 |
| 编码/展示错误伪装成计算未执行 | 阶段分离，保留可证明状态和真实结果限制。 |
| 历史损坏或不可恢复值永久阻断当前调用 | 收缩到可证明状态，最差从空环境继续当前有效计算。 |
| 没有异常但旧闭包读错值、重复 getter、效果重跑 | 正确值、identity、顺序和效果次数与零错误同为验收条件。 |
| ambient 输入被误判为可恢复、隐藏状态继续存活 | 原始来源分析与模型知识边界一致，不能用错误更少掩盖错误状态。 |

这些要求不等于捕获所有 ReferenceError/TypeError 后补默认值。缺少真实输入、对象操作失败、模块缺失或外部失败仍按事实返回；能消除的是内部表示造成的拒绝和错误后果。新增便利规则必须有确定解释，不能靠模型猜测或自动重执行来兜底。

## 8. 遗忘友好、配置迁移与历史语义

依据 C2/C3/C4，连续性包含“哪些状态应留下”和“哪些状态已不再可信”。多保存一些值不能自动提高连续计算的正确性。

### 8.1 模型知识与可恢复状态的交集

在 compaction/recovery 等状态保留边界，保留集合必须同时满足：

```text
可保留状态
  = 来源与依赖可证明的可恢复状态
    ∩ 当前模型可知的状态
```

判断使用 DSH 的公共 ordered surface 和正式来源关系。原始 append-only log 提供审计，UI 清单提供展示，二者都不单独证明模型知道一个值。自然语言 compaction summary 不能被解析为 binding 恢复证据。

只替换结果而保留携带源码的 assistant call，不必机械移除相应状态；来源被遮蔽则对 live 和 cold 使用同一收缩决策。允许显式选择有界模型可见状态投影，但不默认注入它来延长隐藏状态，也不把有界投影升格成 lossless heap。

普通 live 阶段的 volatile 值仍按现有有效环境使用；无法 cold replay 不代表禁止当前计算。在保留边界证据不足时收缩，无法保留任何非空 frontier 时从空环境继续。已经没有可知 x 的情况下，`x + 1` 缺少输入，不能偷偷取旧 heap 的值或猜一个 0。

### 8.2 来源、动态代码与恢复

最后一次同名赋值不能替代完整 ancestry：旧闭包、保存的对象、模块状态和动态源码可能依赖更早定义。恢复依赖原始源码、语义代际、实际提交、记录值与正式来源关系，不把最终值相等当成内部状态相等。

动态源码的 grammar goal、调用点、环境结构和实际文本应能由已有 source/recorded value 重建，或由新封闭 schema 提供足够证据。仅有 digest、截断文本或 UI 摘要不足以证明执行语义。证据不足进入 volatile，不为了恢复去重新读外部文件或重新调用工具。

历史 PTC metadata 损坏只能否定相应恢复证据。沿最大可证明 frontier 收缩，未知依赖按保守后缀处理，并持久化和报告实际收缩一次；不重演未知效果、不声称撤销历史，也不把损坏变成之后所有 run_code 的永久错误。

### 8.3 新配置与旧五开关

新安装直接使用第 4 节的一项普通更新设置和默认模块语法。迁移要区分用户选择与实现默认：

| 已有配置 | 后续执行策略 |
| --- | --- |
| 明确的新语义选择 | 采用用户选定的完整 stateful/protected 策略；旧分项不在下游继续干预。 |
| 没有显式旧限制，或旧五项有效值均开启 | 可采用完整新默认；不要求用户先学会更多开关。 |
| 旧三个更新项全部关闭，模块语法开启 | 映射为保护策略，保持主动防止覆盖的选择。 |
| 旧更新项混合，或显式关闭 import/export | 保留有名称的旧分项兼容状态，展示其有效值；用户选择新语义后整体迁移，不用 OR/AND 或删除字段静默改变选择。 |

旧兼容状态不伪装成已获得完整新语言，也不成为新安装的常驻五开关 UI。它是同一设置区的迁移状态，支持明确选择完整更新或保护语义；选择新语义也明确接受默认模块语法。不能通过默认布尔值掩盖尚未完成的迁移。

一次 cell 从准备到结算绑定同一配置代际，配置改变只影响后续提交。当前 profile 畸形在最早可解析处报告；历史配置证据损坏依第 8.2 节收缩，二者不能混为永久 availability gate。

### 8.4 journal 代际与旧代码

当前封闭 schema 的版本常量与字段集由 [session-journal-schema.js](../internal/session-journal-schema.js) 拥有，JOURNAL_VERSION 为 8；schema 包含 bindingPolicy、rewritePolicy、moduleSemantics（含 `importExpressionBoundary`）、userBindingsFingerprint、userBindingsReusePolicy、userBindingsShadowPolicy 与 userBindingNames 等字段。字段校验、journal 创建与旧代际迁移由 [session-journal.js](../internal/session-journal.js) 拥有，事件关联与折叠恢复由 [session-journal-recovery.js](../internal/session-journal-recovery.js) 拥有。旧 ADR 描述其决策发生时的版本，不能用历史版本叙述替代当前 schema 事实。

新代际必须区分：所有作用域可写规则、裸声明、声明 pattern 提交、import/default 来源关联、特殊命名空间、动态 grammar goal、独立单元、name 级用户绑定覆盖和实际操作证据。只重解释原有两个布尔值无法表达这些变化。

旧 journal 按其记录的规则 replay，包括旧 const 可写性、旧 import 闭包、旧 default 关联、旧 pattern 部分更新和 whole-entry shadow。cold replay 返回 recorded program values，不重复派发外部效果。新的 bug 修正不能被用于伪造“历史其实按新语言运行”。

live 切换不重新执行旧源码制造闭包。可证明可写的旧 storage 可桥接；新代际代码可使用逻辑身份接替不可写旧存储。旧代码已经捕获的引用与策略保持其事实，不承诺原地改造 V8 闭包。后续新代际代码必须内部一致；这种迁移事实不能成为纯新环境的常驻例外。

如果桥接或历史源码无法证明，按既有状态边界收缩而非猜测；普通重声明本身不触发自动清空。新的语义代际、迁移器、源码映射、旧 fixture 与 UI 状态证据必须一起更新。

## 9. 模型交互与展示也服从同一哲学

C1/C4 推出：正常修订应安静完成，不每次重声明都警告，不要求先列出现有 binding，不把内部 frame、slot 或 compiler id 暴露为用户 API。模型可继续使用熟悉的源代码形式。

稳定指引说明 PTC 的真实语义：名称可以更新，局部作用域保留，重复调用仍可能产生新的外部效果，失败后按已发生状态继续。它不承诺任意外部程序零错误，也不把尚未实现的扩展提前宣传为能力。

同配置、模型路由和 native capability view 下，system text、工具 schema 和顺序保持字节稳定。变化的事实只通过既有追加 runtime-context owner 在必要时表达，不把实时 binding 表塞进稳定前缀，不新增一个总要让模型确认状态的协议。

诊断只提供会改变下一步决策的事实：实际失败阶段、已知状态后果、缺少的输入或真实 owner 拒绝。原始源码位置必须准确。对于规则已明确的正常适配，不要求模型再发一次 edit_run_code；确需修改源码的用户操作仍保留真实调用与编辑身份。

UI 清单和观察继续有界、只读并具有 generation/来源证据。无预览不说明无变量，旧 snapshot 不能证明新状态。模型状态与 UI 展示各自使用证据，不互相代替。用户管理、保存或禁用全局条目的行为也不因计算语言变宽松而获得隐式授权。

## 10. 规范与实现 owner 的完整迁移

本文只更新提案。实施时每项语义都要从同一个规范 owner 传播到代码、配置、日志、文档与测试；不能仅新增一段核心哲学而让旧准入规则继续决定行为。

| Owner / 依赖 | 目标变更与原因 |
| --- | --- |
| [CONTEXT.md](../CONTEXT.md)、[AGENTS.md](../AGENTS.md) | 对齐面向 Agent 的目的、执行与知识边界；保留其项目责任，不堆放全部语言细节。 |
| [ADR 0013](adr/0013-isolate-repl-redeclaration-convenience.md) 与新的语言 ADR | 固化完整作用域、可写、裸声明、提升、pattern 提交与保护策略；旧便利策略有明确后继关系。 |
| [ADR 0006](adr/0006-rewrite-module-syntax-with-an-ast.md) | 固化全部名称空间、import/default 的可更新来源、模块图与动态编译适配。 |
| [ADR 0014](adr/0014-persist-cell-rewrite-policy.md)、session journal owner | 新语言代际、旧五项配置、声明提交、name 级 shadow 与 replay 迁移。 |
| [ADR 0015](adr/0015-preserve-source-positions-through-rewrites.md) | 保持原始源码映射与生成边界契约；发生契约变化时记录其理由。 |
| [ADR 0023](adr/0023-global-user-bindings.md) | 完整条目激活与 name 级覆盖分离，旧 whole-entry 语义仅用于历史；管理权与源码 owner 不变。 |
| [ADR 0024](adr/0024-repl-console-observation.md) | 观察消费新 storage 证据，区分编码、展示与真实终止；不扩大读取权限。 |
| internal/cell-analysis.js、cell-rewriter.js、repl-convenience.js、typescript-transform.js | 一个解析/作用域/更新计划，移除按声明位置和旧可写性分散拒绝的路径。 |
| internal/session-state.js、kernel-worker.js、session-cell-executor.js、worker-client.js | 连续身份、独立单元、真实初始化与更新、共同结算、call 所属配置及恢复。 |
| 用户绑定 runner、owner、console worker 与插件子计算 | 所有源码共同编译、分别持有状态和生命周期；激活与覆盖使用不同粒度。 |
| internal/config-spec.js、runtime-config.js、session-runtime.js、Client | 一个普通更新开关、默认模块语法和显式旧兼容状态；保持一次 cell 的配置快照。 |
| [README.md](../README.md)、[README.en.md](../README.en.md)、[runtime-reference.md](runtime-reference.md)、[architecture.md](architecture.md) | 同步完整用户契约、配置迁移、计算方言与真实保证；实现前不宣传尚未交付能力。 |
| schema、fixture、迁移脚本、SDK/guidance、测试与生成 Client | 共享代际和行为事实，旧行为只在历史兼容测试中保留，产物由现有构建生成。 |

涉及持久架构和语义的选择在实际实施时新增或修订 ADR，记录已选方案与取舍。不能篡改历史记录来假装旧语言一直如此，也不能以旧测试通过为由保留与新契约冲突的默认行为。

## 11. 从哲学到证明与验收

### 11.1 要证明的性质

对第 2 节定义的内部计算边界、明确的 PTC 语法和开启的更新策略，任意符合初始状态约束的有限执行前缀都满足：重复名称不会导致声明拒绝，执行按第 5 节产生正确值和效果，当前可用状态有对应执行及来源证据。

这是一项安全性性质，可以对语法结构和执行步骤归纳，不要求枚举无限程序或证明所有计算都会终止。缺少真实输入或 owner 拒绝仍按其实际原因失败；不能把目标源码“有重声明”作为排除前提。

| 义务 | 必须证明的内容 | 当前证据与缺口 |
| --- | --- | --- |
| G1：前端完整性 | 定义语法中的声明/名称空间都能形成计划，扩展输入可解析，生成产物无冲突；同名输入不会因 parser/tooling 限制拒绝。 | 已有错误恢复、七类 occurrence 唯一化和裸 const AST 探针；尚未证明全语法归一化完整性。 |
| G2：语义与环境正确性 | 归一化保持定义的 scope、activation、候选提交、值、控制流、反射、资源和效果次数。 | 已有旧实现行为证据；新统一编译器、特殊名称空间和动态环境尚未验证。 |
| G3：内部入口封闭 | 所有内部可达编译路径，包括动态递归、原型、缓存引用、native 调用及 realm 都进入同一流程。 | load hook 和简单 wrapper 已有绕行反例；尚无完整封闭证明。 |
| G4：生命周期与边界一致性 | 初始状态、执行、失败、配置、恢复均保持不变量；外部结果与 DSH authority 如实保留。 | 有既有契约和测试基础；新语义的结算、桥接与恢复尚未实施。 |

G1/G2 给出单元性质，G3 使动态新单元继续满足它，G4 使状态迁移保持它。四者组合才能推出任意长轨迹的性质。错误文案消失、有限样例通过、100% 覆盖率都不能单独替代这个证明。

形式化模型需要写出声明、读取、更新、初始化、模块关联和恢复的规则，再证明实现对模型的对应关系。可用机器检查证明增强核心转换与状态机的证据；解析器、引擎、模块系统、宿主接口与外部交互假设必须明确。不能仅证明抽象 upsert 没有拒绝分支，就宣称实际 JavaScript 编译路径已被证明。

独立产物校验、native 编译和测试用于发现实现反例并保证证据落到实际源码；校验器本身拒绝了用户需要的代码时，仍属于未完成实现，不能算作“安全地实现零重声明”。

### 11.2 判别式验证矩阵

| 维度 | 必须观察的结果 |
| --- | --- |
| 名称转换 | let/const/var/function/class/named/default/namespace import、__default、用户绑定的全部适用组合；连续三次以上转换，检查旧闭包与值快照。 |
| 声明范围 | 同 cell、跨 cell、函数/块/参数/catch/switch/循环、var 区域重叠、每轮闭包、合法提升与混合组。 |
| 新语言扩展 | 局部 const 赋值、裸 const/let/var 的已有值与新值、类型和值空间、private/constructor/accessor/label 的交叉矩阵。 |
| pattern 与资源 | 全新、全旧、混合、重复目标具有同一声明提交规则；default、getter、iterator、rest、await、候选闭包逃逸与 using 释放次数。 |
| import/export | 多 alias、同/不同模块重导入、覆盖后恢复 live read、短路与失败、具名 default 关联、同名 __default、重复导出、循环依赖。 |
| 动态与反射 | eval 捕获与 var 注入、Function 参数串、with、alias/bind/Reflect/prototype、vm context、两层以上动态编译、toString 再编译。 |
| 模块与入口 | ESM/CJS/createRequire/data URL、已缓存模块、native/realm 绕行；run/edit/code.run/initializer/候选/工作台共同契约。 |
| 失败与结算 | 未执行声明不发布；提升初始化确实发布；工具 pending 后抛错、取消、迟到 reply、call 所属预算、解码失败与有效 journal。 |
| 状态和知识 | live volatile 可继续；恢复损坏收缩一次；来源被遮蔽与 result-only replacement 区分；显式投影不冒充完整 heap。 |
| 配置与历史 | 两种新策略的全部语义；旧五开关 32 组合；同 cell 配置固定；旧 pattern/闭包/whole-entry shadow 的混合代际。 |
| 结果与资源 | 编码/预览失败不伪装未执行；不可达引用释放、长期反复更新内存、真实 worker 终止与后续恢复。 |
| 能力与呈现 | DSH 原始参数/lease/结果、稳定 prompt/schema、准确 source map、有界 UI 观察和管理权。 |

以独立的目标语义模型、手写反例与生成式程序为 oracle。不得把 lowering 的产物再执行一次当作独立语义证明，也不能拿标准 REPL 的拒绝结果判断新语言是否正确。

每个用例同时断言正确值、名称归属、后续状态和效果次数。等价程序在 cell、局部、动态与模块入口交叉运行，包含“不该改写的同名普通函数”“应该保持的原值身份”等反例。未覆盖项有 owner 和补齐条件，不能仅在测试中 skip 后宣称完成。

### 11.3 实际效用与仓库验证

C1–C4 的效用指标包括：完成任务所需调用数、因内部表示而改名/包块/查库存的次数、恢复后错误引用状态的次数、错误值与重复外部效果次数。报错减少但结果变错不算改善，源码更少但隐藏状态更多也不算改善。

针对当前 proposal 的文档验证检查链接、源码事实、推导索引、相互引用与历史语义界限。后续实现按仓库 ledger 流程登记 correction、owner、dependents 与判别式验证；本提案不自动解决已记录的运行时 finding。

稳定树最后运行一次适用的确定性命令：有未终结 ledger 时用 `npm run verify`，否则用 `npm run check`，最后执行 `git diff --check HEAD --`。不以临时内存探针替代正式实现验收。

真实模型实验用来检验新语义是否实际更适合 Agent，不用于证明全量无错误。按既有 opt-in 流程，显式选择 provider/model/credential-variable、隔离 DSH home/workspace，并先进行 config-only 验证；不自动消耗模型配额或暴露凭据。

## 12. 实施顺序与自反一致的完成条件

1. **先验证关键可行性。** 用已有反例验证 parser 的扩展恢复、动态环境和 G3 封闭性；主方案不能满足目标时重选执行边界或获得正式能力，不等大规模迁移后再缩小承诺。
2. **固化语言与证明模型。** 将第 5 节规则、保护策略、内部边界和知识边界落到规范 owner，先写能区分替代语义的行为用例。
3. **实现共同编译器与状态。** 归一化全部 scope/namespace，接入连续 root、局部 activation、候选提交、反射、source map 与独立编译校验。
4. **完整接入执行入口和结算。** 动态/模块/子计算共同适配，成功与失败共同结算；全局条目完整激活和分别覆盖各有证据。
5. **完成迁移与模型知识边界。** 固化新 journal、旧五开关兼容、旧闭包桥接、恢复收缩、UI 与稳定指引。
6. **按真实证据交付。** 完成 G1–G4、行为与资源矩阵及仓库检查，同步中英文用户文档；阶段成果可以单独评审，但不能冒称完整保证。

完成不仅要求不报重声明错误，还要求 C1–C6 全部落实：语义明确的源码得到适配，名称和闭包正确连续，值与效果真实，遗忘不导致未知状态偷偷存活，DSH 权限和外部结果保持 owner 事实，实现扩展不再依赖散落的例外。

自反一致性检查应用于本文自身：每项限制都说明其用户价值或 owner 依据，每项语言扩展都有确定规则和验证，每项保留行为说明保留原因，每项历史差异有代际边界，每项技术能力区分研究事实与未证明假设。发现反例时同时修正推导、规则、实现依赖和验收，不能只在末尾追加一句新的哲学说明。

“面向 Agent 的语言”是由这些可检验的计算契约形成的方向，不是已经完成的新语言发布，也不要求先发明新的语法。其价值由模型能否方便、连续、正确地计算来验证。

## 13. 外部资料与研究边界

以下资料用于确定公开 API 的能力与限制，不要求修改 Node、V8、DSH 源码或安装包：

- [Babel parser：errorRecovery、reasonCode 与 AST](https://babeljs.io/docs/babel-parser#errorrecovery)：可以保留部分错误 AST，但仍可能遇到不可恢复输入；标准 scope 校验不是重声明修复器。
- [Node REPL：自定义 evaluator](https://nodejs.org/api/repl.html#custom-evaluation-functions)：可以替换默认执行函数，产品无需服从默认 REPL 的状态表示。
- [Node module：同步 customization hooks](https://nodejs.org/api/module.html#customization-hooks)：公开 load source 变换和解析接入；同步 hook 不应被误认为所有字符串编译的拦截器。
- [Node vm：编译 API、context 与代码生成选项](https://nodejs.org/api/vm.html)：Script、compileFunction、SourceTextModule 是独立入口；禁止 strings 只产生 EvalError，不进行归一化。
- [V8 embedder callback 声明](https://github.com/nodejs/node/blob/main/deps/v8/include/v8-isolate.h)、[Node isolate 初始化](https://github.com/nodejs/node/blob/main/src/api/environment.cc)、[Node context 代码生成控制](https://github.com/nodejs/node/blob/main/src/node_contextify.cc)：callback 由 embedder/Node 拥有，不能作为普通插件可任意替换的统一编译 hook。

研究证据包括 parser/scope 与 Node 编译入口的隔离内存探针，支持第 3 节的具体事实；它们没有实现本提案的编译器，也没有证明 G1–G4 已完成。本文为设计文档，不表示运行时代码、测试、依赖或宿主配置已经按方案调整。
