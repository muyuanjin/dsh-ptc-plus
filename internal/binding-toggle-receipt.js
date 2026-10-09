import { isPtcMessageSource, PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'

const PREFIX = 'Global binding configuration saved. This does not prove model catalog delivery or worker initialization:\n'

export function bindingToggleMessage(entry, revision) {
  const receipt = { schema: 'ptc-binding-toggle/v1', id: entry.id, name: entry.name, enabled: entry.enabled, revision }
  if (!valid(receipt)) throw new TypeError('invalid binding toggle receipt')
  return { source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'binding-toggle', receipt },
    content: [{ type: 'text', text: PREFIX + JSON.stringify(receipt) }] }
}

function valid(receipt) {
  return receipt?.schema === 'ptc-binding-toggle/v1' && typeof receipt.id === 'string' && receipt.id.length > 0
    && receipt.id.length <= 64 && typeof receipt.name === 'string' && receipt.name.length <= 256
    && typeof receipt.enabled === 'boolean' && Number.isSafeInteger(receipt.revision) && receipt.revision >= 0
    && Object.keys(receipt).length === 5
}

export function readBindingToggle(message) {
  const receipt = message?.source?.receipt
  return isPtcMessageSource(message?.source) && message.source.form === 'binding-toggle' && valid(receipt)
    && message.content?.length === 1 && message.content[0]?.type === 'text'
    && message.content[0].text === PREFIX + JSON.stringify(receipt) ? receipt : undefined
}
