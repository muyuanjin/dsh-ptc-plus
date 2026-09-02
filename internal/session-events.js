/** Read the immutable session log across current and legacy DSH session APIs. */
export function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    return session.snapshotEvents()
  }
  return session?.events
}
