# First in-place MSI migration from the existing Owner profile. This script
# reuses all ProgramData identity/session files and only writes MSI receipts.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Begin','Prepare','Policy','Rollback','Commit')][string]$Action)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$upgradeAction=$Action
. (Join-Path $PSScriptRoot 'managed-owner-msi.ps1') -LibraryOnly
. (Join-Path $PSScriptRoot 'prepare-owner-service-data.ps1') -LibraryOnly
. (Join-Path $PSScriptRoot 'prepare-owner-install-policy.ps1') -LibraryOnly
$Action=$upgradeAction
$product=Get-OwnerProductRoot;$dataRoot=Get-OwnerDataRoot;$ownerRoot=Get-OwnerInstanceRoot
$journalPath=Join-Path $product 'owner-msi.upgrade-transaction.json';$pins=[Collections.Generic.List[IDisposable]]::new()
$services=[Collections.Generic.List[ManagedPreparedService]]::new();$lease=$null;$complete=$false;$stage='admission';$identityOpened=$false
function Read-UpgradeJson([string]$Path,[int]$Maximum=8192){
 $bytes=Read-OwnerPinnedFile $Path @(Get-OwnerAdministrativeSids) $pins $Maximum
 try{$value=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json}catch{throw 'OMU_METADATA_INVALID'}
 return @{value=$value;bytes=$bytes}
}
function Get-UpgradeReceiptNames {return @('owner-msi.prepared.activated.json','owner-msi.policy.activated.json','owner-msi.activated.json','owner-msi.activation-health.json','owner-activation.committed-lock')}
function Get-UpgradeArchivePath([string]$Name,[string]$TransactionId){
 if($Name -notin (Get-UpgradeReceiptNames) -or $TransactionId -cnotmatch '^[a-f0-9]{32}$'){throw 'OMU_ARCHIVE_NAME_INVALID'}
 return (Join-Path $product ($Name+'.previous-'+$TransactionId))
}
function Read-UpgradeBytes([string]$Name,[int]$Maximum=8192){
 $readPins=[Collections.Generic.List[IDisposable]]::new()
 try{$bytes=Read-OwnerPinnedFile (Join-Path $product $Name) @(Get-OwnerAdministrativeSids) $readPins $Maximum;if($bytes.Length -lt 2){throw 'OMU_EXISTING_RECEIPT_INVALID'};return ,$bytes}
 finally{for($index=$readPins.Count-1;$index -ge 0;$index--){$readPins[$index].Dispose()}}
}
function Get-UpgradeFileDigest([string]$Name){return Get-OwnerDigest (Read-UpgradeBytes $Name)}
function Assert-UpgradeJournal {
 if(-not(Test-OwnerServicePreparationPresence $journalPath)){throw 'OMU_TRANSACTION_REQUIRED'}
 $bytes=Read-UpgradeBytes 'owner-msi.upgrade-transaction.json' 8192
 try{$record=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json}catch{throw 'OMU_TRANSACTION_INVALID'}
 if(@($record.PSObject.Properties).Count -ne 9 -or $record.version -isnot [int] -or $record.version -ne 2 -or $record.purpose -cne 'owner-msi-upgrade-transaction' -or $record.phase -cne 'begun' -or $record.transactionId -cnotmatch '^[a-f0-9]{32}$' -or $record.ownerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$' -or $record.controlSid -cnotmatch '^S-1-5-80-(\d+-){4}\d+$' -or $record.executorSid -cnotmatch '^S-1-5-80-(\d+-){4}\d+$' -or $record.controlSid -ceq $record.executorSid){throw 'OMU_TRANSACTION_INVALID'}
 $archiveRows=@($record.archivedReceipts);$expectedNames=Get-UpgradeReceiptNames
 if($archiveRows.Count -ne $expectedNames.Count){throw 'OMU_TRANSACTION_INVALID'}
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 foreach($row in $archiveRows){if(@($row.PSObject.Properties).Count -ne 2 -or $row.name -cnotin $expectedNames -or $row.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not $seen.Add([string]$row.name)){throw 'OMU_TRANSACTION_INVALID'}}
 $layout=@(Get-OwnerDataLayout ([string]$record.controlSid) ([string]$record.executorSid) ([string]$record.ownerSid));$expectedMetadata=@('','instances','instances\owner')
 $metadataRows=@($record.metadataAclMigration);if($metadataRows.Count -ne $expectedMetadata.Count){throw 'OMU_TRANSACTION_INVALID'}
 for($index=0;$index -lt $expectedMetadata.Count;$index++){
  $row=$metadataRows[$index];$relative=$expectedMetadata[$index]
  if(@($row.PSObject.Properties).Count -ne 2 -or $row.relative -cne $relative -or $row.originalSddl -isnot [string] -or $row.originalSddl.Length -lt 8 -or $row.originalSddl.Length -gt 2048){throw 'OMU_TRANSACTION_INVALID'}
  $layoutRow=$layout|Where-Object {$_.relative -ceq $relative}|Select-Object -First 1
  $expectedAcl=New-OwnerDataAcl $layoutRow.grants $layoutRow.traverseOnly
  $expectedSddl=Get-OwnerDataAclSddl $expectedAcl ([Security.AccessControl.AccessControlSections]'Owner,Access')
  $legacyAcl=New-LegacyOwnerMetadataAcl ([string]$record.controlSid) ([string]$record.executorSid)
  $legacySddl=Get-OwnerDataAclSddl $legacyAcl ([Security.AccessControl.AccessControlSections]'Owner,Access')
  $originalSddl=([string]$row.originalSddl -creplace 'D:PAI(?=\()','D:P')
  if($originalSddl -cne $expectedSddl -and $originalSddl -cne $legacySddl){throw 'OMU_TRANSACTION_INVALID'}
 }
 return $record
}
function Assert-UpgradeFileMetadata([string]$Path,[string[]]$Allowed,[long]$Minimum,[long]$Maximum){
 if(-not(Test-OwnerServicePreparationPresence $Path)){throw 'OMU_EXISTING_FILE_REQUIRED'}
 $attributes=[IO.File]::GetAttributes($Path);if(($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'OMU_EXISTING_FILE_INVALID'}
 $stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{[RagentOwnerFilePin]::Verify($stream.SafeFileHandle,$Path,$false);if($stream.Length -lt $Minimum -or $stream.Length -gt $Maximum){throw 'OMU_EXISTING_FILE_INVALID'};Assert-OwnerObjectAcl $Path $Allowed;$pins.Add($stream)}catch{$stream.Dispose();throw}
}
function Assert-ExistingOwnerState([string]$ControlSid,[string]$ExecutorSid,$Policy){
 $layout=@(Get-OwnerDataLayout $ControlSid $ExecutorSid $Policy.ownerSid)
 for($parent=(Get-OwnerProgramDataPath);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){$pins.Add([RagentOwnerFilePin]::Directory($parent));Assert-OwnerObjectAcl $parent @(Get-OwnerAdministrativeSids) -Ancestor -Pins $pins}
 foreach($row in $layout){
  $path=if($row.relative){Join-Path $dataRoot $row.relative}else{$dataRoot}
  if(-not(Test-OwnerServicePreparationPresence $path)){throw 'OMU_DATA_LAYOUT_INCOMPLETE'}
  $pins.Add([RagentOwnerFilePin]::Directory($path));$actual=[IO.Directory]::GetAccessControl($path);$expected=New-OwnerDataAcl $row.grants $row.traverseOnly
  $actualSddl=Get-OwnerDataAclSddl $actual ([Security.AccessControl.AccessControlSections]'Owner,Access');$expectedSddl=Get-OwnerDataAclSddl $expected ([Security.AccessControl.AccessControlSections]'Owner,Access')
  $metadataPath=$row.relative -cin @('','instances','instances\owner')
  $legacySddl=if($metadataPath){Get-OwnerDataAclSddl (New-LegacyOwnerMetadataAcl $ControlSid $ExecutorSid) ([Security.AccessControl.AccessControlSections]'Owner,Access')}else{$null}
  if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or ($actualSddl -cne $expectedSddl -and (-not $metadataPath -or $actualSddl -cne $legacySddl))){throw 'OMU_DATA_ACL_MISMATCH'}
 }
 $config=Join-Path $ownerRoot 'config';$allowed=@(Get-OwnerAdministrativeSids)+@($ControlSid)
 Assert-UpgradeFileMetadata (Join-Path $config 'instance-identity.json') $allowed 2 32768
 Assert-UpgradeFileMetadata (Join-Path $config 'owner-identity.result.json') $allowed 2 8192
 Assert-UpgradeFileMetadata (Join-Path $config 'auth-session-secret') $allowed 32 4096
 Assert-UpgradeFileMetadata (Join-Path $config 'auth-sessions.sqlite') $allowed 16 1073741824
}
function New-LegacyOwnerMetadataAcl([string]$ControlSid,[string]$ExecutorSid){
 $legacy=@{};$legacy[$ControlSid]='ReadAndExecute';$legacy[$ExecutorSid]='ReadAndExecute'
 return New-OwnerDataAcl $legacy $true
}
function Get-ExistingOwnerMetadataAclMigration([string]$ControlSid,[string]$ExecutorSid,$Policy){
 $layout=@(Get-OwnerDataLayout $ControlSid $ExecutorSid $Policy.ownerSid);$rows=@()
 foreach($relative in @('','instances','instances\owner')){
  $row=$layout|Where-Object {$_.relative -ceq $relative}|Select-Object -First 1
  $path=if($relative){Join-Path $dataRoot $relative}else{$dataRoot}
  if(-not(Test-OwnerServicePreparationPresence $path)){throw 'OMU_DATA_LAYOUT_INCOMPLETE'}
  $acl=[IO.Directory]::GetAccessControl($path);$sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')
  $expected=Get-OwnerDataAclSddl (New-OwnerDataAcl $row.grants $row.traverseOnly) ([Security.AccessControl.AccessControlSections]'Owner,Access')
  $legacy=Get-OwnerDataAclSddl (New-LegacyOwnerMetadataAcl $ControlSid $ExecutorSid) ([Security.AccessControl.AccessControlSections]'Owner,Access')
  $comparableSddl=($sddl -creplace 'D:PAI(?=\()','D:P')
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or ($comparableSddl -cne $expected -and $comparableSddl -cne $legacy)){throw 'OMU_DATA_ACL_MISMATCH'}
  $rows+=@{relative=$relative;originalSddl=$sddl}
 }
 return $rows
}
function Set-OwnerMetadataAclFromSddl([string]$Path,[string]$Sddl){
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetSecurityDescriptorSddlForm($Sddl,[Security.AccessControl.AccessControlSections]'Owner,Access');[IO.Directory]::SetAccessControl($Path,$acl)
}
function Apply-OwnerMetadataAclMigration($Journal){
 $layout=@(Get-OwnerDataLayout ([string]$Journal.controlSid) ([string]$Journal.executorSid) ([string]$Journal.ownerSid));$changed=0
 foreach($row in @($Journal.metadataAclMigration)){
  $layoutRow=$layout|Where-Object {$_.relative -ceq $row.relative}|Select-Object -First 1;$path=if($row.relative){Join-Path $dataRoot $row.relative}else{$dataRoot}
  $expected=New-OwnerDataAcl $layoutRow.grants $layoutRow.traverseOnly;$expectedSddl=Get-OwnerDataAclSddl $expected ([Security.AccessControl.AccessControlSections]'Owner,Access')
  $actual=[IO.Directory]::GetAccessControl($path);$actualSddl=Get-OwnerDataAclSddl $actual ([Security.AccessControl.AccessControlSections]'Owner,Access');$originalSddl=([string]$row.originalSddl -creplace 'D:PAI(?=\()','D:P')
  if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or ($actualSddl -cne $originalSddl -and $actualSddl -cne $expectedSddl)){throw 'OMU_DATA_ACL_MISMATCH'}
  if($actualSddl -cne $expectedSddl){[IO.Directory]::SetAccessControl($path,$expected);$changed++}
  $confirmed=[IO.Directory]::GetAccessControl($path);if(-not $confirmed.AreAccessRulesProtected -or $confirmed.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or (Get-OwnerDataAclSddl $confirmed ([Security.AccessControl.AccessControlSections]'Owner,Access')) -cne $expectedSddl){throw 'OMU_DATA_ACL_MIGRATION_FAILED'}
 }
 return $changed
}
function Restore-OwnerMetadataAclMigration($Journal){
 $layout=@(Get-OwnerDataLayout ([string]$Journal.controlSid) ([string]$Journal.executorSid) ([string]$Journal.ownerSid));$restored=0
 foreach($row in @($Journal.metadataAclMigration)){
  $layoutRow=$layout|Where-Object {$_.relative -ceq $row.relative}|Select-Object -First 1;$path=if($row.relative){Join-Path $dataRoot $row.relative}else{$dataRoot}
  $expected=Get-OwnerDataAclSddl (New-OwnerDataAcl $layoutRow.grants $layoutRow.traverseOnly) ([Security.AccessControl.AccessControlSections]'Owner,Access')
  $actual=[IO.Directory]::GetAccessControl($path);$actualSddl=Get-OwnerDataAclSddl $actual ([Security.AccessControl.AccessControlSections]'Owner,Access');$originalSddl=([string]$row.originalSddl -creplace 'D:PAI(?=\()','D:P')
  if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or ($actualSddl -cne $originalSddl -and $actualSddl -cne $expected)){throw 'OMU_DATA_ACL_MISMATCH'}
  if($actualSddl -cne $originalSddl){Set-OwnerMetadataAclFromSddl $path ([string]$row.originalSddl);$restored++}
  $confirmed=[IO.Directory]::GetAccessControl($path);if(-not $confirmed.AreAccessRulesProtected -or (Get-OwnerDataAclSddl $confirmed ([Security.AccessControl.AccessControlSections]'Owner,Access')) -cne $originalSddl){throw 'OMU_DATA_ACL_RESTORE_FAILED'}
 }
 return $restored
}
function Assert-ExistingPolicy($Policy,[byte[]]$PolicyBytes,[string]$ControlSid,[string]$ExecutorSid){
 Assert-OwnerInstallPolicy $Policy
 if($Policy.controlSid -cne $ControlSid -or $Policy.executorSid -cne $ExecutorSid){throw 'OMU_POLICY_SERVICE_MISMATCH'}
 foreach($kind in @('security','file')){
  $path=if($kind -ceq 'security'){Join-Path $ownerRoot 'security'}else{Join-Path $ownerRoot 'security\owner-bootstrap-install.json'}
  $acl=if($kind -ceq 'security'){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -cne (New-OwnerPolicySecurity $Policy $kind).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)){throw 'OMU_POLICY_ACL_MISMATCH'}
 }
}
function Write-UpgradeReceipt([string]$Path,$Value){
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Compress));$stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);[RagentOwnerFilePin]::Verify($stream.SafeFileHandle,$Path,$false);Assert-OwnerObjectAcl $Path @(Get-OwnerAdministrativeSids)}finally{$stream.Dispose()}
 $readPins=[Collections.Generic.List[IDisposable]]::new()
 try{$check=Read-OwnerPinnedFile $Path @(Get-OwnerAdministrativeSids) $readPins;if([Convert]::ToBase64String($check) -cne [Convert]::ToBase64String($bytes)){throw 'OMU_RECEIPT_CONFIRMATION_FAILED'}}finally{for($index=$readPins.Count-1;$index -ge 0;$index--){$readPins[$index].Dispose()}}
 return ,$bytes
}
function Remove-UpgradeFile([string]$Name){
 $path=Join-Path $product $Name;if(-not(Test-OwnerServicePreparationPresence $path)){return}
 $readPins=[Collections.Generic.List[IDisposable]]::new()
 try{$raw=Read-OwnerPinnedFile $path @(Get-OwnerAdministrativeSids) $readPins 8192;if($raw.Length -lt 2){throw 'OMU_ROLLBACK_FILE_INVALID'}}finally{for($index=$readPins.Count-1;$index -ge 0;$index--){$readPins[$index].Dispose()}}
 [IO.File]::Delete($path)
}
function Restore-UpgradeReceipts($Journal){
 foreach($row in @($Journal.archivedReceipts)){
  $sourceName=[string]$row.name;$sourcePath=Join-Path $product $sourceName;$archivePath=Get-UpgradeArchivePath $sourceName ([string]$Journal.transactionId);$archiveName=[IO.Path]::GetFileName($archivePath)
  if(Test-OwnerServicePreparationPresence $archivePath){
   if((Get-UpgradeFileDigest $archiveName) -cne $row.sha256){throw 'OMU_ARCHIVE_DIGEST_MISMATCH'}
   if(Test-OwnerServicePreparationPresence $sourcePath){
    if((Get-UpgradeFileDigest $sourceName) -cne $row.sha256){throw 'OMU_ARCHIVE_RESTORE_CONFLICT'}
    Remove-UpgradeFile $archiveName
   }else{[IO.File]::Move($archivePath,$sourcePath)}
  }elseif(-not(Test-OwnerServicePreparationPresence $sourcePath) -or (Get-UpgradeFileDigest $sourceName) -cne $row.sha256){throw 'OMU_ARCHIVE_MISSING'}
 }
}
function Remove-UpgradeArchives($Journal){
 foreach($row in @($Journal.archivedReceipts)){
  $archivePath=Get-UpgradeArchivePath ([string]$row.name) ([string]$Journal.transactionId);$archiveName=[IO.Path]::GetFileName($archivePath)
  if(-not(Test-OwnerServicePreparationPresence $archivePath) -or (Get-UpgradeFileDigest $archiveName) -cne $row.sha256){throw 'OMU_ARCHIVE_DIGEST_MISMATCH'}
  Remove-UpgradeFile $archiveName
 }
}
function Invoke-UpgradeRollback {
 if(-not(Test-OwnerServicePreparationPresence $journalPath)){return @{ok=$true;rollbackCleaned=$false;reason='no-transaction';dataTouched=$false;identityRead=$false}}
 $journal=Assert-UpgradeJournal
 $metadataAclsRestored=Restore-OwnerMetadataAclMigration $journal
 # Only the fixed, MSI-owned receipt names can be removed. ProgramData identity,
 # session files, install policy, Broker state and all other files are retained.
 foreach($name in @('owner-msi.prepared.json','owner-msi.prepared.activated.json','owner-msi.policy.json','owner-msi.policy.activated.json','owner-msi.activated.json','owner-msi.activation-health.json','owner-activation.prepare-lock','owner-activation.committed-lock','owner-msi.prepare-lock','owner-policy.prepare-lock')){Remove-UpgradeFile $name}
 Restore-UpgradeReceipts $journal
 Remove-UpgradeFile 'owner-msi.upgrade-transaction.json'
 return @{ok=$true;rollbackCleaned=$true;dataTouched=$false;metadataAclsRestored=$metadataAclsRestored;identityRead=$false}
}
try {
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OMU_ADMIN_REQUIRED'}
 switch($Action){
  'Begin' {
   foreach($name in @('owner-msi.upgrade-transaction.json','owner-msi.prepared.json','owner-msi.policy.json','owner-msi.prepare-lock','owner-policy.prepare-lock')){if(Test-OwnerServicePreparationPresence (Join-Path $product $name)){throw 'OMU_PRIOR_MSI_RECEIPT_REFUSED'}}
   $controlSid=[Security.Principal.NTAccount]::new('NT SERVICE','Ragent-ControlPlane').Translate([Security.Principal.SecurityIdentifier]).Value
   $executorSid=[Security.Principal.NTAccount]::new('NT SERVICE','Ragent-RunnerSupervisor').Translate([Security.Principal.SecurityIdentifier]).Value
   $policyInput=Read-UpgradeJson (Join-Path $ownerRoot 'security\owner-bootstrap-install.json') 8192;$policy=$policyInput.value
   Assert-ExistingPolicy $policy $policyInput.bytes $controlSid $executorSid
   $metadataRows=@(Get-ExistingOwnerMetadataAclMigration $controlSid $executorSid $policy)
   $transactionId=[Guid]::NewGuid().ToString('N');$archivedReceipts=@()
   foreach($name in (Get-UpgradeReceiptNames)){
    $sourcePath=Join-Path $product $name;if(-not(Test-OwnerServicePreparationPresence $sourcePath)){throw 'OMU_ACTIVE_RECEIPT_REQUIRED'}
    $archivePath=Get-UpgradeArchivePath $name $transactionId;if(Test-OwnerServicePreparationPresence $archivePath){throw 'OMU_PRIOR_ARCHIVE_REFUSED'}
    $archivedReceipts+=@{name=$name;sha256=(Get-UpgradeFileDigest $name)}
   }
   $record=[ordered]@{version=2;purpose='owner-msi-upgrade-transaction';phase='begun';transactionId=$transactionId;archivedReceipts=@($archivedReceipts);ownerSid=[string]$policy.ownerSid;controlSid=$controlSid;executorSid=$executorSid;metadataAclMigration=$metadataRows}
   $null=Write-UpgradeReceipt $journalPath $record
   foreach($row in $archivedReceipts){$source=Join-Path $product $row.name;$archive=Get-UpgradeArchivePath $row.name $transactionId;[IO.File]::Move($source,$archive);if((Get-UpgradeFileDigest ([IO.Path]::GetFileName($archive))) -cne $row.sha256){throw 'OMU_ARCHIVE_MOVE_INVALID'}}
   $complete=$true
   @{ok=$true;transactionBegun=$true;stableReceiptsArchived=$archivedReceipts.Count;identityReused=$true;identityRead=$false;servicesActivated=$false;dataChanged=$false;metadataAclMigrationPrepared=$metadataRows.Count}|ConvertTo-Json -Compress
  }
  'Prepare' {
   $stage='transaction';$journal=Assert-UpgradeJournal
   foreach($name in @('owner-msi.prepare-lock','owner-msi.prepared.json','owner-msi.policy.json','owner-identity.initialize-lock','owner-data.prepare-lock','owner-activation.prepare-lock','owner-policy.prepare-lock')){if(Test-OwnerServicePreparationPresence (Join-Path $product $name)){throw 'OMU_PENDING_TRANSACTION'}}
   Open-OwnerServicePreparationInputs $pins
   Assert-OwnerPreparedRelease $pins
   foreach($plan in @(Get-OwnerServicePreparationPlan)){$services.Add([ManagedPreparedService]::new($plan.name,$plan.command,$plan.account))}
   $actual=@(Get-OwnerDataServices);$control=($actual|Where-Object {$_.role -ceq 'control'}).sid;$executor=($actual|Where-Object {$_.role -ceq 'supervisor'}).sid
   $policyInput=Read-UpgradeJson (Join-Path $ownerRoot 'security\owner-bootstrap-install.json') 8192;$policy=$policyInput.value
   Assert-ExistingPolicy $policy $policyInput.bytes $control $executor
   Assert-ExistingOwnerState $control $executor $policy
   $metadataAclsChanged=Apply-OwnerMetadataAclMigration $journal
   Assert-ExistingOwnerState $control $executor $policy
   # Retained-data reinstall creates disabled MSI service objects. Apply the
   # same restricted privileges as fresh preparation before activation.
   foreach($service in $services){$service.Restrict()}
   $receipt=[ordered]@{version=1;purpose='owner-msi-preparation';phase='prepared';ownerSid=$policy.ownerSid}
   $target=Join-Path $product 'owner-msi.prepared.json';$lease=[IO.FileStream]::new((Join-Path $product 'owner-msi.prepare-lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
   try{$bytes=[Text.Encoding]::UTF8.GetBytes('{"version":1,"purpose":"owner-msi-prepare-upgrade"}');$lease.Write($bytes,0,$bytes.Length);$lease.Flush($true);foreach($service in $services){$service.Verify()};$null=Write-UpgradeReceipt $target $receipt;foreach($service in $services){$service.Verify()};$complete=$true}finally{$lease.Dispose();if($complete){[IO.File]::Delete((Join-Path $product 'owner-msi.prepare-lock'))}}
   @{ok=$true;stage='prepare';identityReused=$true;identityRead=$false;credentialsRead=$false;dataChanged=$false;metadataAclMigrationApplied=$metadataAclsChanged;servicesActivated=$false;authorityIssued=$false}|ConvertTo-Json -Compress
  }
  'Policy' {
   $stage='policy';$null=Assert-UpgradeJournal
   foreach($name in @('owner-msi.prepare-lock','owner-policy.prepare-lock','owner-msi.policy.json','owner-identity.initialize-lock','owner-activation.prepare-lock')){if(Test-OwnerServicePreparationPresence (Join-Path $product $name)){throw 'OMU_PENDING_TRANSACTION'}}
   $servicesData=@(Get-OwnerDataServices);$control=($servicesData|Where-Object {$_.role -ceq 'control'}).sid;$executor=($servicesData|Where-Object {$_.role -ceq 'supervisor'}).sid
   $prepared=(Read-UpgradeJson (Join-Path $product 'owner-msi.prepared.json') 2048).value
   if($prepared.version -ne 1 -or $prepared.purpose -cne 'owner-msi-preparation' -or $prepared.phase -cne 'prepared' -or $prepared.ownerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'OMU_PREPARED_RECEIPT_INVALID'}
   $policyInput=Read-UpgradeJson (Join-Path $ownerRoot 'security\owner-bootstrap-install.json') 8192;$policy=$policyInput.value
   Assert-ExistingPolicy $policy $policyInput.bytes $control $executor
   if($policy.ownerSid -cne $prepared.ownerSid){throw 'OMU_POLICY_OWNER_MISMATCH'}
   $null=Assert-ExistingOwnerState $control $executor $policy
   $admin=@(Get-OwnerAdministrativeSids);$releasePath=Join-Path $product 'payload\owner-bootstrap-release.json';$helperPath=Join-Path $product 'payload\Ragent.OwnerBootstrap.exe'
   $releaseBytes=Read-OwnerPinnedFile $releasePath $admin $pins 8192;$release=[Text.UTF8Encoding]::new($false,$true).GetString($releaseBytes)|ConvertFrom-Json;Assert-OwnerPolicyRelease $release
   $helperBytes=Read-OwnerPinnedFile $helperPath $admin $pins 4194304
   if($release.helperSha256 -cne (Get-OwnerDigest $helperBytes)){throw 'OMU_HELPER_HASH_MISMATCH'}
   $trust=Get-OwnerReleaseTrust $release $helperBytes $helperPath
   $trustKey=if($release.version -eq 2){'trustMode'}else{'publisherSha256'}
   $record=[ordered]@{version=$release.version;purpose='owner-msi-policy-preparation';phase='policy-prepared';instanceId=$policy.instanceId;policySha256=(Get-OwnerDigest $policyInput.bytes);releaseSha256=(Get-OwnerDigest $releaseBytes);helperSha256=$release.helperSha256;identityReused='preserved-existing'}
   if($release.version -eq 2){$record.trustMode=$trust.trustMode}else{$record.publisherSha256=$trust.publisherSha256}
   $lease=[IO.FileStream]::new((Join-Path $product 'owner-policy.prepare-lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
   try{$bytes=[Text.Encoding]::UTF8.GetBytes('{"version":1,"purpose":"owner-msi-policy-upgrade"}');$lease.Write($bytes,0,$bytes.Length);$lease.Flush($true);$null=Write-UpgradeReceipt (Join-Path $product 'owner-msi.policy.json') $record;$complete=$true}finally{$lease.Dispose();if($complete){[IO.File]::Delete((Join-Path $product 'owner-policy.prepare-lock'))}}
   @{ok=$true;stage='policy';identityReused=$true;identityRead=$false;policyReused=$true;policyChanged=$false;dataChanged=$false;servicesActivated=$false;authorityIssued=$false}|ConvertTo-Json -Compress
  }
  'Rollback' {$stage='rollback';$result=Invoke-UpgradeRollback;$result|ConvertTo-Json -Compress;$complete=$true}
  'Commit' {
   $stage='commit';$journal=Assert-UpgradeJournal
   foreach($row in @($journal.metadataAclMigration)){
    $layoutRow=@(Get-OwnerDataLayout ([string]$journal.controlSid) ([string]$journal.executorSid) ([string]$journal.ownerSid)|Where-Object {$_.relative -ceq $row.relative})[0]
    $path=if($row.relative){Join-Path $dataRoot $row.relative}else{$dataRoot};$expected=New-OwnerDataAcl $layoutRow.grants $layoutRow.traverseOnly
    $actual=[IO.Directory]::GetAccessControl($path);if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or (Get-OwnerDataAclSddl $actual ([Security.AccessControl.AccessControlSections]'Owner,Access')) -cne (Get-OwnerDataAclSddl $expected ([Security.AccessControl.AccessControlSections]'Owner,Access'))){throw 'OMU_DATA_ACL_MISMATCH'}
   }
   $preparedPath=Join-Path $product 'owner-msi.prepared.activated.json';$policyPath=Join-Path $product 'owner-msi.policy.activated.json';$activePath=Join-Path $product 'owner-msi.activated.json';$healthPath=Join-Path $product 'owner-msi.activation-health.json'
   foreach($path in @($preparedPath,$policyPath,$activePath,$healthPath)){if(-not(Test-OwnerServicePreparationPresence $path)){throw 'OMU_ACTIVATION_INCOMPLETE'}}
   $prepared=(Read-UpgradeJson $preparedPath 2048).value;$policy=(Read-UpgradeJson $policyPath 2048).value;$active=(Read-UpgradeJson $activePath 2048).value;$health=(Read-UpgradeJson $healthPath 2048).value
   if($prepared.phase -cne 'prepared' -or $policy.phase -cne 'policy-prepared' -or $policy.identityReused -cne 'preserved-existing' -or $active.purpose -cne 'owner-service-activation' -or $active.phase -cne 'configuration-committed' -or $active.healthConfirmed -ne $false -or $health.purpose -cne 'owner-service-activation-health' -or -not(Test-OwnerServicePreparationPresence (Join-Path $product 'owner-activation.committed-lock'))){throw 'OMU_ACTIVATION_RECEIPT_INVALID'}
   Remove-UpgradeArchives $journal
   Remove-UpgradeFile 'owner-msi.upgrade-transaction.json';$complete=$true
   @{ok=$true;transactionCommitted=$true;identityReused=$true;identityRead=$false;dataChanged=$false}|ConvertTo-Json -Compress
  }
 }
}catch{
 $code=$_.Exception.GetBaseException().Message;if($code -cnotmatch '^(OMU|OMI|ODP|OSP|OBD|OIP|OAT|OPP)_[A-Z_]+$'){$code='OMU_UPGRADE_TRANSACTION_FAILED'}
 @{ok=$false;code=$code;stage=$stage;identityReused=($Action -cin @('Begin','Prepare','Policy','Commit'));identityRead=$identityOpened;credentialsRead=$false;dataChanged=$false;servicesActivated=$false;authorityIssued=$false}|ConvertTo-Json -Compress
 exit 1
}finally{
 foreach($service in $services){$service.Dispose()}
 if($lease){$lease.Dispose();if($complete -and $Action -in @('Prepare','Policy')){$lock=if($Action -ceq 'Prepare'){'owner-msi.prepare-lock'}else{'owner-policy.prepare-lock'};[IO.File]::Delete((Join-Path $product $lock))}}
 for($index=$pins.Count-1;$index -ge 0;$index--){$pins[$index].Dispose()}
}
