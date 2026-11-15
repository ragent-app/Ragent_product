# Private primitive acceptance on owned fresh guest registrations. No signed
# helper or shipping product/HTTP health positive is substituted by the adapter.
function Invoke-ActivationTransactionAcceptance([string]$EvidenceRoot){
 if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository'){throw 'AXQ_DISPOSABLE_REQUIRED'}
 $result=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;adapterSubstituted=$true;syntheticPolicyReceipt=$true;publicPositiveSignedAcceptance=$false;businessActivated=$false;authorityIssued=$false;productHealthTested=$false;checks=@();testOnlyQuarantineCleanup=$true}
 $result.sourceFiles=@('packaging/windows/owner-service-activation-transaction.cs','packaging/windows/owner-service-activation-trial.cs','packaging/windows/check-owner-msi-activation.ps1','tests/windows-activation-transaction.ps1')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}
 if(-not ('OwnerServiceActivationTransaction' -as [type])){throw 'AXQ_NATIVE_TYPES_REQUIRED'}
 $product='C:\Program Files\Ragent';$root='C:\ProgramData\Ragent\instances\owner';$instance='inst_'+('d'*32);$preparedPath=Join-Path $product 'owner-msi.prepared.json';$policyPath=Join-Path $product 'owner-msi.policy.json';$preparedBytes=[IO.File]::ReadAllBytes($preparedPath);$policyBytes=[Text.Encoding]::UTF8.GetBytes('{"purpose":"explicit-qa-synthetic-policy-receipt"}');$failPath=Join-Path $root 'workspace\activation-control-fail-before'
 $tx=$null;$leases=$null;$files=@('owner-msi.activated.json','owner-msi.activation-health.json','owner-msi.prepared.activated.json','owner-msi.policy.activated.json','owner-activation.prepare-lock','owner-activation.committed-lock')
 function Begin-OwnTransaction {
  $script:axLeases=Open-Trials
  return [OwnerServiceActivationTransaction]::new($instance,$preparedBytes,$policyBytes,$script:axLeases.supervisor,$script:axLeases.control)
 }
 function MetadataFacts {
  @($files|ForEach-Object {$p=Join-Path $product $_;@{name=$_;exists=(Test-Path -LiteralPath $p);sha256=$(if(Test-Path -LiteralPath $p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}else{''})}})
 }
 function Clear-OwnTransaction {
  # Explicit QA recovery only, after independently checking the exact adapter
  # executable is absent and both owned services are stopped/PID0/exact commands.
  $left=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -ceq $probe});if($left.Count){throw 'AXQ_PROCESS_NOT_DRAINED'}
  foreach($plan in $plans){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'");if($s.PathName -cne (TrialCommand $plan) -or $s.StartName -ine $plan.account -or $s.State -cne 'Stopped' -or $s.ProcessId -ne 0){throw 'AXQ_CLEANUP_STATE'};Set-Service $plan.name -StartupType Disabled}
  [IO.File]::WriteAllBytes($preparedPath,$preparedBytes);[IO.File]::WriteAllBytes($policyPath,$policyBytes)
  foreach($name in $files){$p=Join-Path $product $name;if(Test-Path -LiteralPath $p){[IO.File]::Delete($p)}}
 }
 try {
  foreach($name in $files){if(Test-Path -LiteralPath (Join-Path $product $name)){throw 'AXQ_EXISTING_TRANSACTION'}};if(Test-Path -LiteralPath $policyPath){throw 'AXQ_EXISTING_POLICY'};[IO.File]::WriteAllBytes($policyPath,$policyBytes);Clear-OwnTransaction;$result.initialUnknownTrialQaCleanup=$true
  $tx=Begin-OwnTransaction;$leases=$script:axLeases;$tx.Begin();$tx.Prepare();[IO.File]::WriteAllText($policyPath,'OWN-QA-CHANGED-RECEIPT')
  try{$tx.CommitConfiguration();throw 'AXQ_CHANGED_RECEIPT_COMMITTED'}catch{$result.precommitCode=$_.Exception.GetBaseException().Message;if($result.precommitCode -cne 'OAX_RECEIPT_CHANGED'){throw}}
  $result.precommitCommitted=$tx.ConfigurationCommitted;$result.precommitQuarantine=$tx.Quarantine();$result.precommitServices=@(TrialFacts);$result.precommitMetadata=@(MetadataFacts)
  try{$other=[OwnerServiceActivationTransaction]::new($instance,$preparedBytes,$policyBytes,$leases.supervisor,$leases.control);$other.Dispose();throw 'AXQ_INTERRUPTED_ADOPTED'}catch{$result.repeatCode=$_.Exception.GetBaseException().Message;if($result.repeatCode -cne 'OAX_EXISTING_TRANSACTION_REFUSED'){throw}}
  $tx.Dispose();$tx=$null;foreach($v in $leases.Values){$v.Dispose()};$leases=$null;Clear-OwnTransaction
  $result.checks+='precommit-receipt-drift-refuses-keeps-marker-and-restores-disabled-without-starting'
  $tx=Begin-OwnTransaction;$leases=$script:axLeases;$tx.Begin();$tx.Prepare();$result.beforeCommit=@(TrialFacts);$tx.CommitConfiguration();$result.configurationCommitted=$tx.ConfigurationCommitted;$result.afterCommit=@(TrialFacts);$result.committedMetadata=@(MetadataFacts);$result.activeReceipt=[IO.File]::ReadAllText((Join-Path $product 'owner-msi.activated.json'))|ConvertFrom-Json
  $tx.Start();$result.successProbes=@(Read-TrialProbes $leases 'none');$result.running=@(TrialFacts);$tx.ConfirmHealth();$result.runningReceipt=[IO.File]::ReadAllText((Join-Path $product 'owner-msi.activation-health.json'))|ConvertFrom-Json
  $result.successCleanupQuarantine=$tx.Quarantine();$tx.Dispose();$tx=$null;foreach($v in $leases.Values){$v.Dispose()};$leases=$null;Clear-OwnTransaction
  $result.checks+='configuration-commit-archives-exact-receipts-before-two-automatic-service-starts-and-records-running-only'
  [IO.File]::WriteAllText($failPath,'OWN-QA-PRE-RUNNING-FAILURE');$tx=Begin-OwnTransaction;$leases=$script:axLeases;$tx.Begin();$tx.Prepare();$tx.CommitConfiguration()
  try{$tx.Start();throw 'AXQ_FAILURE_ACCEPTED'}catch{$result.postcommitCode=$_.Exception.GetBaseException().Message;if($result.postcommitCode -cnotin @('OAT_STOPPED_BEFORE_RUNNING','OAT_START_REFUSED')){throw}}
  $result.postcommitCommitted=$tx.ConfigurationCommitted;$result.postcommitQuarantine=$tx.Quarantine();$result.faultProbes=@(Read-TrialProbes $leases 'before-running');$result.faultServices=@(TrialFacts);$result.faultMetadata=@(MetadataFacts)
  if($result.postcommitQuarantine -cne 'drain-unconfirmed'){throw 'AXQ_UNCONFIRMED_FAILURE_ADOPTED'}
  $tx.Dispose();$tx=$null;foreach($v in $leases.Values){$v.Dispose()};$leases=$null;[IO.File]::Delete($failPath);Clear-OwnTransaction
  $result.checks+='postcommit-start-failure-recreates-quarantine-preserves-archives-and-refuses-unknown-process-recovery'
  if([Convert]::ToBase64String([IO.File]::ReadAllBytes($preparedPath)) -cne [Convert]::ToBase64String($preparedBytes)){throw 'AXQ_PREPARED_CHANGED'};[IO.File]::Delete($policyPath);$result.pass=$true
 }catch{$result.error=$_.Exception.GetBaseException().Message;throw}
 finally{if($tx){try{$null=$tx.Quarantine()}finally{$tx.Dispose()}};if($leases){foreach($v in $leases.Values){$v.Dispose()}};[IO.File]::WriteAllText((Join-Path $EvidenceRoot 'activation-transaction-report.json'),($result|ConvertTo-Json -Depth 9),[Text.UTF8Encoding]::new($false))}
 return $result
}
