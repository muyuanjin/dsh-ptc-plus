import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileStatefulModule, createUserModuleCompilationHooks } from '../internal/stateful-module-compiler.js'
import { managedModuleImport } from '../internal/stateful-module-runtime.js'

export async function managedGraph(t, sources, root = 'root.mjs', native = [], { load } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-managed-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all(Object.entries(sources).map(([name, source]) => writeFile(join(directory, name), source)))
  const url = name => pathToFileURL(join(directory, name)).href
  const opaque = Object.fromEntries(await Promise.all(native.map(async name => [name, await import(url(name))])))
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(url(root))
  const hook = registerHooks({ resolve: compilation.resolve, load: load === undefined ? compilation.load
    : (url, context, nextLoad) => compilation.load(url, context, (source, details) => load(source, details, nextLoad)) })
  t.after(() => hook.deregister())
  return { directory, url, opaque, compilation,
    load: (name = root, options) => managedModuleImport(url(root), url(name), options) }
}


let sourceSequence = 0
export function loadManagedSource(t, source, options) {
  const prepared = compileStatefulModule(source, options)
  const url = `data:text/javascript,${encodeURIComponent(prepared.code)}#managed-source-${++sourceSequence}`
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(url, { transform:options?.transform, compiled:true,
    moduleInterface:prepared.moduleInterface, sourceRegions:prepared.sourceRegions })
  const hook = registerHooks({resolve:compilation.resolve,load:compilation.load})
  t.after(() => hook.deregister())
  return managedModuleImport(url, url)
}
