import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'

test('owned realm callbacks follow the logical root while native properties retain their identities', () => {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const nativeSource = runInContext('Function.prototype.toString', context)
  const roots = createStatefulRootRuntime({ dynamicIntrinsics: intrinsics,
    readAmbient: name => runInContext(name, context),
    typeofAmbient: name => runInContext(`typeof ${name}`, context),
  })
  const first = roots.begin({ declared: ['value'], committed() {} })
  first.assign('value', 41, 'first')
  const environment = first.dynamic()
  const exposedEval = environment.expose(intrinsics.intrinsicEval)
  const exposedConstructor = environment.expose(intrinsics.realmFunction)
  assert.equal(['value'].map(exposedEval)[0], 41)
  const read = exposedConstructor('return value')
  assert.equal(read(), 41)
  const next = roots.begin({ declared: ['value'], committed() {} })
  next.assign('value', 42, 'next')
  assert.equal(read(), 42)
  assert.equal(['value'].map(exposedEval)[0], 42)
  assert.equal(runInContext('eval', context), intrinsics.intrinsicEval)
  assert.equal(runInContext('Function', context), intrinsics.realmFunction)
  assert.equal(runInContext('Function.prototype.toString', context), nativeSource)
  assert.equal(runInContext('typeof value', context), 'undefined')
})

function fixture() {
  const ambient = Object.create(null)
  const overlays = new Set()
  const hasAmbient = name => name in ambient || name in globalThis
  const readAmbient = name => {
    if (!hasAmbient(name)) throw new ReferenceError(`${name} is not defined`)
    return name in ambient ? ambient[name] : globalThis[name]
  }
  const runtime = createStatefulRootRuntime({
    hasAmbient, readAmbient,
    typeofAmbient: name => hasAmbient(name) ? typeof readAmbient(name) : 'undefined',
    writeAmbient(name, value, strict) {
      if (strict && !hasAmbient(name)) throw new ReferenceError(`${name} is not defined`)
      ambient[name] = value
    },
    deleteAmbient: name => Reflect.deleteProperty(ambient, name),
    hasOverlay: name => overlays.has(name),
  })
  const evaluator = createDynamicEnvironmentRuntime()
  const evaluate = (environment, source) => evaluator.evaluate(eval, undefined, [source], environment)
  return { runtime, ambient, overlays, evaluate }
}

test('root dynamic frames retain lexical and var ownership and reject eval conflicts before effects', () => {
  const { runtime, evaluate } = fixture()
  const cell = runtime.begin({
    declared: ['lexical', 'ordinary', 'hoisted', 'pending', 'inferred'],
    declarationKinds: [['lexical', 'const'], ['ordinary', 'var'], ['hoisted', 'hoisted']],
    declaredKinds: [['lexical', 'const'], ['ordinary', 'var'], ['hoisted', 'hoisted'], ['pending', 'let']],
    committed() {},
  })
  cell.assign('lexical', 1, 'lexical')
  cell.assign('ordinary', 2, 'ordinary')
  cell.assign('hoisted', () => 3, 'hoisted')
  const environment = cell.dynamic()
  assert.equal(evaluate(environment, 'lexical += 1; ordinary += 2; hoisted()'), 3)
  assert.deepEqual([runtime.read('lexical'), runtime.read('ordinary')], [2, 4])
  assert.throws(() => evaluate(environment, 'ordinary = 99; var lexical = 10'), SyntaxError)
  assert.equal(runtime.read('ordinary'), 4)
  assert.throws(() => evaluate(environment, 'typeof pending'), /before initialization/)
  assert.throws(() => evaluate(environment, 'var pending'), SyntaxError)
  assert.throws(() => evaluate(environment, 'var inferred'), SyntaxError)
  assert.equal(runtime.has('pending'), false)
  assert.equal(evaluate(environment, 'delete lexical'), false)
  assert.equal(evaluate(environment, 'delete ordinary'), false)
  evaluate(environment, 'var ordinary = 5; function hoisted() { return ordinary }')
  assert.equal(evaluate(environment, 'hoisted()'), 5)
  const reader = evaluate(environment, '() => lexical')
  const next = runtime.begin({ declared: ['lexical'], committed() {} })
  next.assign('lexical', 7, 'next')
  assert.equal(reader(), 7)
  next.link('linked', 'lexical', 'linked')
  assert.equal(evaluate(next.dynamic(), 'linked'), 7)
})

test('root dynamic eval vars can be deleted and recreated with exact write provenance', () => {
  const { runtime, ambient, evaluate } = fixture()
  const cell = runtime.begin({ committed() {} })
  const environment = cell.dynamic().at('eval:source')
  assert.equal(evaluate(environment, 'var created = 2; created'), 2)
  assert.equal(Object.hasOwn(ambient, 'created'), false)
  assert.deepEqual(runtime.facts(), [{ name: 'created', source: 'local', write: 'eval:source:"created"' }])
  assert.equal(evaluate(environment, 'var created; created'), 2)
  assert.equal(evaluate(environment, 'delete created'), true)
  assert.equal(evaluate(environment, 'typeof created'), 'undefined')
  assert.deepEqual(runtime.facts(), [{ name: 'created', source: 'absent', write: 'eval:source:"created"' }])
  assert.equal(evaluate(environment, 'var created = 3; created'), 3)
  environment.reference('created', 'write:explicit').value = 4
  assert.equal(runtime.read('created'), 4)
  assert.equal(runtime.facts()[0].write, 'write:explicit')

  assert.equal(evaluate(environment, 'implicit = 5'), 5)
  assert.equal(ambient.implicit, 5)
  assert.deepEqual(runtime.facts().find(fact => fact.name === 'implicit'), {
    name: 'implicit', source: 'local', write: 'eval:source:"implicit"',
  })
  assert.equal(evaluate(environment, 'typeof implicit'), 'number')
  assert.equal(evaluate(environment, 'delete implicit'), true)
  assert.equal(evaluate(environment, 'typeof implicit'), 'undefined')
  assert.equal(runtime.facts().find(fact => fact.name === 'implicit').source, 'absent')
  assert.throws(() => evaluate(environment.context({ strict: true }), 'uncreated = 6'), ReferenceError)
  assert.equal(runtime.facts().some(fact => fact.name === 'uncreated'), false)
})

test('root dynamic reads and writes follow imports and request overlays without replacing lexical storage', () => {
  const { runtime, ambient, overlays, evaluate } = fixture()
  const cell = runtime.begin({ declared: ['value'], committed() {} })
  const namespace = { value: 1 }
  cell.import('value', namespace, 'value', 'import')
  const environment = cell.dynamic()
  const read = evaluate(environment, '() => value')
  namespace.value = 2
  assert.equal(read(), 2)
  assert.equal(evaluate(environment, 'value = 3'), 3)
  assert.equal(namespace.value, 2)
  assert.equal(read(), 3)
  assert.equal(runtime.facts()[0].source, 'local')
  cell.import('value', namespace, 'value', 'reimport')
  assert.equal(read(), 2)

  ambient.value = 10
  overlays.add('value')
  assert.equal(read(), 10)
  assert.equal(evaluate(environment, 'value += 1'), 11)
  assert.equal(ambient.value, 11)
  assert.equal(namespace.value, 2)
  environment.at('eval:overlay').reference('value', 'write:overlay').value = 12
  assert.equal(ambient.value, 12)
  assert.equal(evaluate(environment, 'typeof value'), 'number')
  overlays.delete('value')
  assert.equal(read(), 2)
  assert.equal(runtime.facts()[0].source, 'import')

  const protectedCell = runtime.begin({ languageSemantics: 'protected-v1', readOnly: ['value'], committed() {} })
  assert.throws(() => evaluate(protectedCell.dynamic(), 'value = 9'), TypeError)
  assert.equal(namespace.value, 2)
  assert.equal(runtime.read('value'), 2)
})
