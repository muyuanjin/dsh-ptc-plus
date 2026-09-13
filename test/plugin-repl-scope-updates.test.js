import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './plugin-fixture.js'

/**
 * The stateful cell language reads a repeated declaration in one logical scope
 * as an update of one identity.  Native JavaScript rejects those groups as an
 * early error, so the preparation has to recover the declaration structure
 * before anything else can lower it.
 */

function session(t, config = {}) {
  const state = fixture({ bindingUpdates: 'stateful', ...config })
  t.after(() => state.dispose())
  return async (id, code) => {
    const result = await state.run(id, code)
    if (result.error !== undefined) return { error: result.error.message }
    return { value: result.value }
  }
}

test('keeps the value of repeated declarations in one cell', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('same-cell-lexical', 'let item = 1\nlet item = 2\nreturn item'), { value: 2 })
  assert.deepEqual(await run('same-cell-const', 'const first = 1\nconst first = 2\nreturn first'), { value: 2 })
  assert.deepEqual(await run('same-cell-mixed', 'let item = 1\nvar item = 2\nreturn item'), { value: 2 })
  assert.deepEqual(await run('same-cell-class', 'class Box { tag() { return 1 } }\nclass Box { tag() { return 2 } }\nreturn new Box().tag()'), { value: 2 })
  assert.deepEqual(await run('same-cell-function-lexical', 'function pick() { return 1 }\nlet pick = 2\nreturn pick'), { value: 2 })
})

test('keeps native hoisting for a group of function declarations', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('function-group', 'function pick() { return 1 }\nconst before = pick()\nfunction pick() { return 2 }\nreturn [before, pick()]'),
    { value: [2, 2] })
})

test('keeps nested scopes separate and updates the identity each one owns', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('nested-scopes',
    'const x = 10\nfunction f() {\n  const x = 1\n  const x = 2\n  { let x = 3; let x = 4 }\n  return x\n}\nreturn [x, f()]'),
    { value: [10, 2] })
  assert.deepEqual(await run('nested-block', '{ let outside = 1; let outside = 2; return outside }'), { value: 2 })
  assert.deepEqual(await run('loop-shadow', 'let out = 0\nfor (let i = 0; i < 1; i++) { let i = 5; out = i }\nreturn out'), { value: 5 })
  assert.deepEqual(await run('switch-scope', 'let r = 0\nswitch (1) { case 1: let s = 1; r = s; break; case 2: let s = 2; r = s }\nreturn r'),
    { value: 1 })
  // Only the clause control flow enters runs its initializer, so a later clause
  // must still reach the identity the declaration group established.
  assert.deepEqual(await run('switch-other-clause', 'let r = 0\nswitch (2) { case 1: let s = 1; r = s; break; case 2: let s = 2; r = s }\nreturn r'),
    { value: 2 })
  assert.deepEqual(await run('switch-fallthrough', 'let r = 0\nswitch (1) { case 1: let f = 1; case 2: let f = 2; r = f }\nreturn r'),
    { value: 2 })
  // The hoisted declaration stays inside the block that wraps the switch, so it
  // does not become a name the rest of the cell or a later cell can read.
  assert.deepEqual(await run('switch-scope-confined', 'switch (2) { case 1: let v = 1; break; case 2: let v = 2; break }\nreturn typeof v'),
    { value: 'undefined' })
  assert.match((await run('switch-scope-confined', 'return v')).error, /PTC-/)
  assert.deepEqual(await run('switch-outer-shadow', 'let v = 9\nlet out = 0\nswitch (2) { case 1: let v = 1; out = v; break; case 2: let v = 2; out = v }\nreturn [out, v]'),
    { value: [2, 9] })
})

test('updates the identity a parameter or catch binding established', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('parameter-body', 'function f(e) { let e = 2; return e }\nreturn f(1)'), { value: 2 })
  assert.deepEqual(await run('parameter-default', 'function f(e = 1) { var e = 2; return e }\nreturn f(9)'), { value: 2 })
  assert.deepEqual(await run('catch-body', 'let out = 0\ntry { throw new Error("x") } catch (e) { let e = 2; out = e }\nreturn out'),
    { value: 2 })
  // An optional catch binding names nothing, and must not disturb a cell that
  // needs normalization elsewhere.
  assert.deepEqual(await run('optional-catch', "const o = { m() { try {} catch {} return 1 } }\nlet s = 1; let s = 2\nreturn s"),
    { value: 2 })
  assert.deepEqual(await run('optional-catch-same', "try { throw new Error('e') } catch { let t = 1; let t = 2; return t }"),
    { value: 2 })
})

test('resolves a hoisted var against the lexical declaration of its statement list', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('function-var', 'function f() { let z = 1; { var z = 2 } return z }\nreturn f()'), { value: 2 })
  assert.deepEqual(await run('root-var', 'let w = 1\n{ var w = 2 }\nreturn w'), { value: 2 })
  assert.deepEqual(await run('boundary-crossing',
    'function f() { { var z = 2 } let z = 1; return z }\nreturn [f(), typeof z]'), { value: [1, 'undefined'] })
  assert.deepEqual(await run('loop-head', 'for (const i of [1]) { var i = 2 }\nreturn "ran"'), { value: 'ran' })
  assert.deepEqual(await run('loop-head', 'for (const k in { a: 1 }) { var k = 2 }\nreturn "ran"'), { value: 'ran' })
})

test('keeps the earlier candidate readable for later pattern defaults', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('pattern-default', 'const [item, item = item + 1] = [1, undefined]\nreturn item'), { value: 2 })
  assert.deepEqual(await run('pattern-plain', 'const [first, first] = [1, 2]\nreturn first'), { value: 2 })
  assert.deepEqual(await run('pattern-mixed', 'const [kept, fresh] = [1, 2]\nreturn [kept, fresh]'), { value: [1, 2] })
  // An object pattern is only a valid assignment target in parentheses, and the
  // parentheses have to enclose the whole assignment.
  assert.deepEqual(await run('pattern-object', 'const { a: item, b: item } = { a: 1, b: 2 }\nreturn item'), { value: 2 })
  assert.deepEqual(await run('pattern-object-default',
    'const { a: item, b: item = item + 1 } = { a: 1, b: undefined }\nreturn item'), { value: 2 })
  assert.deepEqual(await run('pattern-object-two',
    'const { a: item } = { a: 1 }\nconst { b: item } = { b: 2 }\nreturn item'), { value: 2 })
})

test('keeps the alias readable before the declaration that replaces it', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('alias-before-declaration',
    "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  // The replacement installs the local value at its own position, so a read that
  // happens earlier still reads what the module supplies.
  assert.deepEqual(await run('alias-before-declaration',
    "const before = item('/a/b')\nfunction item() { return 'x' }\nreturn [before, item()]"), { value: ['b', 'x'] })

  const silent = session(t)
  assert.deepEqual(await silent('alias-before-arrow',
    "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await silent('alias-before-arrow',
    'let f = () => 1\nlet { g: f } = { g: 2 }\nreturn typeof f'), { value: 'number' })

  const variable = session(t)
  assert.deepEqual(await variable('alias-before-variable',
    "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await variable('alias-before-variable',
    'const kind = typeof item\nvar item = 4\nreturn [kind, item]'), { value: ['function', 4] })

  const shadow = session(t)
  assert.deepEqual(await shadow('alias-shadow',
    "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await shadow('alias-shadow',
    'const local = () => { const item = 1; return item }\nfunction item() { return 2 }\nreturn [local(), item()]'),
  { value: [1, 2] })
})

test('keeps a repeated pattern target consistent with the statement before it', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('pattern-after-statement', 'let [p] = [1]\nlet [p] = [2]\nreturn p'), { value: 2 })
  assert.deepEqual(await run('pattern-after-var', 'var q = 0\nlet [q] = [7]\nreturn q'), { value: 7 })
  assert.deepEqual(await run('pattern-pair', 'let [a, b] = [1, 2]\nlet [a, b] = [3, 4]\nreturn [a, b]'), { value: [3, 4] })
})

test('keeps an alias a cell only instantiates as a hoisted var', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('hoisted-alias', "import { basename as a } from 'node:path'\nreturn a('/x/y')"), { value: 'y' })
  assert.deepEqual(await run('hoisted-alias', 'if (false) { var a = 1, b = 2 }\nreturn [typeof a, typeof b]'),
    { value: ['function', 'undefined'] })
  assert.deepEqual(await run('hoisted-alias', "return [a('/x/z'), b === undefined]"), { value: ['z', true] })
})

test('commits a repeated pattern target to the same identity as its import alias', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('alias-pattern-repeat',
    "import { basename as item } from 'node:path'\nconst savedItem = item; const readItem = () => item\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await run('alias-pattern-repeat', "const [item, item] = ['a', 'b']\nreturn [item, readItem(), savedItem('/a/c')]"),
    { value: ['b', 'b', 'c'] })
  assert.deepEqual(await run('alias-pattern-repeat', 'return readItem()'), { value: 'b' })
  assert.deepEqual(await run('alias-pattern-same-cell',
    "import { basename as item } from 'node:path'\nconst savedItem = item; const readItem = () => item\nconst [item, item] = ['a', 'b']\nreturn [item, readItem(), savedItem('/a/c')]"),
    { value: ['b', 'b', 'c'] })
})

test('updates repeated loop declarations within the loop activation', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('loop-declaration-group',
    'const visited = []; for (let i = 0, i = 1; i < 3; i++) visited.push(i)\nreturn [visited, typeof i]'),
    { value: [[1, 2], 'undefined'] })
  assert.deepEqual(await run('loop-declaration-group', 'const i = 7; return i'), { value: 7 })
})

test('keeps a same-cell update working across cells', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('cross-cell', 'let total = 1\nlet total = 2\nreturn total'), { value: 2 })
  assert.deepEqual(await run('cross-cell', 'total = total + 1\nreturn total'), { value: 3 })
  assert.deepEqual(await run('cross-cell', 'let total = 10\nreturn total'), { value: 10 })
})

test('publishes only initialized lexicals while retaining actual var instantiation', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('unexecuted', 'if (true) { return 1 }\nconst pending = 5'), { value: 1 })
  assert.deepEqual(await run('unexecuted', 'return typeof pending'), { value: 'undefined' })
  assert.deepEqual(await run('unexecuted', 'const pending = 6\nreturn pending'), { value: 6 })

  const hoisted = session(t)
  assert.deepEqual(await hoisted('unexecuted-var', 'if (true) { return 1 }\nvar hoisted = 5'), { value: 1 })
  assert.deepEqual(await hoisted('unexecuted-var', 'return [typeof hoisted, hoisted === undefined]'), { value: ['undefined', true] })
})

test('replaces root class, function and var identities with import sources', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('root-class', 'class Marker { static tag = "class" }\nconst savedMarker = Marker; const readMarker = () => Marker\nreturn Marker.tag'),
    { value: 'class' })
  assert.deepEqual(await run('root-class', "import { basename as Marker } from 'node:path'\nreturn [Marker('/a/b'), readMarker() === Marker, savedMarker.tag]"),
    { value: ['b', true, 'class'] })
  assert.deepEqual(await run('root-class', 'class Marker { static tag = "updated" }\nreturn [readMarker().tag, savedMarker.tag]'),
    { value: ['updated', 'class'] })

  const globals = session(t)
  assert.deepEqual(await globals('root-global', 'function marker() { return "fn" }\nreturn marker()'), { value: 'fn' })
  assert.deepEqual(await globals('root-global', 'var other = 1\nreturn other'), { value: 1 })
  assert.deepEqual(await globals('root-global', "import { basename as marker } from 'node:path'\nreturn marker('/a/b')"), { value: 'b' })
  assert.deepEqual(await globals('root-global', "import { basename as other } from 'node:path'\nreturn other('/a/b')"), { value: 'b' })
})

test('assigns a repeated alias take-over one commit per name', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('multi-alias', "import { basename as a, dirname as b } from 'node:path'\nreturn [a('/x/y'), b('/x/y')]"),
    { value: ['y', '/x'] })
  assert.deepEqual(await run('multi-alias', "let survivor = 'keep'\nreturn survivor"), { value: 'keep' })
  assert.deepEqual(await run('multi-alias', 'if (true) { var a = 1, b = 2 }\nreturn [a, b]'), { value: [1, 2] })
  assert.deepEqual(await run('multi-alias', 'return survivor'), { value: 'keep' })
})

test('keeps a function-local or static-block var out of the cell root', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('local-var', "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await run('local-var', "'use strict'; function f() { var item = 1; return item }\nreturn f()"), { value: 1 })
  assert.deepEqual(await run('local-var', "return item('/a/c')"), { value: 'c' })
  assert.deepEqual(await run('sloppy-local-var', "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await run('sloppy-local-var', "function f() { var item = 1; return item }\nreturn [f(), item('/a/c')]"),
    { value: [1, 'c'] })
  assert.deepEqual(await run('static-var', "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await run('static-var', 'class Holder { static { var item = 1 } }\nreturn "ok"'), { value: 'ok' })
})

test('keeps the guard of a declaration written as a single-statement body', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('guarded-body', 'let x = 1\nif (false) var [x] = [2]\nreturn x'), { value: 1 })
  assert.deepEqual(await run('guarded-body-else', 'let x = 1\nif (true) {} else var { a: x } = { a: 2 }\nreturn x'), { value: 1 })
  assert.deepEqual(await run('guarded-body-while', 'let x = 1\nwhile (false) var [x] = [2]\nreturn x'), { value: 1 })
  assert.deepEqual(await run('guarded-body-do', 'let x = 1\ndo var [x] = [2]; while (false)\nreturn x'), { value: 2 })
  assert.deepEqual(await run('guarded-body-multi', 'let x = 1\nif (false) var x = 2, w = 3\nreturn [x, typeof w]'),
    { value: [1, 'undefined'] })
  assert.deepEqual(await run('guarded-body-taken', 'let x = 1\nif (true) var [x] = [2]\nreturn x'), { value: 2 })
})

test('keeps the grouping of a parenthesized initializer', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('grouped-initializer', 'let item = 0\nconst [item, fresh] = ((x => x)([3, 4]), [1, 2])\nreturn [item, fresh]'),
    { value: [1, 2] })
  assert.deepEqual(await run('grouped-identifier', 'let x = 0\nlet x = ((y => y)([3, 4]), [1, 2])\nreturn x'), { value: [1, 2] })
  assert.deepEqual(await run('grouped-object', 'let item = 0\nconst { a: item } = (0, { a: 7 })\nreturn item'), { value: 7 })
})

test('updates root identities from loop-head var declarations', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('loop-head-var', 'let x = 10\nfor (var x = 0; x < 1; x++) {}\nreturn x'), { value: 1 })
  assert.deepEqual(await run('loop-head-var', 'return x'), { value: 1 })
  assert.deepEqual(await run('loop-head-in', 'let x = 1\nfor (var x in {}) {}\nreturn x'), { value: 1 })
  assert.deepEqual(await run('loop-head-in', 'for (var x in { chosen: true }) {}\nreturn x'), { value: 'chosen' })
})

test('keeps a nested declaration in its own scope', async (t) => {
  const run = session(t)
  // A function declaration written as a single-statement body owns its own
  // binding, so the branch does not replace the enclosing name.
  assert.deepEqual(await run('annex-b-body', 'let f = 1\nif (true) function f() { return 2 }\nreturn f'), { value: 1 })
  assert.deepEqual(await run('annex-b-untaken', 'let g = 1\nif (false) function g() { return 2 }\nreturn typeof g'), { value: 'number' })
  // A labelled declaration shares the enclosing identity and updates it at its
  // declaration position when mixed with an earlier lexical declaration.
  assert.deepEqual(await run('labelled-function',
    'let h = 1\nconst beforeWasOne = h === 1; const readH = () => h\nlab: function h() { return 2 }\nreturn [beforeWasOne, h(), readH() === h]'),
    { value: [true, 2, true] })
  assert.deepEqual(await run('labelled-function', 'return readH()()'), { value: 2 })
  assert.deepEqual(await run('labelled-function', 'const h = 3; return [h === 3, readH() === h]'),
    { value: [true, true] })
})

test('allows local const updates independently of neighboring redeclarations', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('const-sibling',
    'function f() { const a = 1, x = 2\nlet x = 3\na = 9\nreturn [a, x] }\nreturn f()'), { value: [9, 3] })
  assert.deepEqual(await run('const-sibling-baseline',
    'function f() { const a = 1, x = 2; a = 9; return [a, x] }\nreturn f()'), { value: [9, 2] })
})

test('updates a directly named default declaration through the root binding it replaces', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('default-takeover', 'let __default = 1\nreturn __default'), { value: 1 })
  assert.deepEqual(await run('default-takeover', 'export default 2\nreturn __default'), { value: 2 })
  assert.deepEqual(await run('default-takeover', "function __default() { return 'fn' }\nreturn __default()"), { value: 'fn' })
})

test('keeps the generator marker when a comment follows it', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('generator-comment', "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await run('generator-comment', 'function* /* gen */ item() { yield 1 }\nreturn [...item()]'), { value: [1] })
})

test('does not refuse a later take-over because a bare declaration was dropped', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('bare-declaration', "import { basename as item } from 'node:path'\nreturn item('/a/b')"), { value: 'b' })
  assert.deepEqual(await run('bare-declaration', "let item;\nreturn 'kept'"), { value: 'kept' })
  assert.deepEqual(await run('bare-declaration', 'var item = 4\nreturn item'), { value: 4 })
})

test('gates a mixed-pattern alias take-over on the write that produced it', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('mixed-alias', "import { inspect as imported } from 'node:util'\nreturn typeof imported"), { value: 'function' })
  assert.deepEqual(await run('mixed-alias', "const savedImported = imported; const readImported = () => imported; const callImported = v => imported(v)\nreturn callImported('xyz').length"), { value: 5 })
  assert.deepEqual(await run('mixed-alias', "'use strict'; const { imported, fresh } = { imported: 'L-i', fresh: 'L-f' }\nreturn [imported, fresh]"),
    { value: ['L-i', 'L-f'] })
  assert.deepEqual(await run('mixed-alias', "return [typeof imported, readImported(), savedImported('xyz').length]"),
    { value: ['string', 'L-i', 5] })
  assert.deepEqual(await run('mixed-alias', 'const imported = value => `local:${value}`; return [callImported("xyz"), readImported() === imported]'),
    { value: ['local:xyz', true] })
  assert.deepEqual(await run('mixed-alias', "import { inspect as imported } from 'node:util'; return [callImported('xyz').length, readImported() === imported]"),
    { value: [5, true] })
})

test('keeps the alias when the pattern that takes it over never completes', async (t) => {
  const run = session(t)
  assert.deepEqual(await run('mixed-alias-throws', "import { inspect as imported } from 'node:util'\nreturn typeof imported"), { value: 'function' })
  assert.match((await run('mixed-alias-throws',
    "const { imported, fresh } = (() => { throw new Error('boom') })()")).error, /boom/)
  assert.deepEqual(await run('mixed-alias-throws', "return [typeof imported, imported('x').length]"), { value: ['function', 3] })
})
