import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import {
  PROCESS_CONTROL_ERROR_CODE,
  WORKER_REALM_MUTATION,
  WORKER_REALM_SURFACE_CONTRACT,
  assignWorkerRealmProperty,
  defineWorkerRealmProperty,
  workerRealmSurfaceFacts,
} from '../internal/worker-realm-surfaces.js'
import { createPrivateAsyncLocalStorage } from '../internal/async-local-storage-intrinsics.js'
import { fixture as pluginFixture } from './plugin-fixture.js'

const fixture = () => pluginFixture()
const traverse = traverseModule.default ?? traverseModule

const semanticObligations = JSON.parse(await readFile(new URL('../semantic-obligations.json', import.meta.url), 'utf8'))
const implementationSources = id => semanticObligations.obligations
  .find(obligation => obligation.id === id).implementation
const workerRealmSourceNames = [...new Set([
  ...implementationSources('execution-kernel')
    .filter(filename => filename.startsWith('internal/') && filename.endsWith('.js')),
  ...implementationSources('user-bindings-and-client')
    .filter(filename => /^internal\/.*-worker\.js$/u.test(filename)),
])]
const workerRealmSources = await Promise.all(workerRealmSourceNames.map(async filename => [
  filename,
  await readFile(new URL(`../${filename}`, import.meta.url), 'utf8'),
]))
const REALM_MUTATION_ROOTS = new Set([
  'AsyncLocalStorage', 'context', 'contextGlobal', 'globalObject', 'globalThis',
  'owner', 'process', 'processObject', 'receiver', 'scope',
])

function realmMutationRoots(filename) {
  const roots = new Set(REALM_MUTATION_ROOTS)
  // The helper process is outside the inner worker realm; its process is its lifecycle owner.
  if (filename === 'internal/kernel-child.js') roots.delete('process')
  // The boundary itself must use its private owner parameter to implement classified writes.
  if (filename === 'internal/worker-realm-surfaces.js') roots.delete('owner')
  return roots
}

function rootIdentifier(node) {
  let current = node
  while (current?.type === 'MemberExpression' || current?.type === 'OptionalMemberExpression') {
    current = current.object
  }
  return current?.type === 'Identifier' ? current.name : undefined
}

function mutationCallee(node) {
  if (node?.type === 'Identifier') return node.name
  if (node?.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier') return undefined
  const owner = rootIdentifier(node.object)
  return owner === undefined ? node.property.name : `${owner}.${node.property.name}`
}

function directRealmWrites(source, roots) {
  const writes = []
  const record = (path, form, target, ownerArgument = false) => {
    if (!ownerArgument && target?.type !== 'MemberExpression'
      && target?.type !== 'OptionalMemberExpression') return
    if (roots.has(rootIdentifier(target))) writes.push(`${form}:${path.node.loc.start.line}`)
  }
  traverse(parse(source, { sourceType: 'module' }), {
    CallExpression(path) {
      const callee = mutationCallee(path.node.callee)
      if (['Object.defineProperty', 'Reflect.defineProperty', 'privateReflect.defineProperty',
        'defineProperty', 'objectDefineProperty', 'Reflect.deleteProperty',
        'privateReflect.deleteProperty', 'deleteProperty'].includes(callee)) {
        record(path, callee, path.node.arguments[0], true)
      }
    },
    AssignmentExpression(path) {
      record(path, path.node.operator, path.node.left)
    },
    UnaryExpression(path) {
      if (path.node.operator === 'delete') record(path, 'delete', path.node.argument)
    },
  })
  return writes
}

function classifiedRealmWrites(source, filename) {
  const writes = []
  traverse(parse(source, { sourceType: 'module' }), {
    CallExpression(path) {
      if (path.node.callee.type !== 'Identifier'
        || !['assignWorkerRealmProperty', 'defineWorkerRealmProperty', 'deleteWorkerRealmProperty']
          .includes(path.node.callee.name)) return
      const classification = path.node.arguments[0]
      const surface = path.node.arguments[1]
      assert.equal(classification?.type, 'MemberExpression')
      assert.equal(classification.computed, false)
      assert.equal(classification.object?.name, 'WORKER_REALM_MUTATION')
      assert.ok(Object.hasOwn(WORKER_REALM_MUTATION, classification.property?.name))
      if (classification.property.name === 'STABLE') {
        assert.equal(surface?.type, 'StringLiteral')
        const entry = WORKER_REALM_SURFACE_CONTRACT.find(entry => (
          entry.surface === surface.value
          && entry.classification === WORKER_REALM_MUTATION.STABLE
        ))
        assert.notEqual(entry, undefined)
        if (filename !== 'internal/worker-realm-surfaces.js') {
          assert.ok(entry.owner.split(' and ').includes(filename),
            `${filename} is not a declared owner of ${surface.value}`)
        }
      }
      writes.push({ classification: classification.property.name, surface: surface?.value })
    },
  })
  return writes
}

const CALLABLE_SURFACE_FACTS = `
const realmKeyLabel = key => typeof key === 'symbol'
  ? \`symbol:\${Symbol.keyFor(key) ?? key.description ?? String(key)}\`
  : \`string:\${key}\`
const realmPrimitiveFact = value => {
  if (value === null) return ['null']
  const type = typeof value
  if (type === 'undefined') return ['undefined']
  if (type === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN']
    if (value === Infinity) return ['number', 'Infinity']
    if (value === -Infinity) return ['number', '-Infinity']
    if (Object.is(value, -0)) return ['number', '-0']
    return ['number', value]
  }
  if (type === 'bigint') return ['bigint', value.toString()]
  if (type === 'symbol') return ['symbol', Symbol.keyFor(value) ?? value.description ?? String(value)]
  if (type === 'string' || type === 'boolean') return [type, value]
  return [type]
}
const realmCallableFacts = (callable, depth = 0) => Reflect.ownKeys(callable)
  .map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(callable, key)
    const fact = {
      key: realmKeyLabel(key),
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      kind: Object.hasOwn(descriptor, 'value') ? 'data' : 'accessor',
    }
    if (fact.kind === 'accessor') {
      fact.get = typeof descriptor.get
      fact.set = typeof descriptor.set
      return fact
    }
    fact.writable = descriptor.writable
    fact.value = descriptor.value === callable
      ? 'self'
      : typeof descriptor.value === 'function' && depth < 2
        ? realmCallableFacts(descriptor.value, depth + 1)
        : realmPrimitiveFact(descriptor.value)
    return fact
  })
  .sort((left, right) => left.key.localeCompare(right.key))
const realmCallableOwnerFacts = owner => Reflect.ownKeys(owner)
  .map(key => [realmKeyLabel(key), Object.getOwnPropertyDescriptor(owner, key)])
  .filter(([, descriptor]) => descriptor && Object.hasOwn(descriptor, 'value')
    && typeof descriptor.value === 'function')
  .map(([key, descriptor]) => ({
    key,
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    writable: descriptor.writable,
    callable: realmCallableFacts(descriptor.value),
  }))
  .sort((left, right) => left.key.localeCompare(right.key))
const realmCwdProjectedBuiltinFacts = () => {
  const fs = require('node:fs')
  return {
    childProcess: realmCallableOwnerFacts(require('node:child_process')),
    fs: realmCallableOwnerFacts(fs),
    fsPromises: realmCallableOwnerFacts(fs.promises),
    path: realmCallableOwnerFacts(require('node:path')),
  }
}
`

const SURFACE_FACTS = `
${CALLABLE_SURFACE_FACTS}
const descriptor = (owner, name) => {
  const value = Object.getOwnPropertyDescriptor(owner, name)
  return value && { configurable: value.configurable, enumerable: value.enumerable, writable: value.writable }
}
const { AsyncLocalStorage } = require('node:async_hooks')
return {
  cwd: descriptor(process, 'cwd'),
  controls: ['exit', 'abort', 'kill', 'chdir'].map(name => [name, descriptor(process, name)]),
  stdoutWrite: descriptor(process.stdout, 'write'),
  stderrWrite: descriptor(process.stderr, 'write'),
  stdoutWriteOwn: Object.hasOwn(process.stdout, 'write'),
  stderrWriteOwn: Object.hasOwn(process.stderr, 'write'),
  cwdProjectedBuiltins: realmCwdProjectedBuiltinFacts(),
  consoleMethods: ['log', 'dir', 'table', 'time', 'trace'].map(name => typeof console[name]),
  moduleSurface: [typeof require, typeof require.resolve, typeof require.cache, typeof require.main,
    typeof __dirname, typeof __filename, typeof module],
  importMeta: {
    same: import.meta === import.meta,
    nullPrototype: Object.getPrototypeOf(import.meta) === null,
    url: import.meta.url,
    filename: import.meta.filename,
    dirname: import.meta.dirname,
  },
  asyncLocalStorage: {
    run: descriptor(AsyncLocalStorage.prototype, 'run'),
    own: Object.getOwnPropertyNames(new AsyncLocalStorage()),
  },
}`

function nativeWorkerFacts() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads')
      ${CALLABLE_SURFACE_FACTS}
      const descriptor = (owner, name) => {
        const value = Object.getOwnPropertyDescriptor(owner, name)
        return value && { configurable: value.configurable, enumerable: value.enumerable, writable: value.writable }
      }
      const { AsyncLocalStorage } = require('node:async_hooks')
      parentPort.postMessage({
        cwd: descriptor(process, 'cwd'),
        controls: ['exit', 'abort', 'kill', 'chdir'].map(name => [name, descriptor(process, name)]),
        stdoutWrite: descriptor(process.stdout, 'write'),
        stderrWrite: descriptor(process.stderr, 'write'),
        stdoutWriteOwn: Object.hasOwn(process.stdout, 'write'),
        stderrWriteOwn: Object.hasOwn(process.stderr, 'write'),
        cwdProjectedBuiltins: realmCwdProjectedBuiltinFacts(),
        consoleMethods: ['log', 'dir', 'table', 'time', 'trace'].map(name => typeof console[name]),
        moduleSurface: [typeof require, typeof require.resolve, typeof require.cache, typeof require.main,
          typeof __dirname, typeof __filename, typeof module],
        asyncLocalStorage: {
          run: descriptor(AsyncLocalStorage.prototype, 'run'),
          own: Object.getOwnPropertyNames(new AsyncLocalStorage()),
        },
      })
    `, { eval: true, stdout: true, stderr: true })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`native reference worker exited with code ${code}`))
    })
  })
}

test('executes the complete stable realm-surface inventory against native references', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = { id: 'realm-surface-facts', events: [], header: { cwd: process.cwd() } }
  const [native, realm] = await Promise.all([
    nativeWorkerFacts(),
    state.run(session.id, SURFACE_FACTS, {}, { session }),
  ])

  const facts = realm.value
  const expectedModuleFilename = resolve(process.cwd(), 'repl')
  const callableFacts = Function(`${CALLABLE_SURFACE_FACTS}\nreturn realmCallableFacts`)()
  const protectedScopeFacts = (scope) => ({
    methods: ['getStore', 'enterWith', 'run'].map(name => {
      const descriptor = Object.getOwnPropertyDescriptor(scope, name)
      return {
        name,
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        callable: callableFacts(descriptor.value),
      }
    }),
    behavior: (() => {
      const runStore = { kind: 'run' }
      const enteredStore = { kind: 'entered' }
      const inside = scope.run(runStore, () => scope.getStore() === runStore)
      const outside = scope.getStore()
      scope.enterWith(enteredStore)
      return { inside, outside, entered: scope.getStore() === enteredStore }
    })(),
  })
  const nativeScope = new AsyncLocalStorage()
  for (const name of ['getStore', 'enterWith', 'run']) {
    Object.defineProperty(nativeScope, name, { value: AsyncLocalStorage.prototype[name].bind(nativeScope) })
  }
  const protectedScope = createPrivateAsyncLocalStorage()
  const verifiers = new Map([
    ['console-methods', () => assert.deepEqual(facts.consoleMethods, native.consoleMethods)],
    ['stream-descriptors', () => {
      assert.deepEqual([native.stdoutWrite, native.stderrWrite], [undefined, undefined])
      assert.deepEqual([native.stdoutWriteOwn, native.stderrWriteOwn], [false, false])
      assert.deepEqual(facts.stdoutWrite, { configurable: true, enumerable: true, writable: true })
      assert.deepEqual(facts.stderrWrite, { configurable: true, enumerable: true, writable: true })
      assert.deepEqual([facts.stdoutWriteOwn, facts.stderrWriteOwn], [true, true])
    }],
    ['cwd-descriptor', () => {
      assert.deepEqual(native.cwd, { configurable: true, enumerable: true, writable: true })
      assert.deepEqual(facts.cwd, { configurable: false, enumerable: true, writable: false })
    }],
    ['cwd-projected-builtins', () => {
      assert.deepEqual(facts.cwdProjectedBuiltins, native.cwdProjectedBuiltins)
      const serialized = JSON.stringify(facts.cwdProjectedBuiltins)
      assert.match(serialized, /symbol:nodejs\.util\.promisify\.custom/u)
      assert.match(serialized, /string:native/u)
    }],
    ['process-controls', () => {
      for (const [, descriptor] of native.controls) {
        assert.deepEqual(descriptor, { configurable: true, enumerable: true, writable: true })
      }
      for (const [, descriptor] of facts.controls) {
        assert.deepEqual(descriptor, { configurable: false, enumerable: true, writable: false })
      }
    }],
    ['descriptor-output', async () => {
      const output = await state.run(session.id, `
const fs = require('node:fs')
const childProcess = require('node:child_process')
fs.writeSync(1, 'inventory-fd')
childProcess.execFileSync(process.execPath, ['-e', "process.stderr.write('inventory-child')"], {stdio:'inherit'})
`)
      assert.equal(output.error, undefined)
      assert.match(output.logs.join(''), /inventory-fd/u)
      assert.match(output.logs.join(''), /inventory-child/u)
    }],
    ['module-surface', () => {
      assert.deepEqual(native.moduleSurface, ['function', 'function', 'object', 'undefined', 'string', 'string', 'object'])
      assert.deepEqual(facts.moduleSurface, ['function', 'function', 'object', 'undefined', 'undefined', 'undefined', 'undefined'])
      assert.deepEqual(facts.importMeta, {
        same: true,
        nullPrototype: true,
        url: pathToFileURL(expectedModuleFilename).href,
        filename: expectedModuleFilename,
        dirname: process.cwd(),
      })
    }],
    ['async-local-storage', () => {
      assert.deepEqual(facts.asyncLocalStorage, native.asyncLocalStorage)
      for (const name of ['getStore', 'enterWith', 'run']) {
        assert.equal(facts.asyncLocalStorage.own.includes(name), false)
      }
    }],
    ['private-async-local-storage', () => {
      assert.deepEqual(protectedScopeFacts(protectedScope), protectedScopeFacts(nativeScope))
    }],
  ])
  assert.equal(new Set(WORKER_REALM_SURFACE_CONTRACT.map(entry => entry.surface)).size,
    WORKER_REALM_SURFACE_CONTRACT.length)
  assert.equal(new Set(WORKER_REALM_SURFACE_CONTRACT.map(entry => entry.verification)).size,
    WORKER_REALM_SURFACE_CONTRACT.length)
  for (const entry of WORKER_REALM_SURFACE_CONTRACT) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'classification', 'contract', 'owner', 'reference', 'surface', 'verification',
    ])
    assert.ok(entry.owner.length > 0)
    assert.ok(entry.classification.length > 0)
    assert.ok(entry.contract.length > 0)
    assert.ok(entry.reference.length > 0)
    const verify = verifiers.get(entry.verification)
    assert.equal(typeof verify, 'function', entry.surface)
    await verify()
    verifiers.delete(entry.verification)
  }
  assert.deepEqual([...verifiers.keys()], [])
  assert.equal(workerRealmSurfaceFacts(process).cwd.configurable, native.cwd.configurable)
})

test('all supported worker-realm write forms route through the classified owner', async () => {
  assert.ok(workerRealmSourceNames.includes('internal/user-binding-console-worker.js'))
  assert.deepEqual(
    directRealmWrites('Object.defineProperty(context, name, descriptor); process.stdout.write = replacement; delete globalThis[name]',
      new Set(['context', 'process', 'globalThis'])),
    ['Object.defineProperty:1', '=:1', 'delete:1'],
  )
  assert.deepEqual(
    directRealmWrites('owner[name] = wrapped', new Set(['owner'])),
    ['=:1'],
  )
  assert.deepEqual(
    directRealmWrites('delete context[name]', new Set(['context'])),
    ['delete:1'],
  )
  const observerSource = workerRealmSources
    .find(([filename]) => filename === 'internal/repl-value-observer.js')?.[1]
  assert.equal(typeof observerSource, 'string')
  const bypassingObserver = observerSource
    .replace(/^import .*worker-realm-surfaces\.js'\n/mu, '')
    .replace(
      /deleteWorkerRealmProperty\([\s\S]*?context,\s*(?:name|names\[index\]),?\s*\)/u,
      'delete context[name]',
    )
  assert.equal(bypassingObserver.includes("'./worker-realm-surfaces.js'"), false)
  assert.ok(directRealmWrites(bypassingObserver, realmMutationRoots('internal/repl-value-observer.js'))
    .some(write => write.startsWith('delete:')))
  const classified = []
  for (const [filename, source] of workerRealmSources) {
    assert.deepEqual(directRealmWrites(source, realmMutationRoots(filename)), [], filename)
    classified.push(...classifiedRealmWrites(source, filename))
  }
  assert.ok(classified.length > 0)
  const stableSurfaces = new Set(classified
    .filter(write => write.classification === 'STABLE')
    .map(write => write.surface))
  assert.deepEqual(stableSurfaces, new Set([
    'cell module metadata',
    'console',
    'cwd-projected Node builtins',
    'private AsyncLocalStorage receiver methods',
    'process.cwd',
    'process.exit/abort/kill/chdir',
    'process.stdout.write/process.stderr.write',
  ]))
  assert.deepEqual(Object.values(WORKER_REALM_MUTATION).sort(), [
    'per-cell-program-binding',
    'restoration-only',
    'stable-native-divergence',
    'temporary-compiler-name',
    'user-declaration-binding',
  ])
  assert.throws(
    () => defineWorkerRealmProperty(WORKER_REALM_MUTATION.STABLE, 'missing-surface', {}, 'value', { value: 1 }),
    /requires a matching registered classification/u,
  )
  assert.throws(
    () => defineWorkerRealmProperty(WORKER_REALM_MUTATION.STABLE,
      'AsyncLocalStorage.prototype.run', {}, 'value', { value: 1 }),
    /requires a matching registered classification/u,
  )
  assert.throws(
    () => defineWorkerRealmProperty('unclassified', undefined, {}, 'value', { value: 1 }),
    /unknown worker realm mutation classification/u,
  )
  const immutable = Object.freeze({ value: 1 })
  assert.throws(
    () => defineWorkerRealmProperty(WORKER_REALM_MUTATION.RESTORE, undefined,
      immutable, 'other', { value: 2 }),
    /could not be defined/u,
  )
  assert.throws(
    () => assignWorkerRealmProperty(WORKER_REALM_MUTATION.RESTORE, undefined, immutable, 'value', 2),
    /could not be assigned/u,
  )
})

test('callable surface facts retain exact name and arity values', () => {
  const callableFacts = Function(`${CALLABLE_SURFACE_FACTS}\nreturn realmCallableFacts`)()
  function original(left, right) { return left + right }
  function wrong() { return 0 }
  const originalFacts = callableFacts(original)
  const wrongFacts = callableFacts(wrong)
  assert.deepEqual(originalFacts.find(fact => fact.key === 'string:name').value, ['string', 'original'])
  assert.deepEqual(originalFacts.find(fact => fact.key === 'string:length').value, ['number', 2])
  assert.deepEqual(wrongFacts.find(fact => fact.key === 'string:name').value, ['string', 'wrong'])
  assert.deepEqual(wrongFacts.find(fact => fact.key === 'string:length').value, ['number', 0])
  assert.notDeepEqual(originalFacts, wrongFacts)
})

test('uses one stable process-control error contract', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.run('process-control-code', `
const observed = []
for (const name of ['exit', 'abort', 'kill', 'chdir']) {
  let setterCalls = 0
  Object.defineProperty(Error.prototype, 'code', {
    configurable: true,
    set() { setterCalls += 1; throw new Error('user setter replaced process-control failure') },
  })
  try {
    process[name]()
  } catch (error) {
    observed.push([name, error.name, error.code, error.message, Object.hasOwn(error, 'code'), setterCalls])
  } finally {
    delete Error.prototype.code
  }
}
return observed
`)
  assert.equal(result.error, undefined)
  for (const [name, errorName, code, message, ownCode, setterCalls] of result.value) {
    assert.equal(errorName, 'Error')
    assert.equal(code, PROCESS_CONTROL_ERROR_CODE)
    assert.equal(message, `process.${name} is forbidden inside the REPL kernel`)
    assert.equal(ownCode, true)
    assert.equal(setterCalls, 0)
  }
})
