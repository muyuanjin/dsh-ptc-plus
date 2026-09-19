import { isAbsolute, parse, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const FILE_SYSTEM_PATH_ARGUMENTS = Object.freeze({
  access: [0], accessSync: [0], appendFile: [0], appendFileSync: [0],
  chmod: [0], chmodSync: [0], chown: [0], chownSync: [0],
  copyFile: [0, 1], copyFileSync: [0, 1], cp: [0, 1], cpSync: [0, 1],
  createReadStream: [0], createWriteStream: [0], exists: [0], existsSync: [0],
  lchmod: [0], lchmodSync: [0], lchown: [0], lchownSync: [0],
  link: [0, 1], linkSync: [0, 1], lstat: [0], lstatSync: [0],
  lutimes: [0], lutimesSync: [0], mkdir: [0], mkdirSync: [0],
  open: [0], openAsBlob: [0], openSync: [0], opendir: [0], opendirSync: [0],
  readFile: [0], readFileSync: [0], readdir: [0], readdirSync: [0],
  readlink: [0], readlinkSync: [0], realpath: [0], realpathSync: [0],
  rename: [0, 1], renameSync: [0, 1], rm: [0], rmSync: [0],
  rmdir: [0], rmdirSync: [0], stat: [0], statSync: [0], statfs: [0], statfsSync: [0],
  symlink: [1], symlinkSync: [1], truncate: [0], truncateSync: [0],
  unlink: [0], unlinkSync: [0], utimes: [0], utimesSync: [0],
  watch: [0], watchFile: [0], writeFile: [0], writeFileSync: [0],
})
const FILE_SYSTEM_PREFIX_ARGUMENTS = Object.freeze([
  'mkdtemp', 'mkdtempSync', 'mkdtempDisposable', 'mkdtempDisposableSync',
])
const FILE_SYSTEM_PROJECTED_PROPERTIES = Object.freeze({
  exists: [promisify.custom],
  realpath: ['native'],
  realpathSync: ['native'],
})
const CHILD_PROCESS_PROJECTED_PROPERTIES = Object.freeze({
  exec: [promisify.custom],
  execFile: [promisify.custom],
})

function wrapBuiltinCallable(original, projectArguments, projectedProperties = []) {
  const wrapped = {
    invoke(...args) {
      return Reflect.apply(original, this, projectArguments(args))
    },
  }.invoke
  const descriptors = Object.getOwnPropertyDescriptors(original)
  const projected = new Set(projectedProperties)
  for (const property of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[property]
    if (descriptor.value === original) {
      descriptors[property] = { ...descriptor, value: wrapped }
    } else if (projected.has(property)) {
      descriptors[property] = {
        ...descriptor,
        value: wrapBuiltinCallable(descriptor.value, projectArguments),
      }
    }
  }
  return Object.defineProperties(wrapped, descriptors)
}

function wrapBuiltin(owner, name, projectArguments, projectedProperties) {
  const original = owner?.[name]
  if (typeof original !== 'function') return
  owner[name] = wrapBuiltinCallable(original, projectArguments, projectedProperties)
}

/** Install one session's cwd projection into Node builtins loaded by the worker. */
export function installWorkerCwdVirtualization(sessionCwd, originalRequire, markVolatile) {
  if (sessionCwd === undefined) {
    const nativeCwd = process.cwd
    process.cwd = () => {
      markVolatile('process.cwd')
      return Reflect.apply(nativeCwd, process, [])
    }
    return
  }
  const nativeResolve = resolve
  const bufferPrefix = Buffer.from(sessionCwd + (/[\\/]$/.test(sessionCwd) ? '' : sep))
  const sessionPath = (value) => {
    if (typeof value === 'string') return isAbsolute(value) ? value : nativeResolve(sessionCwd, value)
    if (Buffer.isBuffer(value)) {
      const absolute = isAbsolute(String.fromCharCode(...value.subarray(0, 3)))
      return absolute ? value : Buffer.concat([bufferPrefix, value])
    }
    return value
  }
  const sessionPathPrefix = (value) => {
    if (typeof value !== 'string' || isAbsolute(value) || parse(value).root !== '') return sessionPath(value)
    return sessionCwd + (/[\\/]$/.test(sessionCwd) ? '' : sep) + value
  }
  const projectPaths = (args, indices) => {
    const next = [...args]
    for (const index of indices) next[index] = sessionPath(next[index])
    return next
  }
  const projectPrefix = (args) => {
    const next = [...args]
    next[0] = sessionPathPrefix(next[0])
    return next
  }
  const sessionChildOptions = options => (
    options === null || typeof options !== 'object' || options.cwd !== undefined
      ? options
      : { ...options, cwd: sessionCwd }
  )
  const withDefaultOptions = (args, index) => {
    const next = [...args]
    next[index] = sessionChildOptions(next[index]) ?? { cwd: sessionCwd }
    return next
  }
  const childProcessOptions = (name, args) => {
    if (name === 'exec' || name === 'execSync') {
      const next = [...args]
      if (typeof next[1] === 'function') next.splice(1, 0, { cwd: sessionCwd })
      else next[1] = sessionChildOptions(next[1]) ?? { cwd: sessionCwd }
      return next
    }
    if (name === 'execFile' || name === 'execFileSync') {
      if (args.length === 1 || typeof args[1] === 'function') {
        const next = [...args]
        next.splice(1, 0, { cwd: sessionCwd })
        return next
      }
      if (typeof args[2] === 'function') {
        if (args[1] !== undefined && !Array.isArray(args[1])) return withDefaultOptions(args, 1)
        const next = [...args]
        next.splice(2, 0, { cwd: sessionCwd })
        return next
      }
      if (args[1] !== undefined && !Array.isArray(args[1])) return withDefaultOptions(args, 1)
      return withDefaultOptions(args, 2)
    }
    return args.length === 1 || (args[1] !== undefined && !Array.isArray(args[1]))
      ? withDefaultOptions(args, 1)
      : withDefaultOptions(args, 2)
  }
  const sessionGlobOptions = (args) => {
    const next = [...args]
    if (typeof next[1] === 'function') next.splice(1, 0, { cwd: sessionCwd })
    else if (next[1] === undefined) next[1] = { cwd: sessionCwd }
    else if (next[1] !== null && typeof next[1] === 'object' && next[1].cwd === undefined) {
      next[1] = { ...next[1], cwd: sessionCwd }
    }
    return next
  }

  Object.defineProperty(process, 'cwd', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: () => sessionCwd,
  })
  const fs = originalRequire('node:fs')
  const path = originalRequire('node:path')
  for (const [name, indices] of Object.entries(FILE_SYSTEM_PATH_ARGUMENTS)) {
    wrapBuiltin(fs, name, args => projectPaths(args, indices), FILE_SYSTEM_PROJECTED_PROPERTIES[name])
    wrapBuiltin(fs.promises, name, args => projectPaths(args, indices))
  }
  for (const name of FILE_SYSTEM_PREFIX_ARGUMENTS) {
    wrapBuiltin(fs, name, projectPrefix)
    wrapBuiltin(fs.promises, name, projectPrefix)
  }
  for (const name of ['glob', 'globSync']) {
    wrapBuiltin(fs, name, sessionGlobOptions)
    wrapBuiltin(fs.promises, name, sessionGlobOptions)
  }
  wrapBuiltin(path, 'resolve', args => [sessionCwd, ...args])
  const childProcess = originalRequire('node:child_process')
  for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
    wrapBuiltin(childProcess, name, args => childProcessOptions(name, args), CHILD_PROCESS_PROJECTED_PROPERTIES[name])
  }
}
