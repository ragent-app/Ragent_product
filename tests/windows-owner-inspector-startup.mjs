// Diagnose the shipped read-only inspector in a disposable hosted OS. Fixed
// paths remain absent: no installation, service, policy or helper substitution.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
const exec=promisify(execFile),ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',script=resolve('packaging/windows/read-owner-service-trust.ps1'),out=join(process.env.RUNNER_TEMP,'owner-inspector-startup');
for(const p of ['C:/Program Files/Ragent','C:/ProgramData/Ragent'])await assert.rejects(access(p),{code:'ENOENT'});
await mkdir(out);const report={runId:process.env.GITHUB_RUN_ID,productionTouched:false,installationPerformed:false,scriptSha256:createHash('sha256').update(await readFile(script)).digest('hex'),cases:[]};
for(const [name,args]of process.argv.includes('--installed-entry')?[]:[['default',['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-ActivationListener']],['process-policy-explicit',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-ActivationListener']],['policy-list',['-NoLogo','-NoProfile','-NonInteractive','-Command','Get-ExecutionPolicy -List|ConvertTo-Json -Compress']]]){
 const started=Date.now();let r;try{r={exitCode:0,...await exec(ps,args,{windowsHide:true,timeout:60000,maxBuffer:65536,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}})};}catch(e){r={exitCode:e.code,killed:e.killed,signal:e.signal,stdout:e.stdout||'',stderr:e.stderr||''};}
 const item={name,elapsedMs:Date.now()-started,...r};report.cases.push(item);console.log(JSON.stringify(item));await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
if(process.argv.includes('--installed-entry')){
 const {inspectInstalledOwnerActivationService}=await import('../lib/windows-owner-service-trust.mjs');
 const {inspectInstalledOwnerActivation}=await import('../lib/windows-owner-activation-trust.mjs');
 const {inspectInstalledOwnerBootstrap,OWNER_INSPECTION_TIMEOUT_MS}=await import('../lib/windows-owner-discovery.mjs');assert.equal(OWNER_INSPECTION_TIMEOUT_MS,60000);
 const calls=[['service-listener',()=>inspectInstalledOwnerActivationService({instanceRoot:'C:/ProgramData/Ragent/instances/owner',instanceId:'inst_'+'a'.repeat(32),host:'127.0.0.1',port:7690})],['activation-client',()=>inspectInstalledOwnerActivation()],['cli-discovery',()=>inspectInstalledOwnerBootstrap()]];
 for(const [name,call]of calls){const started=Date.now();let code;try{await call();assert.fail('Missing installed trust admitted');}catch(e){code=e.code;}assert.equal(code,'OBD_RELEASE_NOT_INSTALLED');report.cases.push({name,elapsedMs:Date.now()-started,code,authorityIssued:false});console.log(JSON.stringify(report.cases.at(-1)));await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
 report.pass=true;report.originalAuthorityDeadlinesUnchanged=true;await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
