[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$SourceRoot,
    [Parameter(Mandatory = $true)] [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT' -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'build-p2p-host.ps1 requires native Windows; WSL and Unix builds are not supported.'
}
if ([Environment]::Is64BitOperatingSystem -ne $true) {
    throw 'The Windows P2P host requires a 64-bit Windows build.'
}

function Test-WindowsX64Pe {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { return $false }
    $peOffset = [int64][BitConverter]::ToUInt32($bytes, 0x3c)
    if ($peOffset -lt 0 -or $peOffset + 26 -gt $bytes.Length) { return $false }
    if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
        $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) { return $false }
    $machine = [BitConverter]::ToUInt16($bytes, [int]($peOffset + 4))
    $optionalMagic = [BitConverter]::ToUInt16($bytes, [int]($peOffset + 24))
    return $machine -eq 0x8664 -and $optionalMagic -eq 0x20b
}

if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "SourceRoot not found: $SourceRoot"
}
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$p2pRoot = Join-Path $SourceRoot 'p2p'
if (-not (Test-Path (Join-Path $p2pRoot 'go.mod') -PathType Leaf) -or
    -not (Test-Path (Join-Path $p2pRoot 'cmd\ragent-p2p-host\main.go') -PathType Leaf)) {
    throw 'SourceRoot does not contain the P2P host Go module.'
}
$go = Get-Command go.exe -ErrorAction SilentlyContinue
if (-not $go) { throw 'go.exe is required to build the Windows P2P host sidecar.' }

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$oldGoOs = $env:GOOS
$oldGoArch = $env:GOARCH
$oldCgoEnabled = $env:CGO_ENABLED
try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    Push-Location $p2pRoot
    try {
        & $go.Source build -trimpath -o $OutputPath './cmd/ragent-p2p-host'
        if ($LASTEXITCODE -ne 0) { throw "Windows P2P host build failed (go exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $oldGoOs) { Remove-Item Env:GOOS -ErrorAction SilentlyContinue } else { $env:GOOS = $oldGoOs }
    if ($null -eq $oldGoArch) { Remove-Item Env:GOARCH -ErrorAction SilentlyContinue } else { $env:GOARCH = $oldGoArch }
    if ($null -eq $oldCgoEnabled) { Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue } else { $env:CGO_ENABLED = $oldCgoEnabled }
}

if (-not (Test-WindowsX64Pe $OutputPath)) {
    throw "P2P host output is not a native Windows x64 PE32+ executable: $OutputPath"
}
Write-Output ("Built Windows P2P host: {0} ({1:N0} bytes)" -f $OutputPath, (Get-Item -LiteralPath $OutputPath).Length)
