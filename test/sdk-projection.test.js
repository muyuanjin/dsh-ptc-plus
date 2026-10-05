import assert from 'node:assert/strict'
import test from 'node:test'
import { projectProgramSdk } from '../internal/sdk-projection.js'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools'

const PREFIX = /ptc-plus: incompatible tools SDK projection:/

function hostKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

// This fixture preserves the ToolArgsMap/ToolOutputMap layout emitted by DSH's renderToolsSdk.
function renderHostSdk(schemas) {
  const sorted = [...schemas].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))
  const args = sorted.flatMap(schema => [
    ...(schema.description === undefined ? [] : [`  /** ${schema.description} */`]),
    `  ${hostKey(schema.name)}: ${schema.parameters};`,
  ])
  const outputs = sorted.map(schema => `  ${hostKey(schema.name)}: ${schema.output};`)
  const map = (name, members) => `interface ${name} {${members.length === 0 ? '' : `\n${members.join('\n')}\n`}}`
  return `## Writing code for run_code

The available tools:

\`\`\`ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

${map('ToolArgsMap', args)}

${map('ToolOutputMap', outputs)}

type ToolName = keyof ToolOutputMap
\`\`\``
}

const EDIT_SCHEMA = {
  name: 'edit_run_code',
  description: 'Apply literal edits.',
  parameters: '{ edits: unknown[] }',
  output: 'unknown',
}

const SDK = `# Native tools

\`\`\`ts
interface ToolArgsMap {
  /** Direct edit transport. */
  edit_run_code: { edits: unknown[] };
  42: boolean;
  read: { file_path: string };
}
interface ToolOutputMap {
  /** Direct edit transport. */
  "edit_run_code": unknown;
  read: string;
}
declare const tools: {
  read(args: ToolArgsMap["read"]): Promise<ToolOutputMap["read"]>;
};
\`\`\`
`

test('projects the direct-only edit member from the complete host SDK byte-stably', () => {
  assert.equal(projectProgramSdk('native sdk'), 'native sdk')
  assert.equal(projectProgramSdk(undefined), '')
  assert.equal(projectProgramSdk(SDK), `# Native tools

\`\`\`ts
interface ToolArgsMap {
  42: boolean;
  read: { file_path: string };
}
interface ToolOutputMap {
  read: string;
}
declare const tools: {
  read(args: ToolArgsMap["read"]): Promise<ToolOutputMap["read"]>;
};
\`\`\`
`)
})

test('is a byte-identical differential projection of the current host renderer', () => {
  const fixtures = [
    [],
    [{ name: 'read', description: 'Read a file.', parameters: '{ file_path: string }', output: 'string' }],
    [
      { name: 'zzz', parameters: 'Record<string, never>', output: 'boolean' },
      { name: 'aaa', description: 'First tool.', parameters: '{ value?: number }', output: 'number' },
    ],
    [{ name: 'my-mcp.tool', description: 'Use an exotic name.', parameters: 'Record<string, never>', output: 'string[]' }],
  ]
  for (const schemas of fixtures) {
    const expected = renderHostSdk(schemas)
    for (const ordered of [schemas, [...schemas].reverse()]) {
      assert.equal(projectProgramSdk(renderHostSdk([...ordered, EDIT_SCHEMA])), expected)
    }
  }
})

test('projects only the current cell grammar in the official SDK introduction', () => {
  const restriction = 'erasable syntax only — no `enum` or namespaces'
  const schemas = [{ name: 'native', description: restriction, parameters: { type: 'object', properties: {} }, output: { type: 'number' } }]
  const sdk = renderToolsSdk(schemas)
  assert.match(sdk, /erasable syntax only — no `enum` or namespaces/)
  assert.equal(projectProgramSdk(sdk), sdk)
  const fence = sdk.indexOf('```ts\n')
  for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
    const options = { languageSemantics }
    const projected = projectProgramSdk(sdk, options)
    const projectedFence = projected.indexOf('```ts\n')
    assert.match(projected.slice(0, projectedFence), /runtime `enum` and namespaces are supported/)
    assert.doesNotMatch(projected.slice(0, projectedFence), /erasable syntax only|no `enum`/)
    assert.equal(projected.slice(projectedFence), sdk.slice(fence), 'native guidance and declarations stay byte-identical')
    assert.equal(projectProgramSdk(projected, options), projected)
    assert.equal(projectProgramSdk(sdk, options), projected)
    assert.equal(projectProgramSdk(undefined, options), '')
    assert.equal(projectProgramSdk('## Writing code for run_code\nno SDK fence', options), '## Writing code for run_code\nno SDK fence')
    assert.equal(projectProgramSdk('unrelated native guidance', options), 'unrelated native guidance')
  }
})

test('fails loudly when the host SDK shape cannot prove a complete projection', () => {
  const cases = [
    'edit_run_code outside a fence',
    `\`\`\`ts
interface ToolArgsMap { edit_run_code: unknown }
interface ToolOutputMap { edit_run_code: unknown }`,
    `\`\`\`ts
interface ToolArgsMap { edit_run_code: ; }
interface ToolOutputMap { edit_run_code: unknown }
\`\`\``,
    `\`\`\`typescript
interface ToolArgsMap { edit_run_code: unknown }
interface ToolOutputMap { edit_run_code: unknown }
\`\`\``,
    `\`\`\`ts
interface RenamedArgs { edit_run_code: unknown }
interface ToolOutputMap { edit_run_code: unknown }
\`\`\``,
    `\`\`\`ts
interface ToolArgsMap { edit_run_code: unknown; edit_run_code: string }
interface ToolOutputMap { edit_run_code: unknown }
\`\`\``,
    `\`\`\`ts
interface ToolArgsMap { edit_run_code: unknown }
interface ToolOutputMap { read: unknown }
\`\`\``,
    `\`\`\`ts
interface ToolArgsMap { edit_run_code: unknown
interface ToolOutputMap { edit_run_code: unknown }
\`\`\``,
    `${SDK}
\`\`\`ts
interface Other { value: string }
\`\`\``,
    `${SDK}
edit_run_code remains in host prose`,
  ]
  for (const source of cases) assert.throws(() => projectProgramSdk(source), PREFIX)

  assert.doesNotThrow(() => projectProgramSdk(`\`\`\`ts
interface ToolArgsMap { 1: unknown; edit_run_code: unknown }
interface ToolOutputMap { edit_run_code: unknown }
\`\`\``))
})
