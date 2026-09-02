[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $ProfileName = $env:DSH_PROFILE
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-lifecycle-path.ps1')

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

    $commandState = [pscustomobject]@{ ExitCode = 0 }
    Invoke-WithWindowsPathOverlay {
        & $FilePath @ArgumentList
        $commandState.ExitCode = $LASTEXITCODE
    }
    if ($commandState.ExitCode -ne 0) {
        throw "Command failed with exit code $($commandState.ExitCode)`: $FilePath $($ArgumentList -join ' ')"
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

function Resolve-DshHome {
    $userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $configuredHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')

    if ([string]::IsNullOrWhiteSpace($configuredHome)) {
        if ([string]::IsNullOrWhiteSpace($userHome)) {
            throw 'Unable to resolve the Windows user home directory for the default DSH_HOME.'
        }

        return [IO.Path]::GetFullPath((Join-Path $userHome '.dsh'))
    }

    if ($configuredHome -eq '~') {
        $configuredHome = $userHome
    } elseif ($configuredHome.StartsWith('~/', [StringComparison]::Ordinal) -or
        $configuredHome.StartsWith('~\', [StringComparison]::Ordinal)) {
        $configuredHome = Join-Path $userHome $configuredHome.Substring(2)
    }

    if ([IO.Path]::IsPathRooted($configuredHome)) {
        return [IO.Path]::GetFullPath($configuredHome)
    }

    return [IO.Path]::GetFullPath((Join-Path (Get-Location) $configuredHome))
}

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

# Explorer can retain the PATH from before Desktop or npm installed the DSH shim.
Import-LatestWindowsPath
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
$dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if ($null -eq $npmCommand -or $null -eq $nodeCommand) {
    throw 'Node.js and npm were not found on PATH. Install Node.js before running this script.'
}

if ($null -eq $dshCommand) {
    throw 'dsh was not found on PATH. Install the dsh CLI before running this script.'
}

$npmPath = Get-ExecutablePath $npmCommand
$dshPath = Get-ExecutablePath $dshCommand
$nodePath = Get-ExecutablePath $nodeCommand
$dshHome = Resolve-DshHome
$stagingDirectory = Join-Path ([IO.Path]::GetTempPath()) ("dsh-plugin-pack-" + [Guid]::NewGuid().ToString('N'))
$snapshotFile = $null
$locationPushed = $false

try {
    New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
    Push-Location $repositoryRoot
    $locationPushed = $true

    Write-Host "Packing $packageName from $repositoryRoot ..."
    Invoke-ExternalCommand $npmPath @('pack', '--pack-destination', $stagingDirectory)

    $archives = @(Get-ChildItem -LiteralPath $stagingDirectory -Filter '*.tgz' -File)
    if ($archives.Count -ne 1) {
        throw "Expected npm pack to produce exactly one tarball, found $($archives.Count)."
    }

    $packedArchive = $archives[0]
    $archiveHash = Get-Sha256 $packedArchive.FullName
    $snapshotId = 'sha256-' + $archiveHash.Substring(0, 16)
    $snapshotRoot = Join-Path (Join-Path $dshHome 'plugin-snapshots') $packageName
    $snapshotDirectory = Join-Path $snapshotRoot $snapshotId
    $packageLeaf = ($packageName -split '/')[-1]
    $snapshotFile = Join-Path $snapshotDirectory ($packageLeaf + '.tgz')

    if (Test-Path -LiteralPath $snapshotDirectory -PathType Container) {
        if (-not (Test-Path -LiteralPath $snapshotFile -PathType Leaf)) {
            throw "Snapshot directory already exists without its tarball: $snapshotDirectory"
        }

        $existingHash = Get-Sha256 $snapshotFile
        if ($existingHash -ne $archiveHash) {
            throw "Snapshot hash collision or modified snapshot detected: $snapshotFile"
        }

        Write-Host "Reusing immutable snapshot: $snapshotFile"
    } else {
        New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null
        Copy-Item -LiteralPath $packedArchive.FullName -Destination $snapshotFile
        Write-Host "Created immutable snapshot: $snapshotFile"
    }
} finally {
    if ($locationPushed) {
        Pop-Location
    }
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}

Write-Host "Installing snapshot into dsh profile '$ProfileName' ..."
Invoke-ExternalCommand $dshPath @('plugin', '--profile', $ProfileName, 'add', $snapshotFile)
Write-Host "Installed $packageName from an immutable snapshot into profile '$ProfileName'."
