export function recordedSessionEvents(session) {
  return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
}
