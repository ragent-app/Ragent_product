# Actual abrupt coordinator termination on owned disposable registrations only.
function Invoke-ActivationInterruptionAcceptance([string]$EvidenceRoot){
 if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'AIQ_DISPOSABLE_REQUIRED'}
 $result=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;adapterSubstituted=$true;syntheticPolicyReceipt=$true;publicPositiveSignedAcceptance=$false;productHealthTested=$false;businessActivated=$false;authorityIssued=$false;servicesStarted=$false;powerLossTested=$false;testOnlyQuarantineCleanup=$true;cases=@()}
 $result.sourceFiles=@('tests/windows-activation-interruption.ps1','tests/fixtures/windows-activation-coordinator-interruption.ps1')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}
 $product='C:\Program Files\Ragent';$preparedPath=Join-Path $product 'owner-msi.prepared.json';$policyPath=Join-Path $product 'owner-msi.policy.json';$preparedBytes=[IO.File]::ReadAllBytes($preparedPath);$policyBytes=[Text.Encoding]::UTF8.GetBytes('{"purpose":"explicit-qa-synthetic-policy-receipt"}')
 $files=@('owner-msi.prepared.json','owner-msi.policy.json','owner-msi.activated.json','owner-msi.activation-health.json','owner-msi.prepared.activated.json','owner-msi.policy.activated.json','owner-activation.prepare-lock','owner-activation.committed-lock');$child=$null;$ownedHandle=[IntPtr]::Zero
 Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class ActivationInterruptionOwnedProcess {
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 public static void Terminate(IntPtr handle){if(handle==IntPtr.Zero||WaitForSingleObject(handle,0)!=258||!TerminateProcess(handle,0xA44)||WaitForSingleObject(handle,10000)!=0)throw new InvalidOperationException("AIQ_OWNED_PROCESS_TERMINATION_FAILED");}
}
'@
 function InterruptionMetadata {
  @($files|ForEach-Object {$p=Join-Path $product $_;@{name=$_;exists=(Test-Path -LiteralPath $p);sha256=$(if(Test-Path -LiteralPath $p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}else{''})}})
 }
 function Assert-InterruptionServices {
  foreach($plan in $plans){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'");if($s.PathName -cne (TrialCommand $plan) -or $s.StartName -ine $plan.account -or $s.State -cne 'Stopped' -or $s.ProcessId -ne 0 -or $s.StartMode -cne 'Auto'){throw 'AIQ_INTERRUPTED_SERVICE_STATE'}}
 }
 function Clear-OwnInterruption {
  # QA recovery, not product recovery: independently recheck fixed stopped
  # registrations and absent adapter processes before restoring only own files.
  Assert-InterruptionServices
  if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -ceq $probe}).Count){throw 'AIQ_QA_PROCESS_REMAINS'}
  foreach($plan in $plans){Set-Service $plan.name -StartupType Disabled}
  foreach($name in $files|Where-Object {$_ -cnotin @('owner-msi.prepared.json','owner-msi.policy.json')}){$p=Join-Path $product $name;if(Test-Path -LiteralPath $p){[IO.File]::Delete($p)}}
  [IO.File]::WriteAllBytes($preparedPath,$preparedBytes);[IO.File]::WriteAllBytes($policyPath,$policyBytes)
 }
 try {
  foreach($name in $files|Where-Object {$_ -cne 'owner-msi.prepared.json'}){if(Test-Path -LiteralPath (Join-Path $product $name)){throw 'AIQ_EXISTING_STATE'}}
  [IO.File]::WriteAllBytes($policyPath,$policyBytes)
  foreach($phase in @('prepared','committed')){
   $info=[Diagnostics.ProcessStartInfo]::new('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe');$info.Arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $repo 'tests\fixtures\windows-activation-coordinator-interruption.ps1')+'" -Phase '+$phase;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
   $child=[Diagnostics.Process]::new();$child.StartInfo=$info;if(-not $child.Start()){throw 'AIQ_START_FAILED'};$ownedHandle=$child.Handle;$pidBefore=$child.Id;$startBefore=$child.StartTime.ToUniversalTime().ToString('o');$stderr=$child.StandardError.ReadToEndAsync();$lineTask=$child.StandardOutput.ReadLineAsync()
   if(-not $lineTask.Wait(60000) -or [string]::IsNullOrEmpty($lineTask.Result)){throw 'AIQ_READY_MISSING'}
   $raw=$lineTask.Result;[IO.File]::WriteAllText((Join-Path $EvidenceRoot ('interruption-'+$phase+'-ready.json')),$raw,[Text.UTF8Encoding]::new($false));$ready=$raw|ConvertFrom-Json
   if($ready.phase -cne $phase -or $ready.pid -ne $pidBefore -or -not $ready.begun -or $ready.configurationCommitted -ne ($phase -ceq 'committed') -or $ready.servicesStarted -ne $false -or $child.HasExited){throw 'AIQ_WRONG_READY'}
   Assert-InterruptionServices;$before=@(InterruptionMetadata);$beforeServices=@(TrialFacts)
   [ActivationInterruptionOwnedProcess]::Terminate($ownedHandle);$null=$child.WaitForExit(10000);$child.Refresh();if(-not $child.HasExited -or $child.ExitCode -ne 2628){throw 'AIQ_EXIT_MISMATCH'}
   $err=$stderr.Result;[IO.File]::WriteAllText((Join-Path $EvidenceRoot ('interruption-'+$phase+'-stderr.txt')),$err,[Text.UTF8Encoding]::new($false));if($err.Length){throw 'AIQ_CHILD_STDERR'}
   # Observe twice after real coordinator death; no repair API is called here.
   $after=@(InterruptionMetadata);Assert-InterruptionServices;$afterServices=@(TrialFacts);Start-Sleep -Milliseconds 1000;$stable=@(InterruptionMetadata);Assert-InterruptionServices
   if(($before|ConvertTo-Json -Depth 4 -Compress) -cne ($after|ConvertTo-Json -Depth 4 -Compress) -or ($after|ConvertTo-Json -Depth 4 -Compress) -cne ($stable|ConvertTo-Json -Depth 4 -Compress)){throw 'AIQ_METADATA_CHANGED'}
   $case=[ordered]@{phase=$phase;pid=$pidBefore;startedAt=$startBefore;ready=$ready;exitCode=$child.ExitCode;terminatedThroughRetainedHandle=$true;before=$before;after=$after;stable=$stable;beforeServices=$beforeServices;afterServices=$afterServices;healthReceiptExists=(Test-Path -LiteralPath (Join-Path $product 'owner-msi.activation-health.json'));automaticRollbackObserved=$false;stderrEmpty=$true}
   if($phase -ceq 'prepared'){
    try{Assert-OwnerPolicyInstallComplete;throw 'AIQ_NATIVE_GATE_LOST'}catch{if($_.Exception.Message -cne 'OBD_INSTALL_INCOMPLETE'){throw};$case.nativeGateCode=$_.Exception.Message}
    $layout=Join-Path $work 'ActivationLayoutProbe.exe';$blocked=& $layout activation-marker;if($LASTEXITCODE -ne 0 -or $blocked -cne 'SHT_INSTALLATION_INCOMPLETE'){throw 'AIQ_HOST_GATE_LOST'};$case.hostGateCode=$blocked
   }else{$activeBytes=[IO.File]::ReadAllBytes((Join-Path $product 'owner-msi.activated.json'));[IO.File]::WriteAllBytes((Join-Path $EvidenceRoot 'interruption-committed-active.json'),$activeBytes);$case.activeReceipt=[Text.Encoding]::UTF8.GetString($activeBytes)|ConvertFrom-Json}
   $child.Dispose();$child=$null;$ownedHandle=[IntPtr]::Zero;Clear-OwnInterruption;$case.qaCleanupConfirmed=$true;$result.cases+=$case
  }
  [IO.File]::Delete($policyPath);if([Convert]::ToBase64String([IO.File]::ReadAllBytes($preparedPath)) -cne [Convert]::ToBase64String($preparedBytes)){throw 'AIQ_PREPARED_CHANGED'};$result.pass=$true
 }catch{$result.error=$_.Exception.GetBaseException().Message;throw}
 finally{
  if($child){try{if(-not $child.HasExited){[ActivationInterruptionOwnedProcess]::Terminate($ownedHandle)}}finally{$child.Dispose()}}
  [IO.File]::WriteAllText((Join-Path $EvidenceRoot 'activation-interruption-report.json'),($result|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
 }
 return $result
}
