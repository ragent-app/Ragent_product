# Actual product under the prepared virtual service identities, in a disposable
# Windows guest only. No substituted product entry/API/SQLite/native trust code.
[CmdletBinding()]
param([switch]$AdministrativeInstallTrust,[switch]$ActiveRemovalAcceptance)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($ActiveRemovalAcceptance -and -not $AdministrativeInstallTrust){throw 'MPR_ACTIVE_REMOVAL_REQUIRES_ADMIN_TRUST'}
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'MPR_DISPOSABLE_RUNNER_REQUIRED'}
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MPR_ADMIN_REQUIRED'}
$product='C:\Program Files\Ragent';$data='C:\ProgramData\Ragent';$names=@('Ragent-ControlPlane','Ragent-RunnerSupervisor')
foreach($name in $names){if(Get-CimInstance Win32_Service -Filter "Name='$name'"){throw 'MPR_EXISTING_SERVICE'}}
foreach($path in @($product,$data)){if(Test-Path -LiteralPath $path){throw 'MPR_EXISTING_ROOT'}}
if([Diagnostics.EventLog]::SourceExists('Ragent') -or (Get-NetTCPConnection -State Listen -LocalPort 7690 -ErrorAction SilentlyContinue)){throw 'MPR_EXISTING_PRODUCT_RESOURCE'}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$pack=Join-Path $repo 'packaging\windows'
$evidence=Join-Path $env:RUNNER_TEMP 'managed-product';$null=New-Item -ItemType Directory -Path $evidence
$node=(Get-Command node.exe).Source
if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne '2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8'){throw 'MPR_NODE24_BYTES_REQUIRED'}
$report=[ordered]@{pass=$false;sourceCommit=$env:GITHUB_SHA;runId=$env:GITHUB_RUN_ID;startedAt=(Get-Date).ToUniversalTime().ToString('o');actualProductApi=$true;syntheticEntryScripts=$false;providerRun=$false;ownerNativeTrustSubstituted=$false;installationPerformed=$false;productionChanged=$false;checks=@();phases=@();cleanupConfirmed=$false;releaseReady=$false;migrationReady=$false}
$report.administrativeInstallTrust=$AdministrativeInstallTrust.IsPresent
$report.activeRemovalAcceptance=$ActiveRemovalAcceptance.IsPresent
$report.sourceFiles=@('tests/windows-managed-product.ps1','lib/windows-owner-release-trust.mjs','lib/windows-owner-discovery.mjs','lib/windows-owner-activation-trust.mjs','lib/windows-owner-service-trust.mjs','lib/windows-owner-discovery-publication.mjs','native/windows-owner-bootstrap.cs','packaging/windows/stage-owner-bootstrap.ps1','packaging/windows/read-owner-bootstrap-discovery.ps1','packaging/windows/read-owner-service-trust.ps1','packaging/windows/prepare-owner-install-policy.ps1','packaging/windows/prepare-owner-msi-policy.ps1','packaging/windows/check-owner-msi-activation.ps1','packaging/windows/managed-owner-msi.ps1','packaging/windows/managed-owner-msi-bridge.cs','packaging/windows/owner-msi-relocation-journal.cs','packaging/windows/initialize-owner-service-identity.ps1','packaging/windows/build-managed-owner-msi-bridge.ps1','packaging/windows/Ragent.ServiceHost.cs')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}
$owned=$false;$dataAttempted=$false;$eventOwned=$false;$stageAttempted=$false;$rules=@();$profilesBefore=@();$cookies=[Net.CookieContainer]::new();$observed=@();$report.stops=@()
$bridgePath=Join-Path $product 'Ragent.ManagedOwnerMsiBridge.exe'
if($ActiveRemovalAcceptance){$bridgePath=Join-Path $env:RUNNER_TEMP 'managed-product-payload\qa-native-bridge.exe';$report.sourceFiles+=@('packaging/windows/remove-owner-msi-policy.ps1','packaging/windows/owner-service-activation-trial.cs','packaging/windows/owner-service-activation-transaction.cs')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}}
function Parent-Facts {
 $a=Get-Acl -LiteralPath 'C:\ProgramData'
 @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {@{sid=$_.IdentityReference.Value;mask=[int64]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;type=[int]$_.AccessControlType}}|Sort-Object sid,mask,inheritance,propagation,type)}
}
$before=Parent-Facts
function Call-Prepare([string]$file,[string[]]$extra=@()) {
 $p=[Diagnostics.ProcessStartInfo]::new();$p.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';$p.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$file+'" '+($extra -join ' ');$p.UseShellExecute=$false;$p.CreateNoWindow=$true;$p.RedirectStandardOutput=$true;$p.RedirectStandardError=$true
 $c=[Diagnostics.Process]::Start($p)
 try{if(-not $c.WaitForExit(90000)){try{$c.Kill()}catch{};throw 'MPR_PREPARATION_TIMEOUT'};$s=$c.StandardOutput.ReadToEnd();$e=$c.StandardError.ReadToEnd();if($e){throw 'MPR_PREPARATION_STDERR'};return @{exitCode=$c.ExitCode;result=($s|ConvertFrom-Json)}}finally{$c.Dispose()}
}
function Read-Http([string]$path,[switch]$html) {
 $q=[Net.HttpWebRequest]::Create('http://127.0.0.1:7690'+$path);$q.Proxy=$null;$q.Timeout=3000;$q.AllowAutoRedirect=$false;$q.CookieContainer=$cookies
 if($html){$q.Accept='text/html';$q.Headers.Add('Sec-Fetch-Site','none');$q.Headers.Add('Sec-Fetch-Mode','navigate')}
 $r=$null;try{$r=$q.GetResponse()}catch [Net.WebException]{if($_.Exception.Response){$r=$_.Exception.Response}else{throw}}
 try{$reader=[IO.StreamReader]::new($r.GetResponseStream());try{$body=$reader.ReadToEnd()}finally{$reader.Dispose()};return @{status=[int]$r.StatusCode;body=$body;ownerCookie=([string]$r.Headers['Set-Cookie'] -match 'session_token=')}}finally{if($r){$r.Dispose()}}
}
function Call-ManagedBridge([string]$Label,[string]$Arguments,[string]$Expected=''){
 $i=[Diagnostics.ProcessStartInfo]::new($bridgePath);$i.Arguments=$Arguments;$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true
 $c=[Diagnostics.Process]::Start($i);try{$o=$c.StandardOutput.ReadToEndAsync();$e=$c.StandardError.ReadToEndAsync();if(-not $c.WaitForExit(250000)){throw 'MPR_BRIDGE_TIMEOUT'};$value=$o.Result|ConvertFrom-Json
  [IO.File]::WriteAllText((Join-Path $evidence ($Label+'.json')),$o.Result,[Text.UTF8Encoding]::new($false))
  if($e.Result.Length -or ($Expected -eq '' -and ($c.ExitCode -ne 0 -or $value.ok -ne $true)) -or ($Expected -ne '' -and ($c.ExitCode -ne 1 -or $value.code -cne $Expected))){throw ('MPR_BRIDGE_RESULT_'+$Label)}
  return $value
 }finally{$c.Dispose()}
}
function Observe-Services {
 $rows=@()
 foreach($name in $names){
  $s=Get-CimInstance Win32_Service -Filter "Name='$name'";if(-not $s -or $s.State -cne 'Running' -or $s.StartName -ine ('NT SERVICE\'+$name)){throw 'MPR_SERVICE_NOT_RUNNING'}
  $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($s.ProcessId)"|Where-Object {$_.ExecutablePath -ieq (Join-Path $product 'payload\node.exe')});if($children.Count -ne 1){throw 'MPR_NODE_CHILD_REQUIRED'}
  $facts=@();foreach($taskPid in @($s.ProcessId,$children[0].ProcessId)){
   $f=(& (Join-Path $product 'TokenProbe.exe') ([string]$taskPid))|ConvertFrom-Json
   if($LASTEXITCODE -ne 0 -or $f.sid -cne [Security.Principal.NTAccount]::new('NT SERVICE',$name).Translate([Security.Principal.SecurityIdentifier]).Value -or $f.integrityRid -ne 8192 -or $f.sessionId -ne 0 -or $f.elevated -or $f.enabledAdministrators -or @($f.privileges|Where-Object {$_ -cne 'SeChangeNotifyPrivilege'}).Count){throw 'MPR_REAL_TOKEN_INVALID'}
   $facts+=$f
  }
  $rows+=@{name=$name;hostPid=$s.ProcessId;nodePid=$children[0].ProcessId;facts=$facts}
 }
 return $rows
}
function Stop-OwnServices {
 foreach($name in $names){$s=Get-CimInstance Win32_Service -Filter "Name='$name'";if($s -and $s.State -ne 'Stopped'){if(-not $s.PathName.StartsWith(('"'+$product+'\Ragent.ServiceHost.exe"'),[StringComparison]::Ordinal)){throw 'MPR_SERVICE_OWNERSHIP_REFUSED'};Stop-Service $name -ErrorAction Stop;$c=[ServiceProcess.ServiceController]::new($name);try{$c.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(50))}finally{$c.Dispose()}}}
}
function Confirm-ControlStop([string]$phase) {
 $left=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($product+'\',[StringComparison]::OrdinalIgnoreCase)})
 if($left.Count){throw 'MPR_STOP_PROCESS_REMAINS'}
 $ownership=Join-Path $data 'instances\owner\runtime\instance-ownership.json'
 try{$null=[IO.File]::GetAttributes($ownership);throw 'MPR_INSTANCE_OWNERSHIP_NOT_RELEASED'}catch [IO.FileNotFoundException]{}catch [IO.DirectoryNotFoundException]{}
 $log=[IO.File]::ReadAllText((Join-Path $data 'instances\owner\config\logs\service-control.log'))
 if($log -notmatch 'Shutting down chat server \(windows-service-stop\)' -or $log -match '\[shutdown\] hard deadline|OSV_CLEANUP_UNCONFIRMED|UV_HANDLE_CLOSING'){throw 'MPR_STOP_NOT_CONFIRMED'}
 $report.stops+=@{phase=$phase;ownedProcessesGone=$true;instanceOwnershipReleased=$true;serviceStopLogObserved=$true;forcedDeadlineObserved=$false}
}
function Probe-Product([string]$phase) {
 $until=[DateTime]::UtcNow.AddSeconds($(if($AdministrativeInstallTrust){95}else{45}));$health=$null
 do{try{$health=Read-Http '/healthz';if(-not $AdministrativeInstallTrust -or $health.status -eq 200){break}}catch{};Start-Sleep -Milliseconds 300}while([DateTime]::UtcNow -lt $until)
 if(-not $health){throw 'MPR_PRODUCT_HTTP_UNAVAILABLE'}
 # On restart, query with the retained cookie BEFORE any HTML navigation can
 # mint/replace an automatic localweb session. This proves persisted acceptance.
 if($phase -eq 'restart'){$api=Read-Http '/api/sessions';$page=Read-Http '/' -html}else{$page=Read-Http '/' -html;$api=Read-Http '/api/sessions'}
 $h=$health.body|ConvertFrom-Json
 $facts=@{phase=$phase;healthStatus=$health.status;healthOk=$h.ok;cliTransport=$h.cliTransport;htmlStatus=$page.status;automaticOwner=$page.ownerCookie;sessionApiStatus=$api.status}
 $report.phases+=$facts
 if($page.status -ne 200 -or ($phase -eq 'fresh' -and -not $page.ownerCookie) -or $api.status -ne 200){throw 'MPR_LOCALWEB_SQLITE_FAILED'}
 # The unsigned installation supplies no native trust manifest/policy. Preserve
 # this exact degraded response; HTTP/localweb acceptance is not native readiness.
 if($AdministrativeInstallTrust){if($health.status -ne 200 -or $h.ok -ne $true -or $h.cliTransport -cne 'ready'){throw 'MPR_ADMIN_INSTALL_NATIVE_NOT_READY'}}
 elseif($health.status -ne 503 -or $h.cliTransport -cne 'degraded'){throw 'MPR_UNSIGNED_NATIVE_REFUSAL_CHANGED'}
 $rows=@(Observe-Services);$script:observed+=$rows;$report.phases[-1].services=$rows
}
try {
 $stage=Join-Path $env:RUNNER_TEMP 'managed-product-payload'
 if(Test-Path -LiteralPath $stage){throw 'MPR_EXISTING_STAGE'};$stageAttempted=$true
 & $node (Join-Path $repo 'scripts\stage-runtime-payload.mjs') --source $repo --destination $stage --profile desktop
 if($LASTEXITCODE -ne 0){throw 'MPR_CLEAN_STAGE_FAILED'}
 Push-Location $stage;try{& 'C:\Windows\System32\cmd.exe' /d /c 'npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund 2>&1';if($LASTEXITCODE -ne 0){throw 'MPR_DEPENDENCIES_FAILED'}}finally{Pop-Location}
 & (Join-Path $pack 'stage-node-toolchain.ps1') -NodePath $node -PayloadRoot $stage
 & (Join-Path $pack 'stage-owner-bootstrap.ps1') -SourceRoot $stage -PayloadRoot $stage -DevelopmentOnly:(-not $AdministrativeInstallTrust)
 & $node (Join-Path $repo 'scripts\verify-runtime-payload.mjs') $stage > (Join-Path $evidence 'payload-scan.json')
 if($LASTEXITCODE -ne 0){throw 'MPR_PAYLOAD_SCAN_FAILED'}
 Copy-Item -LiteralPath (Join-Path $stage 'runtime-payload-manifest.json') -Destination (Join-Path $evidence 'source-manifest.json')
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
 foreach($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')){$right=if($sid -eq 'S-1-5-32-545'){'ReadAndExecute'}else{'FullControl'};$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$right,'ContainerInherit,ObjectInherit','None','Allow'))}
 $null=[IO.Directory]::CreateDirectory($product,$acl);$owned=$true;[IO.File]::WriteAllText((Join-Path $product '.managed-product-qa'),$env:GITHUB_RUN_ID)
 Copy-Item -LiteralPath $stage -Destination (Join-Path $product 'payload') -Recurse
 & (Join-Path $pack 'build-service-host.ps1') -OutputPath (Join-Path $product 'Ragent.ServiceHost.exe') -SourcePath (Join-Path $product 'payload\packaging\windows\Ragent.ServiceHost.cs') -RuntimePayloadRoot (Join-Path $product 'payload')
 if($AdministrativeInstallTrust){& (Join-Path $pack 'build-managed-owner-msi-bridge.ps1') -OutputPath $bridgePath}
 & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /r:System.Web.Extensions.dll ('/out:'+(Join-Path $product 'TokenProbe.exe')) (Join-Path $repo 'tests\fixtures\windows-service-host-token.cs')
 if($LASTEXITCODE -ne 0){throw 'MPR_TOKEN_PROBE_COMPILE_FAILED'}
 # Normalize only freshly copied QA product bytes, never an existing tree.
 $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($product)
 while($stack.Count){foreach($item in @(Get-ChildItem -LiteralPath $stack.Pop() -Force)){
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MPR_STAGED_REPARSE'}
  if($item.PSIsContainer){
   # Persist clears DirectorySecurity's modified flags. Reconstruct each ACL
   # instead of reusing an object that silently becomes a no-op after one save.
   $copy=[Security.AccessControl.DirectorySecurity]::new();$copy.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access'),[Security.AccessControl.AccessControlSections]'Owner,Access')
   [IO.Directory]::SetAccessControl($item.FullName,$copy);$actual=[IO.Directory]::GetAccessControl($item.FullName)
   if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544'){throw 'MPR_STAGED_DIRECTORY_ACL_NOT_CONFIRMED'}
   $stack.Push($item.FullName)
  }else{$fa=[IO.File]::GetAccessControl($item.FullName);$fa.SetAccessRuleProtection($false,$false);$fa.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));[IO.File]::SetAccessControl($item.FullName,$fa)}
 }}
 $report.runtimeFiles=@('Ragent.ServiceHost.exe','payload\node.exe','payload\chat-server.mjs','payload\chat\runner-supervisor-daemon.mjs')|ForEach-Object {$f=Join-Path $product $_;@{path=$_;bytes=(Get-Item -LiteralPath $f).Length;sha256=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant()}}
 if($AdministrativeInstallTrust){$f=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe';$report.runtimeFiles+=@{path='payload\Ragent.OwnerBootstrap.exe';bytes=(Get-Item -LiteralPath $f).Length;sha256=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant()}}
 # Block all product Node-initiated outbound connections before any service
 # starts, including startup Accounts/TURN attempts. QA HTTP probes are incoming
 # connections from the separate Windows HTTP client; IPC uses named pipes.
 $rule='Ragent-ManagedProduct-QA-'+[Guid]::NewGuid().ToString('N');$null=New-NetFirewallRule -Name $rule -DisplayName $rule -Direction Outbound -Action Block -Program (Join-Path $product 'payload\node.exe') -RemoteAddress Any -Profile Any;$rules+=$rule
 $profilesBefore=@(Get-NetFirewallProfile|Select-Object Name,Enabled)
 $report.firewallProfilesBefore=$profilesBefore
 foreach($profile in $profilesBefore){if([string]$profile.Enabled -cne 'True'){Set-NetFirewallProfile -Name $profile.Name -Enabled True}}
 $effective=@(Get-NetFirewallProfile -PolicyStore ActiveStore|Select-Object Name,Enabled);$report.firewallProfilesActive=$effective
 if($effective.Count -ne 3 -or @($effective|Where-Object {[string]$_.Enabled -cne 'True'}).Count){throw 'MPR_FIREWALL_NOT_ENFORCING'}
 $actualRule=Get-NetFirewallRule -Name $rule
 if([string]$actualRule.Enabled -cne 'True' -or [string]$actualRule.Action -cne 'Block' -or [string]$actualRule.Direction -cne 'Outbound'){throw 'MPR_FIREWALL_RULE_INVALID'}
 $report.outboundBlockedForProductNode=$true
 [Diagnostics.EventLog]::CreateEventSource('Ragent','Application');$eventOwned=$true
 $report.preparation=Call-Prepare (Join-Path $pack 'prepare-owner-services.ps1') @('-Commit');if($report.preparation.exitCode -ne 0){throw 'MPR_SERVICE_PREPARATION_FAILED'}
 $dataAttempted=$true;$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 if($AdministrativeInstallTrust){
  $report.managedPreparation=Call-ManagedBridge 'prepare' ('prepare '+$owner)
  $report.identityInitialization=Call-ManagedBridge 'initialize' 'initialize'
  $helper=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe';$manifest=Join-Path $product 'payload\owner-bootstrap-release.json';$original=[IO.File]::ReadAllBytes($helper);$originalManifest=[IO.File]::ReadAllBytes($manifest)
  $report.helperSignatureStatus=[string](Get-AuthenticodeSignature -LiteralPath $helper).Status;if($report.helperSignatureStatus -cne 'NotSigned'){throw 'MPR_UNSIGNED_HELPER_REQUIRED'}
  $report.release=[IO.File]::ReadAllText($manifest)|ConvertFrom-Json
  if($report.release.version -ne 2 -or $report.release.trustMode -cne 'admin-installed-sha256'){throw 'MPR_ADMIN_MANIFEST_REQUIRED'}
  $privatePath=Join-Path $data 'instances\owner\config\instance-identity.json';$locked=[IO.FileStream]::new($privatePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  $report.privateIdentityExclusivelyLockedDuringRefusals=$true
  try{
   [IO.File]::WriteAllBytes($helper,($original+[byte]0));$report.changedHelperRefusal=Call-ManagedBridge 'changed-helper-refused' 'policy' 'OPP_HELPER_HASH_MISMATCH';if($report.changedHelperRefusal.identityRead -ne $false){throw 'MPR_EARLY_PRIVATE_READ'};[IO.File]::WriteAllBytes($helper,$original)
   $savedAcl=[IO.File]::GetAccessControl($helper);$changedAcl=[IO.File]::GetAccessControl($helper);$changedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Write','Allow'));[IO.File]::SetAccessControl($helper,$changedAcl)
   try{$report.writableHelperRefusal=Call-ManagedBridge 'writable-helper-refused' 'policy' 'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY';if($report.writableHelperRefusal.identityRead -ne $false){throw 'MPR_EARLY_PRIVATE_READ'}}finally{$restoreAcl=[Security.AccessControl.FileSecurity]::new();$restoreAcl.SetSecurityDescriptorSddlForm($savedAcl.GetSecurityDescriptorSddlForm('Access'),'Access');[IO.File]::SetAccessControl($helper,$restoreAcl)}
  }finally{$locked.Dispose();[IO.File]::WriteAllBytes($helper,$original);[IO.File]::WriteAllBytes($manifest,$originalManifest)}
  $report.policyPreparation=Call-ManagedBridge 'policy' 'policy';$report.activationPreflight=Call-ManagedBridge 'activation-check' 'activation-check';$report.activation=Call-ManagedBridge 'activate' 'activate'
  if($report.activation.productHealthPassed -ne $true -or $report.activation.configurationCommitted -ne $true -or $report.activation.servicesActivated -ne $true){throw 'MPR_ACTIVATION_NOT_COMPLETE'}
  $report.checks+='actual-unsigned-administrative-prepare-initialize-policy-activate-with-integrity-and-acl-refusals'
 }else{
  $report.dataPreparation=Call-Prepare (Join-Path $pack 'prepare-owner-service-data.ps1') @('-Commit','-OwnerSid',$owner);if($report.dataPreparation.exitCode -ne 0){throw 'MPR_DATA_PREPARATION_FAILED'}
  foreach($name in $names){Set-Service -Name $name -StartupType Manual};Start-Service 'Ragent-ControlPlane'
 }
 Probe-Product 'fresh';$report.checks+='actual-product-localweb-and-session-api-under-separated-medium-tokens'
 Stop-OwnServices;Confirm-ControlStop 'fresh'
 $config=Join-Path $data 'instances\owner\config'
 $db=[IO.File]::OpenRead((Join-Path $config 'auth-sessions.sqlite'));$header=[byte[]]::new(16)
 try{if($db.Read($header,0,16) -ne 16){throw 'MPR_SQLITE_HEADER_TRUNCATED'}}finally{$db.Dispose()}
 $report.sqliteHeaderValid=([Text.Encoding]::ASCII.GetString($header) -ceq "SQLite format 3`0")
 if(-not $report.sqliteHeaderValid){throw 'MPR_REAL_SQLITE_REQUIRED'}
 $identity=Join-Path $config 'instance-identity.json';$secret=Join-Path $config 'auth-session-secret'
 $identityBefore=(Get-FileHash -LiteralPath $identity -Algorithm SHA256).Hash;$secretBefore=(Get-FileHash -LiteralPath $secret -Algorithm SHA256).Hash
 Start-Service 'Ragent-ControlPlane';Probe-Product 'restart'
 if((Get-FileHash -LiteralPath $identity -Algorithm SHA256).Hash -cne $identityBefore -or (Get-FileHash -LiteralPath $secret -Algorithm SHA256).Hash -cne $secretBefore){throw 'MPR_DURABLE_IDENTITY_CHANGED'}
 $report.durableIdentityPreserved=$true;$report.secretPreserved=$true;$report.oldLocalwebCookieAccepted=$true;$report.checks+='actual-product-restart-preserves-private-identity-secret-and-sqlite-cookie'
 if($ActiveRemovalAcceptance){
  # MSI Binary actions execute outside Product. Exercise the exact public bridge
  # there, without an exception in the product-process absence check.
  $activePath=Join-Path $product 'owner-msi.activated.json';$activeBytes=[IO.File]::ReadAllBytes($activePath)
  $preserve=@($identity,$secret,(Join-Path $product 'owner-msi.prepared.activated.json'),(Join-Path $product 'owner-msi.policy.activated.json'),$activePath,(Join-Path $data 'instances\owner\security\owner-bootstrap-install.json'))
  $hashes=@{};foreach($path in $preserve){$hashes[$path]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash}
  $stateBefore=@(Get-CimInstance Win32_Service|Where-Object {$_.Name -cin $names}|Sort-Object Name|Select-Object Name,State,StartMode,ProcessId,StartName)|ConvertTo-Json -Compress
  $locked=[IO.FileStream]::new($identity,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  try{
   $changed=[Text.Encoding]::UTF8.GetString($activeBytes)|ConvertFrom-Json;$changed.policyReceiptSha256='0'*64
   [IO.File]::WriteAllText($activePath,($changed|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
   try{$report.activeReceiptRefusal=Call-ManagedBridge 'active-receipt-refused' 'remove-check' 'ORP_ACTIVE_RECEIPT_INVALID'}finally{[IO.File]::WriteAllBytes($activePath,$activeBytes)}
   & 'C:\Windows\System32\sc.exe' privs 'Ragent-ControlPlane' 'SeChangeNotifyPrivilege/SeImpersonatePrivilege'|Out-Null;if($LASTEXITCODE -ne 0){throw 'MPR_PRIVILEGE_CHANGE_FAILED'}
   try{$report.activePrivilegesRefusal=Call-ManagedBridge 'active-privileges-refused' 'remove-check' 'OAT_PRIVILEGES_CHANGED'}finally{& 'C:\Windows\System32\sc.exe' privs 'Ragent-ControlPlane' 'SeChangeNotifyPrivilege'|Out-Null;if($LASTEXITCODE -ne 0){throw 'MPR_PRIVILEGE_RESTORE_FAILED'}}
   $stateAfter=@(Get-CimInstance Win32_Service|Where-Object {$_.Name -cin $names}|Sort-Object Name|Select-Object Name,State,StartMode,ProcessId,StartName)|ConvertTo-Json -Compress
   if($stateAfter -cne $stateBefore -or (Test-Path -LiteralPath (Join-Path $product 'owner-msi.prepare-lock'))){throw 'MPR_REMOVAL_REFUSAL_MUTATED_STATE'}
   $report.activeRemovalPreflight=Call-ManagedBridge 'active-remove-check' 'remove-check'
   $report.activeRemoval=Call-ManagedBridge 'active-remove' 'remove'
   $report.privateIdentityLockedDuringActiveRemoval=$true
  }finally{$locked.Dispose()}
  Confirm-ControlStop 'restart'
  foreach($name in $names){if(Get-CimInstance Win32_Service -Filter "Name='$name'"){throw 'MPR_ACTIVE_REMOVAL_SERVICE_REMAINS'}}
  if(Get-NetTCPConnection -State Listen -LocalPort 7690 -ErrorAction SilentlyContinue){throw 'MPR_ACTIVE_REMOVAL_LISTENER_REMAINS'}
  foreach($path in $preserve){if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $hashes[$path]){throw 'MPR_REMOVAL_PRESERVED_FILE_CHANGED'}}
  $db=[IO.File]::OpenRead((Join-Path $config 'auth-sessions.sqlite'));$header=[byte[]]::new(16);try{if($db.Read($header,0,16) -ne 16 -or [Text.Encoding]::ASCII.GetString($header) -cne "SQLite format 3`0"){throw 'MPR_REMOVAL_DATABASE_MISSING'}}finally{$db.Dispose()}
  $report.activeRemovalObserved=@{servicesAbsent=$true;ownedProcessesGone=$true;listenerAbsent=$true;preservedPrivateAndPublicFileCount=$preserve.Count;preservedFileHashesUnchanged=$true;sqliteStillPresent=$true;quarantineMarkerRetained=(Test-Path -LiteralPath (Join-Path $product 'owner-msi.prepare-lock'));refusalStatesUnchanged=$true}
  $report.checks+='actual-running-service-removal-with-locked-identity-and-receipt-privilege-refusals'
 }else{Stop-OwnServices;Confirm-ControlStop 'restart'}
 $report.checks+='actual-product-graceful-stop';$report.pass=$true
}catch{$report.error=$_.Exception.GetBaseException().Message;$report.pass=$false}
finally {
 try {
  foreach($relative in @('instances\owner\config\logs\service-control.log','instances\owner\executor\config\logs\service-supervisor.log')){$p=Join-Path $data $relative;if(Test-Path -LiteralPath $p){$text=(Get-Content -LiteralPath $p -Tail 100|Out-String);$text=$text -replace '(?im)(session_token=|(?:api[_-]?key|password|auth[_-]?session[_-]?secret)\s*[:=]\s*)\S+','$1[REDACTED]';[IO.File]::WriteAllText((Join-Path $evidence ([IO.Path]::GetFileName($p))),$text)}}
  Stop-OwnServices
  $left=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($product+'\',[StringComparison]::OrdinalIgnoreCase)})
  if($left.Count){throw 'MPR_OWNED_PROCESS_REMAINS'}
  foreach($name in $names){$s=Get-CimInstance Win32_Service -Filter "Name='$name'";if($s){if(-not $s.PathName.StartsWith(('"'+$product+'\Ragent.ServiceHost.exe"'),[StringComparison]::Ordinal)){throw 'MPR_DELETE_OWNERSHIP_REFUSED'};& 'C:\Windows\System32\sc.exe' delete $name|Out-Null;if($LASTEXITCODE -ne 0){throw 'MPR_DELETE_FAILED'}}}
  if($eventOwned){[Diagnostics.EventLog]::DeleteEventSource('Ragent')}
  foreach($rule in $rules){$app=Get-NetFirewallRule -Name $rule|Get-NetFirewallApplicationFilter;if($app.Program -ine (Join-Path $product 'payload\node.exe')){throw 'MPR_FIREWALL_OWNERSHIP_REFUSED'};Remove-NetFirewallRule -Name $rule}
  foreach($profile in $profilesBefore){Set-NetFirewallProfile -Name $profile.Name -Enabled $profile.Enabled}
  if($profilesBefore.Count){$restored=@(Get-NetFirewallProfile|Select-Object Name,Enabled);if(($restored|Sort-Object Name|ConvertTo-Json -Compress) -cne ($profilesBefore|Sort-Object Name|ConvertTo-Json -Compress)){throw 'MPR_FIREWALL_PROFILE_RESTORE_FAILED'};$report.firewallProfilesRestored=$true}
  if($owned){
   if([IO.Path]::GetFullPath($product) -cne 'C:\Program Files\Ragent' -or [IO.File]::ReadAllText((Join-Path $product '.managed-product-qa')) -cne $env:GITHUB_RUN_ID){throw 'MPR_CLEANUP_MARKER_REFUSED'}
   foreach($root in @($product,$data)){
    if(-not(Test-Path -LiteralPath $root)){continue};if($root -eq $data -and -not $dataAttempted){throw 'MPR_UNKNOWN_DATA'}
    if([IO.Path]::GetFullPath($root) -cnotin @('C:\Program Files\Ragent','C:\ProgramData\Ragent') -or ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'MPR_CLEANUP_ROOT_REFUSED'}
    if($root -eq $data){$da=Get-Acl -LiteralPath $root;if(-not $da.AreAccessRulesProtected -or $da.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544'){throw 'MPR_DATA_CLEANUP_OWNER_REFUSED'}}
    $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($root)
    while($pending.Count){foreach($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MPR_CLEANUP_REPARSE_REFUSED'};if($item.PSIsContainer){$pending.Push($item.FullName)}}}
    Remove-Item -LiteralPath $root -Recurse -Force
   }
  }
  if($stageAttempted -and (Test-Path -LiteralPath $stage)){
   if([IO.Path]::GetFullPath($stage) -cne [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'managed-product-payload')) -or ((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'MPR_STAGE_CLEANUP_ROOT_REFUSED'}
   $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($stage)
   while($pending.Count){foreach($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MPR_STAGE_CLEANUP_REPARSE_REFUSED'};if($item.PSIsContainer){$pending.Push($item.FullName)}}}
   Remove-Item -LiteralPath $stage -Recurse -Force
  }
  foreach($name in $names){if(Get-CimInstance Win32_Service -Filter "Name='$name'"){throw 'MPR_SERVICE_REMAINS'}}
  $report.cleanupConfirmed=$true
 }catch{$report.cleanupError=$_.Exception.GetBaseException().Message;$report.pass=$false}
 $after=Parent-Facts;$report.defaultProgramDataAclUnchanged=(($before|ConvertTo-Json -Depth 6 -Compress) -ceq ($after|ConvertTo-Json -Depth 6 -Compress));if(-not $report.defaultProgramDataAclUnchanged){$report.pass=$false}
 $report.observed=$observed;$report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
 [IO.File]::WriteAllText((Join-Path $evidence 'report.json'),($report|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
}
$report|ConvertTo-Json -Depth 12 -Compress
if(-not $report.pass){exit 1}
