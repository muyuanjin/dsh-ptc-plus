import './instrument-compiler-coverage.mjs'
import { workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { assignWorkerRealmProperty, WORKER_REALM_MUTATION } from '../internal/worker-realm-surfaces.js'

const entry = workerData.coverageEntry
delete workerData.coverageEntry
delete process.env.DSH_PTC_COMPILER_BYTECODE
assignWorkerRealmProperty(WORKER_REALM_MUTATION.RESTORE, 'process.argv entry', process.argv, '1', fileURLToPath(entry))
await import(entry)
