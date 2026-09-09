import { deepFreeze } from './record-utils.js'

export const BINDING_SUBMISSION = deepFreeze({
  name: 'submitBindingDraft',
  description: 'Submit a Global User Binding draft for user review during /binding. Call inside run_code with the supplied requestId. Validates source and accepts one draft per request; does not save, enable or run it.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['requestId', 'entry'],
    properties: {
      requestId: { type: 'string', description: 'Copy from the active /binding request.' },
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
            description: 'Model documentation when enabled: includeDeclaration selects the source-derived interface (default true); instructions supplies a separate usage prompt (default empty, at most 4096 characters).',
            properties: {
              includeDeclaration: { type: 'boolean', description: 'Include the source-derived interface (default true), independently of instructions.' },
              instructions: { type: 'string', maxLength: 4096, description: 'Usage prompt for the model: when to call this API and any constraints absent from its types. Empty omits the prompt.' },
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
During /binding, submit a draft for user review from run_code using the supplied requestId. Submission does not save, enable or execute it.
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

Develop and check the helper in small run_code cells before submission. Start with a small executable check of the core behavior, then extend it using in-memory inputs and assertions for normal cases, edge cases and failures. Use node:assert/strict for comparisons. Keep the candidate and reusable test inputs in REPL variables; correct them from observed results and recheck changed behavior. For bulk tests, print totals and a few representative failures, keeping successful cases out of the output.

Tests must not write or delete files, change external services, or call effectful tools. For filesystem or network helpers, use in-memory substitutes and check argument forwarding and error propagation. Check imports and initializers before executing them; review unknown effects without running them. A substitute verifies only the behavior its assertions cover; real integration remains untested.

Review the final source, selected exports, types and usage prompt against the requirement and tested implementation. Keep test scaffolding out of the submitted module. In the answer, briefly report verified behavior and remaining limits; distinguish test-harness errors from helper errors and cite only behavior supported by the checks.

Submit from run_code with code.submitBindingDraft({ requestId: ${JSON.stringify(requestId)}, entry }). One valid submission completes this request; correct validation errors and retry only rejected submissions. The receipt confirms a disabled draft awaiting the user's save decision. Saving and enabling belong to the user.

Candidate contract:
${Object.entries(BINDING_SUBMISSION.parameters.properties.entry.properties).map(([name, field]) => `- ${name}: ${field.description ?? field.enum.join(' | ')}`).join('\n')}

Use namespace scope for a compact API: name "textHelpers" with export "trim" is called as textHelpers.trim(...). Top-level scope exposes selected exports directly. Supply complete TypeScript module source with useful types and API comments; the interface is generated from it. Do not supply entry.enabled or entry.declaration. Include modelContext.includeDeclaration and modelContext.instructions; leave instructions empty when the interface is sufficient, otherwise add only usage information missing from it. On edit, preserve the entry ID and existing prompt preferences unless the requirement changes them.

Relative imports in saved modules resolve from ${JSON.stringify(cwd)}, the binding storage directory, rather than the session cwd used by ordinary REPL cells. Prefer Node built-ins when sufficient; inspect dependencies only as needed. The selected entry is supplied for edits. Do not read or modify binding storage or unrelated entries, or scan the host installation to discover this API.

Submission example:
await code.submitBindingDraft({ requestId: ${JSON.stringify(requestId)}, entry: { id: "text-helpers", name: "textHelpers", scope: "namespace", purpose: "Trim surrounding whitespace.", source: "export function trim(value: string): string { return value.trim() }", modelContext: { includeDeclaration: true, instructions: "" } } })`
}
