[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Rollback,
  [string]$BackupPath
)

$ErrorActionPreference = 'Stop'
$serviceName = 'Ragent-ControlPlane'
$healthUrl = 'http://127.0.0.1:7690/healthz'
$assets = @(
  'qr-creator.min.js',
  'chat/cross-device-panel.js',
  'chat/cross-device-panel.css',
  'chat/i18n.js'
)

function Get-ControlPlanePayloadPath {
  $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  if (-not $service) { throw "Windows service '$serviceName' was not found." }
  if ($service.State -ne 'Running') { throw "Windows service '$serviceName' is not running." }
  if ($service.PathName -notmatch '--working-directory\s+"(?<path>[^"]+)"') {
    throw 'Could not safely resolve the ControlPlane working directory from its service command line.'
  }
  $path = [IO.Path]::GetFullPath($Matches.path)
  $programFiles = [IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\') + '\'
  if (-not $path.StartsWith($programFiles, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a service directory outside Program Files: $path"
  }
  return $path
}

function Get-IdleHealth {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
  if ($health.status -ne 'ready') { throw "ControlPlane is not ready (status=$($health.status))." }
  $queue = $health.caches | Where-Object { $_.name -eq 'backgroundQueue' } | Select-Object -First 1
  $harness = $health.caches | Where-Object { $_.name -eq 'adaptive.harnessRuns' } | Select-Object -First 1
  if (-not $queue -or -not $harness) { throw 'Health response is missing the active-work counters; refusing to restart.' }
  if ([int]$queue.active -ne 0 -or [int]$queue.queued -ne 0 -or [int]$harness.active -ne 0 -or [int]$harness.queued -ne 0) {
    throw "ControlPlane has active work (background active/queued=$($queue.active)/$($queue.queued), harness active/queued=$($harness.active)/$($harness.queued)); refusing to restart."
  }
}

function Wait-ControlPlaneReady {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
      if ($health.status -eq 'ready') { return }
    } catch { }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'ControlPlane did not become ready within 45 seconds.'
}

function Set-ServiceRunning {
  param([ValidateSet('Running', 'Stopped')][string]$State)
  if ($State -eq 'Stopped') {
    Stop-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  } else {
    Start-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    Wait-ControlPlaneReady
  }
}

$payload = Get-ControlPlanePayloadPath
$staticRoot = Join-Path $payload 'static'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Rollback) {
  if (-not $BackupPath) { throw 'Rollback requires -BackupPath pointing to a backup created by this script.' }
  $BackupPath = [IO.Path]::GetFullPath($BackupPath)
  $allowedBackupRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Ragent\backups\cross-device-ui')).TrimEnd('\') + '\'
  if (-not $BackupPath.StartsWith($allowedBackupRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to restore from outside $allowedBackupRoot" }
  if (-not (Test-Path -LiteralPath (Join-Path $BackupPath 'manifest.json'))) { throw "Backup manifest was not found in $BackupPath" }
  $manifest = Get-Content -LiteralPath (Join-Path $BackupPath 'manifest.json') -Raw | ConvertFrom-Json
  if ([IO.Path]::GetFullPath($manifest.payloadPath) -ne $payload) { throw 'Backup belongs to a different ControlPlane payload directory.' }
  foreach ($asset in $assets) {
    $backupFile = Join-Path $BackupPath $asset
    if (-not (Test-Path -LiteralPath $backupFile)) { throw "Backup is incomplete: $asset" }
    $expectedBackup = $manifest.assets | Where-Object { $_.path -eq $asset } | Select-Object -First 1
    if (-not $expectedBackup -or (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash -ne $expectedBackup.sha256) { throw "Backup integrity check failed: $asset" }
  }
  if (-not $isElevated) { throw 'Run rollback from an elevated PowerShell window.' }
  Get-IdleHealth
  if ($PSCmdlet.ShouldProcess($payload, "Restore cross-device UI from $BackupPath")) {
    Get-IdleHealth
    Set-ServiceRunning -State Stopped
    try {
      foreach ($asset in $assets) {
        Copy-Item -LiteralPath (Join-Path $BackupPath $asset) -Destination (Join-Path $staticRoot $asset) -Force
      }
    } finally {
      Set-ServiceRunning -State Running
    }
  }
  return
}

foreach ($asset in $assets) {
  $source = Join-Path (Join-Path $repoRoot 'static') $asset
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Source asset is missing: $source" }
  if (-not (Test-Path -LiteralPath (Join-Path $staticRoot $asset) -PathType Leaf)) { throw "Installed asset is missing: $(Join-Path $staticRoot $asset)" }
}

if (-not $isElevated -and -not $WhatIfPreference) { throw 'Run this script from an elevated PowerShell window to update the Program Files installation.' }
Get-IdleHealth

if ($WhatIfPreference) {
  Write-Output "WhatIf OK. Service is ready and idle. Target: $payload"
  foreach ($asset in $assets) {
    $source = Join-Path (Join-Path $repoRoot 'static') $asset
    Write-Output ("{0}  {1}" -f $asset, (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash)
  }
  return
}

$backupRoot = Join-Path $env:ProgramData 'Ragent\backups\cross-device-ui'
$backup = Join-Path $backupRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
if ($PSCmdlet.ShouldProcess($payload, 'Install cross-device pairing UI assets and restart the idle ControlPlane service')) {
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $manifest = [ordered]@{ createdUtc = [DateTime]::UtcNow.ToString('o'); payloadPath = $payload; assets = @() }
  foreach ($asset in $assets) {
    $destBackup = Join-Path $backup $asset
    New-Item -ItemType Directory -Path (Split-Path -Parent $destBackup) -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $staticRoot $asset) -Destination $destBackup
    $manifest.assets += [ordered]@{ path = $asset; sha256 = (Get-FileHash -LiteralPath $destBackup -Algorithm SHA256).Hash }
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backup 'manifest.json') -Encoding UTF8

  Get-IdleHealth
  Set-ServiceRunning -State Stopped
  try {
    foreach ($asset in $assets) {
      Copy-Item -LiteralPath (Join-Path (Join-Path $repoRoot 'static') $asset) -Destination (Join-Path $staticRoot $asset) -Force
    }
    Set-ServiceRunning -State Running
    foreach ($asset in $assets) {
      $served = Join-Path $env:TEMP ([Guid]::NewGuid().ToString() + '.asset')
      try {
        Invoke-WebRequest -Uri ("http://127.0.0.1:7690/" + $asset.Replace('\', '/')) -OutFile $served -UseBasicParsing -TimeoutSec 10
        $expected = (Get-FileHash -LiteralPath (Join-Path (Join-Path $repoRoot 'static') $asset) -Algorithm SHA256).Hash
        $actual = (Get-FileHash -LiteralPath $served -Algorithm SHA256).Hash
        if ($actual -ne $expected) { throw "Served asset hash mismatch: $asset" }
      } finally {
        Remove-Item -LiteralPath $served -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
    $failure = $_
    try {
      Set-ServiceRunning -State Stopped
      foreach ($asset in $assets) {
        Copy-Item -LiteralPath (Join-Path $backup $asset) -Destination (Join-Path $staticRoot $asset) -Force
      }
      Set-ServiceRunning -State Running
    } catch {
      throw "Hotfix failed: $failure. Automatic rollback also failed: $_. Backup is at $backup"
    }
    throw "Hotfix failed and the previous files were restored: $failure. Backup is at $backup"
  }
  Write-Output "Cross-device UI updated and verified. Backup: $backup"
}
