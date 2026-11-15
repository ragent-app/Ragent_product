import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,readFile,writeFile,unlink,lstat,rm,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createOwnerDiscoveryController,createOwnerDiscoveryFileStore,ownerDiscoveryDescriptor} from '../lib/windows-owner-discovery-publication.mjs';
import {validateOwnerDiscoveryEvidence} from '../lib/windows-owner-discovery.mjs';
test('missing owner publication path fails before creating a lock',()=>{
  assert.throws(()=>createOwnerDiscoveryFileStore({filePath:''}),{code:'OBP_PATH_INVALID'});
});
function configuration(){const controlSid='S-1-5-80-1-2-3-4-5',ownerSid='S-1-5-21-1-2-3-1001',instanceId=randomUUID();
  const releaseJson=JSON.stringify({version:1,protocolVersion:1,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)}),
    installationJson=JSON.stringify({version:1,instanceId,controlSid,ownerSid,executorSid:'S-1-5-80-6-7-8-9-10',port:7690});
  const policy=()=>({pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId,requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+20000,controlSid,ownerSid,ownerSessionId:1});
  const peer={pid:1234,createdTicks:'134368500000000000',sid:controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false};
  return {releaseJson,installationJson,policy,peer};
}
async function fixture(t){const root=await mkdtemp(join(await realpath(tmpdir()),'ragent-owner-publish-')),cleanups=[];t.after(async()=>{for(const fn of cleanups.reverse())await fn();await rm(root,{recursive:true,force:true});});return {root,filePath:join(root,'live.json'),cleanup:fn=>cleanups.push(fn)};}
function endpoints(peer){const values=[];return {values,serveEndpoint:async options=>{
  let resolve,reject;const completion=new Promise((yes,no)=>{resolve=yes;reject=no;});completion.catch(()=>{});
  const endpoint={ready:{facts:peer,protectedDacl:true,firstInstance:true,rejectRemote:true},self:{facts:peer},completion,issuer:{},close:async()=>{reject(Object.assign(new Error('closed'),{code:'OBC_PEER_DISCONNECTED'}));await completion.catch(()=>{});}};
  values.push({options,resolve,reject,endpoint});return endpoint;
}};}
test('actual file publication pins byte generations, has no credentials and exclusively owns the path',async t=>{
  const f=await fixture(t),c=configuration(),store=createOwnerDiscoveryFileStore(f),lease=await store.acquire();f.cleanup(()=>lease.close());
  await assert.rejects(store.acquire(),{code:'OBP_ALREADY_OWNED'});
  const value=ownerDiscoveryDescriptor({...c,policy:c.policy(),peer:c.peer});await lease.publish(value);
  const bytes=await readFile(f.filePath,'utf8');assert.equal(bytes.includes('sessionToken'),false);assert.equal(bytes.includes('apiKey'),false);
  const release=JSON.parse(c.releaseJson);const trusted=validateOwnerDiscoveryEvidence({version:1,aclVerified:true,signatureStatus:'Valid',helperSha256:release.helperSha256,publisherSha256:release.publisherSha256,
    releaseJson:c.releaseJson,installationJson:c.installationJson,liveJson:bytes,ownerSid:value.policy.ownerSid,ownerSessionId:1});
  assert.equal(trusted.policy.requestId,value.policy.requestId);assert.equal((await lstat(f.filePath)).nlink,1);
  await lease.withdraw();await assert.rejects(readFile(f.filePath),{code:'ENOENT'});
});
test('exclusive lock is enforced across an actual second Node process and stale records are not reclaimed',async t=>{
  const f=await fixture(t),store=createOwnerDiscoveryFileStore(f),lease=await store.acquire();f.cleanup(()=>lease.close());
  const module=new URL('../lib/windows-owner-discovery-publication.mjs',import.meta.url).href;
  const script=`const {createOwnerDiscoveryFileStore}=await import(${JSON.stringify(module)});try{await createOwnerDiscoveryFileStore({filePath:${JSON.stringify(f.filePath)}}).acquire();process.exitCode=1;}catch(e){if(e.code!=='OBP_ALREADY_OWNED')process.exitCode=2;}`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:'ignore'}),timer=setTimeout(()=>child.kill(),5000);
  try{assert.equal(await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);}),0);}finally{clearTimeout(timer);}
});
test('stale descriptor and altered publication refuse adoption or deletion of another generation',async t=>{
  const f=await fixture(t),store=createOwnerDiscoveryFileStore(f);await writeFile(f.filePath,'unverified');await assert.rejects(store.acquire(),{code:'OBP_EXISTING_DESCRIPTOR'});
  await unlink(f.filePath);const lease=await store.acquire();await lease.publish({old:true});await writeFile(f.filePath,'new-generation');
  await assert.rejects(lease.withdraw(),{code:'OBP_STATE_CHANGED'});assert.equal(await readFile(f.filePath,'utf8'),'new-generation');
  // Test-only restore of exact owned bytes to permit orderly fixture close.
  await writeFile(f.filePath,JSON.stringify({old:true})+'\n');await lease.close();
});
test('junction publication directory and hardlinked descriptor fail closed',async t=>{
  const f=await fixture(t),alias=join(f.root,'alias');await symlink(f.root,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(createOwnerDiscoveryFileStore({filePath:join(alias,'live.json')}).acquire(),{code:'OBP_PATH_INVALID'});await rm(alias,{force:true});
  await writeFile(f.filePath,'{}');await link(f.filePath,join(f.root,'hardlink'));await assert.rejects(createOwnerDiscoveryFileStore(f).acquire(),{code:'OBP_FILE_INVALID'});
});
test('ready precedes publication; refresh retires old issuance and publishes a new request; completion withdraws',async t=>{
  const f=await fixture(t),c=configuration(),native=endpoints(c.peer);let issued=0;
  const controller=await createOwnerDiscoveryController({...c,store:createOwnerDiscoveryFileStore(f),serveEndpoint:native.serveEndpoint,
    issueOwnerSession:async()=>{issued++;return 'e'.repeat(64);},revokeOwnerSession:async()=>{}});f.cleanup(()=>controller.close());
  const first=await controller.start(c.policy());assert.equal(JSON.parse(await readFile(f.filePath,'utf8')).policy.requestId,first.descriptor.policy.requestId);
  const oldIssue=native.values[0].options.issueOwnerSession;await controller.refresh(c.policy());await assert.rejects(oldIssue(c.peer),{code:'OBP_NOT_PUBLISHED'});
  assert.notEqual(JSON.parse(await readFile(f.filePath,'utf8')).policy.requestId,first.descriptor.policy.requestId);assert.equal(issued,0);
  assert.equal(await native.values[1].options.issueOwnerSession(c.peer),'e'.repeat(64));native.values[1].resolve({issued:true});
  await native.values[1].endpoint.completion;await new Promise(done=>setTimeout(done,20));await assert.rejects(readFile(f.filePath),{code:'ENOENT'});
});
test('publication failure cannot issue and closes its endpoint; endpoint failure withdraws live metadata',async t=>{
  const c=configuration(),native=endpoints(c.peer);let issued=0,closed=0;
  const failing={acquire:async()=>({publish:async()=>{await assert.rejects(native.values[0].options.issueOwnerSession(c.peer),{code:'OBP_NOT_PUBLISHED'});throw Object.assign(new Error('disk'),{code:'OBP_STORAGE_FAILED'});},withdraw:async()=>{},close:async()=>{closed++;}})};
  const controller=await createOwnerDiscoveryController({...c,store:failing,serveEndpoint:native.serveEndpoint,issueOwnerSession:async()=>{issued++;return 'a'.repeat(64);},revokeOwnerSession:async()=>{}});
  await assert.rejects(controller.start(c.policy()),{code:'OBP_STORAGE_FAILED'});await controller.close();assert.equal(issued,0);assert.equal(closed,1);
  const f=await fixture(t),other=endpoints(c.peer),live=await createOwnerDiscoveryController({...c,store:createOwnerDiscoveryFileStore(f),serveEndpoint:other.serveEndpoint,issueOwnerSession:async()=>'',revokeOwnerSession:async()=>{}});f.cleanup(()=>live.close());
  const current=await live.start(c.policy());other.values[0].reject(Object.assign(new Error('native failed'),{code:'OBC_ENDPOINT_EXIT'}));
  await assert.rejects(current.completion,{code:'OBC_ENDPOINT_EXIT'});await assert.rejects(readFile(f.filePath),{code:'ENOENT'});
});
test('a late issuer after close is revoked and cannot return a token',async t=>{
  const f=await fixture(t),c=configuration(),native=endpoints(c.peer);let finish,revoked='';
  const controller=await createOwnerDiscoveryController({...c,store:createOwnerDiscoveryFileStore(f),serveEndpoint:native.serveEndpoint,
    issueOwnerSession:()=>new Promise(done=>{finish=done;}),revokeOwnerSession:async token=>{revoked=token;}});
  await controller.start(c.policy());const pending=native.values[0].options.issueOwnerSession(c.peer);await controller.close();finish('f'.repeat(64));
  await assert.rejects(pending,{code:'OBP_RETIRED_DURING_ISSUE'});assert.equal(revoked,'f'.repeat(64));await assert.rejects(readFile(f.filePath),{code:'ENOENT'});
});
test('native startup refusal leaves no publication and releases publisher ownership on close',async t=>{
  const f=await fixture(t),c=configuration();
  const controller=await createOwnerDiscoveryController({...c,store:createOwnerDiscoveryFileStore(f),serveEndpoint:async()=>{throw Object.assign(new Error('refused'),{code:'OBC_HELPER_INVALID'});},issueOwnerSession:async()=>'',revokeOwnerSession:async()=>{}});
  await assert.rejects(controller.start(c.policy()),{code:'OBC_HELPER_INVALID'});await controller.close();
  await assert.rejects(lstat(f.filePath),{code:'ENOENT'});await assert.rejects(lstat(f.filePath+'.publisher-lock'),{code:'ENOENT'});
});
