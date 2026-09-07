const MAX_HISTORY_ENTRIES = 40
const MAX_HISTORY_CHARACTERS = 128 * 1024
const MAX_RECORD_CHARACTERS = MAX_HISTORY_CHARACTERS / 2

export function createBindingConsole(React, { TypeScriptEditor, IconButton, ActionButton, icons }) {
  const h = React.createElement
  return function BindingConsole({ source, entryId, resetVersion, callUserBindings, t }) {
    const [code, setCode] = React.useState('')
    const [records, setRecords] = React.useState([])
    const [running, setRunning] = React.useState(false)
    const [state, setState] = React.useState('ready')
    const [open, setOpen] = React.useState(true)
    const environment = React.useRef(null)
    const request = React.useRef(null)
    const idleTimer = React.useRef(null)
    const alive = React.useRef(false)
    const history = React.useRef(null)
    const release = () => {
      clearTimeout(idleTimer.current)
      const capability = environment.current
      environment.current = null
      request.current?.abort()
      if (capability !== null) void callUserBindings('console-release', { environment: capability }).catch(() => {})
    }
    React.useEffect(() => {
      alive.current = true
      return () => { alive.current = false; release() }
    }, [])
    React.useEffect(() => { release(); setState('ready') }, [resetVersion])
    React.useEffect(() => {
      if (history.current) history.current.scrollTop = history.current.scrollHeight
    }, [records, running])
    const append = record => setRecords(current => {
      const truncated = record.code.length + record.text.length > MAX_RECORD_CHARACTERS
      const code = record.code.slice(0, MAX_RECORD_CHARACTERS / 2)
      const bounded = { ...record, code, text: record.text.slice(0, MAX_RECORD_CHARACTERS - code.length),
        truncated: truncated || code.length < record.code.length }
      const next = [...current, bounded].slice(-MAX_HISTORY_ENTRIES)
      let length = next.reduce((total, item) => total + item.code.length + item.text.length, 0)
      while (next.length > 1 && length > MAX_HISTORY_CHARACTERS) {
        const removed = next.shift()
        length -= removed.code.length + removed.text.length
      }
      return next
    })
    const run = async () => {
      if (request.current !== null || code.trim() === '' || source.trim() === '') return
      clearTimeout(idleTimer.current)
      const controller = new AbortController()
      request.current = controller
      setRunning(true)
      setState('running')
      const submitted = code
      try {
        const result = await callUserBindings('console-run', {
          ...(environment.current === null ? {} : { environment: environment.current }), source, code: submitted,
        }, controller.signal)
        if (!alive.current || controller.signal.aborted) {
          if (result.environment) void callUserBindings('console-release', { environment: result.environment }).catch(() => {})
          if (alive.current) append({ code: submitted, text: t('execution.stopped'), error: true })
          return
        }
        environment.current = result.environment
        const text = [...result.logs.map(log => log.text), result.error ?? result.output ?? ''].join('\n')
        append({ code: submitted, text, error: result.error !== undefined,
          reset: result.reset, durationMs: result.durationMs })
        setCode('')
        setState(result.environment === null ? 'released' : 'ready')
        if (result.expiresAt !== null) idleTimer.current = setTimeout(() => {
          release()
          if (alive.current) setState('released')
        }, Math.max(0, result.expiresAt - Date.now()))
      } catch (error) {
        const stopped = controller.signal.aborted
        release()
        if (alive.current) {
          append({ code: submitted, text: stopped ? t('execution.stopped') : String(error), error: true })
          setState('released')
        }
      } finally {
        if (request.current === controller) request.current = null
        if (alive.current) setRunning(false)
      }
    }
    return h('details', { className: 'ptcPlusExecution', open, onToggle: event => setOpen(event.currentTarget.open) },
      h('summary', null, t('bindings.debug')),
      h('div', { className: 'ptcPlusExecutionToolbar' },
        h('span', { className: 'ptcPlusExecutionLanguage' }, 'TypeScript'),
        h('span', { className: 'ptcPlusExecutionState', role: 'status' }, t(`execution.${state}`)),
        h('div', { className: 'ptcPlusExecutionActions' },
          running
            ? h(ActionButton, { onClick: () => { release(); setState('released') } }, typeof icons.stop === 'function' ? h(icons.stop, { size: 14 }) : null, t('execution.stop'))
            : h(ActionButton, { 'data-kind': 'primary', onClick: run, disabled: !code.trim() || !source.trim() },
              typeof icons.play === 'function' ? h(icons.play, { size: 14 }) : null, t('bindings.run')),
          h(IconButton, { icon: icons.reset, label: t('execution.reset'), onClick: () => { release(); setState('ready') } }),
          h(IconButton, { icon: icons.clear, label: t('execution.clear'), onClick: () => setRecords([]) }))),
      h('div', { className: 'ptcPlusExecutionHistory', ref: history, 'aria-label': t('execution.history') },
        records.map((record, index) => h('div', { className: 'ptcPlusExecutionRecord', key: index },
          record.reset ? h('span', { className: 'ptcPlusMessage' }, t('execution.restarted')) : null,
          h('pre', { className: 'ptcPlusExecutionCommand' }, h('span', { 'aria-hidden': true }, '> '), record.code),
          h('div', { className: 'ptcPlusIoCard ptcPlusExecutionResult' },
            h('span', { className: 'ptcPlusExecutionOutputLabel' }, t('execution.output')),
            h('pre', { className: 'ptcPlusExecutionOutput', 'data-error': record.error,
              tabIndex: 0, 'aria-label': t('execution.output') }, record.text)),
          record.truncated ? h('span', { className: 'ptcPlusMessage' }, t('execution.truncated')) : null,
          record.durationMs === undefined ? null : h('span', { className: 'ptcPlusExecutionDuration' }, `${record.durationMs} ms`)))),
      h('div', { className: 'ptcPlusExecutionInput' }, open ? h(TypeScriptEditor, {
        documentId: entryId, value: code, onChange: setCode, disabled: running,
        label: t('execution.input'), onRun: run,
      }) : null))
  }
}
