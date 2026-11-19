// Compile, query and exercise read-only local refusals. Never msiexec/SCM writes.
import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {existsSync} from 'node:fs';import {mkdir,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve,join} from 'node:path';
const exec=promisify(execFile),ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',root=resolve(process.env.RAGENT_MSI_TEST_EVIDENCE_DIR||'artifacts/showcase/T2-current-20261020/managed-msi/local');await mkdir(root,{recursive:true});
await exec(ps,['-NoProfile','-NonInteractive','-File','packaging/windows/build-managed-owner-msi-bridge.ps1','-OutputPath',join(root,'Ragent.ManagedOwnerMsiBridge.exe')],{windowsHide:true,timeout:30000,maxBuffer:65536});
const exe=join(root,'Ragent.ManagedOwnerMsiBridge.exe');let count=0;
const binary=await readFile(exe);const peOffset=binary.readUInt32LE(0x3c);
assert.equal(binary.readUInt16LE(peOffset+24+68),2,'MSI helper must use the Windows GUI subsystem to avoid a console window');
const missingRoot=join(tmpdir(),`ragent-owner-msi-bridge-missing-${process.pid}`);assert.equal(existsSync(missingRoot),false,'negative-path root must be absent');
const wix=await readFile(resolve('packaging/windows/Ragent.ManagedOwner.wxs'),'utf8');
const bridge=await readFile(resolve('packaging/windows/managed-owner-msi-bridge.cs'),'utf8');
const activatedWix=await readFile(resolve('packaging/windows/Ragent.ActivatedOwner.wxs'),'utf8');
assert.match(activatedWix, /Id="ManagedVoiceRollback"[^\n]+Execute="rollback"[^\n]+Impersonate="no"/, 'voice retirement has an elevated rollback action');
assert.match(activatedWix, /Id="ManagedVoicePrepare"[^\n]+Execute="deferred"[^\n]+Impersonate="no"/, 'voice retirement is performed inside the installer transaction');
assert.match(activatedWix, /Id="ManagedVoiceCommit"[^\n]+Execute="commit"[^\n]+Impersonate="no"/, 'voice retirement cleanup waits for installer commit');
assert.match(activatedWix, /Action="ManagedVoiceRollback" After="StopServices"/);
assert.match(activatedWix, /Action="ManagedVoicePrepare" After="ManagedVoiceRollback"/);
assert.match(activatedWix, /Action="ManagedVoiceCommit" After="ManagedUpgradeCommit"/);
assert.doesNotMatch(activatedWix, /<EmbeddedUI|WixUI_InstallDir/, 'the machine MSI is driven by the outer installer');
assert.match(activatedWix, /<StandardDirectory Id="ProgramFiles64Folder">[\s\S]*?<Directory Id="RagentMachineRoot" Name="Ragent"/, 'the machine installation root is fixed under Program Files');
assert.match(activatedWix, /Property Id="RAGENT_RECOVERY_SOURCE" Secure="yes"/, 'the recovery source survives elevation');
assert.match(activatedWix, /ManagedRelocationRollback" Before="InstallFiles"/, 'relocation rollback is scheduled before receipts can be moved');
assert.match(activatedWix, /ManagedRelocationPrepare" After="InstallFiles"/, 'relocation preparation follows MSI payload installation');
assert.match(activatedWix, /ManagedRelocationCommit" After="ManagedInstallCommit"/, 'old destination data stays recoverable until owner activation commits');
assert.doesNotMatch(activatedWix, /RAGENT_LAUNCH|ManagedCloseDesktop|payload\\Desktop/, 'the machine MSI must not manage the user desktop');
const msiBuilder=await readFile(resolve('packaging/windows/build-msi.ps1'),'utf8');
const brokerBuilder=await readFile(resolve('packaging/windows/build-privileged-broker.ps1'),'utf8');
const activationTrialSource=await readFile(resolve('packaging/windows/owner-service-activation-trial.cs'),'utf8');
const serviceHostSource=await readFile(resolve('packaging/windows/Ragent.ServiceHost.cs'),'utf8');
const activationCheck=await readFile(resolve('packaging/windows/check-owner-msi-activation.ps1'),'utf8');
const upgradeAdmission=await readFile(resolve('packaging/windows/check-owner-msi-upgrade.ps1'),'utf8');
assert.doesNotMatch(upgradeAdmission,/\[IO\.(?:Directory|File)\]::GetAccessControl\(/,'the upgrade admission must not call ACL APIs absent from PowerShell 7');
assert.equal((upgradeAdmission.match(/Get-OwnerPathAcl -Path/g)||[]).length,3,'upgrade admission reads ACLs for directories and files through its PowerShell-compatible helper');
const pwsh=(await exec('where.exe',['pwsh.exe'],{windowsHide:true,timeout:10000,maxBuffer:4096})).stdout.split(/\r?\n/)[0].trim();
assert.ok(pwsh,'PowerShell 7 must be available for the upgrade ACL compatibility regression');
const admissionPath=resolve('packaging/windows/check-owner-msi-upgrade.ps1').replaceAll("'","''"),aclProbeRoot=root.replaceAll("'","''"),aclProbeFile=exe.replaceAll("'","''");
const aclProbe=`$ErrorActionPreference='Stop';. '${admissionPath}' -LibraryOnly;$directoryAcl=Get-OwnerPathAcl -Path '${aclProbeRoot}';$fileAcl=Get-OwnerPathAcl -Path '${aclProbeFile}';if($directoryAcl -isnot [System.Security.AccessControl.DirectorySecurity]){throw 'Expected DirectorySecurity'};if($fileAcl -isnot [System.Security.AccessControl.FileSecurity]){throw 'Expected FileSecurity'};'UPGRADE_ACL_PWSH7_PASS'`;
const aclProbeResult=await exec(pwsh,['-NoProfile','-NonInteractive','-Command',aclProbe],{windowsHide:true,timeout:30000,maxBuffer:16384});
assert.match(aclProbeResult.stdout,/UPGRADE_ACL_PWSH7_PASS/,'upgrade ACL reads must work for both files and directories in PowerShell 7');
const upgradeReceiptProbe=`$ErrorActionPreference='Stop';. '${admissionPath}' -LibraryOnly
function New-ReceiptSet([int]$PolicyVersion=2){
  $owner='S-1-5-21-1-2-3-1001';$inst='inst_'+('a'*32);$h=('b'*64);$r=('c'*64);$i=('d'*64);$p=('e'*64)
  $policyJson='{"version":1,"instanceId":"'+$inst+'","controlSid":"S-1-5-80-1-2-3-4-5","executorSid":"S-1-5-80-6-7-8-9-10","ownerSid":"'+$owner+'","port":7690}'
  $preparedJson='{"version":1,"purpose":"owner-msi-preparation","phase":"prepared","ownerSid":"'+$owner+'"}'
  if($PolicyVersion -eq 2){
    $policyReceiptJson='{"version":2,"purpose":"owner-msi-policy-preparation","phase":"policy-prepared","instanceId":"'+$inst+'","policySha256":"__POLICY_SHA__","releaseSha256":"'+$r+'","helperSha256":"'+$h+'","trustMode":"admin-installed-sha256","identityReused":"preserved-existing"}'
  }else{
    $policyReceiptJson='{"version":1,"purpose":"owner-msi-policy-preparation","phase":"policy-prepared","instanceId":"'+$inst+'","policySha256":"__POLICY_SHA__","releaseSha256":"'+$r+'","helperSha256":"'+$h+'","publisherSha256":"'+$p+'","identitySha256":"'+$i+'"}'
  }
  $activeJson='{"version":1,"purpose":"owner-service-activation","phase":"configuration-committed","instanceId":"'+$inst+'","preparedSha256":"__PREPARED_SHA__","policyReceiptSha256":"__POLICY_RECEIPT_SHA__","committedAt":"2026-11-19T00:00:00.0000000Z","healthConfirmed":false}'
  $healthJson='{"version":1,"purpose":"owner-service-activation-health","instanceId":"'+$inst+'","observation":"service-processes-running","supervisorPid":4242,"controlPid":2147483647,"observedAt":"2026-11-19T00:00:01.0000000Z"}'
  $markerJson='{"version":1,"purpose":"owner-service-activation","instanceId":"'+$inst+'","preparedSha256":"__PREPARED_SHA__","policyReceiptSha256":"__POLICY_RECEIPT_SHA__"}'
  return @{policyJson=$policyJson;preparedJson=$preparedJson;policyReceiptJson=$policyReceiptJson;activeJson=$activeJson;healthJson=$healthJson;markerJson=$markerJson}
}
function Invoke-ReceiptSet([hashtable]$Set){
  $utf8=[Text.UTF8Encoding]::new($false,$true)
  $policyBytes=$utf8.GetBytes($Set.policyJson);$preparedBytes=$utf8.GetBytes($Set.preparedJson)
  $policyReceiptJson=$Set.policyReceiptJson.Replace('__POLICY_SHA__',(Get-OwnerDigest $policyBytes))
  $policyReceiptBytes=$utf8.GetBytes($policyReceiptJson)
  $preparedDigest=Get-OwnerDigest $preparedBytes;$policyReceiptDigest=Get-OwnerDigest $policyReceiptBytes
  $activeJson=$Set.activeJson.Replace('__PREPARED_SHA__',$preparedDigest).Replace('__POLICY_RECEIPT_SHA__',$policyReceiptDigest)
  $markerJson=$Set.markerJson.Replace('__PREPARED_SHA__',$preparedDigest).Replace('__POLICY_RECEIPT_SHA__',$policyReceiptDigest)
  Assert-OwnerUpgradeAdmissionReceipts ($Set.policyJson|ConvertFrom-Json) $policyBytes ($Set.preparedJson|ConvertFrom-Json) $preparedBytes ($policyReceiptJson|ConvertFrom-Json) $policyReceiptBytes ($activeJson|ConvertFrom-Json) ($Set.healthJson|ConvertFrom-Json) ($markerJson|ConvertFrom-Json)
}
foreach($ver in @(1,2)){
  $valid=New-ReceiptSet $ver
  if($PSVersionTable.PSVersion.Major -ge 7 -and (($valid.healthJson|ConvertFrom-Json).supervisorPid -isnot [long])){throw 'Expected pwsh 7 Int64 JSON integer'}
  Invoke-ReceiptSet $valid
}
function Assert-Refused([string]$Label,[hashtable]$Set,[string]$ExpectedCode){
  $actual='';try{Invoke-ReceiptSet $Set}catch{$actual=$_.Exception.GetBaseException().Message}
  if($actual -cne $ExpectedCode){throw ('Expected '+$ExpectedCode+' for '+$Label+' but got: '+$actual)}
}
foreach($badPid in @('2147483648','0','-1','"4242"','4242.5','true','null')){
  $s=New-ReceiptSet 2;$s.healthJson=$s.healthJson.Replace('"supervisorPid":4242',('"supervisorPid":'+$badPid));Assert-Refused ('supervisorPid='+$badPid) $s 'OUG_ACTIVE_RECEIPT_INVALID'
  $c=New-ReceiptSet 2;$c.healthJson=$c.healthJson.Replace('"controlPid":2147483647',('"controlPid":'+$badPid));Assert-Refused ('controlPid='+$badPid) $c 'OUG_ACTIVE_RECEIPT_INVALID'
}
foreach($badBool in @('0','1','"false"','true','null')){
  $a=New-ReceiptSet 2;$a.activeJson=$a.activeJson.Replace('"healthConfirmed":false',('"healthConfirmed":'+$badBool));Assert-Refused ('healthConfirmed='+$badBool) $a 'OUG_ACTIVE_RECEIPT_INVALID'
}
foreach($badVer in @('"1"','1.0','true','0','-1','2147483648')){
  $p=New-ReceiptSet 2;$p.preparedJson=$p.preparedJson.Replace('"version":1',('"version":'+$badVer));Assert-Refused ('prepared.version='+$badVer) $p 'OUG_ACTIVE_RECEIPT_INVALID'
  $pr=New-ReceiptSet 2;$pr.policyReceiptJson=$pr.policyReceiptJson.Replace('"version":2',('"version":'+$badVer));Assert-Refused ('policyReceipt.version='+$badVer) $pr 'OUG_ACTIVE_RECEIPT_INVALID'
  $ac=New-ReceiptSet 2;$ac.activeJson=$ac.activeJson.Replace('"version":1',('"version":'+$badVer));Assert-Refused ('active.version='+$badVer) $ac 'OUG_ACTIVE_RECEIPT_INVALID'
  $hl=New-ReceiptSet 2;$hl.healthJson=$hl.healthJson.Replace('"version":1',('"version":'+$badVer));Assert-Refused ('health.version='+$badVer) $hl 'OUG_ACTIVE_RECEIPT_INVALID'
  $mk=New-ReceiptSet 2;$mk.markerJson=$mk.markerJson.Replace('"version":1',('"version":'+$badVer));Assert-Refused ('marker.version='+$badVer) $mk 'OUG_ACTIVE_RECEIPT_INVALID'
  $pl=New-ReceiptSet 2;$pl.policyJson=$pl.policyJson.Replace('"version":1',('"version":'+$badVer));Assert-Refused ('policy.version='+$badVer) $pl 'OIP_POLICY_INVALID'
  $pp=New-ReceiptSet 2;$pp.policyJson=$pp.policyJson.Replace('"port":7690',('"port":'+$badVer));Assert-Refused ('policy.port='+$badVer) $pp 'OIP_POLICY_INVALID'
}
foreach($badTime in @('"not-a-date"','"2026-11-19"','"2026-11-19T00:00:00"','""','12345','true','null')){
  $at=New-ReceiptSet 2;$at.activeJson=$at.activeJson.Replace('"2026-11-19T00:00:00.0000000Z"',$badTime);Assert-Refused ('active.committedAt='+$badTime) $at 'OUG_ACTIVE_RECEIPT_INVALID'
  $ht=New-ReceiptSet 2;$ht.healthJson=$ht.healthJson.Replace('"2026-11-19T00:00:01.0000000Z"',$badTime);Assert-Refused ('health.observedAt='+$badTime) $ht 'OUG_ACTIVE_RECEIPT_INVALID'
}
@{psVersion=$PSVersionTable.PSVersion.ToString();pass=$true}|ConvertTo-Json -Compress`;
const encodedReceiptProbe=Buffer.from(upgradeReceiptProbe,'utf16le').toString('base64');
for(const [label,shellExe] of [['powershell-5.1',ps],['pwsh-7',pwsh]]){
  const receiptResult=await exec(shellExe,['-NoProfile','-NonInteractive','-EncodedCommand',encodedReceiptProbe],{windowsHide:true,timeout:30000,maxBuffer:16384});
  assert.equal(JSON.parse(receiptResult.stdout).pass,true,`${label} upgrade receipt Int32/Int64 regression failed`);
}
const upgradePreparation=await readFile(resolve('packaging/windows/prepare-owner-msi-upgrade.ps1'),'utf8');
const removal=await readFile(resolve('packaging/windows/remove-owner-msi-policy.ps1'),'utf8');
assert.doesNotMatch(activationCheck,/\[IO\.(?:Directory|File)\]::GetAccessControl\(/,'activation check must not call ACL APIs absent from PowerShell 7');
assert.doesNotMatch(removal,/\[IO\.(?:Directory|File)\]::GetAccessControl\(/,'removal admission must not call ACL APIs absent from PowerShell 7');
const removeRollback=await readFile(resolve('packaging/windows/rollback-owner-msi-uninstall.ps1'),'utf8');
const prevalidation=await readFile(resolve('packaging/windows/prevalidate-owner-msi.ps1'),'utf8');
const chatServer=await readFile(resolve('chat-server.mjs'),'utf8');
const rollbackTest=await readFile(resolve('tests/windows-activated-owner-msi-rollback.ps1'),'utf8');
assert.match(bridge,/SetProductRoot\(args\[args\.Length-1\]\);args=args\.Take\(args\.Length-1\)\.ToArray\(\)/,'MSI actions must pass the selected install root into the trusted helper');
assert.match(bridge,/args\.Length==2&&args\[0\]=="prepare"/,'the bridge must accept only prepare plus a validated owner SID after stripping the root');
assert.match(bridge,/static void ValidateProductRoot\(\)/,'the selected install root and its ancestors must be checked before preparation');
for(const action of ['ManagedFreshGuard']){
 const line=wix.split(/\r?\n/).find(value=>value.includes(`<CustomAction Id="${action}"`));
 assert.ok(line,`Missing ${action} action`);assert.match(line,/RagentMachineRoot/,`${action} must receive its package install root`);
}
for(const action of ['ManagedFreshGuard','ManagedRemoveGuard','ManagedPrepare','ManagedRemove']){
 const line=activatedWix.split(/\r?\n/).find(value=>value.includes(`<CustomAction Id="${action}"`));
 assert.ok(line,`Missing activated Owner ${action} action`);assert.match(line,/RagentMachineRoot/,`Activated Owner ${action} must receive its package install root`);
}
for(const action of ['ManagedUpgradeGuard','ManagedUpgradeBegin','ManagedUpgradeRollback','ManagedPrepareExisting','ManagedPreparePolicyExisting','ManagedUpgradeActivationCheck','ManagedUpgradeActivate','ManagedUpgradeCommit']){
 const line=activatedWix.split(/\r?\n/).find(value=>value.includes(`<CustomAction Id="${action}"`));
 assert.ok(line,`Missing ${action} action`);assert.match(line,/RagentMachineRoot/,`${action} must receive the selected install root`);
}
assert.match(activatedWix,/ProductCode="\$\(var\.ProductCode\)"/,'the first in-place MSI migration must be able to retain the registered product identity');
assert.match(activatedWix,/MsiUpgradeLane/,'the migration and major-upgrade lanes must be explicit at build time');
assert.match(activatedWix,/UpgradeStrategy="\$\(var\.MsiUpgradeStrategy\)"/,'the minor lane must disable WiX v5+ default major-upgrade authoring');
assert.match(msiBuilder,/MsiUpgradeStrategy=\$msiUpgradeStrategy/,'the MSI build must explicitly select no major-upgrade strategy for minor updates');
assert.match(msiBuilder,/\$experimentalMajor\s*=\s*if\s*\(\$MsiUpgradeLane\s+-eq\s+'major'\)\s*\{'1'\}\s*else\s*\{'0'\}/,'ordinary Owner major builds select the verified guarded transaction');
assert.match(msiBuilder,/MSI_MINOR_UPGRADE_HAS_MAJOR_UPGRADE_ROWS/,'the build must reject a minor MSI with an Upgrade table row');
assert.match(msiBuilder,/MSI_MINOR_UPGRADE_HAS_REMOVE_EXISTING_PRODUCTS/,'the build must reject a minor MSI with RemoveExistingProducts sequenced');
assert.match(msiBuilder,/MSI_MINOR_UPGRADE_PRODUCT_CODE_MISMATCH/,'the build must verify the requested installed ProductCode in the MSI database');
assert.match(msiBuilder,/MSI_MINOR_UPGRADE_VERSION_MISMATCH/,'the build must verify the requested MSI version in the database');
assert.match(activatedWix,/MSIUNINSTALLSUPERSEDEDCOMPONENTS/,'the minor update must clean the single retired component');
assert.match(activatedWix,/NOT UPGRADINGPRODUCTCODE/,'major-upgrade removal must preserve Owner and Broker state');
assert.match(activatedWix,/ManagedMajorUpgradeRefused/,'unvalidated ProductCode changes must stop before RemoveExistingProducts');
assert.match(activatedWix,/<\?else\?>\s*<Custom Action="ManagedMajorUpgradeRefused" Before="RemoveExistingProducts"/,'major upgrades remain refused unless the explicit experimental lane is selected');
assert.match(activatedWix, /<Custom Action="ManagedUpgradeGuard" After="InstallInitialize"[\s\S]*?<Custom Action="ManagedMajorBrokerRollback" After="ManagedUpgradeGuard"[\s\S]*?<InstallExecute After="ManagedMajorBrokerRollback"/, 'major upgrade registers Broker rollback after admission and before removal');
assert.match(activatedWix,/<CustomAction Id="ManagedSameUpgradeGuard"[^>]*upgrade-admission \$\(var\.MsiProductVersion\) &quot;\[ProductCode\]&quot;/,'a same-package reinstall verifies the actual installed product');
assert.match(activatedWix, /<Custom Action="ManagedSameUpgradeGuard" Before="ManagedSameUpgradeRollback"[\s\S]*?<Custom Action="ManagedSameUpgradeRollback" Before="ManagedSameUpgradeBegin"[\s\S]*?<Custom Action="ManagedSameUpgradeBegin" Before="StopServices"/, 'same-package reinstall admits and registers rollback before stopping services');
assert.match(activatedWix,/<Custom Action="ManagedUpgradeCommit" Before="InstallFinalize" Condition="\(WIX_UPGRADE_DETECTED AND NOT Installed\) OR \(Installed AND REINSTALL AND NOT \(REMOVE = &quot;ALL&quot;\)\)"\s*\/>/,'both major upgrades and same-package reinstalls commit their transaction');
assert.match(bridge,/RestoreBrokerAfterMajorRollback[\s\S]*?ConfigureBrokerService\(version,hash\)[\s\S]*?ServiceController\(BrokerServiceName\)/,'major rollback restores the verified old broker configuration and service');
assert.match(activatedWix,/<Custom Action="ManagedUpgradeRollback" After="RemoveExistingProducts"[\s\S]*?<Custom Action="ManagedUpgradeBegin" After="ManagedUpgradeRollback"/,'the experimental lane registers receipt rollback before beginning its migration');
assert.match(activatedWix,/<CustomAction Id="ManagedUpgradeGuard"[^>]+Execute="deferred" Impersonate="no"/,'minor-upgrade admission must run elevated to inspect protected service state');
assert.match(activatedWix,/upgrade-admission \$\(var\.MsiProductVersion\) &quot;\$\(var\.ProductCode\)&quot;/,'minor-upgrade admission must compare the candidate MSI version and product identity');
assert.match(activatedWix,/<Package[^>]+Version="\$\(var\.MsiProductVersion\)"/,'the MSI package version must use its three-part effective version');
assert.match(msiBuilder,/MSI_MINOR_EFFECTIVE_VERSION_REQUIRED/,'minor updates must specify a Windows Installer effective version');
assert.match(msiBuilder,/MSI_MINOR_EFFECTIVE_VERSION_NOT_NEWER/,'minor updates must increase a Windows Installer version field');
assert.match(msiBuilder,/assert-minor-component-compat\.ps1/,'minor updates must preserve the previous MSI component tree');
assert.match(activatedWix, /<Custom Action="ManagedUpgradeGuard" Before="ManagedUpgradeRollback" Condition="Installed AND REINSTALL/, 'minor admission precedes rollback registration');
assert.match(bridge,/MsiGetProductInfo\(productCode,"VersionString"/,'minor-upgrade admission must read the installed version from Windows Installer');
assert.match(bridge,/package\.CompareTo\(installed\)<0/,'downgrades must be refused while same-version repair remains available');
assert.match(bridge,/OMI_UPDATE_OLDER/,'downgrade refusal must have a typed result');
assert.match(activatedWix,/<Custom Action="ManagedUpgradeCommit" Before="InstallFinalize" Condition="Installed AND REINSTALL/,'minor-upgrade commit cleanup must be queued inside the MSI transaction');
assert.match(activatedWix,/Name="Ragent-ControlPlane" Stop="install"/,'minor updates must stop the existing Owner process before replacing service files');
assert.match(bridge,/args\[0\]=="upgrade-admission"/,'the MSI bridge must expose the embedded read-only upgrade admission');
assert.match(bridge,/action=="UpgradeActivationCheck"\)scriptArguments=" -Action Check -PreserveExistingIdentity"/,'the upgrade activation path must retain the existing key without reading it');
assert.match(activationCheck,/PreserveExistingIdentity/,'upgrade activation must validate the existing identity by metadata only');
assert.match(upgradeAdmission,/credentialContentsRead=\$false/,'upgrade admission must not read credential contents');
assert.match(upgradeAdmission,/ReadBroker\('Ragent-PrivilegedBroker'\)/,'broker admission must query SCM directly because WMI cannot see the restricted service');
assert.match(upgradeAdmission,/QueryServiceConfig[\s\S]*QueryServiceStatusEx/,'broker admission must check service configuration and live status');
assert.doesNotMatch(upgradeAdmission,/foreach\(\$name in @\([^\r\n]*owner-msi\.activated\.json/,'read-only upgrade admission must accept the stable activated-install receipt');
assert.match(upgradeAdmission,/\$brokerBinary=Join-Path \$product 'Broker\\Ragent\.PrivilegedBroker\.exe'/,'upgrade admission must verify the Broker inside the selected MSI install root');
assert.match(upgradeAdmission,/Assert-UpgradePath \$brokerBinary \$false/,'upgrade admission must pin the Broker binary at the selected install root');
assert.match(upgradeAdmission,/owner-msi\.prepared\.activated\.json/,'upgrade admission must validate the active MSI receipt set');
assert.match(upgradeAdmission,/owner-activation\.committed-lock/,'upgrade admission must require a committed activation marker');
assert.match(upgradePreparation,/identityReused='preserved-existing'/,'the MSI receipt must bind to the existing Owner identity without a key hash');
assert.match(upgradePreparation,/foreach\(\$service in \$services\)\{\$service\.Restrict\(\)\}/,'retained-data reinstall must restrict the new disabled services before activation');
assert.match(upgradePreparation,/archivedReceipts/,'minor upgrade must preserve the prior active receipts until commit or rollback');
assert.match(upgradePreparation,/Restore-UpgradeReceipts/,'minor upgrade rollback must restore the prior active receipt set');
assert.match(upgradePreparation,/Remove-UpgradeArchives/,'minor upgrade commit must remove only its verified prior-receipt archive');
assert.match(removal,/owner-msi\.removed\.json/,'completed active removal must retain an explicit recovery marker');
assert.match(removal,/preparedSha256=\(Get-OwnerDigest \$preparedInput\.bytes\)/,'the recovery marker must bind the old prepared receipt');
assert.match(removal,/policySha256=\(Get-OwnerDigest \$recordInput\.bytes\)/,'the recovery marker must bind the old policy receipt');
assert.match(removal,/activeSha256=\(Get-OwnerDigest \$activeInput\.bytes\)/,'the recovery marker must bind the old activation receipt');
assert.match(removal,/if\(\$complete\)\{\[IO\.File\]::Delete\(\$marker\)\}/,'successful removal must clear its preparation quarantine lock');
assert.match(bridge,/static Dictionary<string,object> RemovedAdmission\(\)/,'fresh-install admission must validate a protected completed removal marker');
assert.match(bridge,/OMI_RECOVERY_RECEIPT_CHANGED/,'recovery must reject changed retained receipts');
assert.match(bridge,/OMI_RECOVERY_OWNER_MISMATCH/,'recovery must keep the original Owner SID');
assert.match(bridge,/Run\("UpgradeBegin",null\)/,'recovery must begin the retained-identity transaction before preparation');
assert.match(bridge,/Run\("UpgradeRollback",null\)/,'failed recovery must restore archived receipts');
assert.match(bridge,/Run\("UpgradeCommit",null\)/,'successful recovery must commit archived receipts');
assert.match(activatedWix,/<Custom Action="ManagedInstallCommit" Before="InstallFinalize" Condition="NOT Installed/,'recovery commit cleanup must run inside the fresh-install transaction');
assert.match(activatedWix,/<Property Id="MSIRESTARTMANAGERCONTROL" Value="DisableShutdown"/,'use Restart Manager file detection without automatic restart mitigation');
assert.match(activatedWix,/<Property Id="MSIRMSHUTDOWN" Value="2"/,'restrict unattended restart-manager shutdown to restartable applications');
assert.match(activatedWix,/<Custom Action="ManagedRemove" Before="DeleteServices"/,'active removal must drain and verify ordinary services before MSI deletes their registrations');
assert.doesNotMatch(activatedWix,/<util:CloseApplication[^>]+Target="Ragent\.exe"/,'uninstall must not terminate other same-named applications by name alone');
assert.match(activatedWix,/<Custom Action="ManagedRemoveRollback" Before="ManagedBrokerOwnerReset"/,'uninstall rollback must be registered before irreversible owner reset');
assert.equal((activatedWix.match(/<PermissionEx Sddl="O:SYG:SYD:\(A;;GA;;;SY\)\(A;;GA;;;BA\)\(A;;CCLCSWLOCRRC;;;IU\)\(A;;CCLCSWLOCRRC;;;SU\)"\s*\/>/g)||[]).length,2,'both Owner service objects must grant SYSTEM service configuration rights without granting ordinary users mutations');
assert.match(bridge,/RemoveRollback\(string version,string expectedSha256\)/,'uninstall rollback must verify the fixed Broker package identity');
assert.match(bridge,/PrevalidationRollback[\s\S]*?PrevalidationMarker\(\)[\s\S]*?RemoveRollback\(version,expectedSha256\)/,'early rollback must verify its protected marker and restore the validated installation');
assert.match(prevalidation,/FileMode\]::CreateNew[\s\S]*?Flush\(\$true\)[\s\S]*?QuiesceForRemoval\(\)/,'write the recovery marker before stopping services');
assert.match(activationTrialSource,/QuiesceForRemoval\(\)[\s\S]*?ControlService\(handle,1/,'early service shutdown must retain a validated SCM handle');
assert.match(msiBuilder,/useEarlyQuiescence[\s\S]*?MSI_EARLY_SEQUENCE_COLLISION/,'early sequence rewriting must apply only to the activated-owner major lane and reject collisions');
assert.match(activatedWix,/<CustomAction Id="ManagedPreValidationRollback"[^>]*Execute="rollback"/,'early shutdown must register an MSI rollback action');
assert.match(bridge,/if\(marker\)RemovedAdmission\(\)/,'uninstall rollback must validate a completed removal marker before clearing it');
assert.match(bridge,/if\(marker\)RemovedAdmission\(\);else ActiveAdmission\(true\)/,'rollback must admit an authenticated in-progress removal');
assert.match(bridge,/OMI_REMOVAL_LOCK_INVALID/,'rollback must only accept the exact authenticated removal lock');
assert.match(removeRollback,/ORR_REMOVAL_LOCK_INVALID/,'rollback must validate the removal lock before clearing it');
assert.match(removeRollback,/Get-OwnerServicePreparationPlan/,'uninstall rollback must use the fixed Owner service plan');
assert.match(removeRollback,/CreateService\(manager,name,display/,'uninstall rollback must recreate Owner service registrations deleted by the removal transaction');
assert.match(removeRollback,/SetServiceObjectSecurity\(service,4,bytes\)/,'recreated Owner services must regain the restricted service DACL');
assert.match(removeRollback,/ChangeServiceConfig2\(service,5,sid\)/,'uninstall rollback must restore Owner service SID type through fixed SCM handles');
assert.match(removeRollback,/ChangeServiceConfig2\(service,6,info\)/,'uninstall rollback must restore Owner service privilege limits through fixed SCM handles');
assert.match(activatedWix,/<Custom Action="ManagedUpgradeRollback" Before="ManagedUpgradeBegin"/,'minor upgrade rollback restoration must be scheduled before receipt archival can start');
assert.match(msiBuilder,/minor MSI update requires the exact installed ProductCode GUID/,'minor builds must bind to the exact registered ProductCode');
assert.match(activatedWix,/<ServiceInstall[^>]+Name="Ragent-PrivilegedBroker"[^>]+Account="LocalSystem"/,'the activated MSI must install the Broker as a distinct LocalSystem service');
assert.match(activatedWix,/<Component Id="PrivilegedBrokerService"[^>]+Guid="\{[A-F0-9-]{36}\}"/,'the Broker EXE and manifest component must use a stable GUID because the native EXE has no MSI file version');
assert.match(activatedWix,/<ServiceControl[^>]+Name="Ragent-PrivilegedBroker"[^>]+Start="install"[^>]+Stop="both"[^>]+Remove="uninstall"/,'MSI must start and remove the Broker service through owned service actions');
assert.match(activatedWix,/ManagedConfigureBrokerServiceTrust[^\r\n]+configure-broker-service \$\(var\.ProductVersion\) \$\(var\.BrokerSha256\)/,'the MSI must verify the exact versioned Broker binary and manifest before service start');
assert.match(activatedWix,/configure-broker-service \$\(var\.ProductVersion\) \$\(var\.BrokerSha256\) &quot;\[RagentMachineRoot\]\.&quot;/,'the deferred Broker trust action must pass the selected install root after the version and binary hash');
assert.match(bridge,/else if\(args\.Length>1&&Regex\.IsMatch\(args\[args\.Length-1\],@"\\A\[A-Za-z\]:\\\\"\)\)/,'the bridge must consume and validate the final install-root argument before dispatching Broker trust configuration');
assert.match(bridge,/args\.Length==3&&args\[0\]=="configure-broker-service"/,'the bridge must accept only version, hash and selected-root arguments for Broker trust configuration');
assert.match(bridge,/Owner MSI Broker trust failed:/,'failed Broker trust actions must log only a typed code for local MSI diagnosis');
assert.match(bridge,/Owner MSI prepare bridge failed:/,'Owner prepare bridge failures must log only a typed code for local MSI diagnosis');
assert.match(bridge,/SetBrokerServiceDacl\(service\);VerifyBrokerServiceDacl\(service\)/,'the Broker MSI action must replace an untrusted legacy service DACL with a restrictive one before validating it');
assert.match(bridge,/new RawSecurityDescriptor\("O:SYG:SYD:\(A;;GA;;;SY\)\(A;;GA;;;BA\)\(A;;0x00000004;;;/,'the Broker service ACL must grant the control service only query-status access');
assert.match(bridge,/common\.AccessMask==4.*OMI_BROKER_CONTROL_QUERY_RIGHTS_REFUSED/,'the control-service ACE must not grant service mutation rights');
assert.match(bridge,/QueryServiceObjectSecurity\(service,5,/,'Broker service ACL verification must request both Owner and DACL fields');
assert.match(activatedWix,/<Custom Action="ManagedConfigureBrokerServiceTrust" After="ManagedInstallRollback"/,'Broker service trust must be set after MSI creates the service');
assert.match(activatedWix,/ServiceSid|configure-broker-service/,'the activated package must configure the Broker service SID');
assert.match(activatedWix,/ManagedBrokerOwnerReset[^\r\n]+admin owner-reset/,'uninstall must revoke Broker approvals while the service pipe is still available');
assert.match(activatedWix,/<Custom Action="ManagedBrokerOwnerReset" Before="StopServices"/,'Broker revocation must complete before MSI stops the service');
assert.match(msiBuilder,/build-privileged-broker\.ps1/,'the activated MSI must build Broker from this source tree');
assert.match(msiBuilder, /Join-Path \$installScriptRoot 'build-privileged-broker\.ps1'\) -SourceRoot \$payloadRoot/, 'Broker must compile from the frozen staged payload');
assert.match(msiBuilder,/PrivilegedBroker=\$brokerBuildRoot/,'the activated MSI must bind the fresh Broker binary');
assert.match(msiBuilder,/Ragent\.PrivilegedBroker\.manifest\.json/,'the MSI must carry a product-versioned Broker hash manifest');
assert.match(brokerBuilder,/Privileged Broker output is not a native Windows x64 PE32\+ executable/,'the Broker package helper must validate its Windows PE output');
assert.match(brokerBuilder,/GOOS = 'windows'/,'the Broker package helper must build for Windows');
assert.match(brokerBuilder,/GOARCH = 'amd64'/,'the Broker package helper must build x64 explicitly');
assert.match(activatedWix,/<CustomAction Id="ManagedInjectedPostActivationFailure" BinaryRef="ManagedOwnerMsiBridge" ExeCommand="injected-failure &quot;\[RagentMachineRoot\]\.\&quot;" Execute="deferred" Impersonate="no" Return="check"\s*\/>/);
assert.doesNotMatch(activatedWix,/<CustomAction Id="ManagedInjectedPostActivationFailure" Error=/);
assert.match(activatedWix,/<Custom Action="ManagedInjectedPostUpgradeFailure" After="ManagedUpgradeActivate" Condition="Installed AND REINSTALL/,'fault-injected minor update must fail after activation inside the rollback transaction');
assert.match(activatedWix,/<Custom Action="ManagedInjectedPostRemovalFailure" After="DeleteServices" Condition="Installed AND REMOVE/,'fault-injected uninstall must fail after MSI has tried to delete service registrations');
assert.match(msiBuilder,/TestPostRemovalRollback=\$removalInjection/,'removal fault injection must only be available in an explicit test build');
assert.match(bridge,/args\[0\]=="injected-failure"/);
assert.match(bridge,/OMI_ACTIVATION_HEALTH_REQUIRED/);
assert.match(bridge,/result\.ContainsKey\("healthDiagnostics"\)/);assert.match(bridge,/nodeExecutableMatchesProductRoot/);assert.match(bridge,/serviceLogs/);assert.match(bridge,/lastServiceState/);assert.match(bridge,/ownerActivationCode/);assert.match(bridge,/healthCheckGatePassed/);assert.match(bridge,/nodeProcessQuery/);assert.match(activationCheck,/healthCheckGatePassed=\(\$healthDiagnostics\.httpStatus -eq 200/);assert.match(activationCheck,/nodeProcessQuery/);assert.match(activationCheck,/\[long\]\$_.ProcessId -eq \[long\]\$health.pid/);
assert.match(chatServer,/ownerActivationHealth/);assert.match(chatServer,/ownerActivationSnapshot\.state/);assert.match(chatServer,/ownerActivationSnapshot\.code/);assert.match(chatServer,/writeOwnerActivationHealthz/);assert.match(chatServer,/\/healthz\/owner-activation/);
assert.match(activationCheck,/HttpWebRequest\]::Create\('http:\/\/127\.0\.0\.1:7690\/healthz'\)/);assert.match(activationCheck,/\/healthz\/owner-activation/);assert.match(activationCheck,/\.Proxy=\$null/);assert.match(activationCheck,/Get-OwnerActivationServiceLogSummary/);assert.match(activationCheck,/Read-OwnerActivationHealthBody/);assert.match(activationCheck,/ownerActivationState/);
assert.match(activationTrialSource,/OpenProcess\(0x00100000,false,status\.pid\)/);assert.doesNotMatch(activationTrialSource,/OpenProcess\(0x00100000\s*\|\s*0x1000/);
assert.match(serviceHostSource,/ProcessSynchronize=0x00100000/);assert.match(serviceHostSource,/permissions=ProcessSynchronize,mode=\(int\)GrantAccess,inheritance=0/);assert.match(serviceHostSource,/type=TrusteeTypeUnknown/);assert.match(serviceHostSource,/GrantSystemWaitOnServiceProcess\(\);/);
assert.match(rollbackTest,/actual error code 93/);assert.match(rollbackTest,/AOMR_SESSION_SECRET_NOT_RETAINED/);assert.ok(rollbackTest.includes('Target=injected-failure(?:\\s+"[^"]+")?,'));
for(const [args,code] of [[['remove',missingRoot],'OMI_FIXED_ROOT_REQUIRED'],[['remove-check','--force'],'OMI_ARGUMENTS_REFUSED'],[['ActiveRemove'],'OMI_ARGUMENTS_REFUSED'],[['remove-admission','--skip-verify'],'OMI_ARGUMENTS_REFUSED'],[['activate','--force'],'OMI_ARGUMENTS_REFUSED'],[['activation-check',missingRoot],'OMI_FIXED_ROOT_REQUIRED'],[['activation-check','--skip-signature'],'OMI_ARGUMENTS_REFUSED'],[['fresh','S-1-5-21-1-2-3-1001','C:\\'],'OMI_FIXED_ROOT_REQUIRED'],[['fresh','S-1-5-18'],'OMI_OWNER_SID_REQUIRED'],[['recovery-source-check','S-1-5-18',missingRoot],'OMI_OWNER_SID_REQUIRED'],[['prepare','S-1-5-18'],'OMI_ARGUMENTS_REFUSED'],[['prepare','S-1-5-21-1-2-3-1001','extra'],'OMI_ARGUMENTS_REFUSED'],[['prepare','S-1-5-21-1-2-3-1001" -Action Remove'],'OMI_ARGUMENTS_REFUSED']]){
 try{await exec(exe,args,{windowsHide:true,timeout:15000,maxBuffer:16384});assert.fail('Unsafe invocation accepted');}catch(e){assert.equal(e.code,1);assert.equal(e.stderr.trim(),code);}count++;
}
for(const action of ['prevalidate-stop','prevalidate-rollback','prevalidate-commit']){
 const args=action==='prevalidate-commit'?[action,missingRoot]:[action,'0.0.1.0','a'.repeat(64),missingRoot];
 try{await exec(exe,args,{windowsHide:true,timeout:15000,maxBuffer:16384});assert.fail('Prevalidation action accepted a non-SYSTEM caller');}
 catch(e){assert.equal(e.code,1);assert.equal(e.stderr.trim(),'OMI_FIXED_ROOT_REQUIRED');}count++;
}
try{const result=await exec(exe,['fresh'],{windowsHide:true,timeout:15000,maxBuffer:16384});assert.match(result.stdout,/OMI_FRESH/);}
catch(e){assert.equal(e.code,1);assert.ok(['OMI_EXISTING_SERVICE_REFUSED','OMI_EXISTING_INSTALL_REFUSED','OMI_INPUT_OWNER_REFUSED'].includes(e.stderr.trim()),`Unexpected safe fresh refusal: ${e.stderr.trim()}`);}
count++;
try{await exec(exe,['recovery-relocation-check','S-1-5-18',missingRoot,missingRoot],{windowsHide:true,timeout:15000,maxBuffer:16384});assert.fail('Relocation accepted a non-user owner');}
catch(e){assert.equal(e.code,1);assert.equal(e.stderr.trim(),'OMI_OWNER_SID_REQUIRED');}
count++;
const source=resolve('packaging/windows/managed-owner-msi.ps1').replaceAll("'","''");
const compile=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$s=[IO.File]::ReadAllText('${source}');$m=[regex]::Match($s,"(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@");if(-not $m.Success){throw 'Missing native handle class'};Add-Type -TypeDefinition $m.Groups[1].Value;@{pass=$true;nativePreparedHandlesCompiled=$true}|ConvertTo-Json -Compress`;
// Literal regex escapes remain literal through argv; no shell interpolation.
const fixed=compile.replaceAll('\\\\r','\\r').replaceAll('\\\\n','\\n');
const parsed=JSON.parse((await exec(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(fixed,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:65536})).stdout);assert.equal(parsed.pass,true);
// Dot-sourced parameter attributes/values must not turn the real action into
// an accidental library return, or reject loading the library with no Action.
await exec(ps,['-NoProfile','-NonInteractive','-Command','. ./packaging/windows/managed-owner-msi.ps1 -LibraryOnly; if(-not ("ManagedPreparedService" -as [type])){throw "Library missing"}'],{windowsHide:true,timeout:30000,maxBuffer:16384});
try{await exec(ps,['-NoProfile','-NonInteractive','-File','packaging/windows/managed-owner-msi.ps1','-Action','Prepare','-OwnerSid','S-1-5-21-1-2-3-1001'],{windowsHide:true,timeout:30000,maxBuffer:16384});assert.fail('Installed preparation accepted');}
catch(e){assert.equal(e.code,1);const refusal=JSON.parse(e.stdout);assert.equal(refusal.ok,false);assert.match(refusal.code,/^(OMI|OBD|ODP|OSP)_[A-Z_]+$/);assert.equal(refusal.servicesActivated,false);}
await writeFile(join(root,'verified.json'),JSON.stringify({pass:true,nativeBridgeCompiled:true,nativePreparedHandlesCompiled:true,localRefusals:count,servicesCreated:false,authorityIssued:false},null,2)+'\n');console.log(JSON.stringify({pass:true,nativeBridgeCompiled:true,nativePreparedHandlesCompiled:true,localRefusals:count,servicesCreated:false}));

assert.match(activatedWix, /<WriteRegistryValues Sequence="6450"\s*\/>/, 'public display version must be written after MSI product publication');
assert.match(activatedWix, /Name="DisplayVersion" Type="string" Value="\$\(var\.DisplayVersion\)"/, 'ARP must show the public package version');
assert.match(msiBuilder, /DisplayVersion=\$displayVersion/, 'build passes the public version into WiX');

assert.match(bridge, /static readonly string\[\] BrokerRequiredPrivileges=\{[\s\S]*?"SeAssignPrimaryTokenPrivilege",[\s\S]*?"SeChangeNotifyPrivilege",[\s\S]*?"SeIncreaseQuotaPrivilege",[\s\S]*?"SeTcbPrivilege"[\s\S]*?\}/, 'Broker service must configure the exact four-privilege minimal set');
assert.match(bridge, /ErrorInsufficientBuffer\s*=\s*122/, 'Broker privilege verification must handle ERROR_INSUFFICIENT_BUFFER resize');
assert.match(bridge, /seen\.SetEquals\(BrokerRequiredPrivileges\)[\s\S]*?OMI_BROKER_REQUIRED_PRIVILEGES_REFUSED/, 'Broker privilege verification must enforce exact set equality');
assert.match(upgradeAdmission, /@\(\$token\.privileges\)\.Count -ne 1 -or \$token\.privileges\[0\] -cne 'SeChangeNotifyPrivilege'/, 'ControlPlane and RunnerSupervisor upgrade checks must stay SeChangeNotifyPrivilege-only');

const brokerPrivExe = exe.replaceAll("'", "''");
const brokerPrivScript = `$ErrorActionPreference='Stop';$asm=[Reflection.Assembly]::LoadFrom('${brokerPrivExe}');$t=$asm.GetType('ManagedOwnerMsiBridge',$true);$flags=[Reflection.BindingFlags]'Static,NonPublic,Public';$build=$t.GetMethod('BuildBrokerRequiredPrivilegesMultiSz',$flags);$verify=$t.GetMethod('VerifyBrokerRequiredPrivilegesMultiSz',$flags);$canonical=$build.Invoke($null,$null);if($canonical -cne "SeAssignPrimaryTokenPrivilege\`0SeChangeNotifyPrivilege\`0SeIncreaseQuotaPrivilege\`0SeTcbPrivilege\`0\`0"){throw 'BROKER_PRIV_BUILD_MISMATCH'};function Invoke-Verify([string]$s,[int]$trim=0){$bytes=[Text.Encoding]::Unicode.GetBytes($s);$len=$bytes.Length-$trim;$ptr=[Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max(1,$len));try{if($len -gt 0){[Runtime.InteropServices.Marshal]::Copy($bytes,0,$ptr,$len)};$verify.Invoke($null,@([IntPtr]$ptr,[long]$len))}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)}};Invoke-Verify $canonical;Invoke-Verify "SeTcbPrivilege\`0seassignprimarytokenprivilege\`0SeIncreaseQuotaPrivilege\`0SeChangeNotifyPrivilege\`0\`0";$badCases=@(@{s="SeChangeNotifyPrivilege\`0\`0";t=0},@{s="SeAssignPrimaryTokenPrivilege\`0SeChangeNotifyPrivilege\`0SeIncreaseQuotaPrivilege\`0\`0";t=0},@{s="SeAssignPrimaryTokenPrivilege\`0SeChangeNotifyPrivilege\`0SeIncreaseQuotaPrivilege\`0SeTcbPrivilege\`0SeTcbPrivilege\`0\`0";t=0},@{s="SeAssignPrimaryTokenPrivilege\`0SeChangeNotifyPrivilege\`0SeIncreaseQuotaPrivilege\`0SeTcbPrivilege\`0SeDebugPrivilege\`0\`0";t=0},@{s="SeAssignPrimaryTokenPrivilege\`0SeChangeNotifyPrivilege\`0SeIncreaseQuotaPrivilege\`0SeTcbPrivilege\`0SeImpersonatePrivilege\`0\`0";t=0},@{s="\`0\`0";t=0},@{s="SeAssignPrimaryTokenPrivilege\`0SeChangeNotifyPrivilege\`0SeIncreaseQuotaPrivilege\`0SeTcbPrivilege\`0";t=0},@{s=$canonical;t=2});foreach($c in $badCases){$threw=$false;try{Invoke-Verify $c.s $c.t}catch{$threw=($_.Exception.InnerException.Message -ceq 'OMI_BROKER_REQUIRED_PRIVILEGES_REFUSED')};if(-not $threw){throw ('BROKER_PRIV_CASE_ACCEPTED:'+$c.s)}};$nullThrew=$false;try{$verify.Invoke($null,@([IntPtr]::Zero,[long]16))}catch{$nullThrew=($_.Exception.InnerException.Message -ceq 'OMI_BROKER_REQUIRED_PRIVILEGES_REFUSED')};if(-not $nullThrew){throw 'BROKER_PRIV_NULL_ACCEPTED'};@{brokerPrivilegeSetVerified=$true}|ConvertTo-Json -Compress`;
const brokerPrivOut = JSON.parse((await exec(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(brokerPrivScript, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000, maxBuffer: 65536 })).stdout);
assert.equal(brokerPrivOut.brokerPrivilegeSetVerified, true);
