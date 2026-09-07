import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  createUserBindingsSnapshot,
  normalizeUserBindingEntry,
  normalizeUserBindingsDocument,
  storedUserBindingsDocument,
  USER_BINDING_ID_MAX_LENGTH,
} from './user-bindings.js'

const EMPTY_DOCUMENT = Object.freeze({ entries: Object.freeze([]) })

function isENOENT(error) {
  return error?.code === 'ENOENT'
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function observedDocumentError(error, text) {
  Object.defineProperty(error, 'observedText', { value: text })
  return error
}

function documentText(document) {
  return `${JSON.stringify(storedUserBindingsDocument(document), null, 2)}\n`
}

function parseDocument(text, filename) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw observedDocumentError(
      new SyntaxError(`invalid bindings document at ${filename}: ${messageOf(error)}`),
      text,
    )
  }
  try {
    const document = normalizeUserBindingsDocument(value)
    createUserBindingsSnapshot(value)
    return document
  } catch (error) {
    throw observedDocumentError(
      new TypeError(`invalid bindings document at ${filename}: ${messageOf(error)}`),
      text,
    )
  }
}

async function readDocument(filename) {
  try {
    const text = await readFile(filename, 'utf8')
    return { document: parseDocument(text, filename), text }
  } catch (error) {
    if (isENOENT(error)) return { document: EMPTY_DOCUMENT, text: undefined }
    throw error
  }
}

function entryView(entry, includeSource = false) {
  return Object.freeze({
    id: entry.id,
    name: entry.name,
    scope: entry.scope,
    symbols: Object.freeze([...entry.symbols]),
    purpose: entry.purpose,
    origin: 'global',
    enabled: entry.enabled,
    declaration: entry.declaration,
    ...(entry.modelContext === undefined ? {} : { modelContext: entry.modelContext }),
    ...(includeSource ? { source: entry.source } : {}),
  })
}

function importedId(path, entries) {
  const rawStem = basename(path, extname(path)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'binding'
  const ids = new Set(entries.map(entry => entry.id))
  const stem = rawStem.slice(0, USER_BINDING_ID_MAX_LENGTH)
  if (!ids.has(stem)) return stem
  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}`
    const candidate = `${rawStem.slice(0, USER_BINDING_ID_MAX_LENGTH - ending.length)}${ending}`
    if (!ids.has(candidate)) return candidate
  }
}

function importedName(path) {
  const stem = basename(path, extname(path)).replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^[^A-Za-z_$]+/, '')
  return stem || 'bindings'
}

async function refreshStore(store) {
  try {
    const loaded = await readDocument(store.filename)
    store.document = loaded.document
    store.text = loaded.text
    store.error = undefined
  } catch (error) {
    store.document = EMPTY_DOCUMENT
    store.text = typeof error?.observedText === 'string' ? error.observedText : undefined
    store.error = messageOf(error)
  }
  store.loaded = true
  store.revision += 1
  return store.describe()
}

/** Owns the single user-global binding document and its process-local revision. */
export class UserBindingsStore {
  constructor(options = {}) {
    this.filename = resolve(options.filename ?? join(resolveDshHome(options.dshHome), 'ptc-plus', 'bindings.json'))
    this.document = EMPTY_DOCUMENT
    this.text = undefined
    this.revision = 0
    this.loaded = false
    this.error = undefined
    this.tail = Promise.resolve()
  }

  enqueue(operation) {
    const task = this.tail.then(operation, operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  async load() {
    if (this.loaded) return
    await this.enqueue(async () => {
      if (!this.loaded) await refreshStore(this)
    })
  }

  reload() {
    return this.enqueue(() => refreshStore(this))
  }

  describe() {
    return Object.freeze({
      revision: this.revision,
      path: this.filename,
      entries: Object.freeze(this.document.entries.map(entry => entryView(entry))),
      ...(this.error === undefined ? {} : { error: this.error }),
    })
  }

  async list() {
    await this.load()
    return this.describe()
  }

  async entry(id) {
    await this.load()
    const entry = this.document.entries.find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error(`binding entry ${JSON.stringify(id)} does not exist`)
    return Object.freeze({ revision: this.revision, path: this.filename, entry: entryView(entry, true) })
  }

  async snapshot() {
    await this.load()
    return createUserBindingsSnapshot(storedUserBindingsDocument(this.document), this.revision)
  }

  async validationDocument() {
    await this.load()
    if (this.error !== undefined) throw new Error(this.error)
    const document = storedUserBindingsDocument(this.document)
    return Object.freeze({
      revision: this.revision,
      entries: Object.freeze(document.entries.map(entry => Object.freeze(entry))),
    })
  }

  async mutate(expectedRevision, transform) {
    return this.enqueue(async () => {
      if (!this.loaded) {
        const loaded = await readDocument(this.filename)
        this.document = loaded.document
        this.text = loaded.text
        this.loaded = true
        this.revision += 1
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new TypeError('expectedRevision must be a non-negative safe integer')
      }
      if (expectedRevision !== this.revision) {
        throw Object.assign(new Error(`bindings document moved from revision ${expectedRevision} to ${this.revision}`), {
          code: 'BINDINGS_CONFLICT',
        })
      }
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      return withFileLock(this.filename, async () => {
        const disk = await readDocument(this.filename)
        if (disk.text !== this.text) {
          this.document = disk.document
          this.text = disk.text
          this.error = undefined
          this.revision += 1
          throw Object.assign(new Error('bindings document changed outside this process; reload and retry'), {
            code: 'BINDINGS_CONFLICT',
          })
        }
        const next = normalizeUserBindingsDocument(storedUserBindingsDocument(
          await transform(this.document),
        ))
        createUserBindingsSnapshot(storedUserBindingsDocument(next), this.revision + 1)
        const text = documentText(next)
        await writeFileAtomic(this.filename, text, { mode: 0o600, dirMode: 0o700 })
        this.document = next
        this.text = text
        this.error = undefined
        this.revision += 1
        return this.describe()
      })
    })
  }

  save(value, expectedRevision) {
    const entry = normalizeUserBindingEntry(value)
    return this.mutate(expectedRevision, (document) => {
      const index = document.entries.findIndex(candidate => candidate.id === entry.id)
      const entries = [...document.entries]
      if (index < 0) entries.push(entry)
      else entries[index] = entry
      return { entries }
    })
  }

  create(value, expectedRevision) {
    const entry = normalizeUserBindingEntry(value)
    return this.mutate(expectedRevision, (document) => {
      if (document.entries.some(candidate => candidate.id === entry.id)) {
        throw new Error(`binding entry ${JSON.stringify(entry.id)} already exists`)
      }
      return { entries: [...document.entries, entry] }
    })
  }

  setEnabled(id, enabled, expectedRevision) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    return this.mutate(expectedRevision, (document) => {
      const index = document.entries.findIndex(candidate => candidate.id === id)
      if (index < 0) throw new Error(`binding entry ${JSON.stringify(id)} does not exist`)
      const entries = [...document.entries]
      entries[index] = { ...entries[index], enabled }
      return { entries }
    })
  }

  remove(id, expectedRevision) {
    return this.mutate(expectedRevision, (document) => {
      const entries = document.entries.filter(candidate => candidate.id !== id)
      if (entries.length === document.entries.length) {
        throw new Error(`binding entry ${JSON.stringify(id)} does not exist`)
      }
      return { entries }
    })
  }

  async importFile(path, expectedRevision, options = {}) {
    if (typeof path !== 'string' || extname(path).toLowerCase() !== '.ts') {
      throw new TypeError('binding import path must name a local .ts file')
    }
    const absolute = resolve(path)
    const source = await readFile(absolute, 'utf8')
    await this.load()
    const entry = {
      id: options.id ?? importedId(absolute, this.document.entries),
      name: options.name ?? importedName(absolute),
      scope: options.scope ?? 'namespace',
      symbols: options.symbols,
      purpose: options.purpose ?? '',
      enabled: options.enabled ?? false,
      source,
    }
    return this.save(entry, expectedRevision)
  }
}
