[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$MsiPath,
    [Parameter(Mandatory=$true)][string]$DesktopMsiPath,
    [Parameter(Mandatory=$true)][string]$IconPath,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$msi = [IO.Path]::GetFullPath($MsiPath)
$desktopMsi = [IO.Path]::GetFullPath($DesktopMsiPath)
$icon = [IO.Path]::GetFullPath($IconPath)
$output = [IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $msi -PathType Leaf) -or -not (Test-Path -LiteralPath $desktopMsi -PathType Leaf) -or -not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'Both installer MSIs and icon are required.' }
$buildRecord = $msi + '.build.json'
$desktopRecordPath = $desktopMsi + '.build.json'
$publicVersion = $null
function Read-MsiProductVersion([string]$Path) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $db = $installer.OpenDatabase($Path, 0)
    $view = $db.OpenView('SELECT `Value` FROM `Property` WHERE `Property` = ''ProductVersion''')
    try {
        $view.Execute(); $row = $view.Fetch()
        if (-not $row) { throw 'SETUP_MSI_VERSION_MISSING' }
        return $row.StringData(1)
    } finally { $view.Close() }
}
if ((Read-MsiProductVersion $msi) -cne (Read-MsiProductVersion $desktopMsi)) { throw 'SETUP_MSI_VERSION_MISMATCH' }
if (Test-Path -LiteralPath $buildRecord -PathType Leaf) {
    $record = Get-Content -LiteralPath $buildRecord -Raw | ConvertFrom-Json
    if ((Read-MsiProductVersion $msi) -cne $record.buildVersion) { throw 'SETUP_MACHINE_VERSION_MISMATCH' }
    if (-not (Test-Path -LiteralPath $desktopRecordPath -PathType Leaf)) { throw 'SETUP_DESKTOP_METADATA_REQUIRED' }
    $desktopRecord = Get-Content -LiteralPath $desktopRecordPath -Raw | ConvertFrom-Json
    if ($desktopRecord.sourceCommit -cne $record.sourceCommit -or $desktopRecord.publicVersion -cne $record.publicVersion -or
        $desktopRecord.msiProductVersion -cne $record.buildVersion -or
        $desktopRecord.desktopMsiSha256 -cne (Get-FileHash -LiteralPath $desktopMsi -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'SETUP_DESKTOP_METADATA_MISMATCH' }
    $publicVersion = [string]$record.publicVersion
    if ($publicVersion -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$' -or
        @($publicVersion.Split('.') | Where-Object { $_.Length -gt 5 -or [int]$_ -gt 65535 }).Count -ne 0) { throw 'SETUP_PUBLIC_VERSION_INVALID' }
    $revision = [string]$record.sourceCommit
    if ($revision -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') { throw 'SETUP_SOURCE_IDENTITY_INVALID' }
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    foreach ($item in @('packaging/windows/build-setup-exe.ps1','packaging/windows/Ragent.Setup.cs','packaging/windows/write-setup-metadata.ps1')) {
        $expected = (& git.exe -C $repo rev-parse ("${revision}:$item")).Trim()
        if ($LASTEXITCODE -ne 0) { throw "SETUP_SOURCE_MISSING: $item" }
        $actual = (& git.exe -C $repo hash-object "--path=$item" (Join-Path $repo $item)).Trim()
        if ($LASTEXITCODE -ne 0 -or $actual -cne $expected) { throw "SETUP_SOURCE_MISMATCH: $item" }
    }
}
$hashFile = Join-Path ([IO.Path]::GetTempPath()) ('ragent-setup-hash-' + [guid]::NewGuid().ToString('N') + '.txt')
$desktopHashFile = Join-Path ([IO.Path]::GetTempPath()) ('ragent-desktop-hash-' + [guid]::NewGuid().ToString('N') + '.txt')
$manifestFile = Join-Path ([IO.Path]::GetTempPath()) ('ragent-setup-manifest-' + [guid]::NewGuid().ToString('N') + '.xml')
$versionFile = Join-Path ([IO.Path]::GetTempPath()) ('ragent-setup-version-' + [guid]::NewGuid().ToString('N') + '.cs')
try {
    [IO.File]::WriteAllText($hashFile, (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash, [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText($desktopHashFile, (Get-FileHash -LiteralPath $desktopMsi -Algorithm SHA256).Hash, [Text.Encoding]::ASCII)
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $source = Join-Path $PSScriptRoot 'Ragent.Setup.cs'
    $sources = @($source)
    if ($publicVersion) {
        $fileVersion = if ($publicVersion.Split('.').Count -eq 3) { $publicVersion + '.0' } else { $publicVersion }
        [IO.File]::WriteAllText($versionFile, ('[assembly: System.Reflection.AssemblyFileVersion("' + $fileVersion + '")]' + "`n" + '[assembly: System.Reflection.AssemblyInformationalVersion("' + $publicVersion + '")]'), [Text.Encoding]::ASCII)
        $sources += $versionFile
    }
    [IO.File]::WriteAllText($manifestFile, '<?xml version="1.0" encoding="utf-8"?><assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>', [Text.UTF8Encoding]::new($false))
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll ('/win32manifest:' + $manifestFile) ('/win32icon:' + $icon) ('/resource:' + $msi + ',Ragent.Machine.msi') ('/resource:' + $hashFile + ',Ragent.Machine.sha256') ('/resource:' + $desktopMsi + ',Ragent.Desktop.msi') ('/resource:' + $desktopHashFile + ',Ragent.Desktop.sha256') ('/out:' + $output) $sources
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'Installer launcher build failed.' }
    if ($publicVersion) {
        $versionInfo = (Get-Item -LiteralPath $output).VersionInfo
        if ($versionInfo.FileVersion -cne $fileVersion -or $versionInfo.ProductVersion -cne $publicVersion) { throw 'SETUP_VERSION_RESOURCE_MISMATCH' }
    }
    if (Test-Path -LiteralPath $buildRecord -PathType Leaf) {
        & (Join-Path $PSScriptRoot 'write-setup-metadata.ps1') -MsiPath $msi -SetupPath $output
    }
    Write-Output ("Built Windows setup executable: " + $output)
} finally {
    if (Test-Path -LiteralPath $manifestFile -PathType Leaf) { Remove-Item -LiteralPath $manifestFile -Force }
    if (Test-Path -LiteralPath $hashFile -PathType Leaf) { Remove-Item -LiteralPath $hashFile -Force }
    if (Test-Path -LiteralPath $desktopHashFile -PathType Leaf) { Remove-Item -LiteralPath $desktopHashFile -Force }
    if (Test-Path -LiteralPath $versionFile -PathType Leaf) { Remove-Item -LiteralPath $versionFile -Force }
}
