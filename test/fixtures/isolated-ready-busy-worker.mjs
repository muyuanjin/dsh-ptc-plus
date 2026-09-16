import { MessageChannel, parentPort } from 'node:worker_threads'

// Finish measurable startup work before the helper's ready handshake. The host
// must use the utilization sample carried by that handshake, not an older cache.
const deadline = performance.now() + 135
while (performance.now() < deadline) {
  // Deliberately synchronous: this is the startup work the ready baseline must
  // exclude from a later cell's compute budget.
}
const { port1 } = new MessageChannel()
parentPort.postMessage({ type: 'ready', port: port1 }, [port1])
parentPort.on('message', message => {
  if (message?.type !== 'shutdown') return
  port1.close()
  parentPort.postMessage({ type: 'shutdown-released' })
  parentPort.close()
})
