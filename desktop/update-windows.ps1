param([string]$Package,[string]$AppRoot,[string]$Executable,[int]$ParentId,[string]$Result,[int]$Port,[string]$Digest)
$ErrorActionPreference = 'Stop'
function Save-Result([string]$State) { [IO.File]::WriteAllText($Result, ('{"status":"' + $State + '","digest":"' + $Digest + '"}')) }
try {
  if ($Digest -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Digest) { throw 'Package checksum mismatch' }
  [Console]::Out.WriteLine('RAGENT_READY')
  [Console]::Out.Flush()
  try { Wait-Process -Id $ParentId -Timeout 90 -ErrorAction Stop } catch { if (Get-Process -Id $ParentId -ErrorAction SilentlyContinue) { throw 'Desktop did not close' } }
  $installer = Start-Process -FilePath $Package -ArgumentList '/passive','/norestart' -Verb RunAs -Wait -PassThru
  if ($installer.ExitCode -ne 0 -and $installer.ExitCode -ne 3010) { throw ('Installer failed: ' + $installer.ExitCode) }
  Save-Result 'installed'
} catch {
  Save-Result 'failed'
} finally {
  if (Test-Path -LiteralPath $Executable -PathType Leaf) { Start-Process -FilePath $Executable }
}
