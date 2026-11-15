# Fixed embedded activation admission and transaction. Check remains read-only;
# Activate repeats full trust admission while retaining all relevant inputs.
[CmdletBinding()]
param([ValidateSet('Check','Activate')][string]$Action='Check',[switch]$PreserveExistingIdentity)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$activationAction=$Action;$preserveExistingIdentity=$PreserveExistingIdentity.IsPresent
. (Join-Path $PSScriptRoot 'prepare-owner-service-data.ps1') -LibraryOnly
. (Join-Path $PSScriptRoot 'prepare-owner-install-policy.ps1') -LibraryOnly
$pins=[Collections.Generic.List[IDisposable]]::new();$handles=[Collections.Generic.List[IDisposable]]::new()
$product=Get-OwnerProductRoot;$root=Get-OwnerInstanceRoot;$stage='administrator';$privateRead=$false
$transaction=$null;$activationLeases=@();$quarantine='not-started'
$healthDiagnostics=[ordered]@{attempts=0;httpStatus=$null;activationEndpointStatus=$null;healthCheckGatePassed=$false;ok=$null;cliTransport=$null;ownerActivationState=$null;ownerActivationReady=$null;ownerActivationCode=$null;pid=$null;pidIsInt32=$false;nodeProcessFound=$false;nodeProcessQuery='not-attempted';nodeParentMatchesControl=$false;nodeExecutableMatchesProductRoot=$false;listenerCount=-1;listenerOwnerMatches=$false;lastErrorType=$null;webExceptionStatus=$null;socketErrorCode=$null;serviceLogs=@()}
$nextNodeProcessEnumerationAt=[DateTime]::MinValue
function Get-OwnerActivationServiceLogSummary([string]$Role,[string]$Path){
 $summary=[ordered]@{role=$Role;present=$false;bytes=0;tailSha256=$null;errorCodes=@();classifications=@()}
 if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){return $summary}
 $stream=$null;$sha=$null
 try{
  $stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  $summary.present=$true;$summary.bytes=[long]$stream.Length
  $count=[int][Math]::Min(65536L,$stream.Length);$tail=[byte[]]::new($count);$offset=0
  [void]$stream.Seek([Math]::Max(0L,$stream.Length-$count),[IO.SeekOrigin]::Begin)
  while($offset -lt $tail.Length){$read=$stream.Read($tail,$offset,$tail.Length-$offset);if($read -le 0){break};$offset+=$read}
  if($offset -ne $tail.Length){if($offset -eq 0){$tail=[byte[]]::new(0)}else{$tail=$tail[0..($offset-1)]}}
  $sha=[Security.Cryptography.SHA256]::Create();$summary.tailSha256=([BitConverter]::ToString($sha.ComputeHash($tail))).Replace('-','').ToLowerInvariant()
  $text=[Text.Encoding]::UTF8.GetString($tail)
  $codes=[Collections.Generic.List[string]]::new()
  foreach($match in [regex]::Matches($text,'\b(?:ERR_[A-Z0-9_]{2,48}|E(?:ACCES|PERM|NOENT|ADDRINUSE|CONNREFUSED|CONNRESET))\b')){if(-not $codes.Contains($match.Value)){$codes.Add($match.Value)}}
  $summary.errorCodes=@($codes|Select-Object -First 12)
  $classes=[Collections.Generic.List[string]]::new()
  if($text -match 'ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module'){$classes.Add('module-resolution')}
  if($text -match 'EACCES|EPERM|ACCESS_DENIED'){$classes.Add('filesystem-access')}
  if($text -match 'ENOENT|PATH_NOT_FOUND'){$classes.Add('missing-path')}
  if($text -match 'EADDRINUSE|address already in use'){$classes.Add('port-conflict')}
  if($text -match 'ERR_[A-Z0-9_]+|\bSyntaxError\b|\bTypeError\b'){$classes.Add('runtime-error')}
  $summary.classifications=@($classes)
  return $summary
 }catch{return $summary}finally{if($sha){$sha.Dispose()};if($stream){$stream.Dispose()}}
}
function Copy-OwnerActivationHealth($Payload){
 if($Payload.ok -is [bool]){$healthDiagnostics.ok=$Payload.ok}
 if($Payload.cliTransport -is [string] -and $Payload.cliTransport -cmatch '\A[A-Za-z0-9_-]{1,64}\z'){$healthDiagnostics.cliTransport=$Payload.cliTransport}
 if($Payload.pid -is [int] -and $Payload.pid -gt 0){$healthDiagnostics.pid=[long]$Payload.pid;$healthDiagnostics.pidIsInt32=$true}
 $activation=$Payload.ownerActivation
 if($null -eq $activation){return}
 $states=@('idle','starting','inspecting','backoff','cooldown','listening','draining','failed','stopping','stopped','cleanup-required')
 if($activation.state -is [string] -and $activation.state -cin $states){$healthDiagnostics.ownerActivationState=$activation.state}
 if($activation.ready -is [bool]){$healthDiagnostics.ownerActivationReady=$activation.ready}
 if($activation.code -is [string] -and $activation.code -cmatch '\A(?:OBC|OBD|OSV|OBP|OBS)_[A-Z_]+\z'){$healthDiagnostics.ownerActivationCode=$activation.code}
}
function Read-OwnerActivationHealthBody([Net.HttpWebResponse]$Response){
 $stream=$null;$reader=$null
 try{
  $stream=$Response.GetResponseStream();if(-not $stream){return}
  $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true)
  $buffer=[char[]]::new(8192);$count=$reader.Read($buffer,0,$buffer.Length)
  if($count -gt 0){try{$payload=[string]::new($buffer,0,$count)|ConvertFrom-Json;Copy-OwnerActivationHealth $payload}catch{}}
 }catch{}finally{if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}}
}
function Read-OwnerActivationHealthEndpoint{
 $request=[System.Net.HttpWebRequest]::Create('http://127.0.0.1:7690/healthz/owner-activation');$request.Proxy=$null;$request.AllowAutoRedirect=$false;$request.Timeout=1000;$request.ReadWriteTimeout=1000;$request.Method='GET';$response=$null
 try{$response=$request.GetResponse()}catch{$errorRecord=$_.Exception.GetBaseException();if($errorRecord -is [Net.WebException] -and $errorRecord.Response -is [Net.HttpWebResponse]){$response=$errorRecord.Response}else{return}}
 if(-not $response){return};try{$healthDiagnostics.activationEndpointStatus=[int]$response.StatusCode;Read-OwnerActivationHealthBody $response}finally{$response.Dispose()}
}
function Read-ActivationJson([string]$Path,[string[]]$Allowed,[int]$Limit=8192){
 $bytes=Read-OwnerPinnedFile $Path $Allowed $pins $Limit
 try{$value=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json}catch{throw 'OAC_METADATA_INVALID'}
 return @{value=$value;bytes=$bytes}
}
function Assert-ActivationKeys($Value,[string[]]$Keys){if($null -eq $Value -or @($Value.PSObject.Properties).Count -ne $Keys.Count -or @($Value.PSObject.Properties.Name|Where-Object {$_ -cnotin $Keys}).Count){throw 'OAC_METADATA_INVALID'}}
try {
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OAC_ADMIN_REQUIRED'}
 $stage='pending'
 foreach($name in @('owner-services.prepare-lock','owner-data.prepare-lock','owner-msi.prepare-lock','owner-identity.initialize-lock','owner-activation.prepare-lock','owner-policy.prepare-lock')){if(Test-OwnerServicePreparationPresence (Join-Path $product $name)){throw 'OAC_PENDING_TRANSACTION'}}
 if(Test-OwnerServicePreparationPresence (Join-Path $root 'owner-policy.install-lock')){throw 'OAC_PENDING_TRANSACTION'}
 $stage='inputs';Open-OwnerServicePreparationInputs $pins;$admin=@(Get-OwnerAdministrativeSids)
 $stage='receipts'
 foreach($name in @('owner-msi.prepared.json','owner-msi.policy.json')){if(-not(Test-OwnerServicePreparationPresence (Join-Path $product $name))){throw 'OAC_PREPARATION_RECEIPTS_REQUIRED'}}
 $preparedInput=Read-ActivationJson (Join-Path $product 'owner-msi.prepared.json') $admin;$prepared=$preparedInput.value
 Assert-ActivationKeys $prepared @('version','purpose','phase','ownerSid')
 if($prepared.version -isnot [int] -or $prepared.version -ne 1 -or $prepared.purpose -cne 'owner-msi-preparation' -or $prepared.phase -cne 'prepared' -or $prepared.ownerSid -cnotmatch '\AS-1-5-21-(\d+-){3}\d+\z'){throw 'OAC_PREPARED_RECEIPT_INVALID'}
 $recordInput=Read-ActivationJson (Join-Path $product 'owner-msi.policy.json') $admin;$record=$recordInput.value
 $trustKey=if($record.version -eq 2){'trustMode'}else{'publisherSha256'}
 $identityKey=if($preserveExistingIdentity){'identityReused'}else{'identitySha256'}
 Assert-ActivationKeys $record @('version','purpose','phase','instanceId','policySha256','releaseSha256','helperSha256',$trustKey,$identityKey)
 if($record.version -isnot [int] -or $record.version -notin @(1,2) -or ($record.version -eq 2 -and $record.trustMode -cne 'admin-installed-sha256') -or $record.purpose -cne 'owner-msi-policy-preparation' -or $record.phase -cne 'policy-prepared' -or $record.instanceId -cnotmatch '\Ainst_[a-f0-9]{32}\z'){throw 'OAC_POLICY_RECEIPT_INVALID'}
 foreach($name in @('policySha256','releaseSha256','helperSha256')+@($identityKey|Where-Object {$_ -ceq 'identitySha256'})+@($trustKey|Where-Object {$_ -ceq 'publisherSha256'})){if($record.$name -isnot [string] -or $record.$name -cnotmatch '\A[a-f0-9]{64}\z'){throw 'OAC_POLICY_RECEIPT_INVALID'}}
 if($preserveExistingIdentity -and $record.identityReused -cne 'preserved-existing'){throw 'OAC_IDENTITY_REUSE_RECEIPT_INVALID'}
 $stage='services';Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'owner-activation-service-read.cs')))
 foreach($plan in @(Get-OwnerServicePreparationPlan)){$handles.Add([OwnerActivationServiceRead]::new($plan.name,$plan.command))}
 $actual=@(Get-OwnerDataServices);$control=($actual|Where-Object {$_.role -eq 'control'}).sid;$executor=($actual|Where-Object {$_.role -eq 'supervisor'}).sid
 $stage='layout'
 foreach($row in @(Get-OwnerDataLayout $control $executor $prepared.ownerSid)){
  $path=if($row.relative){Join-Path (Get-OwnerDataRoot) $row.relative}else{Get-OwnerDataRoot};$pins.Add([RagentOwnerFilePin]::Directory($path));$acl=[IO.Directory]::GetAccessControl($path)
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or (Get-OwnerDataAclSddl $acl ([Security.AccessControl.AccessControlSections]::Access)) -cne (Get-OwnerDataAclSddl (New-OwnerDataAcl $row.grants $row.traverseOnly) ([Security.AccessControl.AccessControlSections]::Access))){throw 'OAC_LAYOUT_MISMATCH'}
 }
 $stage='policy';$policyInput=Read-ActivationJson (Join-Path $root 'security\owner-bootstrap-install.json') $admin;$policy=$policyInput.value
 if((Get-OwnerDigest $policyInput.bytes) -cne $record.policySha256){throw 'OAC_POLICY_HASH_MISMATCH'};Assert-OwnerInstallPolicy $policy
 if($policy.instanceId -cne $record.instanceId -or $policy.ownerSid -cne $prepared.ownerSid -or $policy.controlSid -cne $control -or $policy.executorSid -cne $executor){throw 'OAC_POLICY_BINDING_MISMATCH'}
 foreach($kind in @('security','file')){
  $path=if($kind -eq 'file'){Join-Path $root 'security\owner-bootstrap-install.json'}else{Join-Path $root 'security'};$acl=Get-Acl -LiteralPath $path
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -cne (New-OwnerPolicySecurity $policy $kind).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)){throw 'OAC_POLICY_ACL_MISMATCH'}
 }
 $stage='signature';$helperPath=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe';$releasePath=Join-Path $product 'payload\owner-bootstrap-release.json'
 if(-not(Test-OwnerServicePreparationPresence $helperPath) -or -not(Test-OwnerServicePreparationPresence $releasePath)){throw 'OAC_SIGNED_HELPER_REQUIRED'}
 $release=Read-ActivationJson $releasePath $admin;Assert-OwnerPolicyRelease $release.value;$helper=Read-OwnerPinnedFile $helperPath $admin $pins 4194304
 if((Get-OwnerDigest $release.bytes) -cne $record.releaseSha256 -or (Get-OwnerDigest $helper) -cne $record.helperSha256 -or $release.value.helperSha256 -cne $record.helperSha256 -or $release.value.version -ne $record.version -or $release.value.$trustKey -cne $record.$trustKey){throw 'OAC_PUBLIC_INPUT_HASH_MISMATCH'}
 try{$null=Get-OwnerReleaseTrust $release.value $helper $helperPath}catch{throw 'OAC_SIGNED_HELPER_REQUIRED'}
 # Only an actually trusted helper admits private identity IO. Never print its
 # bytes, JSON, key material or raw exception text, even on digest/parse failure.
 $stage='identity'
 if($preserveExistingIdentity){
  foreach($name in @('instance-identity.json','owner-identity.result.json')){
   $path=Join-Path $root ('config\'+$name);if(-not(Test-OwnerServicePreparationPresence $path)){throw 'OAC_EXISTING_IDENTITY_REQUIRED'}
   $stream=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
   try{[RagentOwnerFilePin]::Verify($stream.SafeFileHandle,$path,$false);if($stream.Length -lt 2 -or $stream.Length -gt 32768){throw 'OAC_EXISTING_IDENTITY_INVALID'};Assert-OwnerObjectAcl $path ($admin+@($control));$pins.Add($stream)}catch{$stream.Dispose();throw}
  }
  $privateRead=$false
 }else{
  $privateRead=$true;$identity=Read-ActivationJson (Join-Path $root 'config\instance-identity.json') ($admin+@($control)) 32768
  if((Get-OwnerDigest $identity.bytes) -cne $record.identitySha256){throw 'OAC_IDENTITY_HASH_MISMATCH'}
  if($identity.value.instanceId -cne $record.instanceId -or $identity.value.algorithm -cne 'ed25519'){throw 'OAC_IDENTITY_BINDING_MISMATCH'}
  $facts=(Read-ActivationJson (Join-Path $root 'config\owner-identity.result.json') ($admin+@($control))).value
  if($facts.version -isnot [int] -or $facts.version -ne 1 -or $facts.initialized -ne $true -or $facts.sid -cne $control -or $facts.sessionId -ne 0 -or $facts.integrityRid -ne 8192 -or $facts.onlyChangeNotify -ne $true -or $facts.hostPid -le 0 -or $facts.nodePid -le 0){throw 'OAC_INITIALIZATION_REQUIRED'}
 }
 foreach($h in $handles){$h.Verify()}
 if($activationAction -ceq 'Activate'){
  $stage='transaction'
  if(@(Get-NetTCPConnection -LocalPort 7690 -State Listen -ErrorAction SilentlyContinue).Count){throw 'OAX_PORT_IN_USE'}
  $env:RAGENT_INSTALL_ROOT=$product
  Add-Type -Path @((Join-Path $PSScriptRoot 'Ragent.ServiceHost.cs'),(Join-Path $PSScriptRoot 'owner-service-activation-trial.cs'),(Join-Path $PSScriptRoot 'owner-service-activation-transaction.cs')) -ReferencedAssemblies @('System.ServiceProcess.dll','System.Web.Extensions.dll')
  foreach($plan in @(Get-OwnerServicePreparationPlan)){$activationLeases+=@{role=$plan.role;value=[OwnerServiceActivationTrial]::new($plan.name,$plan.command)}}
  $supervisor=($activationLeases|Where-Object {$_.role -ceq 'supervisor'}).value;$controlLease=($activationLeases|Where-Object {$_.role -ceq 'control'}).value
  $transaction=[OwnerServiceActivationTransaction]::new($record.instanceId,$preparedInput.bytes,$recordInput.bytes,$supervisor,$controlLease)
  foreach($h in $handles){$h.Verify()}
  $transaction.Begin();$transaction.Prepare()
  # Only the two administrative receipt streams must close for their same-root
  # no-replace archive moves. All other trusted inputs/ancestors stay pinned;
  # the transaction rechecks exact bytes before and after each archive.
  for($i=$pins.Count-1;$i -ge 0;$i--){$pin=$pins[$i];if($pin -is [IO.FileStream] -and $pin.Name -cin @((Join-Path $product 'owner-msi.prepared.json'),(Join-Path $product 'owner-msi.policy.json'))){$pin.Dispose();$pins.RemoveAt($i)}}
  $stage='commit';$transaction.CommitConfiguration()
  $stage='startup';$transaction.Start()
  # Cold service-side PowerShell inspection has its own bounded 60s IO ceiling.
  # Give actual listener readiness time to finish; never extend Owner authority.
  $stage='health';$until=[DateTime]::UtcNow.AddSeconds(90);$healthy=$false;$activationEndpointAttempted=$false
  do{
   $healthDiagnostics.attempts++
   try{
    $request=[System.Net.HttpWebRequest]::Create('http://127.0.0.1:7690/healthz');$request.Proxy=$null;$request.AllowAutoRedirect=$false;$request.Timeout=2000;$request.ReadWriteTimeout=2000;$request.Method='GET'
    $response=$request.GetResponse();$reader=$null
    try{$healthDiagnostics.httpStatus=[int]$response.StatusCode;$reader=[IO.StreamReader]::new($response.GetResponseStream(),[Text.Encoding]::UTF8,$true);$health=$reader.ReadToEnd()|ConvertFrom-Json}finally{if($reader){$reader.Dispose()};$response.Dispose()}
    Copy-OwnerActivationHealth $health
    $healthDiagnostics.ok=($health.ok -eq $true)
    $healthDiagnostics.cliTransport=if($health.cliTransport -is [string]){$health.cliTransport}else{$null}
    $healthDiagnostics.pid=if($health.pid -is [ValueType]){[long]$health.pid}else{$null}
    $healthDiagnostics.pidIsInt32=($health.pid -is [int] -and $health.pid -gt 0)
    $healthDiagnostics.healthCheckGatePassed=($healthDiagnostics.httpStatus -eq 200 -and $healthDiagnostics.ok -eq $true -and $healthDiagnostics.cliTransport -ceq 'ready' -and $healthDiagnostics.pidIsInt32 -and $healthDiagnostics.pid -gt 0)
    if($healthDiagnostics.healthCheckGatePassed){
     $nodeProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$health.pid) -ErrorAction SilentlyContinue
     $healthDiagnostics.nodeProcessQuery=if($nodeProcess){'filtered'}else{'filtered-miss'}
     if(-not $nodeProcess -and [DateTime]::UtcNow -ge $nextNodeProcessEnumerationAt){
      $nextNodeProcessEnumerationAt=[DateTime]::UtcNow.AddSeconds(1)
      $nodeProcess=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|Where-Object {[long]$_.ProcessId -eq [long]$health.pid}|Select-Object -First 1
      if($nodeProcess){$healthDiagnostics.nodeProcessQuery='enumerated'}
     }
     $healthDiagnostics.nodeProcessFound=($null -ne $nodeProcess)
     if($nodeProcess){
      $healthDiagnostics.nodeParentMatchesControl=($nodeProcess.ParentProcessId -eq $controlLease.ProcessId)
      $healthDiagnostics.nodeExecutableMatchesProductRoot=($nodeProcess.ExecutablePath -ceq (Join-Path $product 'payload\node.exe'))
     }
     if($healthDiagnostics.nodeProcessFound -and $healthDiagnostics.nodeParentMatchesControl -and $healthDiagnostics.nodeExecutableMatchesProductRoot){
      $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 7690 -State Listen -ErrorAction Stop)
      $healthDiagnostics.listenerCount=$listeners.Count
      $healthDiagnostics.listenerOwnerMatches=($listeners.Count -eq 1 -and $listeners[0].OwningProcess -eq $health.pid)
      if($healthDiagnostics.listenerOwnerMatches){$supervisor.VerifyRunning();$controlLease.VerifyRunning();$healthy=$true;break}
     }
    }
   }catch{$errorRecord=$_.Exception.GetBaseException();$healthDiagnostics.lastErrorType=$errorRecord.GetType().Name;if($errorRecord -is [Net.WebException]){$healthDiagnostics.webExceptionStatus=$errorRecord.Status.ToString();if($errorRecord.Response -is [Net.HttpWebResponse]){$healthDiagnostics.httpStatus=[int]$errorRecord.Response.StatusCode;Read-OwnerActivationHealthBody $errorRecord.Response;if(-not $activationEndpointAttempted -and $null -eq $healthDiagnostics.ownerActivationState){$activationEndpointAttempted=$true;Read-OwnerActivationHealthEndpoint}};if($errorRecord.InnerException -is [Net.Sockets.SocketException]){$healthDiagnostics.socketErrorCode=[int]$errorRecord.InnerException.SocketErrorCode};if($errorRecord.Response){$errorRecord.Response.Dispose()}}}
   Start-Sleep -Milliseconds 250
  }while([DateTime]::UtcNow -lt $until)
  if(-not $healthy){$healthDiagnostics.serviceLogs+=,(Get-OwnerActivationServiceLogSummary 'control' (Join-Path $root 'config\logs\service-control.log'));$healthDiagnostics.serviceLogs+=,(Get-OwnerActivationServiceLogSummary 'supervisor' (Join-Path $root 'executor\config\logs\service-supervisor.log'));throw 'OAX_PRODUCT_HEALTH_FAILED'};$transaction.ConfirmHealth()
  @{ok=$true;activationImplemented=$true;configurationCommitted=$true;servicesActivated=$true;productHealthPassed=$true;authorityIssued=$false;privateIdentityRead=$true;mutationPerformed=$true}|ConvertTo-Json -Compress;return
 }
 # Point-in-time observation only. A later mutating coordinator MUST repeat
 # admission while holding its own durable transaction/retained handles.
 @{ok=$true;readOnly=$true;preflightPassed=$true;requiresTransactionRevalidation=$true;privateIdentityRead=$privateRead;mutationPerformed=$false;servicesActivated=$false;authorityIssued=$false;activationImplemented=$false}|ConvertTo-Json -Compress
}catch{
 $code=$_.Exception.GetBaseException().Message;if($code -cnotmatch '^(OAC|OAT|OAX|ODP|OSP|OBD|OIP)_[A-Z_]+$'){$code='OAC_CHECK_FAILED'}
 if($activationAction -ceq 'Activate'){
  if($transaction -and $transaction.Begun){try{$quarantine=$transaction.Quarantine()}catch{$quarantine='quarantine-unconfirmed'}}
  $serviceDiagnostics=@($activationLeases|ForEach-Object {@{role=$_.role;lastStartError=[int]$_.value.LastStartError;lastProcessPinError=[int]$_.value.LastProcessPinError;lastServiceState=[int]$_.value.LastServiceState;lastServiceError=[int]$_.value.LastServiceError;lastSpecificServiceError=[int]$_.value.LastSpecificServiceError;lastServiceProcessId=[long]$_.value.LastServiceProcessId}})
  @{ok=$false;code=$code;stage=$stage;activationImplemented=$true;configurationCommitted=($null -ne $transaction -and $transaction.ConfigurationCommitted);quarantine=$quarantine;privateIdentityRead=$privateRead;mutationPerformed=($null -ne $transaction -and $transaction.Begun);servicesActivated=$false;authorityIssued=$false;serviceDiagnostics=$serviceDiagnostics;healthDiagnostics=$healthDiagnostics}|ConvertTo-Json -Compress;exit 1
 }
 @{ok=$false;code=$code;stage=$stage;readOnly=$true;preflightPassed=$false;privateIdentityRead=$privateRead;mutationPerformed=$false;servicesActivated=$false;authorityIssued=$false;activationImplemented=$false}|ConvertTo-Json -Compress;exit 1
}finally{if($transaction){$transaction.Dispose()};foreach($lease in $activationLeases){$lease.value.Dispose()};foreach($h in $handles){$h.Dispose()};for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}}
