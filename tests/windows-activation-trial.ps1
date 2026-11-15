# Admitted fresh disposable MSI guest only. Service adapter substitutes normal
# entries; no signed-policy coordinator or final activation positive is claimed.
function Invoke-ActivationTrialAcceptance([string]$EvidenceRoot,[switch]$TransactionAcceptance,[switch]$InterruptionAcceptance){
 if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository'){throw 'ATQ_DISPOSABLE_REQUIRED'}
 $product='C:\Program Files\Ragent';$workspace='C:\ProgramData\Ragent\instances\owner\workspace';$probe=Join-Path $product 'ActivationTrialProbe.exe';$marker=Join-Path $product 'owner-activation.prepare-lock';$changed=@();$leases=$null;$parked=$false
 $result=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;adapterSubstituted=$true;publicActivationExposed=$false;publicPositiveSignedAcceptance=$false;businessActivated=$false;authorityIssued=$false;testOnlyQuarantineCleanup=$true;checks=@()}
 $result.sourceFiles=@('packaging/windows/owner-service-activation-trial.cs','tests/windows-activation-trial.ps1','tests/fixtures/windows-activation-trial-service.cs','packaging/windows/legacy-owner-install-guard.cs','packaging/windows/initialize-owner-service-identity.ps1','packaging/windows/prepare-owner-msi-policy.ps1','packaging/windows/remove-owner-msi-policy.ps1')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}
 $result.before=@(Observe);$plans=@(Get-OwnerServicePreparationPlan);$serviceSids=@(Get-OwnerDataServices)
 function TrialCommand($Plan){return ('"'+$probe+'" '+$Plan.role)}
 function TrialFacts {
  @($plans|ForEach-Object {$s=Get-CimInstance Win32_Service -Filter ("Name='"+$_.name+"'");@{role=$_.role;command=$s.PathName;account=$s.StartName;mode=$s.StartMode;state=$s.State;pid=$s.ProcessId}})
 }
 function Open-Trials {
  $sup=$null;try{$s=$plans|Where-Object {$_.role -eq 'supervisor'};$sup=[OwnerServiceActivationTrial]::new($s.name,(TrialCommand $s));$c=$plans|Where-Object {$_.role -eq 'control'};$control=[OwnerServiceActivationTrial]::new($c.name,(TrialCommand $c));return @{supervisor=$sup;control=$control}}catch{if($sup){$sup.Dispose()};throw}
 }
 function Restore-Trials($Value){$r=[ordered]@{};foreach($role in @('control','supervisor')){try{$Value[$role].RestoreDisabled();$r[$role]='restored'}catch{$r[$role]=$_.Exception.GetBaseException().Message}};return $r}
 function Dispose-Trials($Value){if($Value){$null=Restore-Trials $Value;foreach($v in $Value.Values){$v.Dispose()}}}
 function Read-TrialProbes($Value,[string]$Phase){
  @($plans|ForEach-Object {$f=[IO.File]::ReadAllText((Join-Path $workspace ('activation-'+$_.role+'.json')))|ConvertFrom-Json;$sid=($serviceSids|Where-Object {$_.role -eq $f.role}).sid
   if($f.sid -cne $sid -or $f.integrityRid -ne 8192 -or $f.sessionId -ne 0 -or -not $f.reducedTokenVerified -or -not $f.adapterSubstituted -or $f.failurePhase -cne $(if($_.role -eq 'control'){$Phase}else{'none'})){throw 'ATQ_TOKEN_OR_PHASE_MISMATCH'}
   if($Value[$_.role].ProcessId -ne 0 -and $Value[$_.role].ProcessId -ne $f.pid){throw 'ATQ_PINNED_PROCESS_MISMATCH'};$f})
 }
 try {
  if($TransactionAcceptance){Add-Type -Path @((Join-Path $pack 'Ragent.ServiceHost.cs'),(Join-Path $pack 'owner-service-activation-trial.cs'),(Join-Path $pack 'owner-service-activation-transaction.cs')) -ReferencedAssemblies @('System.ServiceProcess.dll','System.Web.Extensions.dll')}else{Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $pack 'owner-service-activation-trial.cs')))}
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /main:ActivationTrialService /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll ('/out:'+$probe) (Join-Path $pack 'Ragent.ServiceHost.cs') (Join-Path $repo 'tests\fixtures\windows-activation-trial-service.cs')|Out-Null;if($LASTEXITCODE -ne 0){throw 'ATQ_ADAPTER_COMPILE'}
  $file=[IO.FileStream]::new($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$b=[Text.Encoding]::UTF8.GetBytes('{"version":1,"purpose":"qa-owner-activation-trial"}');$file.Write($b,0,$b.Length);$file.Flush($true)}finally{$file.Dispose()}
  $receipt=Join-Path $product 'owner-msi.prepared.json';$park=Join-Path $product 'owner-msi.prepared.qa-parked';if(Test-Path -LiteralPath $park){throw 'ATQ_PARK_EXISTS'}
  if([IO.Path]::GetDirectoryName($receipt) -cne $product -or [IO.Path]::GetDirectoryName($park) -cne $product){throw 'ATQ_PARK_PATH'}
  Move-Item -LiteralPath $receipt -Destination $park;$parked=$true
  try{try{Assert-OwnerPolicyInstallComplete;throw 'ATQ_NATIVE_GATE_LOST'}catch{if($_.Exception.Message -cne 'OBD_INSTALL_INCOMPLETE'){throw}}
   $layout=Join-Path $work 'ActivationLayoutProbe.exe'; & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /main:PreparedMsiHostProbe /r:System.ServiceProcess.dll /r:System.Security.dll ('/out:'+$layout) (Join-Path $pack 'Ragent.ServiceHost.cs') (Join-Path $repo 'tests\fixtures\windows-managed-msi-host.cs')|Out-Null;if($LASTEXITCODE -ne 0){throw 'ATQ_LAYOUT_COMPILE'}
   $blocked=& $layout activation-marker;if($LASTEXITCODE -ne 0 -or $blocked -cne 'SHT_INSTALLATION_INCOMPLETE'){throw 'ATQ_HOST_GATE_LOST'}
  }finally{Move-Item -LiteralPath $park -Destination $receipt;$parked=$false}
  $result.checks+='activation-marker-alone-blocks-native-policy-and-compiled-host-layout'
  foreach($plan in $plans){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'");if($s.PathName -cne $plan.command -or $s.StartMode -cne 'Disabled' -or $s.State -cne 'Stopped'){throw 'ATQ_OWNERSHIP'};$r=Invoke-CimMethod -InputObject $s -MethodName Change -Arguments @{PathName=(TrialCommand $plan)};if($r.ReturnValue -ne 0){throw 'ATQ_ADAPTER_INSTALL'};$changed+=$plan}
  Set-Service 'Ragent-ControlPlane' -StartupType Manual
  try{try{$bad=Open-Trials;Dispose-Trials $bad;throw 'ATQ_CHANGED_MODE_ACCEPTED'}catch{if($_.Exception.GetBaseException().Message -cne 'OAT_CONFIG_CHANGED'){throw}}}finally{Set-Service 'Ragent-ControlPlane' -StartupType Disabled}
  $result.checks+='native-handle-admission-refuses-changed-start-mode-without-repair'
  $leases=Open-Trials;try{$leases.supervisor.Prepare();$leases.control.Prepare();$leases.supervisor.Start();$leases.control.Start();$result.successProbes=@(Read-TrialProbes $leases 'none');$result.running=@(TrialFacts);$r=Restore-Trials $leases;if($r.control -cne 'restored' -or $r.supervisor -cne 'restored'){throw 'ATQ_SUCCESS_DRAIN_FAILED'};$result.successRestore=$r}finally{Dispose-Trials $leases;$leases=$null}
  $result.checks+='two-actual-reduced-services-start-manual-then-drain-and-restore-disabled'
  $after=Join-Path $workspace 'activation-control-fail-after';[IO.File]::WriteAllText($after,'OWN-DECLARED-AFTER-RUNNING-FAILURE')
  $leases=Open-Trials;try{$leases.supervisor.Prepare();$leases.control.Prepare();$leases.supervisor.Start();$leases.control.Start();$result.afterFailureProbes=@(Read-TrialProbes $leases 'after-running');$controller=[ServiceProcess.ServiceController]::new('Ragent-ControlPlane');try{$controller.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(10))}finally{$controller.Dispose()};$r=Restore-Trials $leases;$result.afterFailureRestore=$r;$result.afterFailureServiceError=$leases.control.LastServiceError;if($r.control -cne 'restored' -or $r.supervisor -cne 'restored' -or $result.afterFailureServiceError -ne 1064){throw 'ATQ_AFTER_FAILURE_NOT_RESTORED'}}finally{Dispose-Trials $leases;$leases=$null;[IO.File]::Delete($after)}
  if(-not(Test-Path -LiteralPath $marker)){throw 'ATQ_QUARANTINE_LOST'};$result.checks+='post-running-control-failure-restores-disabled-after-exact-process-drain-keeps-marker'
  $before=Join-Path $workspace 'activation-control-fail-before';[IO.File]::WriteAllText($before,'OWN-DECLARED-BEFORE-RUNNING-FAILURE')
  $leases=Open-Trials;try{$leases.supervisor.Prepare();$leases.control.Prepare();$leases.supervisor.Start();try{$leases.control.Start();throw 'ATQ_BEFORE_FAILURE_ACCEPTED'}catch{$result.beforeFailureCode=$_.Exception.GetBaseException().Message;if($result.beforeFailureCode -cnotin @('OAT_STOPPED_BEFORE_RUNNING','OAT_START_REFUSED')){throw}};$result.beforeFailureProbes=@(Read-TrialProbes $leases 'before-running');$r=Restore-Trials $leases;$result.beforeFailureRestore=$r;$result.beforeFailureServiceError=$leases.control.LastServiceError;if($r.control -cne 'OAT_PROCESS_DRAIN_UNCONFIRMED' -or $r.supervisor -cne 'restored' -or $result.beforeFailureServiceError -ne 1064){throw 'ATQ_UNCONFIRMED_START_ADOPTED'};$result.quarantined=@(TrialFacts)}finally{Dispose-Trials $leases;$leases=$null;[IO.File]::Delete($before)}
  if(-not(Test-Path -LiteralPath $marker)){throw 'ATQ_QUARANTINE_LOST'};$result.checks+='pre-running-failure-without-trusted-pid-refuses-auto-recovery-and-keeps-quarantine'
  # Explicit QA cleanup only: current probe command/account, STOPPED/PID0 and
  # no executable process are independently checked before resetting test mode.
  $left=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -ceq $probe});if($left.Count){throw 'ATQ_QA_PROCESS_NOT_DRAINED'}
  if($TransactionAcceptance){[IO.File]::Delete($marker);. (Join-Path $PSScriptRoot 'windows-activation-transaction.ps1');$result.transaction=Invoke-ActivationTransactionAcceptance $EvidenceRoot;if(-not $result.transaction.pass){throw 'ATQ_TRANSACTION_FAILED'}}
  if($InterruptionAcceptance){. (Join-Path $PSScriptRoot 'windows-activation-interruption.ps1');$result.interruption=Invoke-ActivationInterruptionAcceptance $EvidenceRoot;if(-not $result.interruption.pass){throw 'ATQ_INTERRUPTION_FAILED'}}
  foreach($plan in $changed){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'");if($s.PathName -cne (TrialCommand $plan) -or $s.StartName -ine $plan.account -or $s.State -cne 'Stopped' -or $s.ProcessId -ne 0){throw 'ATQ_CLEANUP_STATE'};Set-Service $plan.name -StartupType Disabled;$r=Invoke-CimMethod -InputObject $s -MethodName Change -Arguments @{PathName=$plan.command};if($r.ReturnValue -ne 0){throw 'ATQ_RESTORE_IMAGE'}}
  $changed=@();$result.after=@(Observe);[IO.File]::Delete($marker);[IO.File]::Delete($probe);$result.pass=$true
 }catch{$result.error=$_.Exception.GetBaseException().Message;throw}
 finally{Dispose-Trials $leases;if($parked){Move-Item -LiteralPath (Join-Path $product 'owner-msi.prepared.qa-parked') -Destination (Join-Path $product 'owner-msi.prepared.json')}
  foreach($plan in $changed){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'");$left=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -ceq $probe});if($s.PathName -ceq (TrialCommand $plan) -and $s.StartName -ieq $plan.account -and $s.State -ceq 'Stopped' -and $s.ProcessId -eq 0 -and $left.Count -eq 0){Set-Service $plan.name -StartupType Disabled;$null=Invoke-CimMethod -InputObject $s -MethodName Change -Arguments @{PathName=$plan.command}}}
  [IO.File]::WriteAllText((Join-Path $EvidenceRoot 'activation-trial-report.json'),($result|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
 return $result
}
