/** Historical legacy-v1 cell grammar, retained from c51616c8d6c8:cell-parser.js. */
import { stripTypeScriptTypes } from 'node:module'
import { getLineInfo, parse } from 'acorn'
import { walkAst } from './ast-traversal.js'
import { ModuleRewriteError } from './cell-rewriter.js'

const CELL_PREFIX = 'async function __ptc_cell__(){\n'
const CELL_SUFFIX = '\n}'
const PARSER_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', locations: true }

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
        executable = stripTypeScriptTypes(wrapped)
        tree = parse(executable, PARSER_OPTIONS)
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
