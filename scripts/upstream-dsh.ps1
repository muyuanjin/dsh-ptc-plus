# Official source preparation for run-upstream-dsh.cmd. No tracked Host files are patched.
function Open-UpstreamCacheLease {
    param([string] $CacheRoot)
    $lockPath = Join-Path $CacheRoot 'source.lock'
    try {
        return [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        throw "The upstream cache is already in use, or cannot be locked: $lockPath. Close its running launcher before retrying. $($_.Exception.Message)"
    }
}

function Get-UpstreamGitOutput {
    param([string] $GitPath, [string[]] $Arguments)
    $answer = & $GitPath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Upstream Git command failed: git $($Arguments -join ' ')" }
    return ($answer -join "`n").Trim()
}

function Initialize-UpstreamDsh {
    param(
        [string] $CacheRoot,
        [string] $NpmPath,
        [string] $NodePath,
        [string] $BinRoot,
        [string] $StorePath
    )
    $gitPath = Get-ExecutablePath (Get-Command git -ErrorAction Stop)
    $repository = Join-Path $CacheRoot 'repository.git'
    $upstream = 'https://github.com/deepseek-ai/deepseek-harness.git'
    if (-not (Test-Path -LiteralPath (Join-Path $repository 'HEAD'))) {
        Invoke-ExternalCommand $gitPath @('init', '--bare', $repository) | Out-Host
    }
    # Fetch the remote HEAD, not a hard-coded default branch or npm version.
    & $gitPath -C $repository fetch --depth=1 --no-tags $upstream HEAD | Out-Host
    if ($LASTEXITCODE -eq 0) {
        $commit = Get-UpstreamGitOutput $gitPath @('-C', $repository, 'rev-parse', '--verify', 'FETCH_HEAD')
        Invoke-ExternalCommand $gitPath @('-C', $repository, 'update-ref', 'refs/ptc/upstream', $commit) | Out-Host
    } else {
        $commit = Get-UpstreamGitOutput $gitPath @('-C', $repository, 'rev-parse', '--verify', 'refs/ptc/upstream')
        Write-Warning "Unable to fetch upstream HEAD; using cached source $commit. This is not proof of the latest upstream code."
    }
    if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'Upstream did not resolve to a full Git commit.' }
    $manifestText = Get-UpstreamGitOutput $gitPath @('-C', $repository, 'show', "${commit}:package.json")
    $manifest = $manifestText | ConvertFrom-Json
    $manager = [string] $manifest.packageManager
    if ($manager -notmatch '^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\.[0-9a-f]+)?$') {
        throw "Unsupported upstream packageManager: $manager"
    }
    $pnpmVersion = $Matches[1]
    $nodeIdentity = & $NodePath -p 'JSON.stringify([process.version,process.platform,process.arch,process.versions.modules])'
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Node runtime.' }
    $buildEnvironment = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^DSH_(CLIENT_|BUILD_)' } |
        Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" })
    $identity = (@('upstream-build-v1', $commit, $manager, $nodeIdentity, $env:npm_config_registry) + $buildEnvironment) -join "`n"
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
    $buildRoot = Join-Path $CacheRoot 'builds'
    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
    $directory = Join-Path $buildRoot ($commit.Substring(0, 12) + '-' + $digest.Substring(0, 16))
    $checkoutMarker = Join-Path $directory '.git\ptc-checkout-complete'
    if (-not (Test-Path -LiteralPath $checkoutMarker)) {
        Invoke-ExternalCommand $gitPath @('-c', 'core.longpaths=true', 'init', $directory) | Out-Host
        Invoke-ExternalCommand $gitPath @('-C', $directory, 'config', 'core.longpaths', 'true') | Out-Host
        Invoke-ExternalCommand $gitPath @('-C', $directory, 'fetch', '--depth=1', '--update-shallow', $repository, $commit) | Out-Host
        # Only an unfinished, launcher-owned checkout can be overwritten on retry.
        Invoke-ExternalCommand $gitPath @('-C', $directory, 'checkout', '--force', '--detach', $commit) | Out-Host
        Set-Content -LiteralPath $checkoutMarker -Value $commit -Encoding ASCII
    }
    $actualCommit = Get-UpstreamGitOutput $gitPath @('-C', $directory, 'rev-parse', 'HEAD')
    $changes = Get-UpstreamGitOutput $gitPath @('-C', $directory, 'status', '--porcelain', '--untracked-files=no')
    if ($actualCommit -ne $commit -or $changes -ne '') {
        throw "Cached upstream checkout was modified: $directory. Move it out of the builds cache before retrying."
    }
    $toolRoot = Join-Path (Join-Path $CacheRoot 'package-managers') $pnpmVersion
    $pnpmEntry = Join-Path $toolRoot 'node_modules\pnpm\bin\pnpm.cjs'
    $toolMarker = Join-Path $toolRoot '.install-complete'
    if (-not (Test-Path -LiteralPath $pnpmEntry) -or -not (Test-Path -LiteralPath $toolMarker)) {
        Invoke-ExternalCommand $NpmPath @('install', '--prefix', $toolRoot, '--no-package-lock', '--no-fund', '--no-audit', '--ignore-scripts', "pnpm@$pnpmVersion") | Out-Host
        Invoke-ExternalCommand $NodePath @($pnpmEntry, '--version') | Out-Host
        Set-Content -LiteralPath $toolMarker -Value $pnpmVersion -Encoding ASCII
    }
    $pnpmShim = Join-Path $BinRoot 'pnpm.cmd'
    # Environment expansion preserves Unicode paths even in ASCII CMD files,
    # including the copy installed beside the profile's package.json.
    $env:DSH_DEV_SOURCE_NODE = $NodePath
    $env:DSH_DEV_SOURCE_PNPM = $pnpmEntry
    $env:DSH_DEV_SOURCE_STORE = $StorePath
    $env:DSH_DEV_SOURCE_DIRECTORY = $directory
    $env:DSH_DEV_SOURCE_PNPM_SHIM = $pnpmShim
    Set-Content -LiteralPath $pnpmShim -Encoding ASCII -Value @'
@echo off
"%DSH_DEV_SOURCE_NODE%" "%DSH_DEV_SOURCE_PNPM%" --config.store-dir="%DSH_DEV_SOURCE_STORE%" %*
'@
    $command = Join-Path $BinRoot 'dsh-source.cmd'
    # cd is local to this child cmd process; source imports resolve from the upstream workspace.
    Set-Content -LiteralPath $command -Encoding ASCII -Value @'
@echo off
cd /d "%DSH_DEV_SOURCE_DIRECTORY%" || exit /b 1
call "%DSH_DEV_SOURCE_PNPM_SHIM%" run dsh %*
'@
    $marker = Join-Path $directory '.build-complete'
    $ready = (Test-Path -LiteralPath $marker) -and
        ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $digest) -and
        (Test-Path -LiteralPath (Join-Path $directory 'node_modules\.modules.yaml')) -and
        (Test-Path -LiteralPath (Join-Path $directory 'apps\cli\lib\bin.js'))
    if (-not $ready) {
        if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
        Push-Location $directory
        try {
            Invoke-ExternalCommand $pnpmShim @('install', '--frozen-lockfile') | Out-Host
            Invoke-ExternalCommand $pnpmShim @('run', 'build') | Out-Host
            Invoke-ExternalCommand $command @('--version') | Out-Host
            Set-Content -LiteralPath $marker -Value $digest -Encoding ASCII
        } finally { Pop-Location }
    } else {
        Write-Host "Reusing upstream build $commit in $directory"
    }
    Write-Host "Selected official upstream commit: $commit"
    return @{ Commit = $commit; Directory = $directory; Command = $command; Pnpm = $pnpmShim }
}
