export function declarationSpan(node) {
  const start = node.loc?.start
  /* c8 ignore next */
  const end = node.loc?.end ?? start
  /* c8 ignore next */
  if (start === undefined) return undefined
  return {
    line: start.line,
    column: start.column + 1,
    /* c8 ignore next */
    ...(end === undefined ? {} : {
      end: {
        line: end.line,
        column: end.column + 1,
      },
    }),
  }
}

export class PreflightError extends Error {
  constructor(message, node, span = undefined) {
    super(message)
    this.span = span ?? declarationSpan(node)
  }
}
