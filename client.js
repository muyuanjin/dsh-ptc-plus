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

  // src/client.js
  var CLIENT_STYLE_ID = "ptc-plus-client-style";
  var CLIENT_CSS = `
.ptcPlusCard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;list-style:none;overflow:hidden}
.ptcPlusHeader{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .16s ease}
.ptcPlusHeader:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusHeader:focus-visible,.ptcPlusButton:focus-visible,.ptcPlusInput:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}
.ptcPlusHeadText{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:1px}.ptcPlusName{font-size:14px;font-weight:600;line-height:20px}.ptcPlusDescription{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusStatus{display:inline-flex;align-items:center;flex:none;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:16px}.ptcPlusStatus[data-enabled=true]{color:var(--dsw-alias-state-success-primary,#16794f);background:var(--dsw-alias-state-success-tertiary,#e7f7ef)}.ptcPlusStatus[data-enabled=false]{color:var(--dsw-alias-label-tertiary,#74777d);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ptcPlusChevron{display:flex;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .18s ease}.ptcPlusChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusBody{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.ptcPlusBody[data-open=true]{grid-template-rows:1fr}.ptcPlusBodyInner{min-height:0;overflow:hidden}.ptcPlusFields{margin:0 16px;padding:8px 0 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.ptcPlusRow{display:flex;align-items:center;gap:12px;min-height:48px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusRow:first-child{border-top:0}.ptcPlusMain{flex:1;min-width:0}.ptcPlusLabel{font-size:14px;font-weight:500;line-height:20px}.ptcPlusDetail,.ptcPlusMessage{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusInput{box-sizing:border-box;min-width:72px;width:140px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusCheck{width:18px;height:18px;accent-color:var(--dsw-alias-interactive-primary,#4d6bfe)}
.ptcPlusFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.ptcPlusButton{min-height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:500 13px/20px inherit;transition:background-color .16s ease,border-color .16s ease}.ptcPlusButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusButton:disabled,.ptcPlusInput:disabled,.ptcPlusCheck:disabled{cursor:not-allowed;opacity:.55}.ptcPlusActive{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-state-success-primary,#16794f);font-size:12px;line-height:18px;white-space:nowrap}
@media(max-width:560px){.ptcPlusHeader{padding:12px}.ptcPlusFields{margin:0 12px}.ptcPlusRow{align-items:flex-start;flex-direction:column;gap:6px;padding:10px 0}.ptcPlusInput{width:100%}.ptcPlusFooter{align-items:stretch;flex-direction:column}.ptcPlusButton{width:100%}}
@media(prefers-reduced-motion:reduce){.ptcPlusHeader,.ptcPlusChevron,.ptcPlusBody,.ptcPlusButton{transition:none}}
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
      "indicator.title": "PTC Plus \u5DF2\u542F\u7528"
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
      "indicator.title": "PTC Plus is active"
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
  window.__ModuleLoader__.load({
    // Replaced by the bundle entry with the package name from package.json.
    id: "dsh-ptc-plus",
    factory: (require2) => {
      const React = require2("react");
      const {
        IconCheckOutline14,
        IconChevronDownOutline14,
        IconSettingsOutline16
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
              h(IconSettingsOutline16, { size: 16 }),
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
            if (sessions.byId?.[sessionId]?.agentPreset !== "code" || settings.status !== "ready" || settings.value?.enabled !== true) return null;
            return h(
              "span",
              { className: "ptcPlusActive", title: t("indicator.title") },
              h(IconCheckOutline14, { size: 14 }),
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
