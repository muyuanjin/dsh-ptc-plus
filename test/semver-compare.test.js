import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import test, { before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { uncoveredEnvironment } from './subprocess-environment.js'

const helperPath = fileURLToPath(new URL('../scripts/semver-compare.ps1', import.meta.url))

// Every published @deepseek-ai/dsh release with the millisecond epoch npm minted
// for its upload, oldest first. npm rewrites the packument `time` field when a
// version is re-published, so the epochs inside each version's
// `_npmOperationalInternal.tmp` are the authoritative publish order.
const releaseTimeline = [
  ['0.0.1-rc.1', 1786390871700],
  ['0.0.1-rc.2', 1786461864500],
  ['0.0.1-rc.5', 1786574172029],
  ['0.1.0-rc.2', 1786614506039],
  ['0.1.0-rc.3', 1786619782763],
  ['0.1.0-rc.6', 1786624503667],
  ['0.1.0-rc.7', 1786967459040],
  ['0.1.0-rc.8', 1787139689518],
  ['0.1.1-rc.1', 1787294958492],
  ['0.1.1-rc.2', 1787316139277],
  ['0.1.2-alpha.2', 1788099052474],
  ['0.1.2-alpha.3', 1788193252711],
  ['0.1.2-alpha.4', 1788278482945],
  ['0.1.2-alpha.5', 1788338314654],
  ['0.1.2-rc.1', 1788416511972],
  ['0.1.3-alpha.2', 1788786696065],
  ['0.1.5-alpha.1', 1788883050426],
  ['0.1.5-alpha.2', 1788964875611],
  ['0.1.5-rc.1', 1789009973149],
]

const chronological = releaseTimeline.map(([version]) => version)
// Releases so far are all pre-releases, so the release of the current line's
// next stable version has to be modelled to cover pre-release precedence.
const nextStableRelease = chronological.at(-1).split('-')[0]
const nextMinorRelease = nextStableRelease.replace(/\.\d+$/u, m => `.${Number(m.slice(1)) + 1}`)

function resolveWindowsCommand(command) {
  if (process.platform !== 'win32') return null
  try {
    return execFileSync('where.exe', [command], { encoding: 'utf8' })
      .split(/\r?\n/u)
      .find(Boolean) ?? null
  } catch {
    return null
  }
}

// The helper path travels through the environment because a Windows path
// embedded in an inline PowerShell command loses its backslashes.
function runHelperCommand(command, script, environment = {}) {
  const result = spawnSync(command, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `. $env:PTC_SEMVER_HELPER
${script}`,
  ], {
    encoding: 'utf8',
    env: uncoveredEnvironment({ ...process.env, PTC_SEMVER_HELPER: helperPath, ...environment }),
    timeout: 30000,
  })

  assert.equal(result.status, 0, `PowerShell failed: ${(result.stderr ?? '').trim()}`)
  return (result.stdout ?? '').trim()
}

function powershellList(values) {
  return `@('${values.join("', '")}')`
}

let observations
before(() => {
  if (process.platform !== 'win32') return
  const command = resolveWindowsCommand('powershell.exe')
  assert.notEqual(command, null, 'powershell.exe was not found')
  // The helper is pure: one native invocation can observe every input while
  // individual assertions retain their own failures and expected values.
  observations = JSON.parse(runHelperCommand(command, `$versions = ${powershellList([...chronological].reverse())}
$insertion = [System.Collections.Generic.List[string]]::new()
foreach ($version in $versions) {
  $index = 0
  while ($index -lt $insertion.Count -and (Compare-SemanticVersion $insertion[$index] $version) -le 0) {
    $index += 1
  }
  $insertion.Insert($index, $version)
}
[pscustomobject]@{
  sorted = $insertion -join "\`n"
  newest = Select-HighestVersion -Versions $versions
  stable = Select-HighestVersion -Versions ${powershellList([nextStableRelease, ...chronological])}
  higher = Select-HighestVersion -Versions ${powershellList([nextMinorRelease, ...chronological])}
  largePreRelease = Select-HighestVersion -Versions @('1.0.0-9', '1.0.0-2147483648', '1.0.0-999999999999999999999999999999')
  largeCore = Select-HighestVersion -Versions @('1.0.0', '2147483648.0.0', '999999999999999999999999999999.0.0')
} | ConvertTo-Json -Compress`))
})

test('the recorded release timeline agrees with semantic version order', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(observations.sorted, chronological.join('\n'))
})

test('selecting the highest version over the release timeline picks the newest release', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(observations.newest, chronological.at(-1))
})

test('a stable release outranks the pre-releases of the same version', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(observations.stable, nextStableRelease)
})

test('a higher version outranks the pre-releases of a lower version', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(observations.higher, nextMinorRelease)
})

test('compares arbitrary-size core and prerelease numeric identifiers mathematically', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(observations.largePreRelease, '1.0.0-999999999999999999999999999999')
  assert.equal(observations.largeCore, '999999999999999999999999999999.0.0')
})
