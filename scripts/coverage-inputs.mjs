import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import convertSourceMap from 'convert-source-map'

/** The coverage gate applies to these original plugin sources. */
export function coveredSource(filename, root) {
  const name = relative(root, filename).split('\\').join('/')
  return name === 'index.js' || /^internal\/[^/]+\.js$/.test(name)
    || /^compiler-[^/]+\.cjs$/.test(name)
}

function scriptPath(url) {
  if (url.startsWith('file:')) {
    try {
      const parsed = new URL(url)
      // Node's test module mocks load a synthetic module under the real path
      // plus the loader's node-test-mock search parameter. That alias is not
      // the plugin source and must not merge its synthetic ranges into the real
      // file's coverage map. Ordinary query strings and fragments remain real
      // source URLs and still resolve to their filesystem path.
      if (parsed.searchParams.has('node-test-mock')) return undefined
      return fileURLToPath(parsed)
    } catch { return undefined }
  }
  return isAbsolute(url) ? url : undefined
}

function mapMayCoverSource(map, filename, root) {
  // Unproved or unsupported maps remain c8's responsibility. This pass only
  // removes evidence whose original files are provably outside the gate.
  if (map?.version !== 3 || !Array.isArray(map.sources) || map.sources.length === 0
    || map.sections || (map.sourceRoot !== undefined && typeof map.sourceRoot !== 'string')) return true
  const sourceRoot = map.sourceRoot ?? ''
  if (sourceRoot.includes('://')) return true
  return map.sources.some(source => {
    if (typeof source !== 'string') return true
    if (source.startsWith('file:')) {
      const path = scriptPath(source)
      return path === undefined || coveredSource(path, root)
    }
    if (source.includes('://')) return true
    return coveredSource(resolve(dirname(filename), join(sourceRoot, source)), root)
  })
}

export function coverageInputFilter(root) {
  const diskDecisions = new Map()
  return function keep(script, sourceMapCache = {}) {
    const filename = scriptPath(script.url)
    if (filename === undefined) return false
    const cachedMap = sourceMapCache[script.url]?.data
    if (cachedMap !== undefined) return mapMayCoverSource(cachedMap, filename, root)
    if (!diskDecisions.has(filename)) {
      diskDecisions.set(filename, (() => {
        try {
          const source = readFileSync(filename, 'utf8')
          const map = convertSourceMap.fromSource(source) ?? convertSourceMap.fromMapFileSource(source,
            name => readFileSync(resolve(dirname(filename), name), 'utf8'))
          return map === null ? coveredSource(filename, root) : mapMayCoverSource(map.toObject(), filename, root)
        } catch {
          return true
        }
      })())
    }
    return diskDecisions.get(filename)
  }
}
