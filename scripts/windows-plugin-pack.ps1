function Test-WindowsBuildDependencies {
    param([string] $Directory, [string] $NodePath)

    $probe = @'
const path = require('node:path');
const fs = require('node:fs');
const localRequire = require('node:module').createRequire(path.join(process.argv[1], 'package.json'));
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.argv[1], 'package.json'), 'utf8'));
  const lockPath = path.join(process.argv[1], 'package-lock.json');
  const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : {};
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const installed = JSON.parse(fs.readFileSync(path.join(process.argv[1], 'node_modules', name, 'package.json'), 'utf8'));
    const expected = lock.packages?.['node_modules/' + name]?.version;
    if (expected && installed.version !== expected) throw new Error(name + ' does not match package-lock.json');
    const packageRoot = fs.realpathSync(path.join(process.argv[1], 'node_modules', name));
    const checkEntry = target => {
      const entry = fs.realpathSync(target);
      const relativeEntry = path.relative(packageRoot, entry);
      if (relativeEntry === '..' || relativeEntry.startsWith('..' + path.sep) || path.isAbsolute(relativeEntry)) {
        throw new Error(name + ' resolves outside its local installed package');
      }
    };
    if (installed.bin) {
      const bins = typeof installed.bin === 'string' ? [installed.bin] : Object.values(installed.bin);
      for (const bin of bins) checkEntry(path.resolve(packageRoot, bin));
      // An executable-only package does not declare a module root.
      if (!installed.main && !installed.exports) continue;
    }
    try {
      checkEntry(localRequire.resolve(name));
    } catch (error) {
      // Subpath-only or import-only packages may have no require root.
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    }
  }
  const esbuild = localRequire('esbuild');
  esbuild.transformSync('const value: number = 1', { loader: 'ts' });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
'@
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $diagnostic = & $NodePath -e $probe $Directory 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{
        Ready = $exitCode -eq 0
        Diagnostic = ($diagnostic | Out-String).Trim()
    }
}

function Copy-WindowsPackSource {
    param([string] $RepositoryRoot, [string] $Directory, [object] $Manifest)

    # Only package inputs and prepack scripts enter the private build copy.
    # Refresh them on every pack so removed source cannot survive in the cache.
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($entry.Name -notin @('node_modules', '.dependency-inputs', '.pack.lock')) {
            Remove-Item -LiteralPath $entry.FullName -Recurse -Force
        }
    }
    $inputs = @('package.json', 'package-lock.json', '.npmrc', '.npmignore', 'scripts', 'README.md', 'LICENSE') + @($Manifest.files)
    foreach ($inputPath in ($inputs | Select-Object -Unique)) {
        foreach ($item in @(Get-ChildItem -Path (Join-Path $RepositoryRoot $inputPath) -Force -ErrorAction SilentlyContinue)) {
            $relativePath = $item.FullName.Substring($RepositoryRoot.TrimEnd('\', '/').Length + 1)
            $destination = Join-Path $Directory $relativePath
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse -Force
        }
    }
}

function Invoke-WindowsPluginPack {
    param(
        [Parameter(Mandatory = $true)] [string] $RepositoryRoot,
        [Parameter(Mandatory = $true)] [string] $NpmPath,
        [Parameter(Mandatory = $true)] [string] $NodePath,
        [Parameter(Mandatory = $true)] [string] $Destination
    )

    $manifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json
    $devDependencies = $manifest.PSObject.Properties['devDependencies']
    $needsEsbuild = $null -ne $devDependencies -and $null -ne $devDependencies.Value.PSObject.Properties['esbuild']
    $directory = $RepositoryRoot
    $cacheLease = $null
    $marker = $null
    $locationPushed = $false
    try {
        if ($needsEsbuild) {
            $probe = Test-WindowsBuildDependencies $RepositoryRoot $NodePath
            if (-not $probe.Ready) {
                Write-Host 'Checkout build dependencies cannot run under Windows; using win_node_modules.'
                Write-Host $probe.Diagnostic
                $lockPath = Join-Path $RepositoryRoot 'package-lock.json'
                if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
                    throw 'Automatic Windows dependency installation requires package-lock.json.'
                }
                $directory = Join-Path $RepositoryRoot 'win_node_modules'
                New-Item -ItemType Directory -Path $directory -Force | Out-Null
                try {
                    $cacheLease = [IO.File]::Open((Join-Path $directory '.pack.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
                } catch {
                    throw "Windows dependency cache is in use: $directory. Wait for the other pack to finish and retry."
                }

                $nodeIdentity = & $NodePath -p "[process.version, process.platform, process.arch, process.versions.modules].join('/')"
                if ($LASTEXITCODE -ne 0) { throw 'Unable to identify the Windows Node runtime.' }
                $inputIdentity = @(
                    (Get-FileHash -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Algorithm SHA256).Hash
                    (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash
                    $nodeIdentity
                    $env:npm_config_registry
                    [Environment]::GetEnvironmentVariable('npm_config_@deepseek-ai:registry', 'Process')
                ) -join "`n"
                $marker = Join-Path $directory '.dependency-inputs'
                $sameInputs = (Test-Path -LiteralPath $marker -PathType Leaf) -and
                    (Get-Content -LiteralPath $marker -Raw).TrimEnd("`r", "`n") -ceq $inputIdentity.TrimEnd("`r", "`n")
                Copy-WindowsPackSource $RepositoryRoot $directory $manifest
                Push-Location $directory
                $locationPushed = $true
                $cachedProbe = Test-WindowsBuildDependencies $directory $NodePath
                if (-not $sameInputs -or -not $cachedProbe.Ready) {
                    if (Test-Path -LiteralPath $marker -PathType Leaf) { Remove-Item -LiteralPath $marker -Force }
                    Write-Host 'Installing isolated Windows dependencies from package-lock.json ...'
                    Invoke-ExternalCommand $NpmPath @('ci', '--ignore-scripts', '--include=dev', '--include=optional', '--no-audit', '--no-fund')
                    $cachedProbe = Test-WindowsBuildDependencies $directory $NodePath
                    if (-not $cachedProbe.Ready) {
                        throw "Isolated Windows dependencies failed their execution check: $($cachedProbe.Diagnostic)"
                    }
                    Set-Content -LiteralPath $marker -Value $inputIdentity -Encoding UTF8
                } else {
                    Write-Host 'Reusing isolated Windows dependencies.'
                }
            }
        }
        if (-not $locationPushed) {
            Push-Location $directory
            $locationPushed = $true
        }
        Write-Host "Packing $($manifest.name) from $RepositoryRoot ..."
        try {
            Invoke-ExternalCommand $NpmPath @('pack', '--pack-destination', $Destination)
        } catch {
            # A failed prepack can expose damage beyond the readiness probe.
            # Keep the failure visible and require a clean install on retry.
            if ($null -ne $marker -and (Test-Path -LiteralPath $marker -PathType Leaf)) {
                Remove-Item -LiteralPath $marker -Force
            }
            throw
        }
    } finally {
        if ($locationPushed) { Pop-Location }
        if ($null -ne $cacheLease) { $cacheLease.Dispose() }
    }
}
