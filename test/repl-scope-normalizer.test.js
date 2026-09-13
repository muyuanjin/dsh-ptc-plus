import assert from 'node:assert/strict'
import test from 'node:test'
import { lowerStatefulDecorators, normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { identitySourceMap } from '../internal/source-position-map.js'

function run(body) {
  return Function(normalizeStatefulScopes(`function example(){${body}} return example()`).code)()
}

test('production scope normalization preserves repeated declarations and pattern boundaries', () => {
  for (const [source, expected] of [
    ['let x=1; let x=2; let x=3; return x', 3],
    ['const x=1; const x=2; const x; let x; return x', 2],
    ['class D {m(){return 1}} class D {m(){return 2}}; return new D().m()', 2],
    ['let x=1; function x(){return 2}; return x()', 2],
    ['let C=1; class C {static value=3}; return C.value', 3],
    ['const [p,p=p+1]=[1,undefined]; return p', 2],
    ['const {a:p,b:p=p+1}={a:1}; return p', 2],
    ['let p=1; const [p,w]=[2,3]; return [p,w]', [2,3]],
    ['let f=()=>1\nlet {g:f}={g:2}; return f', 2],
    ['let [p]=[1]\nlet [p]=[2]; return p', 2],
    ['let x=0\nlet x=((y)=>y,2); return x', 2],
    ['let item=0\nlet [item]=(0,[7]); return item', 7],
    ['const a=1,x=2\nlet x=3; return [a,x]', [1,3]],
  ]) assert.deepEqual(run(source), expected, source)
})

test('production scopes keep guards, activation and nested ownership distinct', () => {
  for (const [source, expected] of [
    ['let x=1; if(false) var [x]=[2]; return x', 1],
    ['let x=1; while(false) var x=2; return x', 1],
    ['let x=1; if(false) var x=2,w=3; return [x,w]', [1,undefined]],
    ['let effects=0; if(false) var x=++effects,y=++effects; else effects=7; return [effects,x,y]', [7,undefined,undefined]],
    ['let effects=0; if(true) var x=++effects,y=++effects; else effects=7; return [effects,x,y]', [2,1,2]],
    ['let effects=0; while(effects<2) var x=++effects,y=++effects; return [effects,x,y]', [2,1,2]],
    ['function f(e){let e=2; return e}; return f(1)', 2],
    ['try {throw {e:1}} catch({e}) {let e=2; return e}', 2],
    ['try {throw 1} catch{}; let s=1; let s=2; return s', 2],
    ['let x=1; {let x=2}; return x', 1],
    ['let x=9; switch(2){case 1:let x=1;return x;case 2:let x=2;return x}', 2],
    ['switch(1){case 1:class C{m(){return 1}};return new C().m();case 2:class C{m(){return 2}};return new C().m()}', 1],
    ['const reads=[];for(let i=0;i<2;i++){let i=5;reads.push(()=>i)};return reads.map(f=>f())', [5,5]],
    ['let result;for(let i=0,i=1;i<2;i++){result=i};return result', 1],
  ]) assert.deepEqual(run(source), expected, source)
  assert.throws(() => normalizeStatefulScopes('const x=;'), SyntaxError)
})

test('resource fallback preserves the selected module goal when native syntax is unavailable', () => {
  const normalized = normalizeStatefulScopes(
    'export const events=[]; using resource={ [Symbol.dispose](){ events.push("disposed") } }; export {resource}',
    undefined, { target: 'module', nativeUsing: false })
  assert.match(normalized.code, /export \{/)
  assert.doesNotMatch(normalized.code, /exports\./)
  assert.match(normalized.code, /usingCtx/)
})

test('decorator lowering retains parser diagnostics for recovered invalid declarations', () => {
  const code = 'const value = 1;\nconst value = 2;\n@((value) => value) class Example {}'
  assert.throws(() => lowerStatefulDecorators({ code, sourceMap: identitySourceMap(code.length) }), error => {
    assert.equal(error.code, 'BABEL_PARSE_ERROR')
    assert.equal(error.reasonCode, 'VarRedeclaration')
    assert.equal(error.loc.line, 2)
    assert.equal(error.loc.column, 6)
    return true
  })
})
