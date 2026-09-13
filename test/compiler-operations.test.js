import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@babel/parser'
import { types as t } from '@babel/core'
import { compileDynamicEnvironmentSource } from '../internal/dynamic-environment-compiler.js'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { loadManagedSource } from './managed-module-fixture.js'
import { createCompilerOperationPlanner } from '../internal/compiler-operations.js'

test('compilation binding indexes share ownership while each AST retains its own generated state', () => {
  const planner = createCompilerOperationPlanner({ bindings: [{ physicalName: 'slot', property: 'value' }], internalBindings: ['helper'] })
  const firstTree = parse('helper(slot.value)')
  const secondTree = parse('helper(slot.value)')
  const first = planner(firstTree), second = planner(secondTree)
  const firstCall = firstTree.program.body[0].expression
  const secondCall = secondTree.program.body[0].expression
  assert.equal(first.owns(firstCall), true)
  assert.equal(second.owns(secondCall), true)
  assert.equal(second.owns(firstCall), false)
  first.internal.add('temporary')
  assert.equal(first.internal.has('temporary'), true)
  assert.equal(second.internal.has('temporary'), false)
  assert.equal(second.internal.has('slot'), true)
  first.value(firstCall)
  assert.equal(second.isValue(secondCall), false)
})

function operationCounts(code) {
  let functions = 0
  const calls = new Map()
  t.traverseFast(parse(code, { sourceType: 'module', allowReturnOutsideFunction: true }), node => {
    if (t.isFunction(node)) functions++
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
      const name = node.callee.property.name
      calls.set(name, (calls.get(name) ?? 0) + 1)
    }
  })
  return { functions, calls }
}

test('dynamic module helpers retain one native operation through unreachable eval adaptation', async t => {
  const body = 'function f(x){const y=x+1;return y};'
  const staticCode = compileStatefulModule(`${body}export{f}`).code
  const dynamicSource = `${body}if(false)eval('');export{f}`
  const dynamicCode = compileStatefulModule(dynamicSource).code
  const direct = operationCounts(staticCode)
  const dynamic = operationCounts(dynamicCode)
  assert.equal(dynamic.calls.get('beginInvocation') ?? 0, 0)
  assert.ok(dynamic.calls.get('expose') <= direct.calls.get('expose'))
  assert.ok(dynamic.functions < direct.functions * 3)
  assert.ok(dynamicCode.length < staticCode.length * 2)
  const module = await loadManagedSource(t, dynamicSource)
  const saved = module.f
  assert.equal(saved(3), 4)
  assert.equal(module.f, saved)
})

for (const staticOnly of [true, false]) test(`private transport calls preserve source arguments and value operations (${staticOnly ? 'static' : 'dynamic'})`, () => {
  const source = `const events=[];
    function f(value){events.push('call');return [this===receiver,value,f.caller===g]}
    const receiver={get method(){events.push('get');return f}};
    const payload={value:1};
    function key(){events.push('key');return 'method'}
    function g(){return receiver[key()](payload)}
    const result=storage.initialize(g());
    const copied=storage.v;
    return [result,copied===result,result[1]===payload,events]`
  const operations = []
  const storage = { v: undefined, initialize(value) { operations.push(this === storage); this.v = value; return value } }
  const runtime = createDynamicEnvironmentRuntime()
  const compiled = compileDynamicEnvironmentSource(source, { cell: {
    environmentName: 'environment', staticOnly, nativeRoot: true,
    bindings: [{ physicalName: 'storage', property: 'v', name: 'stored', kind: 'let' }],
  } })
  const privateCalls = []
  t.traverseFast(parse(compiled.code, { allowReturnOutsideFunction: true }), node => {
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee)
      && t.isIdentifier(node.callee.object, { name: 'storage' })) privateCalls.push(node)
  })
  assert.equal(privateCalls.length, 1)
  assert.equal(privateCalls[0].callee.property.name, 'initialize')
  assert.ok(t.isCallExpression(privateCalls[0].arguments[0]))
  const result = new Function('environment', 'storage', compiled.code)(runtime.environment(), storage)
  assert.deepEqual(result, [[true, { value: 1 }, true], true, true, ['key', 'get', 'call']])
  assert.deepEqual(operations, [true])
})

for (const staticOnly of [true, false]) test(`source initializer callbacks and accessor values retain invocation ownership (${staticOnly ? 'static' : 'dynamic'})`, () => {
  const source = `const initializer=()=>Function('return 7');
    const copied=reference().value;
    return [initializer()(),copied===original,reference().value.call(receiver)===receiver]`
  const original = function () { return this }
  const receiver = {}
  const reference = () => ({ value: original })
  const runtime = createDynamicEnvironmentRuntime()
  const compiled = compileDynamicEnvironmentSource(source, { cell: {
    environmentName: 'environment', staticOnly, nativeRoot: true, internalBindings: ['initializer'],
    bindings: [{ physicalName: 'initializer', role: 'source-initializer' },
      { physicalName: 'reference', name: 'value', accessor: true, reference: true, kind: 'let' }],
  } })
  const environment = runtime.environment({ nativeBindings: [
    ['original', { kind: 'const', get: () => original }], ['receiver', { kind: 'const', get: () => receiver }],
  ] })
  const result = new Function('environment', 'reference', 'original', 'receiver', compiled.code)(environment, reference, original, receiver)
  assert.deepEqual(result, [7, true, true])
})

for (const dynamic of [false, true]) test(`managed module source calls preserve value effects and receivers (${dynamic ? 'dynamic' : 'static'})`, async t => {
  const module = await loadManagedSource(t, `
    ${dynamic ? "if(false)eval('');" : ''}
    const events=[];
    const value={id:3};
    function selected(input){events.push('call');return [this===object,input===value]}
    const object={get method(){events.push('get');return selected}};
    export function run(){events.length=0;const saved=object.method;
      const result=object.method((events.push('arg'),value));return [result,saved===selected,events.slice()]}
    export {selected}`)
  const selected = module.selected
  assert.deepEqual(module.run(), [[true, true], true, ['get', 'get', 'arg', 'call']])
  assert.equal(module.selected, selected)
})
