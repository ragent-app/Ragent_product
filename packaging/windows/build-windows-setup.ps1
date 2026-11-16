[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$MsiProductVersion,
    [long]$MinimumFreeBytes = 4GB
)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($SourceRoot)
$output = [IO.Path]::GetFullPath($OutputPath)
$revision = (& git.exe -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $revision -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') { throw 'BUNDLE_SOURCE_IDENTITY_INVALID' }
if (@(& git.exe -C $source status --porcelain=v1 --untracked-files=all).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw 'BUNDLE_REQUIRES_CLEAN_SOURCE' }
$staging = Join-Path ([IO.Path]::GetTempPath()) ('ragent-bundle-' + [guid]::NewGuid().ToString('N'))
foreach ($root in @([IO.Path]::GetPathRoot($staging), [IO.Path]::GetPathRoot($output)) | Select-Object -Unique) {
    if (([IO.DriveInfo]::new($root)).AvailableFreeSpace -lt $MinimumFreeBytes) { throw 'BUNDLE_BUILD_FREE_SPACE_INSUFFICIENT' }
}
$node = Get-Command node.exe -ErrorAction Stop
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is required for the desktop build.' }
New-Item -ItemType Directory -Force $staging | Out-Null
$buildFailed = $false
try {
    $machine = Join-Path $staging 'Ragent.Machine.msi'
    $desktop = Join-Path $staging 'Ragent.Desktop.msi'
    $brand = Join-Path $staging ('brand-' + [guid]::NewGuid().ToString('N'))
    $desktopBuild = Join-Path $staging 'desktop-build'
    $payloadRoot = Join-Path $staging 'payload'
    New-Item -ItemType Directory -Force $payloadRoot | Out-Null
    $desktopPayload = Join-Path $payloadRoot 'Desktop'
    & (Join-Path $source 'packaging\windows\build-msi.ps1') -SourceRoot $source -OutputPath $machine -Version $Version -MsiProductVersion $MsiProductVersion -MinimumFreeBytes $MinimumFreeBytes -CommittedTree
    if (-not (Test-Path -LiteralPath $machine -PathType Leaf)) { throw 'Machine MSI build failed.' }
    & (Join-Path $source 'packaging\windows\generate-brand-assets.ps1') -SourceRoot $source -OutputDirectory $brand
    New-Item -ItemType Directory -Force $desktopBuild | Out-Null
    foreach ($name in @('package.json','package-lock.json','main.cjs','preload.cjs','update-check.cjs','auto-update.cjs','update-linux.sh','update-macos.sh','update-windows.ps1','wait.html','stage-windows.mjs')) {
        Copy-Item -LiteralPath (Join-Path $source ('desktop\' + $name)) -Destination (Join-Path $desktopBuild $name)
    }
    Push-Location $desktopBuild
    try {
        & cmd.exe /c 'npm.cmd ci --no-audit --no-fund'
        if ($LASTEXITCODE -ne 0) { throw 'Locked Electron desktop dependencies could not be staged.' }
    } finally { Pop-Location }
    & $node.Source (Join-Path $desktopBuild 'stage-windows.mjs') $desktopPayload $brand $Version $source '--move-staged-electron'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $desktopPayload 'Ragent.exe') -PathType Leaf)) { throw 'Electron desktop staging failed.' }
    & (Join-Path $source 'packaging\windows\build-desktop-msi.ps1') -DesktopPayloadRoot $desktopPayload -OutputPath $desktop -Version $Version -MsiProductVersion $MsiProductVersion -BrandAssetDirectory $brand -VerifiedSourceCommit $revision
    if (-not (Test-Path -LiteralPath $desktop -PathType Leaf)) { throw 'Desktop MSI build failed.' }
    if ((& git.exe -C $source rev-parse HEAD).Trim() -cne $revision -or @(& git.exe -C $source status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'BUNDLE_SOURCE_CHANGED_DURING_BUILD' }
    & (Join-Path $source 'packaging\windows\build-setup-exe.ps1') -MsiPath $machine -DesktopMsiPath $desktop -IconPath (Join-Path $brand 'ragent.ico') -OutputPath $output
    if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'Setup build failed.' }
} catch {
    $buildFailed = $true
    throw
} finally {
    try {
        if (Test-Path -LiteralPath $staging -PathType Container) { Remove-Item -LiteralPath $staging -Recurse -Force }
    } catch {
        if ($buildFailed) { Write-Warning ('Bundle staging cleanup failed: ' + $_.Exception.Message) }
        else { throw }
    }
}
