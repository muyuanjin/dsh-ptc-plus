import { readBindingToggle } from '../internal/binding-toggle-receipt.js'

/** A separate Chat node keeps configuration receipts distinct from ordinary hidden contexts. */
export const bindingToggleConversationDefinition = Object.freeze({
  kind: 'ptc-plus-binding-toggle', target: 'chat',
  match(event) {
    return event.type === 'user/message' && event.surfaceOp === 'append' && readBindingToggle(event.data)
      ? { id: event.data.id, role: 'start' } : null
  },
  start(_context, match) { return { seq: match.event.seq, receipt: readBindingToggle(match.event.data) } },
  update(context) { return context.state },
  buildViewNode(context) {
    if (!context.state?.receipt) return null
    return { key: context.key, id: context.id, kind: 'ptc-plus-binding-toggle', target: 'chat',
      anchorSeq: context.state.seq, location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible', data: context.state.receipt }
  },
})
