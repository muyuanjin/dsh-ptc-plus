/**
 * Model-visible prompt text the plugin authors, expressed as anchors and slots.
 *
 * An anchor is one delivered surface (a system section, a tool schema, a runtime
 * context, a result template). A slot is one piece of that surface with its own
 * ownership: `A` may be edited, `B` is read-only and says which code owns the
 * bytes, `C` belongs to someone else and is only mirrored. Slot kinds are a
 * separate axis from reason codes: `projected` says bytes come from facts, a
 * reason code says why a slot cannot be edited.
 *
 * Two rules keep this owner honest:
 * - Every literal default is byte-identical to the text its composer used before
 *   overrides existed, so an empty document reproduces today's prompt.
 * - Resolution is total: an unknown, oversize, read-only or empty-required
 *   override falls back to the default and reports why. Only saving validates
 *   strictly, because only saving has a user who can fix the input.
 *
 * Budgets are measured in **effective UTF-8 bytes**, meaning the bytes the request
 * would carry: an overridden slot counts its override, every other registered slot
 * counts its literal default, and an unknown id counts only its own override. The
 * limits are 4096 per slot, 16384 per anchor and 65536 per document.
 */
import {
  CLASS_REDECLARATION_REWRITE as REWRITE_CLASS,
  FUNCTION_REDECLARATION_REWRITE as REWRITE_FUNCTION,
  MIXED_REDECLARATION_REWRITE as REWRITE_MIXED,
} from './repl-rewrite-contract.js'


/** Persisted document shape for prompt-text overrides. */
export const PROMPT_TEXT_SCHEMA = 'ptc-prompt-text/v1'
/** Largest effective text one slot may deliver, in UTF-8 bytes. */
export const PROMPT_TEXT_MAX_SLOT_BYTES = 4096
/** Largest effective text the slots of one anchor may deliver together. */
export const PROMPT_TEXT_MAX_ANCHOR_BYTES = 16384
/** Largest effective text one configuration may deliver. */
export const PROMPT_TEXT_MAX_DOCUMENT_BYTES = 65536

/** Delivery channels, in the order the panel lists them. */
export const PROMPT_CHANNELS = Object.freeze(['prompt', 'install', 'plan', 'runtime', 'result'])
/** Slot kinds. A kind never doubles as a reason code. */
export const PROMPT_SLOT_KINDS = Object.freeze(['literal', 'aggregate', 'projected'])
/** Why a slot is read-only. Every non-editable slot names exactly one. */
export const PROMPT_REASON_CODES = Object.freeze([
  'fact-derived',
  'aggregate-frozen',
  'protocol-exact-text',
  'protocol-structural',
  'shadows-host',
  'other-owner',
])

/** Runtime snapshot prefixes: recognizer input, so they stay code-owned. */
export const STATE_PREFIX = 'PTC Plus recovery status. Replaces earlier PTC recovery status, including PTC state in runtime-context snapshots. Global binding APIs are unchanged.'
export const PREVIOUS_STATE_PREFIX = 'PTC Plus runtime recovery state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace the global binding API catalog, tasks, Skill instructions, tool results, or other producers.'
export const LEGACY_STATE_PREFIX = 'PTC Plus current state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace tasks, Skill instructions, tool results, or other producers.'
/** Catalog envelope text; the prefix is recognizer input and the empty sentences are prose. */
export const CATALOG_PREFIX = 'Global binding API reference for run_code (replaces the previous global binding reference):'
export const EMPTY_CATALOG = 'No entries documented.'
export const PREVIOUS_EMPTY_CATALOG = 'No global binding API documentation is currently configured. Earlier binding catalogs no longer apply.'
/**
 * The four delivered tip bodies. One slot per delivered body, so every branch a
 * model can receive is editable; the prefix and the detail sentences stay
 * code-owned because escalation decides which one appears.
 */
export const TIP_BODY = 'Inspect bounded runtime facts with {platformFacts}, then choose the executable and path in the current execution world. Use direct argv or a shell only when required; do not assume Windows, WSL, POSIX, or one shell. Do not dump process.env.'
export const TIP_BODY_PLATFORM_DETAILED = 'Re-check the active execution world and the actual executable before retrying. First inspect bounded runtime facts with {platformFacts}; use the result to choose the executable and path. Use direct argv for a normal executable; use a shell only when its syntax or resolution is required. Windows, WSL, POSIX, and package shims have different paths and launch rules. Do not dump process.env.'
export const TIP_BODY_REPEATED_BINDING = 'Inspect the visible cell source and results for the local name, scope, initialization, or declaration conflict. Correct that expression before continuing; capability discovery does not list session-local variables.{detail}'
export const TIP_BODY_REPEATED_BINDING_CAPABILITY = 'Inspect the live request with `capabilities.tree()`, `capabilities.find()`, or `capabilities.inspect()`, then call the typed member through `tools.*`.{detail}'

/**
 * Fillers for the `{detail}` hole; escalation decides which one appears.
 *
 * Both are registered read-only slots (`tip.detail.binding`, `tip.detail.capability`):
 * the renderer still decides *whether* the hole is filled, but the delivered bytes
 * come from the registry so accounting sees them and the surface gate can claim them.
 */
export const TIP_DETAIL_BINDING = ' Earlier statements may have run; use current expression evidence without assuming a failed declaration initialized its binding.'
export const TIP_DETAIL_CAPABILITY = ' Do not invent hidden bindings or repeat the same failing expression.'

/**
 * The two delivered tip prefixes: one per trigger kind, each its own slot.
 *
 * The recognizer identifies a tip by its notice name (`recoveryTipIdentity`), not
 * by this text, so the prefixes are `protocol-structural` rather than exact-text.
 * They are measured and read-only: escalation decides which trigger fires, but
 * both sentences are plugin-authored bytes, so accounting must see them.
 */
export const TIP_PREFIX_REPEATED_BINDING = 'The same binding failure has recurred.'
export const TIP_PREFIX_PLATFORM_COMMAND = 'An executable, shell, or path failed in the current execution world.'

/** Default discovery guidance delivered with the capability plan. */
export const PLAN_NAVIGATION = 'Use capabilities.search({query}) to retrieve complete tool, Skill and MCP contracts. Unlisted capabilities remain discoverable. Skill descriptions are summaries; follow each Skill\'s declared invocation eligibility to load its body before following it.'

/** One guidance line per capability category, in delivery order. */
export const PLAN_CATEGORY_LINES = Object.freeze({
  tool: 'Tools: search by task or tools.<name> for parameters and results.',
  skill: 'Skills: search by task or skills.<name> for when to use and how to load instructions.',
  resource: 'MCP resources: search by server or resource purpose.',
  'resource-template': 'MCP templates: search by server or resource purpose.',
  task: 'Tasks: search by the operation you need.',
})

/** Sentence delivered when the selected full contracts exceed their budget. */
export const PLAN_OVERAGE = 'Explicit full contracts exceed the configured budget by {overageBytes} UTF-8 bytes.'

/** Accepted hole in a projected slot; a save must keep exactly one occurrence. */
export const PLAN_OVERAGE_HOLE = '{overageBytes}'


/**
 * Result-rendering envelope for a cell that exceeded the output budget.
 *
 * The recognizer reads the byte count this sentence reports, so the sentence is
 * measured and read-only; the hole is the only variable part.
 */
export const RESULT_ENVELOPE = 'output exceeded {maxOutputBytes} bytes; this cell was discarded and the worker reset. Only bindings in the verified recovery frontier can be restored. External effects may already have occurred and are not undone. For future cells, bound console output and return a smaller value; do not assume this cell\'s values remain available.'

/** Accepted hole in the result envelope. */
export const RESULT_ENVELOPE_HOLE = '{maxOutputBytes}'

const GUIDANCE_OPENING = '`run_code` continues one persistent PTC REPL. Use Node.js modules in the cell; use external processes when their environment is needed. Ordinary top-level bindings remain available to later cells, so reuse them instead of resending setup code. Choose the smallest cell that answers the request and return only the value the next step needs.'

const GUIDANCE_ERROR_RECOVERY = 'After an execution error, earlier statements may have taken effect. Inspect relevant values in a short cell, then continue from them; repeat external operations only when their retry rules and current results establish safety. `edit_run_code` edits and reruns a complete cell.'

const GUIDANCE_CELL_CONVENTIONS = '## Cell conventions\nUse `return` for an explicit result and `console` for logs. Return supported values directly, including undefined, NaN, infinities, -0 and BigInt; JSON.stringify loses distinctions or rejects BigInt. Do not mix BigInt with Number arithmetic; use a BigInt literal or convert explicitly. Keep functions, Date, Map and other unsupported values in bindings; return needed data or type observations. Native `tools.*` arguments must satisfy their own JSON schemas; PTC value transport does not widen those contracts. Keep large inspection results in bindings or reduce them to targeted excerpts: `tools.read` is bounded inspection, not a lossless whole-file reader. Relative filesystem, path and default child-process operations use the current working directory at the time they run; a successful in-cell `tools.working_directory({ cd })` applies to the rest of that cell, while cell imports and `import.meta` keep the directory the cell started in, and `process.chdir` is unavailable.'

const GUIDANCE_CAPABILITIES = '## Available capabilities\nUse `capabilities.tree()`, `capabilities.find()`, and `capabilities.inspect()` for unfamiliar program APIs; Reserve `code.run` for isolated execution of source held as data.\nProgram API references expire when their cell ends. Reusable helpers must read the current namespace when called, for example `async function readNow(args) { return tools.read(args) }`, instead of retaining an earlier `tools` object or method. Completed-cell callbacks cannot call program APIs.'

const GUIDANCE_EXECUTION_WORLD = 'Native tool availability depends on the current DSH profile and execution world; inspect executables, shells, and paths instead of assuming Windows, WSL, POSIX, or a particular shell.'

const RUN_CODE_TOOL_DESCRIPTION = 'Evaluate the next TypeScript cell in this session-bound persistent REPL, reusing earlier top-level bindings. Use `code` for the cell and `description` for its short UI summary. Successful image-bearing subtool results are attached after the cell.'
const RUN_CODE_CODE_DESCRIPTION = 'Code for the next PTC TypeScript cell, following the selected language conventions.'
const RUN_CODE_DESCRIPTION_DESCRIPTION = 'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).'

/** Default description of the registered `edit_run_code` tool. */
export const EDIT_RUN_CODE_DESCRIPTION = 'Call this from within a run_code cell. It accepts an edit of the most recent eligible cell captured at nested dispatch and returns { accepted, scheduled, target_call_seq } when scheduled. The corrected cell runs after the current run_code cell releases its worker; its result is reported with that cell, and a successful edit becomes the next target. This reruns the entire target cell, including prior effects; use it after pre-execution rejection or when repeating those effects is safe under the called API\'s retry rules. Otherwise continue in a new run_code cell using retained values. A diagnostic may supply a localized correction; use it when it matches your intent and preserve its expected_target_call_seq. Send exactly one edits or regex_edits array: edits replaces unique literal fragments; regex_edits replaces a counted set of pattern matches. All ranges must be non-overlapping in the original cell. Regex replacements use JavaScript $1/$<name> captures, not \\1.'

/** Label the plugin writes before each delivered binding entry. */
const USER_BINDINGS_ENTRY_LABEL = 'Binding'

/** One editable slot: its bytes are the user's, and omitting is an explicit choice. */
function editableSlot(id, kind, omittable, defaultText) {
  if (!PROMPT_SLOT_KINDS.includes(kind)) throw new TypeError(`ptc-plus: unknown prompt slot kind ${kind} (${id})`)
  return Object.freeze({
    id, kind, owner: 'A', level: 'prose', reason: null, omittable, defaultText, source: 'registry-literal',
  })
}

/**
 * One read-only slot.
 *
 * `defaultText` is the literal the composer uses when the slot is a fixed string.
 * A generated slot passes `null` and names its `source`, because its bytes only
 * exist once the request is assembled; byte accounting marks it unmeasured rather
 * than pretending it is empty.
 */
function readOnlySlot(id, kind, reason, { source, defaultText = null, omittable = false, owner = 'B' }) {
  if (!PROMPT_SLOT_KINDS.includes(kind)) throw new TypeError(`ptc-plus: unknown prompt slot kind ${kind} (${id})`)
  if (!PROMPT_REASON_CODES.includes(reason)) throw new TypeError(`ptc-plus: unknown prompt reason code ${reason}`)
  if (owner !== 'B' && owner !== 'C') throw new TypeError(`ptc-plus: read-only slot ${id} must belong to B or C`)
  return Object.freeze({
    id, kind, owner, level: 'protocol', reason, omittable, defaultText, source,
  })
}

/**
 * One aggregate container slot.
 *
 * The set itself is frozen: adding or removing an item would move its neighbours'
 * bytes and the connectors between them, so the row is read-only with reason
 * `aggregate-frozen`. The container owns no text of its own, so it has no literal
 * default and is excluded from byte accounting; the items carry the bytes and stay
 * individually editable.
 */
function aggregateSlot(id, items) {
  return Object.freeze({
    id, kind: 'aggregate', owner: 'B', level: 'protocol', reason: 'aggregate-frozen',
    omittable: false, defaultText: null, source: 'registry-set', items: Object.freeze(items),
  })
}

/**
 * Every delivered anchor. `presence` states when the anchor reaches a request, so
 * the panel can show "not delivered now" without hiding the row.
 *
 * `wired` says whether a composer already delivers these slots through the
 * resolver. A declared but unwired anchor is listed with its channel, presence and
 * reason codes, renders no control, and contributes no bytes to a counter: its
 * slots have no literal default, so accounting marks them unmeasured instead of
 * reporting a measured zero.
 */
export const PROMPT_ANCHORS = Object.freeze([
  Object.freeze({
    id: 'tools:ptc-plus-repl',
    channel: 'prompt',
    wired: true,
    presence: 'run_code 已注册',
    slots: Object.freeze([
      editableSlot('guidance.opening', 'literal', false, GUIDANCE_OPENING),
      editableSlot('guidance.errorRecovery', 'literal', true, GUIDANCE_ERROR_RECOVERY),
      editableSlot('guidance.cellConventions', 'literal', true, GUIDANCE_CELL_CONVENTIONS),
      editableSlot('guidance.capabilities', 'literal', true, GUIDANCE_CAPABILITIES),
      editableSlot('guidance.executionWorld', 'literal', true, GUIDANCE_EXECUTION_WORLD),
      readOnlySlot('guidance.derivedPolicy', 'projected', 'fact-derived', {
        source: 'internal/binding-update-policy.js guidancePolicies()',
      }),
    ]),
  }),
  Object.freeze({
    id: 'tools:ptc-plus-user-binding-defaults',
    channel: 'prompt',
    wired: true,
    presence: '全局绑定启用',
    slots: Object.freeze([
      editableSlot('userBindings.entryLabel', 'literal', false, USER_BINDINGS_ENTRY_LABEL),
      readOnlySlot('userBindings.entryInstructions', 'literal', 'other-owner', {
        owner: 'C',
        source: 'internal/user-bindings.js (entry instructions supplied by the user)',
      }),
    ]),
  }),
  Object.freeze({
    id: 'run_code',
    channel: 'prompt',
    wired: true,
    presence: '每次请求',
    slots: Object.freeze([
      editableSlot('runCode.description', 'literal', false, RUN_CODE_TOOL_DESCRIPTION),
      editableSlot('runCode.codeArg', 'literal', false, RUN_CODE_CODE_DESCRIPTION),
      editableSlot('runCode.descriptionArg', 'literal', false, RUN_CODE_DESCRIPTION_DESCRIPTION),
    ]),
  }),
  Object.freeze({
    id: 'edit_run_code',
    channel: 'install',
    wired: true,
    presence: '下一次 agent 安装',
    slots: Object.freeze([
      editableSlot('editRunCode.description', 'literal', false, EDIT_RUN_CODE_DESCRIPTION),
    ]),
  }),
  Object.freeze({
    id: 'binding-catalog',
    channel: 'runtime',
    wired: true,
    presence: '有绑定条目',
    slots: Object.freeze([
      readOnlySlot('catalog.prefix', 'literal', 'protocol-exact-text', { source: 'registry-literal', defaultText: CATALOG_PREFIX }),
      editableSlot('catalog.empty', 'literal', false, EMPTY_CATALOG),
      // The previous-generation empty sentence is historical wording, not delivered
      // text: no composer emits it, and `HISTORICAL_EMPTY_CATALOGS` keeps it readable
      // for records written by another version. It is therefore deliberately not a
      // slot — an editable slot nobody delivers would inflate the accounting.
      readOnlySlot('catalog.entryInstructions', 'literal', 'other-owner', {
        owner: 'C',
        source: 'internal/user-bindings.js (entry instructions supplied by the user)',
      }),
    ]),
  }),
  Object.freeze({
    id: 'tools:sdk#capability-appendix',
    channel: 'prompt',
    wired: false,
    presence: '能力管理启用',
    slots: Object.freeze([
      readOnlySlot('capabilities.appendixProse', 'literal', 'shadows-host', {
        source: 'internal/direct-surface-owner.js capabilitySdk()',
      }),
      readOnlySlot('capabilities.declarations', 'literal', 'protocol-structural', {
        source: 'internal/direct-surface-owner.js capabilitySdk() declare block',
      }),
    ]),
  }),
  Object.freeze({
    id: 'plan.navigation',
    channel: 'plan',
    wired: true,
    presence: '新会话或 /capabilities refresh',
    slots: Object.freeze([
      editableSlot('plan.navigationSentence', 'literal', false, PLAN_NAVIGATION),
    ]),
  }),
  Object.freeze({
    id: 'plan.categories',
    channel: 'plan',
    wired: true,
    presence: '新会话或 /capabilities refresh',
    slots: Object.freeze([
      aggregateSlot('plan.categories.set', Object.keys(PLAN_CATEGORY_LINES).map(category => `plan.category.${category}`)),
      ...Object.entries(PLAN_CATEGORY_LINES).map(([category, line]) =>
        editableSlot(`plan.category.${category}`, 'literal', false, line)),
    ]),
  }),
  Object.freeze({
    id: 'plan.overage',
    channel: 'plan',
    wired: true,
    presence: '预算超限时',
    slots: Object.freeze([
      editableSlot('plan.overageSentence', 'projected', false, PLAN_OVERAGE),
    ]),
  }),
  Object.freeze({
    id: 'runtime.recovery-snapshot',
    channel: 'runtime',
    wired: true,
    presence: '恢复代际触发',
    slots: Object.freeze([
      readOnlySlot('recovery.snapshotPrefix', 'literal', 'protocol-exact-text', { source: 'registry-literal', defaultText: STATE_PREFIX }),
      readOnlySlot('recovery.previousStatePrefix', 'literal', 'protocol-exact-text', { source: 'registry-literal', defaultText: PREVIOUS_STATE_PREFIX }),
      readOnlySlot('recovery.legacyStatePrefix', 'literal', 'protocol-exact-text', { source: 'registry-literal', defaultText: LEGACY_STATE_PREFIX }),
    ]),
  }),
  Object.freeze({
    id: 'runtime.tip',
    channel: 'runtime',
    wired: true,
    presence: '触发命中',
    slots: Object.freeze([
      editableSlot('tip.body.platform', 'projected', false, TIP_BODY),
      editableSlot('tip.body.platformDetailed', 'projected', false, TIP_BODY_PLATFORM_DETAILED),
      editableSlot('tip.body.repeatedBinding', 'projected', false, TIP_BODY_REPEATED_BINDING),
      editableSlot('tip.body.repeatedBindingCapability', 'projected', false, TIP_BODY_REPEATED_BINDING_CAPABILITY),
      readOnlySlot('tip.prefix.repeatedBinding', 'literal', 'protocol-structural', {
        source: 'registry-literal',
        defaultText: TIP_PREFIX_REPEATED_BINDING,
      }),
      readOnlySlot('tip.prefix.platformCommand', 'literal', 'protocol-structural', {
        source: 'registry-literal',
        defaultText: TIP_PREFIX_PLATFORM_COMMAND,
      }),
      // The detail sentences fill the body's `{detail}` hole when a failure escalates.
      // Escalation stays a code decision; the sentences are registered so their bytes
      // are accounted and claimed rather than silently delivered outside the registry.
      readOnlySlot('tip.detail.binding', 'projected', 'fact-derived', {
        source: 'registry-literal',
        defaultText: TIP_DETAIL_BINDING,
      }),
      readOnlySlot('tip.detail.capability', 'projected', 'fact-derived', {
        source: 'registry-literal',
        defaultText: TIP_DETAIL_CAPABILITY,
      }),
    ]),
  }),
  Object.freeze({
    id: 'result.rewrite-feedback',
    channel: 'result',
    wired: true,
    presence: '改写发生',
    slots: Object.freeze([
      editableSlot('rewrite.mixed', 'literal', false, REWRITE_MIXED),
      editableSlot('rewrite.function', 'literal', false, REWRITE_FUNCTION),
      editableSlot('rewrite.class', 'literal', false, REWRITE_CLASS),
    ]),
  }),
  Object.freeze({
    id: 'result.diagnostics-and-budget',
    channel: 'result',
    wired: true,
    presence: '失败或超限',
    slots: Object.freeze([
      readOnlySlot('result.diagnosticsProse', 'literal', 'fact-derived', {
        source: 'internal/recovery-tips.js advice and budget prose',
      }),
      readOnlySlot('result.diagnosticsCodes', 'literal', 'protocol-structural', {
        source: 'internal/session-journal-schema.js PTC-* codes and help structure',
      }),
      // The envelope template is measured (the plugin writes every byte of it)
      // but not writable: the recognizer reads the byte count it reports.
      readOnlySlot('result.envelope', 'projected', 'fact-derived', {
        source: 'registry-literal',
        defaultText: RESULT_ENVELOPE,
      }),
    ]),
  }),
])

/** Flat slot list, in anchor order. */
export const PROMPT_SLOTS = Object.freeze(PROMPT_ANCHORS.flatMap(anchor => anchor.slots))

/**
 * Slot ids as constants.
 *
 * Composers import these instead of writing bare strings, and the coverage test
 * enforces both directions: no bare literal in a composer, every constant used.
 */
const slotConstantName = id => id.replace(/[.:-]+(.)?/gu, (_, next) => (next ?? '').toUpperCase())
export const PROMPT_SLOT_IDS = Object.freeze(Object.fromEntries(
  PROMPT_SLOTS.filter(slot => slot.source === 'registry-literal').map(slot => [slotConstantName(slot.id), slot.id]),
))

/**
 * Backwards-compatible alias for the flat slot list.
 *
 * Composer-side code and the settings pane still read `PROMPT_ASSETS` as a flat
 * list of editable rows; it is the same objects, so the two names cannot drift.
 */
export const PROMPT_ASSETS = PROMPT_SLOTS

const ANCHORS_BY_ID = new Map(PROMPT_ANCHORS.map(anchor => [anchor.id, anchor]))
const SLOTS_BY_ID = new Map(PROMPT_SLOTS.map(slot => [slot.id, slot]))
const ANCHOR_OF_SLOT = new Map(PROMPT_ANCHORS.flatMap(anchor => anchor.slots.map(slot => [slot.id, anchor.id])))

/** Default persisted document; an empty configuration reproduces today's prompt. */
export const PROMPT_TEXT_DEFAULT = JSON.stringify({ schema: PROMPT_TEXT_SCHEMA, overrides: {} })

/** Slot id of one category guidance line. */
export const planCategorySlotId = category => `plan.category.${category}`

/** Anchor ids in delivery order, for panels and tests. */
export function promptAnchorIds() {
  return PROMPT_ANCHORS.map(anchor => anchor.id)
}

/**
 * Every file that resolves slot ids through `PROMPT_SLOT_IDS`.
 *
 * The coverage test derives its scan from this list, so adding a composer means
 * registering it here instead of remembering to widen a test-local array.
 */
export const PROMPT_COMPOSER_FILES = Object.freeze([
  'index.js',
  'internal/direct-surface-owner.js',
  'internal/edit-transport-owner.js',
  'internal/capability-plan.js',
  'internal/capability-environment.js',
  'internal/runtime-messages.js',
  'internal/recovery-tips.js',
])

/** The anchor with this id. */
export function promptAnchor(id) {
  const anchor = ANCHORS_BY_ID.get(id)
  if (anchor === undefined) throw new TypeError(`ptc-plus: unknown prompt anchor ${id}`)
  return anchor
}

/** The anchor that delivers this slot. */
export function promptAnchorOfSlot(id) {
  const anchorId = ANCHOR_OF_SLOT.get(id)
  if (anchorId === undefined) throw new TypeError(`ptc-plus: unknown prompt slot ${id}`)
  return ANCHORS_BY_ID.get(anchorId)
}

/** One registered slot. */
export function promptSlot(id) {
  const slot = SLOTS_BY_ID.get(id)
  if (slot === undefined) throw new TypeError(`ptc-plus: unknown prompt slot ${id}`)
  return slot
}

/** Backwards-compatible name for the slot lookup used by composers. */
export const promptAsset = promptSlot

/**
 * Anchor → slot ids, derived from the registry.
 *
 * The request-surface gate imports this instead of keeping its own copy, so a
 * registered slot can never be missing from the surface map.
 */
export function anchorSlotMap() {
  return Object.freeze(Object.fromEntries(
    PROMPT_ANCHORS.map(anchor => [anchor.id, Object.freeze(anchor.slots.map(slot => slot.id))]),
  ))
}

/** Text a composer emits for one slot: the override when usable, else the default. */
export function promptAssetText(promptText, id) {
  const slot = promptSlot(id)
  if (slot.defaultText === null) {
    throw new TypeError(`ptc-plus: prompt slot ${id} is generated by ${slot.source}; composers may only request registry literals`)
  }
  return promptText === undefined || typeof promptText.text !== 'function'
    ? slot.defaultText
    : promptText.text(id)
}

// TextEncoder keeps the registry usable from both the worker realm and the
// client bundle, where Node's Buffer does not exist.
const byteLength = value => new TextEncoder().encode(value).length

/**
 * Apply one projected hole, keeping the registered template when the hole is
 * missing: a document that drops the hole would otherwise deliver an envelope
 * whose reported byte count no longer identifies the cell it describes.
 */
function fillHole(template, hole, value) {
  return template.includes(hole) ? template.replace(hole, String(value)) : template
}

/** Rewrite descriptions a cell delivers: override per kind, else the default. */
export function rewriteDescriptions(promptText) {
  return Object.freeze({
    mixed: promptAssetText(promptText, PROMPT_SLOT_IDS.rewriteMixed),
    function: promptAssetText(promptText, PROMPT_SLOT_IDS.rewriteFunction),
    class: promptAssetText(promptText, PROMPT_SLOT_IDS.rewriteClass),
  })
}

/** The result-rendering envelope for a cell that exceeded its output budget. */
export function resultEnvelopeText(promptText, maxOutputBytes) {
  return fillHole(promptAssetText(promptText, PROMPT_SLOT_IDS.resultEnvelope), RESULT_ENVELOPE_HOLE, maxOutputBytes)
}

/** Placeholders a projected default uses, in order of appearance. */
const holeTokens = text => typeof text === 'string' ? (text.match(/\{[a-zA-Z][a-zA-Z0-9]*\}/gu) ?? []) : []

/** Bytes a slot delivers: its override when present, else its literal default. */
function effectiveBytes(slot, overrides) {
  const text = overrides.has(slot.id) ? overrides.get(slot.id) : slot.defaultText
  return typeof text === 'string' ? byteLength(text) : 0
}

/** Effective bytes of every registered slot in one document. */
function sumEffectiveBytes(overrides) {
  let total = 0
  for (const slot of PROMPT_SLOTS) total += effectiveBytes(slot, overrides)
  return total
}

/** Overrides for ids this plugin version does not know still count toward the total. */
function unknownOverrideBytes(overrides) {
  let total = 0
  for (const [id, text] of overrides) {
    if (SLOTS_BY_ID.has(id)) continue
    total += byteLength(text)
  }
  return total
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Shape validation shared by both layers.
 *
 * Throws only for a document nothing can read: not a JSON string, a foreign
 * schema, or a non-string override. Slot and anchor budgets belong to the save
 * path, because render has to keep working from a document saving would reject.
 */
export function parsePromptTextDocument(value) {
  if (typeof value !== 'string') throw new TypeError('ptc-plus: promptText must be a JSON string')
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError('ptc-plus: promptText must contain valid JSON')
  }
  if (!isRecord(parsed) || parsed.schema !== PROMPT_TEXT_SCHEMA || !isRecord(parsed.overrides)) {
    throw new TypeError(`ptc-plus: promptText must be a ${PROMPT_TEXT_SCHEMA} document with an overrides object`)
  }
  for (const [id, text] of Object.entries(parsed.overrides)) {
    if (!id.trim()) throw new TypeError('ptc-plus: promptText override ids must not be empty')
    if (typeof text !== 'string') throw new TypeError(`ptc-plus: promptText override ${id} must be a string`)
  }
  return parsed
}

/**
 * Strict validation for the write path and `resolveConfig`.
 *
 * Adds what only a save can fix: the per-slot, per-anchor and per-document
 * ceilings, a non-empty value for every required slot, and a refusal to write a
 * read-only slot. Unknown ids are accepted shape-wise and counted in the document
 * total, so a document written by another plugin version still loads.
 */
export function validatePromptTextDocument(value) {
  const parsed = parsePromptTextDocument(value)
  const overrides = new Map()
  for (const [id, text] of Object.entries(parsed.overrides)) {
    const slot = SLOTS_BY_ID.get(id)
    if (slot === undefined) {
      overrides.set(id, text)
      continue
    }
    if (slot.owner !== 'A') {
      throw new TypeError(`ptc-plus: promptText slot ${id} is read-only (${slot.reason}); its bytes belong to another owner`)
    }
    const bytes = byteLength(text)
    if (bytes > PROMPT_TEXT_MAX_SLOT_BYTES) {
      throw new TypeError(`ptc-plus: promptText slot ${id} would deliver ${bytes} bytes, over the ${PROMPT_TEXT_MAX_SLOT_BYTES} byte slot limit`)
    }
    if (text.trim().length === 0 && !slot.omittable) {
      throw new TypeError(`ptc-plus: promptText slot ${id} must not be empty`)
    }
    // Only a projected slot's placeholder names a fact the composer substitutes.
    // A literal default may also contain braces (`plan.navigationSentence` shows
    // `capabilities.search({query})`), but that is prose: nothing substitutes it,
    // so requiring the token here would forbid legitimate rewording. The render
    // path applies the same rule to the same slot kinds.
    if (slot.kind === 'projected') {
      for (const hole of holeTokens(slot.defaultText)) {
        if (text.split(hole).length - 1 !== 1) {
          throw new TypeError(`ptc-plus: promptText slot ${id} must keep exactly one ${hole} placeholder`)
        }
      }
    }
    overrides.set(id, text)
  }
  // Effective bytes: the request carries an override when it has one and the
  // literal default otherwise, so the caps must measure what is delivered.
  for (const anchor of PROMPT_ANCHORS) {
    let total = 0
    for (const slot of anchor.slots) {
      total += effectiveBytes(slot, overrides)
      if (total > PROMPT_TEXT_MAX_ANCHOR_BYTES) {
        throw new TypeError(`ptc-plus: promptText anchor ${anchor.id} would deliver ${total} bytes, over the ${PROMPT_TEXT_MAX_ANCHOR_BYTES} byte anchor limit (at slot ${slot.id})`)
      }
    }
  }
  let document = sumEffectiveBytes(overrides) + unknownOverrideBytes(overrides)
  if (document > PROMPT_TEXT_MAX_DOCUMENT_BYTES) {
    throw new TypeError(`ptc-plus: promptText would deliver ${document} bytes, over the ${PROMPT_TEXT_MAX_DOCUMENT_BYTES} byte document limit`)
  }
  return parsed
}

/**
 * The document a render path may use, given one configuration object.
 *
 * `capabilityPromptTextEnabled` is the pause switch for this whole feature: when
 * it is off, every consumer must behave as if no document were stored, so
 * assembly, the tool schemas, the capability plan and the tip bodies all fall
 * back to the built-in text. Keeping that decision here means no consumer can
 * read `config.promptText` directly and quietly ignore the switch.
 */
export function promptTextDocument(config) {
  return config?.capabilityPromptTextEnabled === false ? undefined : config?.promptText
}

/** `resolvePromptText` over a configuration object, honoring the pause switch. */
export function resolvePromptTextConfig(config) {
  return resolvePromptText(promptTextDocument(config))
}

/**
 * Total resolution for every render and replay path.
 *
 * Never throws: each slot resolves to a usable override or its default, and
 * everything the override cannot be used for is reported as
 * `{ slotId, anchorId, reason }` instead of raised, because a prompt assembly
 * failure would take the whole cell with it.
 */
export function resolvePromptText(value) {
  const overrides = new Map()
  const reported = []
  if (value !== undefined && typeof value !== 'string') {
    // A non-string configuration is a malformed document, not an empty one: it
    // must show up in `reported` so the pane can say the stored value is unusable.
    reported.push({ slotId: undefined, anchorId: undefined, reason: 'invalid-document-type' })
    return freezeResolved(overrides, reported)
  }
  let parsed
  try {
    parsed = parsePromptTextDocument(value ?? PROMPT_TEXT_DEFAULT)
  } catch (error) {
    reported.push({ slotId: undefined, anchorId: undefined, reason: error.message })
    return freezeResolved(overrides, reported)
  }
  const anchorTotals = new Map()
  let document = 0
  for (const [id, text] of Object.entries(parsed.overrides)) {
    const bytes = byteLength(text)
    const slot = SLOTS_BY_ID.get(id)
    if (slot === undefined) {
      // An unknown id is never delivered, but it still occupies the document
      // budget: an unreadable id must not let a document grow without bound.
      document += bytes
      reported.push({ slotId: id, anchorId: undefined, reason: 'unknown-slot' })
      continue
    }
    const anchorId = ANCHOR_OF_SLOT.get(id)
    if (slot.owner !== 'A') {
      reported.push({ slotId: id, anchorId, reason: 'not-writable' })
      continue
    }
    if (bytes > PROMPT_TEXT_MAX_SLOT_BYTES) {
      reported.push({ slotId: id, anchorId, reason: 'slot-exceeds-limit' })
      continue
    }
    if (text.trim().length === 0 && !slot.omittable) {
      reported.push({ slotId: id, anchorId, reason: 'required-slot-empty' })
      continue
    }
    // Only a projected slot is rendered through a hole: the composer substitutes
    // `{platformFacts}`, `{detail}`, `{overageBytes}` or `{maxOutputBytes}` at
    // delivery. A literal default may also contain braces (`plan.navigationSentence`
    // shows `capabilities.search({query})`), but that is prose: nothing substitutes
    // it, and requiring the token would forbid legitimate rewording.
    if (slot.kind === 'projected') {
      const holes = holeTokens(slot.defaultText ?? '')
      const kept = holes.filter(hole => text.includes(hole))
      const duplicates = kept.some(hole => text.split(hole).length - 1 > 1)
      if (holes.length > 0 && (kept.length !== holes.length || duplicates)) {
        reported.push({ slotId: id, anchorId, reason: 'missing-hole' })
        continue
      }
    }
    const total = (anchorTotals.get(anchorId) ?? 0) + bytes
    if (total > PROMPT_TEXT_MAX_ANCHOR_BYTES) {
      reported.push({ slotId: id, anchorId, reason: 'anchor-exceeds-limit' })
      continue
    }
    anchorTotals.set(anchorId, total)
    overrides.set(id, text)
    document += bytes
  }
  if (document > PROMPT_TEXT_MAX_DOCUMENT_BYTES) {
    reported.push({ slotId: undefined, anchorId: undefined, reason: 'document-exceeds-limit' })
    overrides.clear()
  }
  enforceEffectiveCeilings(overrides, reported)
  return freezeResolved(overrides, reported)
}

/**
 * Enforce the same ceilings render-side, measured on effective bytes.
 *
 * `resolvePromptText` is also a draft renderer: the settings pane resolves text
 * that never passed `validatePromptTextDocument`. Without this pass a document
 * could deliver more than the anchor or document ceiling while every individual
 * override looked small, so a too-large override is dropped back to its default
 * and reported instead of being delivered.
 */
function enforceEffectiveCeilings(overrides, reported) {
  for (const [id, text] of [...overrides]) {
    if (byteLength(text) > PROMPT_TEXT_MAX_SLOT_BYTES) {
      reported.push({ slotId: id, anchorId: ANCHOR_OF_SLOT.get(id), reason: 'slot-exceeds-limit' })
      overrides.delete(id)
    }
  }
  for (const anchor of PROMPT_ANCHORS) {
    const overridden = anchor.slots.filter(slot => overrides.has(slot.id))
    if (overridden.length === 0) continue
    const total = anchor.slots.reduce((sum, slot) => sum + effectiveBytes(slot, overrides), 0)
    if (total <= PROMPT_TEXT_MAX_ANCHOR_BYTES) continue
    for (const slot of overridden) {
      reported.push({ slotId: slot.id, anchorId: anchor.id, reason: 'anchor-exceeds-limit' })
      overrides.delete(slot.id)
    }
  }
  if (sumEffectiveBytes(overrides) + unknownOverrideBytes(overrides) <= PROMPT_TEXT_MAX_DOCUMENT_BYTES) return
  for (const id of [...overrides.keys()]) {
    reported.push({ slotId: id, anchorId: ANCHOR_OF_SLOT.get(id), reason: 'document-exceeds-limit' })
  }
  overrides.clear()
}

function freezeResolved(overrides, reported) {
  const text = id => {
    const slot = promptSlot(id)
    if (overrides.has(id)) return overrides.get(id)
    return slot.defaultText
  }
  return Object.freeze({
    text,
    omitted: id => overrides.get(id) === '',
    overridden: id => overrides.has(id),
    reported: Object.freeze(reported),
  })
}

/**
 * Byte accounting for the panel counters.
 *
 * Pure function of a resolved document: per-slot bytes, per-anchor bytes, owner
 * totals (A/B/C) and anchor counts by pure owner vs mixed. A slot with no literal
 * default is `measured: false` and contributes no bytes, so a counter never
 * claims bytes the registry cannot see.
 *
 * Two slot labels stay separate and must never be derived from each other:
 * - 未测槽 (`counts.unmeasured`): slots on a channel this build has not wired to
 *   the resolver yet. Their bytes only exist once the composer is connected.
 * - 动态槽 (`counts.dynamic`): slots on a wired anchor that have no literal
 *   default (policy prose, user-supplied instructions). Their bytes are measured at
 *   assembly time by the composer, so they are not an unwired channel.
 * 投递未证 stays outside this function: only a boundary capture lane can report it.
 *
 * An owner card prints measured bytes plus how many of that owner's slots are not
 * connected yet; unwired bytes are never folded into the measured total.
 */
export function accountPromptText(resolved) {
  const slots = []
  const anchors = []
  const owners = { A: 0, B: 0, C: 0 }
  const counts = { pure: { A: 0, B: 0, C: 0 }, mixed: 0, total: 0 }
  const channels = new Map()
  const slotsByOwner = { A: 0, B: 0, C: 0 }
  const unmeasuredByOwner = { A: 0, B: 0, C: 0 }
  const dynamicByOwner = { A: 0, B: 0, C: 0 }
  for (const anchor of PROMPT_ANCHORS) {
    const anchorOwners = new Set()
    let anchorBytes = 0
    const anchorSlots = []
    for (const slot of anchor.slots) {
      const declared = resolved.text(slot.id)
      // An aggregate container is a set, not text: it owns no bytes and is neither
      // unwired nor dynamic, so it must not inflate either counter.
      const container = slot.kind === 'aggregate'
      const measured = !container && anchor.wired === true && typeof declared === 'string'
      const bytes = measured ? byteLength(declared) : 0
      // A slot without bytes is either on a channel nobody wired yet, or on a
      // wired anchor whose composer still has to produce the text. The two labels
      // answer different questions, so the accounting keeps them apart.
      const unwired = !container && !measured && anchor.wired !== true
      const dynamic = !container && !measured && anchor.wired === true
      anchorOwners.add(slot.owner)
      owners[slot.owner] += bytes
      slotsByOwner[slot.owner] += 1
      if (unwired) unmeasuredByOwner[slot.owner] += 1
      if (dynamic) dynamicByOwner[slot.owner] += 1
      anchorBytes += bytes
      const row = Object.freeze({
        slotId: slot.id, anchorId: anchor.id, owner: slot.owner, reason: slot.reason,
        kind: slot.kind, bytes, measured, unwired, dynamic, overridden: resolved.overridden(slot.id),
      })
      slots.push(row)
      anchorSlots.push(row)
    }
    const pure = anchorOwners.size === 1 ? [...anchorOwners][0] : undefined
    if (pure === undefined) counts.mixed += 1
    else counts.pure[pure] += 1
    counts.total += 1
    const anchorUnmeasured = anchorSlots.filter(slot => slot.unwired).length
    const anchorDynamic = anchorSlots.filter(slot => slot.dynamic).length
    const perChannel = channels.get(anchor.channel) ?? { anchors: 0, wired: 0, bytes: 0, unmeasuredSlots: 0, dynamicSlots: 0 }
    perChannel.anchors += 1
    if (anchor.wired === true) perChannel.wired += 1
    perChannel.bytes += anchorBytes
    perChannel.unmeasuredSlots += anchorUnmeasured
    perChannel.dynamicSlots += anchorDynamic
    channels.set(anchor.channel, perChannel)
    anchors.push(Object.freeze({
      anchorId: anchor.id, channel: anchor.channel, presence: anchor.presence,
      wired: anchor.wired === true,
      owner: pure ?? 'mixed', bytes: anchorBytes, unmeasuredSlots: anchorUnmeasured,
      dynamicSlots: anchorDynamic,
      slots: Object.freeze(anchorSlots),
    }))
  }
  return Object.freeze({
    slots: Object.freeze(slots),
    anchors: Object.freeze(anchors),
    owners: Object.freeze(owners),
    channels: Object.freeze(PROMPT_CHANNELS.map(channel => Object.freeze({
      channel,
      anchors: channels.get(channel)?.anchors ?? 0,
      wired: channels.get(channel)?.wired ?? 0,
      bytes: channels.get(channel)?.bytes ?? 0,
      unmeasuredSlots: channels.get(channel)?.unmeasuredSlots ?? 0,
      dynamicSlots: channels.get(channel)?.dynamicSlots ?? 0,
    }))),
    counts: Object.freeze({
      pure: Object.freeze(counts.pure), mixed: counts.mixed, total: counts.total,
      slots: Object.freeze(slotsByOwner),
      unmeasured: Object.freeze(unmeasuredByOwner),
      dynamic: Object.freeze(dynamicByOwner),
      // Flat totals so a caller never sums two maps by hand.
      unmeasuredSlots: Object.values(unmeasuredByOwner).reduce((sum, value) => sum + value, 0),
      dynamicSlots: Object.values(dynamicByOwner).reduce((sum, value) => sum + value, 0),
    }),
  })
}
