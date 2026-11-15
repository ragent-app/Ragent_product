import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm,readFile,readdir,symlink,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRestrictedControlRunBroker,createControlRunClaims} from '../chat/restricted-control-run-broker.mjs';

const sid='S-1-5-80-1-2-3-4-5';
async function fixture(t){
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'ragent-control-broker-'));t.after(async()=>{
    const actual=await realpath(root);assert.equal(dirname(actual).toLowerCase(),parent.toLowerCase());assert.equal(actual.toLowerCase(),resolve(root).toLowerCase());
    await rm(actual,{recursive:true,force:true});});
  const claimsDir=join(root,'claims');await mkdir(claimsDir);
  let now=Date.now();const secret='SYNTHETIC-'+randomBytes(32).toString('hex');
  const lease={version:1,leaseId:randomUUID(),runId:'run_'+randomBytes(16).toString('hex'),sessionId:'session-local',requestId:'request-1',grantId:'rtg_0123456789abcdef',
    scope:{version:1,sessionId:'session-local',expectedScopeRevision:1,expectedProjectId:'project-local'},authorityHash:'a'.repeat(64),expiresAtUnixMs:now+30000};
  const evidence={run:{id:lease.runId,sessionId:lease.sessionId,requestId:lease.requestId,state:'running',restrictedExecution:{...structuredClone(lease),state:'dispatched'}},
    record:{request:{text:'Original accepted task',attachments:[],runOptions:{}}},binding:{principalKind:'temporary_device',temporaryAuthority:{grantId:lease.grantId},configuration:{tool:'claude',providerProfile:'selected',model:'qa-model'}}};
  const profile={id:'selected',agentType:'claude',protocol:'anthropic-messages',enabled:true,status:'ready',revision:'1'.repeat(16),authProfileId:'selected-auth',baseUrl:'https://provider.example.test/',modelPolicy:{defaultModel:'qa-model'}};
  const auth={id:'selected-auth',agentType:'claude',authType:'api-key',storageType:'secret-store',revision:'2'.repeat(16),storageRef:'selected-secret'};
  const peer={sid,sessionId:0,pid:4321,createdTicks:'134368500000000000',integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true};
  const calls={reads:[],opens:0,sends:0,closes:0,authority:0};let wire;
  const opts={instanceId:'isolated-control-broker',executorSid:sid,authority:{scoped:async(_,effect)=>{calls.authority++;return effect(evidence);}},
    registry:{getProviderProfile:async id=>{assert.equal(id,'selected');return structuredClone(profile);},getAuthProfile:async id=>{assert.equal(id,'selected-auth');return structuredClone(auth);}},
    secretStore:{resolveSecret:async ref=>{calls.reads.push(ref);return {ok:true,authType:'api-key',apiKey:secret};}},
    claims:createControlRunClaims({root:claimsDir}),authorizeEndpoint:async()=>({allowed:true,revision:'endpoint-policy-1'}),clock:()=>now,
    transport:{open:async()=>{calls.opens++;return {peer:structuredClone(peer),send:async payload=>{calls.sends++;wire=structuredClone(payload);return {snapshotHash:payload.snapshotHash,
      outcome:{...Object.fromEntries(['leaseId','runId','requestId','grantId','authorityHash'].map(key=>[key,lease[key]])),stopped:true,completed:true,text:'SYNTHETIC_RESULT'}};},close:async()=>{calls.closes++;}};}}};
  return {root,claimsDir,lease,evidence,profile,auth,peer,secret,calls,opts,broker:()=>createRestrictedControlRunBroker(opts),wire:()=>wire,advance:()=>now+=31000};
}

test('only original selected configuration and key cross the private channel; claim has no secrets',async t=>{
  const f=await fixture(t),broker=f.broker();
  const result=await broker.execute({lease:f.lease,record:{request:{text:'INJECTED'}},binding:{configuration:{providerProfile:'other'}}});
  assert.equal(result.text,'SYNTHETIC_RESULT');assert.deepEqual(f.calls.reads,['selected-secret','selected-secret']);assert.equal(f.calls.sends,1);assert.equal(f.calls.closes,1);
  const wire=f.wire();assert.equal(wire.frame.payload.text,'Original accepted task');assert.equal(wire.snapshot.baseUrl,f.profile.baseUrl);assert.equal(wire.credential.apiKey,f.secret);
  assert.deepEqual(Object.keys(wire.credential),['authType','apiKey']);assert.ok(!JSON.stringify(wire).includes('selected-secret'));assert.ok(!JSON.stringify(wire).includes('storageRef'));
  const rows=await readdir(f.claimsDir);assert.equal(rows.length,1);const persisted=await readFile(join(f.claimsDir,rows[0]),'utf8');
  for(const forbidden of [f.secret,'Original accepted task','capability','storageRef','refresh_token'])assert.equal(persisted.includes(forbidden),false);
  assert.equal(JSON.parse(persisted).state,'consumed-before-credential');
});

test('exclusive durable claim rejects concurrent and cold replays before secret lookup',async t=>{
  const f=await fixture(t),b=f.broker();const result=await Promise.allSettled([b.execute({lease:f.lease}),b.execute({lease:f.lease})]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.find(x=>x.status==='rejected').reason.code,'CB_ALREADY_CONSUMED');
  await assert.rejects(f.broker().execute({lease:f.lease}),{code:'CB_ALREADY_CONSUMED'});assert.equal(f.calls.sends,1);assert.equal(f.calls.reads.length,2);
});

test('forged lease fields, Owner authority and attachments have zero credential work',async t=>{
  for(const mutate of [f=>f.lease.requestId='other',f=>f.lease.grantId='rtg_other123456',f=>f.lease.authorityHash='b'.repeat(64),f=>f.lease.scope.expectedScopeRevision++,
    f=>f.lease.extra='claim',f=>f.evidence.binding.principalKind='owner',f=>f.evidence.run.cancelRequested=true,f=>f.evidence.record.request.attachments.push({id:'file'}),f=>f.advance()]){
    const f=await fixture(t);mutate(f);await assert.rejects(f.broker().execute({lease:f.lease}),error=>error.stopConfirmed===true);
    assert.equal(f.calls.reads.length,0);assert.equal(f.calls.opens,0);assert.equal(f.calls.sends,0);
  }
});

test('disabled profile, OAuth, unsafe endpoint and unsupported tool do not open channel or read key',async t=>{
  for(const mutate of [f=>f.profile.enabled=false,f=>f.auth.authType='oauth',f=>f.auth.storageRef='../private',f=>f.profile.baseUrl='http://example.test/',
    f=>f.profile.baseUrl='https://user:password@example.test/',f=>f.profile.baseUrl='https://example.test/?key=secret',
    f=>f.opts.authorizeEndpoint=async()=>({allowed:false}),f=>f.evidence.binding.configuration.tool='codex']){
    const f=await fixture(t);mutate(f);await assert.rejects(f.broker().execute({lease:f.lease}));assert.equal(f.calls.reads.length,0);assert.equal(f.calls.opens,0);
  }
});

test('unverified/wrong service/interactive/elevated/Low peer consumes claim but reads no key',async t=>{
  for(const patch of [{sid:'S-1-5-18'},{sessionId:1},{integrityRid:4096},{elevated:true},{enabledAdministrators:true},{queryOnlyAuthorityVerified:false},{createdTicks:'bad'}]){
    const f=await fixture(t);Object.assign(f.peer,patch);await assert.rejects(f.broker().execute({lease:f.lease}),{code:'CB_EXECUTOR_DENIED',stopConfirmed:true});
    assert.equal(f.calls.reads.length,0);assert.equal(f.calls.closes,1);await assert.rejects(f.broker().execute({lease:f.lease}),{code:'CB_ALREADY_CONSUMED'});
  }
});

test('profile/auth/policy mutation while opening or resolving aborts publication',async t=>{
  for(const stage of ['open','profile','auth','endpoint','last-read']){
    const f=await fixture(t),open=f.opts.transport.open,read=f.opts.secretStore.resolveSecret;
    if(stage==='open')f.opts.transport.open=async args=>{const value=await open(args);f.profile.baseUrl='https://changed.example.test/';return value;};
    else f.opts.secretStore.resolveSecret=async ref=>{const value=await read(ref);if(stage==='profile')f.profile.revision='3'.repeat(16);
      if(stage==='auth')f.auth.revision='4'.repeat(16);if(stage==='endpoint')f.opts.authorizeEndpoint=async()=>({allowed:true,revision:'changed'});
      if(stage==='last-read'&&f.calls.reads.length===2)f.profile.baseUrl='https://last.example.test/';return value;};
    // Replace closure function as well when testing a policy-generation change.
    if(stage==='endpoint'){let count=0;f.opts.authorizeEndpoint=async()=>({allowed:true,revision:++count>=3?'changed':'endpoint-policy-1'});}
    await assert.rejects(f.broker().execute({lease:f.lease}),{code:'CB_CONFIGURATION_CHANGED',stopConfirmed:true});assert.equal(f.calls.sends,0);
  }
});

test('same-ref API key rotation and cancellation after resolution cannot dispatch',async t=>{
  for(const scenario of ['rotation','cancel','expiry','authority-data']){
    const f=await fixture(t),read=f.opts.secretStore.resolveSecret,abort=new AbortController();
    f.opts.secretStore.resolveSecret=async ref=>{const value=await read(ref);if(f.calls.reads.length===2){if(scenario==='rotation')value.apiKey+='-changed';if(scenario==='cancel')abort.abort();if(scenario==='expiry')f.advance();if(scenario==='authority-data')f.evidence.record.request.text='Changed after secret read';}return value;};
    await assert.rejects(f.broker().execute({lease:f.lease,signal:abort.signal}));assert.equal(f.calls.sends,0);
  }
});

test('transport loss and malformed result never release claim; raw exceptions are redacted',async t=>{
  for(const scenario of ['lost','snapshot','unknown-field','outcome']){
    const f=await fixture(t),open=f.opts.transport.open;f.opts.transport.open=async args=>{const value=await open(args),send=value.send;
      value.send=async payload=>{if(scenario==='lost')throw new Error(f.secret);const result=await send(payload);
        if(scenario==='snapshot')result.snapshotHash='f'.repeat(64);if(scenario==='unknown-field')result.ownerToken='forbidden';if(scenario==='outcome')result.outcome.runId='run_other12345';return result;};return value;};
    await assert.rejects(f.broker().execute({lease:f.lease}),error=>error.stopConfirmed===false&&!error.message.includes(f.secret)&&!error.cause);
    await assert.rejects(f.broker().execute({lease:f.lease}),{code:'CB_ALREADY_CONSUMED'});
  }
});

test('claim root junction/symlink and unexpected metadata are refused',async t=>{
  const f=await fixture(t),link=join(f.root,'linked');await symlink(f.claimsDir,link,process.platform==='win32'?'junction':'dir');
  f.opts.claims=createControlRunClaims({root:link});await assert.rejects(f.broker().execute({lease:f.lease}),{code:'CB_CLAIM_ROOT_INVALID'});assert.equal(f.calls.reads.length,0);
  await assert.rejects(createControlRunClaims({root:f.claimsDir}).consume({apiKey:f.secret}),{code:'CB_CLAIM_INVALID'});
});

test('missing channel methods and cancellation during final authority read cannot send',async t=>{
  for(const scenario of ['missing-close','sync-close','final-abort']){
    const f=await fixture(t),abort=new AbortController(),open=f.opts.transport.open;
    f.opts.transport.open=async args=>{const value=await open(args);if(scenario==='missing-close')delete value.close;
      if(scenario==='sync-close')value.close=()=>{f.calls.closes++;};return value;};
    if(scenario==='final-abort'){const scoped=f.opts.authority.scoped;f.opts.authority.scoped=async(...args)=>{const value=await scoped(...args);if(f.calls.authority===4)abort.abort();return value;};}
    if(scenario==='sync-close'){await f.broker().execute({lease:f.lease});assert.equal(f.calls.sends,1);}
    else{await assert.rejects(f.broker().execute({lease:f.lease,signal:abort.signal}),error=>error.stopConfirmed===true);assert.equal(f.calls.sends,0);}
  }
});

test('two actual Node processes contend on the same fsynced dispatch claim',async t=>{
  const f=await fixture(t),record={version:1,instanceId:f.opts.instanceId,runId:f.lease.runId,leaseId:f.lease.leaseId,requestId:f.lease.requestId,grantId:f.lease.grantId,
    authorityHash:f.lease.authorityHash,snapshotHash:'b'.repeat(64),textSha256:'c'.repeat(64),expiresAtUnixMs:f.lease.expiresAtUnixMs,state:'consumed-before-credential'};
  const moduleUrl=new URL('../chat/restricted-control-run-broker.mjs',import.meta.url).href;
  const script=`import {createControlRunClaims} from ${JSON.stringify(moduleUrl)};try{await createControlRunClaims({root:process.argv[1]}).consume(JSON.parse(process.argv[2]));console.log('CLAIMED');}catch(e){if(e.code!=='CB_ALREADY_CONSUMED')process.exitCode=1;console.log(e.code);}`;
  async function contender(){const child=spawn(process.execPath,['--input-type=module','-e',script,f.claimsDir,JSON.stringify(record)],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();const timer=setTimeout(()=>child.kill(),10000);
    const code=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);});clearTimeout(timer);assert.equal(code,0);return output.trim();}
  assert.deepEqual((await Promise.all([contender(),contender()])).sort(),['CB_ALREADY_CONSUMED','CLAIMED']);
});
