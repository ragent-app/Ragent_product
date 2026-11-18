# Read-only trust inspector. Default execution has fixed installed paths only.
[CmdletBinding()]
param([switch]$LibraryOnly,[ValidateSet('cli','browser','activation')][string]$Purpose='cli')
$ErrorActionPreference='Stop'
function Get-OwnerProductRoot {
  $candidate=$env:RAGENT_INSTALL_ROOT
  if([string]::IsNullOrWhiteSpace($candidate)){$candidate=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'Ragent'}
  if($candidate -notmatch '\A[A-Za-z]:\\'){throw 'OBD_INSTALL_ROOT_INVALID'}
  $full=[IO.Path]::GetFullPath($candidate).TrimEnd('\')
  if($full.Length -le 2){throw 'OBD_INSTALL_ROOT_INVALID'}
  return $full
}
function Get-OwnerProgramDataPath {
  $path=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  if([string]::IsNullOrWhiteSpace($path) -or $path -notmatch '\A[A-Za-z]:\\'){throw 'OBD_PROGRAMDATA_UNAVAILABLE'}
  return [IO.Path]::GetFullPath($path).TrimEnd('\')
}
function Get-OwnerDataRoot { return Join-Path (Get-OwnerProgramDataPath) 'Ragent' }
function Get-OwnerInstanceRoot { return Join-Path (Get-OwnerDataRoot) 'instances\owner' }
if(-not ('RagentOwnerFilePin' -as [type])){
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RagentOwnerFilePin {
 [StructLayout(LayoutKind.Sequential)] struct Info {public uint attributes;public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder p,uint size,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle h,StringBuilder name,uint size,out uint serial,out uint maximum,out uint flags,StringBuilder filesystem,uint fsSize);
 public static SafeFileHandle Directory(string path) {
  // LIST_DIRECTORY participates in sharing checks; attribute-only handles do
  // not reserve DELETE sharing and therefore do not reliably pin a name.
  var handle=CreateFile(path,0x81,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
  try {Verify(handle,path,true);return handle;}catch{handle.Dispose();throw;}
 }
 public static SafeFileHandle[] NonemptyDirectory(string path,string child) {
  path=Path.GetFullPath(path);child=Path.GetFullPath(child);
  if(!String.Equals(Path.GetDirectoryName(child),path.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("OBD_ANCESTOR_WITNESS_INVALID");
  var parent=Directory(path);SafeFileHandle witness=null;
  try {
   witness=Directory(child);Verify(parent,path,true);
   uint serial,maximum,flags;var fs=new StringBuilder(32);
   if(!GetVolumeInformationByHandleW(parent,null,0,out serial,out maximum,out flags,fs,32)||fs.ToString()!="NTFS")throw new IOException("OBD_ANCESTOR_WITNESS_INVALID");
   // No DELETE sharing on either handle. The retained immediate child keeps
   // the NTFS parent nonempty; SET_REPARSE_POINT must fail DIRECTORY_NOT_EMPTY.
   return new[]{parent,witness};
  }catch{if(witness!=null)witness.Dispose();parent.Dispose();throw;}
 }
 public static void Verify(SafeFileHandle handle,string path,bool directory) {
  Info info;var final=new StringBuilder(32768);
  uint length=GetFinalPathNameByHandle(handle,final,(uint)final.Capacity,0);
  if(handle.IsInvalid||!GetFileInformationByHandle(handle,out info)||(info.attributes&0x400)!=0||(!directory&&info.links!=1)
    ||((info.attributes&16)!=0)!=directory||length==0||length>=final.Capacity
    ||!String.Equals(final.ToString(),@"\\?\"+Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase))throw new IOException("OBD_FILE_IDENTITY_INVALID");
 }
}
'@
}
function Get-OwnerDigest([byte[]]$Bytes){$qaSha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($qaSha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$qaSha.Dispose()}}
function Get-OwnerAdministrativeSids {
  # Service SIDs are stable, not localized account names. LookupAccountName can
  # fail on a clean Windows image even while ACLs contain TrustedInstaller SID.
  # https://learn.microsoft.com/en-us/archive/msdn-magazine/2008/november/access-control-understanding-windows-file-and-registry-permissions
  @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
}
function Get-OwnerSigner([string]$Path){
  $qaSignature=Get-AuthenticodeSignature -LiteralPath $Path
  $qaPublisher=if($qaSignature.SignerCertificate){Get-OwnerDigest $qaSignature.SignerCertificate.RawData}else{''}
  return @{status=[string]$qaSignature.Status;publisherSha256=$qaPublisher}
}
function Assert-OwnerReleaseManifest($Release){
  $trustKey=if($Release.version -eq 2){'trustMode'}else{'publisherSha256'};$expected=@('version','protocolVersion','helperFile','helperSha256',$trustKey)
  # ConvertFrom-Json emits Int64 for ordinary JSON integers in PowerShell 7;
  # accept only integral CLR types while keeping range/schema validation strict.
  $versionIsInteger=$Release.version -is [int] -or $Release.version -is [long]
  $protocolVersionIsInteger=$Release.protocolVersion -is [int] -or $Release.protocolVersion -is [long]
  if(@($Release.PSObject.Properties).Count -ne 5 -or @($Release.PSObject.Properties.Name|Where-Object {$_ -cnotin $expected}).Count -or
    -not $versionIsInteger -or $Release.version -notin @(1,2) -or -not $protocolVersionIsInteger -or $Release.protocolVersion -notin @(1,2) -or
    $Release.helperFile -cne 'Ragent.OwnerBootstrap.exe' -or $Release.helperSha256 -isnot [string] -or $Release.helperSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or
    ($Release.version -eq 2 -and ($Release.trustMode -cne 'admin-installed-sha256' -or $Release.protocolVersion -ne 2)) -or
    ($Release.version -eq 1 -and ($Release.publisherSha256 -isnot [string] -or $Release.publisherSha256 -cnotmatch '\A[a-f0-9]{64}\z'))){throw 'OBD_RELEASE_MISMATCH'}
}
# Call only after the fixed manifest/helper and their ancestors have been pinned
# and protected installation objects verified. v2 makes no publisher claim.
function Get-OwnerReleaseTrust($Release,[byte[]]$Helper,[string]$Path){
  Assert-OwnerReleaseManifest $Release;$digest=Get-OwnerDigest $Helper
  if($Release.helperSha256 -cne $digest){throw 'OBD_RELEASE_MISMATCH'}
  if($Release.version -eq 2){return @{version=2;helperSha256=$digest;trustMode='admin-installed-sha256'}}
  $signer=Get-OwnerSigner $Path
  if($signer.status -cne 'Valid' -or $signer.publisherSha256 -cne $Release.publisherSha256){throw 'OBD_INSTALL_TRUST_FAILED'}
  return @{version=1;helperSha256=$digest;signatureStatus=$signer.status;publisherSha256=$signer.publisherSha256}
}
function Assert-OwnerPreparedRelease([Collections.Generic.List[IDisposable]]$Pins){
  $path=Join-Path (Get-OwnerProductRoot) 'payload\owner-bootstrap-release.json'
  if(-not(Test-Path -LiteralPath $path)){return}
  $admin=@(Get-OwnerAdministrativeSids);$bytes=Read-OwnerPinnedFile $path $admin $Pins
  $release=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json
  # New packaged administrative manifests are valid before first identity
  # initialization. A legacy active signed manifest is never silently adopted.
  if($release.version -ne 2){throw 'OBD_PREPARED_RELEASE_REFUSED'}
  $helperPath=Join-Path (Get-OwnerProductRoot) 'payload\Ragent.OwnerBootstrap.exe'
  $helper=Read-OwnerPinnedFile $helperPath $admin $Pins 4194304
  $null=Get-OwnerReleaseTrust $release $helper $helperPath
}
function Assert-OwnerObjectAcl([string]$Path,[string[]]$Allowed,[switch]$Ancestor,[Collections.Generic.List[IDisposable]]$Pins){
  $qaAcl=Get-Acl -LiteralPath $Path
  if($qaAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $Allowed){throw 'OBD_OBJECT_OWNER_UNTRUSTED'}
  # Conservative allow-ACE rejection, including deny-reduced rights. A parent
  # may permit new subdirectories; it may not replace/delete pinned objects.
  # ADD_FILE also authorizes SET_REPARSE_POINT; generic WRITE/ALL must not
  # disappear merely because a raw ACE has not expanded its generic bits.
  $qaMask=if($Ancestor){0x500d0152}else{0x500d0156}
  # Request the raw SID target type. PowerShell's display-name Access property
  # can return names that LSA cannot translate back on a clean/minimal image.
  # Unknown SIDs still have every allow mask checked; none are skipped.
  $qaNeedsWitness=$false
  foreach($qaAce in $qaAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($qaAce.AccessControlType -eq 'Allow' -and -not ($qaAce.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){
      $qaSid=$qaAce.IdentityReference.Value
      if($qaSid -notin $Allowed -and ([int64]$qaAce.FileSystemRights -band $qaMask)){
        # Only the fixed OS ProgramData ancestor may have metadata writers.
        # DELETE/DELETE_CHILD/WRITE_DAC/WRITE_OWNER always refuse. Metadata
        # writers can set reparse points, so ACL ownership alone is insufficient.
        if(-not $Ancestor -or [IO.Path]::GetFullPath($Path).TrimEnd('\') -ine (Get-OwnerProgramDataPath) -or ([int64]$qaAce.FileSystemRights -band 0x500d0040)){throw 'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY'}
        $qaNeedsWitness=$true
      }
    }
  }
  if($qaNeedsWitness){
    if($null -eq $Pins){throw 'OBD_ANCESTOR_WITNESS_REQUIRED'}
    $qaProgramData=Get-OwnerProgramDataPath
    foreach($qaHandle in [RagentOwnerFilePin]::NonemptyDirectory($qaProgramData,(Join-Path $qaProgramData 'Microsoft'))){$Pins.Add($qaHandle)}
  }
}
function Test-ExternalProductAncestor([string]$InputPath,[string]$AncestorPath){
  $product=[IO.Path]::GetFullPath((Get-OwnerProductRoot)).TrimEnd('\')
  $inputFull=[IO.Path]::GetFullPath($InputPath)
  $data=[IO.Path]::GetFullPath((Get-OwnerDataRoot)).TrimEnd('\')
  if($inputFull -ieq $data -or $inputFull.StartsWith($data+'\',[StringComparison]::OrdinalIgnoreCase)){return $false}
  $ancestor=[IO.Path]::GetFullPath($AncestorPath).TrimEnd('\')
  $inputs=@('payload\owner-bootstrap-release.json','payload\Ragent.OwnerBootstrap.exe','Ragent.ServiceHost.exe','payload\node.exe','payload\chat-server.mjs','payload\chat\runner-supervisor-daemon.mjs','owner-msi.prepared.json','owner-msi.policy.json','owner-msi.removed.json','owner-msi.prevalidation-lock','owner-msi.prepare-lock','owner-msi.prepared.activated.json','owner-msi.policy.activated.json','owner-msi.activated.json','owner-msi.activation-health.json','owner-activation.prepare-lock','owner-activation.committed-lock','owner-policy.prepare-lock','owner-msi.upgrade-transaction.json','payload\scripts\initialize-windows-owner-identity.mjs','payload\lib\instance-identity.mjs','payload\lib\instance-proof-protocol.mjs','payload\lib\windows-owner-identity-paths.mjs') | ForEach-Object {[IO.Path]::GetFullPath((Join-Path $product $_))}
  $leaf=[IO.Path]::GetFileName($inputFull)
  $archive=([IO.Path]::GetDirectoryName($inputFull) -ieq $product) -and $leaf -cmatch '^owner-(?:msi\.(?:prepared\.activated|policy\.activated|activated|activation-health)\.json|activation\.committed-lock)\.previous-[a-f0-9]{32}$'
  return (($inputs -icontains $inputFull) -or $archive) -and $product.StartsWith($ancestor+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Read-OwnerPinnedFile([string]$Path,[string[]]$Allowed,[Collections.Generic.List[IDisposable]]$Pins,[int]$Maximum=8192,[string[]]$AncestorAllowed=$null){
  if($null -eq $AncestorAllowed){$AncestorAllowed=$Allowed}
  $qaPath=[IO.Path]::GetFullPath($Path)
  for($qaParent=[IO.Path]::GetDirectoryName($qaPath);$qaParent;$qaParent=[IO.Path]::GetDirectoryName($qaParent)){
    $qaPin=[RagentOwnerFilePin]::Directory($qaParent);$Pins.Add($qaPin)
    if(-not (Test-ExternalProductAncestor $qaPath $qaParent)){Assert-OwnerObjectAcl $qaParent $AncestorAllowed -Ancestor -Pins $Pins}
  }
  $qaFile=[IO.FileStream]::new($qaPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $Pins.Add($qaFile);[RagentOwnerFilePin]::Verify($qaFile.SafeFileHandle,$qaPath,$false)
  Assert-OwnerObjectAcl $qaPath $Allowed
  if($qaFile.Length -lt 1 -or $qaFile.Length -gt $Maximum){throw 'OBD_FILE_SIZE_INVALID'}
  $qaBytes=[byte[]]::new([int]$qaFile.Length);$qaOffset=0
  while($qaOffset -lt $qaBytes.Length){$qaCount=$qaFile.Read($qaBytes,$qaOffset,$qaBytes.Length-$qaOffset);if(-not $qaCount){throw 'OBD_FILE_READ_FAILED'};$qaOffset+=$qaCount}
  return ,$qaBytes
}
function Get-OwnerBootstrapLivePath([string]$RequestedPurpose){
  switch -CaseSensitive ($RequestedPurpose){
    'cli' {return Join-Path (Get-OwnerInstanceRoot) 'runtime\owner-bootstrap-cli-live.json'}
    'browser' {return Join-Path (Get-OwnerInstanceRoot) 'runtime\owner-bootstrap-browser-live.json'}
    default {throw 'OBD_PURPOSE_INVALID'}
  }
}
function Assert-OwnerPolicyInstallComplete([string]$InstanceRoot=(Get-OwnerInstanceRoot)){
  foreach($marker in @('owner-services.prepare-lock','owner-data.prepare-lock','owner-msi.prepare-lock','owner-identity.initialize-lock','owner-msi.prepared.json','owner-activation.prepare-lock','owner-policy.prepare-lock','owner-msi.policy.json')){
    if(Test-Path -LiteralPath (Join-Path (Get-OwnerProductRoot) $marker)){throw 'OBD_INSTALL_INCOMPLETE'}
  }
  if(Test-Path -LiteralPath (Join-Path $InstanceRoot 'owner-policy.install-lock')){throw 'OBD_INSTALL_INCOMPLETE'}
}
function Read-InstalledOwnerBootstrap {
  $qaPins=[Collections.Generic.List[IDisposable]]::new()
  try{
    Assert-OwnerPolicyInstallComplete
    $qaAdmin=@(Get-OwnerAdministrativeSids)
    $qaReleasePath=Join-Path (Get-OwnerProductRoot) 'payload\owner-bootstrap-release.json'
    if(-not(Test-Path -LiteralPath $qaReleasePath)){throw 'OBD_RELEASE_NOT_INSTALLED'}
    $qaRelease=Read-OwnerPinnedFile $qaReleasePath $qaAdmin $qaPins
    $qaInstallPath=Join-Path (Get-OwnerInstanceRoot) 'security\owner-bootstrap-install.json'
    if(-not(Test-Path -LiteralPath $qaInstallPath)){throw 'OBD_INSTALL_POLICY_MISSING'}
    $qaInstall=Read-OwnerPinnedFile $qaInstallPath $qaAdmin $qaPins
    $qaInstallObject=([Text.UTF8Encoding]::new($false,$true)).GetString($qaInstall)|ConvertFrom-Json
    if($qaInstallObject.controlSid -cnotmatch '^S-1-5-80-(\d+-){4}\d+$'){throw 'OBD_INSTALL_POLICY_INVALID'}
    if($Purpose -cne 'activation'){
      $qaLivePath=Get-OwnerBootstrapLivePath $Purpose
      if(-not(Test-Path -LiteralPath $qaLivePath)){throw 'OBD_ENDPOINT_UNAVAILABLE'}
      $qaLive=Read-OwnerPinnedFile $qaLivePath ($qaAdmin+@($qaInstallObject.controlSid)) $qaPins
    }
    $qaHelperPath=Join-Path (Get-OwnerProductRoot) 'payload\Ragent.OwnerBootstrap.exe'
    $qaHelper=Read-OwnerPinnedFile $qaHelperPath $qaAdmin $qaPins 4194304
    $qaReleaseObject=([Text.UTF8Encoding]::new($false,$true)).GetString($qaRelease)|ConvertFrom-Json
    $qaObserved=Get-OwnerReleaseTrust $qaReleaseObject $qaHelper $qaHelperPath
    $qaObserved+=@{aclVerified=$true;
      ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;ownerSessionId=(Get-Process -Id $PID).SessionId;
      releaseJson=([Text.UTF8Encoding]::new($false,$true)).GetString($qaRelease);installationJson=([Text.UTF8Encoding]::new($false,$true)).GetString($qaInstall)}
    if($Purpose -cne 'activation'){$qaObserved.liveJson=([Text.UTF8Encoding]::new($false,$true)).GetString($qaLive)}
    return $qaObserved
  }finally{for($qaIndex=$qaPins.Count-1;$qaIndex -ge 0;$qaIndex--){$qaPins[$qaIndex].Dispose()}}
}
if(-not $LibraryOnly){
  try{Read-InstalledOwnerBootstrap|ConvertTo-Json -Compress -Depth 12}
  catch{
    $qaCode=if($_.Exception.Message -cmatch '^OBD_[A-Z_]+$'){$_.Exception.Message}else{'OBD_INSPECTION_FAILED'}
    @{ok=$false;code=$qaCode}|ConvertTo-Json -Compress
  }
}
