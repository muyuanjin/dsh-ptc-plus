import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'

test('bounded declaration witnesses preserve ownership across parameters, bodies and sibling scopes', () => {
  for (const count of [1, 63, 64, 65, 130]) {
    const locals = Array.from({ length: count }, (_, i) => `let item${i}=${i};`).join('')
    const source = `let outside=7;
      function outer(value=(()=>{${locals}return item0+outside})()){
        ${locals}
        let read;
        try{throw 2}catch(caught){read=()=>caught+value}
        const object={[(function key(){let name='result';return name})()](){return read()}};
        class Example{field=(()=>{let local=3;return local+value})();method(){return this.field}}
        return [object.result(),new Example().method(),item${count - 1}]
      }
      return outer()`
    assert.deepEqual(Function(normalizeStatefulScopes(source).code)(), Function(source)())
  }
})
