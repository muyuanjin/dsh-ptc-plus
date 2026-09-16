import repl from 'node:repl'

// Test-only bad runtime: its eval forces every error to be formatted through
// error.stack, which exercises the kernel-worker startup probe's stack getter.
const originalStart = repl.start
repl.start = function (...args) {
  const server = originalStart.apply(this, args)
  const originalEval = server.eval
  server.eval = function (code, context, filename, callback) {
    const probe = context?.__ptc_settlement_probe__
    if (probe !== null && (typeof probe === 'object' || typeof probe === 'function') && 'stack' in probe) {
      void probe.stack
    }
    return originalEval.call(this, code, context, filename, callback)
  }
  return server
}

await import('../../internal/kernel-worker.js')
