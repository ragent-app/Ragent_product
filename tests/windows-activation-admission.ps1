# Disposable QA only: synthetic public policy/receipts and a genuinely UNSIGNED
# compiled helper. No valid-signature substitute or public positive is used.
function Invoke-ActivationAdmissionAcceptance([string]$Bridge,[string]$EvidenceRoot){
 if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository'){throw 'AAQ_DISPOSABLE_REQUIRED'}
 $product='C:\Program Files\Ragent';$root='C:\ProgramData\Ragent\instances\owner';$pack=Join-Path $PSScriptRoot '..\packaging\windows';$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
 $recordPath=Join-Path $product 'owner-msi.policy.json';$releasePath=Join-Path $product 'payload\owner-bootstrap-release.json';$helperPath=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe';$identityPath=Join-Path $root 'config\instance-identity.json';$policyPath=Join-Path $root 'security\owner-bootstrap-install.json';$marker=Join-Path $product 'owner-activation.prepare-lock';$park=$recordPath+'.qa-parked'
 $savedRecord=[IO.File]::ReadAllBytes($recordPath);$savedRelease=[IO.File]::ReadAllBytes($releasePath);$savedHelper=[IO.File]::ReadAllBytes($helperPath);$privateLease=$null;$leases=@();$parked=$false
 $result=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;syntheticPolicyReceipt=$true;compiledUnsignedHelper=$true;publicPositiveSignedAcceptance=$false;privateIdentityRead=$false;businessActivated=$false;authorityIssued=$false;checkMutationObserved=$false;qaSetupMutatedInputs=$true;privateCanaryExclusiveDuringChecks=$true;checks=@();refusals=@();retainedHandleRefusals=@();activationRefusals=@()}
 $result.sourceFiles=@('packaging/windows/check-owner-msi-activation.ps1','packaging/windows/owner-activation-service-read.cs','packaging/windows/prepare-owner-install-policy.ps1','tests/windows-activation-admission.ps1','tests/windows-policy-removal.ps1','native/windows-owner-bootstrap.cs','packaging/windows/owner-service-activation-trial.cs','packaging/windows/initialize-owner-service-identity.ps1','packaging/windows/prepare-owner-msi-policy.ps1','packaging/windows/owner-service-activation-transaction.cs')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}
 function Call-ActualActivation([string]$Label,[string]$Code,[string]$Stage){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Bridge;$info.Arguments='activate';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $p=[Diagnostics.Process]::Start($info);try{$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(250000)){throw 'AAQ_ACTIVATE_TIMEOUT'};[IO.File]::WriteAllText((Join-Path $EvidenceRoot ('actual-activate-'+$Label+'.json')),(@{exitCode=$p.ExitCode;stdout=$o.Result;stderr=$e.Result}|ConvertTo-Json -Compress));$v=$o.Result|ConvertFrom-Json
   if($p.ExitCode -ne 1 -or $e.Result.Trim() -or $v.ok -ne $false -or $v.code -cne $Code -or $v.stage -cne $Stage -or $v.activationImplemented -ne $true -or $v.configurationCommitted -ne $false -or $v.quarantine -cne 'not-started' -or $v.privateIdentityRead -ne $false -or $v.mutationPerformed -ne $false -or $v.servicesActivated -ne $false -or $v.authorityIssued -ne $false){throw 'AAQ_ACTIVATE_REFUSAL_CHANGED'};$result.activationRefusals+=@{label=$Label;code=$v.code;stage=$v.stage;mutationPerformed=$false;privateIdentityRead=$false}
  }finally{$p.Dispose()}
 }
 function Call-Activation([string]$Label,[string]$Code,[string]$Stage){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Bridge;$info.Arguments='activation-check';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $p=[Diagnostics.Process]::Start($info);try{$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(130000)){throw 'AAQ_CHECK_TIMEOUT'}
   [IO.File]::WriteAllText((Join-Path $EvidenceRoot ('activation-'+$Label+'.json')),(@{exitCode=$p.ExitCode;stdout=$o.Result;stderr=$e.Result}|ConvertTo-Json -Compress))
   $v=$o.Result|ConvertFrom-Json;if($p.ExitCode -ne 1 -or $e.Result.Trim() -or $v.ok -ne $false -or $v.code -cne $Code -or $v.stage -cne $Stage -or $v.readOnly -ne $true -or $v.preflightPassed -ne $false -or $v.privateIdentityRead -ne $false -or $v.mutationPerformed -ne $false -or $v.servicesActivated -ne $false -or $v.authorityIssued -ne $false -or $v.activationImplemented -ne $false){throw 'AAQ_REFUSAL_CHANGED'}
   $result.refusals+=@{label=$Label;code=$v.code;stage=$v.stage;exitCode=$p.ExitCode;privateIdentityRead=$v.privateIdentityRead}
  }finally{$p.Dispose()}
  if($Label -cne 'pending' -and (Test-Path -LiteralPath $marker)){throw 'AAQ_CHECK_CREATED_MARKER'}
  foreach($m in @('owner-services.prepare-lock','owner-data.prepare-lock','owner-msi.prepare-lock','owner-identity.initialize-lock','owner-policy.prepare-lock')){if(Test-Path -LiteralPath (Join-Path $product $m)){throw 'AAQ_CHECK_CREATED_MARKER'}}
 }
 function Expect-RetainedRefusal($Lease,[string]$Code){try{$Lease.Verify();throw 'AAQ_CHANGED_HANDLE_ACCEPTED'}catch{$actual=$_.Exception.GetBaseException().Message;if($actual -cne $Code){throw};$result.retainedHandleRefusals+=$actual}}
 try {
  if(Test-Path -LiteralPath $park){throw 'AAQ_EXISTING_PARK'};if(Test-Path -LiteralPath $marker){throw 'AAQ_EXISTING_MARKER'}
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll ('/out:'+$helperPath) (Join-Path $repo 'native\windows-owner-bootstrap.cs')|Out-Null;if($LASTEXITCODE -ne 0){throw 'AAQ_HELPER_COMPILE'}
  $signature=Get-AuthenticodeSignature -LiteralPath $helperPath;$result.helperSignatureStatus=[string]$signature.Status;if($result.helperSignatureStatus -cne 'NotSigned'){throw 'AAQ_UNSIGNED_REQUIRED'}
  $release=[Text.Encoding]::UTF8.GetString($savedRelease)|ConvertFrom-Json;$release.helperSha256=(Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant();[IO.File]::WriteAllText($releasePath,($release|ConvertTo-Json -Compress))
  $record=[Text.Encoding]::UTF8.GetString($savedRecord)|ConvertFrom-Json;$record.helperSha256=$release.helperSha256;$record.releaseSha256=(Get-FileHash -LiteralPath $releasePath -Algorithm SHA256).Hash.ToLowerInvariant();[IO.File]::WriteAllText($recordPath,($record|ConvertTo-Json -Compress));$baselineRecord=[IO.File]::ReadAllBytes($recordPath)
  $paths=@((Join-Path $product 'owner-msi.prepared.json'),$recordPath,$policyPath,$releasePath,$helperPath,$identityPath);$result.preserved=@($paths|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}})
  $result.before=@(Observe);$privateLease=[IO.FileStream]::new($identityPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  Call-Activation 'unsigned-matching' 'OAC_SIGNED_HELPER_REQUIRED' 'signature'
  Call-ActualActivation 'unsigned-matching' 'OAC_SIGNED_HELPER_REQUIRED' 'signature'
  Move-Item -LiteralPath $recordPath -Destination $park;$parked=$true;try{Call-Activation 'missing-policy-receipt' 'OAC_PREPARATION_RECEIPTS_REQUIRED' 'receipts'}finally{Move-Item -LiteralPath $park -Destination $recordPath;$parked=$false}
  [IO.File]::WriteAllText($recordPath,'NOT-JSON');try{Call-Activation 'malformed-policy-receipt' 'OAC_METADATA_INVALID' 'receipts'}finally{[IO.File]::WriteAllBytes($recordPath,$baselineRecord)}
  foreach($case in @(@('policy-digest','policySha256',('0'*64),'OAC_POLICY_HASH_MISMATCH','policy'),@('policy-binding','instanceId',('inst_'+('c'*32)),'OAC_POLICY_BINDING_MISMATCH','policy'),@('release-digest','releaseSha256',('0'*64),'OAC_PUBLIC_INPUT_HASH_MISMATCH','signature'),@('helper-digest','helperSha256',('0'*64),'OAC_PUBLIC_INPUT_HASH_MISMATCH','signature'))){$bad=[Text.Encoding]::UTF8.GetString($baselineRecord)|ConvertFrom-Json;$bad.($case[1])=$case[2];[IO.File]::WriteAllText($recordPath,($bad|ConvertTo-Json -Compress));try{Call-Activation $case[0] $case[3] $case[4]}finally{[IO.File]::WriteAllBytes($recordPath,$baselineRecord)}}
  [IO.File]::WriteAllText($marker,'OWN-QA-ACTIVATION-MARKER');try{Call-Activation 'pending' 'OAC_PENDING_TRANSACTION' 'pending';Call-ActualActivation 'pending' 'OAC_PENDING_TRANSACTION' 'pending';if([IO.File]::ReadAllText($marker) -cne 'OWN-QA-ACTIVATION-MARKER'){throw 'AAQ_MARKER_RECLAIMED'};$result.pendingMarkerPreserved=$true}finally{[IO.File]::Delete($marker)}
  $result.checks+='unsigned-helper-and-inconsistent-public-state-refused-before-exclusively-locked-private-identity'
  Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $pack 'owner-activation-service-read.cs')))
  foreach($plan in @(Get-OwnerServicePreparationPlan)){$leases+=@{role=$plan.role;value=[OwnerActivationServiceRead]::new($plan.name,$plan.command)}}
  $controlLease=($leases|Where-Object {$_.role -eq 'control'}).value;$controlService=Get-CimInstance Win32_Service -Filter "Name='Ragent-ControlPlane'"
  $changed=Invoke-CimMethod -InputObject $controlService -MethodName Change -Arguments @{ServiceDependencies=[string[]]@('EventLog')};if($changed.ReturnValue -ne 0){throw 'AAQ_DEPENDENCY_SETUP'}
  try{Expect-RetainedRefusal $controlLease 'OAC_SERVICE_CONFIGURATION_CHANGED';Call-Activation 'changed-dependency' 'OAC_SERVICE_CONFIGURATION_CHANGED' 'services'}finally{$restored=Invoke-CimMethod -InputObject $controlService -MethodName Change -Arguments @{ServiceDependencies=[string[]]@('Ragent-RunnerSupervisor')};if($restored.ReturnValue -ne 0){throw 'AAQ_DEPENDENCY_RESTORE'}}
  & 'C:\Windows\System32\sc.exe' privs Ragent-ControlPlane SeChangeNotifyPrivilege/SeImpersonatePrivilege|Out-Null;if($LASTEXITCODE -ne 0){throw 'AAQ_PRIVILEGE_SETUP'}
  try{Expect-RetainedRefusal $controlLease 'OAC_SERVICE_PRIVILEGES_CHANGED';Call-Activation 'changed-privileges' 'OAC_SERVICE_PRIVILEGES_CHANGED' 'services'}finally{& 'C:\Windows\System32\sc.exe' privs Ragent-ControlPlane SeChangeNotifyPrivilege|Out-Null;if($LASTEXITCODE -ne 0){throw 'AAQ_PRIVILEGE_RESTORE'}}
  foreach($lease in $leases){$lease.value.Verify()};Call-Activation 'unsigned-after-restoration' 'OAC_SIGNED_HELPER_REQUIRED' 'signature'
  $result.checks+='actual-query-only-retained-service-handles-detect-dependency-and-privilege-drift-without-repair'
  $privateLease.Dispose();$privateLease=$null
  foreach($p in $result.preserved){if((Get-FileHash -LiteralPath $p.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $p.sha256){throw 'AAQ_INPUT_MUTATED'}}
  $result.after=@(Observe);$result.checks+='all-public-inputs-private-canary-and-disabled-services-preserved';$result.pass=$true
 }catch{$result.error=$_.Exception.GetBaseException().Message;throw}
 finally{if($privateLease){$privateLease.Dispose()};foreach($lease in $leases){$lease.value.Dispose()};if($parked){Move-Item -LiteralPath $park -Destination $recordPath};[IO.File]::WriteAllBytes($recordPath,$savedRecord);[IO.File]::WriteAllBytes($releasePath,$savedRelease);[IO.File]::WriteAllBytes($helperPath,$savedHelper);[IO.File]::WriteAllText((Join-Path $EvidenceRoot 'activation-admission-report.json'),($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))}
 return $result
}
