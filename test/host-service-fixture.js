// Host services a fixture publishes so a composition under test can run.
//
// Each fixture states one service the real Host owns, at the surface the production code
// reads. A surface that omits a member the caller uses turns that call into a type error
// inside an execution instead of an answer, so the doubles state every member these
// compositions reach and nothing the compositions never observe.

import { isAbsolute, resolve as resolvePath } from 'node:path'

/**
 * Publish the sandbox policy every fixture Host runs under.
 *
 * A confined PTC call resolves one file policy per call, and a delegated child asks the
 * parent's service for the session override before it starts. A fixture states full access
 * as the deployment default and no recorded override, so no fixture operation is confined
 * and no session claims a mode it never recorded.
 */
export function provideSandboxPolicyFixture(ctx, mode = 'danger-full-access') {
  if (typeof ctx.get === 'function' && ctx.get('sandboxPolicy') !== undefined) return
  ctx.effect(() => ctx.provide('sandboxPolicy', {
    defaultMode: mode,
    resolve: () => ({ mode }),
    overrideOf: () => undefined,
  }), 'ptc-plus test sandbox policy')
}

/**
 * Publish the working-directory service a delegated child needs.
 *
 * The real owner validates the directory against the filesystem and commits a change as a
 * `working-directory/change` session event. A fixture Host owns no filesystem service, so it
 * records that same event and reads it back: a session answers its last recorded change, or
 * the directory its header was created with, or the deployment default.
 *
 * `set` receives the child Agent before that Agent is published, which is why the real owner
 * takes the Agent rather than a Session.
 */
export function provideWorkingDirectoryFixture(ctx, defaultDirectory = process.cwd()) {
  if (typeof ctx.get === 'function' && ctx.get('workingDirectory') !== undefined) return
  const current = session => {
    let directory = session.header.cwd
    for (const event of session.snapshotEvents()) {
      if (event.type === 'working-directory/change') directory = event.data.cwd
    }
    return directory ?? defaultDirectory
  }
  ctx.effect(() => ctx.provide('workingDirectory', {
    defaultDirectory,
    get: current,
    ensure: async agent => current(agent.session),
    async set(agent, path) {
      if (path.length === 0) throw new Error('working-directory: cd must not be empty')
      const directory = isAbsolute(path) ? path : resolvePath(current(agent.session), path)
      agent.session.append('working-directory/change', { cwd: directory })
      return directory
    },
  }), 'ptc-plus test working directory')
}
