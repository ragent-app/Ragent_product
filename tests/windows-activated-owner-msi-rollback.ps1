# Actual full-payload MSI post-activation rollback on a disposable Windows
# runner. MSI installation changes machine state and must never run locally.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$MsiPath,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$product='C:\Program Files\Ragent';$data='C:\ProgramData\Ragent'
$names=@('Ragent-ControlPlane','Ragent-RunnerSupervisor')
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'AOMR_DISPOSABLE_RUNNER_REQUIRED'}
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'AOMR_ADMIN_REQUIRED'}
if([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)){throw 'AOMR_TEMP_REQUIRED'}
$root=[IO.Path]::GetFullPath($EvidenceDirectory);$msi=[IO.Path]::GetFullPath($MsiPath);$temp=([IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\')
if(-not $root.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or -not $msi.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'AOMR_PATH_OUTSIDE_RUNNER_TEMP'}
foreach($path in @($root,$msi)){for($cursor=$path;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){if(Test-Path -LiteralPath $cursor -PathType Any -ErrorAction SilentlyContinue){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'AOMR_REPARSE_REFUSED'}}}}
if(-not(Test-Path -LiteralPath $msi -PathType Leaf)){throw 'AOMR_MSI_MISSING'}
foreach($name in $names){if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'AOMR_EXISTING_SERVICE_REFUSED'}}
foreach($path in @($product,$data)){if(Test-Path -LiteralPath $path){throw 'AOMR_EXISTING_INSTALL_REFUSED'}}
if(@(Get-NetTCPConnection -State Listen -LocalPort 7690 -ErrorAction SilentlyContinue).Count){throw 'AOMR_PORT_OCCUPIED'}
$null=New-Item -ItemType Directory -Path $root -Force
$hash=(Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
$log=Join-Path $root 'post-activation-rollback.msi.log'
$arguments=@('/i',('"'+$msi+'"'),'/qn','/norestart','/l*v',('"'+$log+'"'))
$process=Start-Process -FilePath 'C:\Windows\System32\msiexec.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden
if(-not $process.WaitForExit(600000)){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue;throw 'AOMR_INSTALL_TIMEOUT'}
$exitCode=$process.ExitCode
if($exitCode -eq 0){throw 'AOMR_INJECTED_FAILURE_NOT_OBSERVED'}
if(-not(Test-Path -LiteralPath $log -PathType Leaf)){throw 'AOMR_MSI_LOG_MISSING'}
$logText=[IO.File]::ReadAllText($log)
if($logText -notmatch 'CustomActionSchedule\(Action=ManagedInjectedPostActivationFailure,ActionType=3074,Source=BinaryData,Target=injected-failure(?:\s+"[^"]+")?,' -or
   $logText -notmatch 'CustomAction ManagedInjectedPostActivationFailure returned actual error code 93' -or
   $logText -notmatch 'Action ManagedInjectedPostActivationFailure, location:'){throw 'AOMR_FAILURE_WAS_NOT_DEFERRED_AFTER_ACTIVATION'}
if($logText -notmatch 'ManagedActivate:.*Return value 1|Action ended .*: ManagedActivate\. Return value 1'){throw 'AOMR_ACTIVATION_DID_NOT_COMMIT_BEFORE_FAILURE'}
$serviceRows=@();foreach($name in $names){$service=Get-Service -Name $name -ErrorAction SilentlyContinue;if($service){$serviceRows+=@{name=$name;state=[string]$service.Status;startMode=(Get-CimInstance Win32_Service -Filter "Name='$name'").StartMode}}}
if($serviceRows.Count){throw 'AOMR_SERVICE_REGISTRATION_REMAINS'}
$processes=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($product+'\',[StringComparison]::OrdinalIgnoreCase)})
if($processes.Count){throw 'AOMR_PRODUCT_PROCESS_REMAINS'}
if(@(Get-NetTCPConnection -State Listen -LocalPort 7690 -ErrorAction SilentlyContinue).Count){throw 'AOMR_CONTROL_PLANE_LISTENER_REMAINS'}
$identity=Join-Path $data 'instances\owner\config\instance-identity.json'
$secret=Join-Path $data 'instances\owner\config\auth-session-secret'
$policy=Join-Path $data 'instances\owner\security\owner-bootstrap-install.json'
$state=[ordered]@{
  identityPresent=(Test-Path -LiteralPath $identity -PathType Leaf)
  secretPresent=(Test-Path -LiteralPath $secret -PathType Leaf)
  policyPresent=(Test-Path -LiteralPath $policy -PathType Leaf)
  ownerConfigPresent=(Test-Path -LiteralPath (Split-Path -Parent $identity) -PathType Container)
  ownerSecurityPresent=(Test-Path -LiteralPath (Split-Path -Parent $policy) -PathType Container)
  prepareLockPresent=(Test-Path -LiteralPath (Join-Path $product 'owner-msi.prepare-lock') -PathType Leaf)
}
$state|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $root 'rollback-state.json') -Encoding UTF8
if(-not $state.identityPresent){throw 'AOMR_IDENTITY_NOT_RETAINED'}
if(-not $state.secretPresent){throw 'AOMR_SESSION_SECRET_NOT_RETAINED'}
if(-not $state.policyPresent){throw 'AOMR_INSTALL_POLICY_NOT_RETAINED'}
$quarantine=Join-Path $product 'owner-msi.prepare-lock'
if(-not $state.prepareLockPresent){throw 'AOMR_QUARANTINE_MARKER_MISSING'}
$report=[ordered]@{
  pass=$true;sourceCommit=$env:GITHUB_SHA;runId=$env:GITHUB_RUN_ID
  msiSha256=$hash;msiBytes=(Get-Item -LiteralPath $msi).Length;msiexecExitCode=$exitCode
  actualFullPayloadMsi=$true;activationCompletedBeforeInjectedFailure=$true
  serviceRegistrationsRemoved=$true;ownedProcessesGone=$true;port7690Closed=$true
  protectedIdentityRetained=$true;sessionSecretRetained=$true;installPolicyRetained=$true
  quarantineMarkerRetained=$true;providerLoginRun=$false;physicalAndroidPairing=$false
  releaseReady=$false;migrationReady=$false;msiLog='post-activation-rollback.msi.log'
}
$report|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $root 'report.json') -Encoding UTF8
Write-Output ($report|ConvertTo-Json -Compress)
