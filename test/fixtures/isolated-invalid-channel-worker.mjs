import { parentPort } from 'node:worker_threads'

// The helper must reject a ready handshake that does not carry a usable port.
parentPort.postMessage({ type: 'ready', port: {} })
