/** Compiler dependencies see only containers and callable prototypes owned by
 * their private realm. The host bridge supplies captured data operations. */
export function createPlatform(bridge) {
  const copyBytes = bytes => {
    const result = new Uint8Array(bytes.length)
    for (let index = 0; index < bytes.length; index++) result[index] = bytes[index]
    return result
  }
  const copyRecord = record => {
    const result = {}
    for (const key of Object.keys(record)) result[key] = record[key]
    return result
  }
  // This is the compiler's text codec subset, not a general Node Buffer shim.
  class CompilerBuffer extends Uint8Array {
    static from(value, encoding = 'utf8') {
      if (typeof value !== 'string') {
        const result = new CompilerBuffer(value.length)
        for (let index = 0; index < value.length; index++) result[index] = value[index]
        return result
      }
      if (!['utf8', 'utf16le', 'base64'].includes(encoding)) throw new TypeError(`unsupported compiler encoding: ${encoding}`)
      const { buffer, length } = bridge.encode(value, encoding)
      const result = new CompilerBuffer(length)
      for (let index = 0; index < length; index++) result[index] = buffer[index]
      return result
    }
    toString(encoding = 'utf8') {
      if (!['utf8', 'utf16le', 'base64'].includes(encoding)) throw new TypeError(`unsupported compiler encoding: ${encoding}`)
      return bridge.decode(this, encoding)
    }
  }
  class CompilerURL {
    constructor(input, base) { this.href = bridge.url(String(input), base === undefined ? undefined : String(base)) }
    toString() { return this.href }
  }
  class TextEncoder {
    #encoder = bridge.textEncoder()
    encode(source = '') { return copyBytes(this.#encoder.encode(source)) }
    encodeInto(source, output) { return copyRecord(this.#encoder.encodeInto(source, output)) }
  }
  class TextDecoder {
    #decode
    constructor(label, options) { this.#decode = bridge.textDecoder(label, options) }
    decode(input, options) { return this.#decode(input, options) }
  }
  class SourceMap {
    #map
    constructor(payload) { this.#map = bridge.sourceMap(payload) }
    findEntry(line, column) { return copyRecord(this.#map.findEntry(line, column)) }
    findOrigin(line, column) { return copyRecord(this.#map.findOrigin(line, column)) }
  }
  const unavailable = () => { throw new Error('compiler dependencies cannot access the filesystem or load configuration') }
  const modules = {
    buffer: { Buffer: CompilerBuffer },
    crypto: { createHash(algorithm) {
      const hash = bridge.hash(algorithm)
      return { update(source, encoding) { hash.update(source, encoding); return this },
        digest(encoding) { return hash.digest(encoding) } }
    } },
    module: { SourceMap, stripTypeScriptTypes: (source, options) => bridge.stripTypeScriptTypes(source, options) },
    url: { URL: CompilerURL, fileURLToPath: url => bridge.fileURLToPath(String(url)) },
    util: { TextEncoder, TextDecoder, deprecate: callback => callback,
      types: { isMap: value => bridge.typeChecks.isMap(value), isSet: value => bridge.typeChecks.isSet(value),
        isUint32Array: value => bridge.typeChecks.isUint32Array(value) } },
    tty: { isatty: () => false },
    fs: { existsSync: unavailable, statSync: unavailable, readFileSync: unavailable,
      readFile: unavailable, stat: unavailable },
    assert(value, message) { if (!value) throw new Error(message) },
  }
  return {
    require(name) {
      const key = name.startsWith('node:') ? name.slice(5) : name
      if (key.startsWith('compiler-asset:')) return bridge.loadAsset(key)
      if (key === 'typescript' || key === 'amaro') return bridge.loadDependency(key)
      if (!Object.hasOwn(modules, key)) throw new Error(`compiler cannot load dependency: ${name}`)
      return modules[key]
    },
    process: { env: {}, version: `v${bridge.nodeVersion}`, versions: { node: bridge.nodeVersion },
      platform: bridge.platform, features: { typescript: bridge.typescript }, cwd: () => bridge.cwd,
      argv: [], stdout: { fd: 1, isTTY: false }, stderr: { fd: 2, isTTY: false } },
    Buffer: CompilerBuffer, URL: CompilerURL, TextEncoder, TextDecoder,
  }
}
