import { blankBinding, editableBinding, bindingPayload } from './client-bindings-data.js'
import { isHostIconComponent } from './client-host-compat.js'

/**
 * User Bindings workbench. The controller owns every piece of edit state in one
 * reducer: selection, the stored identity it was loaded from, the revision the
 * next write is compared against, the editor document identity and the draft.
 * Async responses carry the generation they started in, so a late response can
 * never overwrite a newer selection, and the document identity only changes when
 * the edited document itself changes - never because draft.id was retyped.
 * Callers keep the controller in a stable owner so hiding the dialog does not
 * discard an unsaved draft.
 */
export function createUserBindingsWorkbench(React, deps) {
  const { TypeScriptEditor, BindingConsole, IconButton, ActionButton, CodeBlock, Modal, icons, catalogOwner } = deps
  const h = React.createElement

  const initialState = Object.freeze({
    documentId: 0,
    consoleVersion: 0,
    catalog: null,
    catalogStatus: 'loading',
    catalogError: null,
    draft: null,
    declaration: '',
    original: null,
    revision: null,
    editing: false,
    creating: false,
    query: '',
    importPath: '',
    sourceOpen: false,
    metadataOpen: false,
    message: null,
    busy: false,
  })

  // Selection keeps the document identity when the same stored entry stays in the
  // editor; a replaced source releases the console environment instead. Loading a
  // stored entry or clearing the editor always ends the new-draft mode, so a later
  // reload or cancel of that unchanged entry is not mistaken for a different document.
  const selectDocument = (state, loaded, resetConsole) => {
    const entry = loaded?.entry ?? null
    const sameDocument = entry !== null && state.draft !== null && !state.creating
      && state.original?.id === entry.id
    const replaced = resetConsole !== false && state.draft?.source !== entry?.source
    return {
      ...state,
      documentId: sameDocument ? state.documentId : state.documentId + 1,
      consoleVersion: replaced ? state.consoleVersion + 1 : state.consoleVersion,
      draft: entry === null ? null : editableBinding(entry),
      original: entry,
      declaration: entry?.declaration ?? '',
      revision: loaded?.revision ?? null,
      editing: false,
      creating: false,
    }
  }

  // The reducer is a pure function of the actions it is handed; stale async
  // responses are dropped before dispatch, never inside the reducer.
  function reducer(state, action) {
    switch (action.type) {
      case 'begin':
        return { ...state, busy: true, message: null }
      case 'settle':
        return { ...state, busy: false }
      case 'failed':
        return { ...state, message: action.message }
      case 'catalog':
        // A failed read reports its error but keeps the last good catalog, so the
        // surface stays usable and the message area owns the failure.
        return { ...state, catalog: action.snapshot.catalog ?? state.catalog,
          catalogStatus: action.snapshot.status, catalogError: action.snapshot.error }
      case 'patch':
        return { ...state, ...action.patch }
      case 'loaded':
        return selectDocument(state, action.loaded, action.resetConsole)
      case 'create':
        return { ...state,
          documentId: state.documentId + 1, consoleVersion: state.consoleVersion + 1,
          draft: blankBinding(), original: null, revision: action.revision, editing: true, creating: true,
          sourceOpen: true, metadataOpen: true, declaration: '', message: null, busy: false }
      case 'edit':
        return { ...state, draft: { ...state.draft, [action.key]: action.value }, editing: true,
          message: null, declaration: action.key === 'modelContext' ? state.declaration : '' }
      case 'validated':
        return { ...state, draft: editableBinding(action.normalized),
          declaration: action.normalized.declaration ?? '', message: { key: 'bindings.valid' } }
      case 'saved':
        return { ...state, catalog: action.next, catalogStatus: 'ready', catalogError: null,
          documentId: state.draft?.id === action.normalized.id ? state.documentId : state.documentId + 1,
          consoleVersion: state.original?.source !== action.normalized.source
            ? state.consoleVersion + 1 : state.consoleVersion,
          draft: editableBinding(action.normalized), declaration: action.normalized.declaration ?? '',
          message: { key: 'bindings.saved' }, original: action.normalized,
          revision: action.next.revision, editing: false, creating: false, sourceOpen: false }
      case 'mutated': {
        const next = { ...state, catalog: action.next, catalogStatus: 'ready', catalogError: null,
          // A successful CAS on this baseline proves metadata-only changes preserve its source.
          revision: state.revision === state.catalog?.revision ? action.next.revision : state.revision }
        // The response catalog, not the entry the request started from, is the
        // confirmed stored state; only that field changes, so unsaved edits stay.
        const stored = action.entry === undefined ? undefined
          : action.next.entries.find(entry => entry.id === action.entry.id)
        if (stored !== undefined && state.draft?.id === stored.id) {
          next.draft = { ...state.draft, enabled: stored.enabled }
          next.original = state.original === null ? null : { ...state.original, enabled: stored.enabled }
        }
        if (action.removed === true && state.draft?.id === action.entry.id) {
          next.draft = null
          next.original = null
          next.declaration = ''
          next.revision = null
          next.editing = false
          // The removed entry was the edited document; no new draft survives it.
          next.creating = false
          next.documentId = state.documentId + 1
          next.consoleVersion = state.consoleVersion + 1
        }
        if (action.imported === true) next.importPath = ''
        next.message = action.removed === true ? { key: 'bindings.removed' }
          : action.imported === true ? { key: 'bindings.imported' } : state.message
        return next
      }
      case 'reloadResult': {
        if (action.loaded !== null && action.loaded.revision !== action.next.revision) {
          return { ...state, message: { key: 'bindings.reloadConflict' } }
        }
        const base = { ...state, catalog: action.next, catalogStatus: 'ready', catalogError: null }
        if (state.editing) {
          // Keep the unsaved draft; only its stored identity and baseline are refreshed.
          // An entry that disappeared externally keeps its identity, so the next save
          // is still an update of that entry and never an implicit creation.
          return { ...base, original: action.loaded?.entry ?? state.original,
            revision: action.loaded?.revision ?? action.next.revision,
            message: { key: 'bindings.reloadedDraft' } }
        }
        return { ...selectDocument(base, action.loaded, true), message: { key: 'bindings.reloaded' } }
      }
      case 'reset':
        return { ...initialState, documentId: state.documentId + 1,
          consoleVersion: state.consoleVersion + 1 }
      default:
        return state
    }
  }

  // `enabled` owns the management session: disabling it releases the draft and
  // invalidates every in-flight response, so a closed or disabled surface is
  // never completed by a late answer. `active` only suspends reads while a
  // temporary Host takeover hides the surface.
  function useWorkbenchController({ enabled, active = true, callUserBindings }) {
    const [state, dispatch] = React.useReducer(reducer, initialState)
    const generation = React.useRef(0)
    // The generation that holds the single-flight lock, or null while free.
    const running = React.useRef(null)
    const autoLoaded = React.useRef(false)
    const source = React.useMemo(() => catalogOwner.claim(), [catalogOwner])
    const snapshot = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
    React.useEffect(() => () => {
      // A response arriving after this owner is gone must not dispatch.
      generation.current += 1
      source.release()
    }, [source])
    React.useEffect(() => {
      dispatch({ type: 'catalog', snapshot })
      // A read that fails on the shared source is this surface's failure too.
      if (snapshot.status === 'error' && snapshot.error !== null) {
        dispatch({ type: 'failed', message: { key: 'bindings.failed', params: { error: snapshot.error } } })
      }
    }, [snapshot])

    // One operation at a time. Every response carries the generation it started
    // in, so a late answer can never overwrite a newer selection or a new draft.
    // A lock held by a released generation does not block the surface that
    // replaced it; the released request still settles as a dropped answer.
    const perform = React.useCallback(async operation => {
      if (running.current === generation.current) return
      const current = ++generation.current
      running.current = current
      const alive = () => current === generation.current
      dispatch({ type: 'begin' })
      try {
        await operation(alive)
      } catch (error) {
        if (alive()) dispatch({ type: 'failed', message: {
          key: 'bindings.failed',
          params: { error: error instanceof Error ? error.message : String(error) },
        } })
      } finally {
        if (running.current === current) running.current = null
        if (alive()) dispatch({ type: 'settle' })
      }
    }, [])

    const load = React.useCallback(id => perform(async alive => {
      const loaded = await callUserBindings('load', { id })
      if (!alive()) return
      dispatch({ type: 'loaded', loaded, resetConsole: true })
    }), [perform, callUserBindings])

    React.useEffect(() => {
      if (!enabled) {
        autoLoaded.current = false
        generation.current += 1
        source.reset()
        dispatch({ type: 'reset' })
        return
      }
      if (!active) return
      // Re-entering the surface re-reads the catalog, but keeps the draft it left behind.
      autoLoaded.current = false
      void source.read()
    }, [enabled, active, source])

    React.useEffect(() => {
      if (!enabled || !active || autoLoaded.current) return
      if (state.draft !== null || state.original !== null) {
        autoLoaded.current = true
        return
      }
      const entries = snapshot.status === 'ready' ? snapshot.catalog?.entries : undefined
      if (entries === undefined || entries.length === 0) return
      autoLoaded.current = true
      void load(entries[0].id)
    }, [enabled, active, snapshot, state.draft, state.original, load])

    const edit = (key, value) => dispatch({ type: 'edit', key, value })
    const patch = value => dispatch({ type: 'patch', patch: value })
    // A new draft is saved against the catalog revision it was created from, so
    // creation needs a confirmed one. The last good catalog stays usable while a
    // refresh is in flight or fails, and an empty catalog is a valid baseline
    // (revision 0); a first read that has not answered, or failed, is not. The
    // button and the transition consume this one predicate.
    const catalogRevision = state.catalog !== null && Number.isInteger(state.catalog.revision)
      ? state.catalog.revision : null
    const canCreate = catalogRevision !== null && !state.busy && !state.editing
    const create = () => {
      if (!canCreate) return
      generation.current += 1
      dispatch({ type: 'create', revision: catalogRevision })
    }
    const cancel = () => {
      dispatch({ type: 'loaded', loaded: state.original === null ? null : { entry: state.original, revision: state.revision },
        resetConsole: false })
      patch({ sourceOpen: false, message: null })
    }
    const validate = () => perform(async alive => {
      const normalized = await callUserBindings('validate', { entry: bindingPayload(state.draft) })
      if (!alive()) return
      dispatch({ type: 'validated', normalized })
    })
    const save = () => perform(async alive => {
      const normalized = await callUserBindings('validate', { entry: bindingPayload(state.draft) })
      if (!alive()) return
      // Creating and editing are different host operations: a create may not
      // silently take over an existing entry, and an edit may only rewrite the
      // entry it was loaded from.
      const next = await callUserBindings('save', {
        intent: state.original === null ? 'create' : 'update',
        originalId: state.original?.id ?? null,
        entry: bindingPayload(editableBinding(normalized)),
        expectedRevision: state.revision,
      })
      if (!alive()) return
      source.accept(next)
      dispatch({ type: 'saved', normalized, next })
    })
    const reload = () => perform(async alive => {
      const next = await source.read({ reload: true })
      if (next === undefined || !alive()) return
      const selected = next.entries.find(entry => entry.id === state.original?.id)
      const loaded = selected === undefined ? null : await callUserBindings('load', { id: selected.id })
      if (!alive()) return
      dispatch({ type: 'reloadResult', next, loaded })
    })
    const toggle = entry => perform(async alive => {
      const next = await callUserBindings(entry.enabled ? 'disable' : 'enable', {
        id: entry.id, expectedRevision: state.catalog.revision,
      })
      if (!alive()) return
      source.accept(next)
      dispatch({ type: 'mutated', next, entry })
    })
    const remove = entry => perform(async alive => {
      const next = await callUserBindings('remove', {
        id: entry.id, expectedRevision: state.catalog.revision,
      })
      if (!alive()) return
      source.accept(next)
      dispatch({ type: 'mutated', next, entry, removed: true })
    })
    const importSource = () => perform(async alive => {
      const next = await callUserBindings('import', {
        path: state.importPath, expectedRevision: state.catalog.revision,
      })
      if (!alive()) return
      source.accept(next)
      dispatch({ type: 'mutated', next, imported: true })
    })

    return { state, source, snapshot, callUserBindings, canCreate, edit, patch, create, cancel, load,
      validate, save, reload, toggle, remove, importSource }
  }

  function UserBindingsWorkbench({ controller, enabled = true, t, heading = true, headingLabel }) {
    const { state, canCreate } = controller
    const { edit, patch, create, cancel, load, validate, save, reload, toggle, remove, importSource } = controller
    if (!enabled) return null
    const visibleEntries = state.catalog?.entries.filter(entry =>
      entry.name.toLowerCase().includes(state.query.trim().toLowerCase())) ?? []
    return h('section', { className: 'ptcPlusBindings', 'aria-label': t('bindings.title'), 'aria-busy': state.busy },
      h('div', { className: 'ptcPlusBindingsHead' },
        heading ? h('h3', { className: 'ptcPlusBindingsTitle' }, headingLabel ?? t('bindings.title')) : h('span'),
        h('div', { className: 'ptcPlusBindingsActions' },
          h(IconButton, {
            icon: icons.refresh, label: t('bindings.reload'), disabled: state.busy,
            onClick: reload,
          }),
          h(ActionButton, {
            type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary', disabled: !canCreate,
            onClick: create,
          }, isHostIconComponent(icons.plus) ? h(icons.plus, { size: 16 }) : null, t('bindings.new')))),
      state.catalog === null
        ? h('p', {
            // A failed read publishes its error on the shared source; without it
            // the surface would keep announcing that it is still loading.
            className: `ptcPlusMessage${state.message === null && state.catalogError === null ? '' : ' ptcPlusDanger'}`,
            role: state.message === null && state.catalogError === null ? undefined : 'status',
          }, state.message !== null ? t(state.message.key, state.message.params)
            : state.catalogError !== null ? t('bindings.failed', { error: state.catalogError })
            : t('bindings.loading'))
        : h('div', { className: 'ptcPlusBindingsGrid' },
            h('div', { className: 'ptcPlusBindingPane' },
              h('label', { className: 'ptcPlusSearch' },
                isHostIconComponent(icons.search) ? h(icons.search, { size: 16 }) : null,
                h('input', { value: state.query, onChange: event => patch({ query: event.target.value }),
                  placeholder: t('bindings.search'), 'aria-label': t('bindings.search') })),
              state.catalog.error === undefined
                ? null
                : h('p', { className: 'ptcPlusMessage ptcPlusDanger' }, state.catalog.error),
              state.catalog.entries.length === 0
                ? h('p', { className: 'ptcPlusMessage' }, t('bindings.empty'))
                : h('ul', { className: 'ptcPlusBindingList' }, visibleEntries.map(entry => (
                    h('li', {
                      key: entry.id, className: 'ptcPlusBindingItem',
                      'data-selected': state.draft?.id === entry.id ? true : undefined,
                    },
                      h('button', {
                        type: 'button', className: 'ptcPlusBindingSelect', disabled: state.busy || state.editing,
                        onClick: () => load(entry.id),
                      },
                      h('span', { className: 'ptcPlusBindingName', title: entry.name }, entry.name),
                      h('span', { className: 'ptcPlusBindingMeta', title: entry.symbols.join(', ') }, entry.scope)),
                      h('button', {
                        type: 'button', className: 'ptcPlusBindingSwitch', role: 'switch',
                        disabled: state.busy || state.editing, 'aria-checked': entry.enabled,
                        'aria-label': `${entry.name}: ${t('bindings.enabled')}`,
                        title: t(entry.enabled ? 'bindings.disableAction' : 'bindings.enableAction'),
                        onClick: () => toggle(entry),
                      }, h('span', { 'aria-hidden': true })))
                  ))),
              state.catalog.entries.length > 0 && visibleEntries.length === 0
                ? h('p', { className: 'ptcPlusMessage' }, t('console.noMatches')) : null,
              h('div', { className: 'ptcPlusBindingRun' },
                h('input', {
                  className: 'ptcPlusInput', value: state.importPath, disabled: state.busy,
                  placeholder: t('bindings.importPath'), 'aria-label': t('bindings.importPath'),
                  onChange: event => patch({ importPath: event.target.value }),
                }),
                h(ActionButton, {
                  type: 'button', className: 'ptcPlusButton',
                  disabled: state.busy || state.editing || state.importPath.trim() === '', onClick: importSource,
                }, t('bindings.import')))),
            state.draft === null ? null : h('div', { className: 'ptcPlusBindingEditor' },
              h('div', { className: 'ptcPlusEditorHead' },
                h('strong', { className: 'ptcPlusEditorFile' }, state.draft.name || t('bindings.new')),
                h('div', { className: 'ptcPlusBindingLifecycle' },
                  state.editing ? h(React.Fragment, null,
                    h(ActionButton, { disabled: state.busy, onClick: validate },
                      h(icons.check, { size: 14 }), t('bindings.validate')),
                    h(ActionButton, { 'data-kind': 'primary', disabled: state.busy, onClick: save }, t('bindings.save')),
                    h(ActionButton, { disabled: state.busy, onClick: cancel }, t('bindings.cancel'))) : null,
                  state.catalog.entries.some(entry => entry.id === state.draft.id)
                    ? h(IconButton, {
                        icon: icons.trash, label: t('bindings.remove'), 'data-kind': 'danger',
                        disabled: state.busy || state.editing, onClick: () => remove(state.draft),
                      })
                    : null)),
              h('details', { className: 'ptcPlusBindingSection ptcPlusBindingSourcePreview', open: true },
                h('summary', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.declaration')),
                state.declaration === '' ? h('p', { className: 'ptcPlusMessage' }, t('bindings.unvalidated'))
                  : typeof CodeBlock === 'function'
                    ? h(CodeBlock, { code: state.declaration, lang: 'typescript', className: 'ptcPlusCodeBlock',
                      copyLabel: t('tool.copy'), copiedLabel: t('tool.copied') })
                    : h('pre', { className: 'ptcPlusDeclaration' }, state.declaration)),
              h('section', { className: 'ptcPlusBindingSection ptcPlusModelPrompt' },
                h('h4', { className: 'ptcPlusBindingSectionTitle' }, t('bindings.modelContext')),
                h('div', { className: 'ptcPlusBindingFields' },
                  h('label', { className: 'ptcPlusBindingField ptcPlusPromptToggle', 'data-wide': true },
                    h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.includeDeclaration')),
                    h('input', { className: 'ptcPlusCheck', type: 'checkbox', checked: state.draft.modelContext.includeDeclaration, disabled: state.busy,
                      onChange: event => edit('modelContext', { ...state.draft.modelContext, includeDeclaration: event.target.checked }) })),
                  h('label', { className: 'ptcPlusBindingField', 'data-wide': true },
                    h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.instructions')),
                    h('textarea', { className: 'ptcPlusInput', rows: 3, maxLength: 4096,
                      value: state.draft.modelContext.instructions, disabled: state.busy,
                      onChange: event => edit('modelContext', { ...state.draft.modelContext, instructions: event.target.value }) })))),
              h('div', { className: 'ptcPlusSourceSection' },
                h('button', { type: 'button', className: 'ptcPlusSourceToggle',
                  'aria-expanded': state.sourceOpen, onClick: () => patch({ sourceOpen: !state.sourceOpen }) },
                  h(icons.chevron, { size: 14, style: { transform: state.sourceOpen ? undefined : 'rotate(-90deg)' } }),
                  t('bindings.sourcePreview'),
                  h('span', { className: 'ptcPlusSourceFilename' }, state.draft.name ? `${state.draft.name}.ts` : '')),
                h('div', { className: 'ptcPlusSourceActions' }, state.editing ? null
                  : h(ActionButton, { disabled: state.busy, onClick: () => patch({ editing: true, sourceOpen: true }) },
                    isHostIconComponent(icons.edit) ? h(icons.edit, { size: 14 }) : null, t('bindings.edit'))),
                h('div', { className: 'ptcPlusSourceBody', hidden: !state.sourceOpen },
                  state.editing
                    ? h(TypeScriptEditor, { documentId: state.documentId, value: state.draft.source, disabled: state.busy,
                      label: t('bindings.source'), onChange: value => edit('source', value) })
                    : state.sourceOpen && typeof CodeBlock === 'function'
                      ? h(CodeBlock, { code: state.draft.source, lang: 'typescript', className: 'ptcPlusSourceCode',
                        copyLabel: t('tool.copy'), copiedLabel: t('tool.copied') })
                      : state.sourceOpen ? h('pre', { className: 'ptcPlusSourceCode' }, state.draft.source) : null)),
              h('div', { className: 'ptcPlusWorkbenchFeedback', role: 'status' },
                state.busy ? t('bindings.working')
                  : state.message === null ? '' : t(state.message.key, state.message.params)),
              h(BindingConsole, { key: state.documentId, entryId: `workbench:${state.documentId}`,
                source: state.draft.source, resetVersion: state.consoleVersion,
                callUserBindings: controller.callUserBindings, t }),
              h('details', { className: 'ptcPlusBindingSection ptcPlusEntrySettings', open: state.metadataOpen,
                onToggle: event => patch({ metadataOpen: event.currentTarget.open }) },
                h('summary', { className: 'ptcPlusBindingSectionTitle' }, t('bindings.entry')),
                h('div', { className: 'ptcPlusBindingFields' },
                  h('label', { className: 'ptcPlusBindingField' },
                    h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.id')),
                    h('input', {
                      className: 'ptcPlusInput', value: state.draft.id,
                      // A stored entry is addressed by this id; only a new draft may choose it.
                      disabled: state.busy || !state.editing || state.original !== null,
                      onChange: event => edit('id', event.target.value),
                    })),
                  h('label', { className: 'ptcPlusBindingField' },
                    h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.name')),
                    h('input', {
                      className: 'ptcPlusInput', value: state.draft.name, disabled: state.busy || !state.editing,
                      onChange: event => edit('name', event.target.value),
                    })),
                  h('label', { className: 'ptcPlusBindingField' },
                    h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.scope')),
                    h('select', {
                      className: 'ptcPlusSelect', value: state.draft.scope, disabled: state.busy || !state.editing,
                      onChange: event => edit('scope', event.target.value),
                    }, h('option', { value: 'namespace' }, 'namespace'), h('option', { value: 'top-level' }, 'top-level'))),
                  h('label', { className: 'ptcPlusBindingField' },
                    h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.symbols')),
                    h('input', {
                      className: 'ptcPlusInput', value: state.draft.symbolsText, disabled: state.busy || !state.editing,
                      placeholder: t('bindings.symbolsPlaceholder'),
                      onChange: event => edit('symbolsText', event.target.value),
                    })),
                  h('label', { className: 'ptcPlusBindingField', 'data-wide': true },
                    h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.purpose')),
                    h('input', {
                      className: 'ptcPlusInput', value: state.draft.purpose, disabled: state.busy || !state.editing,
                      onChange: event => edit('purpose', event.target.value),
                    }))))),
            state.message === null || state.draft !== null
              ? null
              : h('p', { className: 'ptcPlusMessage', role: 'status' }, t(state.message.key, state.message.params))))
  }

  function canReturnFocus(element) {
    return element instanceof HTMLElement && element.isConnected
      && element !== document.body && (element.tabIndex >= 0 || element.isContentEditable)
      && !element.matches(':disabled, [aria-disabled="true"]')
      && !element.closest('[hidden], [inert], [aria-hidden="true"]')
      && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible'
  }

  function BindingsDialog({ controller, t, onClose, returnFocusRef, getReturnFocus }) {
    const content = React.useRef(null)
    const localReturnFocus = React.useRef(null)
    const returnFocus = returnFocusRef ?? localReturnFocus
    React.useEffect(() => {
      const previous = document.activeElement
      // A resumed mount may have no focused control; keep the last valid entry.
      if (!content.current.contains(previous) && canReturnFocus(previous)) returnFocus.current = previous
      content.current.querySelector('button')?.focus()
    }, [returnFocus])
    const close = () => {
      const target = canReturnFocus(returnFocus.current) ? returnFocus.current : getReturnFocus?.()
      returnFocus.current = null
      onClose()
      // Only explicit closure restores focus. Temporary hiding leaves Host focus alone.
      if (canReturnFocus(target)) target.focus({ preventScroll: true })
    }
    const trapFocus = event => {
      if (event.key !== 'Tab') return
      const controls = [...content.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[contenteditable=true],summary')]
        .filter(element => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls.at(-1)
      if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus()
      }
    }
    return h(Modal, { open: true, onClose: close, title: t('bindings.title'), headless: true, className: 'ptcPlusBindingsModal' },
      h('div', { className: 'ptcPlusBindingsDialog', ref: content, onKeyDown: trapFocus },
        h('div', { className: 'ptcPlusBindingsDialogHead' },
          h('h2', null, t('bindings.title')),
          h('button', { type: 'button', className: 'ptcPlusDialogClose', onClick: close,
            'aria-label': t('bindings.close'), title: t('bindings.close') }, h(icons.close, { size: 16 }))),
        h('div', { className: 'ptcPlusBindingsSurface' },
          h(UserBindingsWorkbench, { controller, t, heading: false }))))
  }

  return { useWorkbenchController, UserBindingsWorkbench, BindingsDialog }
}
