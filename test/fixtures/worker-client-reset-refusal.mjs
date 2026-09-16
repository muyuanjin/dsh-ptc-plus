import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { WorkerClient } from '../../internal/worker-client.js'
import { IsolatedOwner } from '../../internal/isolated-worker.js'

const mode = process.argv[2] ?? 'startup-error'
const unhandled = []
const listener = error => unhandled.push(error.message)
process.on('unhandledRejection', listener)

const client = new WorkerClient({
  workerUrl: new URL('file:///unused-worker.mjs'),
  cwd: process.cwd(),
  onMessage() {},
  onFailure() {},
})
const transport = new EventEmitter()
transport.stdout = new PassThrough()
transport.stderr = new PassThrough()
transport.terminate = async () => { throw new Error('probe refused reclamation') }
client.owner = new IsolatedOwner({
  create() {
    setImmediate(() => transport.emit('message', mode === 'invalid-channel'
      ? { type: 'ready', port: {} }
      : { type: 'startup-error', error: 'probe startup failed' }))
    return transport
  },
})

let startupError
try {
  await client.ensure(64)
} catch (error) {
  startupError = error.message
}
// A refused reset must not surface after the caller already handled startup.
await new Promise(resolve => setImmediate(resolve))
await new Promise(resolve => setImmediate(resolve))
console.log(JSON.stringify({ startupError, unhandled, retained: client.owner.instances.size }))

try { await client.dispose() } catch {}
const scratch = await client.scratchReady
await rm(scratch, { recursive: true, force: true })
process.off('unhandledRejection', listener)
