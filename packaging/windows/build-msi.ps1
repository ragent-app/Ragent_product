[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$SourceRoot,
    [Parameter(Mandatory = $true)] [string]$OutputPath,
    [string]$Version = '0.0.1.0',
    [string]$SignedOwnerBootstrapPath = '',
    [string]$OwnerBootstrapPublisherSha256 = '',
    [switch]$ManagedOwnerPreparation,
    [switch]$ManagedOwnerActivation,
    [switch]$LegacySystemPreview,
    [switch]$InjectPostActivationFailure,
    [switch]$InjectPostRemovalFailure,
    [switch]$ExperimentalMajorUpgrade,
    [ValidateSet('major','minor')] [string]$MsiUpgradeLane = 'major',
    [string]$ProductCode = '*',
    [string]$MsiProductVersion = '',
    [string]$PreviousMsiProductVersion = '',
    [string]$PreviousMsiPath = '',
    [string]$PreviousMsiSha256 = '',
    [string]$WingetClientPackagePath = '',
    [string]$PowerShellRuntimeArchivePath = '',
    [switch]$CommittedTree,
    [ValidateRange(0, [long]::MaxValue)] [long]$MinimumFreeBytes = 0
)

$ErrorActionPreference = 'Stop'
# The default package uses the separated Owner activation lane. Legacy
# LocalSystem packages are explicit diagnostic previews and cannot claim that
# the Owner helper or a signature migrates their service/data identity.
if($SignedOwnerBootstrapPath -or $OwnerBootstrapPublisherSha256){throw 'OLG_SIGNED_INSTALLER_REQUIRED'}
if(@(@($ManagedOwnerPreparation.IsPresent,$ManagedOwnerActivation.IsPresent,$LegacySystemPreview.IsPresent)|Where-Object {$_}).Count -gt 1){throw 'MSI_OWNER_INSTALL_LANE_CONFLICT'}
$fullOwnerActivation=$ManagedOwnerActivation.IsPresent -or (-not $ManagedOwnerPreparation.IsPresent -and -not $LegacySystemPreview.IsPresent)
if($MsiUpgradeLane -eq 'minor' -and -not $fullOwnerActivation){throw 'MSI_MINOR_UPGRADE_REQUIRES_ACTIVATED_OWNER'}
if($ExperimentalMajorUpgrade -and ($MsiUpgradeLane -ne 'major' -or -not $fullOwnerActivation)){throw 'MSI_EXPERIMENTAL_MAJOR_LANE_REQUIRED'}
$useEarlyQuiescence=$fullOwnerActivation -and $MsiUpgradeLane -eq 'major'
if($InjectPostActivationFailure -and -not $fullOwnerActivation){throw 'MSI_ROLLBACK_INJECTION_REQUIRES_ACTIVATION_LANE'}
if($InjectPostRemovalFailure -and -not $fullOwnerActivation){throw 'MSI_REMOVAL_ROLLBACK_INJECTION_REQUIRES_ACTIVATION_LANE'}
if (-not (Get-Command wix.exe -ErrorAction SilentlyContinue)) { throw 'Pinned WiX 7 wix.exe is required to build the AgentoC MSI.' }
if (-not (Test-Path (Join-Path $SourceRoot 'chat-server.mjs'))) { throw 'SourceRoot must contain the AgentoC application tree.' }
if (-not (Test-Path (Join-Path $SourceRoot 'desktop\package.json'))) { throw 'SourceRoot must include the pinned desktop Electron project.' }
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Version must be a four-part numeric application version.' }
$applicationVersionParts=@($Version.Split('.')|ForEach-Object {[int]::Parse($_)})
$displayVersion=if($applicationVersionParts[3] -eq 0){$applicationVersionParts[0..2] -join '.'}else{$applicationVersionParts -join '.'}
if(-not $MsiProductVersion){
    if($MsiUpgradeLane -eq 'minor'){throw 'MSI_MINOR_EFFECTIVE_VERSION_REQUIRED'}
    $MsiProductVersion=($applicationVersionParts[0..2] -join '.')
}
function ConvertTo-MsiVersion([string]$Text){
    if($Text -notmatch '^\d+\.\d+\.\d+$'){throw 'MSI_EFFECTIVE_VERSION_FORMAT_REFUSED'}
    $parts=@($Text.Split('.')|ForEach-Object {[int]::Parse($_)})
    if($parts[0] -gt 255 -or $parts[1] -gt 255 -or $parts[2] -gt 65535){throw 'MSI_EFFECTIVE_VERSION_RANGE_REFUSED'}
    return [version]::new($parts[0],$parts[1],$parts[2])
}
$effectiveMsiVersion=ConvertTo-MsiVersion $MsiProductVersion
if($MsiUpgradeLane -eq 'minor'){
    if(-not $PreviousMsiProductVersion){throw 'MSI_MINOR_PREVIOUS_EFFECTIVE_VERSION_REQUIRED'}
    if(-not $PreviousMsiPath -or -not $PreviousMsiSha256){throw 'MSI_MINOR_PREVIOUS_PACKAGE_REQUIRED'}
    if($PreviousMsiProductVersion -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$'){throw 'MSI_MINOR_PREVIOUS_VERSION_FORMAT_REFUSED'}
    $previousEffectiveMsiVersion=ConvertTo-MsiVersion (($PreviousMsiProductVersion.Split('.')[0..2]) -join '.')
    if($effectiveMsiVersion.CompareTo($previousEffectiveMsiVersion) -le 0){throw 'MSI_MINOR_EFFECTIVE_VERSION_NOT_NEWER'}
}elseif($PreviousMsiProductVersion -or $PreviousMsiPath -or $PreviousMsiSha256){throw 'MSI_PREVIOUS_PACKAGE_ONLY_FOR_MINOR'}
if($MsiUpgradeLane -eq 'minor' -and $ProductCode -notmatch '^\{[A-Fa-f0-9]{8}-(?:[A-Fa-f0-9]{4}-){3}[A-Fa-f0-9]{12}\}$'){throw 'A minor MSI update requires the exact installed ProductCode GUID.'}
if($MsiUpgradeLane -eq 'major' -and $ProductCode -cne '*'){throw 'Major MSI builds must use a fresh ProductCode.'}
$msiUpgradeStrategy=if($MsiUpgradeLane -eq 'minor'){'none'}else{'majorUpgrade'}
$qrcodeTerminalVersion = '0.12.0'
$qrcodeTerminalSha256 = '3a6260c4e0d80bd527a3f930e90ea2348c03646621f25aa0bd960ee205a0a706'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildInputRoot = $SourceRoot
$frozenRevision = ''
$staging = Join-Path ([IO.Path]::GetTempPath()) ('agentoc-msi-' + [guid]::NewGuid().ToString('N'))
function Assert-BuildFreeSpace([string]$Phase) {
    if ($MinimumFreeBytes -eq 0) { return }
    foreach ($root in @([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($staging)), [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($OutputPath))) | Select-Object -Unique) {
        $drive = [IO.DriveInfo]::new($root)
        if (-not $drive.IsReady -or $drive.AvailableFreeSpace -lt $MinimumFreeBytes) {
            throw ("MSI_BUILD_FREE_SPACE_INSUFFICIENT: {0} at {1} requires {2} available bytes" -f $Phase, $root, $MinimumFreeBytes)
        }
    }
}
Assert-BuildFreeSpace 'before staging'
New-Item -ItemType Directory -Force $staging | Out-Null
try {
    $payloadRoot = Join-Path $staging 'payload'
    New-Item -ItemType Directory -Force $payloadRoot | Out-Null
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node -or -not (Test-Path -LiteralPath $node.Source -PathType Leaf)) {
        throw 'node.exe is required to create the self-contained Windows runtime payload.'
    }
    if ($CommittedTree) {
        if ([IO.Path]::GetFullPath($scriptRoot).TrimEnd('\') -ine [IO.Path]::GetFullPath((Join-Path $SourceRoot 'packaging\windows')).TrimEnd('\')) { throw 'Committed builds must start from the specified source tree.' }
        $frozenRevision = (& git -C $SourceRoot rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $frozenRevision -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') { throw 'Cannot determine committed build revision.' }
        # The small bootstrap that stages Git objects must itself match the
        # frozen commit; all subsequent build inputs come from that snapshot.
        foreach ($bootstrap in @('packaging/windows/build-msi.ps1', 'scripts/stage-runtime-payload.mjs', 'scripts/verify-runtime-payload.mjs')) {
            $expected = (& git -C $SourceRoot rev-parse ("${frozenRevision}:$bootstrap")).Trim()
            if ($LASTEXITCODE -ne 0) { throw "Committed bootstrap is missing: $bootstrap" }
            $actual = (& git -C $SourceRoot hash-object "--path=$bootstrap" (Join-Path $SourceRoot $bootstrap)).Trim()
            if ($LASTEXITCODE -ne 0 -or $actual -cne $expected) { throw "Committed bootstrap differs from the frozen commit: $bootstrap" }
        }
        $buildInputRoot = Join-Path $staging 'windows-build-inputs'
        & $node.Source (Join-Path $SourceRoot 'scripts\stage-runtime-payload.mjs') --source $SourceRoot --destination $payloadRoot --profile desktop --source-mode git-objects --windows-build-destination $buildInputRoot
        if ($LASTEXITCODE -ne 0) { throw 'Committed Windows runtime and build input staging failed.' }
        $runtimeSource = Get-Content -LiteralPath (Join-Path $payloadRoot 'runtime-payload-manifest.json') -Raw | ConvertFrom-Json
        $buildSource = Get-Content -LiteralPath (Join-Path $buildInputRoot 'windows-build-inputs-manifest.json') -Raw | ConvertFrom-Json
        if ($runtimeSource.sourceRevision -cne $frozenRevision -or $buildSource.sourceRevision -cne $frozenRevision -or (& git -C $SourceRoot rev-parse HEAD).Trim() -cne $frozenRevision) { throw 'Committed source changed during Windows staging.' }
        $scriptRoot = Join-Path $payloadRoot 'packaging\windows'
    }
    $whisperRuntimeRoot = ''
    if ($fullOwnerActivation) {
        Assert-BuildFreeSpace 'before optional Whisper staging'
        $whisperRuntimeRoot = Join-Path $staging 'whisper-runtime'
        $whisperCacheRoot = Join-Path $staging 'whisper-download-cache'
        & (Join-Path $scriptRoot 'stage-whisper-runtime.ps1') -OutputDirectory $whisperRuntimeRoot -CacheDirectory $whisperCacheRoot
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $whisperRuntimeRoot 'whisper-server.exe') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $whisperRuntimeRoot 'ggml-base-q5_1.bin') -PathType Leaf)) {
            throw 'The optional local voice runtime could not be staged.'
        }
        Assert-BuildFreeSpace 'after optional Whisper staging'
    }
    $brandRoot = Join-Path $staging ('brand-' + [guid]::NewGuid().ToString('N'))
    & (Join-Path $scriptRoot 'generate-brand-assets.ps1') -SourceRoot $buildInputRoot -OutputDirectory $brandRoot
    $installerUiRoot = ''
    $includeMingwUiRuntime = '0'
    if (-not $ManagedOwnerPreparation) {
        $installerUiRoot = Join-Path $staging ('installer-ui-' + [guid]::NewGuid().ToString('N'))
        & (Join-Path $scriptRoot 'build-agentoc-installer-ui.ps1') -OutputDirectory $installerUiRoot -BrandAssetDirectory $brandRoot
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $installerUiRoot 'AgentoC.MsiEmbeddedUI.dll') -PathType Leaf)) {
            throw 'The custom MSI embedded UI could not be built.'
        }
        $uiMetadata = Get-Content -LiteralPath (Join-Path $installerUiRoot 'installer-ui-build.json') -Raw | ConvertFrom-Json
        if ($uiMetadata.includeMingwRuntime) { $includeMingwUiRuntime = '1' }
    }
    # Never recursively copy a developer checkout. Use committed runtime inputs.
    if (-not $CommittedTree) {
        $runtimeStager = Join-Path $SourceRoot 'scripts\stage-runtime-payload.mjs'
        & $node.Source $runtimeStager --source $SourceRoot --destination $payloadRoot --profile desktop
        if ($LASTEXITCODE -ne 0) { throw 'Clean allowlisted Windows runtime staging failed.' }
    }
    & $node.Source (Join-Path $payloadRoot 'scripts\verify-windows-approval-payload.mjs') $payloadRoot
    if ($LASTEXITCODE -ne 0) { throw 'Windows approval payload inputs are incomplete.' }
    & (Join-Path $payloadRoot 'packaging\windows\build-safe-delete.ps1') -SourceRoot $payloadRoot -OutputPath (Join-Path $payloadRoot 'bin\agentoc-safe-delete.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Windows safe deletion helper could not be built.' }
    & (Join-Path $payloadRoot 'packaging\windows\build-cli-read-bridge.ps1') -SourceRoot $payloadRoot -OutputPath (Join-Path $payloadRoot 'bin\agentoc-cli-read-bridge.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Windows read-only CLI bridge could not be built.' }
    Assert-BuildFreeSpace 'after runtime staging'
    # Keep the host's displayed build version aligned with the actual package.
    & (Join-Path $scriptRoot 'write-package-version.ps1') -PayloadRoot $payloadRoot -Version $Version -BuildVersion $MsiProductVersion
    # Build Electron in a temporary, locked install so npm never mutates the
    # developer checkout. The staged tree contains only Electron's runtime and
    # the three desktop shell files, not npm or its build-only dependencies.
    $desktopBuildRoot = Join-Path $staging 'desktop-build'
    New-Item -ItemType Directory -Force $desktopBuildRoot | Out-Null
    foreach ($desktopInput in @('package.json', 'package-lock.json', 'main.cjs', 'preload.cjs', 'update-check.cjs', 'wait.html', 'stage-windows.mjs')) {
        Copy-Item -LiteralPath (Join-Path $buildInputRoot ('desktop\' + $desktopInput)) -Destination (Join-Path $desktopBuildRoot $desktopInput)
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is required to stage the pinned Electron desktop manager.' }
    Push-Location $desktopBuildRoot
    try {
        & cmd.exe /c 'npm.cmd ci --no-audit --no-fund'
        if ($LASTEXITCODE -ne 0) { throw 'Locked Electron desktop dependencies could not be staged.' }
    } finally { Pop-Location }
    $desktopPayloadRoot = Join-Path $payloadRoot 'Desktop'
    & $node.Source (Join-Path $desktopBuildRoot 'stage-windows.mjs') $desktopPayloadRoot $brandRoot $Version $buildInputRoot '--move-staged-electron'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $desktopPayloadRoot 'AgentoC.exe') -PathType Leaf)) {
        throw 'Branded, unelevated Electron runtime staging failed.'
    }
    Assert-BuildFreeSpace 'after desktop staging'
    # Keep the Windows payload self-contained and in parity with the Debian
    # builder: install only locked production dependencies in the staging tree.
    $payloadLock = Join-Path $payloadRoot 'package-lock.json'
    if (Test-Path $payloadLock) {
        if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is required to stage Windows production dependencies.' }
        Push-Location $payloadRoot
        try {
            # npm writes warnings (deprecations, audit notices) to stderr, and
            # Windows PowerShell 5.1 turns native stderr records into a
            # terminating error while $ErrorActionPreference = 'Stop' even when
            # npm itself succeeds.  Route the invocation through cmd.exe so the
            # build only depends on npm's real exit code (live trace
            # 2026-08-31: node-domexception deprecation notice aborted the
            # harvest before it started).
            & cmd.exe /c 'npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund'
            if ($LASTEXITCODE -ne 0) { throw 'Windows production dependency staging failed.' }
        } finally { Pop-Location }
    }
    Assert-BuildFreeSpace 'after dependency staging'
    # npm ci prunes packages absent from the app lock, including npm/corepack.
    # Stage the self-contained installer toolchain after ci, then smoke-test it.
    if ($CommittedTree) {
        & (Join-Path $scriptRoot 'stage-node-toolchain.ps1') -NodePath $node.Source -PayloadRoot $payloadRoot
    } else {
        & (Join-Path $SourceRoot 'packaging\windows\stage-node-toolchain.ps1') -NodePath $node.Source -PayloadRoot $payloadRoot
    }
    # Prune the staged declarations before adding the private PowerShell
    # runtime, so both do not need to occupy disk space at the same time.
    $nodeModulesRoot = [IO.Path]::GetFullPath((Join-Path $payloadRoot 'node_modules'))
    $nodeModulesPrefix = $nodeModulesRoot.TrimEnd('\') + '\'
    $typeDeclarationFiles = @(Get-ChildItem -LiteralPath $nodeModulesRoot -Filter '*.d.ts' -File -Recurse -Force)
    $typeDeclarationBytes = [long](($typeDeclarationFiles | Measure-Object -Property Length -Sum).Sum)
    foreach ($typeDeclaration in $typeDeclarationFiles) {
        $declarationPath = [IO.Path]::GetFullPath($typeDeclaration.FullName)
        if (-not $declarationPath.StartsWith($nodeModulesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to prune a declaration outside the staged node_modules tree.'
        }
        if (($typeDeclaration.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Refusing to prune a declaration reparse point.'
        }
        Remove-Item -LiteralPath $declarationPath -Force
    }
    Write-Output ('Removed {0:N0} runtime-irrelevant TypeScript declarations ({1:N0} bytes).' -f $typeDeclarationFiles.Count, $typeDeclarationBytes)
    # Keep the Windows CLI feature-parity surface self-contained. The source
    # package intentionally does not carry qrcode-terminal in package.json;
    # Debian stages this same pinned tarball, so Windows must use the same
    # version and digest instead of depending on a user's global npm install.
    $qrcodeCacheRoot = if ($env:AGENTOC_WINDOWS_PACKAGE_CACHE) {
        $env:AGENTOC_WINDOWS_PACKAGE_CACHE
    } else {
        Join-Path ([IO.Path]::GetTempPath()) 'agentoc-package-cache'
    }
    New-Item -ItemType Directory -Force $qrcodeCacheRoot | Out-Null
    $qrcodeTarball = Join-Path $qrcodeCacheRoot ('qrcode-terminal-' + $qrcodeTerminalVersion + '.tgz')
    if (-not (Test-Path -LiteralPath $qrcodeTarball -PathType Leaf)) {
        Invoke-WebRequest -UseBasicParsing `
            -Uri ('https://registry.npmjs.org/qrcode-terminal/-/qrcode-terminal-' + $qrcodeTerminalVersion + '.tgz') `
            -OutFile $qrcodeTarball
    }
    $qrcodeActualSha256 = (Get-FileHash -LiteralPath $qrcodeTarball -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($qrcodeActualSha256 -ne $qrcodeTerminalSha256) {
        throw ('qrcode-terminal checksum mismatch: expected {0}, got {1}' -f $qrcodeTerminalSha256, $qrcodeActualSha256)
    }
    $qrcodeVendorRoot = Join-Path $payloadRoot 'vendor\qrcode-terminal'
    New-Item -ItemType Directory -Force $qrcodeVendorRoot | Out-Null
    & tar.exe -xzf $qrcodeTarball -C $qrcodeVendorRoot --strip-components=1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $qrcodeVendorRoot 'bin\qrcode-terminal.js') -PathType Leaf)) {
        throw 'qrcode-terminal extraction failed.'
    }
    $qrcodeRuntimeRoot = Join-Path $payloadRoot 'runtime'
    New-Item -ItemType Directory -Force $qrcodeRuntimeRoot | Out-Null
    @'
@echo off
"%~dp0..\node.exe" "%~dp0..\vendor\qrcode-terminal\bin\qrcode-terminal.js" %*
'@ | Set-Content -LiteralPath (Join-Path $qrcodeRuntimeRoot 'qrcode-terminal.cmd') -Encoding ASCII
    # The source checkout may carry a Linux ELF sidecar under bin/. Build the
    # native Windows Pion host from the current Go module into the staged
    # payload, then remove every legacy Unix/architecture-specific name.
    $p2pBuilder = Join-Path $payloadRoot 'packaging\windows\build-p2p-host.ps1'
    if (-not (Test-Path -LiteralPath $p2pBuilder -PathType Leaf)) { throw 'Windows P2P host builder is missing.' }
    $stagedP2pBin = Join-Path $payloadRoot 'bin'
    New-Item -ItemType Directory -Force -Path $stagedP2pBin | Out-Null
    $stagedP2pHost = Join-Path $stagedP2pBin 'agentoc-p2p-host.exe'
    & $p2pBuilder -SourceRoot $payloadRoot -OutputPath $stagedP2pHost
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $stagedP2pHost -PathType Leaf)) {
        throw 'Windows P2P host staging failed.'
    }
    foreach ($legacyP2pName in @(
        'agentoc-p2p-host', 'agentoc-p2p-host-amd64', 'agentoc-p2p-host-arm64',
        'agentoc-p2p-host-amd64.exe', 'agentoc-p2p-host-arm64.exe'
    )) {
        $legacyP2pPath = Join-Path $stagedP2pBin $legacyP2pName
        if (Test-Path -LiteralPath $legacyP2pPath) { Remove-Item -LiteralPath $legacyP2pPath -Force }
    }
    # The legacy preview intentionally has no active trust manifest. A complete
    # managed install must ship the explicit admin-installed v2 trust manifest.
    $developmentOnlyBootstrap = -not $fullOwnerActivation
    & (Join-Path $payloadRoot 'packaging\windows\stage-owner-bootstrap.ps1') -SourceRoot $payloadRoot -PayloadRoot $payloadRoot -SignedHelperPath $SignedOwnerBootstrapPath -PublisherSha256 $OwnerBootstrapPublisherSha256 -DevelopmentOnly:$developmentOnlyBootstrap
    $runtimeManifestSha256 = ''
    if ($fullOwnerActivation) {
        # Package an exact, signed client for the future system-compatible
        # installer backend. Never resolve a user-writable module at runtime.
        $wingetPackage = $WingetClientPackagePath
        if (-not $wingetPackage) {
            $wingetPackage = Join-Path $qrcodeCacheRoot 'Microsoft.WinGet.Client-1.29.380.nupkg'
            if (-not (Test-Path -LiteralPath $wingetPackage -PathType Leaf)) {
                Invoke-WebRequest -UseBasicParsing -Uri 'https://www.powershellgallery.com/api/v2/package/Microsoft.WinGet.Client/1.29.380' -OutFile $wingetPackage
            }
        }
        & (Join-Path $payloadRoot 'packaging\windows\stage-winget-client.ps1') -PackagePath $wingetPackage -PayloadRoot $payloadRoot
        # The MSI currently targets x64. Its private PowerShell runtime keeps
        # the service independent of the host's interactive user installation.
        $runtimeArchive = $PowerShellRuntimeArchivePath
        if (-not $runtimeArchive) {
            $runtimeArchive = Join-Path $qrcodeCacheRoot 'PowerShell-7.6.6-win-x64.zip'
            if (-not (Test-Path -LiteralPath $runtimeArchive -PathType Leaf)) {
                Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.zip' -OutFile $runtimeArchive
            }
        }
        & (Join-Path $payloadRoot 'packaging\windows\stage-powershell-runtime.ps1') -ArchivePath $runtimeArchive -PayloadRoot $payloadRoot -Architecture x64
        Assert-BuildFreeSpace 'after PowerShell staging'
        $runtimeManifestOutput = & $node.Source (Join-Path $payloadRoot 'scripts\create-windows-runtime-manifest.mjs') $payloadRoot
        if ($LASTEXITCODE -ne 0) { throw 'Windows runtime integrity manifest generation failed.' }
        $runtimeManifest = $runtimeManifestOutput | ConvertFrom-Json
        $runtimeManifestSha256 = [string]$runtimeManifest.sha256
        if ($runtimeManifestSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Windows runtime integrity manifest hash is invalid.' }
    }
    # Verify the staged tools after declaration pruning.
    $stagedNode = Join-Path $payloadRoot 'node.exe'
    foreach ($entrypoint in @('node_modules\npm\bin\npm-cli.js', 'node_modules\corepack\dist\corepack.js')) {
        $stagedEntrypoint = Join-Path $payloadRoot $entrypoint
        if (-not (Test-Path -LiteralPath $stagedEntrypoint -PathType Leaf)) { throw "Missing staged Node tool after declaration pruning: $entrypoint" }
        & $stagedNode $stagedEntrypoint --version
        if ($LASTEXITCODE -ne 0) { throw "Staged Node tool failed after declaration pruning: $entrypoint" }
    }
    # Scan the assembled payload, including npm/corepack and installed deps.
    $runtimeVerifierRoot = if ($CommittedTree) { $payloadRoot } else { $SourceRoot }
    & $node.Source (Join-Path $runtimeVerifierRoot 'scripts\verify-runtime-payload.mjs') $payloadRoot
    if ($LASTEXITCODE -ne 0) { throw 'Final Windows runtime secret/state verification failed.' }
    # Preserve an explicit uncompressed installer ceiling. The full Owner MSI
    # carries the optional Whisper feature payload even when users leave the
    # feature unchecked, so its budget allows 1 GiB. The Electron renderer is
    # counted inside this payload; declaration pruning keeps normal assets lean.
    $payloadBytes = [long](Get-ChildItem -LiteralPath $payloadRoot -Recurse -File -Force |
        Measure-Object Length -Sum).Sum
    $whisperPayloadBytes = if ($whisperRuntimeRoot) {
        [long](Get-ChildItem -LiteralPath $whisperRuntimeRoot -Recurse -File -Force | Measure-Object Length -Sum).Sum
    } else { 0L }
    $completePayloadBytes = $payloadBytes + $whisperPayloadBytes
    $desktopPayloadBytes = (Get-ChildItem -LiteralPath (Join-Path $payloadRoot 'Desktop') -Recurse -File -Force |
        Measure-Object Length -Sum).Sum
    Write-Output ('Electron desktop payload: {0:N0} bytes' -f $desktopPayloadBytes)
    Write-Output ('Core Windows payload: {0:N0} bytes' -f ($payloadBytes - $desktopPayloadBytes))
    $maxPayloadBytes = if ($fullOwnerActivation) { 1024MB } else { 600MB }
    Write-Output ('Optional Whisper payload: {0:N0} bytes' -f $whisperPayloadBytes)
    Write-Output ('Complete MSI payload: {0:N0} bytes ({1:N0} MiB maximum)' -f $completePayloadBytes, ($maxPayloadBytes / 1MB))
    if ($completePayloadBytes -gt $maxPayloadBytes) {
        throw ('Staged MSI payload is {0:N0} MiB, above the {1:N0} MiB runtime budget.' -f ($completePayloadBytes / 1MB), ($maxPayloadBytes / 1MB))
    }
    Assert-BuildFreeSpace 'before MSI compilation'
    # Compile the service host from the same frozen staged source, never reuse
    # an untracked developer executable from SourceRoot.
    $installScriptRoot = Join-Path $payloadRoot 'packaging\windows'
    $hostSource = Join-Path $staging 'service-host\AgentoC.ServiceHost.exe'
    & (Join-Path $installScriptRoot 'build-service-host.ps1') -OutputPath $hostSource -SourcePath (Join-Path $installScriptRoot 'AgentoC.ServiceHost.cs') -RuntimePayloadRoot $payloadRoot
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $hostSource)) { throw 'Frozen service host compilation failed.' }
    $brokerBuildRoot = Join-Path $staging 'privileged-broker'
    $brokerSource = Join-Path $brokerBuildRoot 'AgentoC.PrivilegedBroker.exe'
    if ($fullOwnerActivation) {
        # Compile the broker from the same verified, frozen payload as the
        # service host; the live checkout can change after staging completes.
        & (Join-Path $installScriptRoot 'build-privileged-broker.ps1') -SourceRoot $payloadRoot -OutputPath $brokerSource -RuntimeManifestSha256 $runtimeManifestSha256
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $brokerSource -PathType Leaf)) { throw 'Windows Privileged Broker build failed.' }
        $brokerSha256 = (Get-FileHash -LiteralPath $brokerSource -Algorithm SHA256).Hash.ToLowerInvariant()
        $brokerManifest = [ordered]@{ schemaVersion = 1; productVersion = $Version; sha256 = $brokerSha256 } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $brokerBuildRoot 'AgentoC.PrivilegedBroker.manifest.json'), $brokerManifest, [Text.UTF8Encoding]::new($false))
    }
    $payloadWxs = Join-Path $staging 'payload.wxs'
    $payloadDir = Join-Path $staging 'payload'
    # Use WiX v4 native Files authoring. A machine may also have legacy
    # heat.exe on PATH; its v3 namespace is rejected by the pinned WiX 7 build.
    if (-not (Get-Command wix.exe -ErrorAction SilentlyContinue)) { throw 'WiX build requires wix.exe.' }
    @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <ComponentGroup Id="PayloadGroup" Directory="INSTALLFOLDER" Subdirectory="payload">
      <Files Include="`$(var.SourceDir)\**" />
    </ComponentGroup>
  </Fragment>
</Wix>
"@ | Set-Content -LiteralPath $payloadWxs -Encoding UTF8
    if (-not (Test-Path $payloadWxs)) { throw 'WiX directory authoring failed.' }
    $localVoiceWxs = ''
    if ($fullOwnerActivation) {
        $localVoiceWxs = Join-Path $staging 'local-voice.wxs'
        @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <ComponentGroup Id="LocalVoicePayload" Directory="LOCALVOICEFOLDER">
      <Files Include="`$(var.WhisperRuntimeDir)\**" />
    </ComponentGroup>
  </Fragment>
</Wix>
"@ | Set-Content -LiteralPath $localVoiceWxs -Encoding UTF8
        if (-not (Test-Path $localVoiceWxs)) { throw 'WiX local voice authoring failed.' }
    }
    New-Item -ItemType Directory -Force (Split-Path -Parent $OutputPath) | Out-Null
    foreach ($extension in @('WixToolset.UI.wixext/7.0.0', 'WixToolset.Util.wixext/7.0.0')) {
        & wix.exe --acceptEula wix7 extension add --global $extension
        if ($LASTEXITCODE -ne 0) { throw ('Required pinned WiX extension could not be installed: ' + $extension) }
    }
    $serviceHostDir = Split-Path -Parent $hostSource
    if($ManagedOwnerPreparation -or $fullOwnerActivation){
        & (Join-Path $installScriptRoot 'build-managed-owner-msi-bridge.ps1') -OutputPath (Join-Path $staging 'AgentoC.ManagedOwnerMsiBridge.exe')
        $managedWxs = if($fullOwnerActivation){Join-Path $installScriptRoot 'AgentoC.ActivatedOwner.wxs'}else{Join-Path $installScriptRoot 'AgentoC.ManagedOwner.wxs'}
        $wixSources = @($managedWxs, $payloadWxs)
        if ($fullOwnerActivation) { $wixSources += $localVoiceWxs }
        $wixArguments = @('--acceptEula','wix7','build','-arch','x64') + $wixSources + @('-d',"ProductVersion=$Version",'-d',"DisplayVersion=$displayVersion",'-d',"MsiProductVersion=$MsiProductVersion",'-d',"ProductCode=$ProductCode",'-d',"MsiUpgradeLane=$MsiUpgradeLane",'-d',"MsiUpgradeStrategy=$msiUpgradeStrategy",'-d',"SourceDir=$payloadDir",'-bindpath',"ServiceHost=$serviceHostDir",'-bindpath',"ManagedBridge=$staging",'-bindpath',"BrandAsset=$brandRoot",'-ext','WixToolset.UI.wixext/7.0.0','-ext','WixToolset.Util.wixext/7.0.0','-o',$OutputPath)
        if($fullOwnerActivation){
            # The guarded major-upgrade transaction has passed real upgrade
            # and injected rollback verification. Use it for ordinary Owner
            # builds as well as the explicit legacy test switch.
            $experimentalMajor = if($MsiUpgradeLane -eq 'major'){'1'}else{'0'}
            $wixArguments += @('-d',"ExperimentalMajorUpgrade=$experimentalMajor")
            $earlyQuiesce = if($useEarlyQuiescence){'1'}else{'0'}
            $wixArguments += @('-d',"EarlyServiceQuiescence=$earlyQuiesce")
            $wixArguments += @('-d',"IncludeMingwUiRuntime=$includeMingwUiRuntime",'-bindpath',"InstallUi=$installerUiRoot")
            $wixArguments += @('-d',"WhisperRuntimeDir=$whisperRuntimeRoot")
            $wixArguments += @('-bindpath',"PrivilegedBroker=$brokerBuildRoot")
            $wixArguments += @('-d',"BrokerSha256=$brokerSha256")
            $rollbackInjection = if($InjectPostActivationFailure){'1'}else{'0'}
            $wixArguments += @('-d',"TestPostActivationRollback=$rollbackInjection")
            $removalInjection = if($InjectPostRemovalFailure){'1'}else{'0'}
            $wixArguments += @('-d',"TestPostRemovalRollback=$removalInjection")
        }
        & wix.exe @wixArguments
    }else{
        & (Join-Path $installScriptRoot 'build-legacy-owner-install-guard.ps1') -OutputPath (Join-Path $staging 'AgentoC.LegacyOwnerInstallGuard.exe')
        & wix.exe --acceptEula wix7 build -arch x64 (Join-Path $installScriptRoot 'AgentoC.wxs') $payloadWxs -d "ProductVersion=$Version" -d "MsiProductVersion=$MsiProductVersion" -d "SourceDir=$payloadDir" -d "IncludeMingwUiRuntime=$includeMingwUiRuntime" -bindpath "ServiceHost=$serviceHostDir" -bindpath "InstallScript=$installScriptRoot" -bindpath "OwnerInstallGuard=$staging" -bindpath "BrandAsset=$brandRoot" -bindpath "InstallUi=$installerUiRoot" -ext 'WixToolset.UI.wixext/7.0.0' -ext 'WixToolset.Util.wixext/7.0.0' -o $OutputPath
    }
    if ($LASTEXITCODE -ne 0) { throw 'WiX MSI build failed.' }
    if($useEarlyQuiescence){
        # WiX fixes standard-action sequence numbers. The isolated fixture
        # verifies that moving initialization ahead of InstallValidate keeps
        # service quiescence transactional. Apply this only to the validated
        # activated-owner major lane and verify every row.
        $installer=$null;$database=$null;$view=$null;$record=$null
        $sequences=[ordered]@{
            InstallInitialize=1300;ManagedFreshGuard=1310;ManagedRemoveGuard=1320;
            ManagedCloseDesktopBeforeValidation=1330;ManagedMaintenanceRefused=1340;
            ManagedPreValidationRollback=1350;ManagedPreValidationStop=1360;InstallExecute=1370;
            ManagedUpgradeGuard=1501;ManagedCloseDesktopForMajorUpdate=1502;ManagedMajorBrokerRollback=1503;
            InstallExecuteAgain=1504;RemoveExistingProducts=1505;ManagedUpgradeRollback=1506;ManagedUpgradeBegin=1507
        }
        try{
            $installer=New-Object -ComObject WindowsInstaller.Installer
            $database=$installer.OpenDatabase([IO.Path]::GetFullPath($OutputPath),1)
            $view=$database.OpenView('SELECT `Action`,`Sequence` FROM `InstallExecuteSequence`');$view.Execute()
            while($record=$view.Fetch()){
                $action=$record.StringData(1);$number=$record.IntegerData(2)
                if($action -notin $sequences.Keys -and $number -in $sequences.Values){throw 'MSI_EARLY_SEQUENCE_COLLISION'}
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record);$record=$null
            }
            $view.Close();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view);$view=$null
            foreach($action in $sequences.Keys){
                $check=$database.OpenView("SELECT ``Action`` FROM ``InstallExecuteSequence`` WHERE ``Action``='$action'");$check.Execute();$row=$check.Fetch()
                try{if(-not $row){throw ('MSI_EARLY_ACTION_MISSING_'+$action)}}finally{if($row){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($row)};$check.Close();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($check)}
                $view=$database.OpenView("UPDATE ``InstallExecuteSequence`` SET ``Sequence``=$($sequences[$action]) WHERE ``Action``='$action'")
                $view.Execute();$view.Close();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view);$view=$null
            }
            $database.Commit()
        }finally{foreach($com in @($record,$view,$database,$installer)){if($com -and [Runtime.InteropServices.Marshal]::IsComObject($com)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($com)}}}
    }
    if($MsiUpgradeLane -eq 'minor'){
        & (Join-Path $scriptRoot 'assert-minor-component-compat.ps1') -PreviousMsiPath $PreviousMsiPath -CandidateMsiPath $OutputPath -PreviousMsiSha256 $PreviousMsiSha256 -PreviousMsiProductVersion $PreviousMsiProductVersion -CandidateMsiProductVersion $MsiProductVersion -ReportPath ($OutputPath+'.component-tree.json')
        $installer=$null;$database=$null;$tablesView=$null;$tableRecord=$null;$upgradeView=$null;$upgradeRecord=$null;$sequenceView=$null;$sequenceRecord=$null;$propertyView=$null;$propertyRecord=$null;$versionView=$null;$versionRecord=$null;$modeView=$null;$modeRecord=$null;$modeSequenceView=$null;$modeSequenceRecord=$null;$costView=$null;$costRecord=$null
        try{
            $installer=New-Object -ComObject WindowsInstaller.Installer
            $database=$installer.OpenDatabase([IO.Path]::GetFullPath($OutputPath),0)
            $tablesView=$database.OpenView('SELECT `Name` FROM `_Tables` WHERE `Name`=''Upgrade''');$tablesView.Execute();$tableRecord=$tablesView.Fetch()
            if($tableRecord){
                $upgradeView=$database.OpenView('SELECT `UpgradeCode` FROM `Upgrade`');$upgradeView.Execute();$upgradeRecord=$upgradeView.Fetch()
                if($upgradeRecord){throw 'MSI_MINOR_UPGRADE_HAS_MAJOR_UPGRADE_ROWS'}
            }
            $sequenceView=$database.OpenView('SELECT `Action` FROM `InstallExecuteSequence` WHERE `Action`=''RemoveExistingProducts''');$sequenceView.Execute();$sequenceRecord=$sequenceView.Fetch()
            if($sequenceRecord){throw 'MSI_MINOR_UPGRADE_HAS_REMOVE_EXISTING_PRODUCTS'}
            $propertyView=$database.OpenView('SELECT `Value` FROM `Property` WHERE `Property`=''ProductCode''');$propertyView.Execute();$propertyRecord=$propertyView.Fetch()
            if(-not $propertyRecord -or $propertyRecord.StringData(1) -cne $ProductCode){throw 'MSI_MINOR_UPGRADE_PRODUCT_CODE_MISMATCH'}
            if($propertyRecord){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($propertyRecord);$propertyRecord=$null}
            $versionView=$database.OpenView('SELECT `Value` FROM `Property` WHERE `Property`=''ProductVersion''');$versionView.Execute();$versionRecord=$versionView.Fetch()
            if(-not $versionRecord -or $versionRecord.StringData(1) -cne $MsiProductVersion){throw 'MSI_MINOR_UPGRADE_VERSION_MISMATCH'}
            $modeView=$database.OpenView('SELECT `Type`,`Source`,`Target` FROM `CustomAction` WHERE `Action`=''SetREINSTALLMODE''');$modeView.Execute();$modeRecord=$modeView.Fetch()
            if(-not $modeRecord -or $modeRecord.IntegerData(1) -ne 51 -or $modeRecord.StringData(2) -cne 'REINSTALLMODE' -or $modeRecord.StringData(3) -cne 'vamus'){throw 'MSI_MINOR_FORCE_ALL_FILES_ACTION_MISSING'}
            $modeSequenceView=$database.OpenView('SELECT `Sequence`,`Condition` FROM `InstallExecuteSequence` WHERE `Action`=''SetREINSTALLMODE''');$modeSequenceView.Execute();$modeSequenceRecord=$modeSequenceView.Fetch()
            $costView=$database.OpenView('SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action`=''CostInitialize''');$costView.Execute();$costRecord=$costView.Fetch()
            if(-not $modeSequenceRecord -or -not $costRecord -or $modeSequenceRecord.IntegerData(1) -ge $costRecord.IntegerData(1) -or $modeSequenceRecord.StringData(2) -cne 'Installed AND REINSTALL AND NOT (REMOVE = "ALL")'){throw 'MSI_MINOR_FORCE_ALL_FILES_SEQUENCE_MISMATCH'}
            if($upgradeRecord){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($upgradeRecord);$upgradeRecord=$null}
            if($sequenceRecord){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($sequenceRecord);$sequenceRecord=$null}
            if($versionRecord){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($versionRecord);$versionRecord=$null}
            Write-Output '{"minorUpgradeMetadataVerified":true,"upgradeRows":0,"removeExistingProducts":false,"modifiedPayloadOverwrite":"vamus"}'
        }finally{
            foreach($com in @($costRecord,$costView,$modeSequenceRecord,$modeSequenceView,$modeRecord,$modeView,$versionRecord,$versionView,$propertyRecord,$propertyView,$sequenceRecord,$sequenceView,$upgradeRecord,$upgradeView,$tableRecord,$tablesView,$database,$installer)){if($com -and [Runtime.InteropServices.Marshal]::IsComObject($com)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($com)}}
        }
    }
    if ($CommittedTree) {
        $sourceCommit = (Get-Content -LiteralPath (Join-Path $payloadRoot '.agentoc-source-commit') -Raw).Trim()
        if ($sourceCommit -cne $frozenRevision -or $sourceCommit -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') { throw 'MSI_RELEASE_SOURCE_IDENTITY_INVALID' }
        $record = [ordered]@{ schemaVersion = 1; publicVersion = $displayVersion; buildVersion = $MsiProductVersion;
            sourceCommit = $sourceCommit; msiSha256 = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant() }
        [IO.File]::WriteAllText(($OutputPath + '.build.json'), (($record | ConvertTo-Json -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
    }
} finally {
    $stagingFull = [IO.Path]::GetFullPath($staging)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $stagingFull.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($stagingFull) -notmatch '^agentoc-msi-[0-9a-f]{32}$') {
        throw 'Refusing cleanup outside the owned MSI staging directory.'
    }
    if (Test-Path -LiteralPath $stagingFull) {
        if ((Get-Item -LiteralPath $stagingFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Refusing cleanup of a replaced MSI staging directory.'
        }
        Remove-Item -LiteralPath $stagingFull -Recurse -Force -ErrorAction SilentlyContinue
    }
}
