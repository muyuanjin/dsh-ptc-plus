# 语义义务与编译验证

[`semantic-obligations.json`](../semantic-obligations.json) 是插件自有语义边界的 tracked owner graph，[ADR 0031](adr/0031-close-semantic-obligations-by-owner.md) 定义其闭合范围。`npm run semantic:check` 要求 `internal/`、`src/`、`index.js`、`client.js` 与 journal migration entry 中的每个受管实现文件恰好归属一个义务，并核对 contract、可执行 evidence、依赖图、journal 连续代际以及 language/module 导出代际。报告分别统计 `preserved`、`intentional-difference`、`bounded-external` 与 `unknown`；只有 `unknown: 0` 才表示声明范围内闭合，不表示对全部 Node 或 DSH 行为的等价证明。

每项义务必须记录 owner、实现边界、源 contract、可观察量、入口、生命周期、代际、平台边界、消费者、oracle 与 evidence。新增文件会直接使 source inventory 失败；现有 owner 内新增转换时，维护者还必须判断它是否改变当前义务、依赖或 oracle。能够从中央注册点机械闭合的边界继续使用更强检查，例如 realm mutation 的分类写入入口、journal schema 和 language/module generation set。该图不能替代具体反例、覆盖率或独立 review lane。

`npm run test:semantics` 运行三个互补的确定性编译测试层。它们也由 `npm run verify` / `npm run check` 的常规测试发现机制执行，不需要网络或模型调用。定向命令用于快速诊断，不能替代完整检查、资源验收和独立审查。

| 层 | Oracle 与执行方式 | 代码 owner |
| --- | --- | --- |
| 保留的 JavaScript 语义 | 固定版本的 Test262 原文与官方 assertion harness；先在新的 Node Script realm 执行，再在新的 stateful/protected cell 执行 | `test/semantic-test262.test.js` |
| PTC 方言 | 声明来源 × 后续操作的明确契约；检查旧闭包、保存的原值、完整 declarator 发布、失败后的状态与真实效果 | `test/semantic-dialect.test.js` |
| 编译器边界 | 协议操作、参数环境或动态错误 × root/function/eval/module 入口；同一源码先在原生 Node 执行，再比较 PTC 的值与显式源码效果 | `test/semantic-boundaries.test.js` |

Test262 子集位于 `test/fixtures/test262/`。`manifest.json` 记录上游仓库、精确 revision、每份原始文件的 SHA-256、语义主题和适用策略。测试验证源码及 harness 的校验值，遵守 strict/noStrict 运行要求；未知 flags、缺少 includes 和未适配的 negative 测试直接使测试配置失败。harness canary 验证错误断言确实会在两个执行路径中失败。

此子集覆盖 lexical 初始化、函数参数/函数体环境、引用求值顺序、迭代器关闭、调用 receiver 与异常完成值。它不代表完整 Test262 合规：PTC cell 有自己的顶层执行契约，尚未接入全套 module/async/realm/agent harness。TypeScript、装饰器、资源管理、真实模块图和历史代际继续由现有专项测试验证。

方言差异必须有规范依据和配对断言。例如提案 §5.1 允许 stateful 赋值先建立值，后续裸声明保留它，因此原生 TDZ 写入拒绝用例只适用于 protected；manifest 指向相应方言断言。不得为了通过而修改上游源码、悄悄跳过失败或把实现限制登记成方言差异。

扩充子集时，从 manifest 的 revision 检出 Test262，原样复制所选用例、依赖的 harness 和 LICENSE，更新校验值及语义主题；升级 revision 时核对全部已选文件。普通测试始终读取仓库内固定输入。优先补齐未覆盖的语义规则与入口组合，而非堆积同一反例的拼写变体。

矩阵是有限笛卡尔积，失败名称会给出协议、操作和入口，可用 Node 的 `--test-name-pattern` 单独复现。原生比较不执行 lowering 产物来生成预期值。涉及对象身份或副作用顺序的规则还需要直接契约断言；相同 JSON 不能证明任意对象等价。扩大生成范围时保留稳定输入和可独立复现的最小案例，禁止无记录的随机种子或无限生成。

当前边界矩阵包括参数默认值闭包与函数体 eval 的组合、六种描述符继承字段与 namespace 反射，以及替换错误构造器后的 eval / Function 失败。装饰器测试用维护中的 TypeScript 标准装饰器 lowering 作独立对照，验证继承属性不成为私有控制状态，同时保留公开 context/access 对象的原型和显式属性读取。资源专项测试把私有栈、函数绑定和 Promise 协议同时替换，并检查 getter/disposer 的原生 caller、receiver、GetMethod 校验顺序、异步间隔和异常身份；原生 Node 24 与强制降级路径比较，Node 22 执行降级路径。真实模块直接持有资源声明，源码重建另经共享语言 lowerer 验证。连续控制台测试跨 cell 保留协议修改，再验证后续计算与恢复，沿用原有资源限额。

失败先写入 checkout-local `REVIEW_FINDINGS.md`，明确规范 owner、共同根因和受影响消费者，再修改实现。源码作用域可见性由 `dynamic-scope-analysis.js` 共享；私有描述符的读写与 Proxy 传输由 `compiler-descriptors.js` 统一处理；`compiler-storage-source.js` 为运行时和独立源码重建提供同一组存储操作；编译失败分类由 `compiler-service.js` 使用编译 realm 的捕获构造器。测试不会使错误抽象自动正确，同类错误跨入口复发时必须纠正其共同边界。

## 发布验证边界

完整确定性检查与有效的独立审查 lane 聚合是提交门槛，不代表发布稳定性证明。发布前仍需补齐 Node 22/24 下连续会话、反复创建与释放 worker、覆盖插桩和资源压力组合的稳定性验证。进程级失败必须保留原始退出码、signal 与 stderr；仅有测试文件级 `test failed` 无法区分运行时缺陷、引擎退出或外部终止。

Windows Node 24/26 的 worker teardown native 崩溃已由插件自有 helper 进程边界限制在可回收子进程内（见 [ADR 0027](adr/0027-run-the-session-kernel-in-a-killable-helper-process.md)）；`npm run check` 现在执行一次确定性运行，不再根据 TAP 文件级 abort 自动重试。发布前仍须在受支持 Node 版本上保留原始退出码、signal 与 stderr，并覆盖连续创建/释放 helper、覆盖插桩和资源压力组合。文件级失败仍按实际 owner 修复，不得用重试掩盖。
