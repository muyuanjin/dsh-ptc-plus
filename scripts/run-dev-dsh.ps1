[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $ProfileName = $env:DSH_DEV_PROFILE,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $DshArguments
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-ExecutablePath {
    param(
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.CommandInfo] $Command
    )

    if (-not [string]::IsNullOrWhiteSpace($Command.Path)) {
        return $Command.Path
    }

    return $Command.Name
}

function Import-LatestWindowsPath {
    $pathValues = @(
        [Environment]::GetEnvironmentVariable('Path', 'Process')
        [Environment]::GetEnvironmentVariable('Path', 'Machine')
        [Environment]::GetEnvironmentVariable('Path', 'User')
    )
    $expandedValues = @($pathValues | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    } | ForEach-Object {
        [Environment]::ExpandEnvironmentVariables($_)
    })

    if ($expandedValues.Count -gt 0) {
        $env:Path = $expandedValues -join [IO.Path]::PathSeparator
    }
}

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FilePath,

        [Parameter(Mandatory = $true)]
        [string[]] $ArgumentList
    )

    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Command failed with exit code $exitCode`: $FilePath $($ArgumentList -join ' ')"
    }
}

function Get-Sha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $algorithm.ComputeHash($stream)
        return ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Resolve-Directory {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string] $ConfiguredPath,

        [Parameter(Mandatory = $true)]
        [string] $FallbackPath
    )

    if ([string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        return [IO.Path]::GetFullPath($FallbackPath)
    }

    $userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ($ConfiguredPath -eq '~') {
        $ConfiguredPath = $userHome
    } elseif ($ConfiguredPath.StartsWith('~/', [StringComparison]::Ordinal) -or
        $ConfiguredPath.StartsWith('~\', [StringComparison]::Ordinal)) {
        $ConfiguredPath = Join-Path $userHome $ConfiguredPath.Substring(2)
    }

    if ([IO.Path]::IsPathRooted($ConfiguredPath)) {
        return [IO.Path]::GetFullPath($ConfiguredPath)
    }

    return [IO.Path]::GetFullPath((Join-Path (Get-Location) $ConfiguredPath))
}

function Get-NpmPackageVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string] $NpmPath,

        [Parameter(Mandatory = $true)]
        [string] $PackageSpec,

        [Parameter(Mandatory = $true)]
        [string] $FallbackVersionFile
    )

    try {
        $raw = & $NpmPath view $PackageSpec version --json 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "npm view failed: $($raw -join ' ')"
        }

        $parsed = ($raw -join "`n") | ConvertFrom-Json
        $version = [string] $parsed
        if ([string]::IsNullOrWhiteSpace($version)) {
            throw "npm view returned no version for $PackageSpec"
        }
        return $version.Trim()
    } catch {
        if (Test-Path -LiteralPath $FallbackVersionFile -PathType Leaf) {
            $cachedLines = @(Get-Content -LiteralPath $FallbackVersionFile)
            if ($cachedLines.Count -ge 2) {
                $cachedSpec = [string] $cachedLines[0]
                $cachedVersion = [string] $cachedLines[1]
                if ($cachedSpec -eq $PackageSpec -and -not [string]::IsNullOrWhiteSpace($cachedVersion)) {
                    Write-Warning "Unable to query $PackageSpec; reusing cached DSH $cachedVersion."
                    return $cachedVersion.Trim()
                }
            }
        }
        throw
    }
}

function Remove-OldDirectories {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Root,

        [Parameter(Mandatory = $true)]
        [int] $Keep
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return
    }

    $directories = @(Get-ChildItem -LiteralPath $Root -Directory | Sort-Object LastWriteTime -Descending)
    if ($directories.Count -le $Keep) {
        return
    }

    foreach ($directory in $directories[$Keep..($directories.Count - 1)]) {
        Remove-Item -LiteralPath $directory.FullName -Recurse -Force
    }
}

function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint] $listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

Import-LatestWindowsPath

if ([string]::IsNullOrWhiteSpace($ProfileName)) {
    $ProfileName = 'web'
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $repositoryRoot 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "package.json was not found at $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$packageName = [string] $manifest.name
if ([string]::IsNullOrWhiteSpace($packageName)) {
    throw "package.json at $manifestPath does not declare a package name."
}

$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $npmCommand -or $null -eq $nodeCommand) {
    throw 'Node.js and npm were not found on PATH. Install Node.js before running this launcher.'
}

$npmPath = Get-ExecutablePath $npmCommand
$nodePath = Get-ExecutablePath $nodeCommand
$nodeDirectory = Split-Path -Parent $nodePath
if (-not [string]::IsNullOrWhiteSpace($nodeDirectory)) {
    $env:Path = $nodeDirectory + [IO.Path]::PathSeparator + $env:Path
}
$env:PATH = $env:Path
[Environment]::SetEnvironmentVariable('Path', $env:Path, 'Process')
# Prefer npm.cmd so native install scripts inherit Windows command semantics,
# even when PowerShell's npm.ps1 shim wins command resolution.
$npmCmdCandidate = Join-Path $nodeDirectory 'npm.cmd'
if (Test-Path -LiteralPath $npmCmdCandidate -PathType Leaf) {
    $npmPath = $npmCmdCandidate
}
$cacheFallback = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'dsh-ptc-plus-dev'
if ([string]::IsNullOrWhiteSpace($cacheFallback.Trim())) {
    $cacheFallback = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) '.dsh-ptc-plus-dev'
}
$cacheRoot = Resolve-Directory ($env:DSH_DEV_CACHE) $cacheFallback
$dshRoot = Join-Path $cacheRoot 'dsh'
$dshHome = Join-Path $cacheRoot 'dsh-home'
$pluginSnapshotRoot = Join-Path (Join-Path $cacheRoot 'plugin-snapshots') $packageName
$pnpmStore = Join-Path $cacheRoot 'pnpm-store'
$binRoot = Join-Path $cacheRoot 'bin'
$versionSpec = if ([string]::IsNullOrWhiteSpace($env:DSH_DEV_VERSION)) { 'alpha' } else { $env:DSH_DEV_VERSION.Trim() }
$keepCount = 3
if (-not [string]::IsNullOrWhiteSpace($env:DSH_DEV_MAX_VERSIONS)) {
    $parsedKeep = 0
    if ([int]::TryParse($env:DSH_DEV_MAX_VERSIONS, [ref] $parsedKeep)) {
        $keepCount = [Math]::Max(1, [Math]::Min(10, $parsedKeep))
    }
}

foreach ($directory in @($cacheRoot, $dshRoot, $dshHome, $pluginSnapshotRoot, $pnpmStore, $binRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$npmShim = Join-Path $binRoot 'npm.cmd'
if (Test-Path -LiteralPath (Join-Path $binRoot 'node.cmd') -PathType Leaf) {
    Remove-Item -LiteralPath (Join-Path $binRoot 'node.cmd') -Force
}
Set-Content -LiteralPath $npmShim -Encoding ASCII -Value "@echo off`r`ncall `"$npmPath`" %*`r`n"
$env:Path = $binRoot + [IO.Path]::PathSeparator + $env:Path
$env:PATH = $env:Path
[Environment]::SetEnvironmentVariable('Path', $env:Path, 'Process')

$cachedVersionFile = Join-Path $cacheRoot 'dsh-version.txt'
$packageSpec = "@deepseek-ai/dsh@$versionSpec"
$dshVersion = Get-NpmPackageVersion $npmPath $packageSpec $cachedVersionFile
$dshInstallDirectory = Join-Path $dshRoot ("dsh-" + ($dshVersion -replace '[^A-Za-z0-9._-]', '_'))
$dshCommandPath = Join-Path $dshInstallDirectory 'node_modules\.bin\dsh.cmd'
$dshInstallMarker = Join-Path $dshInstallDirectory '.install-complete'

if (-not (Test-Path -LiteralPath $dshCommandPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $dshInstallMarker -PathType Leaf)) {
    Write-Host "Installing @deepseek-ai/dsh@$dshVersion into $dshInstallDirectory ..."
    New-Item -ItemType Directory -Path $dshInstallDirectory -Force | Out-Null
    $localBinDirectory = Join-Path $dshInstallDirectory 'node_modules\.bin'
    New-Item -ItemType Directory -Path $localBinDirectory -Force | Out-Null
    $localNodePath = Join-Path $localBinDirectory 'node.exe'
    if (-not (Test-Path -LiteralPath $localNodePath -PathType Leaf)) {
        try {
            New-Item -ItemType HardLink -Path $localNodePath -Target $nodePath -Force | Out-Null
        } catch {
            Copy-Item -LiteralPath $nodePath -Destination $localNodePath -Force
        }
    }
    $env:npm_config_script_shell = 'cmd.exe'
    Invoke-ExternalCommand $npmPath @(
        'install',
        '--prefix', $dshInstallDirectory,
        '--no-package-lock',
        '--no-fund',
        '--no-audit',
        "@deepseek-ai/dsh@$dshVersion"
    )
    Set-Content -LiteralPath $dshInstallMarker -Value $dshVersion -Encoding ASCII
}
if (-not (Test-Path -LiteralPath $dshCommandPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $dshInstallMarker -PathType Leaf)) {
    throw "The DSH CLI was not created at $dshCommandPath"
}
Set-Content -LiteralPath $cachedVersionFile -Value @($packageSpec, $dshVersion) -Encoding ASCII

$pnpmShim = Join-Path $binRoot 'pnpm.cmd'
$corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
if ($null -ne $corepackCommand) {
    $corepackPath = Get-ExecutablePath $corepackCommand
    Set-Content -LiteralPath $pnpmShim -Encoding ASCII -Value "@echo off`r`ncall `"$corepackPath`" pnpm@10 --store-dir `"$pnpmStore`" %*`r`n"
} else {
    $pnpmRuntimeRoot = Join-Path $cacheRoot 'pnpm-runtime'
    $pnpmEntrypoint = Join-Path $pnpmRuntimeRoot 'node_modules\pnpm\bin\pnpm.cjs'
    if (-not (Test-Path -LiteralPath $pnpmEntrypoint -PathType Leaf)) {
        Invoke-ExternalCommand $npmPath @(
            'install',
            '--prefix', $pnpmRuntimeRoot,
            '--no-package-lock',
            '--no-fund',
            '--no-audit',
            '--ignore-scripts',
            'pnpm@10'
        )
    }
    if (-not (Test-Path -LiteralPath $pnpmEntrypoint -PathType Leaf)) {
        throw "The pnpm runtime was not created at $pnpmEntrypoint"
    }
    Set-Content -LiteralPath $pnpmShim -Encoding ASCII -Value "@echo off`r`ncall `"$nodePath`" `"$pnpmEntrypoint`" --store-dir `"$pnpmStore`" %*`r`n"
}
$env:Path = $binRoot + [IO.Path]::PathSeparator + $env:Path
$env:PATH = $env:Path
[Environment]::SetEnvironmentVariable('Path', $env:Path, 'Process')

$stagingDirectory = Join-Path ([IO.Path]::GetTempPath()) ("dsh-ptc-plus-pack-" + [Guid]::NewGuid().ToString('N'))
$snapshotFile = $null
$locationPushed = $false
try {
    New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
    Push-Location $repositoryRoot
    $locationPushed = $true

    Write-Host "Packing $packageName from $repositoryRoot ..."
    Invoke-ExternalCommand $npmPath @('pack', '--ignore-scripts', '--pack-destination', $stagingDirectory)

    $archives = @(Get-ChildItem -LiteralPath $stagingDirectory -Filter '*.tgz' -File)
    if ($archives.Count -ne 1) {
        throw "Expected npm pack to produce exactly one tarball, found $($archives.Count)."
    }

    $packedArchive = $archives[0]
    $archiveHash = Get-Sha256 $packedArchive.FullName
    $snapshotId = 'sha256-' + $archiveHash.Substring(0, 16)
    $snapshotDirectory = Join-Path $pluginSnapshotRoot $snapshotId
    $packageLeaf = ($packageName -split '/')[-1]
    $snapshotFile = Join-Path $snapshotDirectory ($packageLeaf + '.tgz')

    if (Test-Path -LiteralPath $snapshotDirectory -PathType Container) {
        if (-not (Test-Path -LiteralPath $snapshotFile -PathType Leaf)) {
            throw "Snapshot directory already exists without its tarball: $snapshotDirectory"
        }
        if ((Get-Sha256 $snapshotFile) -ne $archiveHash) {
            throw "Snapshot hash collision or modified snapshot detected: $snapshotFile"
        }
        Write-Host "Reusing immutable plugin snapshot: $snapshotFile"
    } else {
        New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null
        Copy-Item -LiteralPath $packedArchive.FullName -Destination $snapshotFile
        Write-Host "Created immutable plugin snapshot: $snapshotFile"
    }
    (Get-Item -LiteralPath $snapshotDirectory).LastWriteTime = Get-Date
} finally {
    if ($locationPushed) {
        Pop-Location
    }
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}

$env:DSH_HOME = $dshHome
$env:npm_config_store_dir = $pnpmStore
$profileDirectory = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
Copy-Item -LiteralPath $pnpmShim -Destination (Join-Path $profileDirectory 'pnpm.cmd') -Force
Write-Host "Installing $packageName into isolated DSH profile '$ProfileName' ..."
Invoke-ExternalCommand $dshCommandPath @('plugin', '--profile', $ProfileName, 'add', $snapshotFile)
Remove-OldDirectories $pluginSnapshotRoot $keepCount
$dshInstallDirectoryItem = Get-Item -LiteralPath $dshInstallDirectory
$dshInstallDirectoryItem.LastWriteTime = Get-Date
Remove-OldDirectories $dshRoot $keepCount

# DSH forwards plugin management to pnpm. Pruning its dedicated store keeps
# repeated DSH/plugin upgrades bounded without touching the user's global store.
Invoke-ExternalCommand $pnpmShim @('store', 'prune')

Write-Host "Starting DSH $dshVersion with profile '$ProfileName'."
$launchArguments = @('--profile', $ProfileName)
if ($null -ne $DshArguments) {
    $launchArguments += $DshArguments
}
if ($ProfileName -eq 'web' -and -not ($launchArguments | Where-Object { $_ -eq '--port' -or $_ -like '--port=*' })) {
    $configuredPort = $env:DSH_DEV_PORT
    if ([string]::IsNullOrWhiteSpace($configuredPort)) {
        $configuredPort = [string] (Get-FreeLoopbackPort)
    }
    if ($configuredPort -notmatch '^\d+$' -or [int] $configuredPort -lt 0 -or [int] $configuredPort -gt 65535) {
        throw "DSH_DEV_PORT must be an integer between 0 and 65535."
    }
    $launchArguments += @('--port', $configuredPort)
    Write-Host "Using Web port $configuredPort."
}
& $dshCommandPath @launchArguments
exit $LASTEXITCODE
