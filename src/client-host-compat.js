function sessionPresetValue(projected, summary) {
  return projected !== undefined || Object.hasOwn(summary?.projectionValues ?? {}, 'agentPreset')
    ? projected : summary?.agentPreset
}

export function sessionUsesPtcPreset(preset) {
  return preset === 'ptc' || preset === 'code'
}

/** Consume the renderer's public hooks; only preset selection has a summary fallback. */
export function useSessionPreset({ sessionId, useProjection, useSessions }) {
  const projected = useProjection('agentPreset')
  return typeof useSessions === 'function'
    ? useSessions(state => sessionPresetValue(projected, state.byId?.[sessionId]))
    : projected
}

/** Publish the current preset immediately and follow its public list/projection sources. */
export function watchCurrentSessionPreset(sessions, listener) {
  let source
  let unsubscribeProjection
  const sync = () => {
    const snapshot = sessions.list.getSnapshot()
    const current = snapshot.current
    const next = current === undefined ? undefined
      : sessions.binding(current)?.session.projections?.faceOf?.('agentPreset')
    if (source !== next) {
      unsubscribeProjection?.()
      source = next
      unsubscribeProjection = source?.subscribe(sync)
    }
    listener(sessionPresetValue(source?.getSnapshot(), snapshot.byId?.[current]))
  }
  const unsubscribeList = sessions.list.subscribe(sync)
  const dispose = () => {
    unsubscribeList()
    unsubscribeProjection?.()
  }
  try {
    sync()
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}

/** Missing legacy interaction evidence never proves that the composer is idle. */
export function isIdleSessionComposer(owner, sessionId) {
  return Object.hasOwn(owner, 'sessionId')
    ? owner.sessionId === sessionId && owner.pendingInteraction === undefined
    : owner.session?.sessionId === sessionId && Array.isArray(owner.interactions) && owner.interactions.length === 0
}
