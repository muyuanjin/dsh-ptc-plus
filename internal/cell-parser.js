import { stripTypeScriptTypes } from 'node:module'
import { getLineInfo, parse } from 'acorn'
import { walkAst } from './ast-traversal.js'
import { ModuleRewriteError } from './cell-rewriter.js'
import { transformTypeScriptSource } from './typescript-transform.js'

const CELL_PREFIX = 'async function __ptc_cell__(){\n'
const CELL_SUFFIX = '\n}'
const PARSER_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', locations: true }
const STRIP_OPTIONS = { mode: 'strip-only' }

/** Erase TypeScript syntax without moving any source position.
 * The host stripper is experimental and rejects TypeScript early-error forms
 * the compiler's own lowering produces (Node 22.19 refuses `delete` on a
 * sequence expression the same input erases on Node 24), so the pinned eraser
 * owns erasure whenever the host stripper refuses the input or leaves text
 * this parser still cannot read. */
function eraseTypeScript(source) {
  try {
    const executable = stripTypeScriptTypes(source)
    return { executable, tree: parse(executable, PARSER_OPTIONS) }
  } catch {
    const executable = transformTypeScriptSource(source, STRIP_OPTIONS).code
    return { executable, tree: parse(executable, PARSER_OPTIONS) }
  }
}

/** Parse the async body once and expose only cell-relative source coordinates. */
export function parseExecutableCell(source, { eraseTypes = false } = {}) {
  const wrapped = CELL_PREFIX + source + CELL_SUFFIX
  let executable = wrapped
  let tree
  try {
    tree = parse(executable, PARSER_OPTIONS)
  } catch (javascriptError) {
    if (eraseTypes) {
      try {
        ({ executable, tree } = eraseTypeScript(wrapped))
      } catch {
        tree = undefined
      }
    }
    if (tree === undefined) {
      const offset = Math.max(0, Math.min(source.length, javascriptError.pos - CELL_PREFIX.length))
      const position = getLineInfo(source, offset)
      throw new ModuleRewriteError(javascriptError.message.replace(/ \(\d+:\d+\)$/, ''),
        { line: position.line, column: position.column + 1 })
    }
  }
  const code = executable.slice(CELL_PREFIX.length, -CELL_SUFFIX.length)
  const body = tree.body[0].body
  walkAst(body, node => {
    if (typeof node.start !== 'number') return
    node.start -= CELL_PREFIX.length
    node.end -= CELL_PREFIX.length
    node.loc = {
      start: { line: node.loc.start.line - 1, column: node.loc.start.column },
      end: { line: node.loc.end.line - 1, column: node.loc.end.column },
    }
  })
  body.start = 0
  body.end = code.length
  body.loc.start = getLineInfo(code, 0)
  body.loc.end = getLineInfo(code, code.length)
  return { code, body }
}
