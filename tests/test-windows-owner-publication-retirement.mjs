import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,unlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createOwnerDiscoveryController,createOwnerDiscoveryFileStore} from '../lib/windows-owner-discovery-publication.mjs';
test('blocked endpoint close withdraws before timeout and prevents a replacement until stop confirms',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'ragent-owner-retire-')),filePath=join(root,'live.json');
  const instanceId=randomUUID(),controlSid='S-1-5-80-1-2-3-4-5',ownerSid='S-1-5-21-1-2-3-1001';
  const releaseJson=JSON.stringify({version:1,protocolVersion:1,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)}),
    installationJson=JSON.stringify({version:1,instanceId,controlSid,executorSid:'S-1-5-80-6-7-8-9-10',ownerSid,port:7690});
  const policy={pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId,requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+20000,controlSid,ownerSid,ownerSessionId:1};
  let finish,served=0;const drain=new Promise(done=>{finish=done;}),completion=new Promise(()=>{});
  const controller=await createOwnerDiscoveryController({releaseJson,installationJson,store:createOwnerDiscoveryFileStore({filePath}),issueOwnerSession:async()=>'',revokeOwnerSession:async()=>{},
    serveEndpoint:async()=>{served++;return {ready:{facts:{pid:1234,createdTicks:'134368500000000000',sid:controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false},protectedDacl:true,firstInstance:true,rejectRemote:true},completion,close:()=>drain};}});
  try{
    await controller.start(policy);const closing=controller.close();await assert.rejects(closing,{code:'OBP_CLOSE_UNCONFIRMED'});
    await assert.rejects(readFile(filePath),{code:'ENOENT'});assert.ok((await lstat(filePath+'.publisher-lock')).isFile());
    await assert.rejects(controller.start({...policy,requestId:'e'.repeat(32)}),{code:'OBP_ALREADY_STARTED'});assert.equal(served,1);
  }finally{finish();await controller.close();await rm(root,{recursive:true,force:true});}
});
test('actual publisher process death leaves an unadoptable lock; no PID-based crash reclaim',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'ragent-owner-cold-')),filePath=join(root,'live.json');
  const url=new URL('../lib/windows-owner-discovery-publication.mjs',import.meta.url).href;
  const code=`const {createOwnerDiscoveryFileStore}=await import(${JSON.stringify(url)});await createOwnerDiscoveryFileStore({filePath:${JSON.stringify(filePath)}}).acquire();process.stdout.write('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  const exited=new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);}),timer=setTimeout(()=>child.kill(),5000);
  try{
    await new Promise((done,reject)=>{child.stdout.once('data',bytes=>{try{assert.equal(bytes.toString(),'ready');done();}catch(error){reject(error);}});child.once('close',()=>reject(new Error('Child ended before ready')));});
    child.kill();await exited;await assert.rejects(createOwnerDiscoveryFileStore({filePath}).acquire(),{code:'OBP_ALREADY_OWNED'});
    assert.ok((await lstat(filePath+'.publisher-lock')).isFile());
    // Exact test-owned lock cleanup after the child exit; product has no reaper.
    await unlink(filePath+'.publisher-lock');
  }finally{clearTimeout(timer);child.kill();await exited;await rm(root,{recursive:true,force:true});}
});
