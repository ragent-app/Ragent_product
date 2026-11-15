# Private installer candidate. Default is read-only planning; fixed installed
# paths only. Does not migrate identities/ACL ancestors, start services or reclaim
# crash locks. Not invoked by the legacy SYSTEM installer.
[CmdletBinding()]
param([switch]$LibraryOnly,[switch]$Commit,[string]$PolicyFile='')
$ErrorActionPreference='Stop'
$ownerPolicyLibraryOnly=$LibraryOnly.IsPresent
. (Join-Path $PSScriptRoot 'read-owner-bootstrap-discovery.ps1') -LibraryOnly
$product=Get-OwnerProductRoot

function Assert-OwnerInstallPolicy($Policy){
  $keys=@($Policy.PSObject.Properties.Name)
  $expected=@('version','instanceId','controlSid','executorSid','ownerSid','port')
  if($keys.Count -ne 6 -or @($keys|Where-Object {$_ -cnotin $expected}).Count -or
    $Policy.version -isnot [int] -or $Policy.version -ne 1 -or $Policy.port -isnot [int] -or $Policy.port -ne 7690 -or
    $Policy.instanceId -isnot [string] -or $Policy.instanceId -cnotmatch '\A(?:[a-f0-9-]{36}|inst_[a-f0-9]{32})\z' -or
    $Policy.controlSid -isnot [string] -or $Policy.controlSid -cnotmatch '\AS-1-5-80-(\d+-){4}\d+\z' -or
    $Policy.executorSid -isnot [string] -or $Policy.executorSid -cnotmatch '\AS-1-5-80-(\d+-){4}\d+\z' -or
    $Policy.controlSid -ceq $Policy.executorSid -or $Policy.ownerSid -isnot [string] -or
    $Policy.ownerSid -cnotmatch '\AS-1-5-21-(\d+-){3}\d+\z'){throw 'OIP_POLICY_INVALID'}
}
function New-OwnerPolicySecurity($Policy,[ValidateSet('security','runtime','file')][string]$Kind,[string[]]$Administrators=@('S-1-5-32-544','S-1-5-18')){
  Assert-OwnerInstallPolicy $Policy
  $acl=if($Kind -eq 'file'){[Security.AccessControl.FileSecurity]::new()}else{[Security.AccessControl.DirectorySecurity]::new()}
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($Administrators[0]))
  $inherit=if($Kind -eq 'file'){[Security.AccessControl.InheritanceFlags]::None}else{[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
  foreach($sid in $Administrators){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
  foreach($sid in @($Policy.controlSid,$Policy.ownerSid)){
    $rights=if($Kind -eq 'runtime' -and $sid -ceq $Policy.controlSid){[Security.AccessControl.FileSystemRights]::Modify}elseif($Kind -eq 'file'){[Security.AccessControl.FileSystemRights]::Read}else{[Security.AccessControl.FileSystemRights]::ReadAndExecute}
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$rights,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  return $acl
}
function Assert-OwnerPolicyRelease($Release){
  try{Assert-OwnerReleaseManifest $Release;if($Release.protocolVersion -ne 2){throw 'protocol'}}catch{throw 'OIP_SIGNED_RELEASE_REQUIRED'}
}
function Assert-OwnerPolicyDirectory([string]$Path,[string[]]$Allowed,[Collections.Generic.List[IDisposable]]$Pins){
  for($cursor=[IO.Path]::GetFullPath($Path);$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){
    $Pins.Add([RagentOwnerFilePin]::Directory($cursor));Assert-OwnerObjectAcl $cursor $Allowed -Ancestor -Pins $Pins
  }
}
# Private primitive accepts an already trusted root/administrator set for isolated
# tests. Public entry below never accepts a root, ACL list or environment path.
function Publish-OwnerInstallPolicy([string]$Root,$Policy,[string[]]$Administrators=@('S-1-5-32-544','S-1-5-18')){
  Assert-OwnerInstallPolicy $Policy
  $pins=[Collections.Generic.List[IDisposable]]::new();$lease=$null;$success=$false
  $rootPath=[IO.Path]::GetFullPath($Root);$lock=Join-Path $rootPath 'owner-policy.install-lock'
  # OS ancestors use the same fixed administrative principals as all installed
  # readers. Metadata ownership/DACLs remain on the explicit Administrators set.
  $ancestorAdministrators=@($Administrators+@(Get-OwnerAdministrativeSids)|Select-Object -Unique)
  $security=Join-Path $rootPath 'security';$runtime=Join-Path $rootPath 'runtime';$target=Join-Path $security 'owner-bootstrap-install.json'
  try{
    Assert-OwnerPolicyDirectory $rootPath $ancestorAdministrators $pins
    if([IO.File]::Exists($target) -or [IO.Directory]::Exists($target)){throw 'OIP_POLICY_ALREADY_PRESENT'}
    try{$lease=[IO.FileStream]::new($lock,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]'ReadData,WriteData',[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough,(New-OwnerPolicySecurity $Policy 'file' $Administrators))}catch{throw 'OIP_INSTALL_ALREADY_OWNED'}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"version":1,"purpose":"owner-policy-install"}')
    $lease.Write($bytes,0,$bytes.Length);$lease.Flush($true)
    # Existing directories are verified, never recursively repaired or adopted.
    foreach($kind in @('security','runtime')){
      $path=Join-Path $rootPath $kind
      if(-not [IO.Directory]::Exists($path)){$null=[IO.Directory]::CreateDirectory($path,(New-OwnerPolicySecurity $Policy $kind $Administrators))}
      $pins.Add([RagentOwnerFilePin]::Directory($path))
      Assert-OwnerObjectAcl $path $(if($kind -eq 'runtime'){$Administrators+@($Policy.controlSid)}else{$Administrators})
      $actual=[IO.Directory]::GetAccessControl($path)
      if(-not $actual.AreAccessRulesProtected -or $actual.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -cne (New-OwnerPolicySecurity $Policy $kind $Administrators).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)){throw 'OIP_DIRECTORY_POLICY_MISMATCH'}
    }
    $temporary=Join-Path $security ('owner-policy.pending-'+[guid]::NewGuid().ToString('N'))
    $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]'ReadData,WriteData',[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough,(New-OwnerPolicySecurity $Policy 'file' $Administrators))
    try{
      $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Policy|ConvertTo-Json -Compress))
      $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);$stream.Position=0
      $check=[byte[]]::new($bytes.Length);$offset=0
      while($offset -lt $check.Length){$count=$stream.Read($check,$offset,$check.Length-$offset);if($count -le 0){throw 'OIP_WRITE_VERIFY_FAILED'};$offset+=$count}
      if([Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($check)){throw 'OIP_WRITE_VERIFY_FAILED'}
      [RagentOwnerFilePin]::Verify($stream.SafeFileHandle,$temporary,$false)
    }finally{$stream.Dispose()}
    if(-not ('RagentOwnerPolicyPublish' -as [type])){
      Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class RagentOwnerPolicyPublish {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateHardLink(string target,string source,IntPtr security);
}
'@
    }
    if(-not [RagentOwnerPolicyPublish]::CreateHardLink($target,$temporary,[IntPtr]::Zero)){throw 'OIP_PUBLISH_REFUSED'}
    # Only this newly created, protected pending pathname is removed. If any
    # following step fails, retain the install lock and evidence for repair.
    [IO.File]::Delete($temporary)
    $read=Read-OwnerPinnedFile $target $Administrators $pins 8192 $ancestorAdministrators
    if([Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($read)){throw 'OIP_WRITE_VERIFY_FAILED'}
    [RagentOwnerFilePin]::Verify($lease.SafeFileHandle,$lock,$false)
    $result=@{policyPrepared=$true;servicesActivated=$false;migrationReady=$false;policySha256=(Get-OwnerDigest $read)}
    $success=$true
    return $result
  }finally{
    if($lease){$lease.Dispose()}
    if($success){[IO.File]::Delete($lock)}
    for($index=$pins.Count-1;$index -ge 0;$index--){$pins[$index].Dispose()}
  }
}

function Read-OwnerPolicyInstallPreflight {
  $services=@()
  foreach($name in @('Ragent-ControlPlane','Ragent-RunnerSupervisor')){
    $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
    if(-not $service){throw 'OIP_SERVICE_MISSING'}
    if($service.StartName -ine ('NT SERVICE\'+$name)){throw 'OIP_SERVICE_IDENTITY_NOT_SEPARATED'}
    if($service.State -ne 'Stopped' -or $service.ProcessId -ne 0){throw 'OIP_SERVICES_NOT_DRAINED'}
    $services+=@{name=$name;sid=[Security.Principal.NTAccount]::new('NT SERVICE',$name).Translate([Security.Principal.SecurityIdentifier]).Value}
  }
  return $services
}
if(-not $ownerPolicyLibraryOnly){
  try{
    # This first gate reads only SCM metadata, before opening any input/identity
    # files or creating paths. A legacy SYSTEM installation is never converted.
    $services=@(Read-OwnerPolicyInstallPreflight)
    if(-not $Commit){@{servicePreflightPassed=$true;policyPrepared=$false;mutationPerformed=$false;servicesActivated=$false;migrationReady=$false}|ConvertTo-Json -Compress;return}
    Assert-OwnerPolicyInstallComplete
    if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OIP_ADMIN_REQUIRED'}
    if(-not $PolicyFile){throw 'OIP_POLICY_REQUIRED'}
    $policyInputStream=[IO.FileStream]::new([IO.Path]::GetFullPath($PolicyFile),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
      [RagentOwnerFilePin]::Verify($policyInputStream.SafeFileHandle,[IO.Path]::GetFullPath($PolicyFile),$false)
      if($policyInputStream.Length -lt 1 -or $policyInputStream.Length -gt 8192){throw 'OIP_POLICY_INVALID'}
      $reader=[IO.StreamReader]::new($policyInputStream,[Text.UTF8Encoding]::new($false,$true),$true,4096,$true)
      try{$policy=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
    }finally{$policyInputStream.Dispose()}
    Assert-OwnerInstallPolicy $policy
    if($policy.controlSid -cne $services[0].sid -or $policy.executorSid -cne $services[1].sid){throw 'OIP_SERVICE_SID_MISMATCH'}
    $pins=[Collections.Generic.List[IDisposable]]::new()
    try{
      $admin=@('S-1-5-32-544','S-1-5-18')
      $release=Read-OwnerPinnedFile (Join-Path $product 'payload\owner-bootstrap-release.json') $admin $pins
      $helperPath=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe'
      $helper=Read-OwnerPinnedFile $helperPath $admin $pins 4194304
      $metadata=[Text.UTF8Encoding]::new($false,$true).GetString($release)|ConvertFrom-Json
      Assert-OwnerPolicyRelease $metadata
      try{Assert-OwnerPolicyRelease $metadata;$null=Get-OwnerReleaseTrust $metadata $helper $helperPath}catch{throw 'OIP_SIGNED_RELEASE_REQUIRED'}
      # Read privately solely to retain the actual durable ID, never output or
      # copy the identity/key container to policy, logs or the executor.
      $identity=Read-OwnerPinnedFile (Join-Path (Get-OwnerInstanceRoot) 'config\instance-identity.json') ($admin+@($policy.controlSid)) $pins 32768
      $record=[Text.UTF8Encoding]::new($false,$true).GetString($identity)|ConvertFrom-Json
      if($record.instanceId -cne $policy.instanceId){throw 'OIP_INSTANCE_MISMATCH'}
      Publish-OwnerInstallPolicy (Get-OwnerInstanceRoot) $policy | ConvertTo-Json -Compress
    }finally{for($index=$pins.Count-1;$index -ge 0;$index--){$pins[$index].Dispose()}}
  }catch{
    $message=$_.Exception.GetBaseException().Message
    $code=if($message -cmatch '\A(?:OIP|OBD)_[A-Z_]+\z'){$message}else{'OIP_PREPARATION_FAILED'}
    @{ok=$false;code=$code;servicesActivated=$false;migrationReady=$false}|ConvertTo-Json -Compress
    exit 1
  }
}
