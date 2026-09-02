import assert from 'node:assert/strict'
import test from 'node:test'
import { rewriteModuleImportsExports } from '../internal/cell-rewriter.js'

const ENABLED = { autoRewriteImports: true, autoStripExports: true }

test('rewrites every static import shape with provenance records', () => {
  const cases = [
    ["import 'node:util'", '', 'side-effect'],
    ["import path from 'node:path'", /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/, 'default'],
    ["import * as ns from 'node:path'", /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/, 'namespace'],
    [
      "import { a, b as c } from 'node:path'",
      /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/,
      'named aliases',
    ],
    [
      "import { 'basename' as base } from 'node:path'",
      /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/,
      'string-named import',
      'node:path',
    ],
    [
      "import x, { a } from 'node:path'",
      /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/,
      'mixed',
    ],
    [
      "import data from './d.json' with { type: 'json' }",
      /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/,
      'attributes',
    ],
  ]
  for (const [input, expected, label, expectedSource] of cases) {
    const result = rewriteModuleImportsExports(input, ENABLED)
    if (expected instanceof RegExp) assert.match(result.code, expected, label)
    else assert.equal(result.code, expected, label)
    assert.equal(result.rewrites.length, 1, label)
    assert.equal(result.rewrites[0].kind, 'import', label)
    assert.equal(result.rewrites[0].source, expectedSource ?? input.match(/'([^']+)'/)[1], label)
    assert.equal(result.rewrites[0].at, undefined, 'sort key is not leaked')
    assert.equal(result.moduleLoads.length, 1, label)
    assert.equal(result.moduleLoads[0].source, result.rewrites[0].source, label)
  }
  assert.deepEqual(rewriteModuleImportsExports(cases.at(-1)[0], ENABLED).moduleLoads[0].options, {
    with: { type: 'json' },
  })
  assert.deepEqual(rewriteModuleImportsExports(cases[1][0], ENABLED).moduleLoads[0].requiredExports, ['default'])
  assert.equal(rewriteModuleImportsExports(cases[1][0], ENABLED).moduleLoads[0].global,
    '__dsh_ptc_import_global_0__')
  assert.equal(rewriteModuleImportsExports(cases[0][0], ENABLED).moduleLoads[0].global, undefined)
  assert.equal(rewriteModuleImportsExports(cases[2][0], ENABLED).moduleLoads[0].requiredExports, undefined)
  assert.deepEqual(rewriteModuleImportsExports(cases[3][0], ENABLED).moduleLoads[0].requiredExports, ['a', 'b'])
  assert.deepEqual(rewriteModuleImportsExports(cases[5][0], ENABLED).moduleLoads[0].requiredExports, ['default', 'a'])
})

test('rewrites mixed clauses with as aliases and removes local re-exports', () => {
  const mixed = rewriteModuleImportsExports("import x, { a as b } from 'node:path'", ENABLED)
  assert.match(mixed.code, /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/)
  assert.deepEqual([...mixed.imports.keys()], ['x', 'b'])
  const multiAlias = rewriteModuleImportsExports("import x, { a as b, c as d } from 'node:path'", ENABLED)
  assert.deepEqual([...multiAlias.imports.keys()], ['x', 'b', 'd'])
  const local = rewriteModuleImportsExports('const a = 1\nexport { a }\nreturn 1', ENABLED)
  assert.doesNotMatch(local.code, /export \{ a \}/)
  assert.match(local.code, /return 1/)
  assert.equal(local.rewrites[0].description, 'removed a local re-export declaration')
})

test('parses module candidates with the non-strict cell-body grammar', () => {
  for (const code of [
    'with ({ x: 1 }) { return x }',
    'return 010',
    'function f(a, a) {}; return f',
    'var eval = 1; return eval',
  ]) {
    assert.equal(rewriteModuleImportsExports(code, ENABLED).code, code)
  }
  const imported = rewriteModuleImportsExports(
    "import type { A } from 'pkg'; with ({ x: 1 }) { return x }",
    ENABLED,
  )
  assert.match(imported.code, /with \(\{ x: 1 \}\)/)
  assert.throws(
    () => rewriteModuleImportsExports("'use strict'; with ({ x: 1 }) { return x }", ENABLED),
    /strict mode/,
  )
})

test('rejects dynamic with scopes only while value import aliases are active', () => {
  assert.throws(
    () => rewriteModuleImportsExports(
      "import { sep } from 'node:path'; with ({ sep: 42 }) { return sep }",
      ENABLED,
    ),
    /with statement is not supported while imported bindings are active/,
  )
  assert.throws(
    () => rewriteModuleImportsExports(
      'with ({ sep: 42 }) { return sep }',
      ENABLED,
      new Map([['sep', { namespace: '__existing_namespace__', imported: 'sep' }]]),
      new Set(['__existing_namespace__']),
    ),
    /with statement is not supported while imported bindings are active/,
  )
  assert.doesNotThrow(() => rewriteModuleImportsExports('with ({ sep: 42 }) { return sep }', ENABLED))
  assert.doesNotThrow(() => rewriteModuleImportsExports(
    "import type { Sep } from 'pkg'; with ({ sep: 42 }) { return sep }",
    ENABLED,
  ))
})

test('validates original import bindings before module lowering', () => {
  for (const code of [
    "import { value } from 'pkg'; const value = 1",
    "import { value } from 'pkg'; if (true) { var value = 1 }",
    "import { value } from 'pkg'; function value() {}",
    "import { value } from 'pkg'; import { other as value } from 'other'",
  ]) {
    assert.throws(() => rewriteModuleImportsExports(code, ENABLED), /already been declared|Duplicate declaration/)
  }
  const located = "import { value } from 'pkg'; const value = 1"
  assert.throws(
    () => rewriteModuleImportsExports(located, ENABLED),
    error => error.cellPosition?.line === 1
      && error.cellPosition.column === located.lastIndexOf('value') + 1,
  )

  const shadowed = rewriteModuleImportsExports(
    "import { value } from 'pkg'; { let value = 1; void value }; return value",
    ENABLED,
  )
  assert.match(shadowed.code, /\{ let value = 1; void value \}/)
  assert.match(shadowed.code, /return __dsh_ptc_import_namespace_0__\.value/)

  for (const code of [
    "import type { Value } from 'pkg'; const Value = 1",
    "import { type Value } from 'pkg'; const Value = 1",
  ]) {
    const erased = rewriteModuleImportsExports(code, ENABLED)
    assert.match(erased.code, /const Value = 1/)
    assert.equal(erased.imports.has('Value'), false)
    assert.equal(erased.moduleLoads.length, 0)
  }
})

test('validates local exports against runtime and TypeScript program bindings', () => {
  for (const code of [
    'if (true) { var lifted = 1 }; export { lifted }',
    'type Shape = number; export { Shape }',
    'interface Shape {}; export { Shape }',
    'declare function declared(): void; export { declared }',
  ]) {
    assert.doesNotThrow(() => rewriteModuleImportsExports(code, ENABLED), code)
  }
  assert.throws(
    () => rewriteModuleImportsExports('if (true) { let nested = 1 }; export { nested }', ENABLED),
    /not defined/,
  )
  assert.throws(() => rewriteModuleImportsExports('export { missing }', ENABLED), /not defined/)
})

test('keeps multiline named imports line-stable', () => {
  const code = "import {\n  a,\n  b as c,\n} from 'node:path'"
  const result = rewriteModuleImportsExports(code, ENABLED)
  assert.equal(result.code.split('\n').length, code.split('\n').length)
  assert.equal(result.code, 'const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__;\n\n\n')
})

test('captures every static namespace in a post-directive cell prologue', () => {
  const source = [
    "'use strict'; const before = basename('/a/b')",
    "import { basename } from 'node:path'",
    "const middle = inspect({ value: before })",
    "import { inspect } from 'node:util'",
    'return middle',
  ].join('\n')
  const result = rewriteModuleImportsExports(source, ENABLED)
  const directiveEnd = result.code.indexOf(';') + 1
  const firstCapture = result.code.indexOf('const __dsh_ptc_import_namespace_0__')
  const secondCapture = result.code.indexOf('const __dsh_ptc_import_namespace_1__')
  const firstBodyStatement = result.code.indexOf('const before')

  assert.equal(firstCapture, directiveEnd)
  assert.equal(secondCapture > firstCapture, true)
  assert.equal(firstBodyStatement > secondCapture, true)
  assert.deepEqual(result.moduleLoads.map(load => load.source), ['node:path', 'node:util'])
  assert.equal(result.code.split('\n').length, source.split('\n').length)

  const returned = rewriteModuleImportsExports(
    "return 1; import { dirname } from 'node:path'",
    ENABLED,
  )
  assert.equal(returned.code.indexOf('const __dsh_ptc_import_namespace_0__') < returned.code.indexOf('return 1'), true)
})

test('separates generated imports from semicolonless directives and interpreters', () => {
  const directiveSource = [
    '"use strict"',
    "import { inspect } from 'node:util'",
    'return inspect({ value: 1 })',
  ].join('\n')
  const directive = rewriteModuleImportsExports(directiveSource, ENABLED)
  assert.match(
    directive.code,
    /^"use strict";const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__;/,
  )
  assert.equal(directive.code.split('\n').length, directiveSource.split('\n').length)

  const interpreterSource = [
    '#!/usr/bin/env node',
    "import { inspect } from 'node:util'",
    'return inspect({ value: 1 })',
  ].join('\n')
  const interpreter = rewriteModuleImportsExports(interpreterSource, ENABLED)
  assert.match(
    interpreter.code,
    /^#!\/usr\/bin\/env node\nconst __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__;/,
  )
  assert.equal(interpreter.code.split('\n').length, interpreterSource.split('\n').length)
})

test('reserves lexical and host import identities against caller-owned bindings', () => {
  const unavailable = new Set([
    '__dsh_ptc_import_namespace_0__',
    '__dsh_ptc_import_global_0__',
  ])
  const result = rewriteModuleImportsExports(
    "import { basename } from 'node:path'; return basename('/a/b')",
    ENABLED,
    new Map(),
    new Set(),
    unavailable,
  )
  assert.deepEqual([...result.generatedNamespaces], ['__dsh_ptc_import_namespace_1__'])
  assert.match(result.code, /const __dsh_ptc_import_namespace_1__ = __dsh_ptc_import_global_1__/)
  assert.equal(result.moduleLoads[0].global, '__dsh_ptc_import_global_1__')
  assert.doesNotMatch(result.code, /const __dsh_ptc_import_namespace_0__/)
  assert.doesNotMatch(result.code, /__dsh_ptc_import_global_0__/)
})

test('supports multiline mixed imports and leaves disabled rewrites untouched', () => {
  const multiMixed = "import x, {\n  a,\n} from 'node:path'"
  const rewritten = rewriteModuleImportsExports(multiMixed, ENABLED)
  assert.equal(rewritten.code, 'const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__;\n\n')
  assert.equal(rewritten.code.split('\n').length, multiMixed.split('\n').length)
  const disabled = rewriteModuleImportsExports("import x from 'node:path'", {
    autoRewriteImports: false,
    autoStripExports: false,
  })
  assert.equal(disabled.code, "import x from 'node:path'")
  assert.equal(disabled.rewrites.length, 0)
})

test('fails safe on malformed module syntax', () => {
  for (const code of [
    'export type Bad = }',
    "import x from 'node:util' whatever",
    'import fs from',
    'import { a }',
    'import x y',
    'export',
    'export default class NoBody',
    "import type 'node:util'",
  ]) {
    assert.throws(() => rewriteModuleImportsExports(code, ENABLED), undefined, JSON.stringify(code))
  }
})

test('strips export modifiers, converts re-exports, and erases type-only exports', () => {
  const code = [
    'export const value = 42',
    'export function f() { return 1 }',
    'export default function helper() { return 2 }',
    "export * from 'node:util'",
    "export { basename } from 'node:path'",
    'export type Shape = {',
    '  width: number',
    '}',
    'return 1',
  ].join('\n')
  const result = rewriteModuleImportsExports(code, ENABLED)
  assert.match(result.code, /const value = 42/)
  assert.match(result.code, /function f\(\) \{ return 1 \}/)
  assert.match(result.code, /function helper\(\) \{ return 2 \}; const __dsh_ptc_default_namespace_0__ = \{ default: helper \}/)
  assert.equal(result.exportDeclarations[0].commitDependency, '__default')
  assert.deepEqual([...result.commitTargets], ['__default'])
  assert.deepEqual(result.imports.get('__default'), {
    namespace: '__dsh_ptc_default_namespace_0__',
    imported: 'default',
    syntheticDefault: true,
    commitDependency: '__default',
  })
  assert.deepEqual(result.moduleLoads.map(load => load.source), ['node:util', 'node:path'])
  assert.match(result.code, /return 1/)
  const kinds = result.rewrites.map(record => record.kind)
  assert.deepEqual(kinds, ['export', 'export', 'export', 'export', 'export', 'export'])
  assert.equal(result.rewrites[4].source, 'node:path')
  assert.equal(result.rewrites[5].source, 'type')
  assert.match(result.rewrites[5].description, /type-only/)
})

test('converts namespace re-exports through the remote re-export path', () => {
  const result = rewriteModuleImportsExports('export * as ns from "node:path"', ENABLED)
  assert.equal(result.code, '')
  assert.equal(result.moduleLoads[0].source, 'node:path')
  assert.deepEqual(result.rewrites, [{
    kind: 'export',
    description: 'converted the re-export of "node:path" into a side-effect import',
    source: 'node:path',
  }])
})

test('converts anonymous default exports to __default bindings', () => {
  for (const code of ['export default 42', 'export default function () {}', 'export default class {}']) {
    const result = rewriteModuleImportsExports(code, ENABLED)
    assert.match(result.code, /const __dsh_ptc_default_namespace_0__ = \{ default: /)
    assert.deepEqual([...result.commitTargets], ['__default'])
  }
  const combined = rewriteModuleImportsExports("import x from 'node:util'\nexport default 42", ENABLED)
  assert.match(combined.code, /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/)
  assert.match(combined.code, /const __dsh_ptc_default_namespace_0__ = \{ default:\s+42 \}/)

  for (const declaration of ['function () {}', 'class {}']) {
    const continued = rewriteModuleImportsExports(
      `export default ${declaration}\n(function marker(){})()`, ENABLED,
    )
    assert.match(continued.code, /};?\n?;/)
    assert.match(continued.code, /;\n\(function marker/)
  }
  const expression = rewriteModuleImportsExports('export default (() => () => 7)\n()', ENABLED)
  assert.match(expression.code, /\(\(\) => \(\) => 7\)\n\(\)/)
  assert.doesNotMatch(expression.code, /7\);\n\(\)/)
})

test('keeps named default classes reachable through __default', () => {
  const code = 'export default class Box { constructor() { this.v = 3 } }\nreturn 1'
  const result = rewriteModuleImportsExports(code, ENABLED)
  assert.match(result.code, /class Box \{ constructor\(\) \{ this\.v = 3 \} \}; const __dsh_ptc_default_namespace_0__ = \{ default: Box \}/)
  assert.equal(result.exportDeclarations[0].commitDependency, '__default')
  assert.deepEqual([...result.commitTargets], ['__default', 'Box'])
})

test('reuses one private slot for later default exports', () => {
  const first = rewriteModuleImportsExports('export default function first() {}', ENABLED)
  const second = rewriteModuleImportsExports(
    'export default function second() {}\nreturn __default',
    ENABLED,
    first.imports,
    first.importNamespaces,
    new Set(['__default', 'first']),
  )
  const namespace = first.imports.get('__default').namespace
  assert.equal(second.imports.get('__default').namespace, namespace)
  assert.equal(second.importNamespaces.size, 1)
  assert.match(second.code, new RegExp(`${namespace}\\.default = second`))
  assert.doesNotMatch(second.code, new RegExp(`const ${namespace}`))
  assert.match(second.code, new RegExp(`return ${namespace}\\.default`))
})

test('preserves predecessor default exports as ordinary declarations', () => {
  const legacy = { defaultExportBinding: 'legacy-variable' }
  const expression = rewriteModuleImportsExports(
    'export default 42', ENABLED, new Map(), new Set(), new Set(), legacy,
  )
  assert.match(expression.code, /const __default =\s+42/)
  assert.equal(expression.imports.has('__default'), false)
  assert.deepEqual([...expression.commitTargets], [])

  const namedFunction = rewriteModuleImportsExports(
    'export default function helper() {}', ENABLED, new Map(), new Set(), new Set(), legacy,
  )
  assert.match(namedFunction.code, /const __default = helper; function helper\(\) \{\}/)
  const namedClass = rewriteModuleImportsExports(
    'export default class Box {}', ENABLED, new Map(), new Set(), new Set(), legacy,
  )
  assert.match(namedClass.code, /class Box \{\}; const __default = Box;/)
  const anonymousFunction = rewriteModuleImportsExports(
    'export default function () {}', ENABLED, new Map(), new Set(), new Set(), legacy,
  )
  assert.match(anonymousFunction.code, /const __default = function \(\) \{\};/)
  const direct = rewriteModuleImportsExports(
    'export default function __default() {}', ENABLED, new Map(), new Set(), new Set(), legacy,
  )
  assert.match(direct.code, /^\s*function __default\(\) \{\}/)
  assert.doesNotMatch(direct.code, /const __default/)
  const typeOnly = rewriteModuleImportsExports(
    'export default interface Shape {}', ENABLED, new Map(), new Set(), new Set(), legacy,
  )
  assert.equal(typeOnly.code, '')
  assert.equal(typeOnly.rewrites[0].source, 'interface')
  assert.throws(
    () => rewriteModuleImportsExports(
      'const __default = 1; export default 2',
      ENABLED,
      new Map(),
      new Set(),
      new Set(),
      legacy,
    ),
    /already declared/,
  )
})

test('defines the public __default collision rule', () => {
  const sameName = rewriteModuleImportsExports('export default function __default() { return 1 }', ENABLED)
  assert.match(sameName.code, /const __dsh_ptc_default_namespace_0__ = \{ default: function __default\(\) \{ return 1 \} \}/)
  assert.match(sameName.code, /redeclaration_commit_0__"\]\("__default"\)/)
  assert.deepEqual([...sameName.commitTargets], ['__default'])
  assert.equal(sameName.exportDeclarations[0].commitDependency, '__default')
  assert.throws(
    () => rewriteModuleImportsExports('const __default = 1; export default 2', ENABLED),
    /already declared/,
  )
  assert.doesNotThrow(() => rewriteModuleImportsExports('import type { __default } from "types"; export default 2', ENABLED))
  assert.doesNotThrow(() => rewriteModuleImportsExports('declare const __default: number; export default 2', ENABLED))
  assert.throws(
    () => rewriteModuleImportsExports(
      'export default 2', ENABLED, new Map(), new Set(), new Set(['__default']),
    ),
    /already declared/,
  )
  assert.throws(
    () => rewriteModuleImportsExports(
      'export default 2',
      ENABLED,
      new Map([['__default', { namespace: '__import__', imported: 'default' }]]),
      new Set(['__import__']),
      new Set(['__default']),
    ),
    /already declared/,
  )
  assert.throws(
    () => rewriteModuleImportsExports(
      'export default 2', ENABLED, new Map(), new Set(), new Set(), { defaultExportBinding: 'unknown' },
    ),
    /unsupported default export binding semantics/,
  )
})

test('preserves a return that mentions return inside strings and templates', () => {
  const code = "const s = 'return'\nconst t = `return ${x}`\nreturn s + t"
  const result = rewriteModuleImportsExports(code, ENABLED)
  assert.match(result.code, /const s = 'return'/)
  assert.match(result.code, /const t = `return \$\{x\}`/)
  assert.match(result.code, /return s \+ t/)
})

test('parses returns through regular expressions and nested template expressions', () => {
  for (const code of [
    "const r = /return/; return r.test('return')",
    'const x = `${"}"}`; return x',
    'const x = `${(() => { return 1 })()}`; return x',
  ]) {
    assert.equal(rewriteModuleImportsExports(code, ENABLED).code, code)
  }
})

test('rewrites default plus namespace imports without dropping either binding', () => {
  const result = rewriteModuleImportsExports("import d, * as ns from 'node:path'\nreturn [d, ns]", ENABLED)
  assert.match(result.code, /const __dsh_ptc_import_namespace_0__ = __dsh_ptc_import_global_0__/)
  assert.match(result.code, /return \[__dsh_ptc_import_namespace_0__\.default, __dsh_ptc_import_namespace_0__\]/)
  assert.equal(result.rewrites.length, 1)
})

test('lowers imported reads and writes through one namespace-backed binding model', () => {
  const result = rewriteModuleImportsExports([
    "import { value, fn as call, tag } from 'pkg'",
    'const local = () => value',
    'const object = { value }',
    'call()',
    'tag`x`',
    'value = value + 1',
  ].join('\n'), ENABLED)
  assert.match(result.code, /;\(0, __dsh_ptc_import_namespace_0__\.fn\)\(\)/)
  assert.match(result.code, /;\(0, __dsh_ptc_import_namespace_0__\.tag\)`x`/)
  assert.match(result.code, /object = \{ value: __dsh_ptc_import_namespace_0__\.value \}/)
  assert.match(result.code, /throw new TypeError\('Assignment to constant variable\.'\)/)
  assert.match(result.code, /__dsh_ptc_import_namespace_0__\.value \+ 1/)
  assert.deepEqual([...result.imports.entries()].map(([name, binding]) => [name, binding.imported]), [
    ['value', 'value'], ['call', 'fn'], ['tag', 'tag'],
  ])

  const writes = rewriteModuleImportsExports([
    "import { value } from 'pkg'",
    'value &&= sideEffect()',
    'value += sideEffect()',
    'value++',
  ].join('\n'), ENABLED)
  assert.match(writes.code, /\.value && \(\(__dsh_ptc_import_value__\)/)
  assert.match(writes.code, /\.value \+ \(sideEffect\(\)\)/)
  assert.match(writes.code, /__dsh_ptc_import_value__\+\+/)
  for (const source of ['value = (value = 1)', 'value = value++']) {
    assert.throws(
      () => rewriteModuleImportsExports(`import { value } from 'pkg'\n${source}`, ENABLED),
      /nested assignment to an imported binding/,
    )
  }

  const optional = rewriteModuleImportsExports("import { value } from 'pkg'\nvalue?.()", ENABLED)
  assert.match(optional.code, /;\(0, __dsh_ptc_import_namespace_0__\.value\)\?\.\(\)/)
  for (const source of ['delete value', 'eval("value")']) {
    assert.throws(
      () => rewriteModuleImportsExports(`import { value } from 'pkg'\n${source}`, ENABLED),
      /imported binding/,
    )
  }
  assert.doesNotThrow(() => rewriteModuleImportsExports(
    "import { value } from 'pkg'\nconst eval = () => value\neval()",
    ENABLED,
  ))
})

test('removes empty local exports and comment-separated export modifiers', () => {
  for (const source of ['export {}', 'export { type Missing }']) {
    const result = rewriteModuleImportsExports(source + '\nreturn 1', ENABLED)
    assert.equal(result.code, '\nreturn 1')
    assert.equal(result.rewrites.length, 1)
  }
  const commented = rewriteModuleImportsExports('export/*comment*/const x = 1\nreturn x', ENABLED)
  assert.equal(commented.code, 'const x = 1\nreturn x')
})

test('records type-only imports independent of quote style and line layout', () => {
  for (const source of [
    'import type { A } from "pkg"',
    "import type {\n  A\n} from 'pkg'",
    "import { type A } from 'pkg'",
  ]) {
    const result = rewriteModuleImportsExports(source + '\nreturn 1', ENABLED)
    assert.equal(result.code.split('\n').length, source.split('\n').length + 1)
    assert.deepEqual(result.rewrites, [{
      kind: 'import',
      description: 'removed the type-only import of "pkg"',
      source: 'pkg',
    }])
  }
})

test('removes every type-only export form without loading a module', () => {
  for (const source of [
    "export type * from 'pkg'",
    "export { type A } from 'pkg'",
    'export default interface A { value: number }',
    'export declare const value: number',
  ]) {
    const result = rewriteModuleImportsExports(source + '\nreturn 1', ENABLED)
    assert.equal(result.code, '\nreturn 1')
    assert.equal(result.rewrites.length, 1)
    assert.equal(result.rewrites[0].kind, 'export')
    assert.match(result.rewrites[0].description, /type-only/)
  }
})
