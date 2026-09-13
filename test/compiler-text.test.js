import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { deflateText, inflateText } from '../internal/compiler-text.js'

test('compiler text retains exact UTF-16 code units within an explicit inflation bound', () => {
  const source = 'source\ud800😀雪\r\n\udc00'.repeat(32)
  const encoded = deflateText(source)
  assert.deepEqual(inflateRawSync(Buffer.from(encoded,'base64')),Buffer.from(source,'utf16le'))
  assert.equal(inflateText(encoded,source.length * 2),source)
  assert.throws(()=>inflateText(encoded,source.length * 2 - 1),{code:'ERR_BUFFER_TOO_LARGE'})
})
