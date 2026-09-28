import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const MOCK_PRELOAD_FILE_NAMES = new Set([
  'isolated-worker.test.js',
  'session-runtime-faults.test.js',
  'user-binding-console-transport.test.js',
  'user-bindings-owner-faults.test.js',
])

export async function backendTestFiles(root) {
  return (await readdir(join(root, 'test')))
    .filter(name => name.endsWith('.test.js'))
    .map(name => `test/${name}`)
    .sort()
}

export function splitBackendTestFiles(files) {
  return {
    mockPreload: files.filter(file => MOCK_PRELOAD_FILE_NAMES.has(basename(file))),
    ordinary: files.filter(file => !MOCK_PRELOAD_FILE_NAMES.has(basename(file))),
  }
}
