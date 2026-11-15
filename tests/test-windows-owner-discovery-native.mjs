// Actual OS signature, file-handle and ACL tests. No elevation/services/credentials.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,realpath,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
if(process.platform!=='win32')throw new Error('Explicit Windows native QA only');
const exec=promisify(execFile),root=await mkdtemp(join(await realpath(tmpdir()),'ragent-owner-trust-')),source=resolve('.');
const q=value=>"'"+value.replaceAll("'","''")+"'";
const evidence=resolve(process.env.RAGENT_OWNER_DISCOVERY_QA_EVIDENCE_DIR||join(source,'artifacts/showcase/T2-current-20261017/owner-discovery'));await mkdir(evidence,{recursive:true});
const report={pass:false,readOnlyProduction:true,servicesCreated:false,sessionIssued:false,checks:[]};
async function ps(code){let stdout;try{({stdout}=await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:65536,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows',TEMP:root,TMP:root}}));return JSON.parse(stdout.replace(/^\uFEFF/,''));}
  catch(error){await writeFile(join(evidence,'native-failure.log'),String(error.stdout||'')+'\n'+String(error.stderr||error.message));throw new Error('Native Owner discovery QA failed; see retained native-failure.log');}}
try{
  const result=await ps(`$ErrorActionPreference='Stop';. ${q(join(source,'packaging/windows/read-owner-bootstrap-discovery.ps1'))} -LibraryOnly
$qaRoot=${q(root)};$qaFile=Join-Path $qaRoot 'metadata.json';[IO.File]::WriteAllText($qaFile,'{"synthetic":true}')
$qaSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$qaAllowed=@($qaSid,'S-1-5-18','S-1-5-32-544',([Security.Principal.NTAccount]::new('NT SERVICE','TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value)
$qaChecks=@();$qaPins=[Collections.Generic.List[IDisposable]]::new()
$qaManifestJson='{"version":2,"protocolVersion":2,"helperFile":"Ragent.OwnerBootstrap.exe","helperSha256":"'+'a'*64+'","trustMode":"admin-installed-sha256"}'
$qaManifest=$qaManifestJson|ConvertFrom-Json;$qaManifestCode='';try{Assert-OwnerReleaseManifest $qaManifest}catch{$qaManifestCode=$_.Exception.Message}
$qaFloatManifest=($qaManifestJson.Replace('"version":2,','"version":2.0,'))|ConvertFrom-Json;$qaFloatCode='';try{Assert-OwnerReleaseManifest $qaFloatManifest}catch{$qaFloatCode=$_.Exception.Message}
$qaChecks+=@{name='json-integer-manifest-accepted-but-fractional-number-refused';pass=(($qaManifest.version -is [int] -or $qaManifest.version -is [long]) -and -not $qaManifestCode -and ($qaFloatManifest.version -is [double] -or $qaFloatManifest.version -is [decimal]) -and $qaFloatCode -ceq 'OBD_RELEASE_MISMATCH')}
$qaChecks+=@{name='fixed-cli-purpose-path';pass=((Get-OwnerBootstrapLivePath 'cli').Replace([char]92,[char]47) -ceq 'C:/ProgramData/Ragent/instances/owner/runtime/owner-bootstrap-cli-live.json')}
$qaChecks+=@{name='fixed-browser-purpose-path';pass=((Get-OwnerBootstrapLivePath 'browser').Replace([char]92,[char]47) -ceq 'C:/ProgramData/Ragent/instances/owner/runtime/owner-bootstrap-browser-live.json')}
$qaPurposeDenied=$true;foreach($qaBadPurpose in @('legacy','CLI','../cli','C:/override')){try{$null=Get-OwnerBootstrapLivePath $qaBadPurpose;$qaPurposeDenied=$false}catch{if($_.Exception.Message -cne 'OBD_PURPOSE_INVALID'){$qaPurposeDenied=$false}}}
$qaChecks+=@{name='unknown-and-path-purpose-refused';pass=$qaPurposeDenied}
try{$qaPins.Add([RagentOwnerFilePin]::Directory($qaRoot));$qaStream=[IO.FileStream]::new($qaFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$qaPins.Add($qaStream)
 [RagentOwnerFilePin]::Verify($qaStream.SafeFileHandle,$qaFile,$false);$qaChecks+=@{name='actual-file-and-directory-handle-pins';pass=$true}
 $qaDenied=$false;try{[IO.File]::Move($qaFile,(Join-Path $qaRoot 'moved.json'))}catch{$qaDenied=$true};$qaChecks+=@{name='actual-delete-sharing-denied-while-pinned';pass=$qaDenied}
}finally{for($qaI=$qaPins.Count-1;$qaI -ge 0;$qaI--){$qaPins[$qaI].Dispose()}}
$qaRejectedPins=[Collections.Generic.List[IDisposable]]::new();$qaCode=''
try{$null=Read-OwnerPinnedFile $qaFile @('S-1-5-18','S-1-5-32-544') $qaRejectedPins}catch{$qaCode=$_.Exception.Message}
finally{for($qaI=$qaRejectedPins.Count-1;$qaI -ge 0;$qaI--){$qaRejectedPins[$qaI].Dispose()}}
$qaChecks+=@{name='actual-full-reader-rejects-untrusted-test-namespace';pass=($qaCode -in @('OBD_OBJECT_OWNER_UNTRUSTED','OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY'))}
$qaAcl=Get-Acl -LiteralPath $qaFile;$qaAce=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Allow)
$qaAcl.AddAccessRule($qaAce);Set-Acl -LiteralPath $qaFile -AclObject $qaAcl
$qaCode='';try{Assert-OwnerObjectAcl $qaFile $qaAllowed}catch{$qaCode=$_.Exception.Message};$qaChecks+=@{name='actual-foreign-write-ace-denied';pass=($qaCode -ceq 'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY')}
$qaAcl.RemoveAccessRuleSpecific($qaAce);Set-Acl -LiteralPath $qaFile -AclObject $qaAcl
$qaUnknown=[Security.Principal.SecurityIdentifier]::new('S-1-5-21-1111111111-2222222222-3333333333-424242')
$qaUnknownAce=[Security.AccessControl.FileSystemAccessRule]::new($qaUnknown,[Security.AccessControl.FileSystemRights]::WriteData,[Security.AccessControl.AccessControlType]::Allow)
$qaAcl.AddAccessRule($qaUnknownAce);Set-Acl -LiteralPath $qaFile -AclObject $qaAcl
$qaCode='';try{Assert-OwnerObjectAcl $qaFile $qaAllowed}catch{$qaCode=$_.Exception.Message};$qaChecks+=@{name='actual-unmapped-sid-write-ace-denied';pass=($qaCode -ceq 'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY')}
$qaAcl.RemoveAccessRuleSpecific($qaUnknownAce);Set-Acl -LiteralPath $qaFile -AclObject $qaAcl
$qaCode='';try{Assert-OwnerObjectAcl $qaFile @('S-1-5-18','S-1-5-32-544')}catch{$qaCode=$_.Exception.Message};$qaChecks+=@{name='actual-ordinary-owner-denied';pass=($qaCode -ceq 'OBD_OBJECT_OWNER_UNTRUSTED')}
$qaLink=Join-Path $qaRoot 'hardlink.json';New-Item -ItemType HardLink -Path $qaLink -Target $qaFile|Out-Null
$qaStream=[IO.FileStream]::new($qaFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$qaDenied=$false
try{[RagentOwnerFilePin]::Verify($qaStream.SafeFileHandle,$qaFile,$false)}catch{$qaDenied=$true}finally{$qaStream.Dispose()};$qaChecks+=@{name='actual-hardlink-denied';pass=$qaDenied}
$qaJunction=Join-Path $qaRoot 'junction';New-Item -ItemType Junction -Path $qaJunction -Target $qaRoot|Out-Null
$qaDenied=$false;try{$qaHandle=[RagentOwnerFilePin]::Directory($qaJunction);$qaHandle.Dispose()}catch{$qaDenied=$true};$qaChecks+=@{name='actual-reparse-directory-denied';pass=$qaDenied}
$qaSigner=Get-OwnerSigner 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';$qaChecks+=@{name='actual-os-signed-file-signature';pass=($qaSigner.status -ceq 'Valid' -and $qaSigner.publisherSha256 -cmatch '^[a-f0-9]{64}$');status=$qaSigner.status}
$qaChecks|ConvertTo-Json -Compress`);
  for(const check of result){report.checks.push(check);assert.equal(check.pass,true,check.name);}
  const payload=join(root,'payload');await mkdir(payload);
  const staged=await ps(`$ErrorActionPreference='Stop';& ${q(join(source,'packaging/windows/stage-owner-bootstrap.ps1'))} -SourceRoot ${q(source)} -PayloadRoot ${q(payload)}`);
  assert.equal(staged.pass,true);assert.equal(staged.signed,false);assert.equal(staged.trustManifestWritten,true);
  const manifest=JSON.parse(await readFile(join(payload,'owner-bootstrap-release.json')));
  assert.deepEqual(manifest,{version:2,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:staged.helperSha256,trustMode:'admin-installed-sha256'});
  report.checks.push({name:'actual-unsigned-compile-explicit-administrative-trust-manifest',pass:true,helperSha256:staged.helperSha256});
  const refused=join(root,'refused');await mkdir(refused);
  const bad=await ps(`$ErrorActionPreference='Stop';$qaDenied=$false;try{& ${q(join(source,'packaging/windows/stage-owner-bootstrap.ps1'))} -SourceRoot ${q(source)} -PayloadRoot ${q(refused)} -SignedHelperPath ${q(join(payload,'Ragent.OwnerBootstrap.exe'))} -PublisherSha256 '${'0'.repeat(64)}'}catch{$qaDenied=$true};@{denied=$qaDenied;helperRetained=(Test-Path -LiteralPath ${q(join(refused,'Ragent.OwnerBootstrap.exe'))});manifestRetained=(Test-Path -LiteralPath ${q(join(refused,'owner-bootstrap-release.json'))})}|ConvertTo-Json -Compress`);
  assert.deepEqual(bad,{denied:true,helperRetained:false,manifestRetained:false});report.checks.push({name:'actual-unsigned-signed-input-refused-and-cleaned',pass:true});
  const wrongPublisher=join(root,'wrong-publisher');await mkdir(wrongPublisher);
  const wrong=await ps(`$ErrorActionPreference='Stop';$qaDenied=$false;try{& ${q(join(source,'packaging/windows/stage-owner-bootstrap.ps1'))} -SourceRoot ${q(source)} -PayloadRoot ${q(wrongPublisher)} -SignedHelperPath 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -PublisherSha256 '${'0'.repeat(64)}'}catch{$qaDenied=$true};@{denied=$qaDenied;helperRetained=(Test-Path -LiteralPath ${q(join(wrongPublisher,'Ragent.OwnerBootstrap.exe'))});manifestRetained=(Test-Path -LiteralPath ${q(join(wrongPublisher,'owner-bootstrap-release.json'))})}|ConvertTo-Json -Compress`);
  assert.deepEqual(wrong,{denied:true,helperRetained:false,manifestRetained:false});report.checks.push({name:'actual-valid-os-signed-wrong-publisher-refused-and-cleaned',pass:true});
  report.pass=true;
}finally{
  const actual=await realpath(root);assert.equal(dirname(actual).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(actual).startsWith('ragent-owner-trust-'));
  // Remove the exact verified junction before recursive cleanup; never follow it.
  const junction=join(actual,'junction');await rm(junction,{force:true});await rm(actual,{recursive:true,force:true});
  report.sourceHashes=await Promise.all(['lib/windows-owner-discovery.mjs','packaging/windows/read-owner-bootstrap-discovery.ps1','packaging/windows/stage-owner-bootstrap.ps1','tests/test-windows-owner-discovery-native.mjs'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(join(source,path))).digest('hex')})));
  await writeFile(join(evidence,'native.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({pass:report.pass,actualChecks:report.checks.length}));
