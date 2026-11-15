# Actual shipped ServiceHost/Node under fixed SCM identities in a disposable VM.
# Synthetic entry scripts replace product APIs; no Provider/Owner traffic.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'MHR_DISPOSABLE_RUNNER_REQUIRED'}
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MHR_ADMIN_REQUIRED'}
$product='C:\Program Files\Ragent';$data='C:\ProgramData\Ragent';$names=@('Ragent-ControlPlane','Ragent-RunnerSupervisor')
foreach($name in $names){if(Get-CimInstance Win32_Service -Filter "Name='$name'"){throw 'MHR_EXISTING_SERVICE'}}
foreach($path in @($product,$data)){if(Test-Path -LiteralPath $path){throw 'MHR_EXISTING_ROOT'}}
if([Diagnostics.EventLog]::SourceExists('Ragent')){throw 'MHR_EXISTING_EVENT_SOURCE'}
if(-not $env:RUNNER_TEMP){throw 'MHR_TEMP_REQUIRED'}
$evidence=Join-Path $env:RUNNER_TEMP 'managed-service-runtime';New-Item -ItemType Directory -Path $evidence|Out-Null
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$pack=Join-Path $repo 'packaging\windows'
$report=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;startedAt=(Get-Date).ToUniversalTime().ToString('o');productionHostTouched=$false;syntheticEntryScripts=$true;actualServiceHost=$true;actualProductApi=$false;authorityIssued=$false;providerRun=$false;checks=@();services=@();cleanupConfirmed=$false}
$productOwned=$false;$dataAttempted=$false;$eventOwned=$false
$parentBefore=$null
function Acl-Facts($Acl){
  @{owner=$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$Acl.AreAccessRulesProtected;rules=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {
    [ordered]@{sid=$_.IdentityReference.Value;mask=[int64]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;type=[int]$_.AccessControlType;inherited=$_.IsInherited}
  }|Sort-Object sid,mask,inheritance,propagation,type,inherited)}
}
function Call-Preparation([string]$File,[string[]]$Extra=@()){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';$info.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$File+'" '+($Extra -join ' ')
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $proc=[Diagnostics.Process]::Start($info)
  try{if(-not $proc.WaitForExit(90000)){try{$proc.Kill()}catch{};throw 'MHR_PREPARATION_TIMEOUT'}
    $text=$proc.StandardOutput.ReadToEnd();$err=$proc.StandardError.ReadToEnd();if($err){throw ('MHR_PREPARATION_STDERR: '+$err)}
    return @{exitCode=$proc.ExitCode;result=($text|ConvertFrom-Json)}
  }finally{$proc.Dispose()}
}
function Wait-Stopped([string]$Name){
  $controller=[ServiceProcess.ServiceController]::new($Name)
  try{$controller.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(50))}finally{$controller.Dispose()}
}
function Remove-GuestServices {
  foreach($name in $names){
    $s=Get-CimInstance Win32_Service -Filter "Name='$name'"
    if($s){
      if(-not $s.PathName.StartsWith(('"'+$product+'\Ragent.ServiceHost.exe"'),[StringComparison]::Ordinal)){throw 'MHR_SERVICE_OWNERSHIP_REFUSED'}
      if($s.State -ne 'Stopped'){Stop-Service -Name $name -ErrorAction Stop;Wait-Stopped $name}
      $s=$null;& 'C:\Windows\System32\sc.exe' delete $name|Out-Null;if($LASTEXITCODE -ne 0){throw 'MHR_DELETE_FAILED'}
    }
  }
  for($i=0;$i -lt 40;$i++){
    $left=@($names|ForEach-Object {Get-CimInstance Win32_Service -Filter "Name='$_'"});if(-not $left.Count){return};Start-Sleep -Milliseconds 250
  }
  throw 'MHR_SERVICE_REMAINS'
}
try{
  $parentBefore=Acl-Facts ([IO.Directory]::GetAccessControl('C:\ProgramData'))
  $report.defaultAncestorBaseline=@{aclAdjusted=$false;before=$parentBefore;unchanged=$false}
  & (Join-Path $repo 'tests\test-windows-ancestor-pin.ps1') -EvidenceRoot (Join-Path $evidence 'ancestor-probe')|Out-Null
  $report.ancestorProbe=[IO.File]::ReadAllText((Join-Path $evidence 'ancestor-probe\native.json'))|ConvertFrom-Json
  if(-not $report.ancestorProbe.pass){throw 'MHR_ANCESTOR_PROBE_FAILED'}
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')){
    $right=if($sid -eq 'S-1-5-32-545'){'ReadAndExecute'}else{'FullControl'}
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]$right,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  $null=[IO.Directory]::CreateDirectory($product,$acl);$productOwned=$true;[IO.File]::WriteAllText((Join-Path $product '.managed-host-qa'),$env:GITHUB_RUN_ID)
  foreach($relative in @('payload','payload\chat')){$null=[IO.Directory]::CreateDirectory((Join-Path $product $relative),$acl)}
  & (Join-Path $pack 'build-service-host.ps1') -OutputPath (Join-Path $product 'Ragent.ServiceHost.exe') -DevelopmentOnly
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /reference:System.Web.Extensions.dll ('/out:'+(Join-Path $product 'payload\HostTokenProbe.exe')) (Join-Path $repo 'tests\fixtures\windows-service-host-token.cs')
  if($LASTEXITCODE -ne 0){throw 'MHR_TOKEN_PROBE_COMPILE_FAILED'}
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /define:HOST_PROBE /target:exe /main:HostAncestorProbe /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Security.dll ('/out:'+(Join-Path $product 'payload\AncestorPinProbe.exe')) (Join-Path $pack 'Ragent.ServiceHost.cs') (Join-Path $repo 'tests\fixtures\windows-ancestor-pin.cs')
  if($LASTEXITCODE -ne 0){throw 'MHR_ANCESTOR_PROBE_COMPILE_FAILED'}
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $product 'payload\node.exe')
  foreach($relative in @('payload\chat-server.mjs','payload\chat\runner-supervisor-daemon.mjs')){Copy-Item -LiteralPath (Join-Path $repo 'tests\fixtures\windows-service-host-child.mjs') -Destination (Join-Path $product $relative)}
  [IO.File]::WriteAllText((Join-Path $product 'payload\immutable-probe.txt'),'SYNTHETIC-IMMUTABLE-CODE-TREE')
  # Copied/compiled files are explicitly administrator-owned, not merely owned
  # by a member of Administrators. Their immutable parent is already protected.
  Get-ChildItem -LiteralPath $product -File -Recurse|ForEach-Object {
    $fileAcl=[IO.File]::GetAccessControl($_.FullName);$fileAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));[IO.File]::SetAccessControl($_.FullName,$fileAcl)
  }
  $report.runtimeFiles=@('Ragent.ServiceHost.exe','payload\node.exe','payload\HostTokenProbe.exe','payload\AncestorPinProbe.exe','payload\chat-server.mjs','payload\chat\runner-supervisor-daemon.mjs','payload\immutable-probe.txt')|ForEach-Object {
    $file=Join-Path $product $_;@{path=$_;bytes=(Get-Item -LiteralPath $file).Length;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  $report.sourceFiles=@('packaging/windows/Ragent.ServiceHost.cs','packaging/windows/prepare-owner-service-data.ps1','packaging/windows/prepare-owner-services.ps1','packaging/windows/read-owner-bootstrap-discovery.ps1','tests/windows-managed-service-runtime.ps1','tests/fixtures/windows-service-host-token.cs','tests/fixtures/windows-service-host-child.mjs','tests/fixtures/windows-ancestor-pin.cs','tests/test-windows-ancestor-pin.ps1')|ForEach-Object {
    @{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  [Diagnostics.EventLog]::CreateEventSource('Ragent','Application');$eventOwned=$true
  . (Join-Path $pack 'prepare-owner-services.ps1') -LibraryOnly
  $supervisorPlan=@(Get-OwnerServicePreparationPlan)|Where-Object {$_.role -eq 'supervisor'}
  New-Service -Name 'Ragent-RunnerSupervisor' -BinaryPathName $supervisorPlan.command -StartupType Manual|Out-Null
  $refused=$false;try{Start-Service 'Ragent-RunnerSupervisor' -ErrorAction Stop}catch{$refused=$true}
  Wait-Stopped 'Ragent-RunnerSupervisor'
  if(-not $refused -or (Test-Path -LiteralPath $data)){throw 'MHR_SYSTEM_START_NOT_REFUSED_BEFORE_IO'}
  $event=Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Ragent';Id=1004} -MaxEvents 5|Where-Object {$_.Message -match 'SHT_SERVICE_ACCOUNT_REFUSED'}
  if(-not $event){throw 'MHR_SYSTEM_REFUSAL_NOT_CONFIRMED'}
  $report.checks+='actual-system-service-refused-before-data-io'
  Remove-GuestServices
  $prepared=Call-Preparation (Join-Path $pack 'prepare-owner-services.ps1') @('-Commit');$report.preparation=$prepared
  if($prepared.exitCode -ne 0 -or -not $prepared.result.servicesPrepared){throw 'MHR_SERVICES_NOT_PREPARED'}
  $plan=Call-Preparation (Join-Path $pack 'prepare-owner-service-data.ps1');$report.dataPlan=$plan
  if($plan.exitCode -ne 0){
    $report.parentAclFacts=@('C:\','C:\ProgramData','C:\Program Files\Ragent','C:\Program Files\Ragent\payload')|ForEach-Object {
      $snapshot=[IO.Directory]::GetAccessControl($_)
      @{path=$_;owner=$snapshot.GetOwner([Security.Principal.SecurityIdentifier]).Value;rules=@($snapshot.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {
        @{sid=$_.IdentityReference.Value;mask=[int64]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;type=[int]$_.AccessControlType}
      })}
    }
  }
  if($plan.exitCode -ne 0 -or -not $plan.result.readOnly -or (Test-Path -LiteralPath $data)){throw 'MHR_DATA_PLAN_FAILED'}
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$dataAttempted=$true
  $created=Call-Preparation (Join-Path $pack 'prepare-owner-service-data.ps1') @('-Commit','-OwnerSid',$owner);$report.dataPreparation=$created
  if($created.exitCode -ne 0 -or -not $created.result.dataPrepared -or $created.result.servicesActivated -or $created.result.credentialsCreated){throw 'MHR_DATA_PREPARATION_FAILED'}
  [IO.File]::WriteAllText((Join-Path $data '.managed-host-qa'),$env:GITHUB_RUN_ID)
  $repeat=Call-Preparation (Join-Path $pack 'prepare-owner-service-data.ps1') @('-Commit','-OwnerSid',$owner);$report.dataReentry=$repeat
  if($repeat.exitCode -ne 1 -or $repeat.result.code -cne 'ODP_EXISTING_DATA_REFUSED'){throw 'MHR_EXISTING_DATA_NOT_REFUSED'}
  $report.checks+='fresh-protected-data-only-default-plan-and-reentry-refusal'
  foreach($name in $names){
    # Give the fresh guest services extra initial privilege potential so the
    # actual host must remove it; do not substitute a reduced test launcher.
    & 'C:\Windows\System32\sc.exe' privs $name 'SeChangeNotifyPrivilege/SeImpersonatePrivilege/SeIncreaseWorkingSetPrivilege'|Out-Null
    if($LASTEXITCODE -ne 0){throw 'MHR_QA_INITIAL_PRIVILEGES_FAILED'}
    New-ItemProperty -Path ('HKLM:\SYSTEM\CurrentControlSet\Services\'+$name) -Name Environment -PropertyType MultiString -Value @('NODE_OPTIONS=--invalid-managed-qa-option','NODE_PATH=SYNTHETIC_PARENT_PATH','OPENAI_API_KEY=SYNTHETIC_PARENT_KEY','RAGENT_AUTH_SESSION_SECRET=SYNTHETIC_PARENT_SECRET')|Out-Null
    Set-Service -Name $name -StartupType Manual
  }
  Start-Service 'Ragent-ControlPlane'
  $proofPaths=@((Join-Path $data 'instances\owner\config\runtime-proof.json'),(Join-Path $data 'instances\owner\executor\config\runtime-proof.json'))
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  while(@($proofPaths|Where-Object {-not (Test-Path -LiteralPath $_)}).Count -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
  foreach($index in 0,1){
    $name=$names[$index];$service=Get-CimInstance Win32_Service -Filter "Name='$name'"
    if($service.State -cne 'Running' -or $service.StartName -ine ('NT SERVICE\'+$name)){throw 'MHR_SERVICE_NOT_RUNNING'}
    $proof=[IO.File]::ReadAllText($proofPaths[$index])|ConvertFrom-Json
    $native=Join-Path $product 'payload\HostTokenProbe.exe'
    $parentFacts=(& $native ([string]$service.ProcessId))|ConvertFrom-Json;if($LASTEXITCODE -ne 0){throw 'MHR_PARENT_TOKEN_QUERY_FAILED'}
    $nodeFacts=(& $native ([string]$proof.pid))|ConvertFrom-Json;if($LASTEXITCODE -ne 0){throw 'MHR_NODE_TOKEN_QUERY_FAILED'}
    $expected=[Security.Principal.NTAccount]::new('NT SERVICE',$name).Translate([Security.Principal.SecurityIdentifier]).Value
    foreach($facts in @($parentFacts,$nodeFacts,$proof.token)){
      if($facts.sid -cne $expected -or $facts.integrityRid -ne 8192 -or $facts.sessionId -ne 0 -or $facts.elevated -or $facts.enabledAdministrators -or @($facts.privileges|Where-Object {$_ -cne 'SeChangeNotifyPrivilege'}).Count){throw 'MHR_REAL_TOKEN_NOT_ORDINARY'}
    }
    if($proof.parentPid -ne $service.ProcessId -or -not $proof.pass -or -not $proof.token.privilegeReenableDenied -or -not $proof.token.integrityRaiseDenied -or $proof.token.postIntegrityRid -ne 8192){throw 'MHR_INHERITANCE_OR_IRREVERSIBILITY_FAILED'}
    $report.services+=@{name=$name;pid=$service.ProcessId;parentFacts=$parentFacts;nodeFacts=$nodeFacts;proof=$proof}
  }
  $report.checks+='actual-host-node-grandchild-medium-virtual-tokens'
  $report.checks+='removed-privilege-and-integrity-cannot-be-raised'
  $report.checks+='cross-role-secret-runtime-harness-and-binary-access-denied'
  $report.checks+='shared-authorized-work-and-spool-access-succeeds'
  foreach($name in $names){Stop-Service $name;Wait-Stopped $name}
  foreach($row in $report.services){foreach($taskPid in @($row.pid,$row.proof.pid,$row.proof.token.pid,$row.proof.ancestorGuard.pid)){if(Get-Process -Id $taskPid -ErrorAction SilentlyContinue){throw 'MHR_OWNED_PROCESS_REMAINS'}}}
  $report.checks+='actual-service-graceful-stop-owned-processes-gone'
  $report.pass=$true
}catch{$report.error=$_.Exception.GetBaseException().Message;$report.pass=$false}
finally{
  try{
    foreach($relative in @('instances\owner\config\logs\service-control.log','instances\owner\executor\config\logs\service-supervisor.log')){
      $path=Join-Path $data $relative
      if(Test-Path -LiteralPath $path){$tail=(Get-Content -LiteralPath $path -Tail 80|Out-String);[IO.File]::WriteAllText((Join-Path $evidence ([IO.Path]::GetFileName($path))),$tail)}
    }
    Remove-GuestServices
    if($eventOwned){[Diagnostics.EventLog]::DeleteEventSource('Ragent')}
    if($productOwned){
      if([IO.Path]::GetFullPath($product) -cne 'C:\Program Files\Ragent' -or [IO.File]::ReadAllText((Join-Path $product '.managed-host-qa')) -cne $env:GITHUB_RUN_ID){throw 'MHR_PRODUCT_CLEANUP_OWNERSHIP_REFUSED'}
      foreach($root in @($product,$data)){
        if(-not(Test-Path -LiteralPath $root)){continue}
        if($root -eq $data -and -not $dataAttempted){throw 'MHR_UNKNOWN_DATA_REFUSED'}
        if((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MHR_CLEANUP_ROOT_REPARSE'}
        if($root -eq $data){$rootAcl=[IO.Directory]::GetAccessControl($root);if(-not $rootAcl.AreAccessRulesProtected -or $rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544'){throw 'MHR_DATA_CLEANUP_OWNERSHIP_REFUSED'}}
        $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($root)
        while($pending.Count){foreach($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)){
          if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MHR_CLEANUP_CHILD_REPARSE'}
          if($item.PSIsContainer){$pending.Push($item.FullName)}
        }}
        # Both exact fixed roots were absent at guest admission; only this QA
        # transaction populated them. Never run this cleanup on an operator OS.
        Remove-Item -LiteralPath $root -Recurse -Force
      }
    }
    $report.cleanupConfirmed=$true
  }catch{$report.cleanupError=$_.Exception.GetBaseException().Message;$report.pass=$false}
  if($parentBefore){
    try{
      $after=Acl-Facts ([IO.Directory]::GetAccessControl('C:\ProgramData'))
      if(($after|ConvertTo-Json -Depth 6 -Compress) -cne ($parentBefore|ConvertTo-Json -Depth 6 -Compress)){throw 'MHR_DEFAULT_ANCESTOR_CHANGED'}
      $report.defaultAncestorBaseline.unchanged=$true;$report.defaultAncestorBaseline.after=$after
    }catch{$report.ancestorComparisonError=$_.Exception.GetBaseException().Message;$report.pass=$false}
  }
  $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
  [IO.File]::WriteAllText((Join-Path $evidence 'report.json'),($report|ConvertTo-Json -Depth 14),[Text.UTF8Encoding]::new($false))
}
$report|ConvertTo-Json -Depth 14 -Compress
if(-not $report.pass){exit 1}
