# Fixed elevated canary. Never modifies production services, config or ACLs.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BundleRoot,
      [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSEdition -ne 'Desktop'){throw 'Use the fixed inbox Windows PowerShell host'}
$qaIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not ([Security.Principal.WindowsPrincipal]::new($qaIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator token required for isolated SCM canary'}
function Assert-NoReparse([string]$Target){
  $qaCursor=[IO.Path]::GetFullPath($Target)
  while($qaCursor){if((Get-Item -LiteralPath $qaCursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse input rejected'};$qaCursor=[IO.Path]::GetDirectoryName($qaCursor)}
}
function Get-QaServiceNames {
  param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$CaseId)
  # Interpolation avoids PowerShell '+' / ',' array-expression precedence.
  @("Ragent-IdentityQA-Control-$CaseId", "Ragent-IdentityQA-Executor-$CaseId")
}
Assert-NoReparse $BundleRoot
$qaManifestFile=Join-Path $BundleRoot 'manifest.json'
$qaBytes=[IO.File]::ReadAllBytes($qaManifestFile)
$qaHash=[Security.Cryptography.SHA256]::Create()
try{$qaActual=([BitConverter]::ToString($qaHash.ComputeHash($qaBytes))).Replace('-','').ToLowerInvariant()}finally{$qaHash.Dispose()}
if($qaActual -cne $ManifestSha256){throw 'Pinned manifest mismatch'}
$qaSpec=[Text.Encoding]::UTF8.GetString($qaBytes)|ConvertFrom-Json
$qaRuntimeFiles=@('node.exe','probe.mjs','IdentityCanary.exe')
$qaOwnerHashes=@{}
if($qaSpec.crossServiceIpc){$qaRuntimeFiles+=@('RunPipeCandidate.exe','chat/restricted-run-ipc.mjs','tests/helpers/windows-run-pipe-fixture.mjs','tests/fixtures/windows-service-run-ipc-probe.mjs')}
if($qaSpec.crossServiceProvider){$qaRuntimeFiles+=@('RestrictedProviderCandidate.exe','claude.exe','tests/fixtures/windows-service-provider-worker.mjs','tests/fixtures/windows-service-provider-probe.mjs')}
if(($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){
  $qaOwnerIndex=Join-Path $BundleRoot 'owner-files.json'
  if((Get-FileHash -LiteralPath $qaOwnerIndex -Algorithm SHA256).Hash.ToLowerInvariant() -cne $qaSpec.'owner-files.json'){throw 'Owner source index hash mismatch'}
  $qaOwnerRows=@(([IO.File]::ReadAllText($qaOwnerIndex)|ConvertFrom-Json).files)
  $qaOwnerLimit=if($qaSpec.crossServiceCredentialChannel){768}else{200}
  if($qaOwnerRows.Count -lt 1 -or $qaOwnerRows.Count -gt $qaOwnerLimit){throw 'Owner source index invalid'}
  foreach($qaRow in $qaOwnerRows){if($qaRow.path -match '\.\.' -or $qaRow.path -cnotmatch '^(?:package\.json|tests/fixtures/(?:windows-service-owner-bootstrap-probe|windows-service-owner-purpose-probe|windows-service-owner-set-probe|windows-service-owner-activation-probe|windows-service-credential-channel-probe|windows-service-provider-provision|local-control-authority)\.mjs|chat/prompt-assets/(?:runtime|system|turn)/[a-zA-Z0-9_-]+\.(?:md|txt)|(?:lib|chat)/[a-zA-Z0-9_./-]+\.mjs|node_modules/[a-zA-Z0-9_@./-]+\.(?:js|mjs|cjs|json))$'){throw 'Owner source index path rejected'}
    if($qaRow.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $qaOwnerHashes.ContainsKey($qaRow.path)){throw 'Owner source index hash or duplicate rejected'}
    $qaOwnerHashes[$qaRow.path]=$qaRow.sha256}
  $qaOwnerRuntime=if($qaSpec.crossServiceCredentialChannel){@('RunCredentialChannel.exe','owner-files.json')}else{@('OwnerBootstrap.exe','OwnerBootstrapRaw.exe','owner-files.json')}
  if($qaSpec.ownerActivation){$qaOwnerRuntime+=@('OwnerActivationRaw.exe')}
  $qaRuntimeFiles+=@($qaOwnerRuntime)+@($qaOwnerRows|ForEach-Object {$_.path})
}
$qaRuntimeFiles=@($qaRuntimeFiles|Select-Object -Unique)
if($qaSpec.caseId -cnotmatch '^[a-f0-9]{32}$' -or $qaSpec.requestorSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'Invalid canary identity'}
$qaParent=Join-Path $env:ProgramData 'RagentIdentityQA'
$qaRoot=Join-Path $qaParent ('case-'+$qaSpec.caseId)
$qaNames=@(Get-QaServiceNames -CaseId $qaSpec.caseId)
if($qaNames.Count -ne 2 -or $qaNames[0] -ceq $qaNames[1] -or @($qaNames|Where-Object {$_ -cnotmatch '^Ragent-IdentityQA-(Control|Executor)-[a-f0-9]{32}$'}).Count){throw 'Invalid exact service names'}
foreach($qaName in $qaNames){if(Get-Service -Name $qaName -ErrorAction SilentlyContinue){throw 'Canary service collision; refusing adoption'}}
if(Test-Path -LiteralPath $qaRoot){throw 'Canary root collision; refusing adoption'}
function New-QaAcl([hashtable]$Grants){
  $qaAcl=[Security.AccessControl.DirectorySecurity]::new();$qaAcl.SetAccessRuleProtection($true,$false)
  $qaAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $qaAll=@{'S-1-5-18'='FullControl';'S-1-5-32-544'='FullControl'}
  foreach($qaSid in $Grants.Keys){$qaAll[$qaSid]=$Grants[$qaSid]}
  foreach($qaSid in $qaAll.Keys){$qaAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new($qaSid),[Security.AccessControl.FileSystemRights]$qaAll[$qaSid],
    [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
  return $qaAcl
}
function Set-QaAcl([string]$Target,[hashtable]$Grants){
  Set-Acl -LiteralPath $Target -AclObject (New-QaAcl $Grants)
}
if(-not(Test-Path -LiteralPath $qaParent)){
  [void][IO.Directory]::CreateDirectory($qaParent,(New-QaAcl @{$qaSpec.requestorSid='ReadAndExecute'}))
}
& {
  Assert-NoReparse $qaParent
  $qaParentAcl=Get-Acl -LiteralPath $qaParent
  $qaOwner=$qaParentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($qaOwner -notin @('S-1-5-18','S-1-5-32-544') -or -not $qaParentAcl.AreAccessRulesProtected){throw 'Unsafe existing QA parent'}
  foreach($qaRule in $qaParentAcl.Access){
    $qaRuleSid=$qaRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if($qaRule.AccessControlType -eq 'Allow' -and $qaRuleSid -notin @('S-1-5-18','S-1-5-32-544')){
      $qaWrite=[Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
      if($qaRule.FileSystemRights -band $qaWrite){throw 'Writable existing QA parent'}
    }
  }
}
New-Item -ItemType Directory -Path $qaRoot|Out-Null
Set-QaAcl $qaRoot @{$qaSpec.requestorSid='ReadAndExecute'}
foreach($qaDir in @('runtime','control','workspace','extra-workspace','state','state\control','state\executor','export')){
  [void][IO.Directory]::CreateDirectory((Join-Path $qaRoot $qaDir),(New-QaAcl @{}))
}
if($qaSpec.crossServiceIpc -or ($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){foreach($qaDir in @('runtime\chat','runtime\tests','runtime\tests\helpers','runtime\tests\fixtures','handoff','handoff\control','handoff\executor')){
  [void][IO.Directory]::CreateDirectory((Join-Path $qaRoot $qaDir),(New-QaAcl @{}))
}}
if($qaSpec.crossServiceProvider -or ($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){foreach($qaDir in @('control\inbox','control\outbox')){
  [void][IO.Directory]::CreateDirectory((Join-Path $qaRoot $qaDir),(New-QaAcl @{}))
}}
if($qaSpec.crossServiceProvider){[void][IO.Directory]::CreateDirectory((Join-Path $qaRoot 'state\preparer'),(New-QaAcl @{}))}
$qaReport=[ordered]@{schemaVersion=1;caseId=$qaSpec.caseId;pass=$false;startedAt=(Get-Date).ToString('o');productionChanged=$false;phoneTouched=$false;credentialsUsed=$false;services=@();cleanup=@();root=$qaRoot}
$qaCreated=@()
function Wait-QaJson([string]$Path,[int]$Seconds){
  $qaUntil=(Get-Date).AddSeconds($Seconds)
  while((Get-Date)-lt $qaUntil){
    if(Test-Path -LiteralPath $Path){try{
      $qaRaw=& $qaExe '--read-report' $Path
      if($LASTEXITCODE -ne 0){throw 'Bound report read failed'}
      return ($qaRaw|ConvertFrom-Json)
    }catch{}}
    Start-Sleep -Milliseconds 100
  }
  throw "Canary report timeout: $([IO.Path]::GetFileName($Path))"
}
try{
  foreach($qaFile in $qaRuntimeFiles){
    $qaInput=Join-Path $BundleRoot $qaFile
    Assert-NoReparse $qaInput
    $qaTarget=Join-Path $qaRoot ('runtime\'+$qaFile)
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($qaTarget))
    Copy-Item -LiteralPath $qaInput -Destination $qaTarget
    $qaExpectedHash=if($qaOwnerHashes.ContainsKey($qaFile)){$qaOwnerHashes[$qaFile]}else{$qaSpec.$qaFile}
    if((Get-FileHash -LiteralPath $qaTarget -Algorithm SHA256).Hash.ToLowerInvariant() -cne $qaExpectedHash){throw 'Staged runtime hash mismatch'}
  }
  $qaExe=Join-Path $qaRoot 'runtime\IdentityCanary.exe'
  [IO.File]::WriteAllText((Join-Path $qaRoot '.ragent-identity-qa'),('case-'+$qaSpec.caseId))
  [IO.File]::WriteAllText((Join-Path $qaRoot 'manifest.json'),($qaSpec|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $qaReport.registrations=@()
  for($qaIndex=0;$qaIndex -lt 2;$qaIndex++){
    $qaRole=@('control','executor')[$qaIndex];$qaName=$qaNames[$qaIndex]
    $qaRegistrationRaw=& $qaExe '--register-canary' $qaRoot $qaRole
    if($LASTEXITCODE -ne 0){throw ('Virtual service registration failed: '+($qaRegistrationRaw -join ''))}
    $qaCreated+=$qaName
    $qaRegistration=$qaRegistrationRaw|ConvertFrom-Json
    if(-not $qaRegistration.pass -or $qaRegistration.name -cne $qaName -or $qaRegistration.account -cne ('NT SERVICE\'+$qaName) -or -not $qaRegistration.passwordNull){throw 'Unexpected fixed service registration result'}
    $qaReport.registrations+=$qaRegistration
    & "$env:SystemRoot\System32\sc.exe" privs $qaName SeChangeNotifyPrivilege|Out-Null
    if($LASTEXITCODE -ne 0){throw 'SCM minimum privileges setup failed'}
    $qaAccount=[Security.Principal.NTAccount]::new('NT SERVICE',$qaName)
    $qaSpec|Add-Member -NotePropertyName ($qaRole+'Sid') -NotePropertyValue $qaAccount.Translate([Security.Principal.SecurityIdentifier]).Value -Force
  }
  $qaControl=$qaSpec.controlSid;$qaExecutor=$qaSpec.executorSid
  if($qaSpec.crossServiceProvider){
    $qaPreparerName='Ragent-IdentityQA-Preparer-'+$qaSpec.caseId
    if(Get-Service -Name $qaPreparerName -ErrorAction SilentlyContinue){throw 'QA preparer service collision'}
    $qaPreparerRaw=& $qaExe '--register-canary' $qaRoot 'preparer'
    if($LASTEXITCODE -ne 0){throw 'Fixed desktop preparer registration failed'}
    $qaCreated+=$qaPreparerName
    $qaPreparerRegistration=$qaPreparerRaw|ConvertFrom-Json
    if(-not $qaPreparerRegistration.pass -or $qaPreparerRegistration.name -cne $qaPreparerName -or $qaPreparerRegistration.account -cne 'LocalSystem'){throw 'Unexpected desktop preparer registration'}
    $qaReport.desktopPreparerRegistration=$qaPreparerRegistration
    & "$env:SystemRoot\System32\sc.exe" privs $qaPreparerName SeChangeNotifyPrivilege|Out-Null
    if($LASTEXITCODE -ne 0){throw 'Desktop preparer minimum privilege setup failed'}
  }
  if($qaControl -eq $qaExecutor -or $qaControl -notlike 'S-1-5-80-*' -or $qaExecutor -notlike 'S-1-5-80-*'){throw 'Distinct virtual SIDs missing'}
  $qaParentAcl=Get-Acl -LiteralPath $qaParent
  foreach($qaSid in @($qaControl,$qaExecutor)){
    $qaParentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($qaSid),
      [Security.AccessControl.FileSystemRights]'ReadAttributes,Traverse,ReadPermissions',
      [Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  Set-Acl -LiteralPath $qaParent -AclObject $qaParentAcl
  Set-QaAcl $qaRoot @{$qaControl='ReadAndExecute';$qaExecutor='ReadAndExecute';$qaSpec.requestorSid='ReadAndExecute'}
  [IO.File]::WriteAllText((Join-Path $qaRoot '.ragent-identity-qa'),('case-'+$qaSpec.caseId))
  Set-QaAcl (Join-Path $qaRoot 'runtime') @{$qaControl='ReadAndExecute';$qaExecutor='ReadAndExecute'}
  if($qaSpec.crossServiceIpc -or ($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){
    foreach($qaDir in @('runtime\chat','runtime\tests','runtime\tests\helpers','runtime\tests\fixtures')){Set-QaAcl (Join-Path $qaRoot $qaDir) @{$qaControl='ReadAndExecute';$qaExecutor='ReadAndExecute'}}
    Set-QaAcl (Join-Path $qaRoot 'handoff') @{$qaControl='ReadAndExecute';$qaExecutor='ReadAndExecute'}
    Set-QaAcl (Join-Path $qaRoot 'handoff\control') @{$qaControl='Modify';$qaExecutor='ReadAndExecute'}
    Set-QaAcl (Join-Path $qaRoot 'handoff\executor') @{$qaExecutor='Modify';$qaControl='ReadAndExecute'}
    if(($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){
      Set-QaAcl (Join-Path $qaRoot 'handoff') @{$qaControl='ReadAndExecute';$qaExecutor='ReadAndExecute';$qaSpec.requestorSid='ReadAndExecute'}
      Set-QaAcl (Join-Path $qaRoot 'handoff\control') @{$qaControl='Modify';$qaExecutor='ReadAndExecute';$qaSpec.requestorSid='ReadAndExecute'}
      Set-QaAcl (Join-Path $qaRoot 'handoff\executor') @{$qaExecutor='Modify';$qaControl='ReadAndExecute';$qaSpec.requestorSid='ReadAndExecute'}
    }
    foreach($qaDir in @('handoff\control','handoff\executor')){
      & "$env:SystemRoot\System32\icacls.exe" (Join-Path $qaRoot $qaDir) '/setintegritylevel' '(OI)(CI)M'|Out-Null
      if($LASTEXITCODE -ne 0){throw 'Medium handoff label failed'}
    }
  }
  if($qaSpec.crossServiceProvider -or ($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){
    Set-QaAcl (Join-Path $qaRoot 'control\inbox') @{$qaControl='Modify';$qaSpec.requestorSid='Modify'}
    Set-QaAcl (Join-Path $qaRoot 'control\outbox') @{$qaControl='Modify';$qaSpec.requestorSid='ReadAndExecute'}
    foreach($qaDir in @('control\inbox','control\outbox')){
      & "$env:SystemRoot\System32\icacls.exe" (Join-Path $qaRoot $qaDir) '/setintegritylevel' '(OI)(CI)M'|Out-Null
      if($LASTEXITCODE -ne 0){throw 'Medium control inbox label failed'}
    }
  }
  Set-QaAcl (Join-Path $qaRoot 'control') @{$qaControl='Modify'}
  Set-QaAcl (Join-Path $qaRoot 'workspace') @{$qaControl='Modify';$qaExecutor='Modify'}
  Set-QaAcl (Join-Path $qaRoot 'extra-workspace') @{$qaControl='Modify';$qaExecutor='Modify'}
  Set-QaAcl (Join-Path $qaRoot 'state') @{$qaControl='ReadAndExecute';$qaExecutor='ReadAndExecute'}
  Set-QaAcl (Join-Path $qaRoot 'state\control') @{$qaControl='Modify'}
  Set-QaAcl (Join-Path $qaRoot 'state\executor') @{$qaExecutor='Modify'}
  foreach($qaDir in @('control','workspace','extra-workspace','state\control','state\executor')){
    & "$env:SystemRoot\System32\icacls.exe" (Join-Path $qaRoot $qaDir) '/setintegritylevel' '(OI)(CI)M'|Out-Null
    if($LASTEXITCODE -ne 0){throw 'Medium directory label failed'}
  }
  [IO.File]::WriteAllText((Join-Path $qaRoot 'manifest.json'),($qaSpec|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $qaRoot 'control\secret.txt'),('SYNTHETIC-IDENTITY-QA-'+$qaSpec.caseId))
  [IO.File]::WriteAllText((Join-Path $qaRoot 'state\control\private-state.txt'),('SYNTHETIC-PRIVATE-STATE-'+$qaSpec.caseId))
  [IO.File]::WriteAllText((Join-Path $qaRoot 'workspace\input.csv'),"name,amount`nalpha,17`nbeta,11`nalpha,25`n")
  $qaReport.rounds=@()
  for($qaRound=1;$qaRound -le 2;$qaRound++){
    if($qaSpec.crossServiceIpc -or ($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){
      $qaSpec|Add-Member -NotePropertyName 'ipcRound' -NotePropertyValue $qaRound -Force
      [IO.File]::WriteAllText((Join-Path $qaRoot 'manifest.json'),($qaSpec|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    }
    if($qaRound -gt 1){
      foreach($qaRole in @('control','executor')){foreach($qaFile in @('service-report.json','node-report.json')){
        $qaOwnedReport=Join-Path $qaRoot ('state\'+$qaRole+'\'+$qaFile)
        Assert-NoReparse $qaOwnedReport
        Remove-Item -LiteralPath $qaOwnedReport -Force
      }}
    }
    if($qaSpec.crossServiceProvider){
      $qaPreparerReport=Join-Path $qaRoot 'state\preparer\desktop-report.json'
      if(Test-Path -LiteralPath $qaPreparerReport){Assert-NoReparse $qaPreparerReport;Remove-Item -LiteralPath $qaPreparerReport -Force}
      Start-Service -Name $qaPreparerName
      $qaDesktopReady=Wait-QaJson $qaPreparerReport 10
      if(-not $qaDesktopReady.ready){throw 'Private Session0 desktop preparation failed'}
    }
    Start-Service -Name $qaNames[0]
    if($qaSpec.crossServiceIpc -or ($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){Start-Service -Name $qaNames[1]}
    if($qaSpec.crossServiceCredentialProvider){
      $qaReady=Join-Path $qaRoot ("handoff\control\r$qaRound-provider-vault-ready.json")
      $qaUntil=(Get-Date).AddSeconds(35)
      while(-not(Test-Path -LiteralPath $qaReady) -and (Get-Date)-lt $qaUntil){Start-Sleep -Milliseconds 100}
      if(-not(Test-Path -LiteralPath $qaReady)){throw 'Credential Provider boundary/vault preflight timeout'}
      Assert-NoReparse $qaReady
      if((Get-Item -LiteralPath $qaReady).Length -gt 1024 -or -not(([IO.File]::ReadAllText($qaReady)|ConvertFrom-Json).pass)){throw 'Credential Provider vault not ready'}
      $qaProvisionInfo=[Diagnostics.ProcessStartInfo]::new()
      $qaProvisionInfo.FileName=Join-Path $qaRoot 'runtime\node.exe'
      $qaProvisionInfo.Arguments='"'+(Join-Path $qaRoot 'runtime\tests\fixtures\windows-service-provider-provision.mjs')+'" "'+$qaRoot+'"'
      $qaProvisionInfo.UseShellExecute=$false;$qaProvisionInfo.CreateNoWindow=$true
      $qaProvisionInfo.RedirectStandardOutput=$true;$qaProvisionInfo.RedirectStandardError=$true
      $qaProvisionInfo.EnvironmentVariables.Clear();$qaProvisionInfo.EnvironmentVariables['SystemRoot']='C:\Windows';$qaProvisionInfo.EnvironmentVariables['WINDIR']='C:\Windows'
      $qaProvisionProcess=[Diagnostics.Process]::Start($qaProvisionInfo)
      if(-not $qaProvisionProcess.WaitForExit(15000)){try{$qaProvisionProcess.Kill()}catch{};throw 'Selected static key QA provisioning timeout'}
      $qaProvision=$qaProvisionProcess.StandardOutput.ReadToEnd()
      if($qaProvisionProcess.ExitCode -ne 0 -or -not(($qaProvision|ConvertFrom-Json).pass)){throw 'Selected static key QA provisioning failed'}
      $qaProvisionProcess.Dispose()
      $qaReport.credentialsProvisioned=$true
    }
    $qaWait=if($qaSpec.crossServiceProvider -or ($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){115}else{40}
    $qaControlResult=Wait-QaJson (Join-Path $qaRoot 'state\control\service-report.json') $qaWait
    $qaReport.control=$qaControlResult
    if(-not $qaControlResult.pass){throw 'Control identity/Node admission failed'}
    if(-not $qaSpec.crossServiceIpc -and -not ($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){Start-Service -Name $qaNames[1]}
    $qaExecutorResult=Wait-QaJson (Join-Path $qaRoot 'state\executor\service-report.json') $qaWait
    $qaReport.executor=$qaExecutorResult
    foreach($qaRole in @('control','executor')){
      $qaReport[($qaRole+'Node')]=Wait-QaJson (Join-Path $qaRoot ('state\'+$qaRole+'\node-report.json')) 5
      if(-not $qaReport[$qaRole].pass -or -not $qaReport[($qaRole+'Node')].pass){throw 'Canary role failed'}
      if($qaSpec.crossServiceCredentialProvider -and $qaReport[($qaRole+'Node')].credentialChannel.providerUsed){$qaReport.credentialsUsed=$true}
      if($qaSpec.crossServiceProvider -and -not $qaSpec.crossServiceCredentialProvider -and $qaReport[($qaRole+'Node')].provider.providerUsed){$qaReport.credentialsUsed=$true}
    }
    if($qaSpec.crossServiceProvider){
      Stop-Service -Name $qaPreparerName
      $qaDesktopUntil=(Get-Date).AddSeconds(5)
      do{$qaDesktopDone=Wait-QaJson $qaPreparerReport 5;if($qaDesktopDone.stationClosed){break};Start-Sleep -Milliseconds 50}while((Get-Date)-lt $qaDesktopUntil)
      if(-not $qaDesktopDone.pass -or -not $qaDesktopDone.stationClosed){throw 'Private Session0 station cleanup failed'}
      $qaReport.rounds+=@{round=$qaRound;control=$qaReport.control;executor=$qaReport.executor;controlNode=$qaReport.controlNode;executorNode=$qaReport.executorNode;desktopPreparer=$qaDesktopDone}
    }else{$qaReport.rounds+=@{round=$qaRound;control=$qaReport.control;executor=$qaReport.executor;controlNode=$qaReport.controlNode;executorNode=$qaReport.executorNode}}
    foreach($qaName in $qaNames){
      $qaService=Get-Service -Name $qaName
      if($qaService.Status -ne 'Stopped'){Stop-Service -Name $qaName;$qaService.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(15))}
      $qaService.Dispose()
    }
  }
  $qaReport.services=@(Get-CimInstance Win32_Service|Where-Object {$_.Name -in $qaNames}|Select-Object Name,StartName,State,ProcessId)
  $qaReport.acls=@('runtime','control','workspace','extra-workspace','state\control','state\executor')|ForEach-Object {@{path=$_;sddl=(Get-Acl -LiteralPath (Join-Path $qaRoot $_)).Sddl}}
  if($qaReport.rounds.Count -ne 2 -or $qaReport.rounds[0].round -ne 1 -or $qaReport.rounds[1].round -ne 2){throw 'Incomplete two-round service acceptance'}
  $qaReport.pass=$true
}catch{$qaReport.error=$_.Exception.Message}
finally{
  foreach($qaName in $qaCreated){
    $qaItem=[ordered]@{name=$qaName;stopped=$false;deleted=$false}
    try{
      $qaService=Get-Service -Name $qaName
      if($qaService.Status -ne 'Stopped'){Stop-Service -Name $qaName;$qaService.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(15))}
      $qaItem.stopped=$true
      & "$env:SystemRoot\System32\sc.exe" delete $qaName|Out-Null
      if($LASTEXITCODE -ne 0){throw 'Canary service delete failed'}
      $qaService.Dispose()
      for($qaPoll=0;$qaPoll -lt 50;$qaPoll++){
        $qaRemaining=Get-Service -Name $qaName -ErrorAction SilentlyContinue
        if(-not $qaRemaining){$qaItem.deleted=$true;break}
        $qaRemaining.Dispose();Start-Sleep -Milliseconds 100
      }
    }catch{$qaItem.error=$_.Exception.Message;$qaReport.pass=$false}
    if(-not $qaItem.deleted){$qaReport.pass=$false};$qaReport.cleanup+=$qaItem
  }
  if($qaSpec.controlSid -and $qaSpec.executorSid){
    $qaParentAcl=Get-Acl -LiteralPath $qaParent
    foreach($qaSid in @($qaSpec.controlSid,$qaSpec.executorSid)){
      $qaParentAcl.PurgeAccessRules([Security.Principal.SecurityIdentifier]::new($qaSid))
    }
    Set-Acl -LiteralPath $qaParent -AclObject $qaParentAcl
  }
  $qaReport.completedAt=(Get-Date).ToString('o')
  if($qaSpec.crossServiceProvider){
    $qaDesktopReport=Join-Path $qaRoot 'state\preparer\desktop-report.json'
    if(Test-Path -LiteralPath $qaDesktopReport){try{
      $qaDesktopRaw=& $qaExe '--read-report' $qaDesktopReport
      if($LASTEXITCODE -ne 0){throw 'Bound desktop report export failed'}
      $qaReport.desktopPreparer=$qaDesktopRaw|ConvertFrom-Json
      [IO.File]::WriteAllText((Join-Path $qaRoot 'export\desktop-preparer-report.json'),($qaDesktopRaw -join "`n"),[Text.UTF8Encoding]::new($false))
    }catch{$qaReport.pass=$false;$qaReport.desktopExportError=$_.Exception.Message}}
  }
  foreach($qaRole in @('control','executor')){
    foreach($qaFile in @('service-report.json','node-report.json')){
      $qaFrom=Join-Path $qaRoot ('state\'+$qaRole+'\'+$qaFile)
      if(Test-Path -LiteralPath $qaFrom){try{
        $qaRaw=& $qaExe '--read-report' $qaFrom
        if($LASTEXITCODE -ne 0){throw 'Bound report export failed'}
        [IO.File]::WriteAllText((Join-Path $qaRoot ('export\'+$qaRole+'-'+$qaFile)),($qaRaw -join "`n"),[Text.UTF8Encoding]::new($false))
      }catch{$qaReport.pass=$false;$qaReport.exportError=$_.Exception.Message}}
    }
  }
  if($qaSpec.crossServiceCredentialChannel){
    $qaReport.credentialKeysRemoved=$true
    foreach($qaRound in @(1,2)){foreach($qaFile in @('authority-identity.json','native-provider-runtime\secrets\selected.json','native-provider-runtime\secrets\unselected.json')){
      if(Test-Path -LiteralPath (Join-Path $qaRoot ("state\control\credential-r$qaRound\config\$qaFile"))){$qaReport.credentialKeysRemoved=$false;$qaReport.pass=$false}
    }}
  }
  if($qaSpec.crossServiceCredentialProvider){
    $qaReport.provisionCredentialsRemoved=$true
    foreach($qaRound in @(1,2)){
      foreach($qaRelative in @("state\control\credential-r$qaRound\config\native-provider-runtime\secrets\selected.json","state\control\provider-provision-r$qaRound.json","handoff\control\r$qaRound-provider-vault-ready.json","handoff\executor\r$qaRound-provider-preflight.json")){
        $qaProvisionPath=Join-Path $qaRoot $qaRelative
        if(Test-Path -LiteralPath $qaProvisionPath){try{Assert-NoReparse $qaProvisionPath;Remove-Item -LiteralPath $qaProvisionPath -Force}catch{$qaReport.provisionCredentialsRemoved=$false;$qaReport.pass=$false}}
      }
    }
  }
    if($qaSpec.crossServiceOwnerBootstrap){
      $qaReport.ownerPublicationRemoved=$true
      $qaPublicationNames=if($qaSpec.ownerDiscoverySet -or $qaSpec.ownerActivation){@('owner-bootstrap-cli-live.json','owner-bootstrap-cli-live.json.publisher-lock','owner-bootstrap-browser-live.json','owner-bootstrap-browser-live.json.publisher-lock','owner-bootstrap-publisher.json','owner-bootstrap-publisher.json.publisher-lock')}else{@('owner-bootstrap-live.json','owner-bootstrap-live.json.publisher-lock')}
      foreach($qaPublicationRound in @(1,2)){foreach($qaPublicationName in $qaPublicationNames){
        $qaPublication=Join-Path $qaRoot ("state\control\owner-auth-r$qaPublicationRound\config\$qaPublicationName")
        if(Test-Path -LiteralPath $qaPublication){try{Assert-NoReparse $qaPublication;Remove-Item -LiteralPath $qaPublication -Force}catch{$qaReport.ownerPublicationRemoved=$false;$qaReport.pass=$false}}
      }}
    }
  $qaReport.runtimeRemoved=@()
  if($qaReport.cleanup.Count -eq $qaCreated.Count -and -not ($qaReport.cleanup|Where-Object {-not $_.stopped -or -not $_.deleted})){
    if($qaSpec.crossServiceIpc){
      $qaReport.handoffRemoved=$true
      foreach($qaRole in @('control','executor')){foreach($qaRound in @(1,2)){foreach($qaScenario in @('success','capability','cross-run','server-pin','client-pin')){
        $qaKinds=if($qaRole -eq 'control'){@('client','done')}else{@('offer','done')}
        foreach($qaKind in $qaKinds){foreach($qaSuffix in @('.json','.json.tmp')){
          $qaHandoff=Join-Path $qaRoot ("handoff\$qaRole\r$qaRound-$qaScenario-$qaKind$qaSuffix")
          if(Test-Path -LiteralPath $qaHandoff){try{Assert-NoReparse $qaHandoff;Remove-Item -LiteralPath $qaHandoff -Force}catch{$qaReport.handoffRemoved=$false;$qaReport.pass=$false}}
        }}
      }}}
    }
    if($qaSpec.crossServiceProvider){
      $qaReport.providerHandoffRemoved=$true
      foreach($qaRound in @(1,2)){
        foreach($qaRole in @('control','executor')){foreach($qaKind in @('policy','ready','client','done','preflight')){foreach($qaSuffix in @('.json','.json.tmp')){
          $qaProviderPath=Join-Path $qaRoot ("handoff\$qaRole\r$qaRound-provider-$qaKind$qaSuffix")
          if(Test-Path -LiteralPath $qaProviderPath){try{Assert-NoReparse $qaProviderPath;Remove-Item -LiteralPath $qaProviderPath -Force}catch{$qaReport.providerHandoffRemoved=$false;$qaReport.pass=$false}}
        }}}
        foreach($qaSuffix in @('.json','.json.tmp')){
          $qaProviderPath=Join-Path $qaRoot ("control\inbox\r$qaRound-provider-request$qaSuffix")
          if(Test-Path -LiteralPath $qaProviderPath){try{Assert-NoReparse $qaProviderPath;Remove-Item -LiteralPath $qaProviderPath -Force}catch{$qaReport.providerHandoffRemoved=$false;$qaReport.pass=$false}}
        }
      }
    }
    if(($qaSpec.crossServiceOwnerBootstrap -or $qaSpec.crossServiceCredentialChannel)){
      $qaReport.ownerHandoffRemoved=$true
      $qaOwnerScenarios=if($qaSpec.ownerDiscoverySet){@('simultaneous','browser-refresh','cli-refresh','browser-failure','browser-completes-first','close-both')}elseif($qaSpec.ownerPurposeV2){@('cli-success','browser-success','browser-ticket-replay','browser-purpose','cli-purpose','browser-downgrade','browser-launch-missing','browser-launch-invalid','browser-instance','browser-server-pin','browser-disconnect','browser-delivery-failure','browser-receipt-nonce','browser-receipt-purpose')}else{@('success','replay','instance','request','nonce','operation','claimed-sid','extend','server-pin','disconnect')}
      foreach($qaRound in @(1,2)){foreach($qaScenario in $qaOwnerScenarios){
        foreach($qaLocation in @('handoff\control','handoff\executor','control\inbox')){foreach($qaKind in @('ready','done','denied','denied-fresh','step','after-step','ack','finish')){foreach($qaSuffix in @('.json','.json.tmp')){
          $qaHandoff=Join-Path $qaRoot ("$qaLocation\r$qaRound-owner-$qaScenario-$qaKind$qaSuffix")
          if(Test-Path -LiteralPath $qaHandoff){try{Assert-NoReparse $qaHandoff;Remove-Item -LiteralPath $qaHandoff -Force}catch{$qaReport.ownerHandoffRemoved=$false;$qaReport.pass=$false}}
        }}}
      }}
    }
    if($qaSpec.ownerActivation){
      $qaReport.activationHandoffRemoved=$true
      foreach($qaRound in @(1,2)){foreach($qaLocation in @('handoff\control','handoff\executor','control\inbox')){foreach($qaStage in @('initial','idle','first','reuse','first-issued','expired','second','second-issued','fault','fault-issued','done','finish','commit-release','after-fault','recovered','recovered-issued')){foreach($qaSuffix in @('.json','.json.tmp')){
        $qaHandoff=Join-Path $qaRoot ("$qaLocation\r$qaRound-activation-$qaStage$qaSuffix")
        if(Test-Path -LiteralPath $qaHandoff){try{Assert-NoReparse $qaHandoff;Remove-Item -LiteralPath $qaHandoff -Force}catch{$qaReport.activationHandoffRemoved=$false;$qaReport.pass=$false}}
      }}}}
    }
    if($qaSpec.crossServiceCredentialChannel){
      $qaReport.credentialHandoffRemoved=$true
      foreach($qaRound in @(1,2)){foreach($qaScenario in @('success','server-pin','snapshot','cross-run','owner-operation')){
        foreach($qaLocation in @('handoff\control','handoff\executor','control\inbox')){foreach($qaKind in @('offer','ready','done','settled','owner-denied')){foreach($qaSuffix in @('.json','.json.tmp')){
          $qaHandoff=Join-Path $qaRoot ("$qaLocation\r$qaRound-credential-$qaScenario-$qaKind$qaSuffix")
          if(Test-Path -LiteralPath $qaHandoff){try{Assert-NoReparse $qaHandoff;Remove-Item -LiteralPath $qaHandoff -Force}catch{$qaReport.credentialHandoffRemoved=$false;$qaReport.pass=$false}}
        }}}
      }}
    }
    foreach($qaFile in $qaRuntimeFiles){
      $qaTarget=[IO.Path]::GetFullPath((Join-Path $qaRoot ('runtime\'+$qaFile)))
      if(-not $qaTarget.StartsWith(($qaRoot+'\runtime\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Cleanup target escaped canary root'}
      for($qaPoll=0;$qaPoll -lt 50;$qaPoll++){
        if(-not(Test-Path -LiteralPath $qaTarget)){break}
        try{Remove-Item -LiteralPath $qaTarget -Force;break}catch{Start-Sleep -Milliseconds 100}
      }
      $qaRemoved= -not(Test-Path -LiteralPath $qaTarget)
      $qaReport.runtimeRemoved+=@{file=$qaFile;removed=$qaRemoved}
      if(-not $qaRemoved){$qaReport.pass=$false}
    }
  }
  [IO.File]::WriteAllText((Join-Path $qaRoot 'export\summary.json'),($qaReport|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))
  Set-QaAcl (Join-Path $qaRoot 'export') @{$qaSpec.requestorSid='ReadAndExecute'}
}
if(-not $qaReport.pass){exit 1}
