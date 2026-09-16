import { MessageChannel, parentPort } from 'node:worker_threads'

process.stderr.write('signal provenance marker\n')
const { port1, port2 } = new MessageChannel()
port2.on('message', message => {
  if (message?.type === 'stderr-marker') process.stderr.write('worker-client-stderr-marker\n')
})
parentPort.postMessage({ type: 'ready', port: port1 }, [port1])
parentPort.on('message', message => {
  if (message?.type !== 'shutdown') return
  port2.close()
  parentPort.postMessage({ type: 'shutdown-released' })
  parentPort.close()
})
