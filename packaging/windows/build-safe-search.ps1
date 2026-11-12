[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceRoot, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Safe search helper requires native 64-bit Windows.' }
$module = Join-Path ([IO.Path]::GetFullPath($SourceRoot)) 'native\windows-safe-delete'
if (-not (Test-Path -LiteralPath (Join-Path $module 'go.mod') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $module 'cmd\agentoc-safe-search\main_windows.go') -PathType Leaf)) { throw 'Safe search helper source is missing.' }
$go = Get-Command go.exe -ErrorAction SilentlyContinue
if (-not $go) { throw 'go.exe is required to build the safe search helper.' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$oldOs=$env:GOOS; $oldArch=$env:GOARCH; $oldCgo=$env:CGO_ENABLED
try {
    $env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
    Push-Location $module
    try { & $go.Source build -trimpath -o $OutputPath './cmd/agentoc-safe-search'; if ($LASTEXITCODE -ne 0) { throw 'Safe search helper build failed.' } }
    finally { Pop-Location }
} finally {
    if ($null -eq $oldOs) { Remove-Item Env:GOOS -ErrorAction SilentlyContinue } else { $env:GOOS=$oldOs }
    if ($null -eq $oldArch) { Remove-Item Env:GOARCH -ErrorAction SilentlyContinue } else { $env:GOARCH=$oldArch }
    if ($null -eq $oldCgo) { Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue } else { $env:CGO_ENABLED=$oldCgo }
}
$bytes=[IO.File]::ReadAllBytes($OutputPath)
if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'Safe search helper is not a Windows PE executable.' }
$offset=[int64][BitConverter]::ToUInt32($bytes,0x3c)
if ($offset -lt 0 -or $offset+26 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,[int]$offset) -ne 0x4550 -or
    [BitConverter]::ToUInt16($bytes,[int]($offset+4)) -ne 0x8664 -or [BitConverter]::ToUInt16($bytes,[int]($offset+24)) -ne 0x20b) { throw 'Safe search helper is not a Windows x64 executable.' }
Write-Output 'Windows safe search helper built.'
