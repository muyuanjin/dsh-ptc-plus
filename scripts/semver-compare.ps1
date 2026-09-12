function Select-HighestVersion {
    # Selects the highest semantic version, prereleases included, according to
    # semantic versioning precedence. Build metadata is ignored for comparison.

    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        [AllowEmptyCollection()]
        [string[]] $Versions
    )

    begin {
        $candidates = [System.Collections.Generic.List[string]]::new()
    }

    process {
        foreach ($version in $Versions) {
            if (-not [string]::IsNullOrWhiteSpace($version)) {
                $candidates.Add($version)
            }
        }
    }

    end {
        if ($candidates.Count -eq 0) {
            throw 'No DSH versions were available to select.'
        }
        $highest = $candidates[0]
        for ($index = 1; $index -lt $candidates.Count; $index += 1) {
            if ((Compare-SemanticVersion $candidates[$index] $highest) -gt 0) {
                $highest = $candidates[$index]
            }
        }
        return $highest
    }
}

function Compare-SemanticVersion {
    # Compares canonical lowercase semantic versions and returns -1, 0, or 1.

    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $Left,

        [Parameter(Mandatory = $true)]
        [string] $Right
    )

    $leftParts = Split-SemanticVersion $Left
    $rightParts = Split-SemanticVersion $Right
    for ($index = 0; $index -lt 3; $index += 1) {
        $coreComparison = Compare-NumericIdentifier $leftParts.Numbers[$index] $rightParts.Numbers[$index]
        if ($coreComparison -ne 0) {
            return $coreComparison
        }
    }

    $leftPre = $leftParts.PreRelease
    $rightPre = $rightParts.PreRelease
    if ($leftPre.Count -eq 0 -and $rightPre.Count -eq 0) {
        return 0
    }
    if ($leftPre.Count -eq 0) {
        return 1
    }
    if ($rightPre.Count -eq 0) {
        return -1
    }

    $shared = [Math]::Min($leftPre.Count, $rightPre.Count)
    for ($index = 0; $index -lt $shared; $index += 1) {
        $leftIdentifier = [string] $leftPre[$index]
        $rightIdentifier = [string] $rightPre[$index]
        if ($leftIdentifier -ceq $rightIdentifier) {
            continue
        }

        $leftIsNumeric = $leftIdentifier -match '^[0-9]+$'
        $rightIsNumeric = $rightIdentifier -match '^[0-9]+$'
        if ($leftIsNumeric -and $rightIsNumeric) {
            $preReleaseComparison = Compare-NumericIdentifier $leftIdentifier $rightIdentifier
            if ($preReleaseComparison -ne 0) {
                return $preReleaseComparison
            }
            continue
        }
        if ($leftIsNumeric) {
            return -1
        }
        if ($rightIsNumeric) {
            return 1
        }
        return [Math]::Sign([string]::CompareOrdinal($leftIdentifier, $rightIdentifier))
    }

    return [Math]::Sign($leftPre.Count - $rightPre.Count)
}

function Split-SemanticVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $Version
    )

    $withoutMetadata = $Version.Trim().Split('+')[0]
    $separator = $withoutMetadata.IndexOf('-')
    if ($separator -lt 0) {
        $core = $withoutMetadata
        $preRelease = ''
    } else {
        $core = $withoutMetadata.Substring(0, $separator)
        $preRelease = $withoutMetadata.Substring($separator + 1)
    }

    $numbers = @('0', '0', '0')
    $segments = $core.Split('.')
    for ($index = 0; $index -lt 3; $index += 1) {
        if ($index -lt $segments.Count -and $segments[$index] -match '^[0-9]+$') {
            $numbers[$index] = $segments[$index]
        }
    }

    $identifiers = @()
    if (-not [string]::IsNullOrWhiteSpace($preRelease)) {
        $identifiers = @($preRelease.Split('.'))
    }

    return [pscustomobject] @{
        Numbers    = $numbers
        PreRelease = $identifiers
    }
}

function Compare-NumericIdentifier {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $Left,

        [Parameter(Mandatory = $true)]
        [string] $Right
    )

    # SemVer numeric identifiers are arbitrary-size decimal values. Trim leading
    # zeroes before comparing lengths so the operation cannot overflow an Int32
    # or depend on the host PowerShell numeric type.
    $leftNormalized = $Left.TrimStart('0')
    $rightNormalized = $Right.TrimStart('0')
    if ($leftNormalized.Length -eq 0) { $leftNormalized = '0' }
    if ($rightNormalized.Length -eq 0) { $rightNormalized = '0' }
    if ($leftNormalized.Length -ne $rightNormalized.Length) {
        return [Math]::Sign($leftNormalized.Length - $rightNormalized.Length)
    }
    return [Math]::Sign([string]::CompareOrdinal($leftNormalized, $rightNormalized))
}
