import { bindingModelPreferences } from '../internal/user-binding-model-context.js'

      const blankBinding = () => ({
        id: '',
        name: '',
        scope: 'namespace',
        symbolsText: '',
        purpose: '',
        enabled: false,
        source: 'export function helper() {\n  return undefined\n}\n',
        modelContext: bindingModelPreferences(),
      })
      const editableBinding = value => ({
        id: value.id,
        name: value.name,
        scope: value.scope,
        symbolsText: Array.isArray(value.symbols) ? value.symbols.join(', ') : '',
        purpose: value.purpose,
        enabled: value.enabled,
        source: value.source,
        modelContext: bindingModelPreferences(value.modelContext),
      })
      const bindingPayload = (value) => {
        const { symbolsText, ...entry } = value
        const symbols = symbolsText.split(',').map(symbol => symbol.trim()).filter(Boolean)
        return symbols.length === 0 ? entry : { ...entry, symbols }
      }

export { blankBinding, editableBinding, bindingPayload }
