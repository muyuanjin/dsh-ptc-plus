# PTC Value Graph V1

## 三个投影

PTC runtime value、持久 wire 与模型文本是三个不同契约：

```text
JavaScript value
  -> ptc-value-graph/v1 envelope     worker IPC / journal / replay identity
  -> structured JSON or TS-like text outer execution-seam projection
```

wire 从不使用 `eval` 或 `Function` 解码，模型文本也从不作为可执行序列化读取。

## 支持域

`PTCValueV1` 支持：

- `null`、boolean、string、普通 finite number；
- `undefined`、`NaN`、正负 Infinity、`-0`、BigInt；
- plain object 的 enumerable string-keyed data values；
- 普通 array，包括 hole；
- cycle 与 shared reference，identity 在 hydrate 后保持。

以下值明确拒绝：function/closure、Promise、WeakMap/WeakSet、symbol value 或 symbol key、accessor、arbitrary class prototype、Date、Map、Set、RegExp、ArrayBuffer、typed array 和其他 live/executable resource。encoder 读取 property descriptor，不调用 getter。writable/configurable flags 不属于 PTC Value V1 的值图语义，hydrate 后统一成为普通 data property；Proxy 仍属于 worker 隔离与执行预算问题，不因 codec 自动变安全。

## Canonical envelope

持久值使用封闭 JSON-safe envelope：

```ts
{
  codec: "ptc-value-graph/v1",
  root: Atom,
  nodes: Node[]
}
```

`Atom` 是 JSON primitive，或封闭 tag：`undefined`、special number、BigInt、node reference。object node 保存有序 `[key, Atom]` entries；array node 保存 `length` 与有序 `[index, Atom]` entries，因此 hole 与显式 `undefined` 不同。decoder 拒绝未知/额外字段、重复 key/index、越界或 dangling reference、不可达 node 和非 canonical 编码；`__proto__` 通过 data descriptor hydrate，不触发 setter。

graph 发现顺序与 ECMAScript own-key 顺序共同确定唯一编码。plain JSON tree 保持线性；shared object 只编码一次。结构预算为 `maxValueNodes`、`maxValueEdges`、`maxValueArrayLength` 和 `maxValueBigIntDigits`；`maxValueArrayLength` 同时限制单个数组长度与一份 graph 中全部数组声明的累计槽位，decoder 在分配目标数组前完成整个 wire 的结构、预算、可达性与 canonical 校验。总 IPC/journal/render byte ceiling 继续由 `maxOutputBytes` 约束。

## Completion 与外层投影

worker completion 显式携带 `hasValue`，协议字段缺失不能与已编码的 JavaScript `undefined` 混淆。显式 `return undefined` 有值；自然无输出的声明 cell 仍保持无值。

DSH 的公共执行缝/tool output 只接受 JSON-safe structured value。为保持社区插件边界：

- dense、无 shared identity 的 plain JSON tree 继续作为 structured result 返回；
- 包含 `undefined`、special number、BigInt、hole、shared identity 或 cycle 的合法 PTC value 使用确定性、有 byte ceiling 的 TS-like renderer，作为 string result 进入外层执行缝；
- 外层投影是 untagged overlapping union：plain JSON 根值本身也可以是 string，调用方不能用 `typeof value === "string"` 判断是否经过 renderer；
- renderer 只是模型展示，不参与 hydrate；需要继续计算时应保留 live REPL binding；
- journal 保存 canonical graph envelope，不保存 renderer 反解析结果，也不把 decoded rich value 交给外层 `JSON.stringify`。

unsupported value、shape 与预算超限使用 `PTC-O001` 并给出路径与对应帮助：预算超限要求缩小 graph；类型或 descriptor 不支持要求显式选取所需 data。已完成计算不会自动重试或清空 worker，可在后续 cell 使用 retained binding。Date 可显式选取 ISO 文本或 timestamp，Map/Set 可显式选取 entries/values；这些是调用方选择的数据投影，不是 codec 自动转换。诊断不调用 getter、toJSON、用户方法或额外的 Proxy reflection；未知原型不猜测 class name。`undefined` 属于受支持值，不要求模型用 `null` 替换。

cell program binding 的参数和结果经过同一 graph IPC，因此 owner-provided binding 可以接收和返回
完整 `PTCValueV1` 支持域，包括 `undefined`、special number、BigInt、hole、shared identity 与 cycle。
跨 worker 后得到的是 hydrate 的值图，不是同一个 live object；function、class instance、Promise、
accessor 和其他不在支持域内的资源会在 dispatch 前或返回 cell 前被拒绝。journal 保存相同的 canonical
envelope，cold replay 以 recorded value 重建结果而不重新调用 owner binding。

## 子计算与 native 边界

插件自有隔离 `code.run` 从已结算的 canonical completion hydrate 子值，保留支持域内的类型、hole、cycle 与 shared identity，不合并父子 binding。无 return 时省略 `result`，显式 `return undefined` 时保留该属性。递归子计算使用同一边界；内部 program completion 校验 graph 与传输预算，不生成无用的模型展示，因此可在父程序中读取无需展开的稀疏数组。真实 native `run_code` member 的委托仍返回其 owner-defined canonical result；legacy upstream 分支保留原契约。历史 recorded-value 字符串原样读取，不反解析或重新执行子 cell。决策与平台 serializer 评估见 [ADR 0034](adr/0034-keep-program-values-separate-from-output-projections.md)。

以上 graph IPC 能力不扩展 native `tools.*` 的 JSON 输入/输出契约。真实调用仍由 DSH 按 live schema 与 lossless JSON 验证；BigInt 在插件内部可传输，但不能据此作为 native JSON 参数。直接 `return {big: 2n}` 无需 `JSON.stringify`；显式 `JSON.stringify` 对 BigInt 的拒绝和 `2n + 1` 的混合算术错误保持原生语义，不自动丢精度转换。

模型检查结果时可直接返回所需数据或类型观察。`JSON.stringify` 是显式 JSON 格式选择：它省略对象中的 `undefined` 和函数，将 `NaN`、正负 Infinity 写成 `null`，将 `-0` 写成 `0`；这些文本不再证明原值的类型或区别。函数和资源留在 live binding 中使用，输出明确选取其可传输观察，不自动过滤不支持的成员。

program binding 参数编码失败发生在 dispatch 前；已完成 binding 的返回值编码失败明确报告调用已完成及可能已有外部效果，不能仅为取得结果重复调用。完成结果的拒绝保持 worker live；参数/结果错误仍使用该程序入口的错误路径。纯数据对象不在 V1 支持域时仍可在 live binding 内计算；live 可用性不证明跨边界传输或 cold recovery 能力。
