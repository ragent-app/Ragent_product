[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$MsiPath,
    [Parameter(Mandatory=$true)][string]$SetupPath
)
$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
$msi = [IO.Path]::GetFullPath($MsiPath)
$setup = [IO.Path]::GetFullPath($SetupPath)
if (-not (Test-Path -LiteralPath $msi -PathType Leaf) -or -not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'SETUP_METADATA_INPUT_MISSING' }
$record = Get-Content -LiteralPath ($msi + '.build.json') -Raw | ConvertFrom-Json
$fields = @($record.PSObject.Properties.Name)
# Windows PowerShell 5.1 parses JSON integers as Int32; PowerShell 7 parses
# them as Int64. Accept either integer representation, never strings/floats.
if ($fields.Count -ne 5 -or @($fields | Where-Object { $_ -notin @('schemaVersion','publicVersion','buildVersion','sourceCommit','msiSha256') }).Count -ne 0 -or
    ($record.schemaVersion -isnot [int] -and $record.schemaVersion -isnot [long]) -or $record.schemaVersion -ne 1 -or $record.publicVersion -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$' -or
    $record.buildVersion -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
    $record.sourceCommit -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' -or $record.msiSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'SETUP_METADATA_INVALID' }
if ((Get-Sha256 $msi) -cne $record.msiSha256) { throw 'SETUP_METADATA_MSI_MISMATCH' }
$setupSha = Get-Sha256 $setup
$marker = '<!-- ragent-build:' + $record.buildVersion + ':' + $record.sourceCommit + ':sha256:' + $setupSha + ' -->'
$result = [ordered]@{ schemaVersion = 1; publicVersion = $record.publicVersion; buildVersion = $record.buildVersion;
    sourceCommit = $record.sourceCommit; msiSha256 = $record.msiSha256; setupSha256 = $setupSha; releaseBodyMarker = $marker }
[IO.File]::WriteAllText(($setup + '.build.json'), (($result | ConvertTo-Json -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Output ("Release build marker: " + $marker)
