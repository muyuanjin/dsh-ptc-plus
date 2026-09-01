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
      key: "cordisToolsEnabled",
      type: "boolean",
      default: false,
      label: "\u5728 PTC \u6A21\u5F0F\u4E2D\u542F\u7528 Cordis \u5DE5\u5177",
      labelEn: "Enable Cordis tools in PTC mode",
      description: "\u5373\u65F6\u4E3A PTC agent \u52A0\u5165\u6216\u79FB\u9664\u5B98\u65B9 Cordis \u5DE5\u5177\u3002",
      descriptionEn: "Adds or removes the official Cordis tools for the PTC agent immediately."
    },
    {
      key: "computeMs",
      type: "integer",
      default: 6e4,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u5355 cell \u6700\u5927 CPU \u65F6\u95F4 (ms)",
      labelEn: "Max CPU time per cell (ms)",
      description: "\u540C\u6B65\u8BA1\u7B97\u8D85\u8FC7\u8BE5\u9884\u7B97\u7684 cell \u4F1A\u88AB\u4E2D\u65AD\u3002",
      descriptionEn: "Cells whose synchronous computation exceeds this budget are interrupted."
    },
    {
      key: "maxWallMs",
      type: "integer",
      default: 6e5,
      min: 1,
      max: MAX_TIMER_DELAY_MS,
      label: "\u5355 cell \u6700\u5927\u5899\u949F\u65F6\u95F4 (ms)",
      labelEn: "Max wall-clock time per cell (ms)",
      description: "\u5B8C\u6574 cell \u6267\u884C\uFF08\u542B\u5F02\u6B65\u7B49\u5F85\uFF09\u7684\u6700\u957F\u8017\u65F6\u3002",
      descriptionEn: "The longest a full cell execution may take, including async waits."
    },
    {
      key: "maxOutputBytes",
      type: "integer",
      default: 64 * 1024 * 1024,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6700\u5927\u8F93\u51FA\u5B57\u8282",
      labelEn: "Max output bytes",
      description: "\u9650\u5236\u5355\u4E2A cell \u7684\u8F93\u51FA\u548C\u7ED3\u679C\u6570\u636E\u603B\u5927\u5C0F\u3002",
      descriptionEn: "Caps the combined size of one cell output and result data."
    },
    {
      key: "maxOldGenerationSizeMb",
      type: "integer",
      default: 512,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "worker \u65E7\u751F\u4EE3\u5185\u5B58\u4E0A\u9650 (MiB)",
      labelEn: "Worker old-generation memory cap (MiB)",
      description: "\u6BCF\u4E2A worker \u7684 V8 \u65E7\u751F\u4EE3\u4E0A\u9650\uFF1B\u6D3B\u52A8 worker \u5B58\u5728\u65F6\u4FEE\u6539\u4F1A\u88AB\u62D2\u7EDD\u3002",
      descriptionEn: "Per-worker V8 old-generation limit; changes are rejected while an active worker exists."
    },
    {
      key: "maxValueNodes",
      type: "integer",
      default: 1e5,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "Value Graph \u6700\u5927\u8282\u70B9\u6570",
      labelEn: "Max Value Graph nodes",
      description: "\u9650\u5236\u5355\u6B21\u8FD4\u56DE\u503C\u7684\u8282\u70B9\u6570\u3002",
      descriptionEn: "Caps the node count of a single returned value."
    },
    {
      key: "maxValueEdges",
      type: "integer",
      default: 1e6,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "Value Graph \u6700\u5927\u8FB9\u6570",
      labelEn: "Max Value Graph edges",
      description: "\u9650\u5236\u5355\u6B21\u8FD4\u56DE\u503C\u7684\u5F15\u7528\u5173\u7CFB\u6570\u3002",
      descriptionEn: "Caps the reference-edge count of a single returned value."
    },
    {
      key: "maxValueArrayLength",
      type: "integer",
      default: 1e6,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6570\u7EC4\u6700\u5927\u58F0\u660E\u957F\u5EA6",
      labelEn: "Max declared array length",
      description: "\u9650\u5236\u8FD4\u56DE\u6570\u7EC4\u7684\u6700\u5927\u957F\u5EA6\u3002",
      descriptionEn: "Caps the maximum length of a returned array."
    },
    {
      key: "maxValueBigIntDigits",
      type: "integer",
      default: 1e5,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "BigInt \u6700\u5927\u5341\u8FDB\u5236\u4F4D\u6570",
      labelEn: "Max BigInt decimal digits",
      description: "\u9650\u5236\u8FD4\u56DE\u503C\u4E2D BigInt \u7684\u5341\u8FDB\u5236\u4F4D\u6570\u3002",
      descriptionEn: "Caps the decimal digits of BigInt values in a returned value."
    },
    {
      key: "maxNestedRunCodeDepth",
      type: "integer",
      default: 8,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "code.run \u6700\u5927\u9012\u5F52\u6DF1\u5EA6",
      labelEn: "Max code.run recursion depth",
      description: "\u9650\u5236 code.run \u7684\u5D4C\u5957\u5C42\u6570\u3002",
      descriptionEn: "Caps how deeply code.run may nest."
    },
    {
      key: "canonicalizeToolCalls",
      type: "boolean",
      default: true,
      label: "\u89C4\u8303\u9876\u5C42 native \u8BEF\u8C03",
      labelEn: "Canonicalize top-level native mis-calls",
      description: "\u4FEE\u6B63\u53EF\u4EE5\u660E\u786E\u8BC6\u522B\u7684\u9876\u5C42 native \u8BEF\u8C03\u3002",
      descriptionEn: "Repairs top-level native mis-calls that can be identified unambiguously."
    },
    {
      key: "looseTopLevelRedeclarations",
      type: "boolean",
      default: true,
      label: "\u5BBD\u677E\u9876\u5C42\u91CD\u58F0\u660E",
      labelEn: "Loose top-level redeclarations",
      description: "\u5141\u8BB8\u9876\u5C42 const/let \u91CD\u58F0\u660E\u5DF2\u6709\u53D8\u91CF\u3002",
      descriptionEn: "Allows top-level const/let to redeclare existing variables."
    },
    {
      key: "durableReplay",
      type: "boolean",
      default: true,
      label: "\u6301\u4E45\u91CD\u653E",
      labelEn: "Durable replay",
      description: "worker \u91CD\u542F\u540E\u6062\u590D\u53EF\u4EE5\u91CD\u5EFA\u7684 REPL \u72B6\u6001\u3002",
      descriptionEn: "Rebuilds recoverable REPL state after a worker restart."
    },
    {
      key: "autoRewriteImports",
      type: "boolean",
      default: true,
      label: "\u81EA\u52A8\u6539\u5199 import",
      labelEn: "Auto-rewrite import",
      description: "\u5141\u8BB8\u5728 run_code \u4E2D\u4F7F\u7528\u9759\u6001 import\u3002",
      descriptionEn: "Allows static import declarations inside run_code."
    },
    {
      key: "autoStripExports",
      type: "boolean",
      default: true,
      label: "\u81EA\u52A8\u5265\u79BB export",
      labelEn: "Auto-strip export",
      description: "\u5141\u8BB8\u5728 run_code \u4E2D\u4F7F\u7528\u9876\u5C42 export\u3002",
      descriptionEn: "Allows top-level export modifiers inside run_code."
    },
    {
      key: "autoSplitRedeclarations",
      type: "boolean",
      default: true,
      label: "\u81EA\u52A8\u62C6\u5206\u6DF7\u5408\u91CD\u58F0\u660E",
      labelEn: "Auto-split mixed redeclarations",
      description: "\u5141\u8BB8\u9876\u5C42\u89E3\u6784\u58F0\u660E\u540C\u65F6\u5305\u542B\u65B0\u65E7\u53D8\u91CF\u3002",
      descriptionEn: "Allows top-level destructuring declarations that mix new and existing variables."
    },
    {
      key: "tipsEnabled",
      type: "boolean",
      default: true,
      label: "\u542F\u7528\u6062\u590D\u63D0\u793A",
      labelEn: "Enable recovery tips",
      description: "\u5728\u7B26\u5408\u6761\u4EF6\u7684\u5931\u8D25\u540E\u663E\u793A\u6062\u590D\u63D0\u793A\u3002",
      descriptionEn: "Shows recovery tips after qualifying failures."
    },
    {
      key: "tipCooldownMessages",
      type: "integer",
      default: 3,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6062\u590D\u63D0\u793A\u51B7\u5374\u6B65\u6570",
      labelEn: "Recovery tip cooldown (messages)",
      description: "\u540C\u7C7B\u6062\u590D\u63D0\u793A\u4E4B\u95F4\u7684\u6700\u5C0F\u95F4\u9694\u3002",
      descriptionEn: "The minimum gap between recovery tips of the same kind."
    },
    {
      key: "tipEscalationFailures",
      type: "integer",
      default: 2,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6062\u590D\u63D0\u793A\u5347\u7EA7\u5931\u8D25\u6B21\u6570",
      labelEn: "Recovery tip escalation failures",
      description: "\u8FDE\u7EED\u5931\u8D25\u8FBE\u5230\u6B64\u6B21\u6570\u540E\u663E\u793A\u66F4\u8BE6\u7EC6\u7684\u6062\u590D\u63D0\u793A\u3002",
      descriptionEn: "After this many consecutive failures, a more detailed recovery tip is shown."
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
    const description = typeof args?.description === "string" && args.description.length > 0 ? args.description.split(/\r?\n/, 1)[0] : "";
    const output = settled ? resultText(block) : "";
    const state = !settled ? "running" : block.error?.code === "interrupted" ? "stopped" : block.isError === true ? "error" : "ok";
    const journal = settled && isRecord(block.meta) && isReadableJournal(block.meta.dshPtcPlus) ? block.meta.dshPtcPlus : void 0;
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

  // src/client.js
  var CLIENT_STYLE_ID = "ptc-plus-client-style";
  var CLIENT_CSS = `
.ptcPlusCard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;list-style:none;overflow:hidden}
.ptcPlusHeader{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .16s ease}
.ptcPlusHeader:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusHeader:focus-visible,.ptcPlusButton:focus-visible,.ptcPlusInput:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}
.ptcPlusHeadText{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:1px}.ptcPlusName{font-size:14px;font-weight:600;line-height:20px}.ptcPlusDescription{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusStatus{display:inline-flex;align-items:center;flex:none;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:16px}.ptcPlusStatus[data-enabled=true]{color:var(--dsw-alias-state-success-primary,#16794f);background:var(--dsw-alias-state-success-tertiary,#e7f7ef)}.ptcPlusStatus[data-enabled=false]{color:var(--dsw-alias-label-tertiary,#74777d);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ptcPlusChevron{display:flex;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .18s ease}.ptcPlusChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusBody{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.ptcPlusBody[data-open=true]{grid-template-rows:1fr}.ptcPlusBodyInner{min-height:0;overflow:hidden}.ptcPlusFields{margin:0 16px;padding:8px 0 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.ptcPlusRow{display:flex;align-items:center;gap:12px;min-height:48px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusRow:first-child{border-top:0}.ptcPlusMain{flex:1;min-width:0}.ptcPlusLabel{font-size:14px;font-weight:500;line-height:20px}.ptcPlusDetail,.ptcPlusMessage{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusInput{box-sizing:border-box;min-width:72px;width:140px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusCheck{width:18px;height:18px;accent-color:var(--dsw-alias-interactive-primary,#4d6bfe)}
.ptcPlusFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.ptcPlusButton{min-height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:500 13px/20px inherit;transition:background-color .16s ease,border-color .16s ease}.ptcPlusButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusButton:disabled,.ptcPlusInput:disabled,.ptcPlusCheck:disabled{cursor:not-allowed;opacity:.55}
.ptcPlusActive{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#52565d);font-size:12px;line-height:18px;white-space:nowrap}
.ptcPlusTool{display:flex;min-width:0;flex-direction:column}.ptcPlusToolSummary{display:flex;min-width:0;align-items:center;gap:7px;min-height:32px;padding:4px 0;color:inherit}.ptcPlusToolSummary[data-expandable=true]{cursor:pointer}.ptcPlusToolSummary[data-expandable=true]:hover .ptcPlusToolTitle{color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusToolSummary:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:2px}.ptcPlusToolLeading{display:flex;width:16px;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusToolChevron{transition:transform .16s ease}.ptcPlusToolChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusToolTitle{flex:none;font-size:13px;font-weight:500;line-height:20px}.ptcPlusToolState{flex:none;color:var(--dsw-alias-label-tertiary,#74777d);font-size:11px;line-height:18px}.ptcPlusToolSummary[data-state=running] .ptcPlusToolState{color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusToolSummary[data-state=error] .ptcPlusToolState{color:var(--dsw-alias-state-danger-primary,#c43d3d)}.ptcPlusToolSummary[data-state=stopped] .ptcPlusToolState{color:var(--dsw-alias-state-warning-primary,#a15c00)}.ptcPlusToolSep{width:3px;height:3px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusToolDescription{min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary,#52565d);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}.ptcPlusToolSummary[data-state=error] .ptcPlusToolDescription{color:var(--dsw-alias-state-danger-primary,#c43d3d)}.ptcPlusToolSummary[data-state=stopped] .ptcPlusToolDescription{color:var(--dsw-alias-state-warning-primary,#a15c00)}
.ptcPlusFeatures{display:flex;min-width:0;flex-wrap:wrap;gap:3px 14px;margin:0 0 5px 23px}.ptcPlusFeature{display:inline-flex;min-width:0;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#52565d);font-size:11px;line-height:17px}.ptcPlusFeature::before{width:4px;height:4px;flex:none;border-radius:50%;background:var(--dsw-alias-interactive-primary,#4d6bfe);content:''}.ptcPlusFeatureName{font-weight:500}.ptcPlusFeatureDetail{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#74777d);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.ptcPlusToolBody{margin:4px 0 8px 23px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03))}.ptcPlusToolSection{display:flex;min-width:0;flex-direction:column;gap:4px;padding:9px 11px}.ptcPlusToolSection+.ptcPlusToolSection{border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusToolSectionLabel{color:var(--dsw-alias-label-tertiary,#74777d);font-size:10px;font-weight:600;line-height:16px;text-transform:uppercase}.ptcPlusToolCode{max-height:320px;margin:0;overflow:auto;color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusInspect{display:inline-flex;align-self:flex-end;align-items:center;gap:5px;margin:0 9px 8px;padding:3px 7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer;font:500 11px/18px inherit}.ptcPlusInspect:hover{color:var(--dsw-alias-interactive-primary,#4d6bfe)}
@media(max-width:560px){.ptcPlusHeader{padding:12px}.ptcPlusFields{margin:0 12px}.ptcPlusRow{align-items:flex-start;flex-direction:column;gap:6px;padding:10px 0}.ptcPlusInput{width:100%}.ptcPlusFooter{align-items:stretch;flex-direction:column}.ptcPlusButton{width:100%}.ptcPlusFeatures,.ptcPlusToolBody{margin-left:0}.ptcPlusToolDescription{white-space:normal;overflow-wrap:anywhere}}
@media(prefers-reduced-motion:reduce){.ptcPlusHeader,.ptcPlusChevron,.ptcPlusBody,.ptcPlusButton,.ptcPlusToolChevron{transition:none}}
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
      "indicator.title": "PTC Plus \u5DF2\u542F\u7528",
      "tool.code": "\u4EE3\u7801",
      "tool.codeEdit": "\u4EE3\u7801\u7F16\u8F91",
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
      "indicator.title": "PTC Plus is active",
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
                  ...CONFIG_FIELDS.map((field) => h(
                    "div",
                    { key: field.key, className: "ptcPlusRow" },
                    h(
                      "div",
                      { className: "ptcPlusMain" },
                      h("div", { className: "ptcPlusLabel" }, t(`${field.key}.label`)),
                      field.description === "" ? null : h("div", { className: "ptcPlusDetail" }, t(`${field.key}.description`))
                    ),
                    fieldInput(field, value[field.key], fieldDisabled(field), persist, t(`${field.key}.label`))
                  )),
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
          const summary = outputSummary || view.description || t(stateKey);
          const toggle = () => {
            if (expandable) setOpen((current) => !current);
          };
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
            view.features.length === 0 ? null : h(
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
            ),
            !open ? null : h(
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
                h("pre", { className: "ptcPlusToolCode" }, view.output)
              ),
              typeof inspect !== "function" ? null : h("button", {
                type: "button",
                className: "ptcPlusInspect",
                onClick: inspect
              }, h(IconInspectOutline12, { "aria-hidden": true }), t("tool.inspect"))
            )
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
            const enabled = snapshot.status === "ready" && snapshot.value?.enabled === true;
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
          function PTCPlusSessionIndicator({ sessionId, t }) {
            const sessions = React.useSyncExternalStore(
              (listener) => scope.sessions.list.subscribe(listener),
              () => scope.sessions.list.getSnapshot(),
              () => scope.sessions.list.getSnapshot()
            );
            const settings = React.useSyncExternalStore(
              (listener) => preferenceScope.subscribe(listener),
              () => preferenceScope.getSnapshot(),
              () => preferenceScope.getSnapshot()
            );
            if (!sessionUsesPtcPreset(sessions.byId?.[sessionId]) || settings.status !== "ready" || settings.value?.enabled !== true) return null;
            return h(
              "span",
              { className: "ptcPlusActive", title: t("indicator.title") },
              h(IconCheckOutline14, { size: 14, "aria-hidden": true }),
              "PTC Plus"
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
