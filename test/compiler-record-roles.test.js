import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { transformSync, types as t } from '@babel/core'
import { privateGeneratedRecords } from '../internal/compiler-record-roles.js'
import { captureCompilerIntrinsics } from '../internal/compiler-intrinsics.js'

function executeHelper(body, observer = 'function(record){return Object.getPrototypeOf(record)===Object.prototype}') {
  const result = transformSync(`function helper(expose){${body}}`, {
    babelrc: false, configFile: false,
    plugins: [() => ({
      pre(file) { t.removePropertiesDeep(file.ast) },
      post(file) {
        const records = privateGeneratedRecords(file)
        file.path.traverse({ ObjectExpression: { exit(path) {
          if (!records.has(path.node)) return
          path.replaceWith(t.callExpression(t.memberExpression(t.identifier('intrinsics'),t.identifier('record')),[path.node]))
          path.skip()
        } } })
      },
    })],
  })
  const realm = createContext()
  realm.intrinsics = captureCompilerIntrinsics(runInContext('Function',realm))
  return runInContext(`Object.defineProperty(Object.prototype,'state',{get(){return 'inherited'},set(){throw Error('source setter')}});
    ${result.code};helper(${observer})`,realm)
}

test('generated record aliases and bound state consumers retain private own-state semantics', () => {
  assert.equal(executeHelper(`const record={};let alias=record;alias=record;
    record.state=42;return function(ref){return ref.state}.bind(null,alias)()`),42)
  assert.equal(executeHelper(`const record={};const read=function(ref){return ref.state};
    record.state=42;return read.bind(null,record)()`),42)
  assert.equal(executeHelper(`const define=Object.defineProperty,record={value:42};
    const target={};define(target,'state',record);return target.state`),42)
})

test('unknown record consumers and publication preserve ordinary source-facing prototypes', () => {
  for (const body of [
    'const record={};return expose(record)',
    'const record={};let alias;return expose(alias=record)',
    'const record={};return function(...args){return expose(args[0])}.bind(null,record)()',
    'const record={};return expose.bind(null,record)()',
    'const record={};return (0,expose)(record)',
    'const record={};const target={record};return expose(target.record)',
  ]) assert.equal(executeHelper(body),true,body)
})

test('own accessors and receiver invocations cannot prove record privacy', () => {
  assert.equal(executeHelper('const record={get state(){return expose(this)}};return record.state'),true)
  assert.equal(executeHelper('const record={...expose};return record.state'), 'inherited')
  assert.equal(executeHelper('const record={[expose()]:42};return record.state', '()=>"key"'), 'inherited')
  for (const key of ['__proto__', '"__proto__"']) {
    assert.equal(executeHelper(`const record={${key}:expose};return record.state`), 'inherited')
  }
  for (const call of ['record.method()','record.method?.()','record.method``']) {
    assert.equal(executeHelper(`const record={method:expose};return ${call}`,
      'function(){return Object.getPrototypeOf(this)===Object.prototype}'),true,call)
  }
})
