import { normalizeUserBindingDraftView } from '../internal/user-binding-draft-projection.js'
import { bindingModelPreferences } from '../internal/user-binding-model-context.js'

export function bindingDraftProjection(value) {
  try { return normalizeUserBindingDraftView(value) } catch { return undefined }
}

function candidateIdentity(candidate) {
  return candidate ? JSON.stringify([candidate.requestId, candidate.commandId, candidate.version]) : null
}

function entryIdentity(entry) {
  return JSON.stringify([entry?.id, entry?.name, entry?.scope, entry?.purpose, entry?.source,
    entry?.symbols, entry?.enabled, bindingModelPreferences(entry?.modelContext)])
}

function sameCandidate(left, right) {
  return left != null && right != null && candidateIdentity(left) === candidateIdentity(right)
    && left.mode === right.mode && entryIdentity(left.entry) === entryIdentity(right.entry)
}

function matchesDraft(candidate, draft) {
  return candidate != null && draft != null && candidate.version === draft.version
    && candidate.mode === draft.mode && entryIdentity(candidate.entry) === entryIdentity(draft.entry)
}

function matchesAction(candidate, action) {
  return action != null && action.requestId === candidate?.requestId && action.id === candidate?.entry.id
    && (action.state === 'saved' || action.state === 'discarded') && typeof action.enabled === 'boolean'
    && (action.state !== 'discarded' || action.enabled === false)
}

export function bindingReviewStatus(view) {
  return view.action?.state === 'saved'
    ? view.action.enabled ? 'bindings.commandSavedEnabled' : 'bindings.commandSaved'
    : view.action?.state === 'discarded' ? 'bindings.commandDiscarded'
      : view.busy ? 'bindings.reviewSaving' : view.message ? 'bindings.reviewAttention'
        : view.writable ? 'bindings.commandReady'
          : view.loading ? 'bindings.reviewLoading' : 'bindings.reviewReadOnly'
}

/** One Client review per session. Display choices and receipts never grant Host authority. */
export function createBindingReviews(call) {
  const sessions = new Map()
  let disposed = false
  function forSession(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId)
    const listeners = new Set()
    const choices = new Map()
    let snapshot = { candidate: null, action: null, writable: false, busy: false, loading: false,
      message: null, messageSource: null, visibility: 'expanded', mounted: false, reachable: false }
    let projection
    let authority = null
    let revoked = false
    let epoch = 0
    let reading
    const pending = new Map()
    let timer
    let attached = false
    const publish = patch => {
      if (disposed) return
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }
    const invalidate = () => {
      epoch++
      reading?.abort()
      reading = undefined
      clearInterval(timer)
      timer = undefined
    }
    const select = (candidate, action = null) => {
      const same = sameCandidate(candidate, snapshot.candidate)
      const visibility = choices.get(candidateIdentity(candidate)) ?? 'expanded'
      publish({ candidate, action: action ?? (same ? snapshot.action : null), visibility,
        ...(!same ? { message: null, messageSource: null, writable: false, loading: false } : {}),
        busy: pending.has(candidateIdentity(candidate)) })
    }
    const refresh = async () => {
      if (!attached || authority === null || reading || pending.has(candidateIdentity(snapshot.candidate))
        || snapshot.action !== null || disposed) return
      const currentEpoch = epoch
      const capability = authority
      const commandId = projection.commandId
      const controller = new AbortController()
      reading = controller
      const results = await Promise.allSettled(['list', 'draft', 'draft-review'].map(endpoint => (
        call(endpoint, endpoint === 'list' ? {} : { capability }, controller.signal)
      )))
      if (disposed || epoch !== currentEpoch || controller.signal.aborted) return
      reading = undefined
      const [catalogResult, draftResult, reviewResult] = results
      const review = reviewResult.status === 'fulfilled' ? reviewResult.value : null
      const candidate = review?.candidate
      const known = snapshot.candidate
      const matches = candidate?.commandId === commandId && typeof candidate?.requestId === 'string'
        && Number.isSafeInteger(candidate.version) && candidate.version > 0 && typeof candidate.entry?.source === 'string'
        && (known === null || sameCandidate(known, candidate))
      if (matches && matchesAction(candidate, review.action)) {
        clearInterval(timer)
        timer = undefined
        publish({ ...(known !== null ? { action: review.action } : {}),
          writable: false, loading: false, message: null, messageSource: null })
        return
      }
      if (matches && known === null) select(candidate)
      const draft = draftResult.status === 'fulfilled' ? draftResult.value : null
      if (draftResult.status === 'fulfilled' && draft === null) revoked = true
      const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null
      const writable = !revoked && matches && review.action === null && matchesDraft(candidate, draft)
        && Number.isSafeInteger(catalog?.revision)
      const error = results.find(result => result.status === 'rejected')
      publish({ writable, loading: false, revision: writable ? catalog.revision : undefined,
        ...(snapshot.messageSource === 'write' ? {} : {
          message: error ? String(error.reason?.message ?? error.reason) : null,
          messageSource: error ? 'read' : null,
        }) })
    }
    const start = () => {
      clearInterval(timer)
      timer = undefined
      if (!attached || authority === null || snapshot.action !== null) return
      void refresh()
      // Retain the existing bounded-frequency eligibility refresh, including during composer takeovers.
      timer = setInterval(() => { void refresh() }, 1500)
    }
    const sync = next => {
      projection = next
      const historical = next?.history?.find(record => record.commandId === next.commandId)
      const nextAuthority = next?.phase === 'ready' && next.commandId !== null && !historical?.action
        ? next.capability : null
      const previousKey = candidateIdentity(snapshot.candidate)
      const recorded = next?.history?.find(record => sameCandidate(record.candidate, snapshot.candidate))
      if (recorded?.action) publish({ action: recorded.action, writable: false, message: null, messageSource: null })
      if (historical && next.phase === 'ready') {
        // Historical receipts reconcile an existing review; they do not create a new dock.
        if (!historical.action || sameCandidate(historical.candidate, snapshot.candidate)) {
          select(historical.candidate, historical.action)
        } else select(null)
      }
      else if (next?.commandId != null && next.commandId !== snapshot.candidate?.commandId) select(null)
      else if (next === undefined || (next?.phase !== 'ready' && snapshot.candidate !== null
        && snapshot.action === null && !next?.history?.some(record => sameCandidate(record.candidate, snapshot.candidate)))) {
        select(null)
      }
      const nextKey = candidateIdentity(snapshot.candidate)
      if (authority !== nextAuthority || previousKey !== nextKey) {
        invalidate()
        if (authority !== nextAuthority) revoked = false
        authority = nextAuthority
        publish({ writable: false, loading: nextAuthority !== null && snapshot.action === null })
        start()
      }
    }
    const act = async (operation, activate = false) => {
      const key = candidateIdentity(snapshot.candidate)
      if (!attached || disposed || !snapshot.writable || snapshot.action !== null || pending.has(key) || authority === null) return
      const transaction = { candidate: snapshot.candidate, capability: authority }
      pending.set(key, transaction)
      invalidate()
      publish({ busy: true, writable: false, message: null, messageSource: null })
      try {
        await call(operation, { capability: transaction.capability, version: transaction.candidate.version,
          ...(operation === 'save-draft' ? { expectedRevision: snapshot.revision, activate } : {}) })
        // Save returns only after persistence. Discard can also return for an absent locator,
        // so it needs the existing review receipt before claiming a completed discard.
        const receipt = operation === 'save-draft'
          ? { requestId: transaction.candidate.requestId, id: transaction.candidate.entry.id, state: 'saved', enabled: activate }
          : (await call('draft-review', { capability: transaction.capability }))
        const action = operation === 'save-draft' ? receipt
          : sameCandidate(receipt?.candidate, transaction.candidate) && matchesAction(transaction.candidate, receipt?.action)
            ? receipt.action : null
        if (!disposed && sameCandidate(snapshot.candidate, transaction.candidate) && snapshot.action === null) {
          publish({ action, writable: false, loading: false,
            message: action === null ? 'bindings.reviewUnconfirmed' : null,
            messageSource: action === null ? 'write' : null })
        }
      } catch (error) {
        if (!disposed && sameCandidate(snapshot.candidate, transaction.candidate) && snapshot.action === null) {
          publish({ message: String(error?.message ?? error), messageSource: 'write', writable: false, loading: false })
        }
      } finally {
        pending.delete(key)
        if (!disposed && sameCandidate(snapshot.candidate, transaction.candidate)) {
          publish({ busy: false })
          start()
        }
      }
    }
    const review = {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      sync,
      attach() {
        attached = true
        publish({ mounted: true })
        start()
        return () => {
          attached = false
          invalidate()
          publish({ mounted: false, reachable: false, writable: false })
        }
      },
      reset() {
        invalidate()
        publish({ writable: false, loading: authority !== null && snapshot.action === null })
        start()
      },
      reachable(value) { if (snapshot.reachable !== value) publish({ reachable: value }) },
      display(visibility) {
        if (snapshot.candidate === null) return
        choices.set(candidateIdentity(snapshot.candidate), visibility)
        publish({ visibility })
      },
      act,
      refresh,
      dispose() { invalidate(); attached = false; listeners.clear(); choices.clear() },
    }
    sessions.set(sessionId, review)
    return review
  }
  return {
    forSession,
    reset() { for (const review of sessions.values()) review.reset() },
    dispose() { disposed = true; for (const review of sessions.values()) review.dispose(); sessions.clear() },
  }
}
