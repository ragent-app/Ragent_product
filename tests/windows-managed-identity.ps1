# Real diagnostic MSI + real one-shot initialization, admitted disposable guest.
# Normal product entries remain synthetic nonexecuting bytes; no API/Provider.
[CmdletBinding()]param()
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'MIQ_DISPOSABLE_REQUIRED'}
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MIQ_ADMIN_REQUIRED'}
$product='C:\Program Files\Ragent';$data='C:\ProgramData\Ragent';$names=@('Ragent-ControlPlane','Ragent-RunnerSupervisor')
foreach($n in $names){if(Get-CimInstance Win32_Service -Filter "Name='$n'"){throw 'MIQ_EXISTING_SERVICE'}}
foreach($p in @($product,$data)){if(Test-Path -LiteralPath $p){throw 'MIQ_EXISTING_ROOT'}}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$pack=Join-Path $repo 'packaging\windows';$evidence=Join-Path $env:RUNNER_TEMP 'managed-identity';$null=New-Item -ItemType Directory -Path $evidence
$work=Join-Path $env:RUNNER_TEMP ('managed-identity-input-'+[Guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $work
$report=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;startedAt=(Get-Date).ToUniversalTime().ToString('o');actualMsi=$true;actualIdentityEntry=$true;normalEntriesSynthetic=$true;businessServicesActivated=$false;authorityIssued=$false;productApiStarted=$false;productionChanged=$false;operations=@();checks=@();cleanupConfirmed=$false;releaseReady=$false;migrationReady=$false}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$msi=Join-Path $work 'identity.msi';$owned=$false;$installed=$false;$eventOwned=$false
$config=Join-Path $data 'instances\owner\config';$receipt=Join-Path $product 'owner-msi.prepared.json';$outerLock=Join-Path $product 'owner-identity.initialize-lock'
function ParentFacts {$a=Get-Acl -LiteralPath 'C:\ProgramData';@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {@{sid=$_.IdentityReference.Value;mask=[int64]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;type=[int]$_.AccessControlType}}|Sort-Object sid,mask,inheritance,propagation,type)}}
$parentBefore=ParentFacts
function Msi([string]$name,[string]$arguments){$p=Start-Process -FilePath 'C:\Windows\System32\msiexec.exe' -ArgumentList ($arguments+' /qn /norestart /l*v "'+(Join-Path $evidence ($name+'.msi.log'))+'"') -PassThru -WindowStyle Hidden;try{$null=$p.Handle;if(-not $p.WaitForExit(180000)){throw 'MIQ_MSI_TIMEOUT'};$p.Refresh();if($null -eq $p.ExitCode){throw 'MIQ_NO_MSI_EXIT'};$report.operations+=@{name=$name;exitCode=$p.ExitCode};if($p.ExitCode -ne 0){throw 'MIQ_MSI_FAILED'}}finally{$p.Dispose()}}
function Observe {
 $rows=@();foreach($p in @(Get-OwnerServicePreparationPlan)){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$p.name+"'");if(-not $s -or $s.PathName -cne $p.command -or $s.StartName -ine $p.account -or $s.State -cne 'Stopped' -or $s.StartMode -cne 'Disabled' -or $s.ProcessId -ne 0){throw 'MIQ_SERVICE_CHANGED'};$rows+=@{name=$s.Name;account=$s.StartName;command=$s.PathName;mode=$s.StartMode;state=$s.State;pid=$s.ProcessId}}
 $deps=@((Get-Service 'Ragent-ControlPlane').RequiredServices.Name);if($deps.Count -ne 1 -or $deps[0] -cne 'Ragent-RunnerSupervisor'){throw 'MIQ_DEPENDENCY_NOT_RESTORED'}
 return $rows
}
function Initialize([string]$label){$out=& (Join-Path $work 'Ragent.ManagedOwnerMsiBridge.exe') initialize 2> (Join-Path $evidence ($label+'.stderr'));$code=$LASTEXITCODE;$text=$out|Out-String;$result=@{exitCode=$code;result=($text|ConvertFrom-Json)};[IO.File]::WriteAllText((Join-Path $evidence ($label+'.json')),($result|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false));return $result}
function ConfirmNoBusiness {
 foreach($name in @('auth-session-secret','auth-sessions.sqlite')){if(Test-Path -LiteralPath (Join-Path $config $name)){throw 'MIQ_BUSINESS_STATE_CREATED'}}
 if(Get-NetTCPConnection -State Listen -LocalPort 7690 -ErrorAction SilentlyContinue){throw 'MIQ_PRODUCT_LISTENER_STARTED'}
 if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($product+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'MIQ_PROCESS_REMAINS'}
 $report.authStateAbsent=$true;$report.noProductListenerObserved=$true;$report.noOwnedProcessAfterInitialization=$true
}
function ClearOwnedRoots {
 foreach($root in @($product,$data)){
  if(-not(Test-Path -LiteralPath $root)){continue}
  if([IO.Path]::GetFullPath($root) -cnotin @('C:\Program Files\Ragent','C:\ProgramData\Ragent') -or ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'MIQ_CLEANUP_ROOT_REFUSED'}
  $a=Get-Acl -LiteralPath $root;if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'MIQ_CLEANUP_OWNER_REFUSED'}
  $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($root);while($stack.Count){foreach($item in @(Get-ChildItem -LiteralPath $stack.Pop() -Force)){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MIQ_CLEANUP_REPARSE_REFUSED'};if($item.PSIsContainer){$stack.Push($item.FullName)}}}
  Remove-Item -LiteralPath $root -Recurse -Force
 }
}
try {
 . (Join-Path $pack 'managed-owner-msi.ps1') -LibraryOnly
 & (Join-Path $pack 'build-service-host.ps1') -OutputPath (Join-Path $work 'Ragent.ServiceHost.exe') -DevelopmentOnly
 & (Join-Path $pack 'build-managed-owner-msi-bridge.ps1') -OutputPath (Join-Path $work 'Ragent.ManagedOwnerMsiBridge.exe')
 $paths=@('packaging/windows/Ragent.ServiceHost.cs','packaging/windows/Ragent.ManagedOwner.wxs','packaging/windows/managed-owner-msi.ps1','packaging/windows/managed-owner-msi-bridge.cs','packaging/windows/owner-msi-relocation-journal.cs','packaging/windows/build-managed-owner-msi-bridge.ps1','packaging/windows/initialize-owner-service-identity.ps1','packaging/windows/prepare-owner-services.ps1','packaging/windows/prepare-owner-service-data.ps1','packaging/windows/read-owner-bootstrap-discovery.ps1','lib/instance-identity.mjs','lib/instance-proof-protocol.mjs','scripts/initialize-windows-owner-identity.mjs','tests/windows-managed-identity.ps1','tests/fixtures/windows-owner-identity-read.mjs','tests/fixtures/windows-managed-msi-host.cs')
 $report.sourceFiles=@($paths|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}})
 $payload=Join-Path $work 'payload';$null=New-Item -ItemType Directory -Path $payload
 $sourceNode=(Get-Command node.exe).Source;if((& $sourceNode --version) -cne 'v24.12.0'){throw 'MIQ_NODE_VERSION'}
 if((Get-FileHash -LiteralPath $sourceNode -Algorithm SHA256).Hash.ToLowerInvariant() -cne '2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8'){throw 'MIQ_NODE_DIGEST'}
 Copy-Item -LiteralPath $sourceNode -Destination (Join-Path $payload 'node.exe')
 foreach($file in @('lib/instance-identity.mjs','lib/instance-proof-protocol.mjs','scripts/initialize-windows-owner-identity.mjs')){$dst=Join-Path $payload $file;$null=New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($dst));Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $dst}
 $null=New-Item -ItemType Directory -Path (Join-Path $payload 'chat');[IO.File]::WriteAllText((Join-Path $payload 'chat-server.mjs'),'SYNTHETIC NONEXECUTABLE');[IO.File]::WriteAllText((Join-Path $payload 'chat\runner-supervisor-daemon.mjs'),'SYNTHETIC NONEXECUTABLE')
 $components=Join-Path $work 'payload.wxs';[IO.File]::WriteAllText($components,'<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Fragment><ComponentGroup Id="PayloadGroup" Directory="INSTALLFOLDER" Subdirectory="payload"><Files Include="$(var.SourceDir)\**" /></ComponentGroup></Fragment></Wix>',[Text.UTF8Encoding]::new($false))
 & wix.exe --acceptEula wix7 build -arch x64 (Join-Path $pack 'Ragent.ManagedOwner.wxs') $components -d ProductVersion=0.0.0.3 -d ('SourceDir='+$payload) -bindpath ('ServiceHost='+$work) -bindpath ('ManagedBridge='+$work) -o $msi > (Join-Path $evidence 'build.log');if($LASTEXITCODE -ne 0){throw 'MIQ_BUILD_FAILED'}
 $report.msi=@{bytes=(Get-Item -LiteralPath $msi).Length;sha256=(Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()};$report.nodeSha256=(Get-FileHash -LiteralPath (Join-Path $payload 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
 [Diagnostics.EventLog]::CreateEventSource('Ragent','Application');$eventOwned=$true
 Msi 'fresh' ('/i "'+$msi+'" RAGENT_OWNER_SID='+$owner);$owned=$true;$installed=$true;$report.before=Observe
 $canary=Join-Path $config 'instance-identity.json';[IO.File]::WriteAllText($canary,'QA OWNED EXISTING STATE')
 $refused=Initialize 'existing';if($refused.exitCode -ne 1 -or $refused.result.code -cne 'OII_EXISTING_STATE_REFUSED' -or [IO.File]::ReadAllText($canary) -cne 'QA OWNED EXISTING STATE' -or (Test-Path -LiteralPath $outerLock)){throw 'MIQ_EXISTING_STATE_NOT_REFUSED'};[IO.File]::Delete($canary);$report.checks+='existing-private-state-refused-without-mutation'
 $report.initialization=Initialize 'fresh-initialize';if($report.initialization.exitCode -ne 0 -or -not $report.initialization.result.identityInitialized){$report.initializationState=@{identityPresent=(Test-Path -LiteralPath (Join-Path $config 'instance-identity.json'));resultPresent=(Test-Path -LiteralPath (Join-Path $config 'owner-identity.result.json'))};throw 'MIQ_INITIALIZATION_FAILED'}
 $report.after=Observe;ConfirmNoBusiness
 $identity=Join-Path $config 'instance-identity.json';$beforeHash=(Get-FileHash -LiteralPath $identity -Algorithm SHA256).Hash.ToLowerInvariant()
 $public=& (Join-Path $product 'payload\node.exe') (Join-Path $repo 'tests\fixtures\windows-owner-identity-read.mjs') (Join-Path $product 'payload\lib\instance-identity.mjs') $identity;if($LASTEXITCODE -ne 0){throw 'MIQ_CRYPTO_CHECK_FAILED'};$report.publicIdentity=($public|Out-String)|ConvertFrom-Json
 if($report.publicIdentity.instanceId -cne $report.initialization.result.instanceId -or (Test-Path -LiteralPath $outerLock) -or -not (Test-Path -LiteralPath $receipt)){throw 'MIQ_RECEIPT_STATE_INVALID'}
 $report.checks+='actual-reduced-control-service-and-node-create-valid-durable-identity-only'
 & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /main:PreparedMsiHostProbe /r:System.ServiceProcess.dll ('/out:'+(Join-Path $work 'HostProbe.exe')) (Join-Path $pack 'Ragent.ServiceHost.cs') (Join-Path $repo 'tests\fixtures\windows-managed-msi-host.cs')|Out-Null;if($LASTEXITCODE -ne 0){throw 'MIQ_PROBE_COMPILE'}
 $null=& (Join-Path $work 'HostProbe.exe');if($LASTEXITCODE -ne 0){throw 'MIQ_PREPARED_GATE_LOST'};$report.checks+='prepared-receipt-still-blocks-normal-host-and-native-policy'
 try{Assert-OwnerPolicyInstallComplete;throw 'MIQ_NATIVE_INSPECTION_ALLOWED'}catch{if($_.Exception.Message -notmatch '^OBD_'){throw}}
 $again=Initialize 'repeat';if($again.exitCode -ne 1 -or $again.result.code -cne 'OII_EXISTING_STATE_REFUSED' -or (Get-FileHash -LiteralPath $identity -Algorithm SHA256).Hash.ToLowerInvariant() -cne $beforeHash){throw 'MIQ_REPEATED_IDENTITY_CHANGED'};$report.identityPreservedAfterRepeat=$true;$report.checks+='repeat-refused-identity-preserved-and-services-disabled'
 Msi 'uninstall' ('/x "'+$msi+'"');$installed=$false;if((Get-FileHash -LiteralPath $identity -Algorithm SHA256).Hash.ToLowerInvariant() -cne $beforeHash -or -not (Test-Path -LiteralPath $receipt)){throw 'MIQ_UNINSTALL_IDENTITY_LOST'};$report.identityPreservedAfterUninstall=$true;$report.checks+='actual-msi-uninstall-preserves-initialized-identity-and-prepared-receipt';ClearOwnedRoots
 Msi 'fault-fresh' ('/i "'+$msi+'" RAGENT_OWNER_SID='+$owner);$installed=$true
 $entry=Join-Path $product 'payload\scripts\initialize-windows-owner-identity.mjs';$original=[IO.File]::ReadAllBytes($entry);[IO.File]::WriteAllText($entry,"throw new Error('QA_INJECTED_INITIALIZATION_FAILURE');")
 $report.faultOverride=@{qaOnly=$true;sha256=(Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()};$fault=Initialize 'fault';$report.fault=$fault
 if($fault.exitCode -ne 1 -or -not (Test-Path -LiteralPath $outerLock) -or (Test-Path -LiteralPath (Join-Path $config 'instance-identity.json'))){throw 'MIQ_FAULT_NOT_QUARANTINED'}
 $report.faultServices=Observe;ConfirmNoBusiness;$report.checks+='actual-child-failure-restores-disabled-services-and-retains-quarantine'
 # Windows PowerShell turns native stderr into a terminating ErrorRecord under
 # Stop. Observe the expected refusal through actual process handles instead.
 $probe=Start-Process -FilePath (Join-Path $work 'Ragent.ManagedOwnerMsiBridge.exe') -ArgumentList 'remove-check' -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $evidence 'quarantine-removal.stdout') -RedirectStandardError (Join-Path $evidence 'quarantine-removal.stderr')
 try{$null=$probe.Handle;if(-not $probe.WaitForExit(15000)){throw 'MIQ_QUARANTINE_PROBE_TIMEOUT'};$probe.Refresh();if($probe.ExitCode -ne 1 -or [IO.File]::ReadAllText((Join-Path $evidence 'quarantine-removal.stderr')).Trim() -cne 'OMI_PREPARATION_INCOMPLETE'){throw 'MIQ_QUARANTINE_REMOVAL_ALLOWED'}}finally{$probe.Dispose()};$report.checks+='pending-initialization-refuses-removal'
 [IO.File]::WriteAllBytes($entry,$original);$report.pass=$true
}catch{$report.error=$_.Exception.GetBaseException().Message;$report.pass=$false}
finally {
 $report.startupEvents=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Ragent';Id=1004} -MaxEvents 5 -ErrorAction SilentlyContinue|ForEach-Object {@{id=$_.Id;message=$_.Message}})
 try{
  ConfirmNoBusiness
  # Disposal-only fixture cleanup: reclaim this exact test-created marker after
  # all processes stop. Product code has no equivalent recovery/adoption path.
  if($owned -and (Test-Path -LiteralPath $outerLock)){if([IO.File]::ReadAllText($outerLock) -cne "ragent-owner-identity-initialization-v1`n"){throw 'MIQ_UNKNOWN_QUARANTINE'};[IO.File]::Delete($outerLock);$report.testOnlyQuarantineCleanup=$true}
  if($installed){$null=Observe;Msi 'cleanup-uninstall' ('/x "'+$msi+'"');$installed=$false}
  foreach($n in $names){if(Get-CimInstance Win32_Service -Filter "Name='$n'"){throw 'MIQ_SERVICE_REMAINS'}}
  if($owned){ClearOwnedRoots};if($eventOwned){[Diagnostics.EventLog]::DeleteEventSource('Ragent')};$report.cleanupConfirmed=$true
 }catch{$report.cleanupError=$_.Exception.GetBaseException().Message;$report.pass=$false}
 $report.defaultProgramDataAclUnchanged=(($parentBefore|ConvertTo-Json -Depth 6 -Compress) -ceq ((ParentFacts)|ConvertTo-Json -Depth 6 -Compress));if(-not $report.defaultProgramDataAclUnchanged){$report.pass=$false}
 $report.completedAt=(Get-Date).ToUniversalTime().ToString('o');[IO.File]::WriteAllText((Join-Path $evidence 'report.json'),($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
$report|ConvertTo-Json -Depth 10 -Compress
if(-not $report.pass){exit 1}
# The last expected native refusal leaves LASTEXITCODE=1. The CI PowerShell
# wrapper propagates it unless the fully checked successful suite exits itself.
exit 0
