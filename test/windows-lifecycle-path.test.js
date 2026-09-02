import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
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

function spawnNpmWithNormalizedPath(shellPath, argumentsList, options) {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $env:PTC_TEST_HELPER
Import-LatestWindowsPath -Prepend @($env:PTC_TEST_NODE_DIRECTORY)
$npmArguments = @($env:PTC_TEST_NPM_ARGUMENTS | ConvertFrom-Json)
$npmOutput = & $env:PTC_TEST_NODE $env:PTC_TEST_NPM_CLI @npmArguments 2>&1
$npmExitCode = $LASTEXITCODE
[pscustomobject]@{
    ExitCode = $npmExitCode
    Output = ($npmOutput | Out-String).Trim()
} | ConvertTo-Json -Compress
exit $npmExitCode
`
  return spawnSync(shellPath, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    ...options,
    env: {
      ...options.env,
      PTC_TEST_HELPER: helperPath,
      PTC_TEST_NODE: process.execPath,
      PTC_TEST_NODE_DIRECTORY: path.dirname(process.execPath),
      PTC_TEST_NPM_CLI: npmCliPath(),
      PTC_TEST_NPM_ARGUMENTS: JSON.stringify(argumentsList),
    },
  })
}

for (const shellName of ['powershell.exe', 'pwsh.exe']) {
  const shellPath = resolveWindowsCommand(shellName)
  test(`deduplicates PATH before a real npm lifecycle under ${shellName}`, {
    skip: shellPath === null,
  }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-windows-path-'))
    t.after(() => rm(root, { recursive: true, force: true }))
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
    $env:PTC_TEST_NODE_DIRECTORY
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
Import-LatestWindowsPath -Prepend @($env:PTC_TEST_NODE_DIRECTORY)
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
$npmOutput = & $env:PTC_TEST_NODE $env:PTC_TEST_NPM_CLI run probe --silent 2>&1
$npmExitCode = $LASTEXITCODE
[pscustomobject]@{
    BeforeLength = $beforeLength
    AfterLength = $env:Path.Length
    ExpectedCount = $expectedEntries.Count
    ActualCount = $actualEntries.Count
    SameEntries = $sameEntries
    BeforeNodeExit = $beforeNodeExit
    NpmExitCode = $npmExitCode
    NpmOutput = ($npmOutput | Out-String).Trim()
} | ConvertTo-Json -Compress
`
    const scriptPath = path.join(root, 'verify.ps1')
    await writeFile(scriptPath, script)
    const result = spawnSync(shellPath, [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], {
      cwd: lifecycleDirectory,
      encoding: 'utf8',
      env: windowsEnvironment(duplicatedPath, {
        PTC_TEST_HELPER: helperPath,
        PTC_TEST_NODE: process.execPath,
        PTC_TEST_NODE_DIRECTORY: path.dirname(process.execPath),
        PTC_TEST_NPM_CLI: npmCliPath(),
      }),
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout.trim())
    assert.ok(report.BeforeLength > 8191)
    assert.notEqual(report.BeforeNodeExit, 0)
    assert.ok(report.AfterLength < 8191)
    assert.equal(report.ActualCount, report.ExpectedCount)
    assert.equal(report.SameEntries, true)
    assert.equal(report.NpmExitCode, 0)
    assert.match(report.NpmOutput, /^v\d+/u)
  })
}

test('rejects a genuinely oversized unique PATH without creating system resources', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-unique-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const uniquePath = Array.from(
    { length: 400 },
    (_, index) => path.join(root, `unique-path-entry-${index.toString().padStart(4, '0')}`),
  ).join(';')
  assert.ok(uniquePath.length > 8191)
  const substBefore = execFileSync('subst.exe', { encoding: 'utf8' })
  const command = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $env:PTC_TEST_HELPER
try {
    Import-LatestWindowsPath
    [pscustomobject]@{ Succeeded = $true; Message = '' } | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{ Succeeded = $false; Message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`
  const result = spawnSync(resolveWindowsCommand('pwsh.exe'), [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], {
    encoding: 'utf8',
    env: windowsEnvironment(uniquePath, { PTC_TEST_HELPER: helperPath }),
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.Succeeded, false)
  assert.match(report.Message, /after removing duplicate entries/u)
  assert.match(report.Message, /Shorten the process, user, or machine PATH/u)
  assert.equal(execFileSync('subst.exe', { encoding: 'utf8' }), substBefore)
})

test('preserves appended arguments in nested npm lifecycle scripts', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
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

  const result = spawnNpmWithNormalizedPath(resolveWindowsCommand('powershell.exe'), [
    'install', '--no-audit', '--no-fund', '--no-package-lock',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: windowsEnvironment(process.env.Path, {
      PTC_ARGUMENT_REPORT: reportPath,
    }),
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(JSON.parse(result.stdout.trim()).ExitCode, 0)
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), [
    'hello',
    'two words',
    'https://example.test/a/b',
  ])
})

test('rejects an oversized PATH before using the cached DSH version', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-path-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = path.join(root, 'project')
  const scriptRoot = path.join(projectRoot, 'scripts')
  const cacheRoot = path.join(root, 'cache')
  await mkdir(scriptRoot, { recursive: true })
  await mkdir(cacheRoot)
  await copyFile(new URL('../scripts/run-dev-dsh.ps1', import.meta.url), path.join(scriptRoot, 'run-dev-dsh.ps1'))
  await copyFile(new URL('../scripts/windows-lifecycle-path.ps1', import.meta.url), path.join(scriptRoot, 'windows-lifecycle-path.ps1'))
  await writeFile(path.join(cacheRoot, 'dsh-version.txt'), '@deepseek-ai/dsh@alpha\r\n0.1.2-test\r\n')
  const uniquePath = Array.from(
    { length: 400 },
    (_, index) => path.join(root, `unique-path-entry-${index.toString().padStart(4, '0')}`),
  ).join(';')
  const result = spawnSync(resolveWindowsCommand('powershell.exe'), [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scriptRoot, 'run-dev-dsh.ps1'), 'web', '--version',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: windowsEnvironment(uniquePath, { DSH_DEV_CACHE: cacheRoot }),
  })

  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /after removing duplicate entries/u)
  assert.doesNotMatch(output, /reusing cached DSH/u)
})

test('leaves unrelated lifecycle environment unchanged after an install-dev command fails', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-plus-shell-restore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = path.join(root, 'project')
  const scriptRoot = path.join(projectRoot, 'scripts')
  const mockBin = path.join(root, 'bin')
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(scriptRoot, { recursive: true })
  await mkdir(mockBin)
  await mkdir(dshHome)
  for (const filename of ['install-dev.ps1', 'windows-lifecycle-path.ps1']) {
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
  const projectRoot = path.join(root, 'project')
  const scriptRoot = path.join(projectRoot, 'scripts')
  const mockBin = path.join(root, 'bin')
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(scriptRoot, { recursive: true })
  await mkdir(mockBin)
  await mkdir(dshHome)
  for (const filename of ['install-dev.ps1', 'windows-lifecycle-path.ps1']) {
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
writeFileSync(process.env.PTC_NPM_REPORT, JSON.stringify({ args, path: process.env.Path }))
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
  const npmReportPath = path.join(root, 'npm.json')
  const dshReportPath = path.join(root, 'dsh.json')
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
      PTC_DSH_REPORT: dshReportPath,
      PTC_NPM_REPORT: npmReportPath,
    }),
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const npmReport = JSON.parse(await readFile(npmReportPath, 'utf8'))
  const dshArguments = JSON.parse(await readFile(dshReportPath, 'utf8'))
  assert.deepEqual(npmReport.args.slice(0, 2), ['pack', '--pack-destination'])
  const normalizedEntries = npmReport.path.split(';')
  assert.equal(new Set(normalizedEntries.map(entry => entry.toLowerCase())).size, normalizedEntries.length)
  assert.ok(npmReport.path.length < duplicatedPath.length)
  assert.deepEqual(dshArguments.slice(0, 4), ['plugin', '--profile', 'test-profile', 'add'])
})

test('Windows launchers normalize PATH without persistent system resources', async () => {
  const helperScript = await readFile(new URL('../scripts/windows-lifecycle-path.ps1', import.meta.url), 'utf8')
  const cmdScript = await readFile(new URL('../scripts/run-dev-dsh.cmd', import.meta.url), 'utf8')
  const installScript = await readFile(new URL('../scripts/install-dev.ps1', import.meta.url), 'utf8')
  const isolatedScript = await readFile(new URL('../scripts/run-dev-dsh.ps1', import.meta.url), 'utf8')

  assert.doesNotMatch(cmdScript, /where\s+pwsh\.exe/iu)
  assert.match(cmdScript, /%ProgramFiles%\\PowerShell\\7\\pwsh\.exe/iu)
  assert.match(cmdScript, /%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/iu)
  assert.match(helperScript, /after removing duplicate entries/u)
  assert.doesNotMatch(helperScript, /subst|New-Item|Remove-Item|Junction|SymbolicLink/iu)
  for (const source of [installScript, isolatedScript]) {
    assert.match(source, /windows-lifecycle-path\.ps1/u)
    assert.ok(source.indexOf('Import-LatestWindowsPath') < source.indexOf('Get-Command npm'))
    assert.doesNotMatch(source, /WindowsPathOverlay|\bsubst\b|npm_config_script_shell|NODE_OPTIONS/iu)
  }
  assert.match(isolatedScript, /Import-LatestWindowsPath -Prepend @\(\$binRoot, \$nodeDirectory\)/u)
})
