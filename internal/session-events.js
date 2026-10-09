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

/** Read model source from the Host projection, independently of execution history. */
export function sessionSourceMessages(session, events, nodes) {
  if (Array.isArray(session?.surface?.sourceMessages)) {
    return new Map(session.surface.sourceMessages)
  }
  const visible = new Set(nodes)
  const sources = new Map()
  const messages = typeof session?.deriveMessages === 'function'
    ? session.deriveMessages()
    : undefined
  for (const event of events) {
    if (event.type !== 'assistant/message' || !visible.has(event.seq)) continue
    let message
    if (typeof session?.deriveEventMessage === 'function') {
      message = session.deriveEventMessage(event)
    } else if (messages !== undefined) {
      const id = event.data?.message?.id
      const matches = typeof id === 'string' ? messages.filter(item => item.id === id) : []
      if (matches.length === 1) message = matches[0]
    } else if (Array.isArray(session?.events)) {
      // The historical array-backed contract has no pure message projections.
      message = event.data?.message
    }
    if (message !== undefined && message !== null) sources.set(event.seq, message)
  }
  return sources
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
    // Do not pair an immutable raw cut with a newer live message projection.
    // A cut without exact model-source evidence cannot retain old bindings.
    const sources = session.seq - 1 === observation.cursor
      ? sessionSourceMessages(session, observation.events, nodes)
      : new Map()
    return Object.freeze({
      id: session.id, header: observation.header, events: observation.events,
      surface: Object.freeze({
        nodes: Object.freeze([...nodes]),
        sourceMessages: Object.freeze([...sources].map(entry => Object.freeze(entry))),
      }),
    })
  } finally {
    observation[Symbol.dispose]()
  }
}
