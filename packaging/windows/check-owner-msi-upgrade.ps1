# Read-only admission for a major upgrade of an already active virtual-account
# Owner profile. Never opens identity, secret, SQLite, provider or Run contents.
[CmdletBinding()]
param([switch]$LibraryOnly)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$upgradeLibraryOnly=$LibraryOnly.IsPresent
. (Join-Path $PSScriptRoot 'managed-owner-msi.ps1') -LibraryOnly
. (Join-Path $PSScriptRoot 'prepare-owner-service-data.ps1') -LibraryOnly
. (Join-Path $PSScriptRoot 'prepare-owner-install-policy.ps1') -LibraryOnly
$pins=[Collections.Generic.List[IDisposable]]::new();$product=Get-OwnerProductRoot
function Initialize-OwnerUpgradeTokenReader {
 if('RagentOwnerUpgradeTokenReader' -as [type]){return}
 Add-Type -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Security.Principal;
public sealed class RagentOwnerUpgradeTokenFacts {public string userSid;public int integrityRid,sessionId;public bool elevated,enabledAdministrators;public string[] privileges;}
public sealed class RagentOwnerBrokerFacts {public string account,binary;public int state,startType,serviceType;}
public static class RagentOwnerUpgradeTokenReader {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct ServiceConfig {public int serviceType,startType,errorControl;public IntPtr binary,group;public int tag;public IntPtr dependencies,account,displayName;}
 [StructLayout(LayoutKind.Sequential)]struct ServiceStatus {public int serviceType,state,controlsAccepted,win32ExitCode,serviceSpecificExitCode,checkPoint,waitHint,processId,flags;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenSCManager(string machine,string database,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool CloseServiceHandle(IntPtr handle);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryServiceConfig(IntPtr service,IntPtr buffer,int size,out int needed);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool QueryServiceStatusEx(IntPtr service,int level,out ServiceStatus status,int size,out int needed);
 public static RagentOwnerBrokerFacts ReadBroker(string name){
  IntPtr manager=OpenSCManager(null,null,1);Need(manager!=IntPtr.Zero);try{IntPtr service=OpenService(manager,name,5);Need(service!=IntPtr.Zero);try{
   int needed;QueryServiceConfig(service,IntPtr.Zero,0,out needed);Need(needed>0&&needed<=65536);IntPtr buffer=Marshal.AllocHGlobal(needed);try{
    Need(QueryServiceConfig(service,buffer,needed,out needed));var c=(ServiceConfig)Marshal.PtrToStructure(buffer,typeof(ServiceConfig));ServiceStatus s;Need(QueryServiceStatusEx(service,0,out s,Marshal.SizeOf(typeof(ServiceStatus)),out needed));
    return new RagentOwnerBrokerFacts{account=Marshal.PtrToStringUni(c.account),binary=Marshal.PtrToStringUni(c.binary),state=s.state,startType=c.startType,serviceType=c.serviceType};
   }finally{Marshal.FreeHGlobal(buffer);}
  }finally{CloseServiceHandle(service);}}finally{CloseServiceHandle(manager);}
 }
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int size,out int needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool LookupPrivilegeName(string system,IntPtr luid,StringBuilder name,ref int size);
 static void Need(bool value){if(!value)throw new InvalidOperationException("OUG_TOKEN_QUERY_REFUSED");}
 static IntPtr Info(IntPtr token,int kind){int size;GetTokenInformation(token,kind,IntPtr.Zero,0,out size);Need(size>0&&size<=65536);IntPtr data=Marshal.AllocHGlobal(size);if(!GetTokenInformation(token,kind,data,size,out size)){Marshal.FreeHGlobal(data);throw new InvalidOperationException("OUG_TOKEN_QUERY_REFUSED");}return data;}
 public static RagentOwnerUpgradeTokenFacts Read(int pid){IntPtr process=OpenProcess(0x1000,false,pid);Need(process!=IntPtr.Zero);try{IntPtr token;Need(OpenProcessToken(process,8,out token));try{
  var f=new RagentOwnerUpgradeTokenFacts();IntPtr d=Info(token,1);try{f.userSid=new SecurityIdentifier(Marshal.ReadIntPtr(d)).Value;}finally{Marshal.FreeHGlobal(d);}
  d=Info(token,25);try{string sid=new SecurityIdentifier(Marshal.ReadIntPtr(d)).Value;f.integrityRid=Int32.Parse(sid.Substring(sid.LastIndexOf('-')+1));}finally{Marshal.FreeHGlobal(d);}
  d=Info(token,12);try{f.sessionId=Marshal.ReadInt32(d);}finally{Marshal.FreeHGlobal(d);}
  d=Info(token,20);try{f.elevated=Marshal.ReadInt32(d)!=0;}finally{Marshal.FreeHGlobal(d);}
  d=Info(token,2);try{int count=Marshal.ReadInt32(d),offset=IntPtr.Size==8?8:4,stride=IntPtr.Size==8?16:8;Need(count>=0&&count<=1024);for(int i=0;i<count;i++){IntPtr row=IntPtr.Add(d,offset+i*stride);int attributes=Marshal.ReadInt32(row,IntPtr.Size);if((attributes&4)!=0&&(attributes&16)==0&&new SecurityIdentifier(Marshal.ReadIntPtr(row)).Value=="S-1-5-32-544")f.enabledAdministrators=true;}}finally{Marshal.FreeHGlobal(d);}
  d=Info(token,3);try{int count=Marshal.ReadInt32(d);Need(count>=0&&count<=256);var names=new List<string>();for(int i=0;i<count;i++){int length=256;var name=new StringBuilder(length);Need(LookupPrivilegeName(null,IntPtr.Add(d,4+i*12),name,ref length));names.Add(name.ToString());}f.privileges=names.ToArray();}finally{Marshal.FreeHGlobal(d);}return f;
 }finally{CloseHandle(token);}}finally{CloseHandle(process);}}
}
'@
}
function Assert-UpgradePath([string]$Path,[bool]$Directory,[string]$InstallRoot){
 $full=[IO.Path]::GetFullPath($Path);$chain=[Collections.Generic.List[string]]::new()
 for($cursor=$full;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){$chain.Add($cursor)};$chain.Reverse()
 foreach($cursor in $chain){
  $attributes=[IO.File]::GetAttributes($cursor)
  if(($attributes -band [IO.FileAttributes]::ReparsePoint) -or ($cursor -cne $full -and -not ($attributes -band [IO.FileAttributes]::Directory))){throw 'OUG_SOURCE_PATH_UNSAFE'}
  $dataRoot=[IO.Path]::GetFullPath((Get-OwnerDataRoot)).TrimEnd('\')
  if($InstallRoot -and -not ($full -ieq $dataRoot -or $full.StartsWith($dataRoot+'\',[StringComparison]::OrdinalIgnoreCase)) -and [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\').StartsWith([IO.Path]::GetFullPath($cursor).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){continue}
  $acl=Get-OwnerPathAcl -Path $cursor
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($cursor -ceq $full -and $owner -notin (Get-OwnerAdministrativeSids)){throw 'OUG_SOURCE_OWNER_REFUSED'}
  $mask=if($cursor -ceq $full -and -not $Directory){0x500d0156L}else{0x500d0152L}
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and $rule.IdentityReference.Value -notin (Get-OwnerAdministrativeSids) -and ([int64]$rule.FileSystemRights -band $mask)){throw 'OUG_SOURCE_WRITABLE_BY_NONADMIN'}
  }
 }
 if($Directory){$pins.Add([RagentOwnerFilePin]::Directory($full))}else{$stream=[IO.FileStream]::new($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[RagentOwnerFilePin]::Verify($stream.SafeFileHandle,$full,$false);$pins.Add($stream)}catch{$stream.Dispose();throw}}
}
function Assert-UpgradeDataFile([string]$Path,[string[]]$Allowed){
 $attributes=[IO.File]::GetAttributes($Path);if(($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'OUG_STATE_FILE_INVALID'}
 Assert-OwnerObjectAcl $Path $Allowed
}
function New-LegacyOwnerMetadataAcl([string]$ControlSid,[string]$ExecutorSid){
 $legacy=@{};$legacy[$ControlSid]='ReadAndExecute';$legacy[$ExecutorSid]='ReadAndExecute'
 return New-OwnerDataAcl $legacy $true
}
function Read-UpgradeReceipt([string]$Name,[int]$Maximum=8192){
 $path=Join-Path $product $Name
 try{$bytes=Read-OwnerPinnedFile $path @(Get-OwnerAdministrativeSids) $pins $Maximum;$value=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json}
 catch{throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 return @{bytes=$bytes;value=$value}
}
function Get-OwnerPathAcl([string]$Path){
 if([string]::IsNullOrWhiteSpace($Path)){throw 'OUG_ACL_PATH_REQUIRED'}
 return Get-Acl -LiteralPath $Path -ErrorAction Stop
}
function Assert-OwnerUpgradeAdmissionReceipts($Policy,[byte[]]$PolicyBytes,$Prepared,[byte[]]$PreparedBytes,$PolicyReceipt,[byte[]]$PolicyReceiptBytes,$Active,$Health,$Marker){
 Assert-OwnerInstallPolicy $Policy
 if($null -eq $Prepared -or $null -eq $PolicyReceipt -or $null -eq $Active -or $null -eq $Health -or $null -eq $Marker){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 if(@($Prepared.PSObject.Properties).Count -ne 4 -or -not (Test-OwnerJsonInteger $Prepared.version 1 1) -or $Prepared.purpose -cne 'owner-msi-preparation' -or $Prepared.phase -cne 'prepared' -or $Prepared.ownerSid -cne $Policy.ownerSid){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 $policyKeyNames=@($PolicyReceipt.PSObject.Properties|ForEach-Object {$_.Name});$hasIdentityHash=$policyKeyNames -contains 'identitySha256';$hasIdentityReuse=$policyKeyNames -contains 'identityReused';$trustKey=if(Test-OwnerJsonInteger $PolicyReceipt.version 2 2){'trustMode'}else{'publisherSha256'}
 if(@($policyKeyNames).Count -ne 9 -or -not (Test-OwnerJsonInteger $PolicyReceipt.version 1 2) -or $PolicyReceipt.purpose -cne 'owner-msi-policy-preparation' -or $PolicyReceipt.phase -cne 'policy-prepared' -or $PolicyReceipt.instanceId -cnotmatch '\Ainst_[a-f0-9]{32}\z' -or $PolicyReceipt.policySha256 -cne (Get-OwnerDigest $PolicyBytes) -or $hasIdentityHash -eq $hasIdentityReuse){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 foreach($name in @('policySha256','releaseSha256','helperSha256')){if($PolicyReceipt.$name -isnot [string] -or $PolicyReceipt.$name -cnotmatch '\A[a-f0-9]{64}\z'){throw 'OUG_ACTIVE_RECEIPT_INVALID'}}
 if($PolicyReceipt.$trustKey -isnot [string] -or ($PolicyReceipt.version -eq 1 -and $PolicyReceipt.publisherSha256 -cnotmatch '\A[a-f0-9]{64}\z') -or ($PolicyReceipt.version -eq 2 -and $PolicyReceipt.trustMode -cne 'admin-installed-sha256') -or ($hasIdentityHash -and $PolicyReceipt.identitySha256 -cnotmatch '\A[a-f0-9]{64}\z') -or ($hasIdentityReuse -and $PolicyReceipt.identityReused -cne 'preserved-existing')){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 if(@($Active.PSObject.Properties).Count -ne 8 -or -not (Test-OwnerJsonInteger $Active.version 1 1) -or $Active.purpose -cne 'owner-service-activation' -or $Active.phase -cne 'configuration-committed' -or $Active.instanceId -cne $PolicyReceipt.instanceId -or $Active.healthConfirmed -isnot [bool] -or $Active.healthConfirmed -ne $false -or $Active.preparedSha256 -cne (Get-OwnerDigest $PreparedBytes) -or $Active.policyReceiptSha256 -cne (Get-OwnerDigest $PolicyReceiptBytes)){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 foreach($name in @('preparedSha256','policyReceiptSha256')){if($Active.$name -isnot [string] -or $Active.$name -cnotmatch '\A[a-f0-9]{64}\z'){throw 'OUG_ACTIVE_RECEIPT_INVALID'}}
 if(-not (Test-OwnerJsonRoundtripTimestamp $Active.committedAt)){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 if(@($Health.PSObject.Properties).Count -ne 7 -or -not (Test-OwnerJsonInteger $Health.version 1 1) -or $Health.purpose -cne 'owner-service-activation-health' -or $Health.instanceId -cne $Active.instanceId -or $Health.observation -cne 'service-processes-running' -or -not (Test-OwnerJsonInteger $Health.supervisorPid 1) -or -not (Test-OwnerJsonInteger $Health.controlPid 1)){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 if(-not (Test-OwnerJsonRoundtripTimestamp $Health.observedAt)){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
 if(@($Marker.PSObject.Properties).Count -ne 5 -or -not (Test-OwnerJsonInteger $Marker.version 1 1) -or $Marker.purpose -cne 'owner-service-activation' -or $Marker.instanceId -cne $Active.instanceId -or $Marker.preparedSha256 -cne $Active.preparedSha256 -or $Marker.policyReceiptSha256 -cne $Active.policyReceiptSha256){throw 'OUG_ACTIVE_RECEIPT_INVALID'}
}
function Invoke-OwnerUpgradeAdmission {
 $script:upgradeStage='install-state'
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OUG_ADMIN_REQUIRED'}
 if(-not (Test-OwnerServicePreparationPresence $product) -or -not (Test-OwnerServicePreparationPresence (Get-OwnerDataRoot))){throw 'OUG_EXISTING_INSTALL_REQUIRED'}
 foreach($name in @('owner-services.prepare-lock','owner-data.prepare-lock','owner-msi.prepare-lock','owner-msi.upgrade-transaction.json','owner-identity.initialize-lock','owner-activation.prepare-lock','owner-policy.prepare-lock','owner-msi.policy.json','owner-msi.prepared.json')){if(Test-OwnerServicePreparationPresence (Join-Path $product $name)){throw 'OUG_INSTALL_TRANSACTION_PRESENT'}}
 foreach($name in @('owner-policy.install-lock','security\owner-policy.install-lock')){if(Test-OwnerServicePreparationPresence (Join-Path (Get-OwnerInstanceRoot) $name)){throw 'OUG_OWNER_TRANSACTION_PRESENT'}}
 $script:upgradeStage='services';$services=@();foreach($role in @('control','supervisor')){
  $name=if($role -ceq 'control'){'Ragent-ControlPlane'}else{'Ragent-RunnerSupervisor'};$service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")
  if(-not $service -or $service.StartName -ine ('NT SERVICE\'+$name) -or $service.State -cne 'Running' -or $service.StartMode -cne 'Auto' -or $service.ProcessId -le 0){throw 'OUG_SERVICE_STATE_REFUSED'}
  $instanceRoot=Get-OwnerInstanceRoot
  $config=if($role -ceq 'control'){Join-Path $instanceRoot 'config'}else{Join-Path $instanceRoot 'executor\config'}
  $command=' --role '+$role+' --config-dir "'+$config+'" --instance-root "'+$instanceRoot+'"'
  if($service.PathName -cnotmatch '^(?:"(?<exe>[A-Za-z]:\\[^\"]+\.exe)"|(?<exe>[A-Za-z]:\\\S+\.exe))(?<args>.*)$' -or $Matches.args -cne $command){throw 'OUG_SERVICE_COMMAND_REFUSED'}
  $exe=[IO.Path]::GetFullPath($Matches.exe);if($services.Count -and $services[0].exe -cne $exe){throw 'OUG_SERVICE_HOST_MISMATCH'}
  Assert-UpgradePath $exe $false ([IO.Path]::GetDirectoryName($exe))
  $sourceRoot=[IO.Path]::GetDirectoryName($exe)
  foreach($relative in @('payload\node.exe','payload\chat-server.mjs','payload\chat\runner-supervisor-daemon.mjs','payload\owner-bootstrap-release.json','payload\Ragent.OwnerBootstrap.exe')){Assert-UpgradePath (Join-Path $sourceRoot $relative) $false $sourceRoot}
  $token=[RagentOwnerUpgradeTokenReader]::Read([int]$service.ProcessId)
  $expectedSid=[Security.Principal.NTAccount]::new('NT SERVICE',$name).Translate([Security.Principal.SecurityIdentifier]).Value
  if($token.userSid -cne $expectedSid -or $token.integrityRid -ne 8192 -or $token.sessionId -ne 0 -or $token.elevated -or $token.enabledAdministrators -or @($token.privileges).Count -ne 1 -or $token.privileges[0] -cne 'SeChangeNotifyPrivilege'){throw 'OUG_SERVICE_TOKEN_REFUSED'}
  $services+=@{name=$name;role=$role;sid=$expectedSid;pid=[int]$service.ProcessId;exe=$exe}
 }
 $script:upgradeStage='policy-and-receipts';$control=$services|Where-Object {$_.role -ceq 'control'};$executor=$services|Where-Object {$_.role -ceq 'supervisor'}
 $root=Get-OwnerDataRoot;$ownerRoot=Get-OwnerInstanceRoot;$policyPath=Join-Path $ownerRoot 'security\owner-bootstrap-install.json'
 $policyBytes=Read-OwnerPinnedFile $policyPath @(Get-OwnerAdministrativeSids) $pins
 $policy=[Text.UTF8Encoding]::new($false,$true).GetString($policyBytes)|ConvertFrom-Json;Assert-OwnerInstallPolicy $policy
 if($policy.controlSid -cne $control.sid -or $policy.executorSid -cne $executor.sid){throw 'OUG_POLICY_SERVICE_MISMATCH'}
 $preparedInput=Read-UpgradeReceipt 'owner-msi.prepared.activated.json' 2048;$prepared=$preparedInput.value
 $policyReceiptInput=Read-UpgradeReceipt 'owner-msi.policy.activated.json' 8192;$policyReceipt=$policyReceiptInput.value
 $activeInput=Read-UpgradeReceipt 'owner-msi.activated.json' 8192;$active=$activeInput.value
 $healthInput=Read-UpgradeReceipt 'owner-msi.activation-health.json' 2048;$health=$healthInput.value
 $markerInput=Read-UpgradeReceipt 'owner-activation.committed-lock' 2048;$marker=$markerInput.value
 Assert-OwnerUpgradeAdmissionReceipts $policy $policyBytes $prepared $preparedInput.bytes $policyReceipt $policyReceiptInput.bytes $active $health $marker
 $script:upgradeStage='data-layout';$layout=@(Get-OwnerDataLayout $control.sid $executor.sid $policy.ownerSid);$missing=0
 for($parent=(Get-OwnerProgramDataPath);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){$pins.Add([RagentOwnerFilePin]::Directory($parent));Assert-OwnerObjectAcl $parent @(Get-OwnerAdministrativeSids) -Ancestor -Pins $pins}
 foreach($row in $layout){
  $path=if($row.relative){Join-Path $root $row.relative}else{$root}
  if(-not (Test-OwnerServicePreparationPresence $path)){$missing++;continue}
  $pins.Add([RagentOwnerFilePin]::Directory($path));$actual=Get-OwnerPathAcl -Path $path;$expected=New-OwnerDataAcl $row.grants $row.traverseOnly
  $actualSddl=Get-OwnerDataAclSddl $actual ([Security.AccessControl.AccessControlSections]::Access);$expectedSddl=Get-OwnerDataAclSddl $expected ([Security.AccessControl.AccessControlSections]::Access)
  $metadataPath=$row.relative -cin @('','instances','instances\owner')
  $legacySddl=if($metadataPath){Get-OwnerDataAclSddl (New-LegacyOwnerMetadataAcl $control.sid $executor.sid) ([Security.AccessControl.AccessControlSections]::Access)}else{$null}
  if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or ($actualSddl -cne $expectedSddl -and (-not $metadataPath -or $actualSddl -cne $legacySddl))){throw 'OUG_DATA_ACL_MISMATCH'}
 }
 if($missing -gt 0){throw 'OUG_DATA_LAYOUT_INCOMPLETE'}
 foreach($path in @((Join-Path $ownerRoot 'config\instance-identity.json'),(Join-Path $ownerRoot 'config\owner-identity.result.json'),(Join-Path $ownerRoot 'config\auth-session-secret'),(Join-Path $ownerRoot 'config\auth-sessions.sqlite'))){
  if(-not (Test-OwnerServicePreparationPresence $path)){throw 'OUG_EXISTING_OWNER_STATE_REQUIRED'}
  $allowed=@(Get-OwnerAdministrativeSids)+@($control.sid);if($path.StartsWith((Join-Path $ownerRoot 'config')+'\',[StringComparison]::OrdinalIgnoreCase)){$allowed+=@($executor.sid)}
  Assert-UpgradeDataFile $path $allowed
 }
 foreach($kind in @('security','file')){
  $path=if($kind -ceq 'security'){Join-Path $ownerRoot 'security'}else{$policyPath};$acl=Get-OwnerPathAcl -Path $path
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -cne (New-OwnerPolicySecurity $policy $kind).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)){throw 'OUG_INSTALL_POLICY_ACL_MISMATCH'}
 }
 $script:upgradeStage='broker';$broker=[RagentOwnerUpgradeTokenReader]::ReadBroker('Ragent-PrivilegedBroker')
 $brokerBinary=Join-Path $product 'Broker\Ragent.PrivilegedBroker.exe'
 if(-not $broker -or $broker.account -ine 'LocalSystem' -or $broker.state -ne 4 -or $broker.startType -ne 2 -or $broker.serviceType -ne 16 -or $broker.binary.Trim('"') -ine $brokerBinary){throw 'OUG_BROKER_STATE_REFUSED'}
 Assert-UpgradePath $brokerBinary $false $product
 return @{ok=$true;readOnly=$true;upgradeAdmitted=$true;credentialContentsRead=$false;identityReused=$true;dataMigration='in-place-preserve';services=@($services|ForEach-Object {@{name=$_.name;role=$_.role;tokenVerified=$true}});dataLayoutVerified=$true;brokerServicePresent=$true;authorityIssued=$false}
}
if(-not $upgradeLibraryOnly){
 try{$script:upgradeStage='token-reader';Initialize-OwnerUpgradeTokenReader;$result=Invoke-OwnerUpgradeAdmission;$result|ConvertTo-Json -Compress}
 catch{$failure=$_;$exception=$failure.Exception.GetBaseException();$code=$exception.Message;if($code -cnotmatch '^OUG_[A-Z_]+$'){$code='OUG_UPGRADE_ADMISSION_FAILED'}
  # Retain only numeric diagnostics: raw exception messages and script paths
  # may contain private installation information. The first stack location is
  # the actual failing statement, rather than this outer catch.
  $line=[int]$failure.InvocationInfo.ScriptLineNumber;$firstStack=($failure.ScriptStackTrace -split "`r?`n")[0];if($firstStack -match '(\d+)\D*$'){$parsed=0;if([int]::TryParse($Matches[1],[ref]$parsed) -and $parsed -gt 0 -and $parsed -le 10000){$line=$parsed}}
  @{ok=$false;code=$code;failureStage=$script:upgradeStage;failureLine=$line;failureHResult=[int]$exception.HResult;readOnly=$true;upgradeAdmitted=$false;credentialContentsRead=$false;authorityIssued=$false}|ConvertTo-Json -Compress;exit 1}
 finally{for($index=$pins.Count-1;$index -ge 0;$index--){$pins[$index].Dispose()}}
}
