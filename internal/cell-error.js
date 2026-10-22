/** Source diagnostics retain their native SyntaxError identity at runtime. */
export class ModuleRewriteError extends SyntaxError {
  constructor(message, cellPosition) {
    super(message)
    if (cellPosition !== undefined) this.cellPosition = cellPosition
  }
}

/**
 * The kernel refuses to admit a cell because a previous helper was not reclaimed.
 *
 * This is a fact about the kernel's own lifecycle, not about the recorded history
 * or the submitted source, so consumers must not contract a frontier or blame a
 * cell for it.
 */
export class CellAdmissionBlocked extends AggregateError {
  constructor(failures) {
    super(failures, 'previous computation helper reclamation failed; dispose the session before continuing')
  }
}
