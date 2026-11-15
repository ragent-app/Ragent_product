# Disposable hosted SCM acceptance. Synthetic input bytes are deliberately never
# executed: this validates registration, isolation prerequisites and cleanup only.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
   $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or
   $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'OSPQ_DISPOSABLE_RUNNER_REQUIRED'}
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OSPQ_ADMIN_REQUIRED'}
$product='C:\Program Files\Ragent';$data='C:\ProgramData\Ragent';$names=@('Ragent-ControlPlane','Ragent-RunnerSupervisor')
foreach($name in $names){if(Get-CimInstance Win32_Service -Filter "Name='$name'"){throw 'OSPQ_EXISTING_SERVICE_REFUSED'}}
foreach($path in @($product,$data)){if(Test-Path -LiteralPath $path){throw 'OSPQ_EXISTING_INSTALLATION_REFUSED'}}
if(-not $env:RUNNER_TEMP){throw 'OSPQ_TEMP_REQUIRED'}
$evidence=Join-Path $env:RUNNER_TEMP 'owner-service-preparation'
for($cursor=[IO.Path]::GetFullPath($env:RUNNER_TEMP);$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){
  if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'OSPQ_TEMP_REPARSE'}
}
New-Item -ItemType Directory -Path $evidence|Out-Null
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\packaging\windows\prepare-owner-services.ps1'))
$report=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;startedAt=(Get-Date).ToUniversalTime().ToString('o');productionHostTouched=$false;syntheticInputs=$true;installationPerformed=$false;servicesStarted=$false;authorityIssued=$false;sourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant();checks=@();observed=@();refusals=@();cleanupConfirmed=$false}
$marker=Join-Path $product '.owner-service-preparation-qa'
$files=@('Ragent.ServiceHost.exe','payload\node.exe','payload\chat-server.mjs','payload\chat\runner-supervisor-daemon.mjs')
function Invoke-Preparation([switch]$Commit,[switch]$Diagnose){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  $info.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$source+'"'+$(if($Commit){' -Commit'}else{''})
  if($Diagnose){
    $diagnostic=@'
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. '__SOURCE__' -LibraryOnly
$pins=[Collections.Generic.List[IDisposable]]::new();$stage='fresh-state'
try{
  Assert-OwnerServicePreparationFresh
  $stage='input-pins';Open-OwnerServicePreparationInputs $pins
  @{pass=$true;readOnly=$true;stage=$stage}|ConvertTo-Json -Compress
}catch{
  # Public-code location/type only; no file contents, exception text or secrets.
  @{pass=$false;readOnly=$true;stage=$stage;type=$_.Exception.GetType().FullName;baseType=$_.Exception.GetBaseException().GetType().FullName;errorId=$_.FullyQualifiedErrorId;line=$_.InvocationInfo.ScriptLineNumber;command=$_.InvocationInfo.MyCommand.Name}|ConvertTo-Json -Compress
}finally{for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}}
'@
    $diagnostic=$diagnostic.Replace('__SOURCE__',$source.Replace("'","''"))
    $info.Arguments='-NoLogo -NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($diagnostic))
  }
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.EnvironmentVariables.Clear();$info.EnvironmentVariables['SystemRoot']='C:\Windows';$info.EnvironmentVariables['WINDIR']='C:\Windows'
  $proc=[Diagnostics.Process]::Start($info)
  try{if(-not $proc.WaitForExit(90000)){try{$proc.Kill()}catch{};throw 'OSPQ_PREPARATION_TIMEOUT'}
    $text=$proc.StandardOutput.ReadToEnd();$err=$proc.StandardError.ReadToEnd();if($err){throw ('OSPQ_CHILD_STDERR: '+$err)}
    return @{exitCode=$proc.ExitCode;result=($text|ConvertFrom-Json)}
  }finally{$proc.Dispose()}
}
function Observe-PreparedServices {
  foreach($name in $names){
    $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
    if(-not $service -or $service.StartName -ine ('NT SERVICE\'+$name) -or $service.State -cne 'Stopped' -or $service.StartMode -cne 'Disabled' -or $service.ProcessId -ne 0){throw 'OSPQ_NOT_DISABLED_VIRTUAL_SERVICE'}
    $privileges=(& 'C:\Windows\System32\sc.exe' qprivs $name)|Out-String
    if($LASTEXITCODE -ne 0 -or @([regex]::Matches($privileges,'Se[A-Za-z]+Privilege')).Count -ne 1 -or $privileges -notmatch 'SeChangeNotifyPrivilege'){throw 'OSPQ_PRIVILEGES_MISMATCH'}
    $sidType=(& 'C:\Windows\System32\sc.exe' qsidtype $name)|Out-String
    if($LASTEXITCODE -ne 0 -or $sidType -notmatch 'UNRESTRICTED'){throw 'OSPQ_SID_TYPE_MISMATCH'}
    $sid=[Security.Principal.NTAccount]::new('NT SERVICE',$name).Translate([Security.Principal.SecurityIdentifier]).Value
    if($sid -cnotmatch '^S-1-5-80-(\d+-){4}\d+$'){throw 'OSPQ_SID_INVALID'}
    @{name=$name;account=$service.StartName;state=$service.State;startMode=$service.StartMode;pid=$service.ProcessId;command=$service.PathName;sid=$sid;privileges=@('SeChangeNotifyPrivilege');sidType='UNRESTRICTED'}
  }
}
function Get-QaAccessFacts($Acl){
  [ordered]@{owner=$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$Acl.AreAccessRulesProtected;
    rules=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {
      [ordered]@{sid=$_.IdentityReference.Value;mask=[int64]$_.FileSystemRights;type=[int]$_.AccessControlType;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;inherited=$_.IsInherited}
    })}
}
try{
  # Parent directory is born protected, with only admin/SYSTEM write and Users RX.
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')){
    $right=if($sid -eq 'S-1-5-32-545'){'ReadAndExecute'}else{'FullControl'}
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]$right,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  $null=[IO.Directory]::CreateDirectory($product,$acl);[IO.File]::WriteAllText($marker,$env:GITHUB_RUN_ID)
  foreach($directory in @('payload','payload\chat')){$null=[IO.Directory]::CreateDirectory((Join-Path $product $directory),$acl)}
  $fileAcl=[Security.AccessControl.FileSecurity]::new();$fileAcl.SetAccessRuleProtection($true,$false);$fileAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')){
    $right=if($sid -eq 'S-1-5-32-545'){'ReadAndExecute'}else{'FullControl'}
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]$right,[Security.AccessControl.AccessControlType]::Allow))
  }
  foreach($relative in $files){
    $stream=[IO.FileStream]::new((Join-Path $product $relative),[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::WriteData,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$fileAcl)
    try{$bytes=[Text.Encoding]::UTF8.GetBytes('SYNTHETIC-NONEXECUTABLE-OWNER-SERVICE-QA');$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
  }
  $hashes=@($files|ForEach-Object {(Get-FileHash -LiteralPath (Join-Path $product $_) -Algorithm SHA256).Hash})
  $plan=Invoke-Preparation
  $report.plan=$plan
  if($plan.exitCode -ne 0){$report.diagnostic=Invoke-Preparation -Diagnose}
  if($plan.exitCode -ne 0 -or -not $plan.result.readOnly -or $plan.result.servicesPrepared){throw 'OSPQ_PLAN_FAILED'}
  foreach($name in $names){if(Get-CimInstance Win32_Service -Filter "Name='$name'"){throw 'OSPQ_PLAN_MUTATED'}}
  $report.checks+='default-plan-no-services'
  $null=[IO.Directory]::CreateDirectory($data,$acl)
  $dataMarker=Join-Path $data '.owner-service-preparation-qa'
  [IO.File]::WriteAllText($dataMarker,$env:GITHUB_RUN_ID)
  try{
    $refused=Invoke-Preparation -Commit
    $report.refusals+=@{case='existing-data';observation=$refused}
    if($refused.exitCode -ne 1 -or $refused.result.code -cne 'OSP_EXISTING_DATA_REFUSED' -or $refused.result.lockRetained -or [IO.File]::ReadAllText($dataMarker) -cne $env:GITHUB_RUN_ID){throw 'OSPQ_EXISTING_DATA_ADOPTED'}
  }finally{[IO.File]::Delete($dataMarker);[IO.Directory]::Delete($data,$false)}
  $report.checks+='existing-data-refused-preserved'
  # Retained transactions and multiply-linked inputs cannot be adopted. Only
  # synthetic files owned by this fresh guest are changed by these fixtures.
  $prepareLock=Join-Path $product 'owner-services.prepare-lock'
  [IO.File]::WriteAllText($prepareLock,'SYNTHETIC-RETAINED-TRANSACTION')
  $refused=Invoke-Preparation -Commit
  $report.refusals+=@{case='retained-lock';observation=$refused}
  if($refused.exitCode -ne 1 -or $refused.result.code -cne 'OSP_PREPARATION_INCOMPLETE' -or [IO.File]::ReadAllText($prepareLock) -cne 'SYNTHETIC-RETAINED-TRANSACTION'){throw 'OSPQ_RETAINED_LOCK_ADOPTED'}
  [IO.File]::Delete($prepareLock);$report.checks+='retained-lock-refused-preserved'
  $alias=Join-Path $product 'payload\node-alias.exe'
  New-Item -ItemType HardLink -Path $alias -Target (Join-Path $product 'payload\node.exe')|Out-Null
  try{
    $refused=Invoke-Preparation -Commit
    $report.refusals+=@{case='hardlink';observation=$refused}
    if($refused.exitCode -ne 1 -or $refused.result.code -cne 'OBD_FILE_IDENTITY_INVALID' -or $refused.result.lockRetained){throw 'OSPQ_HARDLINK_ADOPTED'}
  }finally{[IO.File]::Delete($alias)}
  $report.checks+='multiply-linked-input-refused'
  $nodeFile=Join-Path $product 'payload\node.exe';$savedAcl=[IO.File]::GetAccessControl($nodeFile)
  $badAcl=[IO.File]::GetAccessControl($nodeFile)
  $badAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Allow))
  [IO.File]::SetAccessControl($nodeFile,$badAcl)
  try{
    $refused=Invoke-Preparation -Commit
    $report.refusals+=@{case='foreign-write';observation=$refused}
    if($refused.exitCode -ne 1 -or $refused.result.code -cne 'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY' -or $refused.result.lockRetained){throw 'OSPQ_WRITABLE_INPUT_ADOPTED'}
  }finally{
    # FileSystemSecurity persists only modified sections. A GetAccessControl
    # snapshot has no dirty sections, so writing it directly would be a no-op.
    $restoreAcl=[Security.AccessControl.FileSecurity]::new()
    $restoreAcl.SetSecurityDescriptorSddlForm($savedAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access)
    [IO.File]::SetAccessControl($nodeFile,$restoreAcl)
    $actualAcl=[IO.File]::GetAccessControl($nodeFile)
    # SetSecurityInfo can add the informational AUTO_INHERITED control bit to
    # an otherwise identical protected DACL. Compare every security-relevant
    # owner/protection/ACE fact, retaining both SDDLs for independent review.
    $expectedFacts=Get-QaAccessFacts $savedAcl;$actualFacts=Get-QaAccessFacts $actualAcl
    $same=($expectedFacts|ConvertTo-Json -Depth 6 -Compress) -ceq ($actualFacts|ConvertTo-Json -Depth 6 -Compress)
    $report.daclRestore=@{expectedSddl=$savedAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);actualSddl=$actualAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);expected=$expectedFacts;actual=$actualFacts;permissionsPreserved=$same}
    if(-not $same){throw 'OSPQ_DACL_RESTORE_FAILED'}
  }
  $report.checks+='foreign-writable-input-refused'
  # Exercise the actual native handle-based rollback primitive separately from
  # a successful transaction. This is not an injected transaction-failure test.
  . $source -LibraryOnly
  Initialize-OwnerServiceRegistrationType
  $rollback=[RagentOwnerServiceRegistration]::new('Ragent-RunnerSupervisor',$plan.result.plan[0].command,$null)
  try{$rollback.RestrictPrivileges();$rollback.Rollback()}finally{$rollback.Dispose()}
  if(Get-CimInstance Win32_Service -Filter "Name='Ragent-RunnerSupervisor'"){throw 'OSPQ_ROLLBACK_SERVICE_REMAINS'}
  $report.checks+='actual-created-handle-rollback'
  $prepared=Invoke-Preparation -Commit
  $report.prepared=$prepared
  if($prepared.exitCode -ne 0 -or -not $prepared.result.servicesPrepared -or $prepared.result.servicesActivated -or $prepared.result.migrationReady){throw ('OSPQ_COMMIT_FAILED: '+($prepared|ConvertTo-Json -Depth 5 -Compress))}
  $report.observed=@(Observe-PreparedServices)
  if($report.observed[0].sid -ceq $report.observed[1].sid){throw 'OSPQ_SIDS_NOT_DISTINCT'}
  $report.checks+='actual-disabled-distinct-virtual-services'
  $again=Invoke-Preparation -Commit
  $report.refusals+=@{case='existing-services';observation=$again}
  if($again.exitCode -ne 1 -or $again.result.code -cne 'OSP_EXISTING_SERVICE_REFUSED' -or $again.result.lockRetained){throw 'OSPQ_REENTRY_NOT_REFUSED'}
  if(($report.observed|ConvertTo-Json -Depth 5 -Compress) -cne (@(Observe-PreparedServices)|ConvertTo-Json -Depth 5 -Compress)){throw 'OSPQ_REENTRY_MUTATED'}
  $report.checks+='existing-installation-refused-unchanged'
  $after=@($files|ForEach-Object {(Get-FileHash -LiteralPath (Join-Path $product $_) -Algorithm SHA256).Hash})
  if(($hashes -join ',') -cne ($after -join ',')){throw 'OSPQ_INPUT_CHANGED'}
  if(Test-Path -LiteralPath $data){throw 'OSPQ_DATA_CREATED'}
  $report.checks+='input-hashes-preserved-no-data-or-credentials'
  $report.pass=$true
}catch{$report.error=$_.Exception.GetBaseException().Message;$report.pass=$false}
finally{
  try{
    # Delete only this guest's observed fixed services. No broad process kills.
    foreach($name in $names){
      $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
      if($service){
        if($service.StartName -ine ('NT SERVICE\'+$name) -or $service.State -cne 'Stopped' -or $service.ProcessId -ne 0 -or -not $service.PathName.StartsWith(('"'+$product+'\Ragent.ServiceHost.exe"'),[StringComparison]::Ordinal)){throw 'OSPQ_CLEANUP_OWNERSHIP_REFUSED'}
        $service=$null;& 'C:\Windows\System32\sc.exe' delete $name|Out-Null;if($LASTEXITCODE -ne 0){throw 'OSPQ_DELETE_FAILED'}
      }
    }
    for($attempt=0;$attempt -lt 30;$attempt++){
      $left=@($names|ForEach-Object {Get-CimInstance Win32_Service -Filter "Name='$_'"})
      if($left.Count -eq 0){break};Start-Sleep -Milliseconds 200
    }
    if($left.Count){throw 'OSPQ_SERVICE_REMAINS'}
    $dataMarker=Join-Path $data '.owner-service-preparation-qa'
    if(Test-Path -LiteralPath $data){
      if((Get-Item -LiteralPath $data -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or [IO.File]::ReadAllText($dataMarker) -cne $env:GITHUB_RUN_ID){throw 'OSPQ_DATA_OWNERSHIP_REFUSED'}
      [IO.File]::Delete($dataMarker);[IO.Directory]::Delete($data,$false)
    }
    if((Get-Item -LiteralPath $product -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or [IO.File]::ReadAllText($marker) -cne $env:GITHUB_RUN_ID){throw 'OSPQ_ROOT_OWNERSHIP_REFUSED'}
    foreach($relative in ($files+@('payload\node-alias.exe'))){[IO.File]::Delete((Join-Path $product $relative))}
    [IO.File]::Delete((Join-Path $product 'owner-services.prepare-lock'));[IO.File]::Delete($marker)
    # No recursive deletion or foreign data traversal.
    foreach($path in @((Join-Path $product 'payload\chat'),(Join-Path $product 'payload'),$product)){[IO.Directory]::Delete($path,$false)}
    if(Test-Path -LiteralPath $data){throw 'OSPQ_DATA_REMAINS'}
    $report.cleanupConfirmed=$true
  }catch{$report.cleanupError=$_.Exception.GetBaseException().Message;$report.pass=$false}
  $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
  [IO.File]::WriteAllText((Join-Path $evidence 'report.json'),($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
$report|ConvertTo-Json -Depth 8 -Compress
if(-not $report.pass){exit 1}
