[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DesktopPayloadRoot,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$BrandAssetDirectory,
    [string]$MsiProductVersion = '',
    [string]$VerifiedSourceCommit = ''
)
$ErrorActionPreference = 'Stop'
$payload = [IO.Path]::GetFullPath($DesktopPayloadRoot).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputPath)
$brand = [IO.Path]::GetFullPath($BrandAssetDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $payload 'Ragent.exe') -PathType Leaf)) { throw 'DESKTOP_PAYLOAD_REQUIRED' }
if (-not (Test-Path -LiteralPath (Join-Path $brand 'ragent.ico') -PathType Leaf)) { throw 'DESKTOP_BRAND_REQUIRED' }
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'DESKTOP_VERSION_FORMAT' }
$parts = @($Version.Split('.') | ForEach-Object { [int]::Parse($_) })
if (@($parts | Where-Object { $_ -gt 65535 }).Count -gt 0) { throw 'DESKTOP_VERSION_RANGE' }
if (-not $MsiProductVersion) { $MsiProductVersion = ($parts[0..2] -join '.') }
if ($MsiProductVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'DESKTOP_MSI_VERSION_FORMAT' }
$msiParts = @($MsiProductVersion.Split('.') | ForEach-Object { [int]::Parse($_) })
if ($msiParts[0] -gt 255 -or $msiParts[1] -gt 255 -or $msiParts[2] -gt 65535) { throw 'DESKTOP_MSI_VERSION_RANGE' }
$publicVersion = if ($parts[3] -eq 0) { $parts[0..2] -join '.' } else { $parts -join '.' }
if (-not (Get-Command wix.exe -ErrorAction SilentlyContinue)) { throw 'WiX 7 is required.' }
if ($VerifiedSourceCommit -and $VerifiedSourceCommit -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') { throw 'DESKTOP_SOURCE_COMMIT_INVALID' }
$outdir = Split-Path -Parent $output
New-Item -ItemType Directory -Force -Path $outdir | Out-Null
$staging = Join-Path ([IO.Path]::GetTempPath()) ('ragent-desktop-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    $files = @(Get-ChildItem -LiteralPath $payload -File -Recurse -Force)
    $payloadBytes = [long](($files | Measure-Object Length -Sum).Sum)
    foreach ($root in @([IO.Path]::GetPathRoot($output), [IO.Path]::GetPathRoot($staging)) | Select-Object -Unique) {
        $drive = [IO.DriveInfo]::new($root)
        if (-not $drive.IsReady -or $drive.AvailableFreeSpace -lt ($payloadBytes * 2 + 100MB)) { throw 'DESKTOP_BUILD_FREE_SPACE_INSUFFICIENT' }
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $payload -Recurse -Force)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'DESKTOP_PAYLOAD_REPARSE_POINT_REFUSED' }
    }
    $metadataNames = @('.ragent-package-version', '.ragent-package-build', '.ragent-source-commit')
    $paths = @($files | ForEach-Object { $_.FullName.Substring($payload.Length + 1) })
    foreach ($name in $metadataNames) { if ($paths -contains $name) { throw 'DESKTOP_PAYLOAD_METADATA_COLLISION' } }
    $metadataRoot = Join-Path $staging 'metadata'
    New-Item -ItemType Directory -Path $metadataRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $metadataRoot $metadataNames[0]), "$publicVersion`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $metadataRoot $metadataNames[1]), "$MsiProductVersion`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $metadataRoot $metadataNames[2]), "$VerifiedSourceCommit`n", [Text.UTF8Encoding]::new($false))
    $paths += $metadataNames
    if (@($paths | Where-Object { $_ -match '[\r\n]' }).Count) { throw 'DESKTOP_PAYLOAD_PATH_INVALID' }
    $pathsFile = Join-Path $staging 'payload-paths.txt'
    [IO.File]::WriteAllLines($pathsFile, [string[]]$paths, [Text.UTF8Encoding]::new($false))
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:Microsoft.CSharp.dll ("/resource:$pathsFile,DesktopPayloadPaths") ("/out:$staging\Ragent.DesktopGuard.exe") (Join-Path $PSScriptRoot 'Ragent.DesktopGuard.cs')
    if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_GUARD_BUILD_FAILED' }
    $ui = Join-Path $staging ('installer-ui-' + [guid]::NewGuid().ToString('N'))
    & (Join-Path $PSScriptRoot 'build-ragent-installer-ui.ps1') -OutputDirectory $ui -BrandAssetDirectory $brand
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $ui 'Ragent.MsiEmbeddedUI.dll'))) { throw 'DESKTOP_UI_BUILD_FAILED' }
    $uiMetadata = Get-Content -LiteralPath (Join-Path $ui 'installer-ui-build.json') -Raw | ConvertFrom-Json
    $includeRuntime = if ($uiMetadata.includeMingwRuntime) { '1' } else { '0' }
    $payloadWxs = Join-Path $staging 'payload.wxs'
    # Deterministic component identities follow relative paths across upgrades.
    # Each file has an HKCU key path, as required for per-user profile files.
    function Get-StableToken([string]$Kind, [string]$Relative) {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($Kind + ':' + $Relative.Replace('/', '\').ToUpperInvariant()))))).Replace('-', '').Substring(0, 32) }
        finally { $sha.Dispose() }
    }
    function Get-ComponentGuid([string]$Token) { return ([guid]::new([byte[]]@($(for ($i=0; $i -lt 32; $i+=2) { [Convert]::ToByte($Token.Substring($i, 2), 16) })))).ToString('B').ToUpperInvariant() }
    $directories = @{' ' = 'DESKTOPINSTALLDIR'}
    foreach ($relative in $paths) {
        $directory = [IO.Path]::GetDirectoryName($relative)
        while ($directory) {
            if (-not $directories.ContainsKey($directory)) { $directories[$directory] = 'D_' + (Get-StableToken 'directory' $directory) }
            $directory = [IO.Path]::GetDirectoryName($directory)
        }
    }
    $settings = [Xml.XmlWriterSettings]::new(); $settings.Encoding = [Text.UTF8Encoding]::new($false); $settings.Indent = $true
    $writer = [Xml.XmlWriter]::Create($payloadWxs, $settings)
    try {
        $ns = 'http://wixtoolset.org/schemas/v4/wxs'
        $writer.WriteStartDocument(); $writer.WriteStartElement('Wix', $ns); $writer.WriteStartElement('Fragment', $ns)
        foreach ($directory in @($directories.Keys | Where-Object { $_ -ne ' ' } | Sort-Object Length)) {
            $parent = [IO.Path]::GetDirectoryName($directory); if (-not $parent) { $parent = ' ' }
            $writer.WriteStartElement('DirectoryRef', $ns); $writer.WriteAttributeString('Id', $directories[$parent])
            $writer.WriteStartElement('Directory', $ns); $writer.WriteAttributeString('Id', $directories[$directory]); $writer.WriteAttributeString('Name', [IO.Path]::GetFileName($directory))
            $writer.WriteEndElement(); $writer.WriteEndElement()
        }
        $writer.WriteStartElement('ComponentGroup', $ns); $writer.WriteAttributeString('Id', 'DesktopPayload')
        foreach ($directory in $directories.Keys) {
            $token = Get-StableToken 'folder' $directory
            $writer.WriteStartElement('Component', $ns); $writer.WriteAttributeString('Id', 'C_' + $token); $writer.WriteAttributeString('Guid', (Get-ComponentGuid $token)); $writer.WriteAttributeString('Directory', $directories[$directory])
            $writer.WriteStartElement('RemoveFolder', $ns); $writer.WriteAttributeString('Id', 'R_' + $token); $writer.WriteAttributeString('On', 'uninstall'); $writer.WriteEndElement()
            $writer.WriteStartElement('RegistryValue', $ns); $writer.WriteAttributeString('Root', 'HKCU'); $writer.WriteAttributeString('Key', 'Software\Ragent\DesktopInstaller\Components'); $writer.WriteAttributeString('Name', $token); $writer.WriteAttributeString('Type', 'integer'); $writer.WriteAttributeString('Value', '1'); $writer.WriteAttributeString('KeyPath', 'yes'); $writer.WriteEndElement(); $writer.WriteEndElement()
        }
        foreach ($relative in $paths) {
            $token = Get-StableToken 'file' $relative; $directory = [IO.Path]::GetDirectoryName($relative); if (-not $directory) { $directory = ' ' }
            $sourceFile = if ($metadataNames -contains $relative) { Join-Path $metadataRoot $relative } else { Join-Path $payload $relative }
            $writer.WriteStartElement('Component', $ns); $writer.WriteAttributeString('Id', 'C_' + $token); $writer.WriteAttributeString('Guid', (Get-ComponentGuid $token)); $writer.WriteAttributeString('Directory', $directories[$directory])
            $writer.WriteStartElement('File', $ns); $writer.WriteAttributeString('Id', 'F_' + $token); $writer.WriteAttributeString('Source', $sourceFile); $writer.WriteEndElement()
            $writer.WriteStartElement('RegistryValue', $ns); $writer.WriteAttributeString('Root', 'HKCU'); $writer.WriteAttributeString('Key', 'Software\Ragent\DesktopInstaller\Components'); $writer.WriteAttributeString('Name', $token); $writer.WriteAttributeString('Type', 'integer'); $writer.WriteAttributeString('Value', '1'); $writer.WriteAttributeString('KeyPath', 'yes'); $writer.WriteEndElement(); $writer.WriteEndElement()
        }
        $writer.WriteEndElement(); $writer.WriteEndElement(); $writer.WriteEndElement(); $writer.WriteEndDocument()
    } finally { $writer.Dispose() }
    & wix.exe --acceptEula wix7 build -arch x64 (Join-Path $PSScriptRoot 'Ragent.Desktop.wxs') $payloadWxs -d "MsiProductVersion=$MsiProductVersion" -d "DisplayVersion=$publicVersion" -d "SourceDir=$payload" -d "IncludeMingwUiRuntime=$includeRuntime" -bindpath "BrandAsset=$brand" -bindpath "InstallUi=$ui" -bindpath "Guard=$staging" -bindpath "Metadata=$metadataRoot" -o $output
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'DESKTOP_MSI_BUILD_FAILED' }
    # The caller is responsible for verifying the origin of the staged payload.
    [ordered]@{ publicVersion=$publicVersion; msiProductVersion=$MsiProductVersion; sourceCommit=$VerifiedSourceCommit; desktopMsiSha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json | Set-Content -LiteralPath ($output + '.build.json') -Encoding UTF8
    Write-Output "Built user desktop MSI: $output"
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
