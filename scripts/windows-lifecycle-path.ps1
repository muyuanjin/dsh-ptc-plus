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
    param(
        [AllowEmptyCollection()]
        [string[]] $Prepend = @()
    )

    $pathValues = @(
        $Prepend
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

    if ($pathEntries.Count -eq 0) {
        return
    }

    $normalizedPath = $pathEntries -join [IO.Path]::PathSeparator
    if ($normalizedPath.Length -gt 8190) {
        throw "Windows PATH is $($normalizedPath.Length) characters after removing duplicate entries; cmd.exe supports at most 8191. Shorten the process, user, or machine PATH before running this script."
    }

    $env:Path = $normalizedPath
}
