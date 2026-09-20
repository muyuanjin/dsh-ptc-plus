import assert from 'node:assert/strict'
import test from 'node:test'
import { projectChildProcessArguments } from '../internal/worker-cwd-virtualization.js'

const SESSION_CWD = '/session/project'
const callback = () => {}

test('projects child-process cwd through every supported overload shape', () => {
  const cases = [
    ['exec command', 'exec', ['command'], ['command', { cwd: SESSION_CWD }]],
    ['exec callback', 'exec', ['command', callback], ['command', { cwd: SESSION_CWD }, callback]],
    ['exec options', 'execSync', ['command', { encoding: 'utf8' }],
      ['command', { encoding: 'utf8', cwd: SESSION_CWD }]],
    ['exec null options', 'execSync', ['command', null], ['command', { cwd: SESSION_CWD }]],
    ['exec explicit cwd', 'execSync', ['command', { cwd: '/explicit' }],
      ['command', { cwd: '/explicit' }]],
    ['execFile path', 'execFile', ['node'], ['node', { cwd: SESSION_CWD }]],
    ['execFile callback', 'execFile', ['node', callback], ['node', { cwd: SESSION_CWD }, callback]],
    ['execFile argv callback', 'execFile', ['node', ['arg'], callback],
      ['node', ['arg'], { cwd: SESSION_CWD }, callback]],
    ['execFile options callback', 'execFile', ['node', { encoding: 'utf8' }, callback],
      ['node', { encoding: 'utf8', cwd: SESSION_CWD }, callback]],
    ['execFile argv', 'execFileSync', ['node', ['arg']],
      ['node', ['arg'], { cwd: SESSION_CWD }]],
    ['execFile options', 'execFileSync', ['node', { encoding: 'utf8' }],
      ['node', { encoding: 'utf8', cwd: SESSION_CWD }]],
    ['spawn command', 'spawn', ['node'], ['node', { cwd: SESSION_CWD }]],
    ['spawn options', 'spawn', ['node', { shell: true }],
      ['node', { shell: true, cwd: SESSION_CWD }]],
    ['spawn explicit cwd', 'spawn', ['node', { cwd: '/explicit' }],
      ['node', { cwd: '/explicit' }]],
    ['spawn argv', 'spawnSync', ['node', ['arg']], ['node', ['arg'], { cwd: SESSION_CWD }]],
    ['spawn omitted argv', 'spawnSync', ['node', undefined],
      ['node', undefined, { cwd: SESSION_CWD }]],
    ['fork explicit cwd', 'fork', ['module.js', [], { cwd: '/explicit' }],
      ['module.js', [], { cwd: '/explicit' }]],
  ]

  for (const [label, name, args, expected] of cases) {
    assert.deepEqual(projectChildProcessArguments(name, args, SESSION_CWD), expected, label)
  }
})

test('does not mutate caller-owned argument or option objects', () => {
  const options = { encoding: 'utf8' }
  const args = ['node', ['arg'], options]
  const projected = projectChildProcessArguments('spawn', args, SESSION_CWD)

  assert.deepEqual(args, ['node', ['arg'], options])
  assert.notEqual(projected, args)
  assert.notEqual(projected[2], options)
  assert.deepEqual(projected[2], { encoding: 'utf8', cwd: SESSION_CWD })
})

test('does not read the mutable Array iterator while projecting arguments', () => {
  const iterator = Symbol.iterator
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, iterator)
  let projected
  try {
    Object.defineProperty(Array.prototype, iterator, {
      ...descriptor,
      value: null,
    })
    projected = projectChildProcessArguments('spawn', ['node', ['arg']], SESSION_CWD)
  } finally {
    Object.defineProperty(Array.prototype, iterator, descriptor)
  }

  assert.deepEqual(projected, ['node', ['arg'], { cwd: SESSION_CWD }])
})
