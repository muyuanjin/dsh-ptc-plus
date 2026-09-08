import { deepFreeze } from './record-utils.js'

export const BINDING_SUBMISSION = deepFreeze({
  name: 'submitBindingDraft',
  description: 'Submit one disabled in-memory Global User Binding candidate for the current /binding request. Requires its requestId and an active cell. This cannot persist, enable, or execute the candidate.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['requestId', 'entry'],
    properties: {
      requestId: { type: 'string', description: 'Exact request identity supplied by /binding; old requests cannot submit to a new one.' },
      entry: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'scope', 'purpose', 'source'],
        properties: {
          id: { type: 'string', description: 'Stable storage ID: 1-64 ASCII letters, digits, dots, underscores or hyphens; starts with a letter or digit.' },
          name: { type: 'string', description: 'namespace: JavaScript identifier used directly as the call name; top-level: display label.' },
          scope: { type: 'string', enum: ['namespace', 'top-level'] },
          symbols: { type: 'array', items: { type: 'string' }, description: 'Named value exports to expose; omit to select all. Names must exist in source.' },
          purpose: { type: 'string', description: 'One factual line explaining the API.' },
          modelContext: {
            type: 'object', additionalProperties: false,
            description: 'Per-entry model context. Author instructions as the prompt supplied to the model whenever this saved binding is enabled, and choose whether to include its source-derived API declaration. Applies from the first turn in new sessions and the next request after saving or enabling during an existing session.',
            properties: {
              includeDeclaration: { type: 'boolean', description: 'Include the existing source-derived API declaration in model context (default true). Independent of instructions; does not enable or execute the binding.' },
              instructions: { type: 'string', maxLength: 4096, description: 'Prompt injected for this binding: when to use it, constraints and examples addressed directly to the model. Empty omits this prompt; independent of includeDeclaration.' },
            },
          },
          source: { type: 'string', description: 'Complete TypeScript module with named value exports, explicit useful types, no default exports or re-exports.' },
        },
      },
    },
  },
  returns: {
    type: 'object', additionalProperties: false, required: ['accepted', 'id', 'requestId'],
    properties: { accepted: { const: true }, id: { type: 'string' }, requestId: { type: 'string' } },
  },
  effect: 'ptc-state', authority: 'ptc-plus-program-binding', completeness: 'complete', replay: 'recorded-value',
})

export const BINDING_AUTHORING_SDK = `
Global User Binding authoring is available only for an explicit /binding request. Its requestId is a transaction prerequisite, not persistence authority.
\`\`\`ts
declare namespace code {
  function submitBindingDraft(args: {
    requestId: string;
    entry: { id: string; name: string; scope: "namespace" | "top-level"; symbols?: string[]; purpose: string; source: string; modelContext?: { includeDeclaration?: boolean; instructions?: string } };
  }): Promise<{ accepted: true; id: string; requestId: string }>;
}
\`\`\``

export function bindingAuthoringInstructions(requestId, cwd) {
  return `Create exactly one Global User Binding candidate for the user's requirement.

Submit from run_code with code.submitBindingDraft({ requestId: ${JSON.stringify(requestId)}, entry }). This request identity expires on acceptance, cancellation, replacement or Agent disposal. A successful receipt means only a disabled memory draft ready for user review. Only the user can save, enable or run it. Ordinary REPL declarations do not create this draft.

Candidate contract:
${Object.entries(BINDING_SUBMISSION.parameters.properties.entry.properties).map(([name, field]) => `- ${name}: ${field.description ?? field.enum.join(' | ')}`).join('\n')}

Use namespace scope for a compact reusable API. For name "textHelpers" and exported function "trim", later cells call textHelpers.trim(...); top-level scope exposes the selected exports directly. Do not supply entry.enabled or derived entry.declaration. Write useful argument and return types, generics and API comments in source; the interface is generated from that source, never authored separately. Include modelContext.includeDeclaration (normally true) and modelContext.instructions, the prompt future model requests receive about when and how to use this binding. The declaration checkbox and prompt are independent: false omits the interface, empty instructions omits the prompt. These settings apply after the user saves and enables the entry, including in the current session's next request; acceptance alone does not publish a disabled draft. The user can edit both settings directly. On edit, preserve existing prompt preferences unless the requirement changes them. Source is data for the handoff, not a cell to execute. Relative imports resolve from ${JSON.stringify(cwd)}, the bindings storage directory, during candidate execution and activation; session cwd is not that base. Prefer Node built-ins for self-contained helpers. Investigate a dependency only when the requirement needs it. This contract is complete: routine authoring does not require scanning the host installation, .dsh, bindings.json or unrelated entries. For edit, the complete selected entry is supplied below.

Minimal example (adapt names, source and purpose to the requirement):
await code.submitBindingDraft({ requestId: ${JSON.stringify(requestId)}, entry: { id: "text-helpers", name: "textHelpers", scope: "namespace", purpose: "Trim surrounding whitespace.", source: "export function trim(value: string): string { return value.trim() }", modelContext: { includeDeclaration: true, instructions: "Use textHelpers.trim(value) to remove surrounding whitespace without changing the interior." } } })

Submit once after validation succeeds; fix a rejected candidate using the concrete error. Do not persist, enable, execute or import the candidate, or read or mutate unrelated stored entries. After acceptance, the user reviews the command card. A later save receipt proves persistence only; the global binding API catalog describes configuration, not successful initialization or current values. Execution results establish what actually initialized and ran. repl.state is a checkpoint function, not a binding inventory, and its names are checkpoint names. For an availability question use the catalog to describe configured APIs, or a side-effect-free observation of the known binding when actual runtime availability matters; do not turn it into filesystem write/delete tests. Effectful tests require task authorization and exclusively created temporary resources; clean only resources owned by that test.`
}
