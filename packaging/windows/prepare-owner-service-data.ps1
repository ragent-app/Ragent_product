# Fresh data preparation only; services must remain disabled/stopped. No identity,
# credential generation, migration, service activation or existing ACL repair.
[CmdletBinding()]
param([switch]$LibraryOnly,[switch]$Commit,[string]$OwnerSid='')
$ErrorActionPreference='Stop'
$ownerDataLibraryOnly=$LibraryOnly.IsPresent;$ownerDataCommit=$Commit.IsPresent
. (Join-Path $PSScriptRoot 'prepare-owner-services.ps1') -LibraryOnly
$product=Get-OwnerProductRoot

function Get-OwnerDataServices {
  $result=@()
  foreach($plan in @(Get-OwnerServicePreparationPlan)){
    $actual=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'")
    if(-not $actual -or $actual.StartName -ine $plan.account -or $actual.PathName -cne $plan.command -or $actual.StartMode -cne 'Disabled' -or $actual.State -cne 'Stopped' -or $actual.ProcessId -ne 0){throw 'ODP_DISABLED_PREPARED_SERVICES_REQUIRED'}
    $sid=[Security.Principal.NTAccount]::new('NT SERVICE',$plan.name).Translate([Security.Principal.SecurityIdentifier]).Value
    if($sid -cnotmatch '^S-1-5-80-(\d+-){4}\d+$'){throw 'ODP_SERVICE_SID_INVALID'}
    $result+=@{role=$plan.role;sid=$sid}
  }
  if($result[0].sid -ceq $result[1].sid){throw 'ODP_SERVICE_SID_INVALID'}
  return $result
}
function Get-OwnerDataLayout([string]$ControlSid,[string]$ExecutorSid,[string]$OwnerSid){
  if($OwnerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'ODP_OWNER_SID_REQUIRED'}
  # The unelevated Owner client must inspect the fixed ancestor DACLs before
  # trusting bootstrap files. These grants are non-inheriting on the three
  # metadata directories below; they do not expose descendants or file data.
  $both=@{};$both[$ControlSid]='ReadAndExecute';$both[$ExecutorSid]='ReadAndExecute'
  foreach($path in @('','instances','instances\owner','instances\owner\executor','instances\owner\data')){
    $grants=@{};$grants[$ControlSid]='ReadAndExecute';$grants[$ExecutorSid]='ReadAndExecute'
    if($path -cin @('','instances','instances\owner')){$grants[$OwnerSid]='ReadAndExecute'}
    @{relative=$path;grants=$grants;traverseOnly=$true}
  }
  foreach($path in @('instances\owner\config','instances\owner\memory','instances\owner\home','instances\owner\tmp')){
    @{relative=$path;grants=@{$ControlSid='Modify'};traverseOnly=$false}
  }
  foreach($path in @('instances\owner\executor\config','instances\owner\executor\runtime','instances\owner\executor\home','instances\owner\executor\tmp')){
    @{relative=$path;grants=@{$ExecutorSid='Modify'};traverseOnly=$false}
  }
  @{relative='instances\owner\runtime';grants=[ordered]@{$ControlSid='Modify';$OwnerSid='ReadAndExecute'};traverseOnly=$false}
  foreach($path in @('instances\owner\data\chat-runs','instances\owner\provider-homes','instances\owner\workspace')){
    @{relative=$path;grants=[ordered]@{$ControlSid='Modify';$ExecutorSid='Modify'};traverseOnly=$false}
  }
  foreach($path in @('harnesses','instances\owner\shared-tools')){
    @{relative=$path;grants=[ordered]@{$ControlSid='Modify';$ExecutorSid='ReadAndExecute'};traverseOnly=$false}
  }
}
function New-OwnerDataAcl($Grants,[bool]$TraverseOnly){
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach($sid in @('S-1-5-32-544','S-1-5-18')){
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  foreach($sid in $Grants.Keys){
    $inherit=if($TraverseOnly){[Security.AccessControl.InheritanceFlags]::None}else{[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]$Grants[$sid],$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  return $acl
}
function Get-OwnerDataAclSddl($Acl,[Security.AccessControl.AccessControlSections]$Sections){
  # NTFS can add the auto-inherited DACL control bit to a protected ACL after
  # SetAccessControl. It changes no ACE; compare the protected flag separately
  # and normalize only that control bit before checking the exact ACE list.
  return ($Acl.GetSecurityDescriptorSddlForm($Sections) -creplace 'D:PAI(?=\()','D:P')
}
function Initialize-OwnerDataDirectoryType {
  if('RagentOwnerDataDirectory' -as [type]){return}
  Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Security.AccessControl;
public static class RagentOwnerDataDirectory {
 [StructLayout(LayoutKind.Sequential)] struct Attributes {public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,ref Attributes attributes);
 public static void Create(string path,string sddl) {
  // Medium mandatory label at birth, not a later broad recursive ACL repair.
  var sd=new RawSecurityDescriptor(sddl+"S:(ML;OICI;NW;;;ME)");var bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);
  var memory=Marshal.AllocHGlobal(bytes.Length);
  try {Marshal.Copy(bytes,0,memory,bytes.Length);var attributes=new Attributes{length=Marshal.SizeOf(typeof(Attributes)),descriptor=memory,inherit=false};
   if(!CreateDirectory(path,ref attributes))throw new InvalidOperationException("ODP_DIRECTORY_CREATE_REFUSED");
  }finally{Marshal.FreeHGlobal(memory);}
 }
}
'@
}
function Invoke-OwnerDataPreparation([switch]$Commit,[string]$OwnerSid=''){
  $pins=[Collections.Generic.List[IDisposable]]::new();$lock=$null;$complete=$false;$failed=$false;$result=$null
  try{
    $services=@(Get-OwnerDataServices)
    if(Test-OwnerServicePreparationPresence (Get-OwnerDataRoot)){throw 'ODP_EXISTING_DATA_REFUSED'}
    foreach($marker in @('owner-services.prepare-lock','owner-data.prepare-lock')){if(Test-OwnerServicePreparationPresence (Join-Path $product $marker)){throw 'ODP_PREPARATION_INCOMPLETE'}}
    Open-OwnerServicePreparationInputs $pins
    for($parent=(Get-OwnerProgramDataPath);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){
      $pins.Add([RagentOwnerFilePin]::Directory($parent));Assert-OwnerObjectAcl $parent @(Get-OwnerAdministrativeSids) -Ancestor -Pins $pins
    }
    if(-not $Commit){return @{ok=$true;readOnly=$true;dataPrepared=$false;servicesActivated=$false;migrationReady=$false;ownerSidRequired=$true}}
    if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ODP_ADMIN_REQUIRED'}
    $control=($services|Where-Object {$_.role -eq 'control'}).sid;$executor=($services|Where-Object {$_.role -eq 'supervisor'}).sid
    $layout=@(Get-OwnerDataLayout $control $executor $OwnerSid)
    $lock=[IO.FileStream]::new((Join-Path $product 'owner-data.prepare-lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $bytes=[Text.Encoding]::UTF8.GetBytes('{"version":1,"purpose":"owner-data-preparation"}');$lock.Write($bytes,0,$bytes.Length);$lock.Flush($true)
    $null=@(Get-OwnerDataServices)
    Initialize-OwnerDataDirectoryType
    foreach($row in $layout){
      $path=if($row.relative){Join-Path (Get-OwnerDataRoot) $row.relative}else{Get-OwnerDataRoot}
      $acl=New-OwnerDataAcl $row.grants $row.traverseOnly
      [RagentOwnerDataDirectory]::Create($path,$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access'))
      $pins.Add([RagentOwnerFilePin]::Directory($path))
      $actual=[IO.Directory]::GetAccessControl($path)
      if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or
        (Get-OwnerDataAclSddl $actual ([Security.AccessControl.AccessControlSections]::Access)) -cne (Get-OwnerDataAclSddl $acl ([Security.AccessControl.AccessControlSections]::Access))){throw 'ODP_ACL_CONFIRMATION_FAILED'}
    }
    $complete=$true;$result=@{ok=$true;readOnly=$false;dataPrepared=$true;directories=$layout.Count;servicesActivated=$false;identityCreated=$false;credentialsCreated=$false;migrationReady=$false}
  }catch{
    $failed=$true;$code=$_.Exception.GetBaseException().Message
    if($code -cnotmatch '^(ODP|OSP|OBD)_[A-Z_]+$'){$code='ODP_PREPARATION_FAILED'}
    $result=@{ok=$false;code=$code;dataPrepared=$false;servicesActivated=$false;migrationReady=$false;lockRetained=($null -ne $lock)}
  }finally{
    if($lock){$lock.Dispose();if($complete){[IO.File]::Delete((Join-Path $product 'owner-data.prepare-lock'))}}
    for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}
  }
  return $result
}
if(-not $ownerDataLibraryOnly){
  if(Test-OwnerServicePreparationPresence (Join-Path $product 'owner-msi.prepare-lock')){@{ok=$false;code='ODP_INSTALLER_INCOMPLETE';dataPrepared=$false;servicesActivated=$false;lockRetained=$false}|ConvertTo-Json -Compress;exit 1}
  $result=Invoke-OwnerDataPreparation -Commit:$ownerDataCommit -OwnerSid $OwnerSid
  $result|ConvertTo-Json -Compress
  if(-not $result.ok){exit 1}
}
