(() => {
  // internal/config-spec.js
  var MAX_TIMER_DELAY_MS = 2147483647;
  var SETTINGS_NAMESPACE = "ptc-plus";
  var CONFIG_FIELDS = Object.freeze([
    {
      key: "enabled",
      type: "boolean",
      default: true,
      label: "\u542F\u7528 PTC Plus",
      labelEn: "Enable PTC Plus",
      description: "",
      descriptionEn: ""
    },
    {
      key: "enhancedToolView",
      type: "boolean",
      default: true,
      label: "\u4F7F\u7528 PTC Plus \u589E\u5F3A\u5DE5\u5177\u5361\u7247",
      labelEn: "Use enhanced PTC Plus tool cards",
      description: "\u5F00\u542F\u65F6\u4F7F\u7528 PTC Plus \u5DE5\u5177\u5361\u7247\uFF1B\u5173\u95ED\u540E\u4F7F\u7528 DSH \u539F\u751F run_code \u548C edit_run_code \u5DE5\u5177\u5361\u7247\u3002",
      descriptionEn: "When enabled, PTC Plus renders the tool cards; when disabled, run_code and edit_run_code use DSH native tool cards."
    },
    {
      key: "autoDescribeRunCode",
      type: "boolean",
      default: true,
      label: "\u81EA\u52A8\u8865\u5168\u7F3A\u5931\u7684 run_code \u6458\u8981",
      labelEn: "Auto-fill missing run_code summaries",
      description: "\u7F3A\u5C11\u5916\u5C42\u6458\u8981\u65F6\u751F\u6210\u56FA\u5B9A\u7684 UI \u6458\u8981\uFF1B\u539F\u59CB\u8C03\u7528\u53C2\u6570\u3001\u5DF2\u6709\u6458\u8981\u3001\u4EE3\u7801\u548C\u5D4C\u5957 native \u5DE5\u5177\u53C2\u6570\u4FDD\u6301\u4E0D\u53D8\u3002",
      descriptionEn: "Adds a fixed UI summary when the outer summary is missing; original call arguments, existing summaries, code, and nested native-tool arguments remain unchanged."
    },
    {
      key: "canonicalizeToolCalls",
      type: "boolean",
      default: true,
      label: "\u4FEE\u590D\u53EF\u8BC6\u522B\u7684\u9876\u5C42 native \u5DE5\u5177\u8BEF\u8C03\u7528",
      labelEn: "Repair recognizable top-level native tool mis-calls",
      description: "\u4EC5\u5F53\u5F53\u524D schema \u80FD\u552F\u4E00\u786E\u8BA4\u76EE\u6807\u5DE5\u5177\u4E14\u53C2\u6570\u6709\u6548\u65F6\uFF0C\u4FEE\u590D\u9876\u5C42 native \u5DE5\u5177\u8BEF\u8C03\u7528\u3002",
      descriptionEn: "Repairs a top-level native tool mis-call only when the current schema uniquely identifies the target and validates its arguments."
    },
    {
      key: "cordisToolsEnabled",
      type: "boolean",
      default: false,
      label: "\u5728 PTC \u6A21\u5F0F\u4E2D\u542F\u7528\u5B98\u65B9 Cordis \u5DE5\u5177",
      labelEn: "Enable official Cordis tools in PTC mode",
      description: "\u5F00\u542F\u540E\uFF0CPTC agent \u53EF\u4F7F\u7528\u5B98\u65B9 Cordis \u5DE5\u5177\u3001\u914D\u5957\u6307\u5F15\u548C\u5F00\u53D1 Skill\uFF1B\u5173\u95ED\u540E\u79FB\u9664\u8FD9\u4E9B\u80FD\u529B\u3002Cordis \u5DE5\u5177\u4EE5 DSH \u8FDB\u7A0B\u6743\u9650\u8FD0\u884C\u3002",
      descriptionEn: "When enabled, PTC agents can use the official Cordis tools, guidance, and development Skill; disabling removes them. Cordis tools run with the DSH process permissions."
    },
    {
      key: "looseTopLevelRedeclarations",
      type: "boolean",
      default: true,
      label: "\u5141\u8BB8\u9876\u5C42\u53D8\u91CF\u91CD\u58F0\u660E",
      labelEn: "Allow top-level variable redeclarations",
      description: "\u5141\u8BB8\u9876\u5C42 const \u6216 let \u58F0\u660E\u66FF\u6362\u5DF2\u6709\u53D8\u91CF\uFF1B\u5173\u95ED\u540E\uFF0C\u91CD\u58F0\u660E\u4F1A\u5728\u6267\u884C\u524D\u88AB\u62D2\u7EDD\u3002",
      descriptionEn: "Allows top-level const or let declarations to replace existing variables; disabling rejects redeclarations before execution."
    },
    {
      key: "autoRewriteImports",
      type: "boolean",
      default: true,
      label: "\u652F\u6301\u9759\u6001 import \u58F0\u660E",
      labelEn: "Support static import declarations",
      description: "\u5141\u8BB8\u5728 run_code \u4E2D\u4F7F\u7528\u9759\u6001 import\uFF0C\u5E76\u4FDD\u7559\u6A21\u5757\u89E3\u6790\u548C\u53EA\u8BFB binding \u8BED\u4E49\u3002",
      descriptionEn: "Allows static import declarations in run_code while preserving module resolution and read-only binding semantics."
    },
    {
      key: "autoStripExports",
      type: "boolean",
      default: true,
      label: "\u652F\u6301\u9876\u5C42 export \u4FEE\u9970\u7B26",
      labelEn: "Support top-level export modifiers",
      description: "\u5141\u8BB8\u5728 run_code \u4E2D\u4F7F\u7528\u9876\u5C42 export\uFF0C\u5E76\u4FDD\u7559\u5BF9\u5E94\u7684\u672C\u5730\u58F0\u660E\u6216\u6A21\u5757\u526F\u4F5C\u7528\u3002",
      descriptionEn: "Allows top-level export syntax in run_code while preserving the corresponding local declaration or module side effect."
    },
    {
      key: "autoSplitRedeclarations",
      type: "boolean",
      default: true,
      label: "\u652F\u6301\u6DF7\u5408\u89E3\u6784\u91CD\u58F0\u660E",
      labelEn: "Support mixed destructuring redeclarations",
      description: "\u5141\u8BB8\u9876\u5C42\u89E3\u6784\u58F0\u660E\u540C\u65F6\u5305\u542B\u65B0\u53D8\u91CF\u548C\u5DF2\u6709\u53D8\u91CF\u3002",
      descriptionEn: "Allows top-level destructuring declarations to contain both new and existing variables."
    },
    {
      key: "durableReplay",
      type: "boolean",
      default: true,
      label: "\u542F\u7528\u6301\u4E45 REPL \u6062\u590D",
      labelEn: "Enable durable REPL recovery",
      description: "worker \u91CD\u542F\u540E\u4ECE session journal \u91CD\u5EFA\u53EF\u6062\u590D\u7684 REPL \u72B6\u6001\u3002",
      descriptionEn: "Rebuilds recoverable REPL state from the session journal after a worker restart."
    },
    {
      key: "tipsEnabled",
      type: "boolean",
      default: true,
      label: "\u542F\u7528\u5931\u8D25\u6062\u590D\u63D0\u793A",
      labelEn: "Enable failure recovery tips",
      description: "\u5728\u7B26\u5408\u6761\u4EF6\u7684\u5931\u8D25\u540E\u663E\u793A\u6709\u51B7\u5374\u95F4\u9694\u7684\u6062\u590D\u63D0\u793A\u3002",
      descriptionEn: "Shows recovery tips with a cooldown after qualifying failures."
    },
    {
      key: "computeMs",
      type: "integer",
      default: 6e4,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u5355 cell CPU \u65F6\u95F4\u4E0A\u9650 (ms)",
      labelEn: "CPU time limit per cell (ms)",
      description: "\u540C\u6B65\u8BA1\u7B97\u8D85\u8FC7\u8BE5\u4E0A\u9650\u65F6\u4E2D\u65AD\u5F53\u524D cell\u3002",
      descriptionEn: "Interrupts the current cell when synchronous computation exceeds this limit."
    },
    {
      key: "maxWallMs",
      type: "integer",
      default: 6e5,
      min: 1,
      max: MAX_TIMER_DELAY_MS,
      label: "\u5355 cell \u603B\u8017\u65F6\u4E0A\u9650 (ms)",
      labelEn: "Elapsed time limit per cell (ms)",
      description: "\u9650\u5236\u5B8C\u6574 cell \u6267\u884C\u7684\u8017\u65F6\uFF0C\u5305\u62EC\u5F02\u6B65\u7B49\u5F85\u3002",
      descriptionEn: "Limits the complete cell execution time, including asynchronous waits."
    },
    {
      key: "maxOldGenerationSizeMb",
      type: "integer",
      default: 512,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6BCF\u4E2A worker \u65E7\u751F\u4EE3\u5185\u5B58\u4E0A\u9650 (MiB)",
      labelEn: "Old-generation memory limit per worker (MiB)",
      description: "\u9650\u5236\u6BCF\u4E2A worker \u7684 V8 \u65E7\u751F\u4EE3\uFF1B\u6D3B\u52A8 worker \u5B58\u5728\u65F6\u4E0D\u80FD\u4FEE\u6539\u3002",
      descriptionEn: "Limits the V8 old generation for each worker; this setting cannot change while a worker is active."
    },
    {
      key: "maxNestedRunCodeDepth",
      type: "integer",
      default: 8,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "code.run \u5D4C\u5957\u5C42\u6570\u4E0A\u9650",
      labelEn: "code.run nesting depth limit",
      description: "\u9650\u5236\u5355\u4E2A\u9876\u5C42 cell \u4E2D code.run \u7684\u6700\u5927\u5D4C\u5957\u5C42\u6570\u3002",
      descriptionEn: "Limits the maximum code.run nesting depth within one top-level cell."
    },
    {
      key: "maxOutputBytes",
      type: "integer",
      default: 64 * 1024 * 1024,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u5355 cell \u8F93\u51FA\u4E0A\u9650 (bytes)",
      labelEn: "Output limit per cell (bytes)",
      description: "\u9650\u5236\u5355\u4E2A cell \u7684\u65E5\u5FD7\u548C\u8FD4\u56DE\u7ED3\u679C\u7684\u5408\u8BA1\u5927\u5C0F\u3002",
      descriptionEn: "Limits the combined size of one cell's logs and returned result."
    },
    {
      key: "maxValueNodes",
      type: "integer",
      default: 1e5,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u8FD4\u56DE\u503C\u8282\u70B9\u6570\u4E0A\u9650",
      labelEn: "Returned-value node limit",
      description: "\u9650\u5236\u5355\u6B21\u8FD4\u56DE\u503C\u7684 Value Graph \u8282\u70B9\u6570\u3002",
      descriptionEn: "Limits the Value Graph node count for one returned value."
    },
    {
      key: "maxValueEdges",
      type: "integer",
      default: 1e6,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u8FD4\u56DE\u503C\u5F15\u7528\u8FB9\u6570\u4E0A\u9650",
      labelEn: "Returned-value reference-edge limit",
      description: "\u9650\u5236\u5355\u6B21\u8FD4\u56DE\u503C\u7684 Value Graph \u5F15\u7528\u8FB9\u6570\u3002",
      descriptionEn: "Limits the Value Graph reference-edge count for one returned value."
    },
    {
      key: "maxValueArrayLength",
      type: "integer",
      default: 1e6,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u8FD4\u56DE\u6570\u7EC4\u957F\u5EA6\u4E0A\u9650",
      labelEn: "Returned-array length limit",
      description: "\u9650\u5236\u8FD4\u56DE\u6570\u7EC4\u7684\u6700\u5927\u58F0\u660E\u957F\u5EA6\u3002",
      descriptionEn: "Limits the maximum declared length of a returned array."
    },
    {
      key: "maxValueBigIntDigits",
      type: "integer",
      default: 1e5,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u8FD4\u56DE\u503C BigInt \u5341\u8FDB\u5236\u4F4D\u6570\u4E0A\u9650",
      labelEn: "Returned-value BigInt decimal-digit limit",
      description: "\u9650\u5236\u8FD4\u56DE\u503C\u4E2D BigInt \u7684\u5341\u8FDB\u5236\u4F4D\u6570\u3002",
      descriptionEn: "Limits the decimal-digit count of BigInt values in one returned value."
    },
    {
      key: "tipCooldownMessages",
      type: "integer",
      default: 3,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u540C\u7C7B\u6062\u590D\u63D0\u793A\u95F4\u9694 (messages)",
      labelEn: "Same-kind recovery tip interval (messages)",
      description: "\u540C\u7C7B\u6062\u590D\u63D0\u793A\u4E4B\u95F4\u7684\u6700\u5C0F\u95F4\u9694\u3002",
      descriptionEn: "The minimum gap between recovery tips of the same kind."
    },
    {
      key: "tipEscalationFailures",
      type: "integer",
      default: 2,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u8BE6\u7EC6\u6062\u590D\u63D0\u793A\u9608\u503C (failures)",
      labelEn: "Detailed recovery tip threshold (failures)",
      description: "\u8FDE\u7EED\u5931\u8D25\u8FBE\u5230\u6B64\u6B21\u6570\u540E\u663E\u793A\u66F4\u8BE6\u7EC6\u7684\u6062\u590D\u63D0\u793A\u3002",
      descriptionEn: "After this many consecutive failures, a more detailed recovery tip is shown."
    }
  ]);
  var CONFIG_GROUPS = Object.freeze([
    {
      key: "core",
      label: "\u5E38\u7528\u4E0E\u517C\u5BB9\u6027",
      labelEn: "Common and compatibility",
      fields: Object.freeze(["enabled", "enhancedToolView", "autoDescribeRunCode", "canonicalizeToolCalls"])
    },
    {
      key: "optional",
      label: "\u53EF\u9009\u80FD\u529B",
      labelEn: "Optional capabilities",
      fields: Object.freeze(["cordisToolsEnabled"])
    },
    {
      key: "advanced",
      label: "\u9AD8\u7EA7\u884C\u4E3A",
      labelEn: "Advanced behavior",
      fields: Object.freeze([
        "looseTopLevelRedeclarations",
        "autoRewriteImports",
        "autoStripExports",
        "autoSplitRedeclarations",
        "durableReplay",
        "tipsEnabled"
      ])
    },
    {
      key: "limits",
      label: "\u8D44\u6E90\u9650\u5236",
      labelEn: "Resource limits",
      fields: Object.freeze([
        "computeMs",
        "maxWallMs",
        "maxOldGenerationSizeMb",
        "maxNestedRunCodeDepth",
        "maxOutputBytes",
        "maxValueNodes",
        "maxValueEdges",
        "maxValueArrayLength",
        "maxValueBigIntDigits",
        "tipCooldownMessages",
        "tipEscalationFailures"
      ])
    }
  ]);
  var CONFIG_DEFAULTS = Object.freeze(
    Object.fromEntries(CONFIG_FIELDS.map((field) => [field.key, field.default]))
  );

  // src/client-activity.js
  var JOURNAL_VERSIONS = /* @__PURE__ */ new Set([1, 2, 3]);
  var JOURNAL_STATUSES = /* @__PURE__ */ new Set(["durable", "volatile", "discarded", "noop"]);
  var BINDING_MODES = /* @__PURE__ */ new Set(["loose", "strict"]);
  var JOURNAL_FIELDS = /* @__PURE__ */ new Set([
    "version",
    "bindingMode",
    "rewritePolicy",
    "status",
    "calls",
    "operations",
    "confirms",
    "diagnostics",
    "completion",
    "volatileReason"
  ]);
  var LEGACY_JOURNAL_FIELDS = new Set([...JOURNAL_FIELDS].filter((key) => key !== "rewritePolicy"));
  var REWRITE_POLICY_FIELDS = /* @__PURE__ */ new Set([
    "autoRewriteImports",
    "autoStripExports",
    "autoSplitRedeclarations"
  ]);
  var CALL_SUCCESS_FIELDS = /* @__PURE__ */ new Set(["global", "member", "args", "ok", "value", "settle"]);
  var CALL_ERROR_FIELDS = /* @__PURE__ */ new Set(["global", "member", "args", "ok", "error", "settle"]);
  var OPERATION_FIELDS = /* @__PURE__ */ new Set(["action", "name"]);
  var RETURN_FIELDS = /* @__PURE__ */ new Set(["kind", "hasValue", "value"]);
  var THROW_FIELDS = /* @__PURE__ */ new Set(["kind", "error"]);
  var ERROR_FIELDS = /* @__PURE__ */ new Set(["kind", "message"]);
  var DIAGNOSTIC_FIELDS = /* @__PURE__ */ new Set([
    "code",
    "severity",
    "phase",
    "message",
    "stateEffect",
    "dispatchState",
    "source",
    "cause",
    "help"
  ]);
  var SOURCE_FIELDS = /* @__PURE__ */ new Set(["cell", "start", "end"]);
  var POSITION_FIELDS = /* @__PURE__ */ new Set(["line", "column"]);
  var CAUSE_FIELDS = /* @__PURE__ */ new Set(["code", "message"]);
  var SEVERITIES = /* @__PURE__ */ new Set(["error", "warning", "note"]);
  var PHASES = /* @__PURE__ */ new Set(["parse", "preflight", "execute", "tool-dispatch", "replay", "recover"]);
  var STATE_EFFECTS = /* @__PURE__ */ new Set(["unchanged", "partially-applied", "rolled-back", "unknown"]);
  var DISPATCH_STATES = /* @__PURE__ */ new Set(["not-dispatched", "dispatched", "completed", "unknown"]);
  var REWRITE_FIELDS = /* @__PURE__ */ new Set(["kind", "description", "source"]);
  var REWRITE_KINDS = /* @__PURE__ */ new Set(["import", "redeclaration", "export"]);
  var REWRITE_POLICY_BY_KIND = Object.freeze({
    import: "autoRewriteImports",
    redeclaration: "autoSplitRedeclarations",
    export: "autoStripExports"
  });
  var EDIT_TARGET_FIELDS = /* @__PURE__ */ new Set(["targetCallSeq"]);
  var DERIVED_RUN_FIELDS = /* @__PURE__ */ new Set(["code", "description"]);
  var RECOVERY_BOUNDARY_FIELDS = /* @__PURE__ */ new Set(["failedCallSeq", "frontierCallSeq"]);
  var VALUE_ENVELOPE_FIELDS = /* @__PURE__ */ new Set(["codec", "root", "nodes"]);
  var VALUE_OBJECT_FIELDS = /* @__PURE__ */ new Set(["type", "prototype", "entries"]);
  var VALUE_ARRAY_FIELDS = /* @__PURE__ */ new Set(["type", "length", "entries"]);
  var VALUE_UNDEFINED_FIELDS = /* @__PURE__ */ new Set(["tag"]);
  var VALUE_NUMBER_FIELDS = /* @__PURE__ */ new Set(["tag", "value"]);
  var VALUE_BIGINT_FIELDS = /* @__PURE__ */ new Set(["tag", "value"]);
  var VALUE_REFERENCE_FIELDS = /* @__PURE__ */ new Set(["tag", "index"]);
  var MAX_VALUE_NODES = 1e5;
  var MAX_VALUE_EDGES = 1e6;
  var MAX_ARRAY_LENGTH = 1e6;
  var MAX_BIGINT_DIGITS = 1e5;
  var MAX_STRING_BYTES = 64 * 1024 * 1024;
  var textEncoder = new TextEncoder();
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function hasClosedFields(value, allowed, required = []) {
    if (!isRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key) || !Object.prototype.propertyIsEnumerable.call(value, key))) return false;
    return [...required].every((key) => Object.hasOwn(value, key));
  }
  function hasExactFields(value, fields) {
    return hasClosedFields(value, fields, fields) && Reflect.ownKeys(value).length === fields.size;
  }
  function hasExactOrderedFields(value, fields) {
    if (!isRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    const ordered = [...fields];
    return keys.length === ordered.length && keys.every((key, index) => key === ordered[index] && Object.prototype.propertyIsEnumerable.call(value, key));
  }
  function isLine(value) {
    return typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value);
  }
  function isSafeSequence(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }
  function isValidPosition(value) {
    return hasExactFields(value, POSITION_FIELDS) && Number.isSafeInteger(value.line) && value.line >= 1 && Number.isSafeInteger(value.column) && value.column >= 1;
  }
  function isValidDiagnosticCause(value, depth) {
    if (depth > 16 || !isRecord(value)) return false;
    if (Object.hasOwn(value, "severity")) return isValidDiagnostic(value, depth + 1);
    return hasClosedFields(value, CAUSE_FIELDS, ["message"]) && (value.code === void 0 || isLine(value.code)) && isLine(value.message);
  }
  function isValidDiagnostic(value, depth = 0) {
    if (!hasClosedFields(value, DIAGNOSTIC_FIELDS, [
      "code",
      "severity",
      "phase",
      "message",
      "stateEffect"
    ])) return false;
    if (typeof value.code !== "string" || !/^[A-Z][A-Z0-9-]{2,31}$/.test(value.code) || !SEVERITIES.has(value.severity) || !PHASES.has(value.phase) || !STATE_EFFECTS.has(value.stateEffect) || !isLine(value.message)) return false;
    if (value.dispatchState !== void 0 && !DISPATCH_STATES.has(value.dispatchState)) return false;
    if (value.source !== void 0) {
      if (!hasClosedFields(value.source, SOURCE_FIELDS, ["cell", "start"]) || !isLine(value.source.cell) || !isValidPosition(value.source.start) || value.source.end !== void 0 && !isValidPosition(value.source.end)) return false;
      if (value.source.end !== void 0 && (value.source.end.line < value.source.start.line || value.source.end.line === value.source.start.line && value.source.end.column < value.source.start.column)) return false;
    }
    if (value.cause !== void 0 && !isValidDiagnosticCause(value.cause, depth)) return false;
    return value.help === void 0 || Array.isArray(value.help) && value.help.length <= 3 && value.help.every(isLine);
  }
  function isArrayIndexKey(value) {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return false;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < 4294967295 && String(parsed) === value;
  }
  function accountText(value, state) {
    state.textBytes += textEncoder.encode(value).byteLength;
    return state.textBytes <= MAX_STRING_BYTES;
  }
  function isValidValueAtom(value, state) {
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "string") return accountText(value, state);
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
    if (!isRecord(value) || typeof value.tag !== "string") return false;
    if (value.tag === "undefined") return hasExactOrderedFields(value, VALUE_UNDEFINED_FIELDS);
    if (value.tag === "number") {
      return hasExactOrderedFields(value, VALUE_NUMBER_FIELDS) && ["nan", "infinity", "-infinity", "-0"].includes(value.value);
    }
    if (value.tag === "bigint") {
      if (!hasExactOrderedFields(value, VALUE_BIGINT_FIELDS) || typeof value.value !== "string" || !/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value.value)) return false;
      const digits = value.value[0] === "-" ? value.value.length - 1 : value.value.length;
      return digits <= MAX_BIGINT_DIGITS && accountText(value.value, state);
    }
    if (value.tag !== "reference" || !hasExactOrderedFields(value, VALUE_REFERENCE_FIELDS) || !isSafeSequence(value.index) || value.index >= state.nodeCount) return false;
    if (!state.discovered.has(value.index)) {
      if (value.index !== state.discovered.size) return false;
      state.discovered.add(value.index);
    }
    return true;
  }
  function isValidValueWire(value) {
    if (!hasExactOrderedFields(value, VALUE_ENVELOPE_FIELDS) || value.codec !== "ptc-value-graph/v1" || !Array.isArray(value.nodes) || value.nodes.length > MAX_VALUE_NODES) return false;
    const state = {
      nodeCount: value.nodes.length,
      discovered: /* @__PURE__ */ new Set(),
      edges: 0,
      textBytes: 0
    };
    if (!isValidValueAtom(value.root, state)) return false;
    for (const [nodeIndex, node] of value.nodes.entries()) {
      if (!state.discovered.has(nodeIndex) || !isRecord(node)) return false;
      if (node.type === "array") {
        if (!hasExactOrderedFields(node, VALUE_ARRAY_FIELDS) || !Number.isSafeInteger(node.length) || node.length < 0 || node.length > MAX_ARRAY_LENGTH || !Array.isArray(node.entries)) return false;
        let previous = -1;
        for (const entry of node.entries) {
          if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] <= previous || entry[0] < 0 || entry[0] >= node.length) return false;
          previous = entry[0];
          state.edges += 1;
          if (state.edges > MAX_VALUE_EDGES || !isValidValueAtom(entry[1], state)) return false;
        }
        continue;
      }
      if (node.type !== "object" || !hasExactOrderedFields(node, VALUE_OBJECT_FIELDS) || !["object", "null"].includes(node.prototype) || !Array.isArray(node.entries)) return false;
      const keys = /* @__PURE__ */ new Set();
      let previousArrayIndex = -1;
      let sawOtherKey = false;
      for (const entry of node.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || keys.has(entry[0]) || !accountText(entry[0], state)) return false;
        keys.add(entry[0]);
        if (isArrayIndexKey(entry[0])) {
          const current = Number(entry[0]);
          if (sawOtherKey || current <= previousArrayIndex) return false;
          previousArrayIndex = current;
        } else {
          sawOtherKey = true;
        }
        state.edges += 1;
        if (state.edges > MAX_VALUE_EDGES || !isValidValueAtom(entry[1], state)) return false;
      }
    }
    return state.discovered.size === value.nodes.length;
  }
  function isValidRewritePolicy(value) {
    return hasExactFields(value, REWRITE_POLICY_FIELDS) && [...REWRITE_POLICY_FIELDS].every((key) => typeof value[key] === "boolean");
  }
  function isValidCall(value) {
    if (!isRecord(value) || value.ok !== true && value.ok !== false) return false;
    const fields = value.ok ? CALL_SUCCESS_FIELDS : CALL_ERROR_FIELDS;
    if (!hasExactFields(value, fields) || typeof value.global !== "string" || typeof value.member !== "string" || !isValidValueWire(value.args) || !isSafeSequence(value.settle)) return false;
    return value.ok ? isValidValueWire(value.value) : typeof value.error === "string";
  }
  function isValidOperation(value) {
    if (!hasClosedFields(value, OPERATION_FIELDS, ["action"]) || !["save", "restore", "delete"].includes(value.action)) return false;
    if (value.action === "restore" && value.name === void 0) return true;
    return typeof value.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name);
  }
  function isValidCompletion(value) {
    if (!isRecord(value) || !["return", "throw"].includes(value.kind)) return false;
    if (value.kind === "return") {
      if (!hasClosedFields(value, RETURN_FIELDS, ["kind", "hasValue"]) || typeof value.hasValue !== "boolean") return false;
      return value.hasValue ? Object.hasOwn(value, "value") && isValidValueWire(value.value) : !Object.hasOwn(value, "value");
    }
    return hasExactFields(value, THROW_FIELDS) && hasExactFields(value.error, ERROR_FIELDS) && typeof value.error.kind === "string" && typeof value.error.message === "string";
  }
  function isValidConfirms(value, version) {
    if (value === void 0) return true;
    if (!Array.isArray(value) || new Set(value).size !== value.length) return false;
    if (version === 1) return value.length === 0;
    return value.every(isSafeSequence);
  }
  function isReadableJournalUnchecked(value) {
    if (!isRecord(value) || !JOURNAL_VERSIONS.has(value.version) || !JOURNAL_STATUSES.has(value.status)) {
      return false;
    }
    const fields = value.version === 1 ? LEGACY_JOURNAL_FIELDS : JOURNAL_FIELDS;
    const required = ["version", "bindingMode", "status", "calls", "operations", "diagnostics"];
    if (value.version !== 1) required.push("rewritePolicy");
    if (!hasClosedFields(value, fields, required) || !BINDING_MODES.has(value.bindingMode) || value.version !== 1 && !isValidRewritePolicy(value.rewritePolicy) || !Array.isArray(value.calls) || !value.calls.every(isValidCall) || !Array.isArray(value.operations) || !value.operations.every(isValidOperation) || !isValidConfirms(value.confirms, value.version) || !Array.isArray(value.diagnostics) || !value.diagnostics.every(isValidDiagnostic)) return false;
    const settlementOrder = value.calls.map((call) => call.settle).sort((left, right) => left - right);
    if (settlementOrder.some((settle, index) => settle !== index)) return false;
    const requiresCompletion = value.status === "durable" || value.status === "volatile";
    if (requiresCompletion && !isValidCompletion(value.completion) || !requiresCompletion && value.completion !== void 0 && !isValidCompletion(value.completion)) return false;
    if ((value.status === "discarded" || value.status === "noop") && (value.calls.length !== 0 || value.operations.length !== 0)) return false;
    if (value.volatileReason !== void 0 && (typeof value.volatileReason !== "string" || value.status !== "volatile" && value.status !== "discarded")) return false;
    return true;
  }
  function isReadableJournal(value) {
    try {
      return isReadableJournalUnchecked(value);
    } catch {
      return false;
    }
  }
  function isCountableJournal(value) {
    return isReadableJournal(value) && JOURNAL_STATUSES.has(value.status) && Array.isArray(value.calls) && Array.isArray(value.operations) && Array.isArray(value.diagnostics);
  }
  function isValidRewrites(value, journal) {
    try {
      return journal.status !== "noop" && isValidRewritePolicy(journal.rewritePolicy) && Array.isArray(value) && value.every((rewrite) => hasClosedFields(rewrite, REWRITE_FIELDS, ["kind", "description"]) && REWRITE_KINDS.has(rewrite.kind) && journal.rewritePolicy[REWRITE_POLICY_BY_KIND[rewrite.kind]] === true && typeof rewrite.description === "string" && rewrite.description.length > 0 && (rewrite.source === void 0 || typeof rewrite.source === "string"));
    } catch {
      return false;
    }
  }
  function isValidEditTarget(value) {
    try {
      return hasExactFields(value, EDIT_TARGET_FIELDS) && isSafeSequence(value.targetCallSeq);
    } catch {
      return false;
    }
  }
  function isValidDerivedRun(value) {
    try {
      return hasExactFields(value, DERIVED_RUN_FIELDS) && typeof value.code === "string" && typeof value.description === "string";
    } catch {
      return false;
    }
  }
  function isValidRecoveryBoundaries(value) {
    try {
      return Array.isArray(value) && value.every((boundary) => hasExactFields(boundary, RECOVERY_BOUNDARY_FIELDS) && isSafeSequence(boundary.failedCallSeq) && (boundary.frontierCallSeq === null || isSafeSequence(boundary.frontierCallSeq)));
    } catch {
      return false;
    }
  }
  function isValidEditRelation(meta, args, journal) {
    try {
      if (!isRecord(meta) || !isRecord(args) || !isValidEditTarget(meta.dshPtcPlusEdit) || !isValidDerivedRun(meta.dshPtcPlusDerivedRun) || journal.status === "noop") return false;
      if (Object.hasOwn(meta, "dshPtcPlusRecoveryBoundaries") && !isValidRecoveryBoundaries(meta.dshPtcPlusRecoveryBoundaries)) return false;
      return !Object.hasOwn(args, "expected_target_call_seq") || args.expected_target_call_seq === meta.dshPtcPlusEdit.targetCallSeq;
    } catch {
      return false;
    }
  }
  function rawArguments(block, settled) {
    const call = settled ? block.call : block;
    return typeof call?.argsRaw === "string" ? call.argsRaw : typeof call?.arguments === "string" ? call.arguments : "";
  }
  function parseArguments(raw) {
    try {
      const value = JSON.parse(raw);
      return isRecord(value) ? value : void 0;
    } catch {
      return void 0;
    }
  }
  function resultText(block) {
    if (!Array.isArray(block.content)) return "";
    try {
      const parts = block.content.map((item) => item?.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item, null, 2));
      if (parts.length === 0 && isRecord(block.error)) {
        return [block.error.name, block.error.code].filter((value) => typeof value === "string").join(": ");
      }
      return parts.filter((value) => typeof value === "string").join("\n");
    } catch {
      return "";
    }
  }
  var MIXED_REDECLARATION = "split a mixed top-level declaration while preserving native pattern initialization";
  var GENERATED_RUN_CODE_DESCRIPTION_KEY = "dshPtcPlusRunCodeDescription";
  function rewriteFeature(rewrites, predicate, key) {
    const matching = rewrites.filter(predicate);
    if (matching.length === 0) return void 0;
    const sources = [...new Set(matching.map((rewrite) => rewrite.source).filter((source) => source !== void 0))];
    return { key, detail: sources.join(", ") };
  }
  function operationFeatures(operations) {
    const keys = {
      save: "feature.stateSaved",
      restore: "feature.stateRestored",
      delete: "feature.stateDeleted"
    };
    return operations.map((operation) => ({
      key: keys[operation.action],
      detail: operation.name ?? ""
    }));
  }
  function uniqueFeatures(features) {
    const seen = /* @__PURE__ */ new Set();
    return features.filter((feature) => {
      if (feature === void 0) return false;
      const identity = `${feature.key}\0${feature.detail}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }
  function isDurableRecoveryDiagnostic(diagnostic) {
    return diagnostic.code === "PTC-R002" && diagnostic.severity === "warning" && diagnostic.phase === "recover" && diagnostic.stateEffect === "rolled-back";
  }
  function derivePtcToolView(block, toolName = void 0) {
    const settled = isRecord(block) && block.kind === "tool-result";
    const argsRaw = isRecord(block) ? rawArguments(block, settled) : "";
    const args = parseArguments(argsRaw);
    const code = typeof args?.code === "string" ? args.code : argsRaw;
    const explicitDescription = typeof args?.description === "string" && args.description.length > 0 ? args.description : void 0;
    const generatedDescription = settled && isRecord(block.meta) && typeof block.meta[GENERATED_RUN_CODE_DESCRIPTION_KEY] === "string" && block.meta[GENERATED_RUN_CODE_DESCRIPTION_KEY].length > 0 ? block.meta[GENERATED_RUN_CODE_DESCRIPTION_KEY] : void 0;
    const description = (explicitDescription ?? generatedDescription)?.split(/\r?\n/, 1)[0] ?? "";
    const output = settled ? resultText(block) : "";
    const state = !settled ? "running" : block.error?.code === "interrupted" ? "stopped" : block.isError === true ? "error" : "ok";
    const journal = settled && isRecord(block.meta) && isCountableJournal(block.meta.dshPtcPlus) ? block.meta.dshPtcPlus : void 0;
    if (journal === void 0) {
      return Object.freeze({ state, description, code, output, ptc: false, features: Object.freeze([]) });
    }
    const rewrites = isValidRewrites(block.meta.dshPtcPlusRewrites, journal) ? block.meta.dshPtcPlusRewrites : [];
    const resolvedToolName = typeof toolName === "string" ? toolName : typeof block.call?.name === "string" ? block.call.name : "";
    const recordedToolName = typeof block.call?.name === "string" ? block.call.name : void 0;
    const safeEdit = resolvedToolName === "edit_run_code" && (recordedToolName === void 0 || recordedToolName === "edit_run_code") && isValidEditRelation(block.meta, args, journal);
    const features = uniqueFeatures([
      safeEdit ? { key: "feature.safeEdit", detail: "" } : void 0,
      rewriteFeature(rewrites, (rewrite) => rewrite.kind === "import", "autoRewriteImports.label"),
      rewriteFeature(rewrites, (rewrite) => rewrite.kind === "export", "autoStripExports.label"),
      rewriteFeature(rewrites, (rewrite) => rewrite.kind === "redeclaration" && rewrite.description === MIXED_REDECLARATION, "autoSplitRedeclarations.label"),
      journal.calls.some((call) => call.global === "code" && call.member === "run" && call.ok === true) ? { key: "feature.codeRun", detail: "" } : void 0,
      journal.diagnostics.some(isDurableRecoveryDiagnostic) ? { key: "durableReplay.label", detail: "" } : void 0,
      ...operationFeatures(journal.operations)
    ]);
    return Object.freeze({ state, description, code, output, ptc: true, features: Object.freeze(features) });
  }

  // internal/record-utils.js
  function isRecord2(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  // internal/repl-memory-projection.js
  var BINDING_KINDS = /* @__PURE__ */ new Set(["variable", "function", "class", "import"]);
  var MAX_BINDINGS = 128;
  var MAX_BINDING_NAME_LENGTH = 128;
  var MAX_DEFINITION_SOURCE_LENGTH = 1024;
  var MAX_DEFINITION_SOURCE_TOTAL_LENGTH = 16 * 1024;
  var SNAPSHOT_FIELDS = /* @__PURE__ */ new Set(["available", "entries", "total", "omitted"]);
  var ENTRY_FIELDS = /* @__PURE__ */ new Set(["name", "kind", "definition"]);
  var DEFINITION_FIELDS = /* @__PURE__ */ new Set(["source", "line", "column"]);
  function exactFields(value, fields) {
    if (!isRecord2(value)) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.size && keys.every((key) => typeof key === "string" && fields.has(key) && Object.prototype.propertyIsEnumerable.call(value, key));
  }
  var EMPTY_REPL_MEMORY = Object.freeze({
    available: false,
    entries: Object.freeze([]),
    total: 0,
    omitted: 0
  });
  function unavailableReplMemorySnapshot() {
    return EMPTY_REPL_MEMORY;
  }
  function normalizeDefinition(value) {
    if (!exactFields(value, DEFINITION_FIELDS) || typeof value.source !== "string" || value.source.length === 0 || value.source.length > MAX_DEFINITION_SOURCE_LENGTH || !Number.isSafeInteger(value.line) || value.line < 1 || !Number.isSafeInteger(value.column) || value.column < 1) {
      throw new Error("invalid dsh-ptc-plus REPL binding definition");
    }
    return Object.freeze({ source: value.source, line: value.line, column: value.column });
  }
  function normalizeBinding(value) {
    if (!exactFields(value, ENTRY_FIELDS) || typeof value.name !== "string" || value.name.length === 0 || value.name.length > MAX_BINDING_NAME_LENGTH || !BINDING_KINDS.has(value.kind)) {
      throw new Error("invalid dsh-ptc-plus REPL memory binding");
    }
    return Object.freeze({
      name: value.name,
      kind: value.kind,
      definition: normalizeDefinition(value.definition)
    });
  }
  function normalizeReplMemorySnapshot(value) {
    if (!exactFields(value, SNAPSHOT_FIELDS) || typeof value.available !== "boolean" || !Array.isArray(value.entries) || value.entries.length > MAX_BINDINGS || !Number.isSafeInteger(value.total) || value.total < 0 || !Number.isSafeInteger(value.omitted) || value.omitted < 0 || value.total !== value.entries.length + value.omitted) {
      throw new Error("invalid dsh-ptc-plus REPL memory snapshot");
    }
    if (!value.available && (value.total !== 0 || value.entries.length !== 0)) {
      throw new Error("unavailable dsh-ptc-plus REPL memory snapshot must be empty");
    }
    const names = /* @__PURE__ */ new Set();
    let sourceLength = 0;
    const entries = value.entries.map((entry) => {
      const normalized = normalizeBinding(entry);
      if (names.has(normalized.name)) {
        throw new Error("invalid dsh-ptc-plus REPL memory binding");
      }
      sourceLength += normalized.definition.source.length;
      if (sourceLength > MAX_DEFINITION_SOURCE_TOTAL_LENGTH) {
        throw new Error("dsh-ptc-plus REPL binding definitions exceed the presentation budget");
      }
      names.add(normalized.name);
      return normalized;
    });
    return Object.freeze({
      available: value.available,
      entries: Object.freeze(entries),
      total: value.total,
      omitted: value.omitted
    });
  }

  // src/client.js
  var CLIENT_STYLE_ID = "ptc-plus-client-style";
  var CLIENT_CSS = `
.ptcPlusCard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;list-style:none;overflow:hidden}
.ptcPlusHeader{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .16s ease}
.ptcPlusHeader:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusHeader:focus-visible,.ptcPlusButton:focus-visible,.ptcPlusInput:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}
.ptcPlusHeadText{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:1px}.ptcPlusName{font-size:14px;font-weight:600;line-height:20px}.ptcPlusDescription{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusStatus{display:inline-flex;align-items:center;flex:none;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:16px}.ptcPlusStatus[data-enabled=true]{color:var(--dsw-alias-state-success-primary,#16794f);background:var(--dsw-alias-state-success-tertiary,#e7f7ef)}.ptcPlusStatus[data-enabled=false]{color:var(--dsw-alias-label-tertiary,#74777d);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ptcPlusChevron{display:flex;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .18s ease}.ptcPlusChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusBody{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.ptcPlusBody[data-open=true]{grid-template-rows:1fr}.ptcPlusBodyInner{min-height:0;overflow:hidden}.ptcPlusFields{margin:0 16px;padding:8px 0 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.ptcPlusGroup+.ptcPlusGroup{margin-top:14px}.ptcPlusGroupTitle{margin:0;padding:8px 0 5px;color:var(--dsw-alias-label-secondary,#52565d);font-size:11px;font-weight:600;letter-spacing:0;line-height:16px}.ptcPlusRow{display:flex;align-items:center;gap:12px;min-height:48px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusRow:first-child{border-top:0}.ptcPlusMain{flex:1;min-width:0}.ptcPlusLabel{font-size:14px;font-weight:500;line-height:20px}.ptcPlusDetail,.ptcPlusMessage{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusInput{box-sizing:border-box;min-width:72px;width:140px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusCheck{width:18px;height:18px;accent-color:var(--dsw-alias-interactive-primary,#4d6bfe)}
.ptcPlusFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.ptcPlusButton{min-height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:500 13px/20px inherit;transition:background-color .16s ease,border-color .16s ease}.ptcPlusButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusButton:disabled,.ptcPlusInput:disabled,.ptcPlusCheck:disabled{cursor:not-allowed;opacity:.55}
.ptcPlusActiveShell{display:inline-flex;align-items:center}.ptcPlusActive{appearance:none;display:inline-flex;height:24px;align-items:center;gap:5px;padding:0 8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 32%,transparent);border-radius:6px;background:var(--dsw-alias-state-success-tertiary,#e7f7ef);color:var(--dsw-alias-state-success-primary,#16794f);cursor:help;font:600 12px/18px inherit;white-space:nowrap;transition:background-color .14s ease,border-color .14s ease}.ptcPlusActive:hover,.ptcPlusActive[aria-expanded=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 48%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 16%,var(--dsw-alias-bg-layer-3,#fff))}.ptcPlusActive:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary,#16794f);outline-offset:2px}.ptcPlusReplPopover{position:fixed;z-index:2147483000;inset:auto;display:none;box-sizing:border-box;margin:0;padding:0;border:0;overflow:visible;background:transparent;color:var(--dsw-alias-label-primary,#18191c)}.ptcPlusReplPopover:popover-open,.ptcPlusReplPopover[data-open=true]{display:block}.ptcPlusReplPopover::backdrop{background:transparent}.ptcPlusReplCard{display:flex;max-height:inherit;overflow:hidden;flex-direction:column;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 22%,var(--dsw-alias-border-l2,rgba(0,0,0,.1)));border-top:3px solid var(--dsw-alias-state-success-primary,#16794f);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 14px 36px rgba(16,24,40,.2),0 3px 10px rgba(16,24,40,.1);color:var(--dsw-alias-label-primary,#18191c);white-space:normal}.ptcPlusReplHead{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:8px;padding:11px 13px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 7%,var(--dsw-alias-bg-layer-3,#fff))}.ptcPlusReplStatusDot{grid-row:1/3;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#16794f);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 14%,transparent)}.ptcPlusReplTitle,.ptcPlusReplSummary{display:block;min-width:0}.ptcPlusReplTitle{font-size:13px;font-weight:600;line-height:19px}.ptcPlusReplSummary{color:var(--dsw-alias-label-tertiary,#74777d);font-size:11px;line-height:16px}.ptcPlusReplList{min-height:0;margin:0;padding:5px 0;overflow:auto;overscroll-behavior:contain;list-style:none;scrollbar-gutter:stable}.ptcPlusReplBinding{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 10px;padding:7px 12px}.ptcPlusReplBinding:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusReplIdentity{display:flex;min-width:0;align-items:center;gap:7px}.ptcPlusReplName{min-width:0;overflow:hidden;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.ptcPlusReplKind{flex:none;padding:1px 6px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:999px;background:color-mix(in srgb,currentColor 10%,transparent);font-size:10px;font-weight:600;line-height:15px}.ptcPlusReplKind[data-kind=variable]{color:var(--dsw-alias-interactive-primary,#315fbd)}.ptcPlusReplKind[data-kind=function]{color:#7651b5}.ptcPlusReplKind[data-kind=class]{color:var(--dsw-alias-state-warning-primary,#946200)}.ptcPlusReplKind[data-kind=import]{color:#14766f}.ptcPlusReplPreview{grid-column:1;min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#74777d);font:11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.ptcPlusReplInspect{grid-column:2;grid-row:1/3;display:inline-flex;align-items:center;gap:4px;padding:3px 5px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer;font:500 11px/17px inherit;white-space:nowrap}.ptcPlusReplInspect:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusReplInspect:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:1px}.ptcPlusReplDefinition{grid-column:1/-1;min-width:0;margin-top:4px;padding:8px;border-left:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03))}.ptcPlusReplLocation{display:block;margin-bottom:5px;color:var(--dsw-alias-label-tertiary,#74777d);font-size:10px;line-height:15px}.ptcPlusReplCode{max-height:180px;margin:0;overflow:auto;color:inherit;font:11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusReplEmpty,.ptcPlusReplMore{display:block;color:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusReplEmpty{padding:18px 13px;font-size:12px;line-height:18px}.ptcPlusReplMore{padding:8px 13px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03));font-size:11px;line-height:17px}
.ptcPlusReplList{max-height:min(52vh,480px)}.ptcPlusReplBinding{grid-template-columns:minmax(0,1fr) 24px;gap:3px 8px;min-height:36px;padding:5px 12px;content-visibility:auto;contain-intrinsic-size:36px;cursor:pointer;transition:background-color .16s ease}.ptcPlusReplBinding:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}.ptcPlusReplBinding[data-expanded=true]{background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#4d6bfe) 5%,transparent)}.ptcPlusReplName{grid-column:1}.ptcPlusReplName[data-kind=variable]{color:var(--dsw-alias-interactive-primary,#315fbd)}.ptcPlusReplName[data-kind=function]{color:#7651b5}.ptcPlusReplName[data-kind=class]{color:var(--dsw-alias-state-warning-primary,#946200)}.ptcPlusReplName[data-kind=import]{color:#14766f}.ptcPlusReplPreview{grid-column:1}.ptcPlusReplChevron{grid-column:2;grid-row:1/3;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .2s ease}.ptcPlusReplChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusReplDefinitionWrap{grid-column:1/-1;display:grid;grid-template-rows:0fr;min-width:0;transition:grid-template-rows .24s cubic-bezier(.2,.7,.2,1)}.ptcPlusReplDefinitionWrap[data-open=true]{grid-template-rows:1fr}.ptcPlusReplDefinitionInner{min-height:0;overflow:hidden}
.ptcPlusTool{display:flex;min-width:0;flex-direction:column}.ptcPlusToolPreview{display:flex;min-width:0;flex:1 1 auto;flex-direction:row;align-items:center;overflow:hidden;margin-left:7px}.ptcPlusToolPreview .ptcPlusFeatures{flex:0 1 auto;flex-wrap:nowrap;overflow:hidden;margin:0 0 0 7px}.ptcPlusToolSummaryLine{box-sizing:border-box;display:flex;min-width:0;min-height:20px;flex:1 1 auto;align-items:center;gap:7px;padding:0;color:inherit;line-height:20px}.ptcPlusToolSummary{box-sizing:border-box;display:flex;min-width:0;min-height:32px;align-items:center;gap:7px;padding:0;color:inherit;line-height:20px}.ptcPlusToolSummary[data-expandable=true]{cursor:pointer}.ptcPlusToolSummary[data-expandable=true]:hover .ptcPlusToolTitle{color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusToolSummary:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:2px}.ptcPlusToolLeading{display:flex;width:16px;height:20px;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusToolChevron{transition:transform .16s ease}.ptcPlusToolChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusToolTitle{display:flex;height:20px;flex:none;align-items:center;font-size:13px;font-weight:500;line-height:20px}.ptcPlusToolState{display:flex;height:20px;flex:none;align-items:center;color:var(--dsw-alias-label-tertiary,#74777d);font-size:11px;line-height:20px}.ptcPlusToolSummaryLine[data-state=running] .ptcPlusToolState,.ptcPlusToolSummary[data-state=running] .ptcPlusToolState{color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusToolSummaryLine[data-state=error] .ptcPlusToolState,.ptcPlusToolSummary[data-state=error] .ptcPlusToolState{color:var(--dsw-alias-state-danger-primary,#c43d3d)}.ptcPlusToolSummaryLine[data-state=stopped] .ptcPlusToolState,.ptcPlusToolSummary[data-state=stopped] .ptcPlusToolState{color:var(--dsw-alias-state-warning-primary,#a15c00)}.ptcPlusToolSep{width:3px;height:3px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusToolDescription{display:flex;min-width:0;min-height:20px;flex:1 1 auto;align-items:center;overflow:hidden;color:var(--dsw-alias-label-secondary,#52565d);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}.ptcPlusToolPreview .ptcPlusFeature{flex:none;max-width:180px;white-space:nowrap}.ptcPlusToolPreview .ptcPlusFeatureDetail{max-width:120px}.ptcPlusToolSummaryLine[data-state=error] .ptcPlusToolDescription,.ptcPlusToolSummary[data-state=error] .ptcPlusToolDescription{color:var(--dsw-alias-state-danger-primary,#c43d3d)}.ptcPlusToolSummaryLine[data-state=stopped] .ptcPlusToolDescription,.ptcPlusToolSummary[data-state=stopped] .ptcPlusToolDescription{color:var(--dsw-alias-state-warning-primary,#a15c00)}
.ptcPlusFeatures{display:flex;min-width:0;flex-wrap:wrap;gap:3px 14px;margin:0 0 5px 23px}.ptcPlusFeature{display:inline-flex;min-width:0;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#52565d);font-size:11px;line-height:17px}.ptcPlusFeature::before{width:4px;height:4px;flex:none;border-radius:50%;background:var(--dsw-alias-interactive-primary,#4d6bfe);content:''}.ptcPlusFeatureName{font-weight:500}.ptcPlusFeatureDetail{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#74777d);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.ptcPlusToolBody{margin:4px 0 8px 23px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03))}.ptcPlusToolSection{display:flex;min-width:0;flex-direction:column;gap:4px;padding:9px 11px}.ptcPlusToolSection+.ptcPlusToolSection{border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusToolSectionLabel{color:var(--dsw-alias-label-tertiary,#74777d);font-size:10px;font-weight:600;line-height:16px;text-transform:uppercase}.ptcPlusToolCode{max-height:320px;margin:0;overflow:auto;color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusIoCard{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-markdown-code-block,rgba(38,49,72,.06));overflow:hidden}.ptcPlusIoText{max-height:320px;margin:0;padding:12px 16px;overflow:auto;color:var(--dsw-alias-label-secondary,#52565d);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusIoText[data-error]{color:var(--dsw-alias-state-error-primary,#c43d3d)}.ptcPlusInspect{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:999px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer;opacity:0;font-size:11px;line-height:16px;transition:opacity .1s ease;display:inline-flex}.ptcPlusTool:hover .ptcPlusInspect,.ptcPlusInspect:focus-visible{opacity:1}.ptcPlusInspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#18191c)}
@media(max-width:560px){.ptcPlusHeader{padding:12px}.ptcPlusFields{margin:0 12px}.ptcPlusRow{align-items:flex-start;flex-direction:column;gap:6px;padding:10px 0}.ptcPlusInput{width:100%}.ptcPlusFooter{align-items:stretch;flex-direction:column}.ptcPlusButton{width:100%}.ptcPlusFeatures,.ptcPlusToolBody{margin-left:0}.ptcPlusToolSummary .ptcPlusToolDescription{white-space:normal;overflow-wrap:anywhere}}
@media(prefers-reduced-motion:reduce){.ptcPlusHeader,.ptcPlusChevron,.ptcPlusBody,.ptcPlusButton,.ptcPlusActive,.ptcPlusToolChevron,.ptcPlusReplChevron,.ptcPlusReplDefinitionWrap,.ptcPlusInspect{transition:none}}
/* The summary button owns disclosure; definition content is a separate grid item. */
.ptcPlusReplBinding{padding:0;cursor:default}.ptcPlusReplBindingTrigger{appearance:none;display:grid;width:100%;grid-column:1/-1;grid-template-columns:minmax(0,1fr) 24px;gap:3px 8px;min-height:36px;padding:5px 12px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;transition:background-color .16s ease}.ptcPlusReplBindingTrigger:hover,.ptcPlusReplBindingTrigger[aria-expanded=true]{background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#4d6bfe) 5%,transparent)}.ptcPlusReplBindingTrigger:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}
/* High-contrast TypeScript-like token colors adapt to the active text theme. */
.ptcPlusReplCard .ptcPlusReplName[data-kind=variable]{color:color-mix(in srgb,#005cc5 78%,var(--dsw-alias-label-primary,#18191c))}
.ptcPlusReplCard .ptcPlusReplName[data-kind=function]{color:color-mix(in srgb,#795e26 78%,var(--dsw-alias-label-primary,#18191c))}
.ptcPlusReplCard .ptcPlusReplName[data-kind=class]{color:color-mix(in srgb,#267f99 78%,var(--dsw-alias-label-primary,#18191c))}
.ptcPlusReplCard .ptcPlusReplName[data-kind=import]{color:color-mix(in srgb,#af00db 78%,var(--dsw-alias-label-primary,#18191c))}
/* Keep the session-header action on the same compact 32px rhythm as DSH chrome. */
.ptcPlusActiveShell{display:inline-flex;height:28px;align-items:center;justify-content:center;line-height:0;vertical-align:middle}.ptcPlusActive{box-sizing:border-box;height:28px;justify-content:center;gap:6px;padding:0 6px;border:0;background:transparent;font-family:inherit;font-size:13px;font-weight:500;line-height:18px}.ptcPlusActive::before{width:6px;height:6px;flex:none;border-radius:50%;background:currentColor;box-shadow:0 0 0 2px color-mix(in srgb,currentColor 18%,transparent);content:''}.ptcPlusActive:hover,.ptcPlusActive[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusActiveLabel{display:inline-flex;height:18px;align-items:center;line-height:18px}
`;
  var LOCALE_NS = "settings.ptcPlus";
  var CHROME_COPY = Object.freeze({
    zh: Object.freeze({
      "card.description": "PTC \u6A21\u5F0F\u7684\u4F1A\u8BDD\u7EA7 TypeScript REPL\u3002",
      "status.enabled": "\u5DF2\u542F\u7528",
      "status.disabled": "\u5DF2\u505C\u7528",
      "action.expand": "\u5C55\u5F00 PTC Plus \u8BBE\u7F6E",
      "action.collapse": "\u6536\u8D77 PTC Plus \u8BBE\u7F6E",
      "state.syncing": "\u6B63\u5728\u540C\u6B65\u8BBE\u7F6E...",
      "state.unavailable": "\u5F53\u524D DSH \u5B9E\u4F8B\u672A\u63D0\u4F9B\u8BBE\u7F6E\u670D\u52A1",
      "footer.live": "\u8BBE\u7F6E\u4F1A\u5728\u4FEE\u6539\u540E\u7ACB\u5373\u751F\u6548",
      "footer.readOnly": "\u5F53\u524D\u8BBE\u7F6E\u4E3A\u53EA\u8BFB",
      "status.applied": "\u8BBE\u7F6E\u5DF2\u7ACB\u5373\u751F\u6548",
      "status.conflict": "\u8BBE\u7F6E\u672A\u751F\u6548\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u7F6E\u51B2\u7A81",
      "status.failed": "\u8BBE\u7F6E\u5931\u8D25\uFF1A{error}",
      "indicator.title": "PTC Plus \u5DF2\u542F\u7528\uFF1B\u67E5\u770B\u5F53\u524D\u53EF\u590D\u7528\u7684 REPL \u7ED1\u5B9A",
      "memory.title": "REPL \u53EF\u590D\u7528\u7ED1\u5B9A",
      "memory.count": "{count} \u4E2A\u53EF\u590D\u7528\u7ED1\u5B9A",
      "memory.empty": "\u5F53\u524D\u6CA1\u6709\u53EF\u590D\u7528\u7ED1\u5B9A",
      "memory.unavailable": "\u5F53\u524D\u7ED1\u5B9A\u72B6\u6001\u5C1A\u4E0D\u53EF\u786E\u8BA4",
      "memory.more": "\u53E6\u6709 {count} \u4E2A\u7ED1\u5B9A\u672A\u663E\u793A",
      "memory.kind.variable": "\u53D8\u91CF",
      "memory.kind.function": "\u51FD\u6570",
      "memory.kind.class": "\u7C7B",
      "memory.kind.import": "\u5BFC\u5165",
      "memory.location": "\u7B2C {line} \u884C\uFF0C\u7B2C {column} \u5217",
      "tool.code": "\u6267\u884C",
      "tool.codeEdit": "\u4FEE\u6B63\u6267\u884C",
      "tool.running": "\u6B63\u5728\u8FD0\u884C",
      "tool.completed": "\u6267\u884C\u5B8C\u6210",
      "tool.failed": "\u6267\u884C\u5931\u8D25",
      "tool.stopped": "\u6267\u884C\u5DF2\u4E2D\u65AD",
      "tool.source": "\u6E90\u7801",
      "tool.result": "\u7ED3\u679C",
      "tool.copy": "\u590D\u5236\u4EE3\u7801",
      "tool.copied": "\u5DF2\u590D\u5236",
      "tool.inspect": "\u68C0\u67E5\u8C03\u7528",
      "feature.safeEdit": "\u5B89\u5168\u7F16\u8F91\u6267\u884C",
      "feature.codeRun": "\u9694\u79BB\u6267\u884C code.run",
      "feature.stateSaved": "\u4FDD\u5B58 REPL \u72B6\u6001",
      "feature.stateRestored": "\u6062\u590D REPL \u72B6\u6001",
      "feature.stateDeleted": "\u5220\u9664 REPL \u72B6\u6001"
    }),
    en: Object.freeze({
      "card.description": "The session-bound TypeScript REPL for PTC mode.",
      "status.enabled": "Enabled",
      "status.disabled": "Disabled",
      "action.expand": "Expand PTC Plus settings",
      "action.collapse": "Collapse PTC Plus settings",
      "state.syncing": "Syncing settings...",
      "state.unavailable": "This DSH instance does not provide a settings service",
      "footer.live": "Changes take effect immediately.",
      "footer.readOnly": "These settings are read-only.",
      "status.applied": "Setting applied immediately.",
      "status.conflict": "The setting did not take effect; check for conflicting settings.",
      "status.failed": "Could not save: {error}",
      "indicator.title": "PTC Plus is active; view reusable REPL bindings",
      "memory.title": "Reusable REPL bindings",
      "memory.count": "{count} reusable bindings",
      "memory.empty": "No reusable bindings",
      "memory.unavailable": "Current binding state cannot be confirmed",
      "memory.more": "{count} more bindings not shown",
      "memory.kind.variable": "Variable",
      "memory.kind.function": "Function",
      "memory.kind.class": "Class",
      "memory.kind.import": "Import",
      "memory.location": "Line {line}, column {column}",
      "tool.code": "Code",
      "tool.codeEdit": "Code edit",
      "tool.running": "Running",
      "tool.completed": "Completed",
      "tool.failed": "Failed",
      "tool.stopped": "Stopped",
      "tool.source": "Source",
      "tool.result": "Result",
      "tool.inspect": "Inspect call",
      "feature.safeEdit": "Safe edit execution",
      "feature.codeRun": "Isolated code.run execution",
      "feature.stateSaved": "Saved REPL state",
      "feature.stateRestored": "Restored REPL state",
      "feature.stateDeleted": "Deleted REPL state",
      "tool.copy": "Copy code",
      "tool.copied": "Copied"
    })
  });
  function fieldCopy(field, locale) {
    const copy = { [`${field.key}.label`]: locale === "en" ? field.labelEn : field.label };
    const description = locale === "en" ? field.descriptionEn : field.description;
    if (description !== "") copy[`${field.key}.description`] = description;
    return copy;
  }
  var SETTINGS_COPY = Object.freeze(Object.fromEntries(
    ["zh", "en"].map((locale) => [locale, Object.freeze({
      ...CHROME_COPY[locale],
      ...Object.assign({}, ...CONFIG_GROUPS.map((group) => ({
        [`group.${group.key}`]: locale === "en" ? group.labelEn : group.label
      }))),
      ...Object.assign({}, ...CONFIG_FIELDS.map((field) => fieldCopy(field, locale)))
    })])
  ));
  function sessionUsesPtcPreset(session) {
    const preset = session?.projectionValues?.agentPreset ?? session?.agentPreset;
    return preset === "ptc" || preset === "code";
  }
  window.__ModuleLoader__.load({
    // Replaced by the bundle entry with the package name from package.json.
    id: "dsh-ptc-plus",
    factory: (require2) => {
      const React = require2("react");
      const {
        CodeBlock,
        DisclosureRow,
        IconCheckOutline14,
        IconChevronDownOutline14,
        IconInspectOutline12
      } = require2("@deepseek-ai/dsh-client-ui-primitives");
      const module = { exports: {} };
      const h = React.createElement;
      function installStyles() {
        if (document.getElementById(CLIENT_STYLE_ID) !== null) return () => {
        };
        const style = document.createElement("style");
        style.id = CLIENT_STYLE_ID;
        style.textContent = CLIENT_CSS;
        document.head.append(style);
        return () => style.remove();
      }
      function fieldInput(field, value, disabled, onChange, label) {
        if (field.type === "boolean") {
          return h("input", {
            type: "checkbox",
            role: "switch",
            className: "ptcPlusCheck",
            checked: value === true,
            disabled,
            "aria-label": label,
            onChange: (event) => onChange(field, event.target.checked)
          });
        }
        return h("input", {
          type: "number",
          className: "ptcPlusInput",
          value: Number.isSafeInteger(value) ? String(value) : "",
          min: field.min,
          max: field.max,
          step: 1,
          disabled,
          "aria-label": label,
          onChange: (event) => {
            const input = event.target.value;
            const parsed = input === "" ? "" : Number(input);
            onChange(field, Number.isSafeInteger(parsed) ? parsed : input);
          }
        });
      }
      function apply(ctx) {
        const preferenceScope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
        ctx.effect(() => ctx.locale.register(LOCALE_NS, SETTINGS_COPY), "ptc-plus: settings dictionaries");
        ctx.effect(installStyles, "ptc-plus: client styles");
        function PTCPlusSettingsCard({ t }) {
          const [open, setOpen] = React.useState(false);
          const [status, setStatus] = React.useState(null);
          const [pending, setPending] = React.useState(() => /* @__PURE__ */ new Set());
          const writeTail = React.useRef(Promise.resolve());
          const subscribe = React.useCallback((listener) => preferenceScope.subscribe(listener), []);
          const getSnapshot = React.useCallback(() => preferenceScope.getSnapshot(), []);
          const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
          const value = snapshot.status === "ready" ? snapshot.value ?? {} : {};
          const enabled = value.enabled === true;
          const unavailable = snapshot.status !== "ready" || snapshot.writable !== true;
          const persist = (field, nextValue) => {
            if (unavailable || pending.has(field.key)) return;
            const operation = writeTail.current.then(async () => {
              const before = preferenceScope.getSnapshot();
              if (before.status !== "ready" || before.writable !== true) return;
              if (field.key !== "enabled" && before.value?.enabled !== true) return;
              if (before.value?.[field.key] === nextValue) return;
              setPending((current) => new Set(current).add(field.key));
              setStatus(null);
              try {
                await preferenceScope.set(field.key, nextValue);
                const after = preferenceScope.getSnapshot();
                if (after.status !== "ready" || after.value?.[field.key] !== nextValue) {
                  setStatus({ key: "status.conflict" });
                } else {
                  setStatus({ key: "status.applied" });
                }
              } catch (error) {
                setStatus({
                  key: "status.failed",
                  params: { error: error instanceof Error ? error.message : String(error) }
                });
              } finally {
                setPending((current) => {
                  const next = new Set(current);
                  next.delete(field.key);
                  return next;
                });
              }
            });
            writeTail.current = operation.catch(() => {
            });
          };
          const fieldDisabled = (field) => unavailable || pending.has(field.key) || field.key !== "enabled" && !enabled;
          const settingGroups = CONFIG_GROUPS.map((group) => h(
            "section",
            {
              key: group.key,
              className: "ptcPlusGroup",
              "aria-labelledby": `ptc-plus-settings-group-${group.key}`
            },
            h("h3", {
              id: `ptc-plus-settings-group-${group.key}`,
              className: "ptcPlusGroupTitle"
            }, t(`group.${group.key}`)),
            ...group.fields.map((key) => {
              const field = CONFIG_FIELDS.find((candidate) => candidate.key === key);
              if (field === void 0) return null;
              return h(
                "div",
                { key: field.key, className: "ptcPlusRow" },
                h(
                  "div",
                  { className: "ptcPlusMain" },
                  h("div", { className: "ptcPlusLabel" }, t(`${field.key}.label`)),
                  field.description === "" ? null : h("div", { className: "ptcPlusDetail" }, t(`${field.key}.description`))
                ),
                fieldInput(field, value[field.key], fieldDisabled(field), persist, t(`${field.key}.label`))
              );
            })
          ));
          return h(
            "li",
            { className: "ptcPlusCard" },
            h(
              "button",
              {
                type: "button",
                className: "ptcPlusHeader",
                "aria-expanded": open,
                "aria-label": t(open ? "action.collapse" : "action.expand"),
                "aria-controls": "ptc-plus-settings-body",
                onClick: () => setOpen((current) => !current)
              },
              h(
                "span",
                { className: "ptcPlusHeadText" },
                h("span", { className: "ptcPlusName" }, "PTC Plus"),
                h("span", { className: "ptcPlusDescription" }, t("card.description"))
              ),
              h("span", { className: "ptcPlusStatus", "data-enabled": enabled }, t(enabled ? "status.enabled" : "status.disabled")),
              h("span", { className: "ptcPlusChevron", "data-open": open, "aria-hidden": true }, h(IconChevronDownOutline14, { size: 14 }))
            ),
            h(
              "div",
              { id: "ptc-plus-settings-body", className: "ptcPlusBody", "data-open": open, "aria-hidden": !open },
              h("div", { className: "ptcPlusBodyInner" }, h(
                "div",
                { className: "ptcPlusFields" },
                snapshot.status === "loading" ? h("p", { className: "ptcPlusMessage" }, t("state.syncing")) : snapshot.status === "unavailable" ? h("p", { className: "ptcPlusMessage" }, t("state.unavailable")) : [
                  ...settingGroups,
                  h(
                    "div",
                    { key: "footer", className: "ptcPlusFooter" },
                    h("span", { className: "ptcPlusMessage", role: "status" }, status === null ? t(snapshot.writable ? "footer.live" : "footer.readOnly") : t(status.key, status.params))
                  )
                ]
              ))
            )
          );
        }
        ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
          name: "settings.plugin.item",
          key: SETTINGS_NAMESPACE,
          locale: LOCALE_NS
        }, PTCPlusSettingsCard));
        function PTCPlusToolRow({ toolName, block, inspect, t }) {
          const [open, setOpen] = React.useState(false);
          const view = derivePtcToolView(block, toolName);
          const expandable = view.code !== "" || view.output !== "" || typeof inspect === "function";
          const stateKey = {
            running: "tool.running",
            ok: "tool.completed",
            error: "tool.failed",
            stopped: "tool.stopped"
          }[view.state];
          const outputSummary = view.state === "error" && view.output !== "" ? view.output.split(/\r?\n/, 1)[0] : "";
          const summary = outputSummary || view.description;
          const stateText = view.state === "ok" ? null : t(stateKey);
          const toggle = () => {
            if (expandable) setOpen((current) => !current);
          };
          const summaryText = summary === "" ? null : summary;
          const summaryLine = stateText === null && summaryText === null ? null : h(
            "div",
            { className: "ptcPlusToolSummaryLine", "data-state": view.state, role: "status" },
            stateText === null ? null : h("span", { className: "ptcPlusToolState" }, stateText),
            summaryText === null ? null : h("span", { className: "ptcPlusToolSep", "aria-hidden": true }),
            summaryText === null ? null : h("span", { className: "ptcPlusToolDescription" }, summaryText)
          );
          const body = !open ? null : h(
            "div",
            { className: "ptcPlusToolBody" },
            view.code === "" ? null : h(
              "div",
              { className: "ptcPlusToolSection" },
              h("span", { className: "ptcPlusToolSectionLabel" }, t("tool.source")),
              typeof CodeBlock === "function" ? h(CodeBlock, {
                code: view.code,
                lang: "typescript",
                className: "ptcPlusToolCode",
                copyLabel: t("tool.copy"),
                copiedLabel: t("tool.copied")
              }) : h("pre", { className: "ptcPlusToolCode" }, view.code)
            ),
            view.output === "" ? null : h(
              "div",
              { className: "ptcPlusToolSection" },
              h("span", { className: "ptcPlusToolSectionLabel" }, t("tool.result")),
              h(
                "div",
                { className: "ptcPlusIoCard" },
                h("pre", {
                  className: "ptcPlusIoText",
                  "data-error": view.state === "error" || void 0
                }, view.output)
              )
            ),
            typeof inspect !== "function" ? null : h("button", {
              type: "button",
              className: "ptcPlusInspect",
              onClick: inspect
            }, h(IconInspectOutline12, { "aria-hidden": true }), t("tool.inspect"))
          );
          const features = view.features.length === 0 ? null : h(
            "div",
            { className: "ptcPlusFeatures" },
            view.features.map((feature) => h(
              "span",
              {
                key: `${feature.key}:${feature.detail}`,
                className: "ptcPlusFeature"
              },
              h("span", { className: "ptcPlusFeatureName" }, t(feature.key)),
              feature.detail === "" ? null : h("span", { className: "ptcPlusFeatureDetail", title: feature.detail }, feature.detail)
            ))
          );
          const collapsedContent = h("div", { className: "ptcPlusToolPreview" }, summaryLine, features);
          if (typeof DisclosureRow === "function") {
            return h(
              "div",
              { className: "ptcPlusTool" },
              h(DisclosureRow, {
                icon: expandable ? h(IconChevronDownOutline14, { size: 14 }) : h(IconCheckOutline14, { size: 14 }),
                title: t(toolName === "edit_run_code" ? "tool.codeEdit" : "tool.code"),
                open,
                expandable,
                onToggle: toggle,
                expandOnRowClick: true,
                previewChevron: false,
                keepContentWhenOpen: true,
                collapsedContent,
                children: body
              })
            );
          }
          return h(
            "div",
            { className: "ptcPlusTool" },
            h(
              "div",
              {
                className: "ptcPlusToolSummary",
                "data-state": view.state,
                "data-expandable": expandable || void 0,
                role: expandable ? "button" : void 0,
                tabIndex: expandable ? 0 : void 0,
                "aria-expanded": expandable ? open : void 0,
                onClick: expandable ? toggle : void 0,
                onKeyDown: expandable ? (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  toggle();
                } : void 0
              },
              h("span", { className: "ptcPlusToolLeading", "aria-hidden": true }, expandable ? h(IconChevronDownOutline14, { size: 14, className: "ptcPlusToolChevron", "data-open": open }) : h(IconCheckOutline14, { size: 14 })),
              h("span", { className: "ptcPlusToolTitle" }, t(
                toolName === "edit_run_code" ? "tool.codeEdit" : "tool.code"
              )),
              view.state === "ok" ? null : h("span", { className: "ptcPlusToolState", role: "status" }, t(stateKey)),
              h("span", { className: "ptcPlusToolSep", "aria-hidden": true }),
              h("span", { className: "ptcPlusToolDescription" }, summary)
            ),
            features,
            body
          );
        }
        ctx.slots.inject("tool.call.toolview", () => {
          let releaseRows;
          const release = () => {
            releaseRows?.();
            releaseRows = void 0;
          };
          const sync = () => {
            const snapshot = preferenceScope.getSnapshot();
            const enabled = snapshot.status === "ready" && snapshot.value?.enabled === true && snapshot.value?.enhancedToolView !== false;
            if (enabled === (releaseRows !== void 0)) return;
            release();
            if (!enabled) return;
            const disposers = [];
            try {
              disposers.push(ctx.slots.register({
                name: "tool.call.toolview",
                key: "run_code",
                locale: LOCALE_NS
              }, PTCPlusToolRow));
              disposers.push(ctx.slots.register({
                name: "tool.call.toolview",
                key: "edit_run_code",
                locale: LOCALE_NS
              }, PTCPlusToolRow));
            } catch (error) {
              disposers.reverse().forEach((dispose) => dispose());
              throw error;
            }
            releaseRows = () => disposers.reverse().forEach((dispose) => dispose());
          };
          sync();
          const unsubscribe = preferenceScope.subscribe(sync);
          return () => {
            unsubscribe();
            release();
          };
        });
        ctx.inject(["slots", "sessions"], (scope) => {
          function replPopoverIsOpen(popover) {
            if (popover?.dataset?.open === "true") return true;
            try {
              return popover?.matches?.(":popover-open") === true;
            } catch {
              return false;
            }
          }
          function placeReplPopover(trigger, popover) {
            if (trigger === null || popover === null) return;
            const margin = 12;
            const gap = 8;
            const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
            const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
            const triggerRect = trigger.getBoundingClientRect();
            const width = Math.min(344, Math.max(0, viewportWidth - margin * 2));
            const left = Math.min(
              Math.max(margin, triggerRect.right - width),
              Math.max(margin, viewportWidth - width - margin)
            );
            const below = Math.max(0, viewportHeight - triggerRect.bottom - gap - margin);
            const above = Math.max(0, triggerRect.top - gap - margin);
            const opensAbove = below < 260 && above > below;
            const availableHeight = Math.max(80, opensAbove ? above : below);
            popover.style.width = `${width}px`;
            popover.style.maxHeight = `${availableHeight}px`;
            popover.style.left = `${left}px`;
            popover.style.top = opensAbove ? `${Math.max(margin, triggerRect.top - gap - Math.min(popover.offsetHeight, availableHeight))}px` : `${Math.min(viewportHeight - margin, triggerRect.bottom + gap)}px`;
          }
          function ReplMemoryCard({ memory, t, id, titleId, popoverRef, onEnter, onLeave }) {
            const [expandedBinding, setExpandedBinding] = React.useState(null);
            return h(
              "div",
              {
                className: "ptcPlusReplPopover",
                id,
                ref: popoverRef,
                popover: "auto",
                role: "dialog",
                "aria-labelledby": titleId,
                onPointerEnter: onEnter,
                onPointerLeave: onLeave
              },
              h(
                "div",
                { className: "ptcPlusReplCard" },
                h(
                  "div",
                  { className: "ptcPlusReplHead" },
                  h("span", { className: "ptcPlusReplStatusDot", "aria-hidden": true }),
                  h("span", { className: "ptcPlusReplTitle", id: titleId }, t("memory.title")),
                  memory.available ? h("span", { className: "ptcPlusReplSummary" }, t("memory.count", { count: memory.total })) : null
                ),
                !memory.available ? h("span", { className: "ptcPlusReplEmpty" }, t("memory.unavailable")) : memory.entries.length === 0 ? h("span", { className: "ptcPlusReplEmpty" }, t("memory.empty")) : h("ul", { className: "ptcPlusReplList" }, memory.entries.map((binding, index) => {
                  const expanded = expandedBinding === binding.name;
                  const preview = binding.definition.source.replace(/\s+/g, " ").trim();
                  const definitionId = `${id}-binding-${index}`;
                  const toggle = () => setExpandedBinding((current) => current === binding.name ? null : binding.name);
                  return h(
                    "li",
                    {
                      className: "ptcPlusReplBinding",
                      key: binding.name,
                      "data-expanded": expanded
                    },
                    h(
                      "button",
                      {
                        className: "ptcPlusReplBindingTrigger",
                        type: "button",
                        "aria-expanded": expanded,
                        "aria-controls": expanded ? definitionId : void 0,
                        onClick: toggle
                      },
                      h("span", {
                        className: "ptcPlusReplName",
                        "data-kind": binding.kind,
                        title: `${binding.name} - ${t(`memory.kind.${binding.kind}`)}`
                      }, binding.name),
                      h("span", { className: "ptcPlusReplPreview", title: preview }, preview),
                      h("span", {
                        className: "ptcPlusReplChevron",
                        "data-open": expanded,
                        "aria-hidden": true
                      }, h(IconChevronDownOutline14, { size: 14 }))
                    ),
                    expanded ? h("div", {
                      className: "ptcPlusReplDefinitionWrap",
                      "data-open": true,
                      id: definitionId,
                      role: "region",
                      "aria-label": binding.name
                    }, h(
                      "div",
                      { className: "ptcPlusReplDefinitionInner" },
                      h(
                        "div",
                        { className: "ptcPlusReplDefinition" },
                        h("span", { className: "ptcPlusReplLocation" }, t("memory.location", {
                          line: binding.definition.line,
                          column: binding.definition.column
                        })),
                        typeof CodeBlock === "function" ? h(CodeBlock, {
                          code: binding.definition.source,
                          lang: "typescript",
                          className: "ptcPlusReplCode",
                          copyLabel: t("tool.copy"),
                          copiedLabel: t("tool.copied")
                        }) : h("pre", { className: "ptcPlusReplCode" }, binding.definition.source)
                      )
                    )) : null
                  );
                })),
                memory.omitted === 0 ? null : h("span", { className: "ptcPlusReplMore" }, t("memory.more", { count: memory.omitted }))
              )
            );
          }
          function PTCPlusSessionIndicator({ sessionId, t, useSession, useProjection, useSessions }) {
            let conversation;
            try {
              conversation = typeof useSession === "function" ? useSession((snapshot) => snapshot) : void 0;
            } catch {
              conversation = void 0;
            }
            let projectionMemory;
            try {
              projectionMemory = typeof useProjection === "function" ? useProjection("ptcPlusRepl") : void 0;
            } catch {
              projectionMemory = void 0;
            }
            let sessions;
            try {
              sessions = typeof useSessions === "function" ? useSessions((snapshot) => snapshot) : React.useSyncExternalStore(
                (listener) => scope.sessions?.list?.subscribe?.(listener) ?? (() => {
                }),
                () => scope.sessions?.list?.getSnapshot?.() ?? {},
                () => scope.sessions?.list?.getSnapshot?.() ?? {}
              );
            } catch {
              sessions = {};
            }
            const settings = React.useSyncExternalStore(
              (listener) => preferenceScope.subscribe(listener),
              () => preferenceScope.getSnapshot(),
              () => preferenceScope.getSnapshot()
            );
            const triggerRef = React.useRef(null);
            const popoverRef = React.useRef(null);
            const closeTimer = React.useRef(void 0);
            const [expanded, setExpanded] = React.useState(false);
            const positionPopover = React.useCallback(() => {
              if (!replPopoverIsOpen(popoverRef.current)) return;
              placeReplPopover(triggerRef.current, popoverRef.current);
            }, []);
            const showPopover = React.useCallback(() => {
              if (closeTimer.current !== void 0) clearTimeout(closeTimer.current);
              const popover = popoverRef.current;
              if (popover === null) return;
              popover.style.visibility = "hidden";
              if (!replPopoverIsOpen(popover)) {
                if (typeof popover.showPopover === "function") {
                  try {
                    popover.showPopover();
                  } catch {
                    popover.dataset.open = "true";
                  }
                } else {
                  popover.dataset.open = "true";
                }
              }
              placeReplPopover(triggerRef.current, popover);
              popover.style.visibility = "visible";
              setExpanded(true);
            }, []);
            const hidePopover = React.useCallback(() => {
              const popover = popoverRef.current;
              if (popover === null) return;
              if (popover.dataset.open === "true") delete popover.dataset.open;
              if (typeof popover.hidePopover === "function" && replPopoverIsOpen(popover)) {
                try {
                  popover.hidePopover();
                } catch {
                }
              }
              setExpanded(false);
            }, []);
            const scheduleHide = React.useCallback(() => {
              if (closeTimer.current !== void 0) clearTimeout(closeTimer.current);
              closeTimer.current = setTimeout(() => {
                closeTimer.current = void 0;
                if (document.activeElement === triggerRef.current || popoverRef.current?.contains(document.activeElement)) return;
                hidePopover();
              }, 120);
            }, [hidePopover]);
            React.useEffect(() => {
              const syncPopoverState = (event) => {
                if (event.target !== popoverRef.current) return;
                setExpanded(replPopoverIsOpen(popoverRef.current));
              };
              window.addEventListener("resize", positionPopover);
              document.addEventListener("scroll", positionPopover, true);
              document.addEventListener("toggle", syncPopoverState, true);
              return () => {
                if (closeTimer.current !== void 0) clearTimeout(closeTimer.current);
                window.removeEventListener("resize", positionPopover);
                document.removeEventListener("scroll", positionPopover, true);
                document.removeEventListener("toggle", syncPopoverState, true);
                const popover = popoverRef.current;
                if (popover?.dataset?.open === "true") delete popover.dataset.open;
                if (typeof popover?.hidePopover === "function" && replPopoverIsOpen(popover)) {
                  try {
                    popover.hidePopover();
                  } catch {
                  }
                }
              };
            }, [hidePopover, positionPopover]);
            const resolvedSessionId = sessionId ?? conversation?.sessionId;
            const session = sessions?.byId?.[resolvedSessionId] ?? conversation;
            if (!sessionUsesPtcPreset(session) || settings.status !== "ready" || settings.value?.enabled !== true) return null;
            let memory;
            try {
              memory = normalizeReplMemorySnapshot(projectionMemory ?? session?.projectionValues?.ptcPlusRepl);
            } catch {
              memory = unavailableReplMemorySnapshot();
            }
            const popoverId = `ptc-plus-repl-${String(resolvedSessionId).replace(/[^A-Za-z0-9_-]/g, "-")}`;
            const titleId = `${popoverId}-title`;
            return h(
              "span",
              { className: "ptcPlusActiveShell" },
              h("button", {
                type: "button",
                className: "ptcPlusActive",
                ref: triggerRef,
                "aria-label": t("indicator.title"),
                "aria-controls": popoverId,
                "aria-expanded": expanded,
                "aria-haspopup": "dialog",
                onPointerEnter: showPopover,
                onPointerLeave: scheduleHide,
                onFocus: showPopover,
                onBlur: scheduleHide,
                onClick: showPopover,
                onKeyDown: (event) => {
                  if (event.key === "Escape") hidePopover();
                }
              }, h("span", { className: "ptcPlusActiveLabel" }, "PTC Plus")),
              h(ReplMemoryCard, {
                memory,
                t,
                id: popoverId,
                titleId,
                popoverRef,
                onEnter: showPopover,
                onLeave: scheduleHide
              })
            );
          }
          scope.slots.inject("conversation.session.header.actions", () => scope.slots.register({
            name: "conversation.session.header.actions",
            id: "ptc-plus-active",
            order: -9,
            locale: LOCALE_NS
          }, PTCPlusSessionIndicator));
        });
      }
      module.exports = { apply, inject: ["settingsScope", "slots", "sessions", "locale"] };
      return module.exports;
    }
  });
})();
