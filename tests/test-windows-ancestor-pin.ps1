# Scoped NTFS attacks against both actual production pin implementations. No
# SCM/UAC/OS-root mutation, credential access or protected-baseline adjustment.
[CmdletBinding()]
param([string]$EvidenceRoot='')
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('agct-ancestor-'+[Guid]::NewGuid().ToString('N'))
if(-not $EvidenceRoot){$EvidenceRoot=Join-Path $repo 'artifacts\showcase\T2-current-20261020\ancestor-compatibility'}
$null=New-Item -ItemType Directory -Path $EvidenceRoot -Force
$null=New-Item -ItemType Directory -Path $root
[IO.File]::WriteAllText((Join-Path $root '.owned'),$root)
$report=@{pass=$false;productionChanged=$false;servicesCreated=$false;root=$root}
try {
 . (Join-Path $repo 'packaging\windows\read-owner-bootstrap-discovery.ps1') -LibraryOnly
 Add-Type -Path (Join-Path $repo 'tests\fixtures\windows-ancestor-pin.cs') -ReferencedAssemblies System.Web.Extensions
 $psRoot=Join-Path $root 'powershell';$null=New-Item -ItemType Directory -Path $psRoot
 $guard=[Func[string,string,Microsoft.Win32.SafeHandles.SafeFileHandle[]]]{param($p,$c) return ,[RagentOwnerFilePin]::NonemptyDirectory($p,$c)}
 $single=[Func[string,Microsoft.Win32.SafeHandles.SafeFileHandle]]{param($p) return [RagentOwnerFilePin]::Directory($p)}
 $report.powershell=([AncestorMutationProbe]::Run($psRoot,$guard,$single)|ConvertFrom-Json)
 $exe=Join-Path $root 'host-probe.exe'
 & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /define:HOST_PROBE /target:exe /main:HostAncestorProbe /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Security.dll ('/out:'+$exe) (Join-Path $repo 'packaging\windows\Ragent.ServiceHost.cs') (Join-Path $repo 'tests\fixtures\windows-ancestor-pin.cs') *> (Join-Path $EvidenceRoot 'build.log')
 if($LASTEXITCODE -ne 0){throw 'ANCESTOR_HOST_COMPILE_FAILED'}
 $hostRoot=Join-Path $root 'host';$null=New-Item -ItemType Directory -Path $hostRoot
 $text=& $exe $hostRoot 2> (Join-Path $EvidenceRoot 'host-error.log')
 if($LASTEXITCODE -ne 0){throw 'ANCESTOR_HOST_PROBE_FAILED'}
 $report.host=($text|ConvertFrom-Json)
 # Generic/target metadata write grants remain refused outside the fixed OS
 # ancestor, including unknown SIDs; no deny/allow arithmetic or ACL rewrite.
 $foreign=Join-Path $root 'foreign';$null=New-Item -ItemType Directory -Path $foreign
 $unknown=[Security.Principal.SecurityIdentifier]::new('S-1-5-21-1111111111-2222222222-3333333333-424242')
 $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-32-544','S-1-5-18')
 $aclChecks=0
 foreach($rights in @('WriteAttributes','WriteExtendedAttributes','WriteData','Delete','DeleteSubdirectoriesAndFiles','ChangePermissions','TakeOwnership',0x40000000,0x10000000)) {
  $acl=Get-Acl -LiteralPath $foreign;$original=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  if($rights -is [int]){
   # FileSystemRights enums reject generic bits before Windows sees them.
   # Exercise actual raw allow ACE publication (the OS may expand those bits).
   $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
   $raw.DiscretionaryAcl.InsertAce(0,[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,$rights,$unknown,$false,$null))
   $bytes=[byte[]]::new($raw.BinaryLength);$raw.GetBinaryForm($bytes,0);$acl.SetSecurityDescriptorBinaryForm($bytes,[Security.AccessControl.AccessControlSections]::Access)
  }else{$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($unknown,[Security.AccessControl.FileSystemRights]$rights,'Allow'))}
  Set-Acl -LiteralPath $foreign -AclObject $acl
  foreach($ancestor in @($false,$true)) {
   $code='';try{Assert-OwnerObjectAcl $foreign $allowed -Ancestor:$ancestor}catch{$code=$_.Exception.Message}
   if($code -cne 'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY'){throw 'ANCESTOR_GENERIC_METADATA_NOT_REFUSED'}
   $aclChecks++
  }
  $restore=Get-Acl -LiteralPath $foreign;$restore.SetSecurityDescriptorSddlForm($original,[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath $foreign -AclObject $restore
 }
 $report.otherMetadataWritersRefused=$true;$report.aclChecks=$aclChecks;$report.pass=$true
} catch {$report.error=$_.Exception.ToString();$report.pass=$false}
finally {
 # Reject reparse entries before exact owned-root recursive cleanup. A failed
 # attacker may leave one; retain rather than follow it or delete unknown data.
 try {
  if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)) -ine [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or [IO.File]::ReadAllText((Join-Path $root '.owned')) -cne $root){throw 'ANCESTOR_CLEANUP_ROOT_REFUSED'}
  $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($root)
  while($pending.Count){foreach($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'ANCESTOR_CLEANUP_REPARSE_REFUSED'};if($item.PSIsContainer){$pending.Push($item.FullName)}}}
  Remove-Item -LiteralPath $root -Recurse -Force;$report.cleanupConfirmed=$true
 }catch{$report.cleanupError=$_.Exception.Message;$report.pass=$false}
 [IO.File]::WriteAllText((Join-Path $EvidenceRoot 'native.json'),($report|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
if(-not $report.pass){throw ('ANCESTOR_PROBE_FAILED: '+$report.error+' '+$report.cleanupError)}
@{pass=$true;powershellChecks=$report.powershell.checks.Count;hostChecks=$report.host.checks.Count;aclChecks=$aclChecks;otherMetadataWritersRefused=$true;cleanupConfirmed=$true}|ConvertTo-Json -Compress
