import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { SessionRuntime } from '../internal/session-runtime.js'

const native = createRequire(import.meta.url)('typescript')
const { name, options, first } = JSON.parse(process.argv[2])
const runtime = new SessionRuntime({ durableReplay: false, ...options })
try {
  const session = { id: `large-dependency-${name}`, session: { header: { cwd: process.cwd() } } }
  const run = async program => {
    const result = await runtime.run(session, { bindings: [], program })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
  assert.equal(await run('let retained=7;const readRetained=()=>retained;return retained'), 7)
  const load = first === 'import' ? '(await import("typescript")).default' : 'require("typescript")'
  const result = await run(`
    const library=${load};
    const output=library.transpileModule('const value: number = 1;',{
      compilerOptions:{target:library.ScriptTarget.ES2022}
    });
    const syntax=library.createSourceFile('source.ts','let value: number = 1;',library.ScriptTarget.Latest,true);
    return [library.version,output.outputText,syntax.statements.length,retained,
      library===require('typescript'),library===(await import('typescript')).default,
      library.transpileModule.toString()];
  `)
  const expected = native.transpileModule('const value: number = 1;', { compilerOptions: { target: native.ScriptTarget.ES2022 } }).outputText
  assert.deepEqual(result.slice(0, 6), [native.version, expected, 1, 7, true, true])
  if (name === 'stateful') assert.equal(result[6], native.transpileModule.toString())
  assert.deepEqual(await run(`retained+=1;return [retained,readRetained(),
    library===require('typescript'),library===(await import('typescript')).default]`), [8, 8, true, true])
} finally {
  await runtime.dispose()
}
