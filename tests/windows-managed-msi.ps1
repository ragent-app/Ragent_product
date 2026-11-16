# Actual small MSI install/rollback/uninstall, disposable hosted Windows only.
# Entry payloads are SYNTHETIC NONEXECUTABLE bytes; every service stays stopped.
[CmdletBinding()]
param([switch]$PolicyAcceptance,[switch]$PolicyRemovalAcceptance,[switch]$OrdinaryCallerAcceptance,[switch]$ActivationTrialAcceptance,[switch]$ActivationAdmissionAcceptance,[switch]$ActivationTransactionAcceptance,[switch]$ActivationInterruptionAcceptance)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($ActivationInterruptionAcceptance -and (-not $ActivationTrialAcceptance -or -not $ActivationTransactionAcceptance)){throw 'MMQ_INTERRUPTION_REQUIRES_TRANSACTION'}
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'MMQ_DISPOSABLE_REQUIRED'}
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MMQ_ADMIN_REQUIRED'}
$product='C:\Program Files\Ragent';$data='C:\ProgramData\Ragent';$names=@('Ragent-ControlPlane','Ragent-RunnerSupervisor')
foreach($n in $names){if(Get-CimInstance Win32_Service -Filter "Name='$n'"){throw 'MMQ_EXISTING_SERVICE'}}
foreach($p in @($product,$data)){if(Test-Path -LiteralPath $p){throw 'MMQ_EXISTING_ROOT'}}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$pack=Join-Path $repo 'packaging\windows';$evidence=Join-Path $env:RUNNER_TEMP 'managed-msi';$null=New-Item -ItemType Directory -Path $evidence
$work=Join-Path $env:RUNNER_TEMP ('managed-msi-input-'+[Guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $work
$report=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;startedAt=(Get-Date).ToUniversalTime().ToString('o');actualMsi=$true;syntheticEntryInputs=$true;servicesActivated=$false;authorityIssued=$false;productApiStarted=$false;productionChanged=$false;operations=@();checks=@();cleanupConfirmed=$false;releaseReady=$false;migrationReady=$false}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$msi=Join-Path $work 'prepared.msi';$owned=$false
function ParentFacts {
 $a=Get-Acl -LiteralPath 'C:\ProgramData'
 @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {@{sid=$_.IdentityReference.Value;mask=[int64]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;type=[int]$_.AccessControlType}}|Sort-Object sid,mask,inheritance,propagation,type)}
}
$parentBefore=ParentFacts
function Msi([string]$name,[string]$arguments){
 $log=Join-Path $evidence ($name+'.msi.log');$p=Start-Process -FilePath 'C:\Windows\System32\msiexec.exe' -ArgumentList ($arguments+' /qn /norestart /l*v "'+$log+'"') -PassThru -WindowStyle Hidden
 try{$null=$p.Handle;if(-not $p.WaitForExit(180000)){throw 'MMQ_MSI_TIMEOUT'};$p.Refresh();if($null -eq $p.ExitCode){throw 'MMQ_MSI_EXIT_UNAVAILABLE'};$code=$p.ExitCode;$report.operations+=@{name=$name;exitCode=$code};return $code}finally{$p.Dispose()}
}
function Observe {
 $r=@();foreach($plan in @(Get-OwnerServicePreparationPlan)){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'");if(-not $s -or $s.StartName -ine $plan.account -or $s.PathName -cne $plan.command -or $s.State -cne 'Stopped' -or $s.StartMode -cne 'Disabled' -or $s.ProcessId -ne 0){throw 'MMQ_PREPARED_SERVICE_INVALID'};$r+=@{name=$s.Name;account=$s.StartName;command=$s.PathName;mode=$s.StartMode;state=$s.State;pid=$s.ProcessId}}
 return $r
}
function Clear-OwnedRoots {
 foreach($root in @($product,$data)){
  if(-not(Test-Path -LiteralPath $root)){continue}
  if([IO.Path]::GetFullPath($root) -cnotin @('C:\Program Files\Ragent','C:\ProgramData\Ragent') -or ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'MMQ_CLEANUP_ROOT_REFUSED'}
  $a=Get-Acl -LiteralPath $root;if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'MMQ_CLEANUP_OWNER_REFUSED'}
  $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($root);while($stack.Count){foreach($item in @(Get-ChildItem -LiteralPath $stack.Pop() -Force)){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MMQ_CLEANUP_REPARSE_REFUSED'};if($item.PSIsContainer){$stack.Push($item.FullName)}}}
  Remove-Item -LiteralPath $root -Recurse -Force
 }
}
try {
 . (Join-Path $pack 'prepare-owner-service-data.ps1') -LibraryOnly
 & (Join-Path $pack 'build-service-host.ps1') -OutputPath (Join-Path $work 'Ragent.ServiceHost.exe') -DevelopmentOnly
 & (Join-Path $pack 'build-managed-owner-msi-bridge.ps1') -OutputPath (Join-Path $work 'Ragent.ManagedOwnerMsiBridge.exe')
 $report.sourceFiles=@('packaging/windows/Ragent.ManagedOwner.wxs','packaging/windows/managed-owner-msi-bridge.cs','packaging/windows/owner-msi-relocation-journal.cs','packaging/windows/managed-owner-msi.ps1','packaging/windows/build-managed-owner-msi-bridge.ps1','packaging/windows/build-msi.ps1','packaging/windows/Ragent.ServiceHost.cs','packaging/windows/prepare-owner-service-data.ps1','packaging/windows/prepare-owner-services.ps1','packaging/windows/read-owner-bootstrap-discovery.ps1','tests/windows-managed-msi.ps1','tests/fixtures/windows-managed-msi-host.cs')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}
 $report.bridge=@{sha256=(Get-FileHash -LiteralPath (Join-Path $work 'Ragent.ManagedOwnerMsiBridge.exe') -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath (Join-Path $work 'Ragent.ManagedOwnerMsiBridge.exe')).Length}
 $null=New-Item -ItemType Directory -Path (Join-Path $work 'payload\chat') -Force
 foreach($path in @('node.exe','chat-server.mjs','chat\runner-supervisor-daemon.mjs')){[IO.File]::WriteAllText((Join-Path $work ('payload\'+$path)),'SYNTHETIC-NONEXECUTABLE-MSI-PREPARATION')}
 $payload=Join-Path $work 'payload.wxs';[IO.File]::WriteAllText($payload,'<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Fragment><ComponentGroup Id="PayloadGroup" Directory="RagentMachineRoot" Subdirectory="payload"><Files Include="$(var.SourceDir)\**" /></ComponentGroup></Fragment></Wix>',[Text.UTF8Encoding]::new($false))
 & wix.exe --acceptEula wix7 build -arch x64 (Join-Path $pack 'Ragent.ManagedOwner.wxs') $payload -d ProductVersion=0.0.0.1 -d ('SourceDir='+(Join-Path $work 'payload')) -bindpath ('ServiceHost='+$work) -bindpath ('ManagedBridge='+$work) -o $msi > (Join-Path $evidence 'build.log')
 if($LASTEXITCODE -ne 0){throw 'MMQ_MSI_COMPILE_FAILED'}
 $report.msi=@{sha256=(Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $msi).Length}
 if((Msi 'invalid-owner' ('/i "'+$msi+'" RAGENT_OWNER_SID=S-1-5-18')) -ne 1603 -or (Test-Path -LiteralPath $product) -or (Test-Path -LiteralPath $data)){throw 'MMQ_BAD_OWNER_MUTATED'}
 $report.checks+='invalid-owner-refused-before-files-and-services'
 $owned=$true
 if((Msi 'fresh' ('/i "'+$msi+'" RAGENT_OWNER_SID='+$owner)) -ne 0){throw 'MMQ_INSTALL_FAILED'}
 $report.services=@(Observe)
 if($ActivationTrialAcceptance){. (Join-Path $PSScriptRoot 'windows-activation-trial.ps1');$report.activationTrial=Invoke-ActivationTrialAcceptance $evidence -TransactionAcceptance:$ActivationTransactionAcceptance -InterruptionAcceptance:$ActivationInterruptionAcceptance;if(-not $report.activationTrial.pass){throw 'MMQ_ACTIVATION_TRIAL_FAILED'};$report.checks+='activation-service-trial-drain-and-quarantine'}
 if($PolicyAcceptance){$script:policyBridge=Join-Path $work 'Ragent.ManagedOwnerMsiBridge.exe';. (Join-Path $PSScriptRoot 'windows-managed-policy.ps1');$report.policyAcceptance=Invoke-PreparedPolicyAcceptance $evidence;if(-not $report.policyAcceptance.pass){throw 'MMQ_POLICY_FAILED'};$report.checks+='policy-refusals-and-effective-service-acl-primitive'}
 foreach($relative in @('config\auth-session-secret','config\auth-sessions.sqlite','config\instance-identity.json')){if(Test-Path -LiteralPath (Join-Path $data ('instances\owner\'+$relative))){throw 'MMQ_CREDENTIAL_CREATED'}}
 $receipt=Join-Path $product 'owner-msi.prepared.json';$before=[IO.File]::ReadAllBytes($receipt);$record=[Text.Encoding]::UTF8.GetString($before)|ConvertFrom-Json;if($record.phase -cne 'prepared' -or $record.ownerSid -cne $owner){throw 'MMQ_RECEIPT_FAILED'}
 $report.checks+='actual-msi-creates-only-disabled-virtual-services-and-private-data'
 & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /main:PreparedMsiHostProbe /r:System.ServiceProcess.dll /r:System.Security.dll ('/out:'+(Join-Path $work 'PreparedHostProbe.exe')) (Join-Path $pack 'Ragent.ServiceHost.cs') (Join-Path $repo 'tests\fixtures\windows-managed-msi-host.cs')
 if($LASTEXITCODE -ne 0){throw 'MMQ_HOST_PROBE_COMPILE_FAILED'}
 $blocked=& (Join-Path $work 'PreparedHostProbe.exe');if($LASTEXITCODE -ne 0 -or $blocked -cne 'SHT_PREPARED_INSTALLATION_INACTIVE'){throw 'MMQ_PREPARED_HOST_NOT_BLOCKED'}
 $report.checks+='compiled-host-layout-refuses-prepared-receipt-before-business-io'
 $sentinel=Join-Path $data 'instances\owner\workspace\qa-sentinel';[IO.File]::WriteAllText($sentinel,'SYNTHETIC-PRESERVE-DATA');$sentinelHash=(Get-FileHash -LiteralPath $sentinel).Hash
 if((Msi 'repair-refused' ('/fa "'+$msi+'"')) -ne 1603){throw 'MMQ_REPAIR_NOT_REFUSED'}
 $null=@(Observe);if((Get-FileHash -LiteralPath $sentinel).Hash -cne $sentinelHash){throw 'MMQ_REPAIR_CHANGED_DATA'}
 $report.checks+='maintenance-refused-with-data-preserved'
 Set-Service -Name 'Ragent-ControlPlane' -StartupType Manual
 if((Msi 'changed-service-refused' ('/x "'+$msi+'"')) -ne 1603){throw 'MMQ_CHANGED_SERVICE_REMOVED'}
 if(-not(Test-Path -LiteralPath (Join-Path $product 'Ragent.ServiceHost.exe'))){throw 'MMQ_CHANGED_SERVICE_FILES_REMOVED'}
 Set-Service -Name 'Ragent-ControlPlane' -StartupType Disabled;$null=@(Observe)
 $report.checks+='changed-service-uninstall-refused-before-file-removal'
 if((Msi 'uninstall' ('/x "'+$msi+'"')) -ne 0){throw 'MMQ_UNINSTALL_FAILED'}
 foreach($n in $names){if(Get-CimInstance Win32_Service -Filter "Name='$n'"){throw 'MMQ_UNINSTALL_SERVICE_REMAINS'}}
 if((Test-Path -LiteralPath (Join-Path $product 'Ragent.ServiceHost.exe')) -or -not(Test-Path -LiteralPath $receipt) -or (Get-FileHash -LiteralPath $sentinel).Hash -cne $sentinelHash){throw 'MMQ_UNINSTALL_DATA_NOT_PRESERVED'}
 $report.checks+='verified-handle-uninstall-removes-services-preserves-all-data-and-receipt'
 if((Msi 'retained-data-refused' ('/i "'+$msi+'" RAGENT_OWNER_SID='+$owner)) -ne 1603 -or (Get-FileHash -LiteralPath $sentinel).Hash -cne $sentinelHash){throw 'MMQ_RETAINED_DATA_ADOPTED'}
 $report.checks+='new-fresh-install-refuses-retained-state'
 Clear-OwnedRoots
 # Inject an actual post-prepare MSI failure: standard rollback must remove
 # created registrations while retained protected data/receipt quarantine it.
 $faultSource=Join-Path $work 'fault.wxs';$xml=[IO.File]::ReadAllText((Join-Path $pack 'Ragent.ManagedOwner.wxs')).Replace('<InstallExecuteSequence>','<CustomAction Id="QaFailure" BinaryRef="ManagedOwnerMsiBridge" ExeCommand="prepare S-1-5-18" Execute="deferred" Impersonate="no" Return="check" /><InstallExecuteSequence><Custom Action="QaFailure" After="ManagedPrepare" Condition="NOT Installed" />')
 [IO.File]::WriteAllText($faultSource,$xml,[Text.UTF8Encoding]::new($false));$fault=Join-Path $work 'fault.msi'
 & wix.exe --acceptEula wix7 build -arch x64 $faultSource $payload -d ProductVersion=0.0.0.2 -d ('SourceDir='+(Join-Path $work 'payload')) -bindpath ('ServiceHost='+$work) -bindpath ('ManagedBridge='+$work) -o $fault > (Join-Path $evidence 'fault-build.log')
 if($LASTEXITCODE -ne 0 -or (Msi 'injected-rollback' ('/i "'+$fault+'" RAGENT_OWNER_SID='+$owner)) -ne 1603){throw 'MMQ_FAILURE_INJECTION_FAILED'}
 foreach($n in $names){if(Get-CimInstance Win32_Service -Filter "Name='$n'"){throw 'MMQ_ROLLBACK_SERVICE_REMAINS'}}
 if(-not(Test-Path -LiteralPath $receipt) -or -not(Test-Path -LiteralPath $data)){throw 'MMQ_ROLLBACK_QUARANTINE_LOST'}
 $report.checks+='actual-msi-rollback-removes-new-services-retains-quarantined-data'
 if($PolicyRemovalAcceptance){Clear-OwnedRoots;. (Join-Path $PSScriptRoot 'windows-policy-removal.ps1');$report.policyRemovalAcceptance=Invoke-PolicyRemovalAcceptance $msi $owner $evidence -OrdinaryCaller:$OrdinaryCallerAcceptance -ActivationAdmission:$ActivationAdmissionAcceptance;if(-not $report.policyRemovalAcceptance.pass){throw 'MMQ_POLICY_REMOVAL_FAILED'};$report.checks+='policy-prepared-removal-and-quarantine'}
 $report.pass=$true
} catch {$report.error=$_.Exception.GetBaseException().Message;$report.pass=$false}
finally {
 try {
  # Remove only exact verified prepared handles in this admitted fresh guest,
  # including partial MSI failures. No name-only deletion or process kill.
  $s=[IO.File]::ReadAllText((Join-Path $pack 'managed-owner-msi.ps1'));$m=[regex]::Match($s,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@");if(-not ('ManagedPreparedService' -as [type])){Add-Type -TypeDefinition $m.Groups[1].Value}
  foreach($plan in @((Get-OwnerServicePreparationPlan)|Sort-Object role)) {if(Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'")){$handle=[ManagedPreparedService]::new($plan.name,$plan.command,$plan.account);try{$handle.Remove()}finally{$handle.Dispose()}}}
  $left=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($product+'\',[StringComparison]::OrdinalIgnoreCase)});if($left.Count){throw 'MMQ_UNEXPECTED_PROCESS'}
  if($owned){Clear-OwnedRoots}
  $report.cleanupConfirmed=$true
 }catch{$report.cleanupError=$_.Exception.GetBaseException().Message;$report.pass=$false}
 $report.defaultProgramDataAclUnchanged=(($parentBefore|ConvertTo-Json -Depth 6 -Compress) -ceq ((ParentFacts)|ConvertTo-Json -Depth 6 -Compress));if(-not $report.defaultProgramDataAclUnchanged){$report.pass=$false}
 $report.completedAt=(Get-Date).ToUniversalTime().ToString('o');[IO.File]::WriteAllText((Join-Path $evidence 'report.json'),($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
$report|ConvertTo-Json -Depth 10 -Compress
if(-not $report.pass){exit 1}
