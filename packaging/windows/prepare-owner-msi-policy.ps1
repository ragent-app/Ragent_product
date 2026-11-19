# Embedded fixed-path policy preparation. No service activation, caller policy,
# signer substitution, existing-state adoption or uncertainty recovery.
[CmdletBinding()]
param([switch]$Commit,[ValidateSet('Policy')][string]$Action='Policy')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$msiPolicyCommit=$Commit.IsPresent -or $PSBoundParameters.ContainsKey('Action')
. (Join-Path $PSScriptRoot 'managed-owner-msi.ps1') -LibraryOnly
. (Join-Path $PSScriptRoot 'prepare-owner-install-policy.ps1') -LibraryOnly
$pins=[Collections.Generic.List[IDisposable]]::new();$handles=[Collections.Generic.List[ManagedPreparedService]]::new()
$product=Get-OwnerProductRoot;$root=Get-OwnerInstanceRoot;$lockPath=Join-Path $product 'owner-policy.prepare-lock';$lease=$null;$complete=$false;$identityRead=$false;$stage='services'
try {
 $services=@(Get-OwnerDataServices)
 if(-not $msiPolicyCommit){@{ok=$true;readOnly=$true;policyPrepared=$false;servicesActivated=$false;identityRead=$false}|ConvertTo-Json -Compress;return}
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OPP_ADMIN_REQUIRED'}
 $stage='inputs';Open-OwnerServicePreparationInputs $pins
 foreach($name in @('owner-services.prepare-lock','owner-data.prepare-lock','owner-msi.prepare-lock','owner-identity.initialize-lock','owner-activation.prepare-lock','owner-policy.prepare-lock','owner-msi.policy.json')){if(Test-OwnerServicePreparationPresence (Join-Path $product $name)){throw 'OPP_TRANSACTION_OR_POLICY_PRESENT'}}
 foreach($path in @((Join-Path $root 'security'),(Join-Path $root 'owner-policy.install-lock'))){if(Test-OwnerServicePreparationPresence $path){throw 'OPP_EXISTING_POLICY_REFUSED'}}
 $stage='receipt';$bytes=Read-OwnerPinnedFile (Join-Path $product 'owner-msi.prepared.json') @(Get-OwnerAdministrativeSids) $pins
 $receipt=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json
 if(@($receipt.PSObject.Properties).Count -ne 4 -or -not (Test-OwnerJsonInteger $receipt.version 1 1) -or $receipt.purpose -cne 'owner-msi-preparation' -or $receipt.phase -cne 'prepared' -or $receipt.ownerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'OPP_PREPARED_RECEIPT_REQUIRED'}
 $stage='layout';for($parent=(Get-OwnerProgramDataPath);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){$pins.Add([RagentOwnerFilePin]::Directory($parent));Assert-OwnerObjectAcl $parent @(Get-OwnerAdministrativeSids) -Ancestor -Pins $pins}
 $controlSid=($services|Where-Object {$_.role -eq 'control'}).sid;$executorSid=($services|Where-Object {$_.role -eq 'supervisor'}).sid
 foreach($row in @(Get-OwnerDataLayout $controlSid $executorSid $receipt.ownerSid)){
  $path=if($row.relative){Join-Path (Get-OwnerDataRoot) $row.relative}else{Get-OwnerDataRoot}
  $pins.Add([RagentOwnerFilePin]::Directory($path));$acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or (Get-OwnerDataAclSddl $acl ([Security.AccessControl.AccessControlSections]::Access)) -cne (Get-OwnerDataAclSddl (New-OwnerDataAcl $row.grants $row.traverseOnly) ([Security.AccessControl.AccessControlSections]::Access))){throw 'OPP_LAYOUT_MISMATCH'}
 }
 foreach($p in @(Get-OwnerServicePreparationPlan)){$handles.Add([ManagedPreparedService]::new($p.name,$p.command,$p.account))}
 # The signature gate precedes any identity/result/container open or mutation.
 $stage='signature';$releasePath=Join-Path $product 'payload\owner-bootstrap-release.json';$helperPath=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe'
 if(-not(Test-OwnerServicePreparationPresence $releasePath) -or -not(Test-OwnerServicePreparationPresence $helperPath)){throw 'OIP_SIGNED_RELEASE_REQUIRED'}
 $releaseBytes=Read-OwnerPinnedFile $releasePath @(Get-OwnerAdministrativeSids) $pins
 try{$release=[Text.UTF8Encoding]::new($false,$true).GetString($releaseBytes)|ConvertFrom-Json;Assert-OwnerPolicyRelease $release}catch{throw 'OIP_SIGNED_RELEASE_REQUIRED'}
 $helperBytes=Read-OwnerPinnedFile $helperPath @(Get-OwnerAdministrativeSids) $pins 4194304
 if($release.helperSha256 -cne (Get-OwnerDigest $helperBytes)){throw 'OPP_HELPER_HASH_MISMATCH'}
 try{$trust=Get-OwnerReleaseTrust $release $helperBytes $helperPath}catch{throw 'OIP_SIGNED_RELEASE_REQUIRED'}
 $stage='identity';$identityRead=$true
 $factsBytes=Read-OwnerPinnedFile (Join-Path $root 'config\owner-identity.result.json') (@(Get-OwnerAdministrativeSids)+@($controlSid)) $pins
 $facts=[Text.UTF8Encoding]::new($false,$true).GetString($factsBytes)|ConvertFrom-Json
 if(-not (Test-OwnerJsonInteger $facts.version 1 1) -or $facts.initialized -isnot [bool] -or $facts.initialized -ne $true -or $facts.sid -cne $controlSid -or -not (Test-OwnerJsonInteger $facts.sessionId 0 0) -or -not (Test-OwnerJsonInteger $facts.integrityRid 8192 8192) -or $facts.onlyChangeNotify -isnot [bool] -or $facts.onlyChangeNotify -ne $true){throw 'OPP_INITIALIZATION_REQUIRED'}
 $identityBytes=Read-OwnerPinnedFile (Join-Path $root 'config\instance-identity.json') (@(Get-OwnerAdministrativeSids)+@($controlSid)) $pins 32768
 try{$identity=[Text.UTF8Encoding]::new($false,$true).GetString($identityBytes)|ConvertFrom-Json}catch{throw 'OPP_IDENTITY_INVALID'}
 if($identity.instanceId -cnotmatch '^inst_[a-f0-9]{32}$' -or $identity.algorithm -cne 'ed25519'){throw 'OPP_IDENTITY_INVALID'}
 $policy=[pscustomobject][ordered]@{version=1;instanceId=$identity.instanceId;controlSid=$controlSid;executorSid=$executorSid;ownerSid=$receipt.ownerSid;port=7690}
 Assert-OwnerInstallPolicy $policy
 $stage='publish';$lease=[IO.FileStream]::new($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 $bytes=[Text.Encoding]::UTF8.GetBytes('{"version":1,"purpose":"owner-policy-preparation"}');$lease.Write($bytes,0,$bytes.Length);$lease.Flush($true)
 foreach($h in $handles){$h.Verify()}
 $result=Publish-OwnerInstallPolicy $root $policy
 if(-not $result.policyPrepared){throw 'OPP_PUBLICATION_FAILED'}
 foreach($h in $handles){$h.Verify()}
 # A second admin-owned receipt binds the prepared policy and verified input
 # generations. Both receipts remain startup/authority gates until activation.
 $record=[ordered]@{version=$release.version;purpose='owner-msi-policy-preparation';phase='policy-prepared';instanceId=$policy.instanceId;policySha256=$result.policySha256;releaseSha256=(Get-OwnerDigest $releaseBytes);helperSha256=$release.helperSha256;identitySha256=(Get-OwnerDigest $identityBytes)}
 if($release.version -eq 2){$record.trustMode=$trust.trustMode}else{$record.publisherSha256=$trust.publisherSha256}
 $target=Join-Path $product 'owner-msi.policy.json';$file=[IO.FileStream]::new($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress));$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
 $check=Read-OwnerPinnedFile $target @(Get-OwnerAdministrativeSids) $pins
 if([Convert]::ToBase64String($check) -cne [Convert]::ToBase64String($bytes)){throw 'OPP_RECEIPT_CONFIRMATION_FAILED'}
 $complete=$true
 @{ok=$true;policyPrepared=$true;policySha256=$result.policySha256;preparedReceiptPreserved=$true;identityRead=$true;servicesActivated=$false;authorityIssued=$false}|ConvertTo-Json -Compress
}catch{
 $code=$_.Exception.GetBaseException().Message;if($code -cnotmatch '^(OPP|OIP|ODP|OSP|OBD)_[A-Z_]+$'){$code='OPP_PREPARATION_FAILED'}
 @{ok=$false;code=$code;stage=$stage;identityRead=$identityRead;quarantined=($null -ne $lease);policyPrepared=$false;servicesActivated=$false;authorityIssued=$false}|ConvertTo-Json -Compress
 exit 1
}finally{
 foreach($h in $handles){$h.Dispose()}
 if($lease){$lease.Dispose();if($complete){[IO.File]::Delete($lockPath)}}
 for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}
}
