[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\packaging\windows\prepare-owner-install-policy.ps1'
$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Policy installer syntax failure'}
. $source -LibraryOnly
$base=[IO.Path]::GetFullPath($EvidenceRoot)
if($base -like 'C:\ProgramData\Ragent*' -or $base -like 'C:\Program Files\Ragent*' -or -not [IO.Directory]::Exists($base)){throw 'Isolated evidence root required'}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$admins=@($user,'S-1-5-32-544','S-1-5-18')
$baseAcl=[Security.AccessControl.DirectorySecurity]::new();$baseAcl.SetAccessRuleProtection($true,$false);$baseAcl.SetOwner([Security.Principal.SecurityIdentifier]::new($user))
foreach($sid in $admins){$baseAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
[IO.Directory]::SetAccessControl($base,$baseAcl)
# This ordinary-user test cannot make the machine's Temp ancestors installer
# owned. Substitute ONLY their ACL trust, retaining real native handle/reparse
# checks everywhere and actual ACL checks for every object within the QA root.
$originalOwnerAclCheck=(Get-Command Assert-OwnerObjectAcl).ScriptBlock
function Assert-OwnerObjectAcl([string]$Path,[string[]]$Allowed,[switch]$Ancestor,[Collections.Generic.List[IDisposable]]$Pins){
  $absolute=[IO.Path]::GetFullPath($Path)
  if($absolute.Equals($base,[StringComparison]::OrdinalIgnoreCase) -or $absolute.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){
    & $originalOwnerAclCheck $Path $Allowed -Ancestor:$Ancestor -Pins $Pins
  }
}
$policy=[pscustomobject][ordered]@{version=1;instanceId=('inst_'+('a'*32));controlSid='S-1-5-80-1-2-3-4-5';executorSid='S-1-5-80-6-7-8-9-10';ownerSid='S-1-5-21-1-2-3-1001';port=7690}
$checks=[Collections.Generic.List[object]]::new()
function New-PolicyCase([string]$Name){
  $path=Join-Path $base $Name
  if([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)){throw 'Test case collision'}
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new($user))
  foreach($sid in $admins){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  $null=[IO.Directory]::CreateDirectory($path,$acl)
  [IO.File]::WriteAllText((Join-Path $path 'qa-owner-policy.json'),'{"testOnly":true,"publicSyntheticPolicy":true}')
  return $path
}
function Check([string]$Name,[bool]$Pass){$checks.Add(@{name=$Name;pass=$Pass});if(-not $Pass){throw ('Native policy check failed: '+$Name)}}
function Refuses([scriptblock]$Action,[string]$Code){try{&$Action|Out-Null;return $false}catch{return $_.Exception.GetBaseException().Message -ceq $Code}}
$root=New-PolicyCase 'success'
$result=Publish-OwnerInstallPolicy $root $policy $admins
Check 'actual-create-flush-readback-and-publish' ($result.policyPrepared -eq $true -and $result.servicesActivated -eq $false -and $result.migrationReady -eq $false)
$file=Join-Path $root 'security\owner-bootstrap-install.json'
$bytes=[IO.File]::ReadAllBytes($file);$text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes);$record=$text|ConvertFrom-Json
Check 'actual-canonical-public-json-no-bom' ($record.instanceId -ceq $policy.instanceId -and $text[0] -eq '{' -and @($record.PSObject.Properties).Count -eq 6 -and $text -notmatch 'privateKey|password|sessionToken')
Check 'actual-install-lock-released-after-success' (-not [IO.File]::Exists((Join-Path $root 'owner-policy.install-lock')))
Assert-OwnerPolicyInstallComplete $root
Check 'actual-reader-gate-allows-confirmed-install' $true
$acl=[IO.File]::GetAccessControl($file)
Check 'actual-file-protected-owner-and-dacl' ($acl.AreAccessRulesProtected -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $user)
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
Check 'actual-metadata-owner-and-control-read-only' (@($rules|Where-Object {$_.IdentityReference.Value -in @($policy.ownerSid,$policy.controlSid) -and ([int64]$_.FileSystemRights -band 0xd0116) -ne 0}).Count -eq 0)
Check 'actual-executor-no-allow-ace' (@($rules|Where-Object {$_.IdentityReference.Value -ceq $policy.executorSid}).Count -eq 0)
Check 'actual-policy-collision-refused' (Refuses {Publish-OwnerInstallPolicy $root $policy $admins} 'OIP_POLICY_ALREADY_PRESENT')
Check 'actual-collision-preserves-bytes' ([Convert]::ToBase64String($bytes) -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($file)))
$runtime=[IO.Directory]::GetAccessControl((Join-Path $root 'runtime'))
Check 'actual-runtime-control-modify-owner-read' (@($runtime.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -ceq $policy.controlSid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Modify) -eq [Security.AccessControl.FileSystemRights]::Modify}).Count -eq 1)
$bad=New-PolicyCase 'foreign-root';$badAcl=[IO.Directory]::GetAccessControl($bad)
$badAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Write','Allow'));[IO.Directory]::SetAccessControl($bad,$badAcl)
Check 'actual-foreign-write-parent-refused-before-lock' (Refuses {Publish-OwnerInstallPolicy $bad $policy $admins} 'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY')
Check 'actual-unsafe-parent-creates-no-policy' (-not [IO.File]::Exists((Join-Path $bad 'security\owner-bootstrap-install.json')) -and -not [IO.File]::Exists((Join-Path $bad 'owner-policy.install-lock')))
$stale=New-PolicyCase 'stale-lock';[IO.File]::WriteAllText((Join-Path $stale 'owner-policy.install-lock'),'SYNTHETIC-UNRECOVERED-INSTALL')
Check 'actual-stale-install-lock-not-reclaimed' (Refuses {Publish-OwnerInstallPolicy $stale $policy $admins} 'OIP_INSTALL_ALREADY_OWNED')
Check 'actual-stale-lock-bytes-retained' ([IO.File]::ReadAllText((Join-Path $stale 'owner-policy.install-lock')) -ceq 'SYNTHETIC-UNRECOVERED-INSTALL')
Check 'actual-reader-refuses-incomplete-install' (Refuses {Assert-OwnerPolicyInstallComplete $stale} 'OBD_INSTALL_INCOMPLETE')
$originalInstallGate=(Get-Command Assert-OwnerPolicyInstallComplete).ScriptBlock
function Assert-OwnerPolicyInstallComplete {& $originalInstallGate $stale}
try{Check 'actual-client-reader-gates-before-opening-installed-files' (Refuses {Read-InstalledOwnerBootstrap} 'OBD_INSTALL_INCOMPLETE')}
finally{Set-Item Function:\Assert-OwnerPolicyInstallComplete -Value $originalInstallGate}
$serviceSource=Join-Path $PSScriptRoot '..\packaging\windows\read-owner-service-trust.ps1';$serviceTokens=$null;$serviceErrors=$null
$serviceAst=[Management.Automation.Language.Parser]::ParseFile($serviceSource,[ref]$serviceTokens,[ref]$serviceErrors)
$gateCall=@($serviceAst.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Assert-OwnerPolicyInstallComplete'},$true))
$firstRead=@($serviceAst.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Read-OwnerPinnedFile'},$true)|Sort-Object {$_.Extent.StartOffset})
Check 'service-entry-ast-gates-before-first-protected-read' ($serviceErrors.Count -eq 0 -and $gateCall.Count -eq 1 -and $firstRead.Count -gt 0 -and $gateCall[0].Extent.StartOffset -lt $firstRead[0].Extent.StartOffset)
$mismatch=New-PolicyCase 'wrong-directory';$null=[IO.Directory]::CreateDirectory((Join-Path $mismatch 'security'))
Check 'actual-existing-directory-not-repaired' (Refuses {Publish-OwnerInstallPolicy $mismatch $policy $admins} 'OIP_DIRECTORY_POLICY_MISMATCH')
Check 'actual-failed-preparation-lock-retained' ([IO.File]::Exists((Join-Path $mismatch 'owner-policy.install-lock')))
Check 'actual-reader-refuses-failed-preparation' (Refuses {Assert-OwnerPolicyInstallComplete $mismatch} 'OBD_INSTALL_INCOMPLETE')
$junctionCase=New-PolicyCase 'junction';$junction=Join-Path $junctionCase 'redirect'
$null=New-Item -ItemType Junction -Path $junction -Target $root
Check 'actual-junction-root-refused' (Refuses {Publish-OwnerInstallPolicy $junction $policy $admins} 'OBD_FILE_IDENTITY_INVALID')
$failedFinal=New-PolicyCase 'final-confirmation-failure'
$originalDigest=(Get-Command Get-OwnerDigest).ScriptBlock
function Get-OwnerDigest([byte[]]$Bytes){throw 'OIP_SYNTHETIC_HASH_FAILURE'}
try{Check 'actual-final-confirmation-failure-reported' (Refuses {Publish-OwnerInstallPolicy $failedFinal $policy $admins} 'OIP_SYNTHETIC_HASH_FAILURE')}
finally{Set-Item Function:\Get-OwnerDigest -Value $originalDigest}
Check 'actual-published-but-unconfirmed-policy-quarantined' ([IO.File]::Exists((Join-Path $failedFinal 'security\owner-bootstrap-install.json')) -and [IO.File]::Exists((Join-Path $failedFinal 'owner-policy.install-lock')))
Check 'actual-reader-rejects-published-unconfirmed-policy' (Refuses {Assert-OwnerPolicyInstallComplete $failedFinal} 'OBD_INSTALL_INCOMPLETE')
$corrupt=New-PolicyCase 'corrupt-existing';$corruptSecurity=Join-Path $corrupt 'security'
$null=[IO.Directory]::CreateDirectory($corruptSecurity,(New-OwnerPolicySecurity $policy 'security' $admins));$corruptFile=Join-Path $corruptSecurity 'owner-bootstrap-install.json'
[IO.File]::WriteAllText($corruptFile,'{"version":')
Check 'actual-corrupt-existing-policy-never-reset' (Refuses {Publish-OwnerInstallPolicy $corrupt $policy $admins} 'OIP_POLICY_ALREADY_PRESENT')
Check 'actual-corrupt-policy-bytes-preserved' ([IO.File]::ReadAllText($corruptFile) -ceq '{"version":')
$hardlinkCase=New-PolicyCase 'hardlink-existing';$hardlinkSecurity=Join-Path $hardlinkCase 'security'
$null=[IO.Directory]::CreateDirectory($hardlinkSecurity,(New-OwnerPolicySecurity $policy 'security' $admins));$hardlinkFile=Join-Path $hardlinkSecurity 'owner-bootstrap-install.json'
[IO.File]::WriteAllText($hardlinkFile,'SYNTHETIC-HARDLINK-POLICY');$null=New-Item -ItemType HardLink -Path (Join-Path $hardlinkCase 'alias.json') -Target $hardlinkFile
Check 'actual-hardlinked-policy-never-overwritten' (Refuses {Publish-OwnerInstallPolicy $hardlinkCase $policy $admins} 'OIP_POLICY_ALREADY_PRESENT')
$readPins=[Collections.Generic.List[IDisposable]]::new()
try{Check 'actual-reader-refuses-hardlinked-policy' (Refuses {Read-OwnerPinnedFile $hardlinkFile $admins $readPins} 'OBD_FILE_IDENTITY_INVALID')}
finally{for($index=$readPins.Count-1;$index -ge 0;$index--){$readPins[$index].Dispose()}}
$malformed=$policy|ConvertTo-Json -Compress|ConvertFrom-Json;$malformed.port='7690'
Check 'actual-private-parser-rejects-string-port' (Refuses {Assert-OwnerInstallPolicy $malformed} 'OIP_POLICY_INVALID')
$release=[pscustomobject]@{version='1';protocolVersion=2;helperFile='Ragent.OwnerBootstrap.exe';helperSha256=('a'*64);publisherSha256=('b'*64)}
Check 'actual-release-parser-rejects-string-version' (Refuses {Assert-OwnerPolicyRelease $release} 'OIP_SIGNED_RELEASE_REQUIRED')
@{pass=$true;checks=@($checks);evidenceRoot=$base;level='actual NTFS publication and QA-root ACLs with current-user QA administrative authority and synthetic service/Owner SIDs';ancestorAclOutsideQaRootSubstituted=$true;actualAdministratorOwner=$false;effectiveServiceAccessTested=$false;productionChanged=$false;servicesActivated=$false;syntheticEvidenceRetained=$true}|ConvertTo-Json -Depth 5 -Compress
