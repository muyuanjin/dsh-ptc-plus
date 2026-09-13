# Deterministic verification

`npm run check` runs `npm run verify`, checks that the source tree and review ledger did not change, and records the verified tree for the commit hook. Run `check` alone when the ledger is absent or resolved; running `verify` immediately before it repeats the full suite. While the ledger has unresolved findings, use `npm run verify` to collect verification evidence.

Both commands validate the ledger, compare generated bundles, check syntax, run Client tests, and run all backend tests with coverage. Backend test files run in separate Node processes. The default process count is half the available CPUs, rounded down and bounded between one and four; each process can also own runtime Workers. Tests within each file retain their existing ordering. Coverage still requires 100% lines and functions and at least 95% branches, including compiler source remapping.

Source fingerprints use Git with temporary administrative files, an index and an object directory. Configuration includes and repository attributes preserve canonical content, and newly computed objects stay in the temporary directory. One tagged file inventory identifies tracked, missing, untracked and sparse entries without repeatedly starting Git for each category. The temporary files are written directly, avoiding repeated Git initialization and configuration processes; explicit Git command arguments preserve isolation across Windows/WSL command forwarders.

Set `DSH_PTC_TEST_CONCURRENCY` to a positive integer to override the backend process count. Use `1` for serial diagnosis or when CPU/memory contention affects timing-sensitive tests. This changes scheduling, not runtime compute budgets, test selection, or coverage thresholds. For example:

```bash
DSH_PTC_TEST_CONCURRENCY=1 npm run verify
```

```powershell
$env:DSH_PTC_TEST_CONCURRENCY = '1'
npm run verify
Remove-Item Env:DSH_PTC_TEST_CONCURRENCY
```

`npm run coverage` uses the same scheduling and prints test and total elapsed time. Each invocation collects worker coverage in its own temporary directory under `coverage/`, removed after c8 finishes reporting, so simultaneous runs cannot erase or combine each other's evidence. The default report is printed to the terminal. A separate `coverage/run-*.tap` log retains Node's test diagnostics, including process exit codes and signals that the concise terminal reporter can omit. An explicit Node test reporter option replaces these default reporters. Source changes during verification still invalidate a `check` proof; separate coverage directories do not make concurrent source edits safe.

Native oracle workers and external Windows command fixtures explicitly disable inherited `NODE_V8_COVERAGE`; they execute no code included by the plugin coverage gate. Subprocesses testing plugin implementations still collect coverage. PowerShell semantic-version observations share one invocation, and Windows registry fixtures read the three effective registry values with one real npm configuration query. Each retains its original inputs and assertions.

The reporting adapter filters script records before c8 merges them. It reads source-map metadata once per input file, retains maps that lead to selected original sources, and leaves unknown or malformed maps to c8. Dependency-only compiler artifacts can be excluded before remapping; mixed compiler bundles retain their original coverage records. c8 still owns merging, remapping, counters, reporting and threshold checks. This uses an isolated adapter for c8's normalization method; dependency upgrades must pass the comparison with ordinary c8, including uncovered counters and mapped sources. The raw V8 reports are not rewritten.

Runtime Workers defer parsing the compiler bundle until their first compiler operation. Ordinary cells already prepared by the host avoid that startup work. Once an uninstrumented host has initialized its compiler, it snapshots V8 compiler bytecode for subsequent session kernel Workers. Coverage runs prepare that snapshot once in a separate uninstrumented process and pass its temporary file through `DSH_PTC_COMPILER_BYTECODE`; instrumented compiler instances neither produce nor consume bytecode. The runner owns this variable and removes the file after the tests. Workers receive private bytes through their initialization data and do not inherit the temporary file setting.

A Worker uses a snapshot only when its complete compiler source matches; V8 checks bytecode compatibility and recompiles when it rejects the snapshot. Workers still initialize independent compiler realms and session state. The host retains one snapshot in memory, and each Worker discards its private copy after consumption; bytecode contains no saved program values. The bundle source, VM constructor and options are captured or isolated from source-owned mutations before execution.

Repeated Global User Binding validation reuses export descriptions and durability analysis inside the private compiler realm. Each cache keys the complete source and transform generation, retains at most 64 entries and 512 Ki characters of serialized keys, and returns fresh data to its caller. Snapshot fields, fingerprints and publication evidence still undergo validation on each request. This cache contains source-derived metadata, never executed values or module state, and is rebuilt for every compiler realm.

Cell preparation carries its successful native JavaScript parse proof into scope normalization, as module preparation already does. Decorator and resource transforms consume their feature scan's existing syntax tree through Babel's AST API. Recovered invalid decorator input retains the original parser diagnostic path. Intrinsic binding skips its source scan when the compiler recorded no bindings to replace. These changes remove repeated preparation work without changing execution budgets or coverage collection.

Nested callable reflection reuses completed ordinary function recipes inside enclosing recipes. A source-position index selects the outermost reusable descendants, and syntax inspection skips their complete AST subtrees. Each reused function already contains its generated helper dependencies; class and method definition recipes keep their separate lowering paths. If all non-native syntax is inside those substituted functions, the surrounding recipe needs no additional type-erasure pass. Enclosing type syntax and resource declarations still undergo their own lowering. Callable marker emission uses cumulative edit offsets and binary searches to retain exact source boundaries without rescanning all edits for each mapping point. Declaration analysis groups at most 64 declarations into each shared ancestry witness, so Babel assigns ownership without repeatedly walking the same ancestors or retaining a full expression graph.

Dynamic eval and Function preparation reuse source-derived compilation results within their private compiler realm. The key includes the complete source and syntax options. Every hit rechecks the original-source facts consulted by that compilation; a changed fact requires compilation again. The cache holds at most 64 entries and 2 Mi characters of serialized keys, results and source facts. Callers receive fresh metadata, and each execution still declares its variables and creates a new activation against the current environment. Cell operation plans remain with their existing compiler owner.

Optional-chain transforms allocate temporary names through the complete compilation unit's allocator. A scoped Babel adapter retains Babel's UID reservations and restores its original method when the transform completes or throws. This avoids a subsequent whole-scope rename for every generated temporary while preserving uniqueness across module regions.

Callable catalogs compress windows containing referenced source ranges. Ranges separated by at most one source block share a window, preserving compression across nearby functions; large unreferenced gaps and unused buffers are omitted. Empty catalogs retain no source buffers. Entries keep their registration order and exact UTF-16 text in the existing catalog format.

Cell preparation traverses parsed trees and edit mappings without allocating a
temporary object per unit of work. The namespace walk reads a node's own keys
once and indexes node arrays directly instead of materializing an entry pair
per property; the source-map builder validates and writes its four offsets
positionally, and replacement runs reach that builder through a direct emitter
instead of a generator and a per-run segment object. Rehomed compiler messages
write their owned data descriptor directly rather than copying a generic
descriptor first. Every one of these paths produced identical output before and
after the change; only the immediately discarded allocations are gone.

For focused diagnostics, use `npm run test:client`, `npm run test:semantics`, or Node's test runner with selected test files. These do not replace the final complete command. Model-backed evaluation remains separate and opt-in; see [Evaluation](evaluation.md).
