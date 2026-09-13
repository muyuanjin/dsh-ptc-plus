/** Babel's transform retains its scope and declaration machinery, while the
 * complete compilation unit owns uniqueness across separately parsed regions. */
export function withGeneratedNameAllocator(scope, allocate, transform) {
  const previous = Object.getOwnPropertyDescriptor(scope, 'generateUid')
  Object.defineProperty(scope, 'generateUid', { configurable: true, writable: true, value() {
    const name = allocate('native_temporary')
    const program = this.getProgramParent()
    program.references[name] = true
    program.uids[name] = true
    return name
  } })
  try { return transform() }
  finally {
    if (previous === undefined) delete scope.generateUid
    else Object.defineProperty(scope, 'generateUid', previous)
  }
}
