import { parse } from '@babel/parser'
import { types as t } from '@babel/core'
import { transformTypeScriptSource } from './typescript-transform.js'
import { CELL_PARSER_PLUGINS, normalizeTypeScriptValues } from './repl-scope-normalizer.js'
import { visitSource } from './compiler-source-regions.js'
import { applySourceEdits, identitySourceMap } from './source-position-map.js'

export function linkCommonJsEvidenceSource(source, prefix) {
  const tree = parse(source, { sourceType: 'commonjs', errorRecovery: true, plugins: CELL_PARSER_PLUGINS })
  const starts = []
  t.traverseFast(tree, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && node.callee.name === 'require' && node.arguments[0]?.type === 'StringLiteral') {
      starts.push(node.arguments[0].start + 1)
    }
  })
  const pieces = []
  let previous = 0
  for (const start of starts.sort((left, right) => left - right)) {
    pieces.push(source.slice(previous, start), prefix)
    previous = start
  }
  pieces.push(source.slice(previous))
  return pieces.join('')
}

/** Preserve original spelling for the native CommonJS linker's source analysis. */
export function commonJsExportEvidence(source, { legacy = false } = {}) {
  try {
    parse(source, { sourceType: 'commonjs' })
    return source
  } catch {
    // Syntax validation belongs to the executable compiler. Evidence only
    // removes type ranges that would interfere with Node's lexical analysis.
  }
  if (!legacy) {
    const normalized = normalizeTypeScriptValues(source, identitySourceMap(source.length), 'commonjs').code
    const tree = parse(normalized, { sourceType: 'commonjs', errorRecovery: true, plugins: CELL_PARSER_PLUGINS })
    const edits = []
    visitSource(tree, { enter(path) {
      const node = path.node
      if (path.isTSType() || path.isTSTypeAnnotation() || path.isTSTypeParameterDeclaration()
        || path.isTSTypeParameterInstantiation()) {
        edits.push({ start: node.start, end: node.end, text: '' })
        path.skip()
      } else if (node.type.startsWith('TS') && node.expression !== undefined) {
        edits.push({ start: node.start, end: node.expression.start, text: '' },
          { start: node.expression.end, end: node.end, text: '' })
        for (const key of t.VISITOR_KEYS[node.type]) if (key !== 'expression') path.skipKey(key)
      }
    } })
    return applySourceEdits(normalized, identitySourceMap(normalized.length), edits.map(edit => ({ ...edit,
      text: normalized.slice(edit.start, edit.end).replace(/[^\s]/gu, ' ') }))).code
  }
  // Strip types without printing JavaScript: even parentheses and property
  // spellings affect Node's lexical detection. The wrapper permits CJS return
  // and new.target, and is removed before top-level reexport analysis.
  const prefix = 'function __ptc_commonjs_evidence__(){\n'
  const wrapped = `${prefix}${source}\n}`
  let javascript
  try {
    javascript = transformTypeScriptSource(wrapped, { mode: 'strip-only' }).code.slice(prefix.length, -2)
  } catch (error) {
    if (error.cause?.code !== 'UnsupportedSyntax') throw error
    // Legacy TypeScript runtime constructs still use their recorded lowering.
    const transformed = transformTypeScriptSource(wrapped, { module: false,
      transform: { noEmptyExport: true } }).code
    const body = parse(transformed).program.body[0].body
    javascript = transformed.slice(body.start + 1, body.end - 1)
  }
  return javascript
}
