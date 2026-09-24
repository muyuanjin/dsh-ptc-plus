# GitHub Release Notes

本文件拥有每个 GitHub Release 的**内容取舍与写作风格**。发布流程（tag、CI 身份校验、npm staging、2FA approve）由 [publishing.md](publishing.md) 拥有；包内容由 manifest 与发布白名单拥有；面向用户的长期说明由 [README.md](../README.md) 与 [README.en.md](../README.en.md) 拥有。写 notes 时按本文件执行，不需要回看历史 Release。

## 读者与边界

读者是使用插件的用户。notes 只写他们需要知道的产品事实：能不能装、能不能跑、行为变了什么、坏掉的东西修好了什么、升级要做什么。

不写产物的生成过程：

- 不写写作时间或发行状态（“写作时”“目前”“本文完成于”）；需要指明目标发行时直接写版本号
- 不写验证与取证过程（谁在哪个客户端上核对过、跑过哪些命令、门禁结果）
- 不写内部实现与流程术语（内部模块名、实现步骤、评审与 CI 与发布自动化）
- 不写协商过程与修正记录（“按反馈”“不再使用某说法”）

验证证据留在交付记录里（CI run、发布日志、维护文档），不进入 notes。

## 先按用户视角计算重要性

从 `git log --format='%h %s%n%b' <上一个 tag>..<本次 tag>` 收集全部变更，按用户的遭遇排序后再提炼；提交顺序、提交类型（feat/fix/docs/chore）和改动行数都不参与排序。

1. **还能不能用**：对当前官方 DSH 发布与上一代宿主契约的适配、安装与升级路径、激活与启动。用户最先问的是“装上还能不能跑”，排第一。
2. **有什么变化**：新增能力、默认值变化、既有行为改变，以及需要用户动手的迁移。
3. **哪些毛病没了**：用户可观察到的错误、闪烁、失效入口、丢失的数据关系。
4. **升级要求**：Node 版本、是否需要重启、是否有配置迁移。
5. **内部交付**默认不出现；只有当它改变用户可见结果时，才用用户能理解的方式提及。

兼容性声明落在公共扩展面上——设置座位、slot、公共 `Menu` 区域、会话投影、能力探测。版本号只用于标明本次适配的目标发行，不构成版本白名单；能力与座位仍以宿主声明的公共扩展面为准（[ADR 0017](adr/0017-track-the-latest-dsh-public-surface.md)）。

## 风格

- 双语且等价：中文在前，`---` 之后是 English；两段不互相省略，小节顺序一致。小节标题用 `<h3>`，中文 anchor 用 `cn-v0XY`，英文用 `en-v0XY`。
- 一条 bullet 只写一个用户可观察的结果；写清触发条件与边界（何时生效、何时不做、是否自动执行）。
- 用用户能观察到的对象描述变化：绑定、星光菜单、设置卡片、状态提示、cell 执行。宿主声明的座位键名（如 `plugins.row.config`）保留，内部模块名和实现步骤不写。
- 不写营销形容词，也不承诺恢复能力、永久记忆等无法保证的结果。
- 结构稳定，便于读者按标题 diff 两个版本：宿主适配 → 新增 → 修复 → 升级（含安装命令）→ `Full Changelog` compare 链接。

## 模板

````markdown
[中文](#cn-v0XY) | [English](#en-v0XY)

<h3 id="cn-v0XY">宿主适配</h3>

* 本次适配的目标 DSH 发行与它使用的公共扩展面
* 不满足该契约的宿主如何继续工作

<h3>新增</h3>

* ……

<h3>修复</h3>

* ……

<h3>升级</h3>

* 需要 Node.js `^22.19.0 || >=24.0.0`；升级插件后请重启 DSH
* 是否有配置迁移，以及旧配置的表现

```sh
dsh plugin --profile <profile> add dsh-ptc-plus@<version>
```

---

<h3 id="en-v0XY">Host Compatibility</h3>

* ……

<h3>New Features</h3>

* ……

<h3>Fixes</h3>

* ……

<h3>Upgrade</h3>

* Requires Node.js `^22.19.0 || >=24.0.0`; restart DSH after upgrading the plugin

```sh
dsh plugin --profile <profile> add dsh-ptc-plus@<version>
```

---

Full Changelog: https://github.com/muyuanjin/dsh-ptc-plus/compare/<上一个 tag>...<本次 tag>
````

## 示例（v0.4.3 的宿主适配小节）

````markdown
<h3 id="cn-v043">宿主适配</h3>

* 适配 DSH 0.1.7 的公共扩展面：设置卡片注册到宿主的插件配置座位（侧栏 **插件 → 已安装** 的 `plugins.row.config`），星光入口的四个动作进入公共 `Menu` 的 `children` 区域
* 不渲染 `children` 的宿主同样可用：同一套插件自有动作区由 pinned 区域承载，上一代设置座位 `settings.plugin.item` 继续生效
* 兼容性由公共能力探测决定：探测只记录一次已挂载观测，支持 `children` 的宿主不会重复渲染
````

同一版的 `feat(review)`、`chore(release)` 等内部提交不进入 notes；测试夹具修复属于交付记录，不作为用户条目。

## 发布时的用法

1. 取全量变更：`git log --format='%h %s%n%b' <上一个 tag>..<本次 tag>`。
2. 按用户视角排序，决定每条要不要写、写在哪个小节。
3. 逐条确认陈述在产品里成立；无法确认的条目删除。
4. 按模板写完；npm 版本可安装后创建 GitHub Release（流程见 [publishing.md](publishing.md)）。
