import { basicSetup } from 'codemirror'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { tags } from '@lezer/highlight'

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: '20px', overflow: 'auto' },
  '.cm-content': { minHeight: '320px', padding: '10px 0', caretColor: 'var(--dsw-alias-label-primary)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { backgroundColor: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-tertiary)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover)' },
  '.cm-cursor': { borderLeftColor: 'var(--dsw-alias-label-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-interactive-primary, #4d6bfe) 22%, transparent)',
  },
  '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, #e3b24e 30%, transparent)' },
})

const editorHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: 'var(--ptc-code-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--ptc-code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--ptc-code-number)' },
  { tag: [tags.typeName, tags.className], color: 'var(--ptc-code-type)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--ptc-code-function)' },
  { tag: [tags.comment, tags.meta], color: 'var(--dsw-alias-label-tertiary)', fontStyle: 'italic' },
])

export function createTypeScriptEditor(React) {
  return function TypeScriptEditor({ value, onChange, disabled, label, documentId, onRun }) {
    const parent = React.useRef(null)
    const view = React.useRef(null)
    const latest = React.useRef({ value, onChange })
    const access = React.useRef(new Compartment())
    latest.current = { value, onChange, onRun }
    const accessExtensions = () => [EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]

    React.useLayoutEffect(() => {
      const editor = new EditorView({
        parent: parent.current,
        state: EditorState.create({ doc: value, extensions: [
          keymap.of([{ key: 'Mod-Enter', run: () => {
            if (!latest.current.onRun) return false
            void latest.current.onRun()
            return true
          } }]),
          basicSetup,
          javascript({ typescript: true }),
          editorTheme,
          syntaxHighlighting(editorHighlight),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          access.current.of(accessExtensions()),
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              const next = update.state.doc.toString()
              if (next !== latest.current.value) latest.current.onChange(next)
            }
          }),
        ] }),
      })
      view.current = editor
      return () => { view.current = null; editor.destroy() }
    }, [documentId])

    React.useLayoutEffect(() => {
      const editor = view.current
      const current = editor.state.doc.toString()
      if (current !== value) editor.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      })
    }, [value])
    React.useLayoutEffect(() => {
      view.current.dispatch({ effects: access.current.reconfigure(accessExtensions()) })
      view.current.contentDOM.setAttribute('aria-label', label)
    }, [disabled, label])
    return React.createElement('div', { className: 'ptcPlusCodeEditor', ref: parent })
  }
}
