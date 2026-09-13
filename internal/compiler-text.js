import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** Exact source facts cross the compiler boundary as strings, never buffers. */
export function hashText(source, encoding = 'utf8', format = 'base64') {
  return createHash('sha256').update(source, encoding).digest(format)
}

export function deflateText(source) {
  return deflateRawSync(Buffer.from(source, 'utf16le')).toString('base64')
}

export function inflateText(encoded, maxOutputBytes) {
  return inflateRawSync(Buffer.from(encoded, 'base64'), { maxOutputLength: maxOutputBytes }).toString('utf16le')
}
