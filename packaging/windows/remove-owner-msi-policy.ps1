# Fixed prepared/activated installation removal. Active removal stops only the
# retained service processes. No private identity reads, data deletion or repair.
[CmdletBinding()]
param([ValidateSet('Check','Remove','ActiveCheck','ActiveRemove')][string]$Action='Check')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$policyRemoveAction=$Action
. (Join-Path $PSScriptRoot 'managed-owner-msi.ps1') -LibraryOnly
. (Join-Path $PSScriptRoot 'prepare-owner-install-policy.ps1') -LibraryOnly
$pins=[Collections.Generic.List[IDisposable]]::new();$services=[Collections.Generic.List[IDisposable]]::new();$lease=$null;$complete=$false;$activeRemoval=$policyRemoveAction.StartsWith('Active',[StringComparison]::Ordinal)
$product=Get-OwnerProductRoot;$root=Get-OwnerInstanceRoot;$marker=Join-Path $product 'owner-msi.prepare-lock';$removedMarker=Join-Path $product 'owner-msi.removed.json'
function Read-PolicyRemovalJson([string]$Path,[int]$Limit=8192){
 $bytes=Read-OwnerPinnedFile $Path @(Get-OwnerAdministrativeSids) $pins $Limit
 try{$value=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json}catch{throw 'ORP_PUBLIC_METADATA_INVALID'}
 return @{value=$value;bytes=$bytes}
}
function Assert-PolicyRemovalKeys($Value,[string[]]$Keys){if(@($Value.PSObject.Properties).Count -ne $Keys.Count -or @($Value.PSObject.Properties.Name|Where-Object {$_ -cnotin $Keys}).Count){throw 'ORP_PUBLIC_METADATA_INVALID'}}
try {
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ORP_ADMIN_REQUIRED'}
 Open-OwnerServicePreparationInputs $pins
 foreach($name in @('owner-services.prepare-lock','owner-data.prepare-lock','owner-msi.prepare-lock','owner-identity.initialize-lock','owner-activation.prepare-lock','owner-policy.prepare-lock')){if($activeRemoval -and $name -ceq 'owner-activation.prepare-lock'){continue};if(Test-OwnerServicePreparationPresence (Join-Path $product $name)){throw 'ORP_PENDING_TRANSACTION'}}
 if(Test-OwnerServicePreparationPresence (Join-Path $root 'owner-policy.install-lock')){throw 'ORP_PENDING_TRANSACTION'}
 $preparedInput=Read-PolicyRemovalJson (Join-Path $product $(if($activeRemoval){'owner-msi.prepared.activated.json'}else{'owner-msi.prepared.json'}));$prepared=$preparedInput.value
 Assert-PolicyRemovalKeys $prepared @('version','purpose','phase','ownerSid')
 if($prepared.version -isnot [int] -or $prepared.version -ne 1 -or $prepared.purpose -cne 'owner-msi-preparation' -or $prepared.phase -cne 'prepared' -or $prepared.ownerSid -cnotmatch '\AS-1-5-21-(\d+-){3}\d+\z'){throw 'ORP_PREPARED_RECEIPT_INVALID'}
 $recordInput=Read-PolicyRemovalJson (Join-Path $product $(if($activeRemoval){'owner-msi.policy.activated.json'}else{'owner-msi.policy.json'}));$record=$recordInput.value
 $trustKey=if($record.version -eq 2){'trustMode'}else{'publisherSha256'};$identityKey=if($record.identityReused -ceq 'preserved-existing'){'identityReused'}else{'identitySha256'}
 Assert-PolicyRemovalKeys $record @('version','purpose','phase','instanceId','policySha256','releaseSha256','helperSha256',$trustKey,$identityKey)
 if($record.version -isnot [int] -or $record.version -notin @(1,2) -or ($record.version -eq 2 -and $record.trustMode -cne 'admin-installed-sha256') -or $record.purpose -cne 'owner-msi-policy-preparation' -or $record.phase -cne 'policy-prepared' -or $record.instanceId -cnotmatch '\Ainst_[a-f0-9]{32}\z'){throw 'ORP_POLICY_RECEIPT_INVALID'}
 foreach($name in @('policySha256','releaseSha256','helperSha256')+@($identityKey|Where-Object {$_ -ceq 'identitySha256'})+@($trustKey|Where-Object {$_ -ceq 'publisherSha256'})){if($record.$name -isnot [string] -or $record.$name -cnotmatch '\A[a-f0-9]{64}\z'){throw 'ORP_POLICY_RECEIPT_INVALID'}}
 if($identityKey -ceq 'identityReused' -and $record.identityReused -cne 'preserved-existing'){throw 'ORP_POLICY_RECEIPT_INVALID'}
 if($activeRemoval){
  if(Test-OwnerServicePreparationPresence $removedMarker){throw 'ORP_PRIOR_REMOVAL_MARKER'}
  $activeInput=Read-PolicyRemovalJson (Join-Path $product 'owner-msi.activated.json');$active=$activeInput.value
  Assert-PolicyRemovalKeys $active @('version','purpose','phase','instanceId','preparedSha256','policyReceiptSha256','committedAt','healthConfirmed')
  $committedTime=[DateTimeOffset]::MinValue
  if($active.committedAt -isnot [string] -or -not [DateTimeOffset]::TryParseExact($active.committedAt,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$committedTime)){throw 'ORP_ACTIVE_RECEIPT_INVALID'}
  if($active.version -isnot [int] -or $active.version -ne 1 -or $active.purpose -cne 'owner-service-activation' -or $active.phase -cne 'configuration-committed' -or $active.instanceId -cne $record.instanceId -or $active.healthConfirmed -isnot [bool] -or $active.healthConfirmed -ne $false -or $active.preparedSha256 -cne (Get-OwnerDigest $preparedInput.bytes) -or $active.policyReceiptSha256 -cne (Get-OwnerDigest $recordInput.bytes)){throw 'ORP_ACTIVE_RECEIPT_INVALID'}
 }
 $actual=if($activeRemoval){
  # Do not reuse the fresh-install helper: it deliberately requires Disabled /
  # Stopped. Exact state/config/process validation follows via retained leases.
  foreach($plan in @(Get-OwnerServicePreparationPlan)){
   $service=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'")
   if(-not $service -or $service.StartName -ine $plan.account -or $service.PathName -cne $plan.command){throw 'ORP_SERVICE_BINDING_MISMATCH'}
   @{role=$plan.role;sid=[Security.Principal.NTAccount]::new('NT SERVICE',$plan.name).Translate([Security.Principal.SecurityIdentifier]).Value}
  }
 }else{@(Get-OwnerDataServices)}
 $control=($actual|Where-Object {$_.role -eq 'control'}).sid;$executor=($actual|Where-Object {$_.role -eq 'supervisor'}).sid
 foreach($row in @(Get-OwnerDataLayout $control $executor $prepared.ownerSid)){
  $path=if($row.relative){Join-Path (Get-OwnerDataRoot) $row.relative}else{Get-OwnerDataRoot};$pins.Add([RagentOwnerFilePin]::Directory($path));$acl=[IO.Directory]::GetAccessControl($path)
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or (Get-OwnerDataAclSddl $acl ([Security.AccessControl.AccessControlSections]::Access)) -cne (Get-OwnerDataAclSddl (New-OwnerDataAcl $row.grants $row.traverseOnly) ([Security.AccessControl.AccessControlSections]::Access))){throw 'ORP_LAYOUT_MISMATCH'}
 }
 $policyInput=Read-PolicyRemovalJson (Join-Path $root 'security\owner-bootstrap-install.json');$policy=$policyInput.value
 if((Get-OwnerDigest $policyInput.bytes) -cne $record.policySha256){throw 'ORP_POLICY_HASH_MISMATCH'}
 Assert-OwnerInstallPolicy $policy
 if($policy.instanceId -cne $record.instanceId -or $policy.controlSid -cne $control -or $policy.executorSid -cne $executor -or $policy.ownerSid -cne $prepared.ownerSid){throw 'ORP_POLICY_BINDING_MISMATCH'}
 foreach($kind in @('security','file')){
  $path=if($kind -eq 'file'){Join-Path $root 'security\owner-bootstrap-install.json'}else{Join-Path $root 'security'};$acl=Get-Acl -LiteralPath $path
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -cne (New-OwnerPolicySecurity $policy $kind).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)){throw 'ORP_POLICY_ACL_MISMATCH'}
 }
 # Public consistency only: ceasing execution does not require granting trust to
 # this helper. No signature/identity authority is issued by removal admission.
 $release=Read-PolicyRemovalJson (Join-Path $product 'payload\owner-bootstrap-release.json');Assert-OwnerPolicyRelease $release.value
 $helper=Read-OwnerPinnedFile (Join-Path $product 'payload\Ragent.OwnerBootstrap.exe') @(Get-OwnerAdministrativeSids) $pins 4194304
 if((Get-OwnerDigest $release.bytes) -cne $record.releaseSha256 -or (Get-OwnerDigest $helper) -cne $record.helperSha256 -or $release.value.helperSha256 -cne $record.helperSha256 -or $release.value.version -ne $record.version -or $release.value.$trustKey -cne $record.$trustKey){throw 'ORP_PUBLIC_INPUT_HASH_MISMATCH'}
 if($activeRemoval){Add-Type -Path (Join-Path $PSScriptRoot 'owner-service-activation-trial.cs')}
 foreach($plan in @(Get-OwnerServicePreparationPlan)){if($activeRemoval){if($policyRemoveAction -ceq 'ActiveRemove'){$services.Add([OwnerServiceActivationTrial]::OpenForRemoval($plan.name,$plan.command))}else{$services.Add([OwnerServiceActivationTrial]::OpenForRemovalCheck($plan.name,$plan.command))}}else{$services.Add([ManagedPreparedService]::new($plan.name,$plan.command,$plan.account))}}
 if($policyRemoveAction -cin @('Remove','ActiveRemove')){
  $lease=[IO.FileStream]::new($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $bytes=[Text.Encoding]::UTF8.GetBytes('{"version":1,"purpose":"owner-policy-removal"}');$lease.Write($bytes,0,$bytes.Length);$lease.Flush($true)
  if($activeRemoval){
   foreach($s in $services){$s.VerifyRemoval()}
   for($i=$services.Count-1;$i -ge 0;$i--){$services[$i].RestoreDisabled()}
   # Both retained service-host handles have drained. Refuse orphan/unknown
   # product processes before deleting registrations; never kill by PID/path.
   $left=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($product+'\',[StringComparison]::OrdinalIgnoreCase)})
   if($left.Count){throw 'ORP_PRODUCT_PROCESS_REMAINS'}
   for($i=$services.Count-1;$i -ge 0;$i--){$services[$i].RemoveDrained()}
   # A successful removal leaves a public, administrator-owned recovery marker.
   # Fresh MSI admission can then distinguish this exact retained installation
   # from arbitrary data or a legacy LocalSystem installation. No private key
   # or session material is read or copied.
   $removed=[ordered]@{version=1;purpose='owner-msi-removal';phase='services-removed';instanceId=[string]$record.instanceId;ownerSid=[string]$prepared.ownerSid;preparedSha256=(Get-OwnerDigest $preparedInput.bytes);policySha256=(Get-OwnerDigest $recordInput.bytes);activeSha256=(Get-OwnerDigest $activeInput.bytes);removedAt=[DateTimeOffset]::UtcNow.ToString('o')}
   $removedBytes=[Text.UTF8Encoding]::new($false).GetBytes(($removed|ConvertTo-Json -Compress))
   $removedStream=[IO.FileStream]::new($removedMarker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
   try{$removedStream.Write($removedBytes,0,$removedBytes.Length);$removedStream.Flush($true)}finally{$removedStream.Dispose()}
   $confirmed=Read-OwnerPinnedFile $removedMarker @(Get-OwnerAdministrativeSids) $pins 8192
   if((Get-OwnerDigest $confirmed) -cne (Get-OwnerDigest $removedBytes)){throw 'ORP_REMOVAL_MARKER_INVALID'}
   # Best-effort discovery hint only: recovery still verifies the protected
   # removal receipts, owner and retained policy before accepting this path.
   # If the hint cannot be written, the installer asks for the old folder.
   try{
    $key=[Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SOFTWARE\Ragent')
    if($key){try{$key.SetValue('LastRemovedProductRoot',$product,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}}
   }catch{}
  }else{foreach($s in $services){$s.Verify()};for($i=$services.Count-1;$i -ge 0;$i--){$services[$i].Remove()}}
 }
 $complete=$true
 if($activeRemoval){@{ok=$true;stage=$policyRemoveAction;activeInstallation=$true;readOnly=($policyRemoveAction -ceq 'ActiveCheck');servicesRemoved=($policyRemoveAction -ceq 'ActiveRemove');processesGoneObserved=($policyRemoveAction -ceq 'ActiveRemove');dataRemoved=$false;privateIdentityRead=$false;receiptsPreserved=$true;authorityIssued=$false}|ConvertTo-Json -Compress}
 else{@{ok=$true;stage=$policyRemoveAction;policyPreparedOnly=$true;servicesRemoved=($policyRemoveAction -eq 'Remove');dataRemoved=$false;privateIdentityRead=$false;receiptsPreserved=$true;authorityIssued=$false}|ConvertTo-Json -Compress}
}catch{
 $code=$_.Exception.GetBaseException().Message;if($code -cnotmatch '^(ORP|OMI|ODP|OSP|OBD|OIP|OAT)_[A-Z_]+$'){$code='ORP_REMOVAL_FAILED'}
 @{ok=$false;code=$code;quarantined=($null -ne $lease);dataRemoved=$false;privateIdentityRead=$false;authorityIssued=$false}|ConvertTo-Json -Compress;exit 1
}finally{
 foreach($s in $services){$s.Dispose()}
 if($lease){$lease.Dispose();if($complete){[IO.File]::Delete($marker)}}
 for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}
}
