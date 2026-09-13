import { managedModuleImport } from '../internal/stateful-module-runtime.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { compileStatefulModule, createUserModuleCompilationHooks } from '../internal/stateful-module-compiler.js'

async function graph(t, sources, root = 'consumer.mjs', { resolve } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-module-links-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all(Object.entries(sources).map(([name, source]) => writeFile(join(directory, name), source)))
  const url = pathToFileURL(join(directory, root)).href
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(url)
  const hook = registerHooks({ resolve: resolve === undefined ? compilation.resolve
    : (specifier, context, nextResolve) => compilation.resolve(specifier, context,
      (source, details) => resolve(source, details, nextResolve)), load: compilation.load })
  t.after(() => hook.deregister())
  return { module: await managedModuleImport(url, url), load: name => managedModuleImport(url, pathToFileURL(join(directory, name)).href) }
}

const provider = 'export let value = 1; export function change(next = 2) { value = next }'

test('type-only re-exports never load or evaluate their target modules', async t => {
  globalThis.__ptcTypeOnlyEffects = 0
  t.after(() => { delete globalThis.__ptcTypeOnlyEffects })
  const { module, load } = await graph(t, {
    'consumer.mjs': `export type * from './types.mjs';
      export type * as Types from './types.mjs'; export const answer=42`,
    'types.mjs': 'globalThis.__ptcTypeOnlyEffects++; export const value=1',
  })
  assert.deepEqual(Object.keys(module), ['answer'])
  assert.equal(module.answer, 42)
  assert.equal(globalThis.__ptcTypeOnlyEffects, 0)
  await load('types.mjs')
  assert.equal(globalThis.__ptcTypeOnlyEffects, 1)
})

test('cyclic consumers can call native-hoisted exported functions before provider evaluation', async t => {
  const { module } = await graph(t, {
    'consumer.mjs': `import { observed } from './reader.mjs'; export function answer(){return 42}; export { observed }`,
    'reader.mjs': `import { answer } from './consumer.mjs'; export const observed = answer()`,
  })
  assert.equal(module.observed, 42)
})

test('cyclic reads preserve exported lexical TDZ until initializer publication', async t => {
  await assert.rejects(graph(t, {
    'consumer.mjs': `import { read } from './reader.mjs'; export let value = read()`,
    'reader.mjs': `import { value } from './consumer.mjs'; export function read(){return value}`,
  }), ReferenceError)
})

test('anonymous default functions retain native names and identities during cyclic early reads', async t => {
  const { module } = await graph(t, {
    'consumer.mjs': `
      import { saved, observed } from './reader.mjs'; export { saved, observed };
      export default function (input = 1) { const value = input; const value = value + 1; return value }
    `,
    'reader.mjs': `
      import value from './consumer.mjs';
      export const saved = value;
      export const observed = [value.name, value.length, value()];
      export function replace(next) { value = next }
    `,
  })
  assert.equal(module.saved, module.default)
  assert.deepEqual(module.observed, ['default', 0, 2])
  assert.equal(module.default.prototype.constructor, module.default)
})

test('early functions retain native identity and resolve functions, vars, imports and local scopes', async t => {
  const { module } = await graph(t, {
    'state.mjs': 'export const effects = []; export function imported() { return 40 }',
    'consumer.mjs': `
      import { effects, imported } from './state.mjs';
      import { observed, saved } from './reader.mjs';
      export { observed, saved, effects };
      export var count;
      export function helper() { return imported() + 2 }
      export function inspect(fn = helper) {
        const local = fn(); const local = local + 1;
        return [fn, fn.name, fn.length, count, local, this, arguments.length, initializedVar];
      }
      effects.push('body');
      export const initialized = effects.push('initializer');
      export var initializedVar = (effects.push('var'), 9);
    `,
    'reader.mjs': `
      import { effects } from './state.mjs';
      import { inspect, helper } from './consumer.mjs';
      effects.push('reader');
      export const saved = helper;
      export const observed = inspect();
      if (effects.join(',') !== 'reader') throw new Error('early initializer');
    `,
  })
  assert.equal(module.saved, module.helper)
  assert.equal(module.observed[0], module.helper)
  assert.deepEqual(module.observed.slice(1), ['helper', 0, undefined, 43, undefined, 0, undefined])
  assert.equal(module.inspect.name, 'inspect')
  assert.equal(module.inspect.length, 0)
  assert.equal(module.helper.prototype.constructor, module.helper)
  assert.deepEqual(module.effects, ['reader', 'body', 'initializer', 'var'])
  assert.equal(module.initialized, 3)
  assert.equal(module.initializedVar, 9)
})

test('early writes survive provider evaluation and pure hoisted declarations do not reinstall old values', async t => {
  const { module } = await graph(t, {
    'provider.mjs': 'export let value = 1; export function change() { value = 2 }',
    'consumer.mjs': `
      import { value, change } from './provider.mjs';
      import { saved, replacement, observed } from './reader.mjs';
      export { value, change, saved, replacement, observed };
      export var count;
      export function helper() { return 1 }
      export function revise(next) { count = 7; value = 8; helper = next }
      export function read() { return [count, value, helper] }
      export const atBody = read();
    `,
    'reader.mjs': `
      import { helper, revise, read } from './consumer.mjs';
      export const saved = helper;
      export function replacement() { return 9 }
      revise(replacement);
      export const observed = read();
    `,
  })
  assert.deepEqual(module.observed, [7, 8, module.replacement])
  assert.deepEqual(module.atBody, module.observed)
  assert.equal(module.helper, module.replacement)
  assert.equal(module.saved(), 1)
  module.change()
  assert.deepEqual(module.read(), [7, 8, module.replacement])
  assert.equal(module.value, 8)
})

test('early lexical reads, typeof and writes preserve TDZ without running user initializers', async t => {
  const { module } = await graph(t, {
    'state.mjs': 'export const effects = []',
    'consumer.mjs': `
      import { effects } from './state.mjs';
      import { errors } from './reader.mjs';
      export { effects, errors };
      export function read() { return value }
      export function kind() { return typeof value }
      export function write() { value = 9 }
      export let value = (effects.push('value'), 3);
      export let bare;
      export class Current { static value = (effects.push('class'), value) }
    `,
    'reader.mjs': `
      import { effects } from './state.mjs';
      import * as source from './consumer.mjs';
      export const errors = [];
      for (const action of [source.read, source.kind, source.write, () => source.value,
        () => source.bare, () => source.Current]) {
        try { action(); errors.push('missing') } catch (error) { errors.push(error) }
      }
      if (effects.length !== 0) throw new Error('early initializer');
    `,
  })
  assert.equal(module.errors.length, 6)
  for (const error of module.errors) assert.ok(error instanceof ReferenceError)
  assert.deepEqual(module.effects, ['value', 'class'])
  assert.equal(module.value, 3)
  assert.equal(module.bare, undefined)
  assert.equal(module.Current.value, 3)
})

test('lexical pattern candidates remain private until their complete declarator commits', async t => {
  const { module } = await graph(t, {
    'consumer.mjs': `
      import { probe, errors } from './reader.mjs';
      export { errors };
      export const [first, second = (probe(), 2)] = [1];
      export const after = probe();
    `,
    'reader.mjs': `
      import { first, second } from './consumer.mjs';
      export const errors = [];
      export function probe() {
        const values = [];
        for (const read of [() => first, () => second]) {
          try { values.push(read()) } catch (error) { errors.push(error); values.push('tdz') }
        }
        return values;
      }
    `,
  })
  assert.equal(module.errors.length, 2)
  for (const error of module.errors) assert.ok(error instanceof ReferenceError)
  assert.deepEqual(module.after, [1, 2])
})

test('a failed cyclic declarator preserves prior commits, actual writes and escaped candidates', async t => {
  await assert.rejects(graph(t, {
    'consumer.mjs': `
      import { fail } from './reader.mjs';
      export var count;
      export function write() { count = 7; first = 3 }
      export const first = 1;
      export const [second, third = fail(() => second)] = [2];
    `,
    'reader.mjs': `
      import { count, first, second, third, write } from './consumer.mjs';
      export function fail(candidate) {
        write();
        const error = new Error('candidate failure');
        error.candidate = candidate;
        error.committed = () => [count, first];
        error.pending = [() => second, () => third];
        throw error;
      }
    `,
  }), error => {
    assert.equal(error.message, 'candidate failure')
    assert.equal(error.candidate(), 2)
    assert.deepEqual(error.committed(), [7, 3])
    for (const read of error.pending) assert.throws(read, ReferenceError)
    return true
  })
})

test('native hoisted async and generator functions retain names, identities and early parameter scopes', async t => {
  const { module } = await graph(t, {
    'consumer.mjs': `
      import { observed, saved } from './reader.mjs'; export { observed, saved };
      export function helper() { return 5 }
      export async function asyncValue(value = helper()) { return value }
      export function* generator(value = helper()) { yield value }
      export async function* asyncGenerator(value = helper()) { yield value }
    `,
    'reader.mjs': `
      import { asyncValue, generator, asyncGenerator } from './consumer.mjs';
      export const saved = [asyncValue, generator, asyncGenerator];
      export const observed = [await asyncValue(), generator().next().value,
        (await asyncGenerator().next()).value];
    `,
  })
  assert.deepEqual(module.observed, [5, 5, 5])
  assert.deepEqual(module.saved, [module.asyncValue, module.generator, module.asyncGenerator])
  assert.deepEqual(module.saved.map(fn => fn.name), ['asyncValue', 'generator', 'asyncGenerator'])
})

test('early partial assignment preserves only completed writes and keeps untouched import links', async t => {
  const { module } = await graph(t, {
    'provider.mjs': provider,
    'consumer.mjs': `
      import { value, value as second, change } from './provider.mjs';
      import { observed, failure } from './reader.mjs';
      export { value, second, change, observed, failure };
      export var count;
      export function write() {
        [count, value, second = (() => { throw new Error('partial') })()] = [6, 7];
      }
      export function read() { return [count, value, second] }
      export const atBody = read();
    `,
    'reader.mjs': `
      import { write, read } from './consumer.mjs';
      export let failure;
      try { write() } catch (error) { failure = error }
      export const observed = read();
    `,
  })
  assert.match(module.failure.message, /partial/)
  assert.deepEqual(module.observed, [6, 7, 1])
  assert.deepEqual(module.atBody, module.observed)
  module.change()
  assert.deepEqual(module.read(), [6, 7, 2])
  assert.deepEqual([module.value, module.second], [7, 2])
})

test('early functions can use private helpers and lexical errors with shadowed intrinsic names', async t => {
  const { module } = await graph(t, {
    'consumer.mjs': `
      import { observed } from './reader.mjs'; export { observed };
      export function inspect() {
        const Object = null; const Reflect = null; const ReferenceError = null;
        class Mixed {
          static #value() { return 3 }
          #value() { return 4 }
          read() { return [this.#value(), Mixed.#value(), this.#value.name] }
        }
        let failure;
        try { return missing } catch (error) { failure = error }
        const missing = 1;
        return [new Mixed().read(), failure];
      }
    `,
    'reader.mjs': `import { inspect } from './consumer.mjs'; export const observed = inspect()`,
  })
  assert.deepEqual(module.observed[0], [4, 3, '#value'])
  assert.ok(module.observed[1] instanceof ReferenceError)
})

test('early function class evaluation has initialized standard and legacy decorator helpers', async t => {
  const { module } = await graph(t, {
    'consumer.mjs': `
      import { observed } from './reader.mjs'; export { observed };
      export function inspect() {
        const effects = [];
        function standard(value, context) { effects.push(context.name); return value }
        function legacy(target, key, index) { effects.push(index) }
        const key = 'method';
        class Standard {
          @standard [key]() { return 1 }
          @standard [key]() { return 2 }
        }
        class Legacy { constructor(@legacy value) { this.value = value } }
        return [new Standard().method(), new Legacy(3).value, effects];
      }
    `,
    'reader.mjs': `import { inspect } from './consumer.mjs'; export const observed = inspect()`,
  })
  assert.deepEqual(module.observed, [2, 3, ['method', 'method', 0]])
})

test('a writable re-export follows builtin export updates until its actual override', async t => {
  const original = fs.readFile
  t.after(() => { fs.readFile = original; syncBuiltinESMExports() })
  const { module } = await graph(t, {
    'consumer.mjs': `import { readFile } from 'node:fs'; export { readFile }; export function read(){return readFile}; export function override(value){readFile=value}`,
  })
  const external = function external() {}
  fs.readFile = external
  syncBuiltinESMExports()
  assert.equal(module.readFile, external)
  assert.equal(module.read(), external)
  const local = function local() {}
  module.override(local)
  fs.readFile = original
  syncBuiltinESMExports()
  assert.equal(module.readFile, local)
  assert.equal(module.read(), local)
})

test('exported imports follow provider writes synchronously until an actual local override', async t => {
  const { module: consumer, load } = await graph(t, {
    'provider.mjs': provider,
    'consumer.mjs': `
      import { value, change } from './provider.mjs';
      export { value, change };
      export function override() { value = 7 }
      export function read() { return value }
    `,
  })
  assert.equal(consumer.value, 1)
  consumer.change()
  assert.deepEqual([consumer.value, consumer.read()], [2, 2])
  consumer.override()
  assert.deepEqual([consumer.value, consumer.read()], [7, 7])
  consumer.change(9)
  assert.deepEqual([consumer.value, consumer.read()], [7, 7])
  assert.equal((await load('provider.mjs')).value, 9)
  assert.equal(await load('consumer.mjs'), consumer)
  assert.equal(Object.getPrototypeOf(consumer), null)
  assert.equal(Object.isExtensible(consumer), false)
  assert.throws(() => { consumer.value = 12 }, TypeError)
})

test('native re-export chains and export stars propagate committed values into imported overrides', async t => {
  const { module: consumer } = await graph(t, {
    'provider.mjs': provider,
    'named.mjs': `export { value as renamed, change } from './provider.mjs'`,
    'star.mjs': `export * from './named.mjs'; export * from './named.mjs'`,
    'consumer.mjs': `
      import { renamed as value, change } from './star.mjs';
      export { value, change };
      export function override() { value = 7 }
      export function read() { return value }
    `,
  })
  consumer.change()
  assert.deepEqual([consumer.value, consumer.read()], [2, 2])
  consumer.override()
  consumer.change(3)
  assert.deepEqual([consumer.value, consumer.read()], [7, 7])
})

test('unwritten imported re-export aliases relay provider changes to an independently writable alias', async t => {
  const { module: consumer, load } = await graph(t, {
    'provider.mjs': provider,
    'relay.mjs': `import { value, change } from './provider.mjs'; export { value, change }`,
    'consumer.mjs': `
      import { value, value as second, change } from './relay.mjs';
      export { value, second, change };
      export function override() { value = 7 }
      export function overrideSecond() { second = 8 }
      export function read() { return [value, second] }
    `,
  })
  consumer.change()
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [2, 2, 2, 2])
  consumer.override()
  consumer.change(3)
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [7, 3, 7, 3])
  consumer.overrideSecond()
  consumer.change(4)
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [7, 8, 7, 8])
  assert.equal((await load('relay.mjs')).value, 4)
})

test('cycles link uninitialized providers without evaluating their imported values', async t => {
  const { module: source, load } = await graph(t, {
    'provider.mjs': `
      import { read } from './consumer.mjs';
      export { read };
      ${provider}
    `,
    'consumer.mjs': `
      import { value, change } from './provider.mjs';
      export { value, change };
      export function override() { value = 7 }
      export function read() { return value }
    `,
  }, 'provider.mjs')
  const consumer = await load('consumer.mjs')
  assert.deepEqual([source.value, consumer.value, source.read()], [1, 1, 1])
  source.change()
  assert.deepEqual([source.value, consumer.value, source.read()], [2, 2, 2])
  consumer.override()
  source.change(3)
  assert.deepEqual([source.value, consumer.value, source.read()], [3, 7, 7])
})

test('short-circuited and throwing writes retain links; partial assignment detaches only completed targets', async t => {
  const { module: consumer } = await graph(t, {
    'provider.mjs': provider,
    'consumer.mjs': `
      import { value, value as second, change } from './provider.mjs';
      export { value, second, change };
      export function shortCircuit() { value ||= 7; value ??= 8 }
      export function failRhs() { value = (() => { throw new Error('rhs') })() }
      export function partial() {
        [value, second] = [7, undefined].map((value, index) => value);
      }
      export function partialThrow() {
        [value, second = (() => { throw new Error('default') })()] = [7, undefined];
      }
      export function failDeclaration() {
        // This is a local declaration and must not shadow the module import.
        let value = (() => { throw new Error('declaration') })();
      }
      export function read() { return [value, second] }
    `,
  })
  consumer.shortCircuit()
  assert.throws(() => consumer.failRhs(), /rhs/)
  assert.throws(() => consumer.failDeclaration(), /declaration/)
  consumer.change()
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [2, 2, 2, 2])
  assert.throws(() => consumer.partialThrow(), /default/)
  consumer.change(3)
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [7, 3, 7, 3])
  consumer.partial()
  consumer.change(4)
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [7, undefined, 7, undefined])
})

test('a throwing provider write publishes completed assignment effects synchronously', async t => {
  const { module: consumer } = await graph(t, {
    'provider.mjs': `${provider}; export function fail() { value = 4; throw new Error('after write') }`,
    'consumer.mjs': `
      import { value, fail } from './provider.mjs';
      export { value, fail };
      export function override() { value = 7 }
      export function read() { return value }
    `,
  })
  assert.throws(() => consumer.fail(), /after write/)
  assert.deepEqual([consumer.value, consumer.read()], [4, 4])
})

test('native builtins keep live no-write re-exports and preserve namespace identity', async t => {
  const original = fs.readFile
  t.after(() => { fs.readFile = original; syncBuiltinESMExports() })
  const { module: consumer } = await graph(t, {
    'relay.mjs': `export * from 'node:fs'`,
    'consumer.mjs': `
      import { readFile } from './relay.mjs';
      import * as namespace from 'node:fs';
      export { readFile, namespace };
      export function read() { return readFile }
    `,
  })
  const next = function replacement() {}
  fs.readFile = next
  syncBuiltinESMExports()
  assert.equal(consumer.readFile, next)
  assert.equal(consumer.read(), next)
  assert.equal(consumer.namespace, await import('node:fs'))
})

test('prepared data roots subscribe through the same native URL identity as loaded modules', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-prepared-links-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const providerUrl = pathToFileURL(join(directory, 'provider.mjs')).href
  await writeFile(join(directory, 'provider.mjs'), provider)
  const source = `import { value, change } from ${JSON.stringify(providerUrl)};
    export { value, change }; export function override() { value = 7 }; export function read() { return value }`
  const prepared = compileStatefulModule(source)
  const rootUrl = `data:text/javascript,${encodeURIComponent(prepared.code)}#prepared`
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(rootUrl, { compiled: true, moduleInterface: prepared.moduleInterface })
  const hooks = registerHooks({ resolve: compilation.resolve, load: compilation.load })
  t.after(() => hooks.deregister())
  const consumer = await managedModuleImport(rootUrl, rootUrl)
  consumer.change()
  assert.deepEqual([consumer.value, consumer.read()], [2, 2])
  assert.equal(await managedModuleImport(rootUrl, rootUrl), consumer)
})

test('export stars in cycles enumerate names without reading uninitialized values', async t => {
  const { module: source, load } = await graph(t, {
    'provider.mjs': `import './consumer.mjs'; ${provider}; export default 99`,
    'star.mjs': `export * from './provider.mjs'`,
    'consumer.mjs': `
      import { value } from './star.mjs'; export { value };
      export function override() { value = 7 }
      export function read() { return value }
    `,
  }, 'provider.mjs')
  const consumer = await load('consumer.mjs')
  source.change()
  assert.deepEqual([consumer.value, consumer.read()], [2, 2])
  assert.equal(Object.hasOwn(await load('star.mjs'), 'default'), false)
})

test('explicit exports take precedence over stars while native ambiguity remains a linker error', async t => {
  const { module: consumer } = await graph(t, {
    'provider.mjs': provider,
    'other.mjs': 'export let value = 9',
    'star.mjs': `export * from './other.mjs'; export { value, change } from './provider.mjs'`,
    'consumer.mjs': `
      import { value, change } from './star.mjs'; export { value, change };
      export function override() { value = 7 }
    `,
  })
  consumer.change()
  assert.equal(consumer.value, 2)
  await assert.rejects(graph(t, {
    'provider.mjs': provider,
    'other.mjs': 'export let value = 9',
    'star.mjs': `export * from './other.mjs'; export * from './provider.mjs'`,
    'consumer.mjs': `import { value } from './star.mjs'; export { value }`,
  }), /conflicting star exports/)
})

test('the last repeated static import owns the link without clearing either module cache', async t => {
  const { module: consumer, load } = await graph(t, {
    'provider.mjs': provider,
    'last.mjs': 'export let value = 10; export function change() { value = 11 }',
    'consumer.mjs': `
      import { value } from './provider.mjs';
      import { value, change } from './last.mjs';
      export { value, change }; export function override() { value = 7 }
      export function read() { return value }
    `,
  })
  assert.deepEqual([consumer.value, consumer.read()], [10, 10])
  ;(await load('provider.mjs')).change()
  assert.deepEqual([consumer.value, consumer.read()], [10, 10])
  consumer.change()
  assert.deepEqual([consumer.value, consumer.read()], [11, 11])
  consumer.override()
  assert.deepEqual([consumer.value, consumer.read()], [7, 7])
})

test('namespace import overrides preserve the original object and update native exported aliases', async t => {
  const { module: consumer, load } = await graph(t, {
    'provider.mjs': provider,
    'consumer.mjs': `
      import * as namespace from './provider.mjs';
      export { namespace, namespace as alias };
      export function override(next) { namespace = next }
      export function read() { return namespace }
    `,
  })
  const original = await load('provider.mjs')
  assert.equal(consumer.namespace, original)
  const next = { value: 7 }
  consumer.override(next)
  original.change()
  assert.equal(original.value, 2)
  assert.equal(consumer.namespace, next)
  assert.equal(consumer.alias, next)
  assert.equal(consumer.read(), next)
})

test('loop writes detach only aliases whose iteration assignment actually executes', async t => {
  const { module: consumer } = await graph(t, {
    'provider.mjs': provider,
    'consumer.mjs': `
      import { value, value as second, change } from './provider.mjs';
      export { value, second, change };
      export function empty() { for (value of []) {} }
      export function override() { for ([value] of [[7]]) {} }
      export function overrideSecond() { for (second in { eight: true }) {} }
      export function read() { return [value, second] }
    `,
  })
  consumer.empty()
  consumer.change()
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [2, 2, 2, 2])
  consumer.override()
  consumer.change(3)
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [7, 3, 7, 3])
  consumer.overrideSecond()
  consumer.change(4)
  assert.deepEqual([consumer.value, consumer.second, ...consumer.read()], [7, 'eight', 7, 'eight'])
})

test('source links use the native resolver URL for each distinct import attribute set', async t => {
  const { module: consumer, load } = await graph(t, {
    'first.mjs': provider,
    'second.mjs': 'export let value = 10; export function change() { value = 11 }',
    'relay.mjs': `export { value as remote } from './choice' with { flavor: 'first' };
      export * from './choice' with { flavor: 'second' }`,
    'consumer.mjs': `
      import { value as first } from './choice' with { flavor: 'first' };
      import { value as second } from './choice' with { flavor: 'second' };
      import { remote } from './relay.mjs';
      export { first, second, remote };
      export function override() { first = 7; second = 8; remote = 9 }
      export function read() { return [first, second, remote] }
    `,
  }, 'consumer.mjs', {
    resolve(specifier, context, nextResolve) {
      if (specifier !== './choice') return nextResolve(specifier, context)
      return { ...nextResolve(`./${context.importAttributes.flavor}.mjs`, {
        ...context, importAttributes: {},
      }), importAttributes: {} }
    },
  })
  assert.deepEqual([consumer.first, consumer.second, consumer.remote, ...consumer.read()], [1, 10, 1, 1, 10, 1])
  ;(await load('first.mjs')).change()
  ;(await load('second.mjs')).change()
  assert.deepEqual([consumer.first, consumer.second, consumer.remote, ...consumer.read()], [2, 11, 2, 2, 11, 2])
  assert.equal((await load('relay.mjs')).value, 11)
  consumer.override()
  assert.deepEqual([consumer.first, consumer.second, consumer.remote, ...consumer.read()], [7, 8, 9, 7, 8, 9])
})
