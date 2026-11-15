# Read-only installed-state inventory. Never opens credential file contents,
# connects to Owner IPC, or calls service/ACL/registry mutation commands.
$ErrorActionPreference='Stop'
$qaSystemRoot=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$qaProduct=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'Ragent'
$qaData=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'Ragent'
$qaInstance=Join-Path $qaData 'instances\owner'
function Get-ServiceInventory {
  foreach($qaRole in @('control','supervisor')){
    $qaName=if($qaRole -eq 'control'){'Ragent-ControlPlane'}else{'Ragent-RunnerSupervisor'}
    $qaService=Get-CimInstance Win32_Service -Filter "Name='$qaName'"
    $qaSid=$null
    if($qaService){try{$qaSid=[Security.Principal.NTAccount]::new('NT SERVICE',$qaName).Translate([Security.Principal.SecurityIdentifier]).Value}catch{}}
    $qaCommand=[string]$qaService.PathName
    $qaDigest=[Security.Cryptography.SHA256]::Create()
    try{$qaCommandHash=([BitConverter]::ToString($qaDigest.ComputeHash([Text.Encoding]::UTF8.GetBytes($qaCommand)))).Replace('-','').ToLowerInvariant()}finally{$qaDigest.Dispose()}
    [ordered]@{name=$qaName;role=$qaRole;present=($null -ne $qaService);configuredAccount=$qaService.StartName;state=$qaService.State;
      pid=$qaService.ProcessId;startMode=$qaService.StartMode;serviceSid=$qaSid;commandSha256=$qaCommandHash;
      commandUsesOwnedHost=$qaCommand.StartsWith(('"'+(Join-Path $qaProduct 'Ragent.ServiceHost.exe')+'"'),[StringComparison]::OrdinalIgnoreCase);
      expectedVirtualAccount=('NT SERVICE\'+$qaName);tokenDirectlyVerified=$false}
  }
}
function Get-PathInventory([string]$Label,[string]$Path){
  $qaRecord=[ordered]@{label=$Label;path=$Path;present=$false;aclRead=$false}
  try{
    $qaItem=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $qaRecord.present=$true;$qaRecord.reparse=[bool]($qaItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
    if($qaRecord.reparse){$qaRecord.error='REPARSE_PATH_NOT_FOLLOWED';return $qaRecord}
    # Check each ancestor before Get-Acl; do not traverse a redirected control root.
    for($qaCursor=[IO.Path]::GetDirectoryName($Path);$qaCursor;$qaCursor=[IO.Path]::GetDirectoryName($qaCursor)){
      if((Get-Item -LiteralPath $qaCursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){$qaRecord.error='REPARSE_ANCESTOR_NOT_FOLLOWED';return $qaRecord}
    }
    # Use inbox .NET APIs: a PS7 caller can supply a PSModulePath that makes
    # PS5.1 Get-Acl autoload fail. Do not mistake that for access denial.
    $qaAcl=if($qaItem.PSIsContainer){[IO.Directory]::GetAccessControl($Path)}else{[IO.File]::GetAccessControl($Path)}
    $qaRecord.ownerSid=$qaAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $qaRecord.protected=$qaAcl.AreAccessRulesProtected;$qaRecord.sddl=$qaAcl.Sddl
    $qaRecord.rules=@($qaAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {
      [ordered]@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();mask=[int64]$_.FileSystemRights;inherited=$_.IsInherited;
        inheritance=$_.InheritanceFlags.ToString();propagation=$_.PropagationFlags.ToString()}
    })
    $qaRecord.aclRead=$true
  }catch [System.Management.Automation.ItemNotFoundException]{$qaRecord.error='MISSING'}
  catch{$qaRecord.error='METADATA_UNAVAILABLE';$qaRecord.errorType=$_.Exception.GetType().Name;$qaRecord.errorId=$_.FullyQualifiedErrorId}
  return $qaRecord
}
$qaPaths=@(
  @('control-config',(Join-Path $qaInstance 'config')),
  @('control-auth-key',(Join-Path $qaInstance 'config\auth-session-secret')),
  @('instance-runtime',(Join-Path $qaInstance 'runtime')),
  @('run-spool',(Join-Path $qaInstance 'data\chat-runs')),
  @('provider-homes',(Join-Path $qaInstance 'provider-homes')),
  @('harness-root',(Join-Path $qaData 'harnesses')),
  @('installed-host',(Join-Path $qaProduct 'Ragent.ServiceHost.exe'))
)
$qaBefore=@(Get-ServiceInventory)
$qaSnapshot=[ordered]@{schemaVersion=1;capturedAt=(Get-Date).ToString('o');readOnly=$true;credentialContentsRead=$false;
  ownerIpcConnected=$false;actualTokenInspection=$false;services=$qaBefore;paths=@($qaPaths|ForEach-Object {Get-PathInventory $_[0] $_[1]});
  serviceObservationAfter=@(Get-ServiceInventory)}
$qaSnapshot|ConvertTo-Json -Depth 7 -Compress
