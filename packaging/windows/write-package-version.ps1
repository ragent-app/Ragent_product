[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$PayloadRoot,
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$BuildVersion = ''
)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Application version must have four numeric components.' }
if ($BuildVersion -and $BuildVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Internal package build must have three canonical numeric components.' }
if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) { throw 'Payload root must be an existing directory.' }
$parts = @($Version.Split('.') | ForEach-Object { [int]::Parse($_) })
$displayVersion = if ($parts[3] -eq 0) { $parts[0..2] -join '.' } else { $parts -join '.' }
$target = Join-Path $PayloadRoot '.ragent-package-version'
[IO.File]::WriteAllText($target, "$displayVersion`n", [Text.UTF8Encoding]::new($false))
if ($BuildVersion) {
    [IO.File]::WriteAllText((Join-Path $PayloadRoot '.ragent-package-build'), "$BuildVersion`n", [Text.UTF8Encoding]::new($false))
}
