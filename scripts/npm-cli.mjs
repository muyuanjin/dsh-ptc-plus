/** Resolve an npm child process through the CLI identity of the invoking npm process. */
export function npmCliCommand(args, options = {}) {
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const npmExecPath = Object.hasOwn(options, 'npmExecPath')
    ? options.npmExecPath
    : process.env.npm_execpath
  if (typeof npmExecPath === 'string' && npmExecPath.length > 0) {
    return { executable: execPath, args: [npmExecPath, ...args] }
  }
  return {
    executable: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [...args],
  }
}

/**
 * The error for a child process that did not succeed.
 *
 * A process that never started, one a spawn budget killed and one a signal killed all
 * have no exit status of their own. Naming that state — with the spawn cause or the
 * signal — keeps a failure attributed to how the command ended instead of reporting an
 * exit status the command never produced.
 * @param {string} executable - the program that was spawned.
 * @param {string[]} args - its arguments.
 * @param {object} result - the `spawnSync` result.
 * @returns {Error} the diagnostic for that outcome.
 */
export function spawnFailure(executable, args, result) {
  const cause = result?.error?.message !== undefined
    ? ` (${result.error.message})`
    : typeof result?.signal === 'string' && result.signal.length > 0 ? ` (signal ${result.signal})` : ''
  const outcome = typeof result?.status === 'number' ? `exit ${result.status}` : 'no exit status'
  return new Error(`${[executable, ...args].join(' ')} failed with ${outcome}${cause}`)
}
