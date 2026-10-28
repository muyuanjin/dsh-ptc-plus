import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { isHostServicePackageName, verifyInstalledHostGraph } from './host-channel-manifest.mjs'
import { npmCliCommand } from './npm-cli.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Freeze the Host service cohort, including peers of the plugin's direct peers. */
export async function consumerManifest(archive, plugin, host) {
  const lock = JSON.parse(await readFile(join(host, 'package-lock.json'), 'utf8'))
  const verified = await verifyInstalledHostGraph(host, lock)
  const require = createRequire(join(host, 'package.json'))
  const dependencies = {}
  const selected = new Set()
  const pending = []
  const optionalPeers = new Set(Object.entries(plugin.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name))
  for (const name of Object.keys(plugin.peerDependencies ?? {})) {
    let filename
    try {
      filename = require.resolve(`${name}/package.json`)
    } catch (error) {
      // An optional peer is resolved by whichever host publishes it; a host
      // without it is a supported shape, not a broken consumer install.
      if (optionalPeers.has(name) && error.code === 'MODULE_NOT_FOUND') continue
      throw error
    }
    const installed = JSON.parse(await readFile(filename, 'utf8'))
    const packagePath = relative(host, dirname(filename)).replaceAll('\\', '/')
    if (installed.name !== name || lock.packages?.[packagePath]?.version !== installed.version) {
      throw new Error(`Host peer ${name} is not proved by its installed frozen graph`)
    }
    dependencies[name] = installed.version
    pending.push(filename)
  }
  while (pending.length > 0) {
    const filename = pending.pop()
    if (selected.has(filename)) continue
    selected.add(filename)
    const metadata = JSON.parse(await readFile(filename, 'utf8'))
    const requireFromPeer = createRequire(filename)
    for (const name of Object.keys({ ...metadata.dependencies, ...metadata.peerDependencies, ...metadata.optionalDependencies })) {
      if (!isHostServicePackageName(name)) continue
      let dependencyFile
      try { dependencyFile = requireFromPeer.resolve(`${name}/package.json`) } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND'
          && (Object.hasOwn(metadata.optionalDependencies ?? {}, name) || metadata.peerDependenciesMeta?.[name]?.optional)) continue
        throw error
      }
      const installed = JSON.parse(await readFile(dependencyFile, 'utf8'))
      const packagePath = relative(host, dirname(dependencyFile)).replaceAll('\\', '/')
      if (!verified.some(entry => entry.packagePath === packagePath && entry.name === name && entry.version === installed.version)) {
        throw new Error(`Host transitive peer ${name} is not proved by its installed frozen graph`)
      }
      if (dependencies[name] !== undefined && dependencies[name] !== installed.version) {
        throw new Error(`Host consumer requires conflicting versions of ${name}`)
      }
      dependencies[name] = installed.version
      pending.push(dependencyFile)
    }
  }
  dependencies[plugin.name] = pathToFileURL(resolve(archive)).href
  return { private: true, type: 'module', dependencies }
}

/** Install and import the same tarball with its Host's required peer cohort. */
export async function smokePackedConsumer(archive, { host = ROOT } = {}) {
  archive = resolve(archive)
  if (!(await stat(archive)).isFile()) throw new Error('consumer smoke requires a tarball file')
  const plugin = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const manifest = await consumerManifest(archive, plugin, resolve(host))
  const consumer = await mkdtemp(join(tmpdir(), 'ptc-packed-consumer-'))
  try {
    await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const npm = npmCliCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund'])
    execFileSync(npm.executable, npm.args, { cwd: consumer, stdio: 'inherit' })
    const installedManifest = await consumerManifest(archive, plugin, consumer)
    if (JSON.stringify(installedManifest.dependencies) !== JSON.stringify(manifest.dependencies)) {
      throw new Error('packed consumer changed the selected frozen Host service cohort')
    }
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const require = createRequire(process.cwd() + '/package.json');
      const metadata = require(${JSON.stringify(plugin.name + '/package.json')});
      const installed = await import(${JSON.stringify(plugin.name)});
      if (metadata.version !== ${JSON.stringify(plugin.version)} || installed.name !== 'ptc-plus' || typeof installed.apply !== 'function') {
        throw new Error('packed consumer resolved an unexpected plugin artifact');
      }
      console.log('Packed consumer installation and ESM import passed');
    `], { cwd: consumer, stdio: 'inherit' })
    // The compiler stack ships vendored: this proves the packed artifact loads
    // its compiler entry, TypeScript, and amaro from package files with only
    // the declared dependencies installed. The dependency classification in
    // package.json relies on this packed-consumer evidence.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      import { readFileSync } from 'node:fs';
      import { createContext, Script } from 'node:vm';
      import { dirname, join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const require = createRequire(process.cwd() + '/package.json');
      const root = dirname(require.resolve(${JSON.stringify(plugin.name + '/package.json')}));
      const { installCompilerPlatform } = await import(pathToFileURL(join(root, 'internal', 'compiler-platform.js')).href);
      const bundlePath = join(root, 'compiler-core.cjs');
      const context = createContext({
        __compilerBaseUrl: pathToFileURL(join(root, 'internal', 'compiler-service.js')).href,
        __filename: bundlePath, __dirname: root, module: { exports: {} },
      });
      installCompilerPlatform(context);
      const compile = new Script(readFileSync(bundlePath, 'utf8') + '\\nmodule.exports.compile', { displayErrors: false })
        .runInContext(context, { displayErrors: false });
      if (typeof compile !== 'function') throw new Error('packed compiler entry did not load');
      const typescript = new Script('require("typescript")').runInContext(context);
      const output = typescript.transpileModule('const value: number = 42', {
        compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.ESNext },
      }).outputText;
      if (!output.includes('const value = 42')) throw new Error('packed TypeScript compiler did not transpile');
      const amaro = new Script('require("amaro")').runInContext(context);
      const stripped = amaro.transformSync('const typed: number = 1', { mode: 'strip-only' });
      if (typeof stripped.code !== 'string' || !stripped.code.includes('const typed')) {
        throw new Error('packed amaro transform did not run');
      }
      const prepared = compile('prepareProgram', ['const value: number = 42',
        { languageSemantics: 'stateful-v1', nativeUsing: false }]);
      if (prepared.error !== undefined || typeof prepared.value?.code !== 'string') {
        throw new Error('packed compiler entry did not prepare a PTC cell');
      }
      const { Worker } = await import('node:worker_threads');
      await new Promise((resolve, reject) => {
        // Clear execArgv: this probe runs with --input-type=module, which a
        // file-backed worker entry must not inherit.
        const worker = new Worker(pathToFileURL(join(root, 'internal', 'kernel-worker.js')),
          { workerData: {}, execArgv: [] });
        let settled = false;
        const finish = (settle, value) => { if (settled) return; settled = true; clearTimeout(timer); settle(value); };
        const timer = setTimeout(() => { finish(resolve); worker.terminate(); }, 5000);
        worker.once('error', error => finish(reject, new Error('packed kernel worker failed to load: ' + error.message)));
        worker.once('exit', code => { if (code !== 0) finish(reject, new Error('packed kernel worker exited early with code ' + code)); });
      });
      console.log('Packed compiler stack (TypeScript ' + typescript.version + ', amaro) and kernel worker loaded');
    `], { cwd: consumer, stdio: 'inherit' })
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { host: { type: 'string' } } })
  if (positionals.length !== 1) throw new Error('usage: npm-consumer-smoke.mjs <tarball> [--host <installed-frozen-host>]')
  await smokePackedConsumer(positionals[0], { host: values.host })
}
