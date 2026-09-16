const WINDOWS_ENVIRONMENT_NAMES = new Map([
  ['appdata', 'APPDATA'],
  ['comspec', 'ComSpec'],
  ['home', 'HOME'],
  ['homedrive', 'HOMEDRIVE'],
  ['homepath', 'HOMEPATH'],
  ['localappdata', 'LOCALAPPDATA'],
  ['path', 'PATH'],
  ['pathext', 'PATHEXT'],
  ['programdata', 'ProgramData'],
  ['programfiles', 'ProgramFiles'],
  ['programfiles(x86)', 'ProgramFiles(x86)'],
  ['systemdrive', 'SystemDrive'],
  ['systemroot', 'SystemRoot'],
  ['temp', 'TEMP'],
  ['tmp', 'TMP'],
  ['userprofile', 'USERPROFILE'],
  ['windir', 'windir'],
])
export const HOST_ONLY_ENVIRONMENT_NAMES = new Set([
  'node_test_context',
  'node_v8_coverage',
  'dsh_ptc_compiler_bytecode',
])

/** Project the host environment once without losing Windows case variants. */
export function normalizeWorkerEnvironment(source, platform = process.platform) {
  if (platform !== 'win32') {
    return Object.fromEntries(Object.entries(source).filter(([name, value]) => (
      value !== undefined && !HOST_ONLY_ENVIRONMENT_NAMES.has(name.toLowerCase())
    )))
  }
  const normalized = new Map()
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    if (HOST_ONLY_ENVIRONMENT_NAMES.has(key)) continue
    const canonicalName = WINDOWS_ENVIRONMENT_NAMES.get(key) ?? name
    const current = normalized.get(key)
    if (current === undefined || name === canonicalName) {
      normalized.set(key, [canonicalName, value])
    }
  }
  return Object.fromEntries(normalized.values())
}
