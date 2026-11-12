[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceRoot,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem){throw 'Windows x64 is required'}
$module=Join-Path ([IO.Path]::GetFullPath($SourceRoot)) 'native\windows-cli-read-bridge'
$go=Get-Command go.exe -ErrorAction Stop
$OutputPath=[IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$oldOs=$env:GOOS;$oldArch=$env:GOARCH;$oldCgo=$env:CGO_ENABLED
try {
    $env:GOOS='windows';$env:GOARCH='amd64';$env:CGO_ENABLED='0'
    Push-Location $module
    try { & $go.Source build -trimpath -o $OutputPath .; if($LASTEXITCODE -ne 0){throw 'CLI read bridge build failed'} }
    finally {Pop-Location}
} finally {
    foreach($item in @(@('GOOS',$oldOs),@('GOARCH',$oldArch),@('CGO_ENABLED',$oldCgo))) {
        if($null -eq $item[1]){Remove-Item -LiteralPath ('Env:'+ $item[0]) -ErrorAction SilentlyContinue}
        else{[Environment]::SetEnvironmentVariable($item[0],$item[1],'Process')}
    }
}
Write-Output 'Windows scoped CLI bridge built.'
