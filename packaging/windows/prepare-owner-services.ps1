# Fresh-install preparation only. Creates disabled virtual-account services;
# never starts them, adopts an installation, changes ACLs or reads credentials.
[CmdletBinding()]
param([switch]$LibraryOnly,[switch]$Commit)
$ErrorActionPreference='Stop'
$ownerServicesLibraryOnly=$LibraryOnly.IsPresent
. (Join-Path $PSScriptRoot 'read-owner-bootstrap-discovery.ps1') -LibraryOnly
$product=Get-OwnerProductRoot

function Get-OwnerServicePreparationPlan {
  # Windows Installer quotes the service executable only when its path
  # contains whitespace. Match its SCM representation exactly: an unquoted
  # executable without whitespace is unambiguous, while one with whitespace
  # must remain quoted.
  $executable=Join-Path $product 'AgentoC.ServiceHost.exe'
  $serviceBinary=if($executable -match '\s'){'"'+$executable+'"'}else{$executable}
  $programData=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  if(-not $programData -or -not [IO.Path]::IsPathRooted($programData)){throw 'OSP_PROGRAMDATA_UNAVAILABLE'}
  $instanceRoot=Join-Path $programData 'AgentoC\instances\owner'
  foreach($role in @('supervisor','control')){
    $name=if($role -eq 'control'){'AgentoC-ControlPlane'}else{'AgentoC-RunnerSupervisor'}
    $config=if($role -eq 'control'){Join-Path $instanceRoot 'config'}else{Join-Path $instanceRoot 'executor\config'}
    [pscustomobject]@{name=$name;account=('NT SERVICE\'+$name);startMode='Disabled';role=$role;
      dependencies=@($(if($role -eq 'control'){'AgentoC-RunnerSupervisor'}));
      command=('{0} --role {1} --config-dir "{2}" --instance-root "{3}"' -f $serviceBinary,$role,$config,$instanceRoot)}
  }
}

function Test-OwnerServicePreparationPresence([string]$Path){
  $chain=[Collections.Generic.List[string]]::new()
  for($cursor=[IO.Path]::GetFullPath($Path);$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){$chain.Add($cursor)}
  $chain.Reverse()
  foreach($cursor in $chain){
    try{$attributes=[IO.File]::GetAttributes($cursor)}
    catch [IO.FileNotFoundException]{return $false}
    catch [IO.DirectoryNotFoundException]{return $false}
    if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'OSP_PATH_UNSAFE'}
    if($cursor -cne $chain[$chain.Count-1] -and -not ($attributes -band [IO.FileAttributes]::Directory)){throw 'OSP_PATH_UNSAFE'}
  }
  return $true
}
function Assert-OwnerServicePreparationFresh([switch]$OwnLock) {
  # SCM and marker checks come before any product/input or credential read.
  foreach($row in @(Get-OwnerServicePreparationPlan)){
    if(Get-CimInstance Win32_Service -Filter ("Name='"+$row.name+"'")){throw 'OSP_EXISTING_SERVICE_REFUSED'}
  }
  if(Test-OwnerServicePreparationPresence (Get-OwnerDataRoot)){throw 'OSP_EXISTING_DATA_REFUSED'}
  if(-not $OwnLock -and (Test-OwnerServicePreparationPresence (Join-Path $product 'owner-services.prepare-lock'))){throw 'OSP_PREPARATION_INCOMPLETE'}
  if(Test-OwnerServicePreparationPresence (Join-Path $product 'owner-data.prepare-lock')){throw 'OSP_PREPARATION_INCOMPLETE'}
}

function Open-OwnerServicePreparationInputs([Collections.Generic.List[IDisposable]]$Pins){
  $allowed=@(Get-OwnerAdministrativeSids)
  foreach($relative in @('AgentoC.ServiceHost.exe','payload\node.exe','payload\chat-server.mjs','payload\chat\runner-supervisor-daemon.mjs')){
    $path=Join-Path $product $relative
    for($parent=[IO.Path]::GetDirectoryName($path);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){
      $Pins.Add([AgentoCOwnerFilePin]::Directory($parent));if(-not (Test-ExternalProductAncestor $path $parent)){Assert-OwnerObjectAcl $parent $allowed -Ancestor -Pins $Pins}
    }
    $file=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $Pins.Add($file);[AgentoCOwnerFilePin]::Verify($file.SafeFileHandle,$path,$false);Assert-OwnerObjectAcl $path $allowed
    if($file.Length -lt 1 -or $file.Length -gt 157286400){throw 'OSP_INPUT_SIZE_INVALID'}
  }
}

function Initialize-OwnerServiceRegistrationType {
  if('AgentoCOwnerServiceRegistration' -as [type]){return}
  Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.ComponentModel;
// Handles have no SERVICE_START permission. Rollback uses the exact created
// kernel objects, never a later name lookup that could adopt another service.
public sealed class AgentoCOwnerServiceRegistration:IDisposable {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenSCManager(string machine,string database,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateService(IntPtr manager,string name,string display,uint access,uint type,uint start,uint error,string command,string group,IntPtr tag,string dependencies,string account,string password);
 [DllImport("advapi32.dll",EntryPoint="ChangeServiceConfig2W",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ChangeServiceConfig2(IntPtr service,uint level,IntPtr info);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool DeleteService(IntPtr service);
 [DllImport("advapi32.dll")]static extern bool CloseServiceHandle(IntPtr handle);
 IntPtr service;bool removed;
 public AgentoCOwnerServiceRegistration(string name,string command,string dependency) {
  if(name!="AgentoC-ControlPlane"&&name!="AgentoC-RunnerSupervisor")throw new InvalidOperationException("OSP_SERVICE_NAME_REFUSED");
  var manager=OpenSCManager(null,null,2);if(manager==IntPtr.Zero)throw new InvalidOperationException("OSP_SCM_CREATE_DENIED");
  try{service=CreateService(manager,name,name,0x10007,0x10,4,1,command,null,IntPtr.Zero,dependency==null?null:dependency+"\0\0","NT SERVICE\\"+name,null);
   if(service==IntPtr.Zero)throw new InvalidOperationException("OSP_SERVICE_CREATE_FAILED");
  }finally{CloseServiceHandle(manager);}
 }
 public void RestrictPrivileges() {
  var info=Marshal.AllocHGlobal(IntPtr.Size);var privileges=Marshal.StringToHGlobalUni("SeChangeNotifyPrivilege\0\0");
  try{Marshal.WriteIntPtr(info,privileges);if(!ChangeServiceConfig2(service,6,info))throw new InvalidOperationException("OSP_PRIVILEGES_FAILED");}
  finally{Marshal.FreeHGlobal(privileges);Marshal.FreeHGlobal(info);}
  info=Marshal.AllocHGlobal(4);
  try{Marshal.WriteInt32(info,1);if(!ChangeServiceConfig2(service,5,info))throw new InvalidOperationException("OSP_SERVICE_SID_FAILED");}
  finally{Marshal.FreeHGlobal(info);}
 }
 public void Rollback(){if(service!=IntPtr.Zero&&!removed){if(!DeleteService(service))throw new InvalidOperationException("OSP_SERVICE_ROLLBACK_FAILED");removed=true;}}
 public void Dispose(){if(service!=IntPtr.Zero){CloseServiceHandle(service);service=IntPtr.Zero;}}
}
'@
}

if(-not $ownerServicesLibraryOnly){
  $pins=[Collections.Generic.List[IDisposable]]::new();$created=$null
  $lock=$null;$complete=$false;$failed=$false
  try{
    Assert-OwnerServicePreparationFresh
    Open-OwnerServicePreparationInputs $pins
    $plan=@(Get-OwnerServicePreparationPlan)
    if(-not $Commit){@{ok=$true;readOnly=$true;servicesPrepared=$false;servicesActivated=$false;migrationReady=$false;plan=$plan}|ConvertTo-Json -Depth 5 -Compress;return}
    if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OSP_ADMIN_REQUIRED'}
    # Pinning above prevents rename/reparse and requires administrator-owned
    # immutable input. This exclusive lock is never automatically reclaimed.
    $lock=[IO.FileStream]::new((Join-Path $product 'owner-services.prepare-lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"version":1,"purpose":"owner-services-preparation"}')
    $lock.Write($bytes,0,$bytes.Length);$lock.Flush($true)
    Assert-OwnerServicePreparationFresh -OwnLock
    Initialize-OwnerServiceRegistrationType
    $created=[Collections.Generic.List[AgentoCOwnerServiceRegistration]]::new()
    foreach($row in $plan){
      $dependency=if($row.role -eq 'control'){'AgentoC-RunnerSupervisor'}else{$null}
      $registration=[AgentoCOwnerServiceRegistration]::new($row.name,$row.command,$dependency)
      $created.Add($registration);$registration.RestrictPrivileges()
    }
    foreach($row in $plan){
      $actual=Get-CimInstance Win32_Service -Filter ("Name='"+$row.name+"'")
      if(-not $actual -or $actual.StartName -ine $row.account -or $actual.StartMode -cne 'Disabled' -or $actual.State -cne 'Stopped' -or $actual.ProcessId -ne 0 -or $actual.PathName -cne $row.command){throw 'OSP_SERVICE_CONFIRMATION_FAILED'}
    }
    $complete=$true
  }catch{
    $failed=$true;$complete=$false;$code=$_.Exception.GetBaseException().Message
    if($created){for($index=$created.Count-1;$index -ge 0;$index--){try{$created[$index].Rollback()}catch{$code='OSP_SERVICE_ROLLBACK_FAILED'}}}
    if($code -cnotmatch '^OSP_[A-Z_]+$' -and $code -cnotmatch '^OBD_[A-Z_]+$'){$code='OSP_PREPARATION_FAILED'}
    @{ok=$false;code=$code;servicesPrepared=$false;servicesActivated=$false;migrationReady=$false;lockRetained=($null -ne $lock)}|ConvertTo-Json -Compress
  }finally{
    if($created){foreach($registration in $created){$registration.Dispose()}}
    if($lock){$lock.Dispose();if($complete){[IO.File]::Delete((Join-Path $product 'owner-services.prepare-lock'))}}
    for($index=$pins.Count-1;$index -ge 0;$index--){$pins[$index].Dispose()}
  }
  if($failed){exit 1}
  # Publish success only after owned handles and the transaction lock are closed.
  if($complete){@{ok=$true;readOnly=$false;servicesPrepared=$true;servicesActivated=$false;migrationReady=$false;plan=$plan}|ConvertTo-Json -Depth 5 -Compress}
}
