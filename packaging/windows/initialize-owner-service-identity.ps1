# Fixed embedded installer step. Default performs SCM-only planning. No product
# activation, signed-helper substitute, existing-state adoption or lock recovery.
[CmdletBinding()]
param([switch]$Commit,[ValidateSet('Initialize')][string]$Action='Initialize')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$identityCommit=$Commit.IsPresent -or $PSBoundParameters.ContainsKey('Action')
. (Join-Path $PSScriptRoot 'managed-owner-msi.ps1') -LibraryOnly
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Diagnostics;using System.Threading;
public sealed class OwnerIdentityServiceLease:IDisposable {
 [StructLayout(LayoutKind.Sequential)]struct Config {public uint type,start,error;public IntPtr command,group;public uint tag;public IntPtr dependencies,account,display;}
 [StructLayout(LayoutKind.Sequential)]struct Status {public uint type,state,controls,win32,service,checkpoint,hint,pid,flags;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenSCManager(string a,string b,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryServiceConfig(IntPtr service,IntPtr config,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool QueryServiceStatusEx(IntPtr service,int kind,out Status status,int size,out int needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ChangeServiceConfig(IntPtr service,uint type,uint start,uint error,string command,string group,IntPtr tag,string dependencies,string account,string password,string display);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool StartService(IntPtr service,int count,[In,MarshalAs(UnmanagedType.LPArray,ArraySubType=UnmanagedType.LPWStr,SizeParamIndex=1)]string[] args);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool ControlService(IntPtr service,uint control,out Status status);
 [DllImport("advapi32.dll")]static extern bool CloseServiceHandle(IntPtr service);
 IntPtr handle;readonly string command;bool temporary;
 const string Dependency="Ragent-RunnerSupervisor",Account=@"NT SERVICE\Ragent-ControlPlane";
 public OwnerIdentityServiceLease(string expectedCommand){command=expectedCommand;var m=OpenSCManager(null,null,1);if(m==IntPtr.Zero)throw new InvalidOperationException("OII_SCM_OPEN_REFUSED");try{handle=OpenService(m,"Ragent-ControlPlane",0x37);}finally{CloseServiceHandle(m);}if(handle==IntPtr.Zero)throw new InvalidOperationException("OII_SERVICE_OPEN_REFUSED");try{Verify(4,Dependency,true);}catch{Dispose();throw;}}
 Status State(){Status s;int n;if(!QueryServiceStatusEx(handle,0,out s,Marshal.SizeOf(typeof(Status)),out n))throw new InvalidOperationException("OII_STATUS_REFUSED");return s;}
 void Verify(uint mode,string dependency,bool stopped){
  uint n;QueryServiceConfig(handle,IntPtr.Zero,0,out n);if(n<1||n>65536)throw new InvalidOperationException("OII_CONFIG_REFUSED");var memory=Marshal.AllocHGlobal((int)n);
  try{if(!QueryServiceConfig(handle,memory,n,out n))throw new InvalidOperationException("OII_CONFIG_REFUSED");var c=(Config)Marshal.PtrToStructure(memory,typeof(Config));
   string dep=c.dependencies==IntPtr.Zero?"":Marshal.PtrToStringUni(c.dependencies);if(dep==Dependency && Marshal.ReadInt16(c.dependencies,(dep.Length+1)*2)!=0)throw new InvalidOperationException("OII_CONFIG_CHANGED");
   if(c.type!=16||c.start!=mode||Marshal.PtrToStringUni(c.command)!=command||!String.Equals(Marshal.PtrToStringUni(c.account),Account,StringComparison.OrdinalIgnoreCase)||dep!=dependency)throw new InvalidOperationException("OII_CONFIG_CHANGED");
  }finally{Marshal.FreeHGlobal(memory);}var s=State();if(stopped&&(s.state!=1||s.pid!=0))throw new InvalidOperationException("OII_NOT_DRAINED");
 }
 void Configure(uint mode,string deps){if(!ChangeServiceConfig(handle,0xffffffff,mode,0xffffffff,null,null,IntPtr.Zero,deps+"\0",null,null,null))throw new InvalidOperationException("OII_CONFIGURATION_FAILED");}
 public void Initialize(){Verify(4,Dependency,true);Configure(3,"");temporary=true;Verify(3,"",true);if(!StartService(handle,1,new[]{"--initialize-owner-identity"}))throw new InvalidOperationException("OII_START_REFUSED");var clock=Stopwatch.StartNew();while(clock.ElapsedMilliseconds<60000){var s=State();if(s.state==1){if(s.win32!=0||s.service!=0)throw new InvalidOperationException("OII_INITIALIZER_FAILED");return;}Thread.Sleep(100);}throw new InvalidOperationException("OII_INITIALIZER_TIMEOUT");}
 public void Restore(){if(!temporary)return;Verify(3,"",false);var state=State();if(state.state!=1){Status after;if(!ControlService(handle,1,out after))throw new InvalidOperationException("OII_STOP_FAILED");var clock=Stopwatch.StartNew();while(State().state!=1&&clock.ElapsedMilliseconds<10000)Thread.Sleep(100);}Verify(3,"",true);Configure(4,Dependency);temporary=false;Verify(4,Dependency,true);}
 public void Dispose(){if(handle!=IntPtr.Zero){CloseServiceHandle(handle);handle=IntPtr.Zero;}}
}
'@
$pins=[Collections.Generic.List[IDisposable]]::new();$supervisor=$null;$control=$null;$marker=$null;$complete=$false
$product=Get-OwnerProductRoot;$config=Join-Path (Get-OwnerInstanceRoot) 'config';$lockPath=Join-Path $product 'owner-identity.initialize-lock';$stage='services'
try {
 $services=@(Get-OwnerDataServices)
 if(-not $identityCommit){@{ok=$true;readOnly=$true;identityInitialized=$false;servicesActivated=$false}|ConvertTo-Json -Compress;return}
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OII_ADMIN_REQUIRED'}
 $stage='inputs';Open-OwnerServicePreparationInputs $pins
 foreach($name in @('owner-services.prepare-lock','owner-data.prepare-lock','owner-msi.prepare-lock','owner-identity.initialize-lock','owner-activation.prepare-lock','owner-policy.prepare-lock','owner-msi.policy.json')){if(Test-OwnerServicePreparationPresence (Join-Path $product $name)){throw 'OII_TRANSACTION_INCOMPLETE'}}
 foreach($path in @((Join-Path (Get-OwnerInstanceRoot) 'security'),(Join-Path (Get-OwnerInstanceRoot) 'owner-policy.install-lock'))){if(Test-OwnerServicePreparationPresence $path){throw 'OII_ACTIVE_STATE_REFUSED'}}
 Assert-OwnerPreparedRelease $pins
 $stage='receipt';$receiptBytes=Read-OwnerPinnedFile (Join-Path $product 'owner-msi.prepared.json') @(Get-OwnerAdministrativeSids) $pins
 $receipt=[Text.UTF8Encoding]::new($false,$true).GetString($receiptBytes)|ConvertFrom-Json
 if(@($receipt.PSObject.Properties).Count -ne 4 -or -not (Test-OwnerJsonInteger $receipt.version 1 1) -or $receipt.purpose -cne 'owner-msi-preparation' -or $receipt.phase -cne 'prepared' -or $receipt.ownerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'OII_PREPARED_RECEIPT_REQUIRED'}
 # Verify the entire protected prepared directory layout without changing it.
 $stage='layout';for($parent=(Get-OwnerProgramDataPath);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){$pins.Add([RagentOwnerFilePin]::Directory($parent));Assert-OwnerObjectAcl $parent @(Get-OwnerAdministrativeSids) -Ancestor -Pins $pins}
 $controlSid=($services|Where-Object {$_.role -eq 'control'}).sid;$executorSid=($services|Where-Object {$_.role -eq 'supervisor'}).sid
 foreach($row in @(Get-OwnerDataLayout $controlSid $executorSid $receipt.ownerSid)){
  $path=if($row.relative){Join-Path (Get-OwnerDataRoot) $row.relative}else{Get-OwnerDataRoot}
  $pins.Add([RagentOwnerFilePin]::Directory($path));$a=[IO.Directory]::GetAccessControl($path)
  if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or (Get-OwnerDataAclSddl $a ([Security.AccessControl.AccessControlSections]::Access)) -cne (Get-OwnerDataAclSddl (New-OwnerDataAcl $row.grants $row.traverseOnly) ([Security.AccessControl.AccessControlSections]::Access))){throw 'OII_LAYOUT_MISMATCH'}
 }
 $stage='modules';foreach($relative in @('scripts\initialize-windows-owner-identity.mjs','lib\instance-identity.mjs','lib\instance-proof-protocol.mjs','lib\windows-owner-identity-paths.mjs')){$null=Read-OwnerPinnedFile (Join-Path (Join-Path $product 'payload') $relative) @(Get-OwnerAdministrativeSids) $pins 131072}
 $stage='existing';foreach($name in @('instance-identity.json','instance-identity.json.initialize-lock','instance-identity.json.pending','auth-session-secret','auth-sessions.sqlite','owner-identity.result.json')){if(Test-OwnerServicePreparationPresence (Join-Path $config $name)){throw 'OII_EXISTING_STATE_REFUSED'}}
 $stage='lease';$plan=@(Get-OwnerServicePreparationPlan);$p=$plan|Where-Object {$_.role -eq 'supervisor'};$supervisor=[ManagedPreparedService]::new($p.name,$p.command,$p.account)
 $p=$plan|Where-Object {$_.role -eq 'control'};$control=[OwnerIdentityServiceLease]::new($p.command)
 $create=[IO.FileStream]::new($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes("ragent-owner-identity-initialization-v1`n");$create.Write($bytes,0,$bytes.Length);$create.Flush($true)}finally{$create.Dispose()}
 $marker=[IO.FileStream]::new($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $stage='run';$control.Initialize();$control.Restore();$supervisor.Verify();$null=@(Get-OwnerDataServices)
 $stage='result';$resultBytes=Read-OwnerPinnedFile (Join-Path $config 'owner-identity.result.json') (@(Get-OwnerAdministrativeSids)+@($controlSid)) $pins
 $facts=[Text.UTF8Encoding]::new($false,$true).GetString($resultBytes)|ConvertFrom-Json
 if(-not (Test-OwnerJsonInteger $facts.version 1 1) -or $facts.initialized -isnot [bool] -or $facts.initialized -ne $true -or $facts.sid -cne $controlSid -or -not (Test-OwnerJsonInteger $facts.sessionId 0 0) -or -not (Test-OwnerJsonInteger $facts.integrityRid 8192 8192) -or $facts.onlyChangeNotify -isnot [bool] -or $facts.onlyChangeNotify -ne $true -or -not (Test-OwnerJsonInteger $facts.hostPid 1) -or -not (Test-OwnerJsonInteger $facts.nodePid 1)){throw 'OII_INITIALIZATION_RESULT_INVALID'}
 $stage='identity';$identityBytes=Read-OwnerPinnedFile (Join-Path $config 'instance-identity.json') (@(Get-OwnerAdministrativeSids)+@($controlSid)) $pins 32768
 $identity=[Text.UTF8Encoding]::new($false,$true).GetString($identityBytes)|ConvertFrom-Json
 if($identity.instanceId -cnotmatch '^inst_[a-f0-9]{32}$' -or $identity.algorithm -cne 'ed25519'){throw 'OII_IDENTITY_INVALID'}
 foreach($name in @('auth-session-secret','auth-sessions.sqlite','instance-identity.json.initialize-lock','instance-identity.json.pending')){if(Test-OwnerServicePreparationPresence (Join-Path $config $name)){throw 'OII_UNEXPECTED_STATE'}}
 $complete=$true
 @{ok=$true;identityInitialized=$true;instanceId=$identity.instanceId;identitySha256=(Get-OwnerDigest $identityBytes);observed=$facts;servicesActivated=$false;preparedReceiptPreserved=$true;authorityIssued=$false}|ConvertTo-Json -Depth 5 -Compress
}catch{
 $code=$_.Exception.GetBaseException().Message;if($code -cnotmatch '^(OII|ODP|OSP|OBD)_[A-Z_]+$'){$code='OII_INITIALIZATION_FAILED'}
 @{ok=$false;code=$code;stage=$stage;quarantined=($null -ne $marker);servicesActivated=$false;authorityIssued=$false}|ConvertTo-Json -Compress
 exit 1
}finally{
 if($control){try{$control.Restore()}finally{$control.Dispose()}}
 if($supervisor){$supervisor.Dispose()}
 if($marker){$marker.Dispose();if($complete){[IO.File]::Delete($lockPath)}}
 for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}
}
