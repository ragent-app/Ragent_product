[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath,
    [ValidateSet('Ragent-ControlPlane','Ragent-RunnerSupervisor')][string]$ServiceName='Ragent-ControlPlane')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $root 'testpipeclient'
$destination = [IO.Path]::GetFullPath($OutputPath)
if (-not (Get-Command go.exe -ErrorAction SilentlyContinue)) { throw 'Go is required to build the Broker test client.' }
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
Push-Location $probe
try {
    & go.exe build -trimpath -buildvcs=false -ldflags ("-X main.serviceName=" + $ServiceName) -o $destination .\
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        throw 'Broker test client compilation failed.'
    }
} finally { Pop-Location }
Get-FileHash -LiteralPath $destination -Algorithm SHA256 | Select-Object Path,Hash
