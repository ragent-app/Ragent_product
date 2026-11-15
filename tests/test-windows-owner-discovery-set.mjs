import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,realpath,rm,lstat,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createOwnerDiscoverySetController,OWNER_DISCOVERY_SET_MAX_GENERATIONS} from '../lib/windows-owner-discovery-set.mjs';
import {createOwnerDiscoveryFileStore,ownerDiscoveryDescriptor} from '../lib/windows-owner-discovery-publication.mjs';
import {OWNER_BOOTSTRAP_INSTALLED_PATHS,ownerDiscoveryPurposePath,validateOwnerDiscoveryEvidence,inspectInstalledOwnerBootstrap} from '../lib/windows-owner-discovery.mjs';
import {createOwnerBootstrapIssuer} from '../lib/windows-owner-bootstrap-protocol.mjs';
const hex=()=>randomBytes(32).toString('hex');
function config(){const authority={instanceId:randomUUID(),controlSid:'S-1-5-80-1-2-3-4-5',ownerSid:'S-1-5-21-1-2-3-1001',ownerSessionId:1,expiresAtUnixMs:Date.now()+25000};
  return {authority,releaseJson:JSON.stringify({version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)}),
    installationJson:JSON.stringify({version:1,instanceId:authority.instanceId,controlSid:authority.controlSid,executorSid:'S-1-5-80-6-7-8-9-10',ownerSid:authority.ownerSid,port:7690})};}
function nativeFixture(){const values=[];let pid=1000;
  const serveEndpoint=async options=>{let resolve,reject;const completion=new Promise((yes,no)=>{resolve=yes;reject=no;});completion.catch(()=>{});
    const peer={pid:++pid,createdTicks:'134368500000000000',sid:options.policy.controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false};
    const facts={...peer,pid:++pid,sid:options.policy.ownerSid,sessionId:1,queryOnlyAuthorityVerified:true};
    const issuer=createOwnerBootstrapIssuer(options);
    const endpoint={ready:{facts:peer,protectedDacl:true,firstInstance:true,rejectRemote:true},completion,issuer,
      close:async()=>{reject(Object.assign(new Error('closed'),{code:'OBC_PEER_DISCONNECTED'}));await completion.catch(()=>{});}};
    const request=async()=>issuer.accept({kind:'request',facts,frame:{version:2,operation:'owner.'+options.policy.purpose,instanceId:options.policy.instanceId,
      requestId:options.policy.requestId,expiresAtUnixMs:options.policy.expiresAtUnixMs,challenge:randomBytes(32).toString('base64url'),launchNonce:hex()}});
    values.push({options,resolve,reject,endpoint,request,facts});return endpoint;
  };return {values,serveEndpoint};}
async function fixture(t,options={}){const root=await mkdtemp(join(await realpath(tmpdir()),'ragent-owner-set-')),c=config(),native=nativeFixture(),issued={cli:0,browser:0},revoked=[];
  const paths={cli:join(root,'cli.json'),browser:join(root,'browser.json'),publisher:join(root,'publisher.json')};
  const callbacks={issueOwnerSession:async()=>{issued.cli++;return hex();},revokeOwnerSession:async token=>{revoked.push(token);},issueBrowserTicket:async()=>{issued.browser++;return hex();},revokeBrowserTicket:async token=>{revoked.push(token);},confirmBrowserTicket:()=>{}};
  const setup={...c,...callbacks,publisherStore:createOwnerDiscoveryFileStore({filePath:paths.publisher}),stores:Object.fromEntries(['cli','browser'].map(p=>[p,createOwnerDiscoveryFileStore({filePath:paths[p]})])),serveEndpoint:native.serveEndpoint,...options};
  const controller=await createOwnerDiscoverySetController(setup);
  t.after(async()=>{await controller.close();const actual=await realpath(root);assert.equal(actual.toLowerCase(),root.toLowerCase());assert.equal(dirname(actual).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(actual).startsWith('ragent-owner-set-'));await rm(actual,{recursive:true,force:true});});
  const read=async purpose=>JSON.parse(await readFile(paths[purpose],'utf8'));
  return {root,c,native,controller,paths,setup,issued,revoked,read};}
async function absent(path){await assert.rejects(lstat(path),{code:'ENOENT'});}

test('CLI-only service acquires no browser store or callback and keeps shared ownership',async t=>{
  const f=await fixture(t,{enabledPurposes:['cli'],issueBrowserTicket:undefined,revokeBrowserTicket:undefined,confirmBrowserTicket:undefined});
  const pair=await f.controller.start(f.c.authority);assert.deepEqual(Object.keys(pair),['cli']);assert.equal(f.native.values.length,1);
  await absent(f.paths.browser);await absent(f.paths.browser+'.publisher-lock');assert.ok((await lstat(f.paths.publisher+'.publisher-lock')).isFile());
  await assert.rejects(f.controller.refresh('browser'),{code:'OBS_PURPOSE_DISABLED'});assert.ok((await f.native.values[0].request()).sessionToken);
});
test('CLI-only refresh preserves original authority and closes its sole descriptor/leases',async t=>{
  const f=await fixture(t,{enabledPurposes:['cli']});await f.controller.start(f.c.authority);const old=await f.read('cli');
  const next=await f.controller.refresh('cli');assert.notEqual(next.descriptor.policy.requestId,old.policy.requestId);assert.equal(next.descriptor.policy.expiresAtUnixMs,old.policy.expiresAtUnixMs);
  await f.controller.close();for(const p of ['cli','browser','publisher']){await absent(f.paths[p]);await absent(f.paths[p]+'.publisher-lock');}
});
test('invalid purpose subsets fail before acquiring publisher ownership',async()=>{
  for(const enabledPurposes of [[],['browser'],['cli','cli'],['browser','cli'],['cli','browser','extra'],['cli',{toString:()=> 'browser'}]]){
    let acquired=false;await assert.rejects(createOwnerDiscoverySetController({enabledPurposes,publisherStore:{acquire(){acquired=true;}}}),{code:'OBS_CONFIGURATION_REQUIRED'});assert.equal(acquired,false);
  }
});

test('purpose selection fixes two owned paths and rejects caller paths/unknown purposes before OS inspection',async()=>{
  assert.equal(ownerDiscoveryPurposePath('cli'),OWNER_BOOTSTRAP_INSTALLED_PATHS.cliLive);assert.equal(ownerDiscoveryPurposePath('browser'),OWNER_BOOTSTRAP_INSTALLED_PATHS.browserLive);
  assert.notEqual(ownerDiscoveryPurposePath('browser'),OWNER_BOOTSTRAP_INSTALLED_PATHS.live);
  for(const purpose of ['legacy','CLI','../browser','C:/override',undefined,{},null]){assert.throws(()=>ownerDiscoveryPurposePath(purpose),{code:'OBD_PURPOSE_INVALID'});if(purpose!==undefined)await assert.rejects(inspectInstalledOwnerBootstrap({purpose}),{code:'OBD_PURPOSE_INVALID'});}
});
test('a signed/ACL-shaped private descriptor still cannot cross purpose slots or downgrade to v1',()=>{
  const c=config(),policy={...c.authority,protocolVersion:2,purpose:'browser',pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),requestId:randomBytes(16).toString('hex')};
  const peer={pid:1234,createdTicks:'134368500000000000',sid:policy.controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false};
  const descriptor=ownerDiscoveryDescriptor({...c,policy,peer}),release=JSON.parse(c.releaseJson);
  const evidence={version:1,aclVerified:true,signatureStatus:'Valid',helperSha256:release.helperSha256,publisherSha256:release.publisherSha256,releaseJson:c.releaseJson,
    installationJson:c.installationJson,liveJson:JSON.stringify(descriptor),ownerSid:policy.ownerSid,ownerSessionId:1};
  assert.equal(validateOwnerDiscoveryEvidence(evidence,{purpose:'browser'}).policy.purpose,'browser');
  assert.throws(()=>validateOwnerDiscoveryEvidence(evidence,{purpose:'cli'}),{code:'OBD_PURPOSE_MISMATCH'});
  const legacy={...policy};delete legacy.protocolVersion;delete legacy.purpose;const oldRelease=JSON.stringify({...release,protocolVersion:1});
  const old=ownerDiscoveryDescriptor({...c,releaseJson:oldRelease,policy:legacy,peer});
  assert.throws(()=>validateOwnerDiscoveryEvidence({...evidence,releaseJson:oldRelease,liveJson:JSON.stringify(old)},{purpose:'cli'}),{code:'OBD_PURPOSE_MISMATCH'});
});
test('both channels publish distinct request/pipe identities with one frozen authority and no nonce or secret metadata',async t=>{
  const f=await fixture(t),started=await f.controller.start(f.c.authority),cli=await f.read('cli'),browser=await f.read('browser');
  assert.notEqual(cli.policy.requestId,browser.policy.requestId);assert.notEqual(cli.policy.pipeName,browser.policy.pipeName);
  for(const purpose of ['cli','browser']){const value=await f.read(purpose);assert.equal(value.policy.purpose,purpose);assert.equal(value.policy.expiresAtUnixMs,f.c.authority.expiresAtUnixMs);
    assert.equal(value.policy.instanceId,f.c.authority.instanceId);assert.deepEqual(value,started[purpose].descriptor);
    for(const key of ['launchNonce','sessionToken','bootstrapTicket'])assert.equal(JSON.stringify(value).includes(key),false);}
  assert.equal(f.native.values[0].options.issueBrowserTicket,undefined);assert.equal(f.native.values[1].options.issueOwnerSession,undefined);
  await f.controller.close();for(const path of Object.values(f.paths)){await absent(path);await absent(path+'.publisher-lock');}
});
test('partial startup cannot mint before the second native-ready publication',async t=>{
  let release,entered;const waiting=new Promise(done=>{entered=done;}),hold=new Promise(done=>{release=done;});
  const native=nativeFixture(),f=await fixture(t,{serveEndpoint:async options=>{if(options.policy.purpose==='browser'){entered();await hold;}return native.serveEndpoint(options);}});
  const starting=f.controller.start(f.c.authority);await waiting;
  try{await assert.rejects(native.values[0].request(),{code:'OBS_NOT_ADMITTED'});assert.deepEqual(f.issued,{cli:0,browser:0});}finally{release();}
  await starting;const result=await native.values[1].request();assert.ok(result.bootstrapTicket);assert.equal(f.issued.browser,1);
});
test('simultaneous synthetic authenticated transcripts select only their own issuer and completion withdraws independently',async t=>{
  const f=await fixture(t),pair=await f.controller.start(f.c.authority),[cli,browser]=await Promise.all(f.native.values.map(value=>value.request()));
  assert.ok(cli.sessionToken);assert.equal(cli.bootstrapTicket,undefined);assert.ok(browser.bootstrapTicket);assert.equal(browser.sessionToken,undefined);assert.notEqual(cli.launchNonce,browser.launchNonce);
  assert.deepEqual(f.issued,{cli:1,browser:1});f.native.values[1].resolve({issued:true});await pair.browser.completion;
  await absent(f.paths.browser);assert.deepEqual((await f.read('cli')).policy,pair.cli.descriptor.policy);
  await assert.rejects(f.native.values[0].request(),{code:'OBC_ALREADY_USED'});
  f.native.values[0].resolve({issued:true});await pair.cli.completion;await absent(f.paths.cli);
});
test('refreshing browser preserves the active CLI publisher/issuer and cannot extend authority',async t=>{
  const f=await fixture(t);await f.controller.start(f.c.authority);const cli=await f.read('cli'),oldBrowser=await f.read('browser');
  const replacement=await f.controller.refresh('browser');assert.deepEqual(await f.read('cli'),cli);
  assert.notEqual(replacement.descriptor.policy.requestId,oldBrowser.policy.requestId);assert.notEqual(replacement.descriptor.policy.pipeName,oldBrowser.policy.pipeName);
  assert.equal(replacement.descriptor.policy.expiresAtUnixMs,oldBrowser.policy.expiresAtUnixMs);
  await assert.rejects(f.native.values[1].request(),{code:'OBP_NOT_PUBLISHED'});
  assert.ok((await f.native.values[0].request()).sessionToken);assert.ok((await f.native.values[2].request()).bootstrapTicket);
});
test('delayed old completion cannot withdraw a newer browser descriptor or the CLI channel',async t=>{
  const native=nativeFixture(),f=await fixture(t,{serveEndpoint:native.serveEndpoint});await f.controller.start(f.c.authority);
  const cli=await f.read('cli');native.values[1].endpoint.close=async()=>{};const fresh=await f.controller.refresh('browser');
  native.values[1].resolve({issued:true});await new Promise(done=>setImmediate(done));
  assert.deepEqual(await f.read('cli'),cli);assert.deepEqual(await f.read('browser'),fresh.descriptor);
  assert.ok((await native.values[2].request()).bootstrapTicket);
});
test('a failed browser refresh leaves CLI usable and does not publish a failed endpoint',async t=>{
  const native=nativeFixture();let browserCount=0;const f=await fixture(t,{serveEndpoint:options=>{
    if(options.policy.purpose==='browser'&&++browserCount===2)throw Object.assign(new Error('startup failed'),{code:'OBC_HELPER_INVALID'});return native.serveEndpoint(options);}});
  await f.controller.start(f.c.authority);const cli=await f.read('cli');await assert.rejects(f.controller.refresh('browser'),{code:'OBC_HELPER_INVALID'});
  await absent(f.paths.browser);assert.deepEqual(await f.read('cli'),cli);assert.ok((await native.values[0].request()).sessionToken);
  await f.controller.refresh('browser');assert.ok((await native.values[2].request()).bootstrapTicket);
});
test('startup failure withdraws both slots and releases all three publisher locks',async t=>{
  const native=nativeFixture(),f=await fixture(t,{serveEndpoint:options=>{if(options.policy.purpose==='browser')throw Object.assign(new Error('no helper'),{code:'OBC_HELPER_INVALID'});return native.serveEndpoint(options);}});
  await assert.rejects(f.controller.start(f.c.authority),{code:'OBC_HELPER_INVALID'});await assert.rejects(native.values[0].request(),{code:'OBP_NOT_PUBLISHED'});
  for(const path of Object.values(f.paths)){await absent(path);await absent(path+'.publisher-lock');}await assert.rejects(f.controller.refresh('cli'),{code:'OBS_CLOSED'});
});
test('endpoint completion during partial startup cannot produce an admitted pair',async t=>{
  const native=nativeFixture(),f=await fixture(t,{serveEndpoint:async options=>{if(options.policy.purpose==='browser'){native.values[0].resolve({issued:false});await new Promise(done=>setImmediate(done));}return native.serveEndpoint(options);}});
  await assert.rejects(f.controller.start(f.c.authority),{code:'OBS_ENDPOINT_ENDED'});assert.deepEqual(f.issued,{cli:0,browser:0});
  for(const path of Object.values(f.paths)){await absent(path);await absent(path+'.publisher-lock');}
});
test('a competing process cannot split ownership of the two channels',async t=>{
  const f=await fixture(t);await f.controller.start(f.c.authority);
  const module=new URL('../lib/windows-owner-discovery-set.mjs',import.meta.url).href,storeModule=new URL('../lib/windows-owner-discovery-publication.mjs',import.meta.url).href;
  const script=`const {createOwnerDiscoverySetController}=await import(${JSON.stringify(module)});const {createOwnerDiscoveryFileStore}=await import(${JSON.stringify(storeModule)});const paths=${JSON.stringify(f.paths)};try{await createOwnerDiscoverySetController({...${JSON.stringify(f.c)},publisherStore:createOwnerDiscoveryFileStore({filePath:paths.publisher}),stores:{cli:createOwnerDiscoveryFileStore({filePath:paths.cli}),browser:createOwnerDiscoveryFileStore({filePath:paths.browser})},issueOwnerSession:async()=>'',revokeOwnerSession:async()=>{},issueBrowserTicket:async()=>'',revokeBrowserTicket:async()=>{},confirmBrowserTicket:()=>{}});process.exitCode=1;}catch(e){if(e.code!=='OBP_ALREADY_OWNED')process.exitCode=2;}`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:'ignore'}),timer=setTimeout(()=>child.kill(),5000);
  try{assert.equal(await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);}),0);}finally{clearTimeout(timer);}
  assert.ok((await f.native.values[0].request()).sessionToken);assert.ok((await f.native.values[1].request()).bootstrapTicket);
});
test('stale purpose lock refuses construction without adopting or removing foreign state',async t=>{
  const f=await fixture(t);await f.controller.close();await writeFile(f.paths.browser+'.publisher-lock','stale foreign owner');
  await assert.rejects(createOwnerDiscoverySetController(f.setup),{code:'OBP_ALREADY_OWNED'});
  assert.equal(await readFile(f.paths.browser+'.publisher-lock','utf8'),'stale foreign owner');await absent(f.paths.cli+'.publisher-lock');await absent(f.paths.publisher+'.publisher-lock');
  await unlink(f.paths.browser+'.publisher-lock');
});
test('generation budgets bound each purpose independently and capacity never extends or stops the other slot',async t=>{
  const f=await fixture(t);await f.controller.start(f.c.authority);const cli=await f.read('cli');
  for(let i=1;i<OWNER_DISCOVERY_SET_MAX_GENERATIONS;i++)await f.controller.refresh('browser');
  const last=await f.read('browser');await assert.rejects(f.controller.refresh('browser'),{code:'OBS_CAPACITY'});
  assert.deepEqual(await f.read('browser'),last);assert.deepEqual(await f.read('cli'),cli);assert.equal(last.policy.expiresAtUnixMs,f.c.authority.expiresAtUnixMs);
  assert.equal(f.native.values.length,OWNER_DISCOVERY_SET_MAX_GENERATIONS+1);assert.ok((await f.native.values[0].request()).sessionToken);
});
test('expiry and invalid purpose cannot rearm or extend the frozen owner authority',async t=>{
  let now=Date.now();const f=await fixture(t,{clock:()=>now});await f.controller.start(f.c.authority);const cli=await f.read('cli');
  await assert.rejects(f.controller.refresh('../cli'),{code:'OBD_PURPOSE_INVALID'});assert.deepEqual(await f.read('cli'),cli);
  f.c.authority.expiresAtUnixMs+=100000;now=cli.policy.expiresAtUnixMs;
  await assert.rejects(f.controller.refresh('cli'),{code:'OBS_EXPIRED'});
  await assert.rejects(f.native.values[0].request(),{code:'OBP_NOT_PUBLISHED'});assert.deepEqual(f.issued,{cli:0,browser:0});
});
test('unknown authority fields create no endpoints; corrected private input can start once',async t=>{
  const f=await fixture(t);await assert.rejects(f.controller.start({...f.c.authority,path:'override'}),{code:'OBS_AUTHORITY_INVALID'});
  assert.equal(f.native.values.length,0);await absent(f.paths.cli);await absent(f.paths.browser);
  // Structural input rejection precedes ownership of an authority, so caller
  // may correct the private input without changing an existing grant.
  await f.controller.start(f.c.authority);await assert.rejects(f.controller.start(f.c.authority),{code:'OBS_ALREADY_STARTED'});
});
test('unconfirmed close withdraws both descriptors, retains group ownership, and permits only close retry',async t=>{
  const f=await fixture(t);await f.controller.start(f.c.authority);let finish;const held=new Promise(done=>{finish=done;});
  const oldClose=f.native.values[1].endpoint.close;f.native.values[1].endpoint.close=async()=>{await held;await oldClose();};
  try{await assert.rejects(f.controller.close(),{code:'OBP_CLOSE_UNCONFIRMED'});await absent(f.paths.cli);await absent(f.paths.browser);
    assert.ok((await lstat(f.paths.publisher+'.publisher-lock')).isFile());await assert.rejects(f.controller.refresh('cli'),{code:'OBS_CLOSED'});
    await assert.rejects(createOwnerDiscoverySetController(f.setup),{code:'OBP_ALREADY_OWNED'});
  }finally{finish();await f.controller.close();}
  for(const path of Object.values(f.paths))await absent(path+'.publisher-lock');
});
test('late cookie/session issuance after group close revokes rather than returning authority',async t=>{
  let finish;const pending=new Promise(done=>{finish=done;}),f=await fixture(t,{issueOwnerSession:()=>pending});
  await f.controller.start(f.c.authority);const issue=f.native.values[0].request();await f.controller.close();const token=hex();finish(token);
  await assert.rejects(issue,{code:'OBS_NOT_ADMITTED'});assert.deepEqual(f.revoked,[token]);
});
test('close immediately denies issuance even while queued behind a blocked refresh',async t=>{
  const native=nativeFixture();let count=0,entered,release;const waiting=new Promise(done=>{entered=done;}),hold=new Promise(done=>{release=done;});
  const f=await fixture(t,{serveEndpoint:async options=>{if(options.policy.purpose==='browser'&&++count===2){entered();await hold;}return native.serveEndpoint(options);}});
  await f.controller.start(f.c.authority);const refresh=f.controller.refresh('browser');await waiting;const closing=f.controller.close();
  try{await assert.rejects(native.values[0].request(),{code:'OBS_NOT_ADMITTED'});assert.deepEqual(f.issued,{cli:0,browser:0});}finally{release();}
  await refresh;await closing;await absent(f.paths.cli);await absent(f.paths.browser);await absent(f.paths.publisher+'.publisher-lock');
});
test('close queued behind refresh also revokes an issuer that returns before child cleanup can run',async t=>{
  const native=nativeFixture();let count=0,entered,release,finish;const waiting=new Promise(done=>{entered=done;}),hold=new Promise(done=>{release=done;}),issuing=new Promise(done=>{finish=done;});
  const f=await fixture(t,{issueOwnerSession:()=>issuing,serveEndpoint:async options=>{if(options.policy.purpose==='browser'&&++count===2){entered();await hold;}return native.serveEndpoint(options);}});
  await f.controller.start(f.c.authority);const refresh=f.controller.refresh('browser');await waiting;
  const issue=native.values[0].request(),closing=f.controller.close(),token=hex();finish(token);
  try{await assert.rejects(issue,{code:'OBS_NOT_ADMITTED'});assert.deepEqual(f.revoked,[token]);}finally{release();}
  await refresh;await closing;
});
test('missing callbacks or non-v2 release refuse before acquiring any filesystem lease',async()=>{
  const c=config();let acquired=0;const options={...c,publisherStore:{acquire:async()=>{acquired++;throw new Error('must not acquire');}}};
  await assert.rejects(createOwnerDiscoverySetController(options),{code:'OBS_CONFIGURATION_REQUIRED'});
  await assert.rejects(createOwnerDiscoverySetController({...options,releaseJson:JSON.stringify({...JSON.parse(c.releaseJson),protocolVersion:1}),issueOwnerSession:async()=>'',revokeOwnerSession:async()=>{},issueBrowserTicket:async()=>'',revokeBrowserTicket:async()=>{},confirmBrowserTicket:()=>{}}),{code:'OBS_PROTOCOL_REQUIRED'});
  assert.equal(acquired,0);
});
