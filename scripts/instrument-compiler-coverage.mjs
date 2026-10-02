import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { deserialize } from 'node:v8'
import vm from 'node:vm'
import { compilerDescriptors } from '../internal/compiler-descriptors.js'

const source = readFileSync(new URL('../compiler-core.cjs', import.meta.url), 'utf8')
const path = process.env.DSH_PTC_COMPILER_BYTECODE
const cache = path ? deserialize(readFileSync(path)) : undefined
if (cache !== undefined && (cache.source !== source || !(cache.data instanceof Uint8Array))) {
  throw new Error('coverage compiler cache does not match the compiler source')
}
const NativeScript = vm.Script
const compilerScripts = new WeakSet()
const objectCreate = Object.create
const getPrototypeOf = Object.getPrototypeOf
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const defineProperties = compilerDescriptors.defineProperties
const weakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add)
const weakSetHas = Function.prototype.call.bind(WeakSet.prototype.has)
const NativeUint8Array = Uint8Array
vm.Script = class extends NativeScript {
  constructor(text, options) {
    const compiler = text === source
    const scriptOptions = compiler ? defineProperties(
      objectCreate(options == null ? null : getPrototypeOf(options)),
      { __proto__: null, ...getOwnPropertyDescriptors(options ?? {}),
        cachedData: { __proto__: null, value: undefined, writable: true, enumerable: true, configurable: true } },
    ) : options
    super(text, scriptOptions)
    if (compiler) weakSetAdd(compilerScripts, this)
  }

  createCachedData() {
    return weakSetHas(compilerScripts, this)
      ? new NativeUint8Array(cache?.data ?? 0) : super.createCachedData()
  }
}
syncBuiltinESMExports()
