/** Read an explicit observation or the historical array-backed session contract. */
export function sessionEvents(session) {
  if (session === undefined || session === null) return undefined
  const events = session.events
  if (Array.isArray(events)) return events
  if (Object.hasOwn(session, 'events')) throw new Error('ptc-plus: legacy session.events is not an event array')
  throw new Error('ptc-plus: session history requires a public sessionQuery observation')
}

export function advanceSessionSurface(nodes, event) {
  if (event?.surfaceOp === 'append') return [...nodes, event.seq]
  if (event?.surfaceOp?.op !== 'replace') return nodes
  const first = nodes.indexOf(event.surfaceOp.startSeq ?? event.surfaceOp.start)
  const last = nodes.indexOf(event.surfaceOp.endSeq ?? event.surfaceOp.end)
  if (first === -1 || last < first) return nodes
  const next = [...nodes]
  next.splice(first, last - first + 1, event.seq)
  return next
}

export async function readSessionLog(session, query, signal) {
  if (session === undefined || session === null || Array.isArray(session.events)) return session
  if (typeof query?.observeSession !== 'function') {
    throw new Error('ptc-plus: sessionQuery.observeSession is unavailable for this session')
  }
  const observation = await query.observeSession(session.id, { signal, projectionMode: 'none' })
  try {
    if (!Array.isArray(observation.events)) throw new Error('ptc-plus: sessionQuery observation did not publish events')
    let nodes = session.surface?.nodes
    if (!Array.isArray(nodes) || session.seq - 1 !== observation.cursor) {
      nodes = []
      for (const event of observation.events) nodes = advanceSessionSurface(nodes, event)
    }
    return Object.freeze({
      id: session.id, header: observation.header, events: observation.events,
      surface: Object.freeze({
        nodes: Object.freeze([...nodes]),
      }),
    })
  } finally {
    observation[Symbol.dispose]()
  }
}
