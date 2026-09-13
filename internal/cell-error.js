/** Source diagnostics retain their native SyntaxError identity at runtime. */
export class ModuleRewriteError extends SyntaxError {
  constructor(message, cellPosition) {
    super(message)
    if (cellPosition !== undefined) this.cellPosition = cellPosition
  }
}
