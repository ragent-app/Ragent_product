# Embedded in the fixed MSI bridge, not loaded from caller-selected paths.
# No service start/stop, identity, credentials, policy activation or data removal.
[CmdletBinding()]
param([ValidateSet('Prepare','Remove')][string]$Action,[string]$OwnerSid='',[switch]$LibraryOnly)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$managedAction=$Action;$managedOwnerSid=$OwnerSid;$managedLibraryOnly=$LibraryOnly.IsPresent
. (Join-Path $PSScriptRoot 'prepare-owner-service-data.ps1') -LibraryOnly
if(-not $managedLibraryOnly){$Action=$managedAction;$OwnerSid=$managedOwnerSid}
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public sealed class ManagedPreparedService:IDisposable {
 [StructLayout(LayoutKind.Sequential)]struct Config {public uint type,start,error;public IntPtr command,group;public uint tag;public IntPtr dependencies,account,display;}
 [StructLayout(LayoutKind.Sequential)]struct Status {public uint type,state,controls,win32,service,checkpoint,hint,pid,flags;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenSCManager(string machine,string database,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryServiceConfig(IntPtr service,IntPtr config,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool QueryServiceStatusEx(IntPtr service,int kind,out Status status,int size,out int needed);
 [DllImport("advapi32.dll",EntryPoint="ChangeServiceConfig2W",SetLastError=true)]static extern bool Change(IntPtr service,uint kind,IntPtr info);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool DeleteService(IntPtr service);
 [DllImport("advapi32.dll")]static extern bool CloseServiceHandle(IntPtr service);
 IntPtr handle;readonly string command,account;
 public ManagedPreparedService(string name,string expectedCommand,string expectedAccount){
  command=expectedCommand;account=expectedAccount;var manager=OpenSCManager(null,null,1);
  if(manager==IntPtr.Zero)throw new InvalidOperationException("OMI_SCM_OPEN_REFUSED");
  try{handle=OpenService(manager,name,0x10007);}finally{CloseServiceHandle(manager);}
  if(handle==IntPtr.Zero)throw new InvalidOperationException("OMI_SERVICE_OPEN_REFUSED");
  try{Verify();}catch{Dispose();throw;}
 }
 public void Verify(){
  uint size;QueryServiceConfig(handle,IntPtr.Zero,0,out size);if(size<1||size>65536)throw new InvalidOperationException("OMI_CONFIG_REFUSED");var memory=Marshal.AllocHGlobal((int)size);
  try{if(!QueryServiceConfig(handle,memory,size,out size))throw new InvalidOperationException("OMI_CONFIG_REFUSED");var c=(Config)Marshal.PtrToStructure(memory,typeof(Config));
   if(c.type!=0x10||c.start!=4||Marshal.PtrToStringUni(c.command)!=command||!String.Equals(Marshal.PtrToStringUni(c.account),account,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("OMI_SERVICE_CHANGED");
  }finally{Marshal.FreeHGlobal(memory);}
  Status status;int needed;if(!QueryServiceStatusEx(handle,0,out status,Marshal.SizeOf(typeof(Status)),out needed)||status.state!=1||status.pid!=0)throw new InvalidOperationException("OMI_SERVICE_ACTIVE");
 }
 public void Restrict(){Verify();var text=Marshal.StringToHGlobalUni("SeChangeNotifyPrivilege\0\0");var info=Marshal.AllocHGlobal(IntPtr.Size);try{Marshal.WriteIntPtr(info,text);if(!Change(handle,6,info))throw new InvalidOperationException("OMI_PRIVILEGES_REFUSED");}finally{Marshal.FreeHGlobal(info);Marshal.FreeHGlobal(text);}}
 public void Remove(){Verify();if(!DeleteService(handle))throw new InvalidOperationException("OMI_DELETE_FAILED");}
 public void Dispose(){if(handle!=IntPtr.Zero){CloseServiceHandle(handle);handle=IntPtr.Zero;}}
}
'@
if($managedLibraryOnly){return}
$pins=[Collections.Generic.List[IDisposable]]::new();$services=[Collections.Generic.List[ManagedPreparedService]]::new();$lock=$null;$complete=$false
$product=Get-OwnerProductRoot;$receipt=Join-Path $product 'owner-msi.prepared.json'
try {
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OMI_ADMIN_REQUIRED'}
 Open-OwnerServicePreparationInputs $pins
 foreach($marker in @('owner-services.prepare-lock','owner-data.prepare-lock','owner-msi.prepare-lock','owner-identity.initialize-lock','owner-activation.prepare-lock','owner-policy.prepare-lock','owner-msi.policy.json')){if(Test-OwnerServicePreparationPresence (Join-Path $product $marker)){throw 'OMI_PREPARATION_INCOMPLETE'}}
 foreach($path in @((Join-Path (Get-OwnerInstanceRoot) 'security'),(Join-Path (Get-OwnerInstanceRoot) 'owner-policy.install-lock'))){if(Test-OwnerServicePreparationPresence $path){throw 'OMI_ACTIVE_INSTALLATION_REFUSED'}}
 Assert-OwnerPreparedRelease $pins
 if($Action -eq 'Prepare'){
  if($OwnerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'OMI_OWNER_SID_REQUIRED'}
  if(Test-OwnerServicePreparationPresence (Get-OwnerDataRoot)){throw 'OMI_EXISTING_DATA_REFUSED'}
  if(Test-OwnerServicePreparationPresence $receipt){throw 'OMI_RECEIPT_EXISTS'}
 }else{
  $bytes=Read-OwnerPinnedFile $receipt @(Get-OwnerAdministrativeSids) $pins
  $record=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json
  if(-not (Test-OwnerJsonInteger $record.version 1 1) -or $record.purpose -cne 'owner-msi-preparation' -or $record.phase -cne 'prepared' -or $record.ownerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'OMI_RECEIPT_INVALID'}
 }
 $null=@(Get-OwnerDataServices)
 foreach($plan in @(Get-OwnerServicePreparationPlan)){$services.Add([ManagedPreparedService]::new($plan.name,$plan.command,$plan.account))}
 $lock=[IO.FileStream]::new((Join-Path $product 'owner-msi.prepare-lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $bytes=[Text.Encoding]::UTF8.GetBytes('{"version":1,"purpose":"owner-msi-transaction"}');$lock.Write($bytes,0,$bytes.Length);$lock.Flush($true)
 if($Action -eq 'Prepare'){
  foreach($s in $services){$s.Restrict()}
  $result=Invoke-OwnerDataPreparation -Commit -OwnerSid $OwnerSid
  if(-not $result.ok -or -not $result.dataPrepared){throw 'OMI_DATA_PREPARATION_FAILED'}
  foreach($s in $services){$s.Verify()}
  $record=@{version=1;purpose='owner-msi-preparation';phase='prepared';ownerSid=$OwnerSid}
  $stream=[IO.FileStream]::new($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 }else{
  # Exact verified handles; never adopt or delete a later same-name service.
  for($i=$services.Count-1;$i -ge 0;$i--){$services[$i].Remove()}
  # Keep the public receipt and all data after uninstall. Its presence makes
  # future fresh preparation/legacy mutation refuse; no credential is read.
 }
 $complete=$true
 @{ok=$true;stage=$Action;preparedOnly=$true;servicesActivated=$false;dataRemoved=$false;authorityIssued=$false}|ConvertTo-Json -Compress
} catch {
 $code=$_.Exception.GetBaseException().Message;if($code -cnotmatch '^(OMI|ODP|OSP|OBD)_[A-Z_]+$'){$code='OMI_TRANSACTION_FAILED'}
 @{ok=$false;code=$code;quarantined=($null -ne $lock);servicesActivated=$false;dataRemoved=$false}|ConvertTo-Json -Compress
 exit 1
} finally {
 foreach($s in $services){$s.Dispose()}
 if($lock){$lock.Dispose();if($complete){[IO.File]::Delete((Join-Path $product 'owner-msi.prepare-lock'))}}
 for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}
}
