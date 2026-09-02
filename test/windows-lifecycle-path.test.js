import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const helperPath = fileURLToPath(new URL('../scripts/windows-lifecycle-path.ps1', import.meta.url))

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

function windowsEnvironment(pathValue, additions = {}) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'path') delete environment[key]
  }
  return { ...environment, Path: pathValue, ...additions }
}

function npmCliPath() {
  return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function lifecycleEnvironment(pathValue, additions = {}) {
  return windowsEnvironment(pathValue, additions)
}

const npmOverlayCommand = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $env:PTC_TEST_HELPER
$npmArguments = @($env:PTC_TEST_NPM_ARGUMENTS | ConvertFrom-Json)
$commandState = [pscustomobject]@{ ExitCode = 1 }
Invoke-WithWindowsPathOverlay {
    & $env:PTC_TEST_NODE $env:PTC_TEST_NPM_CLI @npmArguments
    $commandState.ExitCode = $LASTEXITCODE
}
exit $commandState.ExitCode
`

function spawnNpmInOverlay(shellPath, argumentsList, options) {
  return spawnSync(shellPath, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', npmOverlayCommand,
  ], {
    ...options,
    env: {
      ...options.env,
      PTC_TEST_HELPER: helperPath,
      PTC_TEST_NODE: process.execPath,
      PTC_TEST_NPM_CLI: npmCliPath(),
      PTC_TEST_NPM_ARGUMENTS: JSON.stringify(argumentsList),
    },
  })
}

async function overlayDirectories() {
  return (await readdir(os.tmpdir(), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-lifecycle-path-'))
    .map(entry => entry.name)
    .sort()
}

async function registerOverlayCleanup(t) {
  const substBefore = execFileSync('subst.exe', { encoding: 'utf8' })
  const overlaysBefore = await overlayDirectories()
  t.after(async () => {
    const baselineMappings = new Set(substBefore.split(/\r?\n/u).filter(Boolean))
    const currentMappings = execFileSync('subst.exe', { encoding: 'utf8' })
      .split(/\r?\n/u)
      .filter(Boolean)
    for (const mapping of currentMappings) {
      if (baselineMappings.has(mapping)) continue
      const match = mapping.match(/^([A-Z]:)\\: => (.+)$/iu)
      if (match && path.basename(match[2]).startsWith('dsh-lifecycle-path-')) {
        let released = false
        for (let attempt = 0; attempt < 5; attempt += 1) {
          if (spawnSync('subst.exe', [match[1], '/d']).status === 0) {
            released = true
            break
          }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        if (released) await rm(match[2], { recursive: true, force: true })
      }
    }
    const mappedRoots = new Set(
      execFileSync('subst.exe', { encoding: 'utf8' })
        .split(/\r?\n/u)
        .flatMap(mapping => {
          const match = mapping.match(/^[A-Z]:\\: => (.+)$/iu)
          return match ? [path.resolve(match[1]).toLowerCase()] : []
        }),
    )
    const currentOverlays = await overlayDirectories()
    for (const overlay of currentOverlays) {
      const overlayPath = path.join(os.tmpdir(), overlay)
      if (!overlaysBefore.includes(overlay) && !mappedRoots.has(path.resolve(overlayPath).toLowerCase())) {
        await rm(overlayPath, { recursive: true, force: true })
      }
    }
  })
  return { overlaysBefore, substBefore }
}

for (const shellName of ['powershell.exe', 'pwsh.exe']) {
  const shellPath = resolveWindowsCommand(shellName)
  test(`deduplicates the inherited Windows PATH under ${shellName}`, {
    skip: shellPath === null,
  }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-windows-path-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await registerOverlayCleanup(t)
    const lifecycleDirectory = path.join(root, 'probe-package')
    await mkdir(lifecycleDirectory)
    await writeFile(path.join(lifecycleDirectory, 'package.json'), JSON.stringify({
      private: true,
      scripts: {
        probe: 'node -e "process.stdout.write(process.version)"',
      },
    }))

    const originalPathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path'
    const originalPath = process.env[originalPathKey] ?? ''
    const repetitions = Math.max(3, Math.ceil(9000 / Math.max(originalPath.length, 1)))
    const duplicatedPath = Array.from({ length: repetitions }, () => originalPath).join(';')
    assert.ok(duplicatedPath.length > 8191)

    const script = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $env:PTC_TEST_HELPER
$sourceValues = @(
    $env:Path
    [Environment]::GetEnvironmentVariable('Path', 'Machine')
    [Environment]::GetEnvironmentVariable('Path', 'User')
)
$expectedEntries = [Collections.Generic.List[string]]::new()
$seenEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in (ConvertTo-WindowsPathEntries $sourceValues)) {
    if ($seenEntries.Add($entry)) { [void] $expectedEntries.Add($entry) }
}
$beforeLength = $env:Path.Length
& $env:ComSpec /d /c 'node --version 2>nul' > $null
$beforeNodeExit = $LASTEXITCODE
Import-LatestWindowsPath
$actualEntries = @($env:Path.Split([IO.Path]::PathSeparator))
$sameEntries = $actualEntries.Count -eq $expectedEntries.Count
if ($sameEntries) {
    for ($index = 0; $index -lt $actualEntries.Count; $index += 1) {
        if ($actualEntries[$index] -cne $expectedEntries[$index]) {
            $sameEntries = $false
            break
        }
    }
}
$nodeVersion = (& $env:ComSpec /d /c 'node --version' 2>&1 | Out-String).Trim()
$afterNodeExit = $LASTEXITCODE
[pscustomobject]@{
    beforeLength = $beforeLength
    afterLength = $env:Path.Length
    importedPath = $env:Path
    expectedCount = $expectedEntries.Count
    actualCount = $actualEntries.Count
    sameEntries = $sameEntries
    beforeNodeExit = $beforeNodeExit
    afterNodeExit = $afterNodeExit
    nodeVersion = $nodeVersion
} | ConvertTo-Json -Compress
`
    const testScriptPath = path.join(root, 'verify.ps1')
    await writeFile(testScriptPath, script)
    const result = spawnSync(shellPath, [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', testScriptPath,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: windowsEnvironment(duplicatedPath, {
        PTC_TEST_HELPER: helperPath,
      }),
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout.trim())
    assert.ok(report.beforeLength > 8191)
    assert.notEqual(report.beforeNodeExit, 0)
    assert.ok(report.afterLength < report.beforeLength)
    assert.ok(report.afterLength < 8191)
    assert.equal(report.actualCount, report.expectedCount)
    assert.equal(report.sameEntries, true)
    assert.equal(report.afterNodeExit, 0)
    assert.match(report.nodeVersion, /^v\d+/u)

    const lifecycleResult = spawnNpmInOverlay(shellPath, ['run', 'probe', '--silent'], {
      cwd: lifecycleDirectory,
      encoding: 'utf8',
      env: lifecycleEnvironment(report.importedPath),
    })
    assert.equal(lifecycleResult.status, 0, lifecycleResult.stderr || lifecycleResult.stdout)
    assert.match(lifecycleResult.stdout.trim(), /^v\d+/u)
  })
}

test('preserves a fully unique oversized PATH through a real npm lifecycle', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-unique-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await registerOverlayCleanup(t)
  const pathRoot = path.join(root, 'p')
  const lifecycleDirectory = path.join(root, 'package')
  await mkdir(pathRoot)
  await mkdir(lifecycleDirectory)

  const uniqueDirectories = Array.from(
    { length: 400 },
    (_, index) => path.join(pathRoot, index.toString(16)),
  )
  await Promise.all(uniqueDirectories.map(directory => mkdir(directory)))
  await writeFile(path.join(uniqueDirectories[10], 'precedence-tool.cmd'), '@echo first\r\n')
  await writeFile(path.join(uniqueDirectories[300], 'precedence-tool.cmd'), '@echo second\r\n')
  await writeFile(path.join(uniqueDirectories.at(-1), 'last-tool.cmd'), '@echo last\r\n')

  const nodeDirectory = path.dirname(process.execPath)
  const expectedDirectories = [nodeDirectory, ...uniqueDirectories]
  const oversizedPath = expectedDirectories.join(';')
  assert.ok(oversizedPath.length > 8191)
  const expectedPathFile = path.join(root, 'expected.json')
  await writeFile(expectedPathFile, JSON.stringify(expectedDirectories))
  await writeFile(path.join(lifecycleDirectory, 'verify.cjs'), String.raw`
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync, realpathSync } = require('node:fs')
const path = require('node:path')
const expected = JSON.parse(readFileSync(process.env.PTC_EXPECTED_PATH_FILE, 'utf8'))
  .map(entry => path.resolve(entry).toLowerCase())
const actual = process.env.Path.split(path.delimiter).flatMap(entry => {
  try { return [realpathSync(entry).toLowerCase()] } catch { return [] }
})
let position = -1
for (const entry of expected) {
  position = actual.indexOf(entry, position + 1)
  assert.notEqual(position, -1, entry)
}
assert.equal(execFileSync(process.env.ComSpec, ['/d', '/c', 'precedence-tool'], { encoding: 'utf8' }).trim(), 'first')
assert.equal(execFileSync(process.env.ComSpec, ['/d', '/c', 'last-tool'], { encoding: 'utf8' }).trim(), 'last')
process.stdout.write('complete-path-ok')
`)
  await writeFile(path.join(lifecycleDirectory, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      probe: 'node verify.cjs',
      fail: 'node -e "process.exit(7)"',
    },
  }))

  const substBefore = execFileSync('subst.exe', { encoding: 'utf8' })
  const overlaysBefore = await overlayDirectories()
  const environment = lifecycleEnvironment(oversizedPath, {
    PTC_EXPECTED_PATH_FILE: expectedPathFile,
  })
  const powershellPath = resolveWindowsCommand('powershell.exe')
  const overlayScriptPath = path.join(root, 'verify-overlay.ps1')
  await writeFile(overlayScriptPath, String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $env:PTC_TEST_HELPER
$ambientPath = $env:Path
$state = [pscustomobject]@{
    CompactLength = 0
    NodeVersion = ''
    Precedence = ''
    Last = ''
    FailureRestored = $false
}
Invoke-WithWindowsPathOverlay {
    $state.CompactLength = $env:Path.Length
    $state.NodeVersion = (& $env:ComSpec /d /c 'node --version' | Out-String).Trim()
    $state.Precedence = (& $env:ComSpec /d /c 'precedence-tool' | Out-String).Trim()
    $state.Last = (& $env:ComSpec /d /c 'last-tool' | Out-String).Trim()
}
$successRestored = $env:Path -ceq $ambientPath
try {
    Invoke-WithWindowsPathOverlay { throw 'expected overlay failure' }
} catch {
    if ($_.Exception.Message -ne 'expected overlay failure') { throw }
    $state.FailureRestored = $env:Path -ceq $ambientPath
}
[pscustomobject]@{
    CompactLength = $state.CompactLength
    NodeVersion = $state.NodeVersion
    Precedence = $state.Precedence
    Last = $state.Last
    SuccessRestored = $successRestored
    FailureRestored = $state.FailureRestored
} | ConvertTo-Json -Compress
`)
  const overlayResult = spawnSync(powershellPath, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', overlayScriptPath,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: windowsEnvironment(oversizedPath, {
      PTC_TEST_HELPER: helperPath,
    }),
  })
  assert.equal(overlayResult.status, 0, overlayResult.stderr || overlayResult.stdout)
  const overlayReport = JSON.parse(overlayResult.stdout.trim())
  assert.ok(overlayReport.CompactLength < 8191)
  assert.match(overlayReport.NodeVersion, /^v\d+/u)
  assert.equal(overlayReport.Precedence, 'first')
  assert.equal(overlayReport.Last, 'last')
  assert.equal(overlayReport.SuccessRestored, true)
  assert.equal(overlayReport.FailureRestored, true)
  assert.equal(execFileSync('subst.exe', { encoding: 'utf8' }), substBefore)
  assert.deepEqual(await overlayDirectories(), overlaysBefore)

  const probeResult = spawnNpmInOverlay(powershellPath, ['run', 'probe', '--silent'], {
    cwd: lifecycleDirectory,
    encoding: 'utf8',
    env: environment,
  })
  assert.equal(probeResult.status, 0, probeResult.stderr || probeResult.stdout)
  assert.equal(probeResult.stdout.trim(), 'complete-path-ok')
  assert.equal(execFileSync('subst.exe', { encoding: 'utf8' }), substBefore)
  assert.deepEqual(await overlayDirectories(), overlaysBefore)

  const failureResult = spawnNpmInOverlay(powershellPath, ['run', 'fail', '--silent'], {
    cwd: lifecycleDirectory,
    encoding: 'utf8',
    env: environment,
  })
  assert.equal(failureResult.status, 7, failureResult.stderr || failureResult.stdout)
  assert.equal(execFileSync('subst.exe', { encoding: 'utf8' }), substBefore)
  assert.deepEqual(await overlayDirectories(), overlaysBefore)
})

test('shares one overlay across more concurrent npm lifecycles than drive letters', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-concurrent-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await registerOverlayCleanup(t)
  const markerRoot = path.join(root, 'markers')
  await mkdir(markerRoot)

  const dependencyCount = 24
  await writeFile(path.join(root, 'probe.cjs'), String.raw`
const { readdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
writeFileSync(path.join(process.env.PTC_CONCURRENT_MARKERS, process.env.PTC_PROBE_ID), '')
const deadline = Date.now() + 15000
while (readdirSync(process.env.PTC_CONCURRENT_MARKERS).length < ${dependencyCount}) {
  if (Date.now() >= deadline) throw new Error('concurrent lifecycle barrier timed out')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
}
if (!process.env.Path.split(';').some(entry => /^[A-Z]:\\[0-9a-f]+$/i.test(entry))) {
  throw new Error('lifecycle PATH was not compacted')
}
`)
  await writeFile(path.join(root, 'coordinator.cjs'), String.raw`
const { spawn } = require('node:child_process')
const path = require('node:path')
const npmCli = process.env.PTC_TEST_NPM_CLI
const runs = Array.from({ length: ${dependencyCount} }, (_, index) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npmCli, 'run', 'probe', '--silent'], {
    cwd: process.cwd(),
    env: { ...process.env, PTC_PROBE_ID: String(index) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(output || 'probe failed: ' + code)))
}))
Promise.all(runs).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
`)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      concurrent: 'node coordinator.cjs',
      probe: 'node probe.cjs',
    },
  }))

  const substBefore = execFileSync('subst.exe', { encoding: 'utf8' })
  const overlaysBefore = await overlayDirectories()
  const result = spawnNpmInOverlay(resolveWindowsCommand('powershell.exe'), [
    'run', 'concurrent', '--silent',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: lifecycleEnvironment(process.env.Path, {
      PTC_CONCURRENT_MARKERS: markerRoot,
    }),
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal((await readdir(markerRoot)).length, dependencyCount)
  assert.equal(execFileSync('subst.exe', { encoding: 'utf8' }), substBefore)
  assert.deepEqual(await overlayDirectories(), overlaysBefore)
})

test('preserves appended arguments in nested npm lifecycle scripts', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-lifecycle-args-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await registerOverlayCleanup(t)
  const reportPath = path.join(root, 'arguments.json')
  await writeFile(path.join(root, 'probe.cjs'), String.raw`
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.PTC_ARGUMENT_REPORT, JSON.stringify(process.argv.slice(2)))
`)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      preinstall: 'npm run probe -- hello "two words" https://example.test/a/b',
      probe: 'node probe.cjs',
    },
  }))

  const substBefore = execFileSync('subst.exe', { encoding: 'utf8' })
  const overlaysBefore = await overlayDirectories()
  const result = spawnNpmInOverlay(resolveWindowsCommand('powershell.exe'), [
    'install', '--no-audit', '--no-fund', '--no-package-lock',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: lifecycleEnvironment(process.env.Path, {
      PTC_ARGUMENT_REPORT: reportPath,
    }),
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), [
    'hello',
    'two words',
    'https://example.test/a/b',
  ])
  assert.equal(execFileSync('subst.exe', { encoding: 'utf8' }), substBefore)
  assert.deepEqual(await overlayDirectories(), overlaysBefore)
})

test('retries overlay unmapping and preserves the root when retries are exhausted', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-unmap-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await registerOverlayCleanup(t)
  const mockScript = path.join(root, 'mock-subst.cjs')
  const mockCommand = path.join(root, 'mock-subst.cmd')
  const counterPath = path.join(root, 'counter.txt')
  await writeFile(mockScript, String.raw`
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[1]?.toLowerCase() === '/d') {
  const count = existsSync(process.env.PTC_UNMAP_COUNTER)
    ? Number(readFileSync(process.env.PTC_UNMAP_COUNTER, 'utf8'))
    : 0
  writeFileSync(process.env.PTC_UNMAP_COUNTER, String(count + 1))
  if (count < Number(process.env.PTC_UNMAP_FAILURES)) process.exit(19)
}
const result = spawnSync(process.env.PTC_REAL_SUBST, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  await writeFile(mockCommand, `@"${process.execPath}" "${mockScript}" %*\r\n`)

  const shellPath = resolveWindowsCommand('powershell.exe')
  const cleanupScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $env:PTC_TEST_HELPER
try {
    Invoke-WithWindowsPathOverlay -SubstPath $env:PTC_MOCK_SUBST { }
    [pscustomobject]@{ Succeeded = $true; Message = ''; CleanupFlag = $false } | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{
        Succeeded = $false
        Message = $_.Exception.Message
        CleanupFlag = $_.Exception.Data['DshPtcPlusPathOverlayCleanup'] -eq $true
    } | ConvertTo-Json -Compress
}
`
  const commonEnvironment = windowsEnvironment(process.env.Path, {
    PTC_TEST_HELPER: helperPath,
    PTC_MOCK_SUBST: mockCommand,
    PTC_REAL_SUBST: path.join(process.env.SystemRoot, 'System32', 'subst.exe'),
    PTC_UNMAP_COUNTER: counterPath,
  })

  const eventualResult = spawnSync(shellPath, [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cleanupScript,
  ], {
    encoding: 'utf8',
    env: { ...commonEnvironment, PTC_UNMAP_FAILURES: '2' },
  })
  assert.equal(eventualResult.status, 0, eventualResult.stderr || eventualResult.stdout)
  assert.equal(JSON.parse(eventualResult.stdout.trim()).Succeeded, true)
  assert.equal(await readFile(counterPath, 'utf8'), '3')

  await writeFile(counterPath, '0')
  const exhaustedResult = spawnSync(shellPath, [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cleanupScript,
  ], {
    encoding: 'utf8',
    env: { ...commonEnvironment, PTC_UNMAP_FAILURES: '99' },
  })
  assert.equal(exhaustedResult.status, 0, exhaustedResult.stderr || exhaustedResult.stdout)
  const report = JSON.parse(exhaustedResult.stdout.trim())
  assert.equal(report.Succeeded, false)
  assert.equal(report.CleanupFlag, true)
  assert.match(report.Message, /after 5 attempts/u)
  const [, drive, overlayRoot] = report.Message.match(/overlay ([A-Z]:).*preserved at (.+)$/u) ?? []
  assert.ok(drive, report.Message)
  assert.ok(overlayRoot, report.Message)
  assert.equal(await readFile(counterPath, 'utf8'), '5')
  assert.match(execFileSync('subst.exe', { encoding: 'utf8' }), new RegExp(`^${drive}`, 'mu'))
  assert.ok((await readdir(path.dirname(overlayRoot))).includes(path.basename(overlayRoot)))

  execFileSync('subst.exe', [drive, '/d'])
  await rm(overlayRoot, { recursive: true, force: true })
})

test('does not use the cached DSH version after overlay cleanup fails', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-cache-cleanup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await registerOverlayCleanup(t)
  const projectRoot = path.join(root, 'project')
  const scriptRoot = path.join(projectRoot, 'scripts')
  const mockBin = path.join(root, 'bin')
  const cacheRoot = path.join(root, 'cache')
  await mkdir(scriptRoot, { recursive: true })
  await mkdir(mockBin)
  await mkdir(cacheRoot)
  await copyFile(new URL('../scripts/run-dev-dsh.ps1', import.meta.url), path.join(scriptRoot, 'run-dev-dsh.ps1'))
  const helperSource = await readFile(new URL('../scripts/windows-lifecycle-path.ps1', import.meta.url), 'utf8')
  await writeFile(
    path.join(scriptRoot, 'windows-lifecycle-path.ps1'),
    helperSource.replaceAll(
      "(Join-Path ([Environment]::SystemDirectory) 'subst.exe')",
      '$env:PTC_MOCK_SUBST',
    ),
  )
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'path-probe' }))
  await writeFile(path.join(cacheRoot, 'dsh-version.txt'), '@deepseek-ai/dsh@alpha\r\n0.1.2-test\r\n')
  await writeFile(path.join(mockBin, 'npm.cmd'), '@node "%~dp0mock-npm.cjs" %*\r\n')
  await writeFile(path.join(mockBin, 'mock-npm.cjs'), 'process.stdout.write(\'"0.1.2-live"\')\n')

  const mockSubstScript = path.join(root, 'mock-subst.cjs')
  const mockSubstCommand = path.join(root, 'mock-subst.cmd')
  await writeFile(mockSubstScript, String.raw`
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[1]?.toLowerCase() === '/d') process.exit(19)
const result = spawnSync(process.env.PTC_REAL_SUBST, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  await writeFile(mockSubstCommand, `@"${process.execPath}" "${mockSubstScript}" %*\r\n`)

  const executablePath = [
    mockBin,
    path.dirname(process.execPath),
    path.join(process.env.SystemRoot, 'System32'),
  ].join(';')
  const result = spawnSync(resolveWindowsCommand('powershell.exe'), [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scriptRoot, 'run-dev-dsh.ps1'), 'web', '--version',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: windowsEnvironment(executablePath, {
      DSH_DEV_CACHE: cacheRoot,
      PTC_MOCK_SUBST: mockSubstCommand,
      PTC_REAL_SUBST: path.join(process.env.SystemRoot, 'System32', 'subst.exe'),
    }),
  })

  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /Failed to release lifecycle PATH overlay/u)
  assert.doesNotMatch(output, /reusing cached DSH/u)
})

test('leaves lifecycle environment unchanged after an install-dev command fails', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-shell-restore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await registerOverlayCleanup(t)
  const projectRoot = path.join(root, 'project')
  const scriptRoot = path.join(projectRoot, 'scripts')
  const mockBin = path.join(root, 'bin')
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(scriptRoot, { recursive: true })
  await mkdir(mockBin)
  await mkdir(dshHome)
  for (const filename of [
    'install-dev.ps1',
    'windows-lifecycle-path.ps1',
  ]) {
    await copyFile(new URL(`../scripts/${filename}`, import.meta.url), path.join(scriptRoot, filename))
  }
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'path-probe' }))
  await writeFile(path.join(mockBin, 'npm.cmd'), '@node "%~dp0mock-npm.cjs" %*\r\n')
  await writeFile(path.join(mockBin, 'dsh.cmd'), '@exit /b 0\r\n')
  await writeFile(path.join(mockBin, 'mock-npm.cjs'), String.raw`
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.PTC_COMMAND_ENV_REPORT, JSON.stringify({
  nodeOptions: process.env.NODE_OPTIONS,
  scriptShell: process.env.npm_config_script_shell,
}))
process.exit(23)
`)
  const wrapperPath = path.join(root, 'invoke.ps1')
  await writeFile(wrapperPath, String.raw`
$env:NODE_OPTIONS = '--no-warnings'
$env:npm_config_script_shell = 'original-shell'
$message = ''
try { & $env:PTC_INSTALL_SCRIPT test-profile } catch { $message = $_.Exception.Message }
[pscustomobject]@{
    Message = $message
    NodeOptions = $env:NODE_OPTIONS
    ScriptShell = $env:npm_config_script_shell
} | ConvertTo-Json -Compress
`)
  const commandReportPath = path.join(root, 'command-env.json')
  const executablePath = [
    mockBin,
    path.dirname(process.execPath),
    path.join(process.env.SystemRoot, 'System32'),
  ].join(';')
  const result = spawnSync(resolveWindowsCommand('powershell.exe'), [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: windowsEnvironment(executablePath, {
      DSH_HOME: dshHome,
      PTC_COMMAND_ENV_REPORT: commandReportPath,
      PTC_INSTALL_SCRIPT: path.join(scriptRoot, 'install-dev.ps1'),
    }),
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const wrapperReport = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1))
  const commandReport = JSON.parse(await readFile(commandReportPath, 'utf8'))
  assert.match(wrapperReport.Message, /exit code 23/u)
  assert.equal(wrapperReport.NodeOptions, '--no-warnings')
  assert.equal(wrapperReport.ScriptShell, 'original-shell')
  assert.equal(commandReport.nodeOptions, '--no-warnings')
  assert.equal(commandReport.scriptShell, 'original-shell')
})

test('install-dev normalizes PATH even when npm and dsh are already discoverable', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-install-dev-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await registerOverlayCleanup(t)
  const projectRoot = path.join(root, 'project')
  const scriptRoot = path.join(projectRoot, 'scripts')
  const mockBin = path.join(root, 'bin')
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(scriptRoot, { recursive: true })
  await mkdir(mockBin)
  await mkdir(dshHome)
  for (const filename of [
    'install-dev.ps1',
    'windows-lifecycle-path.ps1',
  ]) {
    await copyFile(new URL(`../scripts/${filename}`, import.meta.url), path.join(scriptRoot, filename))
  }
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'path-probe' }))
  await writeFile(path.join(mockBin, 'npm.cmd'), '@node "%~dp0mock-npm.cjs" %*\r\n')
  await writeFile(path.join(mockBin, 'dsh.cmd'), '@node "%~dp0mock-dsh.cjs" %*\r\n')
  await writeFile(path.join(mockBin, 'mock-npm.cjs'), String.raw`
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const destination = args[args.indexOf('--pack-destination') + 1]
writeFileSync(path.join(destination, 'path-probe.tgz'), 'snapshot')
writeFileSync(process.env.PTC_NPM_REPORT, JSON.stringify(args))
`)
  await writeFile(path.join(mockBin, 'mock-dsh.cjs'), String.raw`
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.PTC_DSH_REPORT, JSON.stringify(process.argv.slice(2)))
`)

  const basePath = [mockBin, path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32')]
    .join(';')
  const repetitions = Math.ceil(9000 / basePath.length)
  const duplicatedPath = Array.from({ length: repetitions }, () => basePath).join(';')
  assert.ok(duplicatedPath.length > 8191)
  const npmReport = path.join(root, 'npm.json')
  const dshReport = path.join(root, 'dsh.json')
  const result = spawnSync(resolveWindowsCommand('powershell.exe'), [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scriptRoot, 'install-dev.ps1'),
    'test-profile',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: windowsEnvironment(duplicatedPath, {
      DSH_HOME: dshHome,
      PTC_DSH_REPORT: dshReport,
      PTC_NPM_REPORT: npmReport,
    }),
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const npmArguments = JSON.parse(await readFile(npmReport, 'utf8'))
  const dshArguments = JSON.parse(await readFile(dshReport, 'utf8'))
  assert.deepEqual(npmArguments.slice(0, 2), ['pack', '--pack-destination'])
  assert.deepEqual(dshArguments.slice(0, 4), ['plugin', '--profile', 'test-profile', 'add'])
})

test('Windows launchers configure PATH handling before package commands', async () => {
  const cmdScript = await readFile(new URL('../scripts/run-dev-dsh.cmd', import.meta.url), 'utf8')
  const installScript = await readFile(new URL('../scripts/install-dev.ps1', import.meta.url), 'utf8')
  const isolatedScript = await readFile(new URL('../scripts/run-dev-dsh.ps1', import.meta.url), 'utf8')

  assert.doesNotMatch(cmdScript, /where\s+pwsh\.exe/iu)
  assert.match(cmdScript, /%ProgramFiles%\\PowerShell\\7\\pwsh\.exe/iu)
  assert.match(cmdScript, /%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/iu)
  for (const source of [installScript, isolatedScript]) {
    assert.match(source, /windows-lifecycle-path\.ps1/u)
    assert.ok(source.indexOf('Import-LatestWindowsPath') < source.indexOf('Get-Command npm'))
    assert.ok(source.indexOf('Invoke-WithWindowsPathOverlay') < source.indexOf("@('pack'"))
    assert.doesNotMatch(source, /npm_config_script_shell|NODE_OPTIONS/u)
  }
  assert.match(isolatedScript, /DshPtcPlusPathOverlayCleanup/u)
  assert.doesNotMatch(installScript, /Get-WindowsLifecyclePath|Invoke-WithWindowsLifecyclePath/u)
  assert.doesNotMatch(isolatedScript, /Get-WindowsLifecyclePath|Invoke-WithWindowsLifecyclePath/u)
})
