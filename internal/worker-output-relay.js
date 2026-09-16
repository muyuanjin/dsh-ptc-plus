/** Forward one worker output stream while honoring destination backpressure. */
export function relayWorkerOutput(source, destination) {
  if (source === null || source === undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let ended = false
    let pending = 0
    let settled = false
    let failure
    const finish = error => {
      if (error !== undefined) failure ??= error
      if (settled || (!ended && failure === undefined) || pending > 0) return
      settled = true
      if (failure === undefined) resolve()
      else reject(failure)
    }
    source.on('data', chunk => {
      source.pause()
      pending += 1
      destination.write(chunk, error => {
        pending -= 1
        if (error !== null && error !== undefined) { finish(error); return }
        if (failure === undefined) source.resume()
        finish()
      })
    })
    source.once('end', () => { ended = true; finish() })
    source.once('error', error => { ended = true; finish(error) })
  })
}
