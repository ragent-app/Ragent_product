import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,copyFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

assert.equal(process.platform,'win32');
const exec=promisify(execFile), root=await mkdtemp(join(await realpath(tmpdir()),'agentoc-uninstall-desktop-'));
const ownDir=join(root,'installed'),otherDir=join(root,'other'),own=join(ownDir,'Ragent.exe'),other=join(otherDir,'Ragent.exe');
const csc='C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',runner=join(root,'shutdown-fixture.exe');
let owned,unrelated;
try{
  await mkdir(ownDir);await mkdir(otherDir);
  await exec(csc,['/nologo','/target:exe','/platform:x64',`/out:${own}`,resolve('tests/fixtures/windows-desktop-hold.cs')],{windowsHide:true});
  await copyFile(own,other);
  await exec(csc,['/nologo','/target:exe','/platform:x64','/main:DesktopShutdownFixture',
    '/r:System.Management.dll','/r:System.ServiceProcess.dll','/r:System.Security.dll','/r:System.Web.Extensions.dll',`/out:${runner}`,
    resolve('packaging/windows/managed-owner-msi-bridge.cs'),resolve('packaging/windows/AgentoC.ServiceHost.cs'),
    resolve('packaging/windows/owner-service-activation-trial.cs'),resolve('packaging/windows/owner-msi-relocation-journal.cs'),
    resolve('tests/fixtures/windows-desktop-shutdown.cs')],{windowsHide:true});
  owned=spawn(own,[],{windowsHide:true});unrelated=spawn(other,[],{windowsHide:true});
  await Promise.all([owned,unrelated].map(child=>new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}))); 
  assert.equal(owned.exitCode,null);assert.equal(unrelated.exitCode,null);
  const exited=new Promise(resolve=>owned.once('exit',resolve));
  await exec(runner,[own],{windowsHide:true,timeout:15000});
  await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('target did not exit')),5000))]);
  assert.notEqual(owned.exitCode,null,'the selected desktop process must exit');
  assert.equal(unrelated.exitCode,null,'a same-named process in another directory must remain running');
  console.log('uninstall desktop shutdown: selected process stopped; same-name unrelated process preserved');
}finally{
  for(const child of [owned,unrelated])if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
