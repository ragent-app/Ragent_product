// Actual local refusal and pure plan/native compilation; no SCM mutation.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
assert.equal(process.platform,'win32');
const exec=promisify(execFile), ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const file=resolve('packaging/windows/prepare-owner-services.ps1');
const command=`. '${file.replaceAll("'","''")}' -LibraryOnly; Initialize-OwnerServiceRegistrationType; @(Get-OwnerServicePreparationPlan)|ConvertTo-Json -Depth 5 -Compress`;
const {stdout}=await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:60000,maxBuffer:65536});
const plan=JSON.parse(stdout.replace(/^\uFEFF/,''));assert.equal(plan.length,2);
assert.deepEqual(plan.map(r=>r.name),['Ragent-RunnerSupervisor','Ragent-ControlPlane']);
for(const row of plan){assert.equal(row.account,'NT SERVICE\\'+row.name);assert.equal(row.startMode,'Disabled');assert.ok(row.command.startsWith('"C:\\Program Files\\Ragent\\Ragent.ServiceHost.exe"'));assert.ok(row.command.includes('--instance-root "C:\\ProgramData\\Ragent\\instances\\owner"'));assert.ok(row.command.includes('--config-dir "C:\\ProgramData\\Ragent\\instances\\owner\\'+(row.role==='control'?'':'executor\\')+'config"'));}
assert.deepEqual(plan[0].dependencies,[]);assert.deepEqual(plan[1].dependencies,['Ragent-RunnerSupervisor']);
const sidProbe=`. '${file.replaceAll("'","''")}' -LibraryOnly; $observed=[Security.Principal.NTAccount]::new('NT SERVICE','TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value;@{allowed=@(Get-OwnerAdministrativeSids);resolved=$observed}|ConvertTo-Json -Compress`;
const sids=JSON.parse((await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',sidProbe],{windowsHide:true,timeout:60000,maxBuffer:65536})).stdout);
assert.deepEqual(sids.allowed,['S-1-5-18','S-1-5-32-544',sids.resolved]);
const scope=await mkdtemp(join(tmpdir(),'agct-owner-service-presence-'));
await writeFile(join(scope,'file'),'SYNTHETIC-PUBLIC-METADATA-ONLY');
const literal=scope.replaceAll("'","''");
const presence=`. '${file.replaceAll("'","''")}' -LibraryOnly; $r='${literal}'; $code=$null;try{Test-OwnerServicePreparationPresence (Join-Path $r 'file/child')|Out-Null}catch{$code=$_.Exception.GetBaseException().Message};@{directory=(Test-OwnerServicePreparationPresence $r);file=(Test-OwnerServicePreparationPresence (Join-Path $r 'file'));missing=(Test-OwnerServicePreparationPresence (Join-Path $r 'missing'));ancestorError=$code}|ConvertTo-Json -Compress`;
const state=JSON.parse((await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',presence],{windowsHide:true,timeout:60000,maxBuffer:65536})).stdout);
assert.deepEqual(state,{directory:true,file:true,missing:false,ancestorError:'OSP_PATH_UNSAFE'});
// This workspace has an existing installed product. Default AND explicit Commit
// must refuse at the same first SCM gate before opening files or taking a lock.
for(const args of [[],['-Commit']]){
  let observed;try{await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-File',file,...args],{windowsHide:true,timeout:60000,maxBuffer:65536});assert.fail('Existing service adopted');}
  catch(error){assert.equal(error.code,1);observed=JSON.parse(error.stdout.replace(/^\uFEFF/,''));}
  assert.equal(observed.code,'OSP_EXISTING_SERVICE_REFUSED');assert.equal(observed.lockRetained,false);assert.equal(observed.servicesActivated,false);
}
console.log(JSON.stringify({pass:true,nativeCompiled:true,readOnlyPlan:true,presenceCases:4,existingServiceRefusals:2,servicesCreated:false,presenceFixture:scope}));
