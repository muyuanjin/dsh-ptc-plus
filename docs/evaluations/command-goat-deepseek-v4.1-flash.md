# Command Goat / DeepSeek V4.1 Flash 实测

## 结论范围

2026-10-05 的真实额度实验使用 Command Goat 的 `deepseek/deepseek-v4.1-flash`，在实验开始时安装官方最新 DSH。记录到的实际宿主为 `0.2.0-rc.2`、Windows Node `v24.14.0`；这些版本只标识本次证据，不是兼容性开关。插件运行时代码为 `0.4.10`、来源提交 `e36b6aab013483c1a2a31b8006a94c0bf704f95c`；本次修改范围是评估器与文档。正常 Windows DSH 配置与凭据存储未改动，实验使用独立 home 与 workspace。

验收观察到跨 cell 直接复用、同名函数/类更新、增量编辑、静态 import 和真实主／子代理独立计算及 BigInt 返回。两轮各 60 个根会话的 A/B 都没有证明普遍 token 节省：首轮环境受污染，修正实验完整家族的已报告 traffic 仍比基线高 5.67%。全部失败和成本保留，特定能力收益不能替代普通任务的质量与成本判断。

## 真实主／子代理验收

首轮 8 个场景的冻结机器结果为 **7/8**。失败场景先声明数值并返回 `declared`，再在独立 cell 复用绑定得到正确和。任务只禁止返回“此值”，oracle 却禁止返回任何值，因此这是验收指令错配。原始失败和用量保留；后续统一三个连续性任务的 setup 指令，明确禁止任何返回值，另行预定一次 durable 补充实验。

| 场景 | 冻结机器结果 | 已观察到的实际行为 |
| --- | --- | --- |
| 成功／失败 cell 的增量编辑 | 通过 | 两次只发送 delta，含一次故意语法拒绝，修复后正确完成 |
| Durable 连续绑定 | 失败：指令／oracle 错配 | 两个独立 cell 正确声明和复用；确认字符串触发冻结条件 |
| Typed program surface | 通过 | 正式能力发现、单次文件读取、单次隔离计算返回完整标记 |
| Node I/O 后连续计算 | 通过 | 精确字节摘要跨 cell 复用，保持 volatile 分类 |
| 静态 import | 通过 | 直接静态声明和后续绑定复用成功 |
| 已有／新增混合解构 | 通过 | 模型未手拆声明，绑定自动适配成功 |
| 函数／类同名更新 | 通过 | 三个独立 cell 更新并复用新实现 |
| 真实主／子代理 | 通过 | 主子绑定相互隔离，子代理同名更新、self identity 与隔离 BigInt 运算成功 |

首轮包含 8 个主会话和 1 个真实子代理，完整检查 251,524 压缩字节、774,976 解压字节、304 物理行、295 逻辑事件、38 模型循环步骤和 29 对直接调用／结果。原始行分段和文件保留 SHA-256；日志经实际 Windows 官方 Session catalog 严格恢复后，再检查所有 assistant／tool 步骤、来源关系、journal、主子身份和请求表面。

取证过程中另外修复了评估器报告的值边界：真实 child 成功返回 `2n`，旧报告直接 JSON.stringify 解码值会失败；现在报告保留 canonical `valueWire`，内存消费者仍使用原类型。循环／共享引用、undefined、非有限数及负零也通过两套报告回归。这属于实验工具缺陷，未改插件值语义；先前付费记录保持原样。

结果中有 1 个测试预设语法错误、0 个意外工具错误；未观察到状态丢失、主子绑定泄漏、BigInt 传输错误或插件 catalog 重复注入。self identity 证明的是子环境内的 live 对象关系，不是循环图跨边界传输。BigInt 在隔离计算中返回后仍可进行 BigInt 算术；这不改变 JavaScript 对 BigInt 与 Number 混合算术的规则。

每个会话内实际投递的有序 system 文本和完整工具 schema 字节稳定；不同 workspace 的 system 文本为 30,770–30,787 UTF-8 字节，schema 为 3,375 字节。9 个正式 runtime snapshot 未包含插件 catalog／状态段。仍观察到模型重复查询、重复 inspect，以及误选子代理 reasoning block；已有 SDK 指令明确区分这些用途，原生子代理结果由 DSH 拥有，插件没有改写它。

| 首轮用量范围 | 未缓存输入 | 输出（含 reasoning） | 缓存读取 | 缓存写入 | Token traffic |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8 个主会话 | 84,401 | 13,111 | 239,488 | 0 | 337,000 |
| 真实子代理 | 2,896 | 1,955 | 45,696 | 0 | 50,547 |
| 完整会话家族 | **87,297** | **15,066** | **285,184** | **0** | **387,547** |

补充实验单独执行 1 个新版 durable 场景：先声明 `19017` 且不返回任何值，再在独立 cell 直接加 `95265`，得到 `114282`。机器判定通过；原始 7/8 不变。补充用量为未缓存输入 8,790、输出 227、缓存读取 16,768、缓存写入 0，traffic 25,785。独立审计完整覆盖 18,583 压缩字节、51,122 解压字节、27 物理行、26 逻辑事件、3 模型步骤和 2 次工具调用，0 错误；系统提示 30,772 字节、schema 3,375 字节稳定，runtime snapshot 没有插件段。正式身份扫描确认此次没有子代理，因此家族用量等于根会话用量。

缓存读取占输入为 285,184 / (87,297 + 285,184) = 76.56%。这只是 provider 经 adapter 报告的缓存计数；首轮没有禁用插件的对照，不能将其解释为插件导致的缓存收益。现有 runner 总表仅计主会话；本报告根据正式父子关系及 own-event 边界独立汇总，避免把子代理漏算成节省。

## A/B 方法

冻结 15 个任务 × 每组 2 次，13 个普通任务为主要分层，强制 transport canary 和静态 import 为两个独立能力探针。两组使用同一 provider／model、权限、任务、fixture、初始 Git 历史与 dirty state；唯一配置处理差异是 `ptc-plus.disabled`。能力探针不能代替普通任务收益。

每对先后次序由执行前 run identity 与 task/repetition 的 hash 决定，两组顺序可不同（原轮先 PTC Plus 14 对、先基线 16 对）；同一配对按序执行，原机器 canary 判定通过后最多四对并行（下文披露一次假通过）。这降低固定“总先运行某组”的偏差，却没有构成 provider 缓存隔离或时间效应控制。运行选择无数值结果输入，不以有利样本停止。

使用 `ab-node-project-v1` / `1.0.0`，fixture SHA-256 为 `807580baf64e367bb2dc047c389edf471e13077d54d50ee4b3a143c38f0cebd1`；任务描述 SHA-256 为 `60ad7a844ddaf9f45c06dbd73e48c21914f51d7ba0192b34e380e89bd5ef470e`。两组保留相同的 greeting 改动和 untracked draft；原 greeting 测试故意不通过，诚实报告该失败是正确答案，顺手改成全绿违反任务。

全部尝试和失败保留，不按结果重采样。独立 reviewer 在揭示分组前按照预先冻结的事实／源码／计算 oracle，分别评分 correctness、efficiency、clarity（每项 0–3）；先封存评分与证据 hash，再关联分组。统计消费者验证独立提供的评分 seal 与实际字节一致，要求分组映射、报告与评分组成精确 60 样本双射；证据不完整即保留 incomplete 配对，正式主子家族不闭合则不报告完整成本。标签和 workspace identity 隐去，语法本身仍可能提示处理组，因此是身份盲评，不保证 reviewer 无法推测处理。

评分规则在付费结果前从任务与 fixture 冻结：correctness 0 为重要结果错误／矛盾的完成宣称／缺少必需产物，1 为重要要求未解决，2 为大体正确但有有限遗漏，3 为所有重要要求有实际证据；证据缺失单独保留 incomplete。efficiency 0–3 分别为严重、实质、轻微无谓工作和适度直接；clarity 0–3 分别为混乱／无依据确定性、明显置信失当、少量歧义和清晰且匹配证据。完成状态判断与分数分开，efficiency 或 clarity 不能补偿 correctness 回退。

数值 oracle 独立固定：普通统计和为 77、平均 9.625、中位数 9、样本方差 2287/56；分阶段原均值 9.8、中位数 7，修正后均值 9.2、中位数 7、范围 17。编辑 oracle 检查实际源码与保留 dirty bytes，并用可区分 median/average 的输入验证集成；配置 oracle 区分 retries 的非负安全整数和 timeoutMs 的正安全整数以及非法类型／边界，既有 greeting 失败保持。委派必须有正式 child 关系、实际子结论和主代理独立检查，创建 child 本身不足以证明交付完成。

盲评证据包含完整匿名 trajectory、最终文件快照、独立源码后条件与正式子代理 own-event 证据。快照原子替换，包含 ignored 文件，唯一默认排除为 Git 管理元数据；非普通文件或缺失证据保持 incomplete。原始字节私下校验后生成带独立 hash 的匿名源码视图。所有 60 个固定标签保留，缺失材料不被当作成功或删除。

比较质量、工具错误、预算与完整家族用量。Token traffic 为未缓存输入 + cacheRead + cacheWrite + 输出，reasoning 已包含在输出中；逻辑步骤不等于物理 HTTP 尝试。所有正式链接子会话只统计 own events，继承历史不重复计费。缺失 usage 不按零计，缓存计数不证明完整账单或因果关系。

## 首轮 A/B 的评估环境缺陷

第一轮固定 60 个主会话全部完成，正式日志证明另有 4 个子代理。独立匿名评分和原始日志审计分别发现：隔离启动器把 Linux 快照用的 `git` 包装器目录也加入 Windows PATH，PowerShell 因而把该脚本作为文档处理，出现空输出或管道启动错误。模型后续尝试定位 `git.exe`；额外探索的成本不能归因于插件，配置两组共享错误环境也不能保证恢复成本对称。

修正在执行世界路由的 owner：Windows 只 prepend Windows launcher 目录，Linux 快照工具只留在 WSL evaluator PATH。真实无模型探针确认原生 Git 与管道工作正常。fixture、source、模型、预算和重复数不改；另外澄清已证歧义的整数任务算法并冻结新实验，完整保留原 60 个样本、评分和用量，不按不利结果挑选替换。

| 首轮分层 | PTC Plus 完成 / 总数 | 基线完成 / 总数 | PTC Plus Traffic | 基线 Traffic | Traffic 差异 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 全部任务 | 28/30 | 25/30 | 2,663,541 | 2,199,466 | +21.10% |
| 普通任务（主要分层） | 24/26 | 23/26 | 2,595,123 | 2,075,874 | +25.01% |
| 能力探针 | 4/4 | 2/4 | 68,418 | 123,592 | -44.64% |
| 双方均完成的普通配对（次要分层） | 22/22 | 22/22 | 2,391,622 | 1,844,396 | +29.67% |

| 首轮任务 | PTC Plus / 基线完成数（各 2 次） | Correctness 合计（各满分 6） | PTC Plus / 基线 Traffic |
| --- | ---: | ---: | ---: |
| package-name | 2 / 2 | 6 / 6 | 34,279 / 29,531 |
| orientation | 2 / 2 | 5 / 5 | 88,780 / 145,494 |
| test-check | 2 / 1 | 5 / 3 | 192,327 / 222,442 |
| worktree-status | 2 / 2 | 6 / 6 | 249,383 / 137,605 |
| runtime-requirement | 2 / 2 | 6 / 6 | 92,157 / 56,099 |
| code-explanation | 2 / 1 | 4 / 5 | 83,236 / 103,763 |
| small-edit | 2 / 2 | 6 / 6 | 71,476 / 73,303 |
| negative-fact | 2 / 2 | 6 / 6 | 90,840 / 58,845 |
| static-import-cell | 2 / 0 | 6 / 0 | 34,139 / 94,061 |
| numeric-analysis | 2 / 2 | 4 / 6 | 55,621 / 50,386 |
| cross-file-change | 2 / 2 | 6 / 4 | 396,339 / 355,778 |
| boundary-repair | 2 / 2 | 6 / 5 | 424,394 / 356,745 |
| successive-calculation | 2 / 2 | 6 / 6 | 70,369 / 63,388 |
| delegated-review | 2 / 2 | 4 / 6 | 693,900 / 400,375 |
| precise-integers | 0 / 1 | 0 / 2 | 86,301 / 51,651 |

首轮盲评还保留了一次基线 test-check 擅自把 dirty greeting 改成测试期望值的失败；检查任务不授权改文件，不能把改成全绿当作检查成功。

首轮全部质量：PTC Plus 28 个完成、2 个失败；基线 25 个完成、1 个部分完成、4 个失败。普通配对 correctness 为 5 胜、14 平、7 负；能力探针为 2 胜、2 平。完成表示重要任务条件获得证据支持，仍可含少量事实错误；满分 correctness 更严格。全部成本与双方均完成的次要分层同时保留，后者没有删除原总体中的失败成本。

首轮整数任务原文为：“用真实代码处理交易金额字符串 ["9007199254740993","7","-2"]，计算精确总和，再按 3:2:1 比例以整数份额分摊（余数依次分配至前面的份额），证明三份之和等于总额。不得转换为浮点金额或损失精度；最终给出十进制结果和检验事实，不改文件。”

上述整数任务完成数是**冻结 oracle 匹配分数**，不能直接等同业务计算错误。原 prompt 没明确规定先分别计算带权份额并取整；先取总额的六分之一再乘权重，也符合原措辞并精确守恒，却得到不同份额。独立源头审查用总额 8 给出 [5,2,1] 与 [4,3,1] 两个反例，证明歧义。新实验只澄清该算法：分别 floor(total × weight / 6)，再按原份额顺序加一分配剩余整数；所有数值、oracle、预算及其余十四任务不变，原评分封存不重写。

原家族包含 60 个根会话与 4 个真实子会话，完整处理 2,731,370 存储字节、9,918,936 解压字节、4,247 物理行及 4,183 逻辑事件；411 模型步骤、347 直接调用、689 原生分派。字节范围、UTF-8、JSON、正式恢复、流与结算一致性、call/result、source 关系、主子身份和用量采用全覆盖检查。独立审阅已逐步完整读取 411/411 步 reasoning、源码、结果与最终回答；64 会话的唯一步骤身份和每步材料 hash/字节复核无遗漏，语义材料共 1,772,057 字节。完全重复的 provider 流与结算已逐字节比对，无需把重复流再算成另一执行步骤。

直接结果错误为 PTC Plus 1、基线 6；689 次原生分派中，DSH 原生 isError 为 PTC Plus 1、基线 1（后者为将子代理 ID 当作 job ID 后捕获的 unknown-job 错误），不能与直接错误重复计数。另有 34 次非零 exit（PTC Plus 18、基线 16），多次是保留 fixture 已有 greeting 测试失败，不能全称意外工具错误；15 次文档管道错误甚至可能伴随外层成功和 exit 0。PTC Plus 的错误是模型生成的畸形 glob pattern 被原生工具底层 ripgrep 拒绝。基线包括未定义名称、相对模块解析、三次静态 import 拒绝，以及 BigInt 与 Number 严格比较造成的模型自写断言失败；后者不是序列化失败。 独立核对实际 reasoning 与冻结提示发现：PTC Plus 第一例为构建独立算术证明主动手写十进制加法；第二例明确引用了允许 plain-object BigInt 的正确指导，却仍选择输出字符串。四例都将 BigInt 投影为十进制字符串，只有基线第二例实际 `JSON.stringify` 报告；这四例没有 native 子调用，不能归因于原生 JSON 参数边界。提示/schema 未观察到与 canonical V1 契约冲突，因此不能从这些例子的额外算术代码反推插件误导。shell 的外层成功不保证内部进程 exit code 成功，已分别审阅。PATH 污染影响 18 个根会话（PTC Plus 8、基线 10）、58 次 bare Git 分派与 15 次文档管道错误；不得把恢复探索计为插件缺陷。

预算共有 56 条超限记录，涉及 23 个根会话（PTC Plus 12、基线 11）；预算超限与重要任务质量分别报告。所有正式主子 model route 相同，用量完整；继承历史不重复计数。未观察到 system、工具 schema 或 runtime-context 约束失败。

| 首轮完整家族 | 未缓存输入 | 输出（含 reasoning） | 缓存读取 | 缓存写入 | Token traffic | 模型步骤 | 直接调用 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PTC Plus | 421,669 | 110,928 | 2,130,944 | 0 | 2,663,541 | 214 | 182 |
| 基线 | 390,450 | 124,152 | 1,684,864 | 0 | 2,199,466 | 197 | 165 |

每个会话的 leading system 和工具 schema 都保持字节稳定；首轮 PTC Plus 为 30,784 / 3,375 字节，基线为 26,954 / 2,130 字节。插件增加 3,830 字节系统说明与 1,245 字节 schema，这是能力的固定上下文成本，不是状态反复注入；32 个 PTC Plus 家族成员的 snapshot 都没有插件 catalog/状态段。较高缓存读取率不能抵消或证明较低账单，静态字节稳定也不证明 provider 的所有缓存键、TTL 与物理请求行为。

逐步骤审阅区分了模型事实错误与运行时缺陷：样本中的误称全部数据为奇数、虚假的最优性检验、过宽的输入契约批评、重复测试和大规模 fuzzing，并不证成插件编译/传输错误。首轮没有 capabilities.find/inspect 调用，capabilities.tree 仅一次；不能把 shell 路径恢复探索误写成插件导致的重复能力发现。连续计算任务两次 PTC Plus 都重建第二阶段数据，因此其成本不是直接复用的对照证据；前面的独立连续性验收才观察了真正跨 cell 复用。

## 修正路由与明确算法的新实验

新协议在模型调用前冻结，配置-only 与完整无模型验证通过后执行全部 60 根会话，正式扫描关联 4 子代理。原轮未替换；修正路由但尚未澄清算法的一次启动在 keyless 阶段停止，模型样本为零。新记录独立封存评分与日志，预算不因结果调高。

独立审阅已逐步全文读取 **347/347 已结算步骤**，覆盖全部 64 会话的 reasoning、源码、直接／原生结果、relay 与最终回答；语义材料 1,735,752 字节，唯一 session／assistant 身份和每步 hash 与字节索引闭合，未结算的第 348 次启动保持明确。字节审计完整覆盖 2,411,864 存储字节、8,602,961 解压字节、3,656 物理行、3,592 逻辑事件，285 次直接调用和 561 次原生分派。53 次 Git 相关分派中有 46 次 bare Git，文档管道错误与旧 helper 引用均为零。所选日志通过公开严格恢复、完整流/结算与来源检查，实际 schema 与 system 会话内稳定；两组的固定字节成本与原轮相同，无插件 catalog/状态段重复注入。

| 新实验完整家族 | 未缓存输入 | 输出（含 reasoning） | 缓存读取 | 缓存写入 | Token traffic | 已结算模型步骤 | 直接调用 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PTC Plus | 393,917 | 103,526 | 1,513,856 | 0 | 2,011,299 | 170 | 138 |
| 基线 | 368,304 | 104,114 | 1,430,912 | 0 | 1,903,330 | 177 | 147 |

记录中有 348 次 step/start、347 次已结算 assistant 步骤和 63/64 个 turn/end：一个基线真实子代理开始了第十次请求但没有结算。所有已结算请求都有 usage，未结算请求不按零费用计；此前全家族汇总只统计已落盘用量，不证明完整账单。该基线主代理也只留下中间报告，不能因 child 已创建就判定委派任务完成；另一个基线委派存在真实完成消息和主代理交叉验证。后者声称“独立 3,000 次随机 oracle”，实际源码复制 fixture 算法，零差异没有独立语义证明力。只读核对公开 headless driver 发现，它等待主代理 whenIdle、flush 主 session 后按主 turn 完成退出，不等待全部子代理。本例主代理提前结束使 one-shot 生命周期退出时子请求仍在进行；实际进程 exit 0、无超时。委派交付仍不完整，不能据 exit 0 判定成功，也不能据日志推算 HTTP 取消或该未结算请求的账单。插件不接管宿主调度以掩盖这一结果。

| 新实验分层 | PTC Plus 完成 / 总数 | 基线完成 / 总数 | PTC Plus Traffic | 基线 Traffic | Traffic 差异 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 全部任务 | 30/30 | 25/30 | 2,011,299 | 1,903,330 | +5.67% |
| 普通任务（主要分层） | 26/26 | 24/26 | 1,943,053 | 1,822,703 | +6.60% |
| 能力探针 | 4/4 | 1/4 | 68,246 | 80,627 | -15.36% |
| 双方均完成的普通配对（次要分层） | 24/24 | 24/24 | 1,585,452 | 1,530,420 | +3.60% |

| 新实验任务 | PTC Plus / 基线完成数（各 2 次） | Correctness 合计（各满分 6） | PTC Plus / 基线 Traffic |
| --- | ---: | ---: | ---: |
| package-name | 2 / 1 | 6 / 3 | 34,089 / 30,021 |
| orientation | 2 / 2 | 5 / 4 | 175,452 / 113,806 |
| test-check | 2 / 2 | 6 / 4 | 129,615 / 173,558 |
| worktree-status | 2 / 2 | 6 / 6 | 53,615 / 46,468 |
| runtime-requirement | 2 / 2 | 5 / 6 | 91,986 / 82,141 |
| code-explanation | 2 / 1 | 5 / 4 | 96,717 / 91,167 |
| small-edit | 2 / 2 | 6 / 6 | 83,268 / 71,407 |
| negative-fact | 2 / 2 | 6 / 6 | 71,208 / 71,117 |
| static-import-cell | 2 / 0 | 6 / 0 | 34,157 / 50,606 |
| numeric-analysis | 2 / 2 | 5 / 4 | 103,374 / 78,101 |
| cross-file-change | 2 / 2 | 6 / 6 | 139,054 / 200,617 |
| boundary-repair | 2 / 2 | 4 / 5 | 174,658 / 199,388 |
| successive-calculation | 2 / 2 | 6 / 6 | 82,403 / 43,377 |
| delegated-review | 2 / 1 | 4 / 3 | 702,904 / 604,026 |
| precise-integers | 2 / 2 | 5 / 5 | 38,799 / 47,530 |


独立盲评揭示新实验第一对 transport canary 的基线是假通过：模型实际 `return JSON.stringify(pkg.name)`，返回的是带引号的字符串；旧机器 validator 再次 JSON.parse 展示文本，误将它还原成要求的包名。盲评按原任务判失败，未被机器结果影响。该 pair 不满足冻结的“双方 canary 通过再扩展”条件，矩阵却已执行；故新实验是保留全部结果的描述性证据，不能称为完全遵循预登记门槛的确认性实验。原 paid report 的机器 pass、独立 fail 及全部成本保持原样；不会为纠正此误判重采样。后续评估改用公开 `tools/result` 的执行内 canonical 结果证据；细节见[评估协议](../evaluation.md#protocol)。本轮历史日志不具备该新证据，不回写机器判定。

新实验 PTC Plus 30 个完成；基线 25 个完成、1 个部分完成、3 个失败、1 个不完整。普通配对 correctness 为 **5 胜、18 平、2 负、1 不完整**；能力探针为 3 胜、1 平。普通任务的两个非完成基线样本分别是未完成的委派和code-explanation 的部分完成回答。能力探针的三个基线失败包含两次静态 import 不满足指定语法，以及一次返回经 JSON 编码的包名字符串。

普通任务 correctness / efficiency / clarity 总分分别为 PTC Plus **69 / 45 / 62**、基线 **65 / 35 / 61**（各项满分 78）。全部任务分别为 **81 / 56 / 74** 与 **68 / 45 / 70**（各项满分 90）；不完整项没有虚构完成分数。分数和完成数衡量不同条件，不能把 30/30 理解为所有陈述正确。

整数任务四例最终实际结果都满足明确的 floor(total×weight/6) 再按原顺序分配余数规则，但执行与说明仍可出错：基线第二例将 Number 索引 `0` 执行 `i += 1n`，实际抛出 “Cannot mix BigInt and other types”，随后修正成功。这是原生混合算术，不是序列化失败；PTC Plus 第一例主动转换 Number 作诊断后仍声称无浮点，第二例错误写出 T mod 6 = 4（实际 2）。基线第一例文字解释又把已加权基数重复乘权重。正确的最终份额不能掩盖模型证明／说明错误。独立盲评已记录其中一些问题；后续日志审计另行发现 PTC Plus 第二例的模数错误，而该样本冻结评分仍为满分、无 flags。冻结评分保持原样，两种检查的发现不能混为一项。

PTC Plus 唯一直接错误为模型 code-explanation 探测结果含函数，插件按不支持的输出域报 `PTC-O001`；随后代码复用仍保留的 `out` 并投影可传输数据后成功。函数可留在会话中继续调用，与把函数放入返回图是不同契约。本轮没有证明任意 JavaScript 对象都可传输，亦未观察到 BigInt canonical 编码失败。

错误层次独立对账为 1 个 PTC Plus / 5 个基线直接错误，原生分派 isError 为零；24 次原生非零退出包括 21 次 fixture 已有 greeting 断言失败、两次模型生成的外部 Node 语法错误，以及一次模型错误输出过滤表达式导致空输出与 exit 1。另有一次 `node --test test/` 的 MODULE_NOT_FOUND 被其后的 PowerShell Get-Content 掩盖为总 exit 0，后续针对具体文件的测试成功；非零标记数并非全部内部进程失败数。不得把这些全算成 plugin tool error，也不得仅凭原生 isError 为零称执行全成功。

新增语义检查还发现：所有跨文件实现都实际调用了正确 median，但新增测试数据的 median 全都等于 average，因此测试不能拒绝 `median: average(values)`；验收的独立行为 oracle 使用可区分数据，实际实现通过，测试质量缺口另记。边界配置改动正确，部分最终回答误计测试数；数值分析中有模型修复错误公式、正确结果配上错误 Σx² 的情况。两组均有额外搜索、重复测试、console 与 return 重复输出及过度输入域探测，尚无实际证据把这些行为归为插件提示冲突。

新冻结预算仍失败：23 条超限（PTC Plus 11、基线 12），涉及两组各 5 个根会话。context 配对失败为零，没有 task machine exception；free-form 正确性仍由独立盲评判定。完整家族 traffic 为 PTC Plus +5.67%，已结算步骤和直接调用更少；这些描述不能以请求减少抵消质量回退，也不能换算账单。


## 提示契约修正轮：定向主／子代理 A/B

为验证本轮提示契约修正，另以同一 Command Goat / `deepseek/deepseek-v4.1-flash` 路由
执行四类窄任务，每类两次重复、每次都有完整主会话；两组都启用 PTC Plus，唯一差异是
冻结的旧／新 `replGuidance`。任务覆盖特殊值观察、明确 JSON 输出、委派文本审查和
独立 Node 引擎对照。配置预检、安装文件、模型路由、权限、fixture、预算和主／子关系
均由独立审计核对；子代理只计 own events。独立盲评分者在揭示分组前读取 16 个匿名
packet 并封存评分，质量 **92/92**，两组每个任务层均无质量下降。

解盲后的已报告 token traffic 为候选 **560,403**、控制 **504,030**，候选高 **11.18%**；
候选 48 个已结算模型步骤、控制 47 个，直接错误分别为 3 和 5。候选在明确 JSON 任务
两次均避免了控制组出现的一次 literal `\\n` 外部脚本语法失败和一次路径准备错误，
但独立引擎层仍出现 BigInt 混合算术、原生 JSON.stringify BigInt 拒绝及函数输出边界
拒绝各类模型选择错误。它们随后都通过保留 binding、编辑或显式投影恢复；这些现象
不是 PTC Plus codec 丢值，也不证明模型永远遵守提示。委派任务两组都保留正式 child
完成关系和父级合并证据。

因此本轮确认了：run_code schema 与 PTC cell 语言契约一致；特殊值应直接观察，显式
JSON 是有损格式选择；当前 cell 足够时存在直接 Node module 路径，独立引擎仍可使用；
authoring SDK 的完整类型结构保持不变。实验支持关闭四条记录的错误归因和入口缺失，
但没有证明普遍 token、缓存或账单收益，也不能宣称任意 JavaScript 类型都可直接传输。
完整度量、错误分类和盲评封存 hash 留在 checkout-local 评估材料中，不进入版本库。

## 可复现与限制

两个仓库入口分别为 `npm run test:expensive` 和 `npm run test:ab`。先按 [配置预检](../evaluation.md#configuration-preflight) 显式配置 provider、model 与凭据变量，分别用专属 CONFIG_ONLY 入口验证隔离配置，再运行已授权模型场景。原始日志、分组映射、凭据及本机路径不进入版本库；本报告只保存方法、汇总结果和结论范围。验收、补充和两轮 A/B 共执行 138 个正式会话（129 根会话、9 子代理），合计已报告 token traffic 为 9,190,968；这不是费用清单，缺失物理尝试不按零费用解释。

## 冻结与独立证据标识

下列 SHA-256 绑定本次有限结论使用的字节对象。原始材料保留在隔离评估存储中，不随仓库发布；hash 本身不能替代内容、独立评分或重现，也不使未结算请求具有完整账单。评分先封存再关联分组，后续审计核对两组封存 hash 未变。

| 对象 | SHA-256 |
| --- | --- |
| 修正实验调用前冻结协议 | `f7c94c6abff9daf7ec81a3967f85a901cdc627916e2319a85dbc3579d8e5a0df` |
| 修正实验冻结中立评分 oracle | `9268d476bcd67037ed69590d02ccbb94936daa5e0038c120055c8cd8a582e459` |
| 修正实验任务文件 | `d4293987626bc855c9bcd1a45273ea6bcf068f88b7f1f6a203467a2ac5f3b4fd` |
| 原实验盲评分 | `95343dfac7fd7fe41df7957f65009a649fa06f0864de17c1adf5f2a087834445` |
| 原实验盲评报告 | `c7131d5c3343c38b3608f5094ec9b30623e69a9e7c895c6934acabb9b37a4176` |
| 原实验全步骤聚合索引 | `c41ae20ec9fcce51c801cb8a1cc4b4c65b788b53cc6edb3eadb942bd96f03779` |
| 修正实验匿名材料 inventory | `936f436842a4239ce5d407538cee67978584d55c66a5172e413f97f27a8d1e8c` |
| 修正实验盲评分 | `f03e01c1cbf579f1f94c2ae178932d6aac541088b98ca5a4a157abe283d0d131` |
| 修正实验盲评报告 | `fc87e454771bcf712e5d5cb94290ed3e0fa7a34f8ebba4fd45fef981a1e3744f` |
| 修正实验全步骤聚合索引 | `7b4fa7b68f53cdd333dbb43c175b3192750faaac8a409a176db075eb61b0ebea` |
| 修正实验语义覆盖闭合 | `b024fca1db2c20dbfa18422c413cc7dad9364725908cb09a5fdca9cc54aa7fab` |
| 修正实验独立日志审计报告 | `8a658a2d4138c0e0b52fadeddbce4f45da8d8f144231c50d5781bf9ecd210f85` |

## 实验任务与冻结预算

下表给出修正实验的精确任务。首轮只有 precise-integers 的算法措辞不同，原文及歧义在前文单列；其余十四条逐字相同。预算是单个根会话的验收阈值，完整家族另计。

| 任务 ID | 精确任务 |
| --- | --- |
| package-name | 请直接调用一次 run_code（不要先调用 capabilities 或其他工具）读取当前项目的 package.json。run_code 必须直接 return name 字段的 JSON 字符串值本身，不要返回对象或数组，也不要 console.log；然后报告该值。 |
| orientation | 这个项目是做什么的？ |
| test-check | 检查这个项目能否通过测试。 |
| worktree-status | 这个仓库当前有哪些未提交的变更？ |
| runtime-requirement | 这个项目要求的最低 Node.js 版本是什么？ |
| code-explanation | 解释 internal/value-wire.js 中 projectValueWire 的返回策略。 |
| small-edit | 在 package.json 中新增 test:unit 脚本，值为 node --test，并验证 JSON 有效。 |
| negative-fact | README 是否要求 Python 3.12？只报告结论和依据。 |
| static-import-cell | 在 run_code cell 中直接使用静态 import 声明导入 node:path 的 basename（不要改写为动态导入），用它返回 C:/logs/session.jsonl 的文件名，并报告该文件名。 |
| numeric-analysis | 读取 data/facts.json 的实际数据，解释其用途；另对 [2,3,5,7,11,13,17,19] 计算和、平均值、中位数、样本方差并核对结果。只读操作，最终给出数据来源和全部数值。 |
| cross-file-change | 让 lib/processor.js 的 summarize 在保留 count/average 契约基础上增加 median 字段；使用现有 stats 模块中的 median，添加覆盖空数组、奇数和偶数长度的自动化测试，然后运行所有测试。保留已有未提交变更。 |
| boundary-repair | 修复 internal/config.js：retries 只接受非负安全整数，timeoutMs 只接受正安全整数；无效值恢复现有 defaults。增加负数、零、小数和合法边界测试并运行整个套件，保持其他字段语义及既有未提交变更。 |
| successive-calculation | 分步骤计算以下固定数据。先读取并保留 [3,7,7,12,20]，计算原始平均值与中位数；然后把 12 修正为 9，再计算平均值、中位数和范围；最后解释两阶段差异。每阶段需要用一次真实代码执行得到结果，不要写文件，不预设 REPL 是否保留状态。 |
| delegated-review | 请委派一个真正的独立子代理只读审查 src/math/stats.js 的平均值和中位数实现，覆盖空数组、奇偶长度、重复值和输入数组是否被排序改变。主代理独立运行少量验证后比较子代理结论，最终给出有依据的审查结果。不要改文件，也不要修改模型路由。 |
| precise-integers | 用真实代码处理交易金额字符串 ["9007199254740993","7","-2"]，计算精确总和，再按 3:2:1 比例分摊。先分别对总额乘以每个权重再除以 6 向下取整，得到三份整数基础份额；把总额减去三份基础份额之和的剩余单位，按原份额顺序依次给前面的份额，每份加一，直到分完。证明三份之和等于总额。不得转换为浮点金额或损失精度；最终给出十进制结果和检验事实，不改文件。 |

所有任务的 runtime-context 实验条件相同：两组均为 `{ "allowed": [], "requiredTransitions": [], "maxSnapshotChars": 8192 }`，不允许插件 catalog/状态注入；仅 package-name 为 canary。

预算向量依次为 `maxModelRequests / maxDirectCalls / maxSourceChars / maxRepeatedSourceCalls / maxResultChars / maxAssistantChars / maxTokenTraffic / maxRuntimeContextChars`；分别约束逻辑模型步骤、直接调用、源码字符、重复源码、结果字符、回答字符、报告的 token traffic 和 runtime-context 字符。

| 任务 | 完整预算向量 |
| --- | --- |
| package-name | 4 / 3 / 6000 / 0 / 30000 / 12000 / 40000 / 16000 |
| orientation | 5 / 4 / 12000 / 0 / 50000 / 20000 / 60000 / 20000 |
| test-check | 6 / 5 / 16000 / 0 / 100000 / 20000 / 80000 / 24000 |
| worktree-status | 5 / 4 / 12000 / 0 / 50000 / 20000 / 60000 / 20000 |
| runtime-requirement | 5 / 4 / 12000 / 0 / 50000 / 20000 / 60000 / 20000 |
| code-explanation | 6 / 5 / 18000 / 0 / 80000 / 30000 / 80000 / 24000 |
| small-edit | 6 / 5 / 18000 / 0 / 80000 / 20000 / 80000 / 24000 |
| negative-fact | 5 / 4 / 12000 / 0 / 50000 / 20000 / 60000 / 20000 |
| static-import-cell | 5 / 3 / 8000 / 0 / 30000 / 10000 / 50000 / 24000 |
| numeric-analysis | 12 / 10 / 30000 / 1 / 150000 / 40000 / 240000 / 40000 |
| cross-file-change | 12 / 10 / 30000 / 1 / 150000 / 40000 / 240000 / 40000 |
| boundary-repair | 12 / 10 / 30000 / 1 / 150000 / 40000 / 240000 / 40000 |
| successive-calculation | 12 / 10 / 30000 / 1 / 150000 / 40000 / 240000 / 40000 |
| delegated-review | 12 / 10 / 30000 / 1 / 150000 / 40000 / 240000 / 40000 |
| precise-integers | 12 / 10 / 30000 / 1 / 150000 / 40000 / 240000 / 40000 |


复现使用顶层数组，每个条目包括 `id`、上表的 `prompt`、完整八维 `machineBudget`、`validator` 和两组 `runtimeContexts`；未设置额外 headerPolicy。Validator 及额外字段如下：

| 任务 | validator | 额外字段 |
| --- | --- | --- |
| package-name | `package-name` | `{"canary":true}` |
| orientation | `blind` | 无 |
| test-check | `test-gate` | 无 |
| worktree-status | `git-status` | 无 |
| runtime-requirement | `package-engine` | 无 |
| code-explanation | `blind` | 无 |
| small-edit | `package-script` | `{"script":"test:unit","value":"node --test"}` |
| negative-fact | `readme-phrase` | `{"phrase":"Python 3.12"}` |
| static-import-cell | `blind` | 无 |
| numeric-analysis | `blind` | 无 |
| cross-file-change | `blind` | 无 |
| boundary-repair | `blind` | 无 |
| successive-calculation | `blind` | 无 |
| delegated-review | `blind` | 无 |
| precise-integers | `blind` | 无 |

单一小型 fixture、单一模型路由与每任务两次重复只能提供描述性观测。未预登记或进行统计显著性检验；同一任务的重复也不能当作不同项目的独立样本。不能据此保证任意项目都有收益，也不能证明所有数据类型、冷恢复、所有原生工具、provider 重试、远端缓存规则或实际费用。
