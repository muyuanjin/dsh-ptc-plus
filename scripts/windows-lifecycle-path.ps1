function ConvertTo-WindowsPathEntries {
    param(
        [AllowNull()]
        [string[]] $PathValues
    )

    $pathEntries = [Collections.Generic.List[string]]::new()
    foreach ($pathValue in $PathValues) {
        if ([string]::IsNullOrWhiteSpace($pathValue)) {
            continue
        }

        $expandedPath = [Environment]::ExpandEnvironmentVariables($pathValue)
        foreach ($pathEntry in $expandedPath.Split([IO.Path]::PathSeparator)) {
            $pathEntry = $pathEntry.Trim().Trim('"')
            if (-not [string]::IsNullOrWhiteSpace($pathEntry)) {
                [void] $pathEntries.Add($pathEntry)
            }
        }
    }

    return $pathEntries.ToArray()
}

function Import-LatestWindowsPath {
    $pathValues = @(
        [Environment]::GetEnvironmentVariable('Path', 'Process')
        [Environment]::GetEnvironmentVariable('Path', 'Machine')
        [Environment]::GetEnvironmentVariable('Path', 'User')
    )
    $pathEntries = [Collections.Generic.List[string]]::new()
    $seenEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

    foreach ($pathEntry in (ConvertTo-WindowsPathEntries $pathValues)) {
        if ($seenEntries.Add($pathEntry)) {
            [void] $pathEntries.Add($pathEntry)
        }
    }

    if ($pathEntries.Count -gt 0) {
        $env:Path = $pathEntries -join [IO.Path]::PathSeparator
    }
}

# cmd.exe drops an oversized inherited PATH. One command-scoped drive mapping
# preserves the complete ordered search surface for the command and its children.
function New-WindowsPathOverlay {
    param(
        [string] $SubstPath = (Join-Path ([Environment]::SystemDirectory) 'subst.exe')
    )

    $pathEntries = [Collections.Generic.List[string]]::new()
    $seenEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($pathEntry in (ConvertTo-WindowsPathEntries @($env:Path))) {
        $absoluteEntry = [IO.Path]::GetFullPath($pathEntry)
        if ($seenEntries.Add($absoluteEntry)) {
            [void] $pathEntries.Add($absoluteEntry)
        }
    }

    $overlayRoot = Join-Path ([IO.Path]::GetTempPath()) ("dsh-lifecycle-path-" + [Guid]::NewGuid().ToString('N'))
    $overlayDrive = $null
    try {
        New-Item -ItemType Directory -Path $overlayRoot -Force | Out-Null
        for ($index = 0; $index -lt $pathEntries.Count; $index += 1) {
            $aliasPath = Join-Path $overlayRoot $index.ToString('x')
            $targetPath = $pathEntries[$index]
            if (Test-Path -LiteralPath $targetPath -PathType Container) {
                try {
                    New-Item -ItemType Junction -Path $aliasPath -Target $targetPath | Out-Null
                } catch {
                    New-Item -ItemType SymbolicLink -Path $aliasPath -Target $targetPath | Out-Null
                }
            } else {
                New-Item -ItemType Directory -Path $aliasPath | Out-Null
            }
        }

        for ($code = [int] [char] 'Z'; $code -ge [int] [char] 'D'; $code -= 1) {
            $candidateDrive = ([char] $code).ToString() + ':'
            if (Test-Path -LiteralPath ($candidateDrive + '\')) {
                continue
            }

            & $SubstPath $candidateDrive $overlayRoot
            if ($LASTEXITCODE -eq 0) {
                $overlayDrive = $candidateDrive
                break
            }
        }
        if ($null -eq $overlayDrive) {
            throw 'No unused Windows drive letter is available for the lifecycle PATH overlay.'
        }

        $compactEntries = @(
            for ($index = 0; $index -lt $pathEntries.Count; $index += 1) {
                $overlayDrive + '\' + $index.ToString('x')
            }
        )
        $compactPath = $compactEntries -join [IO.Path]::PathSeparator
        if ($compactPath.Length -gt 8190) {
            throw "The complete compact lifecycle PATH is still $($compactPath.Length) characters."
        }

        return [pscustomobject]@{
            Path = $compactPath
            Root = $overlayRoot
            Drive = $overlayDrive
            SubstPath = $SubstPath
        }
    } catch {
        if ($null -ne $overlayDrive) {
            Remove-WindowsPathOverlay -Drive $overlayDrive -Root $overlayRoot -SubstPath $SubstPath
        } elseif (Test-Path -LiteralPath $overlayRoot) {
            Remove-Item -LiteralPath $overlayRoot -Recurse -Force
        }
        throw
    }
}

function Remove-WindowsPathOverlay {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Drive,

        [Parameter(Mandatory = $true)]
        [string] $Root,

        [Parameter(Mandatory = $true)]
        [string] $SubstPath,

        [int] $Attempts = 5,

        [int] $RetryDelayMilliseconds = 50
    )

    $lastFailure = 'unknown failure'
    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        try {
            & $SubstPath $Drive /d | Out-Null
            $exitCode = $LASTEXITCODE
            if ($exitCode -eq 0) {
                Remove-Item -LiteralPath $Root -Recurse -Force
                return
            }
            $lastFailure = "exit code $exitCode"
        } catch {
            $lastFailure = $_.Exception.Message
        }

        if ($attempt -lt $Attempts) {
            Start-Sleep -Milliseconds $RetryDelayMilliseconds
        }
    }

    $cleanupError = [InvalidOperationException]::new(
        "Failed to release lifecycle PATH overlay $Drive after $Attempts attempts ($lastFailure). Its recovery root was preserved at $Root"
    )
    $cleanupError.Data['DshPtcPlusPathOverlayCleanup'] = $true
    throw $cleanupError
}

function Invoke-WithWindowsPathOverlay {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock] $Action,

        [string] $SubstPath = (Join-Path ([Environment]::SystemDirectory) 'subst.exe')
    )

    $ambientPath = $env:Path
    $overlay = New-WindowsPathOverlay -SubstPath $SubstPath
    try {
        $env:Path = $overlay.Path
        & $Action
    } finally {
        $env:Path = $ambientPath
        Remove-WindowsPathOverlay -Drive $overlay.Drive -Root $overlay.Root -SubstPath $overlay.SubstPath
    }
}
