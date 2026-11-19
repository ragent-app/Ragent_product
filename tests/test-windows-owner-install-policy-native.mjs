import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
assert.equal(process.platform,'win32','Actual NTFS test: run only on Windows.');
const exec=promisify(execFile),root=await mkdtemp(join(await realpath(tmpdir()),'agct-opi-'));
await writeFile(join(root,'qa-instance.json'),JSON.stringify({testOnly:true,purpose:'owner-install-policy',pid:process.pid}));
const powershell='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const pwsh=(await exec('where.exe',['pwsh.exe'],{windowsHide:true,timeout:10000,maxBuffer:4096})).stdout.split(/\r?\n/)[0].trim();
assert.ok(pwsh,'PowerShell 7 must be available for cross-shell integer compatibility regression');
try{
  const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-File','tests/windows-owner-install-policy-native.ps1','-EvidenceRoot',root],{windowsHide:true,timeout:25000,maxBuffer:1024*1024,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});
  const report=JSON.parse(stdout.replace(/^\uFEFF/,''));assert.equal(report.pass,true);assert.equal(report.checks.length,30);assert.ok(report.checks.every(c=>c.pass));
  const policySource=join(process.cwd(),'packaging/windows/prepare-owner-install-policy.ps1').replaceAll("'","''");
  const crossShellScript=`$ErrorActionPreference='Stop'
. '${policySource}' -LibraryOnly
$results=[Collections.Generic.List[object]]::new()
function Assert-Bool([string]$Name,[bool]$Condition){if(-not $Condition){throw ('Cross-shell check failed: '+$Name)};$results.Add(@{name=$Name;pass=$true})}
function Assert-PolicyRefused([string]$Name,[string]$Json){
  $obj=$Json|ConvertFrom-Json
  $code='';try{Assert-OwnerInstallPolicy $obj}catch{$code=$_.Exception.GetBaseException().Message}
  Assert-Bool $Name ($code -ceq 'OIP_POLICY_INVALID')
}
$sample='{"one":1,"port":7690,"maxInt32":2147483647,"zero":0,"overflow":2147483648,"neg":-1,"str":"1","flt":1.0,"boolTrue":true,"boolFalse":false,"nil":null}'|ConvertFrom-Json
if($PSVersionTable.PSVersion.Major -ge 7){Assert-Bool 'pwsh7-convertfrom-json-emits-int64' ($sample.one -is [long])}
else{Assert-Bool 'ps51-convertfrom-json-emits-int32' ($sample.one -is [int])}
Assert-Bool 'json-int-one-in-range' (Test-OwnerJsonInteger $sample.one 1 1)
Assert-Bool 'json-int-port-in-range' (Test-OwnerJsonInteger $sample.port 7690 7690)
Assert-Bool 'json-int-maxint32-in-range' (Test-OwnerJsonInteger $sample.maxInt32 1)
Assert-Bool 'json-int-zero-in-zero-range' (Test-OwnerJsonInteger $sample.zero 0 0)
Assert-Bool 'clr-int32-accepted' (Test-OwnerJsonInteger ([int]1) 1 1)
Assert-Bool 'clr-int64-accepted' (Test-OwnerJsonInteger ([long]1) 1 1)
Assert-Bool 'json-int-overflow-int32-refused' (-not (Test-OwnerJsonInteger $sample.overflow))
Assert-Bool 'json-int-overflow-pid-refused' (-not (Test-OwnerJsonInteger $sample.overflow 1))
Assert-Bool 'clr-int64-underflow-int32-refused' (-not (Test-OwnerJsonInteger ([int64]([int32]::MinValue)-1L)))
Assert-Bool 'json-int-zero-pid-refused' (-not (Test-OwnerJsonInteger $sample.zero 1))
Assert-Bool 'json-int-negative-pid-refused' (-not (Test-OwnerJsonInteger $sample.neg 1))
Assert-Bool 'json-string-refused' (-not (Test-OwnerJsonInteger $sample.str 1 1))
Assert-Bool 'json-float-refused' (-not (Test-OwnerJsonInteger $sample.flt 1 1))
Assert-Bool 'json-bool-true-refused' (-not (Test-OwnerJsonInteger $sample.boolTrue 0 1))
Assert-Bool 'json-bool-false-refused' (-not (Test-OwnerJsonInteger $sample.boolFalse 0 1))
Assert-Bool 'json-null-refused' (-not (Test-OwnerJsonInteger $sample.nil))
Assert-Bool 'json-array-refused' (-not (Test-OwnerJsonInteger @($sample.one) 1 1))
$validJson='{"version":1,"instanceId":"inst_'+('a'*32)+'","controlSid":"S-1-5-80-1-2-3-4-5","executorSid":"S-1-5-80-6-7-8-9-10","ownerSid":"S-1-5-21-1-2-3-1001","port":7690}'
$validPolicy=$validJson|ConvertFrom-Json
Assert-OwnerInstallPolicy $validPolicy
Assert-Bool 'valid-json-policy-accepted' $true
foreach($bad in @(
  @('version-string',$validJson.Replace('"version":1','"version":"1"')),
  @('version-float',$validJson.Replace('"version":1','"version":1.0')),
  @('version-bool',$validJson.Replace('"version":1','"version":true')),
  @('version-zero',$validJson.Replace('"version":1','"version":0')),
  @('version-negative',$validJson.Replace('"version":1','"version":-1')),
  @('version-overflow',$validJson.Replace('"version":1','"version":2147483648')),
  @('port-string',$validJson.Replace('"port":7690','"port":"7690"')),
  @('port-float',$validJson.Replace('"port":7690','"port":7690.0')),
  @('port-bool',$validJson.Replace('"port":7690','"port":true')),
  @('port-zero',$validJson.Replace('"port":7690','"port":0')),
  @('port-negative',$validJson.Replace('"port":7690','"port":-1')),
  @('port-overflow',$validJson.Replace('"port":7690','"port":2147483648'))
)){Assert-PolicyRefused $bad[0] $bad[1]}
@{psVersion=$PSVersionTable.PSVersion.ToString();checks=@($results)}|ConvertTo-Json -Depth 4 -Compress`;
  const encodedCrossShell=Buffer.from(crossShellScript,'utf16le').toString('base64');
  report.crossShellChecks=[];
  for(const [shellName,shellExe] of [['powershell-5.1',powershell],['pwsh-7',pwsh]]){
    const {stdout:crossOut}=await exec(shellExe,['-NoProfile','-NonInteractive','-EncodedCommand',encodedCrossShell],{windowsHide:true,timeout:25000,maxBuffer:1024*1024,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});
    const parsed=JSON.parse(crossOut.replace(/^\uFEFF/,''));
    assert.ok(parsed.checks.length>=25 && parsed.checks.every(c=>c.pass),`${shellName} cross-shell integer checks failed`);
    report.crossShellChecks.push({shell:shellName,psVersion:parsed.psVersion,count:parsed.checks.length});
  }
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({pass:false,exitCode:error.code,stdout:error.stdout||'',stderr:error.stderr||'',message:error.message},null,2));console.error('NATIVE_POLICY_FAIL '+root);throw error;}
