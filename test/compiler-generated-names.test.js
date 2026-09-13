import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@babel/parser'
import traverseImport, { Scope } from '@babel/traverse'
import { withGeneratedNameAllocator } from '../internal/compiler-generated-names.js'
import { createGeneratedNameAllocator } from '../internal/binding-pattern.js'
import { prepareProgram } from '../internal/cell-analysis.js'
import { loadManagedSource } from './managed-module-fixture.js'

const traverse = traverseImport.default ?? traverseImport

test('generated names reserve Babel identifiers and restore the scope method after nested failures', () => {
  const tree = parse('let __dsh_ptc_native_temporary_0__=1;')
  const allocate = createGeneratedNameAllocator(tree)
  traverse(tree, { Program(path) {
    const scope = path.scope, original = scope.generateUid
    const names = []
    withGeneratedNameAllocator(scope, allocate, () => {
      names.push(scope.generateUidIdentifier('temporary').name)
      const outer = Object.getOwnPropertyDescriptor(scope, 'generateUid')
      assert.throws(() => withGeneratedNameAllocator(scope, allocate, () => {
        names.push(scope.generateUidIdentifierBasedOnNode(tree.program.body[0].declarations[0].id).name)
        throw Error('transform failed')
      }), /transform failed/)
      assert.deepEqual(Object.getOwnPropertyDescriptor(scope, 'generateUid'), outer)
    })
    assert.equal(scope.generateUid, original)
    assert.equal(Object.hasOwn(scope, 'generateUid'), false)
    assert.equal(new Set(names).size, 2)
    assert.ok(!names.includes('__dsh_ptc_native_temporary_0__'))
    for (const name of names) {
      assert.equal(scope.uids[name], true)
      assert.equal(scope.references[name], true)
    }
    path.stop()
  } })
})

test('optional-chain preparation does not traverse an entire scope once per temporary', t => {
  let renames = 0
  const rename = Scope.prototype.rename
  t.mock.method(Scope.prototype, 'rename', function (...args) {
    renames++
    return Reflect.apply(rename, this, args)
  })
  const source = 'const value={method(){return 42}};' + 'value?.method();'.repeat(100)
  assert.equal(typeof prepareProgram(source, { languageSemantics: 'stateful-v1' }).code, 'string')
  assert.equal(renames, 0)
})

test('optional-chain temporaries stay distinct across module regions and nested source scopes', async t => {
  const source = `let __ptc$0=40,__dsh_ptc_native_temporary_0__=2;
    const values=[];
    const receiver={base:40,method(value){return this.base+value},tag(parts,value){return this.base+value}};
    function collect(value){const absent=null;
      ${'values.push(receiver?.method(value));absent?.method(values.push(0));'.repeat(120)}
      function nested(){return (receiver?.tag)\`answer: \${value}\`}
      return [nested(),__ptc$0+__dsh_ptc_native_temporary_0__]
    }
    export const result=[collect(2),values.length,values.every(value=>value===42)]`
  const module = await loadManagedSource(t, source)
  assert.deepEqual(module.result, [[42,42],120,true])
})
