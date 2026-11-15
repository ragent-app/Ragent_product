# Invoked only by the admitted fresh diagnostic MSI test. No signing/trust
# substitutes in the public coordinator; synthetic policy tests the primitive.
function Invoke-PreparedPolicyAcceptance([string]$EvidenceRoot){
 if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository'){throw 'MPQ_DISPOSABLE_REQUIRED'}
 $pack=Join-Path $PSScriptRoot '..\packaging\windows';$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$product='C:\Program Files\Ragent';$root='C:\ProgramData\Ragent\instances\owner'
 $result=[ordered]@{pass=$false;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;publicPositiveSignedAcceptance=$false;policyCoordinatorPositive=$false;rawPolicySynthetic=$true;serviceAdapterSubstituted=$true;identityRead=$false;businessActivated=$false;authorityIssued=$false;checks=@();refusals=@();effectiveOwnerReadTested=$false}
 $paths=@('packaging/windows/prepare-owner-msi-policy.ps1','packaging/windows/prepare-owner-install-policy.ps1','packaging/windows/managed-owner-msi-bridge.cs','packaging/windows/owner-msi-relocation-journal.cs','packaging/windows/build-managed-owner-msi-bridge.ps1','packaging/windows/read-owner-bootstrap-discovery.ps1','packaging/windows/Ragent.ServiceHost.cs','packaging/windows/managed-owner-msi.ps1','packaging/windows/prepare-owner-service-data.ps1','packaging/windows/prepare-owner-services.ps1','tests/windows-managed-policy.ps1','tests/fixtures/windows-policy-access-service.cs','native/windows-owner-bootstrap.cs')
 $result.sourceFiles=@($paths|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}})
 $helper=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe';$release=Join-Path $product 'payload\owner-bootstrap-release.json';$identity=Join-Path $root 'config\instance-identity.json';$probe=Join-Path $product 'PolicyAccessProbe.exe';$security=Join-Path $root 'security';$published=$false;$changed=@();$exclusive=$null
 foreach($p in @($helper,$release,$identity,$probe,$security)){if(Test-Path -LiteralPath $p){throw 'MPQ_EXISTING_INPUT_REFUSED'}}
 $plans=@(Get-OwnerServicePreparationPlan);$services=@(Get-OwnerDataServices);$control=($services|Where-Object {$_.role -eq 'control'}).sid;$executor=($services|Where-Object {$_.role -eq 'supervisor'}).sid
 $receipt=[IO.File]::ReadAllText((Join-Path $product 'owner-msi.prepared.json'))|ConvertFrom-Json
 function Call-Policy([string]$Label,[string]$Expected){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$script:policyBridge;$info.Arguments='policy';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $child=[Diagnostics.Process]::Start($info);try{$o=$child.StandardOutput.ReadToEndAsync();$e=$child.StandardError.ReadToEndAsync();if(-not $child.WaitForExit(130000)){throw 'MPQ_POLICY_TIMEOUT'};if($child.ExitCode -ne 1){throw 'MPQ_UNSIGNED_POLICY_ACCEPTED'};$value=$o.Result|ConvertFrom-Json;if($value.ok -ne $false -or $value.code -cne $Expected -or $value.stage -cne 'signature' -or $value.identityRead -ne $false -or $value.quarantined -ne $false){throw 'MPQ_SIGNATURE_ORDER_CHANGED'};$result.refusals+=@{label=$Label;exitCode=$child.ExitCode;code=$value.code;stage=$value.stage;identityRead=$value.identityRead};[IO.File]::WriteAllText((Join-Path $EvidenceRoot ($Label+'.json')),($value|ConvertTo-Json -Compress));}finally{$child.Dispose()}
  foreach($p in @($security,(Join-Path $product 'owner-policy.prepare-lock'),(Join-Path $product 'owner-msi.policy.json'))){if(Test-Path -LiteralPath $p){throw 'MPQ_UNSIGNED_MUTATION'}}
 }
 try {
  # Locked non-JSON canary proves signature refusal precedes private identity IO.
  [IO.File]::WriteAllText($identity,'QA LOCKED UNREAD PRIVATE-STATE CANARY');$exclusive=[IO.FileStream]::new($identity,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll ('/out:'+$helper) (Join-Path $repo 'native\windows-owner-bootstrap.cs')|Out-Null;if($LASTEXITCODE -ne 0){throw 'MPQ_UNSIGNED_HELPER_COMPILE'}
  Call-Policy 'missing-release' 'OIP_SIGNED_RELEASE_REQUIRED'
  [IO.File]::WriteAllText($release,'invalid-json');Call-Policy 'malformed-release' 'OIP_SIGNED_RELEASE_REQUIRED'
  $digest=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant();$metadata=[ordered]@{version=1;protocolVersion=2;helperFile='Ragent.OwnerBootstrap.exe';helperSha256=('0'*64);publisherSha256=('a'*64)}
  [IO.File]::WriteAllText($release,($metadata|ConvertTo-Json -Compress));Call-Policy 'wrong-helper-hash' 'OPP_HELPER_HASH_MISMATCH'
  $metadata.helperSha256=$digest;[IO.File]::WriteAllText($release,($metadata|ConvertTo-Json -Compress));Call-Policy 'unsigned-matching-helper' 'OIP_SIGNED_RELEASE_REQUIRED'
  $result.checks+='four-real-public-signature-refusals-before-locked-identity-and-any-mutation'
  $exclusive.Dispose();$exclusive=$null;[IO.File]::Delete($identity);[IO.File]::Delete($helper);[IO.File]::Delete($release)
  . (Join-Path $pack 'prepare-owner-install-policy.ps1') -LibraryOnly
  $policy=[pscustomobject][ordered]@{version=1;instanceId=('inst_'+('a'*32));controlSid=$control;executorSid=$executor;ownerSid=$receipt.ownerSid;port=7690}
  $result.policyAncestors=@(for($p=$root;$p;$p=[IO.Path]::GetDirectoryName($p)){@{path=$p;owner=(Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value}})
  # Explicit QA direct primitive call: no signed coordinator positive is claimed.
  $publication=Publish-OwnerInstallPolicy $root $policy;$published=$true
  if(-not $publication.policyPrepared){throw 'MPQ_PRIMITIVE_FAILED'}
  $policyPath=Join-Path $security 'owner-bootstrap-install.json';$before=(Get-FileHash -LiteralPath $policyPath -Algorithm SHA256).Hash.ToLowerInvariant();$result.policySha256=$before
  foreach($p in @($security,$policyPath)){$a=Get-Acl -LiteralPath $p;if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544'){throw 'MPQ_POLICY_NOT_ADMIN_PROTECTED'}}
  $result.checks+='actual-fixed-root-administrator-owned-policy-primitive-publication'
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /main:PolicyAccessService /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll ('/out:'+$probe) (Join-Path $pack 'Ragent.ServiceHost.cs') (Join-Path $repo 'tests\fixtures\windows-policy-access-service.cs')|Out-Null;if($LASTEXITCODE -ne 0){throw 'MPQ_PROBE_COMPILE'}
  foreach($plan in $plans){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'");if($s.PathName -cne $plan.command -or $s.State -cne 'Stopped' -or $s.StartMode -cne 'Disabled'){throw 'MPQ_PROBE_OWNERSHIP'};$response=Invoke-CimMethod -InputObject $s -MethodName Change -Arguments @{PathName=('"'+$probe+'" '+$plan.role);StartMode='Manual'};if($response.ReturnValue -ne 0){throw 'MPQ_PROBE_CONFIG'};$changed+=$plan}
  Start-Service 'Ragent-RunnerSupervisor';Start-Service 'Ragent-ControlPlane';foreach($name in @('Ragent-ControlPlane','Ragent-RunnerSupervisor')){Stop-Service $name;$c=[ServiceProcess.ServiceController]::new($name);try{$c.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}finally{$c.Dispose()}}
  $result.probes=@();foreach($role in @('control','supervisor')){$f=[IO.File]::ReadAllText((Join-Path $root ('workspace\policy-'+$role+'.json')))|ConvertFrom-Json;$sid=if($role -eq 'control'){$control}else{$executor};if($f.sid -cne $sid -or $f.integrityRid -ne 8192 -or $f.sessionId -ne 0 -or -not $f.reducedTokenVerified -or $f.policyRead -ne ($role -eq 'control') -or $f.policyWrite -or $f.securityCreate){throw 'MPQ_EFFECTIVE_ACCESS_FAILED'};$result.probes+=$f}
  if((Get-FileHash -LiteralPath $policyPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before){throw 'MPQ_POLICY_MODIFIED'};$result.checks+='actual-reduced-control-read-only-and-executor-read-write-denial'
  try{Assert-OwnerPolicyInstallComplete;throw 'MPQ_AUTHORITY_GATE_LOST'}catch{if($_.Exception.Message -cne 'OBD_INSTALL_INCOMPLETE'){throw}};$result.checks+='prepared-receipt-still-blocks-native-authority'
  $result.pass=$true
 }catch{$result.error=$_.Exception.GetBaseException().Message;throw}
 finally {
  if($exclusive){$exclusive.Dispose()}
  foreach($plan in $changed){$s=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'");if($s.PathName -cne ('"'+$probe+'" '+$plan.role)){throw 'MPQ_CLEANUP_UNKNOWN_SERVICE'};if($s.State -ne 'Stopped'){Stop-Service $plan.name -ErrorAction Stop;$c=[ServiceProcess.ServiceController]::new($plan.name);try{$c.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}finally{$c.Dispose()}};$response=Invoke-CimMethod -InputObject $s -MethodName Change -Arguments @{PathName=$plan.command;StartMode='Disabled'};if($response.ReturnValue -ne 0){throw 'MPQ_RESTORE_FAILED'}}
  if($published){$p=Join-Path $security 'owner-bootstrap-install.json';if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $result.policySha256){throw 'MPQ_CLEANUP_UNKNOWN_POLICY'};[IO.File]::Delete($p);[IO.Directory]::Delete($security)}
  foreach($p in @($identity,$helper,$release,$probe)){if(Test-Path -LiteralPath $p){[IO.File]::Delete($p)}}
  $null=@(Get-OwnerDataServices)
  [IO.File]::WriteAllText((Join-Path $EvidenceRoot 'policy-report.json'),($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
 }
 return $result
}
