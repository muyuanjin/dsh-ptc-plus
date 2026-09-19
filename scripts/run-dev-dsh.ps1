[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $ProfileName = $env:DSH_DEV_PROFILE,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $DshArguments
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-lifecycle-path.ps1')
. (Join-Path $PSScriptRoot 'semver-compare.ps1')

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

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FilePath,

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

function Get-NpmPublishedVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string] $NpmPath,

        [Parameter(Mandatory = $true)]
        [string] $PackageSpec,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string] $VersionSpec,

        [Parameter(Mandatory = $true)]
        [string] $FallbackVersionFile,

        [string[]] $LegacySpecs = @()
    )

    $spec = if ([string]::IsNullOrWhiteSpace($VersionSpec)) { $PackageSpec } else { "$PackageSpec@$VersionSpec" }

    try {
        if ([string]::IsNullOrWhiteSpace($VersionSpec)) {
            # No explicit spec follows every published release, prereleases included,
            # so a build that stops tagging its dist-tag channel cannot pin this launcher
            # to an older release.
            $raw = & $NpmPath view $PackageSpec versions --json --prefer-online 2>&1
        } else {
            $raw = & $NpmPath view $spec version --json --prefer-online 2>&1
        }
        if ($LASTEXITCODE -ne 0) {
            throw "npm view failed: $($raw -join ' ')"
        }

        # The launcher exports npm configuration for its isolated pnpm store, so
        # an npm warning can arrive on the merged stream. Only the JSON document
        # itself may become the version answer.
        $json = (@($raw | Where-Object { $_ -is [string] }) -join "`n")
        if ([string]::IsNullOrWhiteSpace($VersionSpec)) {
            # ConvertFrom-Json emits the published versions as one array object;
            # enumerate it explicitly so the selector sees each version.
            $published = @(($json | ConvertFrom-Json) | ForEach-Object { [string] $_ })
            $version = Select-HighestVersion -Versions $published
        } else {
            $version = [string] ($json | ConvertFrom-Json)
            if ([string]::IsNullOrWhiteSpace($version)) {
                throw "npm view returned no version for $spec"
            }
        }
        return $version.Trim()
    } catch {
        if (Test-Path -LiteralPath $FallbackVersionFile -PathType Leaf) {
            $cachedLines = @(Get-Content -LiteralPath $FallbackVersionFile)
            if ($cachedLines.Count -ge 2) {
                $cachedSpec = [string] $cachedLines[0]
                $cachedVersion = [string] $cachedLines[1]
                $acceptedSpecs = @($spec) + @($LegacySpecs)
                if ($acceptedSpecs -contains $cachedSpec -and -not [string]::IsNullOrWhiteSpace($cachedVersion)) {
                    Write-Warning "Unable to query $spec; reusing cached DSH $cachedVersion."
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
        [int] $Keep,

        [string[]] $ProtectedPaths = @()
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return
    }

    $directories = @(Get-ChildItem -LiteralPath $Root -Directory | Sort-Object LastWriteTime -Descending)
    $protected = @($directories | Where-Object { $_.FullName -in $ProtectedPaths })
    $remaining = [Math]::Max(0, $Keep - $protected.Count)
    foreach ($directory in $directories) {
        if ($directory.FullName -in $ProtectedPaths) {
            continue
        }
        if ($remaining -gt 0) {
            $remaining -= 1
            continue
        }
        try {
            # A partial deletion must not be reused as a complete installation.
            $marker = Join-Path $directory.FullName '.install-complete'
            if (Test-Path -LiteralPath $marker -PathType Leaf) {
                Remove-Item -LiteralPath $marker -Force
            }
            Remove-Item -LiteralPath $directory.FullName -Recurse -Force
        } catch {
            Write-Warning "Unable to remove cached directory '$($directory.FullName)'; cleanup will retry on a later launch. $($_.Exception.Message)"
        }
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

function Test-LoopbackPortAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [int] $Port
    )

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
        return $true
    } catch [Net.Sockets.SocketException] {
        return $false
    } finally {
        $listener.Stop()
    }
}

function Get-ProfileWebPort {
    param(
        [Parameter(Mandatory = $true)]
        [string] $CachePath
    )

    if (Test-Path -LiteralPath $CachePath -PathType Leaf) {
        $cachedPort = (Get-Content -LiteralPath $CachePath -Raw).Trim()
        $parsedPort = 0
        if ($cachedPort -match '^\d+$' -and
            [int]::TryParse($cachedPort, [ref] $parsedPort) -and
            $parsedPort -ge 1 -and $parsedPort -le 65535 -and
            (Test-LoopbackPortAvailable $parsedPort)) {
            return $parsedPort
        }
    }

    $selectedPort = Get-FreeLoopbackPort
    $temporaryPath = "$CachePath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        Set-Content -LiteralPath $temporaryPath -Value $selectedPort -Encoding ASCII
        Move-Item -LiteralPath $temporaryPath -Destination $CachePath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
    return $selectedPort
}

Import-LatestWindowsPath

$registry = if ([string]::IsNullOrWhiteSpace($env:DSH_DEV_REGISTRY)) {
    'https://registry.npmjs.org/'
} else {
    $env:DSH_DEV_REGISTRY.Trim()
}
$registryUri = $null
if (-not [Uri]::TryCreate($registry, [UriKind]::Absolute, [ref] $registryUri) -or
    $registryUri.Scheme -notin @('https', 'http') -or
    [string]::IsNullOrWhiteSpace($registryUri.Host) -or
    $registryUri.UserInfo -ne '' -or $registryUri.Query -ne '' -or $registryUri.Fragment -ne '') {
    throw 'DSH_DEV_REGISTRY must be an absolute HTTP(S) registry URL without credentials, a query, or a fragment.'
}
$registry = $registryUri.AbsoluteUri.TrimEnd('/') + '/'
# Keep npm and DSH's pnpm subprocesses on the same registry, including scoped DSH packages.
$env:npm_config_registry = $registry
[Environment]::SetEnvironmentVariable('npm_config_@deepseek-ai:registry', $registry, 'Process')
Write-Host "Using development npm registry: $registry"

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
Import-LatestWindowsPath -Prepend @($nodeDirectory)
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
# Empty means "newest published"; any other value is an npm dist-tag or version.
$versionSpec = if ([string]::IsNullOrWhiteSpace($env:DSH_DEV_VERSION)) { '' } else { $env:DSH_DEV_VERSION.Trim() }
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
Import-LatestWindowsPath -Prepend @($binRoot, $nodeDirectory)

$cachedVersionFile = Join-Path $cacheRoot 'dsh-version.txt'
# An explicit spec keeps its dist-tag or version meaning; the default resolves
# every published version so the launcher always installs the newest release.
$packageSpec = if ([string]::IsNullOrWhiteSpace($versionSpec)) { '@deepseek-ai/dsh' } else { "@deepseek-ai/dsh@$versionSpec" }
$legacyDefaultSpecs = if ([string]::IsNullOrWhiteSpace($versionSpec)) {
    # The previous launcher used the alpha dist-tag as its default cache key.
    @('@deepseek-ai/dsh@alpha')
} else {
    @()
}
$dshVersion = Get-NpmPublishedVersion -NpmPath $npmPath -PackageSpec '@deepseek-ai/dsh' -VersionSpec $versionSpec `
    -FallbackVersionFile $cachedVersionFile -LegacySpecs $legacyDefaultSpecs
Write-Host "Resolved @deepseek-ai/dsh $dshVersion."
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
Remove-OldDirectories $pluginSnapshotRoot $keepCount @($snapshotDirectory)
$dshInstallDirectoryItem = Get-Item -LiteralPath $dshInstallDirectory
$dshInstallDirectoryItem.LastWriteTime = Get-Date
Remove-OldDirectories $dshRoot $keepCount @($dshInstallDirectory)

# DSH forwards plugin management to pnpm. Pruning its dedicated store keeps
# repeated DSH/plugin upgrades bounded without touching the user's global store.
try {
    Invoke-ExternalCommand $pnpmShim @('store', 'prune')
} catch {
    Write-Warning "Unable to prune the development pnpm store; continuing startup. $($_.Exception.Message)"
}

Write-Host "Starting DSH $dshVersion with profile '$ProfileName'."
$launchArguments = @('--profile', $ProfileName)
if ($null -ne $DshArguments) {
    $launchArguments += $DshArguments
}
if ($ProfileName -eq 'web' -and -not ($launchArguments | Where-Object { $_ -eq '--port' -or $_ -like '--port=*' })) {
    $configuredPort = $env:DSH_DEV_PORT
    if ([string]::IsNullOrWhiteSpace($configuredPort)) {
        $portCachePath = Join-Path $profileDirectory '.ptc-plus-dev-web-port'
        $configuredPort = [string] (Get-ProfileWebPort $portCachePath)
    }
    if ($configuredPort -notmatch '^\d+$' -or [int] $configuredPort -lt 0 -or [int] $configuredPort -gt 65535) {
        throw "DSH_DEV_PORT must be an integer between 0 and 65535."
    }
    $launchArguments += @('--port', $configuredPort)
    Write-Host "Using Web port $configuredPort."
}
$env:NODE_OPTIONS = (($env:NODE_OPTIONS, '--max-http-header-size=65536' | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
}) -join ' ').Trim()
& $dshCommandPath @launchArguments
exit $LASTEXITCODE
