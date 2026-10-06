# PTC Plus context management

PTC Plus keeps the model-facing surface divided into three layers:

- stable plugin guidance and the ordered `run_code`/`edit_run_code` schema;
- the host-owned SDK and native capability descriptions;
- accepted-step runtime messages for recovery, binding configuration, and bounded notices.

Only the first and third layers are owned by this plugin. With unchanged configuration, model route, and live capability view, the plugin keeps its system section, tool schemas, and ordering byte-stable. Changing session facts are appended through the existing runtime-context owner. This preserves the host's cache boundary and prevents a recovery notice from becoming a new system prefix.

Session evidence shows why the boundary matters: state reuse, edit recovery, isolated child computation, capability discovery, and rich values can work without establishing provider billing or cache savings. The [recorded A/B evaluation](evaluations/command-goat-deepseek-v4.1-flash.md) likewise showed quality and direct-error improvements in one cohort while total traffic rose, so byte reductions are not reported as token or cost savings.

The current optimization policy is therefore:

1. Keep capability discovery progressive (`tree`, short `find`, budgeted `inspect`) and do not inject a default state projection or dynamically replace the native SDK without a host contract and a measured task benefit.
2. Keep runtime notices short, source-backed, accepted-step-only, and retractable. Journal ancestry and exact model-visible provenance remain the recovery authority; UI inventories and natural-language summaries do not extend hidden state.
3. Keep parent agents, DSH child agents, and `code.run` isolated according to their existing host/runtime owners. PTC Plus does not add cross-agent memory or a second scheduler.
4. State the value-wire boundary where it prevents a predictable model error. The stable guidance now says to return BigInt directly, avoid `JSON.stringify` for it, and never mix BigInt with `Number` arithmetic without an explicit conversion. This is a model-facing clarification; it does not change the canonical value graph or native tool JSON schemas.

Future prompt experiments must compare the complete adapter-facing system text and ordered schemas, not just character counts. They must cover ordinary continuation, failed and edited cells, compaction/recovery, rich values, malformed tool JSON, capability discovery, and parent/child scopes. A candidate is acceptable only when it preserves byte stability, does not increase tool-call or serialization errors, and reports cache-read/write, uncached input, output, reasoning, retry, and exploration measurements separately. Provider cache counters are supporting evidence rather than proof of a reusable prefix.
