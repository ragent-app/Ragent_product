# Quiesce only the two validated Owner services while retaining their automatic
# start mode. A protected marker lets the MSI rollback action restore them if
# validation is cancelled or any later uninstall action fails.
[CmdletBinding()]
param([ValidateSet('Stop')][string]$Action)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'prepare-owner-service-data.ps1') -LibraryOnly
$product=Get-OwnerProductRoot
$marker=Join-Path $product 'owner-msi.prevalidation-lock'
$pins=[Collections.Generic.List[IDisposable]]::new()
$leases=[Collections.Generic.List[IDisposable]]::new()
try{
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OPV_ADMIN_REQUIRED'}
 Open-OwnerServicePreparationInputs $pins
 if(Test-OwnerServicePreparationPresence $marker){throw 'OPV_PRIOR_TRANSACTION'}
 $plans=@(Get-OwnerServicePreparationPlan)
 if($plans.Count -ne 2){throw 'OPV_PLAN_INVALID'}
 Add-Type -Path (Join-Path $PSScriptRoot 'owner-service-activation-trial.cs')
 foreach($plan in $plans){
  $row=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'")
  if(-not $row -or $row.PathName -cne $plan.command -or $row.StartName -ine $plan.account){throw 'OPV_SERVICE_BINDING_CHANGED'}
  # If a user intentionally stopped either service, do not change either one.
  if($row.State -ne 'Running' -or $row.StartMode -ne 'Auto'){
   @{ok=$true;quiesced=$false;reason='service-not-running'}|ConvertTo-Json -Compress;return
  }
 }
 foreach($plan in $plans){$leases.Add([OwnerServiceActivationTrial]::OpenForRemoval($plan.name,$plan.command))}
 foreach($lease in $leases){$lease.VerifyRemoval();if($lease.LastServiceState -ne 4){throw 'OPV_SERVICE_STATE_CHANGED'}}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes("ragent-msi-prevalidation-v1`n")
 $stream=[IO.FileStream]::new($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 $actual=Read-OwnerPinnedFile $marker @(Get-OwnerAdministrativeSids) $pins 1024
 if([Text.UTF8Encoding]::new($false,$true).GetString($actual) -cne "ragent-msi-prevalidation-v1`n"){throw 'OPV_MARKER_INVALID'}
 # Control Plane depends on Runner Supervisor; stop it first.
 for($i=$leases.Count-1;$i -ge 0;$i--){$leases[$i].QuiesceForRemoval()}
 @{ok=$true;quiesced=$true}|ConvertTo-Json -Compress
}catch{
 $code=$_.Exception.GetBaseException().Message
 if($code -cnotmatch '^(OPV|OAT|OSP|ODP)_[A-Z_]+$'){$code='OPV_STOP_FAILED'}
 @{ok=$false;code=$code}|ConvertTo-Json -Compress;exit 1
}finally{
 foreach($lease in $leases){$lease.Dispose()}
 for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}
}
