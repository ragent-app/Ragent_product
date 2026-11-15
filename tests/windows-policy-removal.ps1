# Disposable guest only. Synthetic public policy/receipt do not assert a signed
# coordinator positive. Private-state canary stays exclusively locked on removal.
function Invoke-PolicyRemovalAcceptance([string]$MsiPath,[string]$OwnerSid,[string]$EvidenceRoot,[switch]$OrdinaryCaller,[switch]$ActivationAdmission){
 if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository'){throw 'PRQ_DISPOSABLE_REQUIRED'}
 $pack=Join-Path $PSScriptRoot '..\packaging\windows';$product='C:\Program Files\Ragent';$root='C:\ProgramData\Ragent\instances\owner';$bridge=Join-Path $work 'Ragent.ManagedOwnerMsiBridge.exe';$privateLease=$null
 $result=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;syntheticPolicyReceipt=$true;publicPositiveSignedAcceptance=$false;privateIdentityRead=$false;businessActivated=$false;authorityIssued=$false;testOnlyInterruptedState=$true;checks=@();refusals=@()}
 $result.sourceFiles=@('packaging/windows/remove-owner-msi-policy.ps1','packaging/windows/managed-owner-msi-bridge.cs','packaging/windows/owner-msi-relocation-journal.cs','packaging/windows/build-managed-owner-msi-bridge.ps1','packaging/windows/managed-owner-msi.ps1','packaging/windows/prepare-owner-install-policy.ps1','packaging/windows/prepare-owner-service-data.ps1','packaging/windows/read-owner-bootstrap-discovery.ps1','tests/windows-policy-removal.ps1')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}
 if($OrdinaryCaller){$result.sourceFiles+=@('tests/windows-ordinary-uninstall.ps1','tests/fixtures/windows-ordinary-uninstall.cs')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}}
 function Call-RemovalCheck([string]$Label,[string]$Code=''){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$bridge;$info.Arguments='remove-check';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $p=[Diagnostics.Process]::Start($info);try{$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(130000)){throw 'PRQ_CHECK_TIMEOUT'};if($Code){if($p.ExitCode -ne 1){throw 'PRQ_BAD_STATE_ADMITTED'};if($Code.StartsWith('OMI_')){if($e.Result.Trim() -cne $Code){throw 'PRQ_REFUSAL_CHANGED'}}else{$v=$o.Result|ConvertFrom-Json;if($v.ok -ne $false -or $v.code -cne $Code -or $v.quarantined -ne $false -or $v.privateIdentityRead -ne $false -or $v.dataRemoved -ne $false){throw 'PRQ_REFUSAL_CHANGED'}};$result.refusals+=@{label=$Label;exitCode=1;code=$Code}}else{if($p.ExitCode -ne 0){throw 'PRQ_VALID_STATE_REFUSED'};$v=$o.Result|ConvertFrom-Json;if(-not $v.ok -or -not $v.policyPreparedOnly -or $v.servicesRemoved -or $v.privateIdentityRead -or $v.dataRemoved -or $v.authorityIssued){throw 'PRQ_CHECK_MUTATED'}};[IO.File]::WriteAllText((Join-Path $EvidenceRoot ($Label+'.json')),(@{exitCode=$p.ExitCode;stdout=$o.Result;stderr=$e.Result}|ConvertTo-Json -Compress))}finally{$p.Dispose()}
 }
 function New-SyntheticRemovalState {
  . (Join-Path $pack 'prepare-owner-install-policy.ps1') -LibraryOnly
  $s=@(Get-OwnerDataServices);$policy=[pscustomobject][ordered]@{version=1;instanceId=('inst_'+('b'*32));controlSid=($s|Where-Object {$_.role -eq 'control'}).sid;executorSid=($s|Where-Object {$_.role -eq 'supervisor'}).sid;ownerSid=$OwnerSid;port=7690}
  $null=Publish-OwnerInstallPolicy $root $policy
  $helper=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe';[IO.File]::WriteAllText($helper,'SYNTHETIC-UNSIGNED-REMOVAL-INPUT')
  $release=[ordered]@{version=1;protocolVersion=2;helperFile='Ragent.OwnerBootstrap.exe';helperSha256=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant();publisherSha256=('a'*64)};$releasePath=Join-Path $product 'payload\owner-bootstrap-release.json';[IO.File]::WriteAllText($releasePath,($release|ConvertTo-Json -Compress))
  $identity=Join-Path $root 'config\instance-identity.json';[IO.File]::WriteAllText($identity,'NON-JSON-EXCLUSIVE-PRIVATE-CANARY')
  $record=[ordered]@{version=1;purpose='owner-msi-policy-preparation';phase='policy-prepared';instanceId=$policy.instanceId;policySha256=(Get-FileHash -LiteralPath (Join-Path $root 'security\owner-bootstrap-install.json') -Algorithm SHA256).Hash.ToLowerInvariant();releaseSha256=(Get-FileHash -LiteralPath $releasePath -Algorithm SHA256).Hash.ToLowerInvariant();helperSha256=$release.helperSha256;publisherSha256=$release.publisherSha256;identitySha256=(Get-FileHash -LiteralPath $identity -Algorithm SHA256).Hash.ToLowerInvariant()}
  [IO.File]::WriteAllText((Join-Path $product 'owner-msi.policy.json'),($record|ConvertTo-Json -Compress))
 }
 try {
  if((Msi 'policy-fresh' ('/i "'+$MsiPath+'" RAGENT_OWNER_SID='+$OwnerSid)) -ne 0){throw 'PRQ_FRESH_FAILED'}
  New-SyntheticRemovalState
  if($ActivationAdmission){. (Join-Path $PSScriptRoot 'windows-activation-admission.ps1');$result.activationAdmission=Invoke-ActivationAdmissionAcceptance $bridge $EvidenceRoot;if(-not $result.activationAdmission.pass){throw 'PRQ_ACTIVATION_ADMISSION_FAILED'}}
  $result.before=@(Observe);$receipt=Join-Path $product 'owner-msi.policy.json';$original=[IO.File]::ReadAllBytes($receipt);$policyPath=Join-Path $root 'security\owner-bootstrap-install.json';$policyBytes=[IO.File]::ReadAllBytes($policyPath)
  $preserved=@((Join-Path $product 'owner-msi.prepared.json'),$receipt,$policyPath,(Join-Path $root 'config\instance-identity.json'));$result.preserved=@($preserved|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}})
  $privateLease=[IO.FileStream]::new((Join-Path $root 'config\instance-identity.json'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  Call-RemovalCheck 'policy-valid-check'
  $bad=[Text.Encoding]::UTF8.GetString($original)|ConvertFrom-Json;$bad.policySha256='0'*64;[IO.File]::WriteAllText($receipt,($bad|ConvertTo-Json -Compress));Call-RemovalCheck 'policy-bad-digest' 'ORP_POLICY_HASH_MISMATCH'
  if((Msi 'policy-invalid-receipt-refused' ('/x "'+$MsiPath+'"')) -ne 1603 -or -not(Test-Path -LiteralPath (Join-Path $product 'Ragent.ServiceHost.exe'))){throw 'PRQ_BAD_RECEIPT_MUTATED'}
  [IO.File]::WriteAllBytes($receipt,$original)
  foreach($entry in @(@('owner-policy.prepare-lock','OMI_POLICY_PHASE_REFUSED'),@('owner-msi.prepare-lock','OMI_PREPARATION_INCOMPLETE'))){$path=Join-Path $product $entry[0];[IO.File]::WriteAllText($path,'OWN-TEST-PENDING');Call-RemovalCheck $entry[0] $entry[1];if(-not(Test-Path -LiteralPath $path)){throw 'PRQ_LOCK_RECLAIMED'};[IO.File]::Delete($path)}
  $inner=Join-Path $root 'owner-policy.install-lock';[IO.File]::WriteAllText($inner,'OWN-TEST-PENDING');Call-RemovalCheck 'policy-inner-pending' 'ORP_PENDING_TRANSACTION';[IO.File]::Delete($inner)
  $result.checks+='valid-public-check-and-invalid-receipt-pending-markers-refused-before-mutation'
  Set-Service 'Ragent-ControlPlane' -StartupType Manual
  if((Msi 'policy-changed-service-refused' ('/x "'+$MsiPath+'"')) -ne 1603 -or -not(Test-Path -LiteralPath (Join-Path $product 'Ragent.ServiceHost.exe'))){throw 'PRQ_CHANGED_SERVICE_MUTATED'}
  Set-Service 'Ragent-ControlPlane' -StartupType Disabled;$result.afterRefusals=@(Observe)
  $ordinaryRemoved=$false
  if($OrdinaryCaller){. (Join-Path $PSScriptRoot 'windows-ordinary-uninstall.ps1');$result.ordinaryCaller=Invoke-OrdinaryUninstallProbe $bridge $MsiPath $EvidenceRoot;$ordinaryRemoved=($result.ordinaryCaller.msi.exitCode -eq 0)}
  if($ordinaryRemoved){Copy-Item -LiteralPath (Join-Path $EvidenceRoot 'ordinary-msi.log') -Destination (Join-Path $EvidenceRoot 'policy-uninstall.msi.log');$report.operations+=@{name='policy-uninstall';exitCode=0}}elseif((Msi 'policy-uninstall' ('/x "'+$MsiPath+'"')) -ne 0){throw 'PRQ_UNINSTALL_FAILED'}
  foreach($name in @('Ragent-ControlPlane','Ragent-RunnerSupervisor')){if(Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")){throw 'PRQ_SERVICE_REMAINS'}}
  if(Test-Path -LiteralPath (Join-Path $product 'Ragent.ServiceHost.exe')){throw 'PRQ_CODE_REMAINS'}
  if(Test-Path -LiteralPath (Join-Path $product 'owner-msi.prepare-lock')){throw 'PRQ_SUCCESS_LOCK_REMAINS'}
  $privateLease.Dispose();$privateLease=$null
  foreach($f in $result.preserved){if((Get-FileHash -LiteralPath $f.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'PRQ_DATA_CHANGED'}}
  $result.checks+='actual-msi-removes-only-disabled-services-and-code-preserves-locked-private-state-policy-and-receipts'
  if((Msi 'policy-retained-data-refused' ('/i "'+$MsiPath+'" RAGENT_OWNER_SID='+$OwnerSid)) -ne 1603){throw 'PRQ_RETAINED_STATE_ADOPTED'}
  $result.checks+='fresh-reinstall-refuses-retained-policy-state'
  Clear-OwnedRoots
  if((Msi 'policy-interrupted-fresh' ('/i "'+$MsiPath+'" RAGENT_OWNER_SID='+$OwnerSid)) -ne 0){throw 'PRQ_SECOND_FRESH_FAILED'}
  New-SyntheticRemovalState
  # Explicit QA model of an interrupted deletion, not a product fault-injection
  # result. Only an exact verified own service handle is deleted; marker kept.
  $marker=Join-Path $product 'owner-msi.prepare-lock';[IO.File]::WriteAllText($marker,'{"version":1,"purpose":"owner-policy-removal"}')
  if(-not ('ManagedPreparedService' -as [type])){$source=[IO.File]::ReadAllText((Join-Path $pack 'managed-owner-msi.ps1'));$match=[regex]::Match($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@");Add-Type -TypeDefinition $match.Groups[1].Value}
  $plan=@(Get-OwnerServicePreparationPlan)|Where-Object {$_.role -eq 'control'};$h=[ManagedPreparedService]::new($plan.name,$plan.command,$plan.account);try{$h.Remove()}finally{$h.Dispose()}
  Call-RemovalCheck 'policy-interrupted-check' 'OMI_PREPARATION_INCOMPLETE'
  if((Msi 'policy-interrupted-removal-refused' ('/x "'+$MsiPath+'"')) -ne 1603 -or -not(Test-Path -LiteralPath $marker) -or -not(Test-Path -LiteralPath (Join-Path $product 'Ragent.ServiceHost.exe'))){throw 'PRQ_INTERRUPTED_STATE_ADOPTED'}
  $result.checks+='modeled-interrupted-deletion-keeps-quarantine-and-refuses-removal-without-auto-recovery'
  $result.pass=$true
 }catch{$result.error=$_.Exception.GetBaseException().Message;throw}
 finally{if($privateLease){$privateLease.Dispose()};[IO.File]::WriteAllText((Join-Path $EvidenceRoot 'policy-removal-report.json'),($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))}
 return $result
}
