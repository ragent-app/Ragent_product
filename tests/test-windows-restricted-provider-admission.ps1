[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$candidateSource = Split-Path -Parent $PSScriptRoot
$candidateId = [Guid]::NewGuid().ToString('N')
$candidateRoot = Join-Path $env:LOCALAPPDATA "Ragent\restricted-runs\$candidateId"
$candidateProfile = "ragent.restricted.$candidateId"
$candidateEvidence = Join-Path $candidateSource 'artifacts\showcase\T2-current-20261017\restricted-provider'
$candidateIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($candidateIdentity.IsSystem -or ([Security.Principal.WindowsPrincipal]::new($candidateIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this fixture as an ordinary user'
}
$candidateReport = [ordered]@{case=$candidateId;pass=$false;root=$candidateRoot;credentialsUsed=$false;providerStarted=$false;tests=@()}
New-Item -ItemType Directory -Path $candidateRoot | Out-Null
& "$env:SystemRoot\System32\icacls.exe" $candidateRoot '/inheritance:r' '/grant:r' "*$($candidateIdentity.User.Value):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Private root ACL failed' }
[IO.File]::WriteAllText((Join-Path $candidateRoot '.ragent-restricted-run'),$candidateProfile)
foreach ($candidatePart in @('runtime','workspace','control','state','evidence')) {
  New-Item -ItemType Directory -Path (Join-Path $candidateRoot $candidatePart) | Out-Null
}
$candidateHelper = Join-Path $candidateRoot 'runtime\RestrictedProviderCandidate.exe'
$candidateLaunch = Join-Path $candidateRoot 'control\launch.json'
try {
  New-Item -ItemType Directory -Force -Path $candidateEvidence | Out-Null
  & "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe" '/nologo' '/target:exe' '/platform:x64' '/r:System.Web.Extensions.dll' "/out:$candidateHelper" (Join-Path $candidateSource 'native\windows-restricted-provider-candidate.cs') *> (Join-Path $candidateRoot 'evidence\build.log')
  if ($LASTEXITCODE -ne 0) { throw 'Candidate compilation failed' }
  $candidateBase = @{version=1;caseId=$candidateId;runId=('run_'+[Guid]::NewGuid().ToString('N'));grantId=('rtg_'+[Guid]::NewGuid().ToString('N'));requestId=('request_'+[Guid]::NewGuid().ToString('N'));harness='claude';authorityHash=('e'*64);expiresAtUnixMs=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+120000);configSha256=('a'*64);inputSha256=('b'*64);promptSha256=('c'*64);probeSha256=('d'*64)}
  [IO.File]::WriteAllText((Join-Path $candidateRoot 'runtime\node.exe'),'SYNTHETIC-NOT-AN-EXECUTABLE')
  foreach ($candidateMode in @('expired','overlong','cancelled','invalid-grant','unknown-harness','tampered-binary')) {
    $candidateSpec = $candidateBase.Clone()
    $candidateExpected = switch ($candidateMode) {
      'expired' { $candidateSpec.expiresAtUnixMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-1000; 'Invalid launch deadline' }
      'overlong' { $candidateSpec.expiresAtUnixMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+600000; 'Invalid launch deadline' }
      'cancelled' { [IO.File]::WriteAllText((Join-Path $candidateRoot 'control\cancel'),'1'); 'Run cancelled before admission' }
      'invalid-grant' { $candidateSpec.grantId='owner'; 'Invalid bound launch inputs' }
      'unknown-harness' { $candidateSpec.harness='external-path'; 'Unsupported internal Harness' }
      'tampered-binary' { 'Internal runtime copy mismatch' }
    }
    [IO.File]::WriteAllText($candidateLaunch,($candidateSpec | ConvertTo-Json -Compress))
    $candidateRaw = & $candidateHelper $candidateRoot $candidateProfile
    $candidateExit = $LASTEXITCODE
    $candidateFacts = $candidateRaw | ConvertFrom-Json
    $candidatePassed = $candidateExit -eq 1 -and -not $candidateFacts.pass -and -not $candidateFacts.profileDeleted -and $candidateFacts.error -eq $candidateExpected -and -not $candidateFacts.packageSid -and -not $candidateFacts.cases
    $candidateReport.tests += @{name=$candidateMode;pass=$candidatePassed;exitCode=$candidateExit;native=$candidateFacts}
    if (-not $candidatePassed) { throw "Admission fixture failed: $candidateMode" }
    if ($candidateMode -eq 'cancelled') { Remove-Item -LiteralPath (Join-Path $candidateRoot 'control\cancel') }
  }
  $candidateAcl = (Get-Acl -LiteralPath $candidateSource).Sddl
  $candidateOutsideRaw = & $candidateHelper $candidateSource $candidateProfile
  $candidateOutsideExit = $LASTEXITCODE
  $candidateOutside = $candidateOutsideRaw | ConvertFrom-Json
  $candidateOutsidePassed = $candidateOutsideExit -eq 1 -and $candidateOutside.error -eq 'Not an owned probe root/profile' -and -not $candidateOutside.profileDeleted -and (Get-Acl -LiteralPath $candidateSource).Sddl -eq $candidateAcl
  $candidateReport.tests += @{name='outside-root-no-acl-change';pass=$candidateOutsidePassed;exitCode=$candidateOutsideExit;native=$candidateOutside}
  if (-not $candidateOutsidePassed) { throw 'Outside root fixture failed' }
  foreach($candidateServiceMode in @('--service-run','--service-boundary')){
    $candidateServiceRaw=& $candidateHelper $candidateServiceMode $candidateRoot $candidateProfile
    $candidateServiceExit=$LASTEXITCODE
    $candidateServiceFacts=$candidateServiceRaw|ConvertFrom-Json
    $candidateServicePassed=$candidateServiceExit -eq 1 -and $candidateServiceFacts.error -eq 'SERVICE_EXECUTOR_REQUIRED' -and -not $candidateServiceFacts.packageSid
    $candidateReport.tests+=@{name=('ordinary-caller-'+$candidateServiceMode);pass=$candidateServicePassed;native=$candidateServiceFacts}
    if(-not $candidateServicePassed){throw 'Service mode admitted ordinary caller'}
  }
  $candidateReport.sourceFiles = @('native/windows-restricted-provider-candidate.cs','tests/test-windows-restricted-provider-admission.ps1') | ForEach-Object { @{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $candidateSource $_)).Hash.ToLowerInvariant()} }
  $candidateReport.pass = $true
} catch { $candidateReport.error=$_.Exception.Message }
finally {
  # Exact fresh marked root only; no recursive delete, all reports retained.
  $candidateResolved = [IO.Path]::GetFullPath($candidateRoot)
  $candidateParent = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Ragent\restricted-runs')).TrimEnd('\')+'\'
  if (-not $candidateResolved.StartsWith($candidateParent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($candidateResolved) -ne $candidateId) { throw 'Cleanup root mismatch' }
  if ([IO.File]::ReadAllText((Join-Path $candidateRoot '.ragent-restricted-run')) -ne $candidateProfile) { throw 'Cleanup marker mismatch' }
  if ((Get-Acl -LiteralPath $candidateRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $candidateIdentity.User.Value) { throw 'Cleanup owner mismatch' }
  foreach ($candidateFile in @($candidateRoot,(Join-Path $candidateRoot 'runtime'),$candidateHelper,(Join-Path $candidateRoot 'runtime\node.exe'))) {
    if ((Get-Item -LiteralPath $candidateFile).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup reparse mismatch' }
  }
  Remove-Item -LiteralPath $candidateHelper
  Remove-Item -LiteralPath (Join-Path $candidateRoot 'runtime\node.exe')
  $candidatePath = Join-Path $candidateEvidence "admission-$candidateId.json"
  $candidateReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $candidatePath -Encoding utf8
  @{pass=$candidateReport.pass;report=$candidatePath;error=$candidateReport.error} | ConvertTo-Json -Compress
}
if (-not $candidateReport.pass) { exit 1 }
