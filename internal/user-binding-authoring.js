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
    entry: { id: string; name: string; scope: "namespace" | "top-level"; symbols?: string[]; purpose: string; source: string };
  }): Promise<{ accepted: true; id: string; requestId: string }>;
}
\`\`\``

export function bindingAuthoringInstructions(requestId, cwd) {
  return `Create exactly one Global User Binding candidate for the user's requirement.

Submit from run_code with code.submitBindingDraft({ requestId: ${JSON.stringify(requestId)}, entry }). This request identity expires on acceptance, cancellation, replacement or Agent disposal. A successful receipt means only a disabled memory draft ready for user review. Only the user can save, enable or run it. Ordinary REPL declarations do not create this draft.

Candidate contract:
${Object.entries(BINDING_SUBMISSION.parameters.properties.entry.properties).map(([name, field]) => `- ${name}: ${field.description ?? field.enum.join(' | ')}`).join('\n')}

Use namespace scope for a compact reusable API. For name "textHelpers" and exported function "trim", later cells call textHelpers.trim(...); top-level scope exposes the selected exports directly. Do not supply enabled or derived declarations. Source is data for the handoff, not a cell to execute. Relative imports resolve from ${JSON.stringify(cwd)}, the bindings storage directory, during candidate execution and activation; session cwd is not that base. Prefer Node built-ins for self-contained helpers. Investigate a dependency only when the requirement needs it. This contract is complete: routine authoring does not require scanning the host installation, .dsh, bindings.json or unrelated entries. For edit, the complete selected entry is supplied below.

Minimal example (adapt names, source and purpose to the requirement):
await code.submitBindingDraft({ requestId: ${JSON.stringify(requestId)}, entry: { id: "text-helpers", name: "textHelpers", scope: "namespace", purpose: "Trim surrounding whitespace.", source: "export function trim(value: string): string { return value.trim() }" } })

Submit once after validation succeeds; fix a rejected candidate using the concrete error. Do not persist, enable, execute or import the candidate, or read or mutate unrelated stored entries. After acceptance, the user reviews the command card. A later save receipt proves persistence only; an active binding declaration proves successful session activation. repl.state is a checkpoint function, not a binding inventory, and its names are checkpoint names. For an availability question use the current declaration or a side-effect-free observation of the known binding; do not turn it into filesystem write/delete tests. Effectful tests require task authorization and exclusively created temporary resources; clean only resources owned by that test.`
}
