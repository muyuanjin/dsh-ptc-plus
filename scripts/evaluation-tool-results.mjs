import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { decodeValue, encodeValue } from '../internal/value-wire.js'

export const name = 'ptc-evaluation-tool-results'
const SCHEMA = 'ptc-evaluation-tool-result/v1'
const MAX_RECORDS = 128
const MAX_STRING_CHARS = 2048
const MAX_FILE_BYTES = 1024 * 1024
const digest = text => createHash('sha256').update(text).digest('hex')
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const evidenceFile = (directory, sessionId) => join(directory, `${digest(sessionId)}.jsonl`)

/** Public tools/result is final and canonical; no policy or model projection is changed. */
export function apply(ctx, config) {
  if (typeof config?.directory !== 'string' || !isAbsolute(config.directory)) {
    throw new Error('evaluation tool-result directory must be absolute')
  }
  mkdirSync(config.directory, { recursive: true })
  let count = 0
  return ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'run_code' || exec.parent !== undefined) return
    const sessionId = exec.agent?.session?.id
    if (!identity(sessionId) || !identity(exec.callId) || exec.rootCallId !== exec.callId
      || typeof exec.arguments?.code !== 'string' || count >= MAX_RECORDS) return
    count += 1
    const body = result.value
    const canonical = result.isError === false && body !== null && typeof body === 'object'
      && !Array.isArray(body) && Array.isArray(body.logs) && body.logs.every(log => typeof log === 'string')
    const hasValue = canonical && Object.hasOwn(body, 'result')
    const returned = hasValue ? body.result : undefined
    const returnType = hasValue ? returned === null ? 'null' : typeof returned : 'absent'
    const complete = result.isError === true || canonical
      && (returnType !== 'string' || returned.length <= MAX_STRING_CHARS)
    const record = {
      schema: SCHEMA, sessionId, callId: exec.callId, rootCallId: exec.rootCallId,
      sourceSha256: digest(exec.arguments.code), resultError: result.isError === true,
      complete, hasValue, returnType,
      ...(canonical ? { logCount: body.logs.length } : {}),
      ...(complete && returnType === 'string' ? { value: returned } : {}),
    }
    // tools/result does not await listeners. Synchronous bounded persistence finishes
    // before notification returns; write failure leaves missing evidence, never a pass.
    try {
      appendFileSync(evidenceFile(config.directory, sessionId), `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // Missing sidecar evidence blocks evaluation; instrumentation cannot fail a tool.
    }
  })
}

function validRecord(record, sessionId) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false
  const keys = ['schema', 'sessionId', 'callId', 'rootCallId', 'sourceSha256', 'resultError',
    'complete', 'hasValue', 'returnType', 'logCount', 'value']
  return Object.keys(record).every(key => keys.includes(key)) && record.schema === SCHEMA
    && record.sessionId === sessionId && identity(record.callId) && record.rootCallId === record.callId
    && /^[0-9a-f]{64}$/.test(record.sourceSha256) && typeof record.resultError === 'boolean'
    && typeof record.complete === 'boolean' && typeof record.hasValue === 'boolean'
    && ['absent', 'string', 'number', 'boolean', 'object', 'null'].includes(record.returnType)
    && (record.hasValue === (record.returnType !== 'absent'))
    && (record.logCount === undefined || Number.isSafeInteger(record.logCount) && record.logCount >= 0)
    && (record.resultError ? !record.hasValue && record.logCount === undefined
      : !record.complete || record.logCount !== undefined)
    && (record.complete && record.returnType === 'string'
      ? typeof record.value === 'string' && record.value.length <= MAX_STRING_CHARS
      : !Object.hasOwn(record, 'value'))
}

/** Sidecars are runner-owned evidence, separate from the immutable durable Session log. */
export async function readEvaluationToolResults(directory, sessionId) {
  const incomplete = reason => ({ status: 'incomplete', reason })
  if (!identity(sessionId)) return incomplete('missing canonical result session identity')
  try {
    const file = evidenceFile(directory, sessionId)
    if ((await stat(file)).size > MAX_FILE_BYTES) return incomplete('canonical result evidence exceeds its bound')
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
    if (lines.length > MAX_RECORDS) return incomplete('canonical result evidence exceeds its record bound')
    const records = lines.map(line => JSON.parse(line))
    if (records.some(record => !validRecord(record, sessionId))) return incomplete('invalid canonical result evidence')
    if (new Set(records.map(record => record.callId)).size !== records.length) {
      return incomplete('duplicate canonical result call identity')
    }
    return { status: 'complete', sessionId, records }
  } catch {
    return incomplete('missing or unreadable canonical result evidence')
  }
}

export function canonicalRunCodeResults(analysis) {
  const retainWire = wire => Object.defineProperty({ status: 'complete', valueWire: wire }, 'value', {
    value: decodeValue(wire),
  })
  const calls = (analysis.timeline ?? []).filter(item => item.name === 'run_code')
  return calls.map(item => {
    if (item.resultError === true) return { status: 'fail', reason: 'run_code failed' }
    if (item.resultError !== false) return { status: 'incomplete', reason: 'missing run_code outcome' }
    const completion = item.completion
    if (completion !== undefined) {
      if (completion.kind !== 'return' || completion.hasValue !== true) {
        return { status: 'fail', reason: 'run_code did not return a value' }
      }
      try {
        return retainWire(completion.valueWire)
      } catch {
        return { status: 'incomplete', reason: 'missing or invalid canonical journal completion' }
      }
    }
    const evidence = analysis.canonicalToolResults
    if (evidence?.status !== 'complete' || evidence.sessionId !== analysis.session?.id
      || !Array.isArray(evidence.records)
      || evidence.records.some(record => !validRecord(record, evidence.sessionId))
      || new Set(evidence.records.map(record => record.callId)).size !== evidence.records.length
      || evidence.records.some(record => !calls.some(call => call.callId === record.callId))) {
      return { status: 'incomplete', reason: 'missing canonical run_code return evidence' }
    }
    const records = evidence.records.filter(record => record.callId === item.callId)
    if (records.length !== 1 || !validRecord(records[0], evidence.sessionId)
      || typeof item.code !== 'string' || records[0].sourceSha256 !== digest(item.code)
      || records[0].resultError !== item.resultError || records[0].complete !== true) {
      return { status: 'incomplete', reason: 'unproved canonical run_code result identity or completeness' }
    }
    const record = records[0]
    if (!record.hasValue || record.returnType !== 'string') {
      return { status: 'fail', reason: 'run_code did not return a string' }
    }
    return retainWire(encodeValue(record.value))
  })
}
