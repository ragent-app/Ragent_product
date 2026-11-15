[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Rollback,
  [string]$BackupPath
)

$ErrorActionPreference = 'Stop'
$serviceName = 'Ragent-ControlPlane'
$healthUrl = 'http://127.0.0.1:7690/healthz'
$updates = @(
  @{ source = 'static/qr-creator.min.js'; target = 'static/qr-creator.min.js'; served = 'qr-creator.min.js' },
  @{ source = 'static/chat/cross-device-panel.js'; target = 'static/chat/cross-device-panel.js'; served = 'chat/cross-device-panel.js' },
  @{ source = 'static/chat/cross-device-panel.css'; target = 'static/chat/cross-device-panel.css'; served = 'chat/cross-device-panel.css' },
  @{ source = 'static/chat/i18n.js'; target = 'static/chat/i18n.js'; served = 'chat/i18n.js' },
  @{ source = 'chat/temporary-carrier-ingress.mjs'; target = 'chat/temporary-carrier-ingress.mjs'; served = $null },
  @{ source = 'chat/temporary-resource-policy.mjs'; target = 'chat/temporary-resource-policy.mjs'; served = $null },
  @{ source = 'chat/temporary-session-service.mjs'; target = 'chat/temporary-session-service.mjs'; served = $null },
  @{ source = 'lib/temporary-carrier-routes.mjs'; target = 'lib/temporary-carrier-routes.mjs'; served = $null },
  @{ source = 'lib/temporary-runtime-catalog.mjs'; target = 'lib/temporary-runtime-catalog.mjs'; served = $null }
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

function Get-ContainedPath {
  param([string]$Root, [string]$RelativePath)
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $path = [IO.Path]::GetFullPath((Join-Path $rootPath $RelativePath))
  if (-not $path.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a path outside its approved root: $RelativePath"
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

function Restore-Manifest {
  param([string]$Path, $Manifest)
  $payload = [IO.Path]::GetFullPath($Manifest.payloadPath)
  foreach ($entry in $Manifest.files) {
    $target = Get-ContainedPath $payload $entry.target
    if ($entry.existed) {
      $saved = Get-ContainedPath $Path $entry.target
      if (-not (Test-Path -LiteralPath $saved -PathType Leaf)) { throw "Backup file is missing: $($entry.target)" }
      if ((Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash -ne $entry.backupSha256) {
        throw "Backup integrity check failed: $($entry.target)"
      }
    }
  }
  Get-IdleHealth
  Set-ServiceRunning -State Stopped
  try {
    foreach ($entry in $Manifest.files) {
      $target = Get-ContainedPath $payload $entry.target
      if ($entry.existed) {
        $saved = Get-ContainedPath $Path $entry.target
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $saved -Destination $target -Force
      } elseif (Test-Path -LiteralPath $target -PathType Leaf) {
        Remove-Item -LiteralPath $target -Force
      }
    }
  } finally {
    Set-ServiceRunning -State Running
  }
}

$payload = Get-ControlPlanePayloadPath
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Rollback) {
  if (-not $BackupPath) { throw 'Rollback requires -BackupPath pointing to a backup created by this script.' }
  $BackupPath = [IO.Path]::GetFullPath($BackupPath)
  $allowedBackupRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Ragent\backups\temporary-access')).TrimEnd('\') + '\'
  if (-not $BackupPath.StartsWith($allowedBackupRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to restore from outside $allowedBackupRoot" }
  $manifestPath = Join-Path $BackupPath 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Backup manifest was not found.' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ([IO.Path]::GetFullPath($manifest.payloadPath) -ne $payload) { throw 'Backup belongs to a different ControlPlane payload directory.' }
  if (-not $isElevated) { throw 'Run rollback from an elevated PowerShell window.' }
  if ($PSCmdlet.ShouldProcess($payload, "Restore temporary-access files from $BackupPath")) {
    Restore-Manifest -Path $BackupPath -Manifest $manifest
  }
  return
}

foreach ($update in $updates) {
  $source = Get-ContainedPath $repoRoot $update.source
  $target = Get-ContainedPath $payload $update.target
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Source file is missing: $source" }
  if ($update.target -ne 'lib/temporary-runtime-catalog.mjs' -and -not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "Installed file is missing: $target"
  }
}

if (-not $isElevated -and -not $WhatIfPreference) { throw 'Run this script from an elevated PowerShell window to update the Program Files installation.' }
Get-IdleHealth

if ($WhatIfPreference) {
  Write-Output "WhatIf OK. Service is ready and idle. Target: $payload"
  foreach ($update in $updates) {
    $source = Get-ContainedPath $repoRoot $update.source
    Write-Output ("{0}  {1}" -f $update.target, (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash)
  }
  return
}

$backupRoot = Join-Path $env:ProgramData 'Ragent\backups\temporary-access'
$backup = Join-Path $backupRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
if ($PSCmdlet.ShouldProcess($payload, 'Install temporary-access runtime and pairing UI fixes, then restart the idle ControlPlane service')) {
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $manifest = [ordered]@{ version = 1; createdUtc = [DateTime]::UtcNow.ToString('o'); payloadPath = $payload; files = @() }
  foreach ($update in $updates) {
    $target = Get-ContainedPath $payload $update.target
    $existed = Test-Path -LiteralPath $target -PathType Leaf
    $entry = [ordered]@{ target = $update.target; existed = $existed; backupSha256 = $null }
    if ($existed) {
      $saved = Get-ContainedPath $backup $update.target
      New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
      Copy-Item -LiteralPath $target -Destination $saved
      $entry.backupSha256 = (Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash
    }
    $manifest.files += $entry
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backup 'manifest.json') -Encoding UTF8

  try {
    Get-IdleHealth
    Set-ServiceRunning -State Stopped
    try {
      foreach ($update in $updates) {
        $source = Get-ContainedPath $repoRoot $update.source
        $target = Get-ContainedPath $payload $update.target
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
      }
    } finally {
      Set-ServiceRunning -State Running
    }
    foreach ($update in $updates) {
      $source = Get-ContainedPath $repoRoot $update.source
      $target = Get-ContainedPath $payload $update.target
      if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
        throw "Installed file hash mismatch: $($update.target)"
      }
      if ($update.served) {
        $served = Join-Path $env:TEMP ([Guid]::NewGuid().ToString() + '.asset')
        try {
          Invoke-WebRequest -Uri ("http://127.0.0.1:7690/" + $update.served) -OutFile $served -UseBasicParsing -TimeoutSec 10
          if ((Get-FileHash -LiteralPath $served -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
            throw "Served asset hash mismatch: $($update.served)"
          }
        } finally {
          Remove-Item -LiteralPath $served -Force -ErrorAction SilentlyContinue
        }
      }
    }
  } catch {
    $failure = $_
    try { Restore-Manifest -Path $backup -Manifest $manifest }
    catch { throw "Hotfix failed: $failure. Automatic rollback also failed: $_. Backup is at $backup" }
    throw "Hotfix failed and the previous files were restored: $failure"
  }
  Write-Output "Temporary-access hotfix installed and verified. Backup: $backup"
}
