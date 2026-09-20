# Deterministic verification

`npm run check` runs `npm run verify`, checks that the source tree and review ledger did not change, and records the verified tree for the commit hook. Run `check` alone when the ledger is absent or resolved; running `verify` immediately before it repeats the full suite. While the ledger has unresolved findings, use `npm run verify` to collect verification evidence.

## Incremental independent review

Independent review is partitioned before reviewers start. Create the ignored working plan, replace every placeholder, then record it against the commit that defines the change scope:

```bash
npm run review:plan:new
npm run review:plan -- --base <base-commit>
```

The plan uses `dsh-review-plan/v1`, and the ignored root `REVIEW_PLAN.json` is its only active source. All five standard obligations from the template must remain present. Each standard or change-specific obligation is assigned to a lane or excluded with a concrete reason. A lane declares semantic scope, exact file paths or directory prefixes, upstream lanes, owners, consumers, and counterexamples. `.` selects the complete checkout. Paths only determine content inputs and changed-path coverage; they do not replace the semantic declarations. A lane fingerprint covers that declaration, its assigned obligations, selected raw Git entry identities, persistent invalidation generation, and upstream fingerprints. Dependencies must form a DAG. The plan command refuses missing standard obligations, placeholders, unknown obligations, dependency cycles, a non-ancestor base, and changed paths outside every lane.

The plan command prints one `review-lane <id> <head> <fingerprint>` line per lane. Lanes may be reviewed concurrently. Record each clean external report with the identity captured before that review:

```bash
npm run review:lane -- \
  --lane <id> \
  --evidence <report-path> \
  --expect-head <head> \
  --expect-fingerprint <lane-fingerprint>
```

The report's last non-empty line must be `VERDICT: NO FINDINGS`. A readable findings or incomplete report retires the named lane and every declared dependent from the recorded plan before checking whether the current candidate drifted; restoring an earlier tree therefore cannot revive evidence that the report rejected. An unreadable or missing report path is a command-input error and does not retire valid evidence. Unrelated lanes remain effective. A clean report retains the captured `HEAD` as provenance; an unrelated concurrent edit or `HEAD` advance does not prevent recording. Direct input, upstream fingerprint, scope, obligation, owner, consumer, counterexample, or dependency changes do. Put findings in `REVIEW_FINDINGS.md`, fix them, and rerun only the incomplete lanes shown by `npm run review:status`.

Review-state mutations and authorization decisions use one atomic lock under checkout-local Git metadata. Plan recording, clean or negative lane recording, finalization, clearing, and pre-commit therefore have one observable order. A negative report queued behind an older clean recorder advances the reported lane's persistent invalidation `{epoch, revision}`, including while that lane is temporarily absent from the current plan, before retiring its current dependent closure. Advancement increments the revision normally and rotates to a new random epoch with revision zero at `Number.MAX_SAFE_INTEGER`, so a valid tuple never becomes unretirable. A temporarily absent lane must already have a retained tuple; unknown or mistyped lane IDs are rejected rather than creating state. Every active lane must have an explicit tuple. The tuple participates in the lane fingerprint and propagates through dependency fingerprints, so an older clean report cannot be submitted after re-addition. It survives normal `review:clear` and temporary lane removal; only a review captured after retirement can authorize the repaired fingerprint. Missing, partial, or malformed generation state blocks status and authorization. Explicit clear preserves valid generations but removes damaged generation state; plan recording then creates a new random epoch, so old reports still cannot match. The lock records a PID and unique release token and bounds acquisition, but never reclaims another owner automatically. If a command crashed, confirm that no review-state command is active, obtain the exact checkout-local path with `git rev-parse --git-path review-findings/state.lock`, remove only that directory, and retry. `review:status` remains a diagnostic snapshot and does not grant authorization. Finalization and pre-commit also re-read the active plan, candidate, proof, lane records, and evidence before they persist or return a decision, so edits made outside the review commands fail closed.

Do not mutate a recorded boundary implicitly. Every status, clean lane verdict, finalization, and commit decision compares the normalized active file with the recorded plan. Missing, malformed, or semantically changed active content blocks clean authorization; it does not block a findings or incomplete report from retiring the recorded lane closure. Whitespace and object-key formatting alone do not change plan identity. When evidence reveals a missing path or semantic dependency, edit `REVIEW_PLAN.json` and run `npm run review:plan` without another `--base`; the command reuses the recorded base. The new plan hash invalidates its aggregate verdict, but clean lane records survive when their base, complete declaration, selected Git entries, upstream fingerprints, and evidence hashes are unchanged.

After `review:status` reports `clean`, run the deterministic gate once and bind the composite verdict to it:

```bash
npm run check
npm run review:finalize
git diff --check HEAD --
```

The final verdict uses `dsh-review-verdict/v2`. Pre-commit verifies its plan hash, lane fingerprints, evidence hashes, whole source fingerprint, `HEAD`, and prospective index. A later `HEAD` change retires the proof and aggregate verdict. Source or index drift blocks the gate while it differs; restoring the exact finalized candidate preserves those records, while keeping a changed candidate requires another `check` and `review:finalize`. Only lanes whose effective inputs changed need another independent review. `npm run review:clear` abandons the recorded plan, lane records, aggregate verdict, and verification proof while leaving the working `REVIEW_PLAN.json` available for revision; persistent invalidation generations remain so pre-retirement reports cannot revive in a rebuilt plan. Clearing is not a normal retry step. The prior single-report `verdict` command and `dsh-review-verdict/v1` records are not accepted.

`npm run verify` and `npm run check` validate the ledger, compare generated bundles, check syntax, run Client tests, and run all backend tests with coverage. Backend test files run in separate Node processes. The default process count is half the available CPUs, rounded down and bounded between one and four; each process can also own runtime Workers. Tests within each file retain their existing ordering. Coverage still requires 100% lines and functions and at least 95% branches, including compiler source remapping.

Use focused coverage while developing or after a full gate identifies a narrow coverage failure. Select every source whose threshold matters and the smallest test set that can distinguish the correction:

```bash
npm run coverage:focus -- \
  --source internal/source-position-map.js \
  --test test/source-position-map.test.js \
  --test test/compiler-memory-facts.test.js \
  --test test/stateful-source-line-mapping.test.js
```

Repeat `--source` and `--test` as needed. Paths must exist inside the checkout; sources must belong to the full coverage gate, and tests must be `test/*.test.js` files. Arguments after a standalone `--` are forwarded as Node test options. The focused runner uses the same compiler bytecode preparation, mock-dependent grouping, real Worker coverage instrumentation, source-map filtering, and 100% line/function plus 95% branch thresholds as the full runner. It includes selected but unexecuted sources as uncovered, so an empty report cannot pass. Its evidence and retained TAP diagnostics use the ignored `coverage/` directory.

Focused coverage establishes only the selected source-and-test relation. It does not establish full-suite compatibility and never replaces the final `verify` or `check`. A failed full gate must be diagnosed with the smallest check that reproduces its failure before another full run. Because `check` already invokes `verify`, running both consecutively against an unchanged tree repeats the full suite without adding evidence.

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

Coverage runs additionally set `DSH_PTC_TEST_WORKER_COVERAGE=1` and load `scripts/instrument-worker-coverage.mjs` through Node's `--import`; that test-only seam adds the coverage variable to the helper's inner-Worker launch environment so real kernel, console, and candidate worker branches are measured. Production never sets the marker and continues to project `NODE_V8_COVERAGE` out of the user Worker environment. Because some transport tests install module mocks before importing the real transport, the runner executes two backend groups into the same coverage directory: the mock-dependent files run without the preload, and the remaining files run with it. Each group writes its own `run-*-mock.tap` or `run-*-instrumented.tap` diagnostic, both managed by the same retention and cleanup lifecycle. Test arguments such as `--test-name-pattern` are placed before the selected file list so Node applies them to test selection rather than treating them as file inputs.

`npm run coverage` and `npm run coverage:focus` print their current stage and total elapsed time. Each invocation collects worker coverage in its own temporary directory under `coverage/`, removed after c8 finishes reporting, so simultaneous runs cannot erase or combine each other's evidence. The default report is printed to the terminal. A separate `coverage/run-*.tap` log retains Node's test diagnostics, including process exit codes and signals that the concise terminal reporter can omit. An explicit Node test reporter option replaces these default reporters. Source changes during verification still invalidate a `check` proof; separate coverage directories do not make concurrent source edits safe.

Windows Node 24 and 26 reproductions and stacks identify a cppgc finalizer (`node::contextify::ContextifyScript`, or `ContextifyContext` when coverage was enabled) running after the environment that owned its private realm was gone, which wrote through a dangling `node::Realm` during isolate teardown. The reproduction ended the whole DSH process when an in-host session worker was terminated; macOS runners also observed whole-file aborts under coverage, but the available evidence does not establish that those aborts came from the same Windows stack or that the same cause applies across platforms. The session kernel now runs in a plugin-owned helper process (`internal/kernel-child.js`); `IsolatedWorker` sends a cooperative shutdown and, if the helper does not leave within its bound, kills only that helper. DSH is no longer the worker-teardown target on any supported host, so a wedged kernel is contained as a helper failure rather than a host-native crash. `.github/workflows/ci.yml` sets `DSH_PTC_TEST_CONCURRENCY: 1` and runs `npm run check` once; the former file-level retry wrapper is gone, and any failing test or file-level abort fails that run. This boundary removes the plugin's in-host kill exposure; it neither repairs the upstream Node path nor proves the macOS abort shared the Windows cause.

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
