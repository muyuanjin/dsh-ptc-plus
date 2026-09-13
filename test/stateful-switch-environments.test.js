import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

function session(t, bindingUpdates) {
  const runtime = new SessionRuntime({ bindingUpdates })
  t.after(() => runtime.dispose())
  let sequence = 0
  return async source => {
    const result = await runtime.run(`switch-environment-${sequence++}`, { program: source, bindings: [] })
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    return result.value
  }
}

const discriminants = [
  'x', '(()=>x)()', '(function(){return x})()', '(function(value=x){return value})()',
  'eval("x")', '(()=>eval("x"))()', '(function(value=eval("x")){return value})()',
  'new class {value=x}().value', 'new class {value=eval("x")}().value',
  '(class {static value=x}).value', '(class {static value;static{this.value=eval("x")}}).value',
  '(class {[x](){return 1}}).prototype[1]()', '({[x](){return x}})[1]()',
  '(class extends (x===1?Object:Array){}).prototype instanceof Object?1:0',
]

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`${bindingUpdates} switch discriminants retain outer bindings across callable and class creation`, async t => {
    const run = session(t, bindingUpdates)
    for (const discriminant of discriminants) {
      const source = `let x=1;switch(${discriminant}){case 1:let x=2;return x}return 0`
      const expected = Function(source)()
      assert.deepEqual(await run(source), expected, discriminant)
      assert.deepEqual(await run(`return (function(){${source}})()`), expected, discriminant)
    }
  })

  test(`${bindingUpdates} discriminant closures keep outer state while cases retain their lexical scope`, async t => {
    const run = session(t, bindingUpdates)
    const sources = [
      `let x=1,read,write;switch((read=()=>x,write=value=>x=value,x)){
        case 1:let x=2;write(3);return [x,read()]}`,
      `let x=1,read;switch((read=()=>eval('x'),x)){case 1:let x=2;x=3;}x=4;return read()`,
      `let x=1;switch((()=>{let x=3;return x})()){case 3:let x=2;return x}`,
      `let x=1;switch((()=>{switch((()=>x)()){case 1:let x=2;return x}})()){
        case 2:let x=3;switch((()=>x)()){case 3:let x=4;return x}}`,
      `let x=1;try{switch(x){case x:let x=2;return x}}catch(error){return error.name}`,
      `let x=1;const effects=[];switch((effects.push('discriminant'),(()=>x)())){
        case (effects.push('test'),1):let x=2;effects.push(x);
        default:effects.push(x);break}return effects`,
      `let x=1;outer:for(let i=0;i<2;i++){selected:switch((()=>x)()){
        case 1:let x=2;if(i===0)continue outer;break selected;}return i}`,
      `let f=()=>1;switch((()=>f())()){case 1:function f(){return 2}return f()}`,
      `let x=1;switch((()=>x=3)()){case 3:let x=2;}return x`,
      `let x=1;switch((()=>{let [x,y=x]=[3];return y})()){case 3:let x=2;return x}`,
    ]
    for (const source of sources) assert.deepEqual(await run(source), Function(source)(), source)
  })

  test(`${bindingUpdates} dynamic compilation uses switch source environments`, async t => {
    const run = session(t, bindingUpdates)
    for (const discriminant of ['(()=>x)()', 'eval("x")', '(()=>eval("x"))()', 'new class {value=eval("x")}().value']) {
      const source = `let x=1;switch(${discriminant}){case 1:let x=2;return x}`
      assert.deepEqual(await run(`return eval(${JSON.stringify(`(function(){${source}})()`)});`), 2, discriminant)
      assert.deepEqual(await run(`return Function(${JSON.stringify(source)})()`), 2, discriminant)
    }
    const moduleSource = `export let x=1;export let result;switch((()=>eval('x'))()){
      case 1:let x=2;result=x;}`
    const url = `data:text/javascript,${encodeURIComponent(moduleSource)}`
    assert.deepEqual(await run(`const result=await import(${JSON.stringify(url)});return [result.x,result.result]`), [1,2])
  })
}

test('switch discriminants preserve suspension, once-only effects and statement completion', async t => {
  const run = session(t, 'stateful')
  assert.deepEqual(await run(`let x=1;const effects=[];switch(await(async()=>{
    effects.push('await');return x})()){case 1:let x=2;effects.push(x)}return effects`), ['await',2])
  assert.deepEqual(await run(`function* f(){let x=1;switch(yield(()=>x)()){
    case 3:let x=2;return x}}const iterator=f();return [iterator.next().value,iterator.next(3).value]`), [1,2])
  assert.equal(await run(`eval('let x=1;switch((()=>x)()){case 1:let x=2;x}')`), 2)
  assert.equal(await run(`eval('let x=1;switch((()=>x)()){case 9:let x=2;x}')===undefined`), true)
})
