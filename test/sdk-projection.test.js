import assert from 'node:assert/strict'
import test from 'node:test'
import { projectProgramSdk } from '../internal/sdk-projection.js'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools'

const EDIT_SCHEMA = {
  name: 'edit_run_code',
  description: 'Revise the last eligible cell.',
  parameters: {
    type: 'object', properties: {
      edits: {
        type: 'array',
        items: { type: 'object', properties: {
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        }, required: ['old_string', 'new_string'] },
      },
    },
  },
  output: { type: 'object', properties: {
    accepted: { type: 'boolean' },
    scheduled: { type: 'boolean' },
  }, required: ['accepted', 'scheduled'] },
}

test('retains the native SDK editor member and typed fields across language projection', () => {
  const sdk = renderToolsSdk([
    EDIT_SCHEMA,
    { name: 'read', description: 'Read a file.', parameters: {
      type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'],
    }, output: { type: 'string' } },
  ])
  assert.match(sdk, /edit_run_code: \{/)
  for (const field of ['old_string', 'new_string', 'accepted', 'scheduled']) {
    assert.match(sdk, new RegExp(field))
  }
  for (const languageSemantics of ['legacy-v1', 'stateful-v1', 'protected-v1']) {
    const projected = projectProgramSdk(sdk, { languageSemantics })
    const fence = sdk.indexOf('```ts\n')
    const projectedFence = projected.indexOf('```ts\n')
    assert.equal(projected.slice(projectedFence), sdk.slice(fence))
    assert.match(projected, /edit_run_code: \{/)
    assert.match(projected, /read: \{/)
    assert.equal(projectProgramSdk(projected, { languageSemantics }), projected)
  }
})

test('updates only the current cell grammar in the official SDK introduction', () => {
  const restriction = 'erasable syntax only — no `enum` or namespaces'
  const schemas = [{ name: 'native', description: restriction,
    parameters: { value: { type: 'number', required: true } }, output: { type: 'number' } }]
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

test('preserves unrecognized Host SDK text instead of deleting native members', () => {
  const sdk = '```ts\ninterface ToolArgsMap { edit_run_code: unknown }\n```'
  assert.equal(projectProgramSdk(sdk, { languageSemantics: 'stateful-v1' }), sdk)
  assert.equal(projectProgramSdk('native sdk'), 'native sdk')
  assert.equal(projectProgramSdk(undefined), '')
})

test('projects the cell grammar when the Host describes both required arguments in one sentence', () => {
  const sdk = '## Writing code for run_code\n\n'
    + '`run_code` takes two required arguments: `code`, the body of an async TypeScript function '
    + '(erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped), '
    + 'and `description`, a short summary of what the program does.\n\n'
    + 'Native guidance stays unchanged.\n\n```ts\n'
    + 'interface ToolArgsMap { /** erasable syntax only — no `enum` or namespaces */ native: {} }\n```'
  assert.equal(projectProgramSdk(sdk), sdk)
  for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
    const options = { languageSemantics }
    const projected = projectProgramSdk(sdk, options)
    const fence = projected.indexOf('```ts\n')
    assert.match(projected.slice(0, fence), /`code`, a PTC Plus TypeScript cell/)
    assert.match(projected, /and `description`, a short summary of what the program does/)
    assert.doesNotMatch(projected.slice(0, fence), /erasable syntax only|no `enum`/)
    assert.equal(projected.slice(fence), sdk.slice(sdk.indexOf('```ts\n')))
    assert.equal(projectProgramSdk(projected, options), projected)
  }
})
