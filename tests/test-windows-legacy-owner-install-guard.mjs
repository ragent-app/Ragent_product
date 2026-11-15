import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
assert.equal(process.platform,'win32');
const exec=promisify(execFile),ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',hash=b=>createHash('sha256').update(b).digest('hex');
const root=await mkdtemp(join(tmpdir(),'agct-legacy-guard-'));
await writeFile(join(root,'qa-instance.json'),JSON.stringify({testOnly:true,purpose:'legacy-owner-install-guard',pid:process.pid}));
const report={pass:false,root,cases:[],actualMsiInstallation:false,productionMutation:false};
const sources=['packaging/windows/legacy-owner-install-guard.cs','packaging/windows/assert-legacy-owner-install.ps1','packaging/windows/build-legacy-owner-install-guard.ps1','packaging/windows/install-ragent.ps1','packaging/windows/build-msi.ps1','tests/fixtures/windows-legacy-owner-install-guard.cs','tests/windows-legacy-owner-install-guard.ps1'];
const fingerprints=async()=>Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(p))])));
const production=async()=>JSON.parse((await exec(ps,['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Service -Filter "Name='Ragent-ControlPlane' OR Name='Ragent-RunnerSupervisor'" | Sort-Object Name | Select-Object Name,State,StartName,ProcessId | ConvertTo-Json -Compress`],{windowsHide:true,timeout:15000})).stdout||'null');
const call=async(name,file,args,expectedCode,expectedText)=>{
  let result;try{result={code:0,...await exec(file,args,{windowsHide:true,timeout:30000,maxBuffer:1024*1024})};}catch(error){result={code:error.code,stdout:error.stdout||'',stderr:error.stderr||String(error)};}
  await writeFile(join(root,name+'.log'),result.stdout+'\nSTDERR\n'+result.stderr);
  assert.equal(result.code,expectedCode,name);if(expectedText)assert.match(result.stdout+result.stderr,expectedText,name);report.cases.push({name,pass:true,exitCode:result.code});return result.stdout;
};
try{
  report.sourceBefore=await fingerprints();report.before=await production();const native=await call('native',ps,['-NoProfile','-NonInteractive','-File','tests/windows-legacy-owner-install-guard.ps1','-EvidenceRoot',root],0,/"pass":true/);report.native=JSON.parse(native.replace(/^\uFEFF/,''));
  // Current installed legacy context is only inspected, never installed/stopped.
  await call('actual-installed-readonly',join(root,'Ragent.LegacyOwnerInstallGuard.exe'),[],0,/OLG_LEGACY_COMPATIBLE/);
  await call('native-arguments-refused',join(root,'Ragent.LegacyOwnerInstallGuard.exe'),['--root',root],1,/OLG_ARGUMENTS_REFUSED/);
  await call('shared-powershell-readonly',ps,['-NoProfile','-NonInteractive','-File','packaging/windows/assert-legacy-owner-install.ps1'],0);
  const incoming=join(root,'incoming');await mkdir(incoming);const marker=join(incoming,'owner-bootstrap-release.json');await writeFile(marker,'INTENTIONALLY-INVALID-JSON-NO-CREDENTIAL');const before=hash(await readFile(marker));
  for(const action of ['Install','Upgrade','Repair','Uninstall'])await call('entry-'+action,ps,['-NoProfile','-NonInteractive','-File','packaging/windows/install-ragent.ps1','-PackageRoot',incoming,'-Action',action,...action==='Uninstall'?['-PurgeData']:[]],1,/OLG_SIGNED_INSTALLER_REQUIRED/);
  const output=join(root,'existing-output.msi');await writeFile(output,'UNCHANGED-CANARY');const outputBefore=hash(await readFile(output));
  for(const [name,args]of [['helper',['-SignedOwnerBootstrapPath',marker]],['publisher',['-OwnerBootstrapPublisherSha256','a'.repeat(64)]],['both',['-SignedOwnerBootstrapPath',marker,'-OwnerBootstrapPublisherSha256','a'.repeat(64)]]])await call('build-refusal-'+name,ps,['-NoProfile','-NonInteractive','-File','packaging/windows/build-msi.ps1','-SourceRoot',join(root,'missing-source'),'-OutputPath',output,...args],1,/OLG_SIGNED_INSTALLER_REQUIRED/);
  assert.equal(hash(await readFile(marker)),before);assert.equal(hash(await readFile(output)),outputBefore);report.after=await production();assert.deepEqual(report.before,report.after);report.sourceAfter=await fingerprints();assert.deepEqual(report.sourceBefore,report.sourceAfter);report.pass=true;
}catch(error){report.error={message:error.message};throw error;}
finally{await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,root,nativeChecks:report.native?.nativeChecks,cases:report.cases.length}));}
