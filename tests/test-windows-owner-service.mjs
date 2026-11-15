import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createOwnerServiceLifecycle} from '../lib/windows-owner-service.mjs';
import {validateOwnerServiceEvidence,validateOwnerServiceContext,validateOwnerActivationServiceEvidence} from '../lib/windows-owner-service-trust.mjs';
const context={instanceRoot:'C:/ProgramData/Ragent/instances/owner',instanceId:'00000000-0000-4000-8000-000000000000',port:7690,host:'127.0.0.1'};
const error=code=>Object.assign(Error(code),{code});
function evidence(now=Date.now()){
  const install={version:1,instanceId:context.instanceId,controlSid:'S-1-5-80-1-2-3-4-5',executorSid:'S-1-5-80-6-7-8-9-10',ownerSid:'S-1-5-21-1-2-3-1001',port:7690};
  return {version:1,aclVerified:true,helperSha256:'a'.repeat(64),signatureStatus:'Valid',publisherSha256:'b'.repeat(64),
    releaseJson:JSON.stringify({version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)}),installationJson:JSON.stringify(install),
    serviceFacts:{pid:100,createdTicks:'134368500000000000',sid:install.controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false},ownerSessionId:1,observedAtUnixMs:now};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};}
async function settle(){await tick();await tick();}
function fixture(overrides={}){
  const f={now:Date.now(),inspects:0,sets:[],timers:[],revoked:[],issued:0};
  f.trusted=()=>validateOwnerServiceEvidence(evidence(f.now),context,{clock:()=>f.now});
  const dependencies={clock:()=>f.now,inspect:async(c,options)=>{assert.deepEqual(c,context);assert.ok(options.signal instanceof AbortSignal);f.inspects++;f.signal=options.signal;return f.trusted();},
    schedule:(fn,ms)=>{const timer={fn,ms};f.timers.push(timer);return timer;},cancel:timer=>{timer.cancelled=true;},
    issueOwnerSession:async()=>{f.issued++;return 'c'.repeat(64);},revokeOwnerSession:async token=>{f.revoked.push(token);},
    createSet:async options=>{const set={options,endpoints:[],closes:0,starts:[],refreshes:[]};f.sets.push(set);
      set.endpoint=()=>{const d=deferred(),endpoint={completion:d.promise};set.endpoints.push(d);return endpoint;};
      set.start=async authority=>{set.starts.push(authority);return {cli:set.endpoint()};};
      set.refresh=async purpose=>{set.refreshes.push(purpose);return set.endpoint();};
      set.close=async()=>{set.closes++;for(const d of set.endpoints)d.reject(error('OBC_ENDPOINT_EXIT'));};return set;},...overrides};
  f.lifecycle=createOwnerServiceLifecycle(dependencies);return f;
}
test('service context is fixed before OS inspection and ignores no caller override',()=>{
  validateOwnerServiceContext(context);
  const productContext={...context,instanceId:'inst_'+'a'.repeat(32)},observed=evidence();
  observed.installationJson=JSON.stringify({...JSON.parse(observed.installationJson),instanceId:productContext.instanceId});
  assert.equal(validateOwnerServiceEvidence(observed,productContext).authority.instanceId,productContext.instanceId);
  for(const c of [{...context,port:7890},{...context,host:'localhost'},{...context,instanceRoot:'G:/test'},{...context,executablePath:'evil'},{...context,instanceRoot:context.instanceRoot+'/../other'}])assert.throws(()=>validateOwnerServiceContext(c),{code:'OSV_CONTEXT_REFUSED'});
});
test('private service evidence binds signed helper, installation, actual token and one original 30s deadline',()=>{
  const now=Date.now(),observed=evidence(now),trusted=validateOwnerServiceEvidence(observed,context,{clock:()=>now+500});
  const ownerPeer={pid:123,createdTicks:'134368500000000000',sid:JSON.parse(observed.installationJson).ownerSid,sessionId:1,integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true};
  assert.equal(validateOwnerServiceEvidence({...observed,ownerPeer},context,{clock:()=>now,ownerPeer}).authority.ownerSessionId,1);
  for(const change of [{createdTicks:'134368500000000001'},{sid:'S-1-5-18'},{sessionId:0},{queryOnlyAuthorityVerified:false},{integrityRid:12288},{extra:true}])assert.throws(()=>validateOwnerServiceEvidence({...observed,ownerPeer:{...ownerPeer,...change}},context,{clock:()=>now,ownerPeer}),{code:'OSV_OWNER_PEER_DENIED'});
  const listener=validateOwnerActivationServiceEvidence({...observed,ownerSessionId:0},context,{clock:()=>now});assert.equal(listener.binding.ownerSessionId,0);assert.equal(listener.authority,undefined);assert.equal(listener.binding.expiresAtUnixMs,undefined);assert.throws(()=>validateOwnerServiceEvidence({...observed,ownerSessionId:0},context,{clock:()=>now}));
  assert.equal(trusted.authority.expiresAtUnixMs,now+30000);assert.equal(trusted.executablePath,'C:/Program Files/Ragent/payload/Ragent.OwnerBootstrap.exe');assert.ok(Object.isFrozen(trusted.authority));
  for(const change of [{aclVerified:false},{signatureStatus:'NotSigned'},{helperSha256:'c'.repeat(64)},{publisherSha256:'c'.repeat(64)},{observedAtUnixMs:now+1},{observedAtUnixMs:now-30000},{ownerSessionId:0},{ownerSessionId:65536},{installationJson:'\ufeff{}'},{extra:true}])assert.throws(()=>validateOwnerServiceEvidence({...observed,...change},context,{clock:()=>now}));
  for(const change of [{sid:'S-1-5-18'},{sid:'S-1-5-80-6-7-8-9-10'},{sessionId:1},{integrityRid:12288},{elevated:true},{enabledAdministrators:true},{createdTicks:'bad'},{pid:0}])assert.throws(()=>validateOwnerServiceEvidence({...observed,serviceFacts:{...observed.serviceFacts,...change}},context,{clock:()=>now}),{code:'OSV_SERVICE_IDENTITY_DENIED'});
});
test('metadata corruption, wrong instance, protocol, executor/control collision refuse service start',()=>{
  const now=Date.now(),observed=evidence(now),install=JSON.parse(observed.installationJson),release=JSON.parse(observed.releaseJson);
  for(const change of [{installationJson:'{'},{releaseJson:JSON.stringify({...release,protocolVersion:1})},{releaseJson:JSON.stringify({...release,helperFile:'external.exe'})},{installationJson:JSON.stringify({...install,instanceId:'other'})},{installationJson:JSON.stringify({...install,executorSid:install.controlSid})},{installationJson:JSON.stringify({...install,ownerSid:'S-1-5-18'})}])assert.throws(()=>validateOwnerServiceEvidence({...observed,...change},context,{clock:()=>now}));
});
test('start publishes CLI only; completion replenishes without re-inspection or extending deadline',async()=>{
  const f=fixture();await f.lifecycle.start(context);assert.equal(f.lifecycle.snapshot().ready,true);assert.deepEqual(f.sets[0].options.enabledPurposes,['cli']);assert.equal(f.sets[0].options.issueBrowserTicket,undefined);
  const deadline=f.lifecycle.snapshot().expiresAtUnixMs;f.now+=1000;f.sets[0].endpoints[0].resolve({issued:true});await settle();
  assert.deepEqual(f.sets[0].refreshes,['cli']);assert.equal(f.inspects,1);assert.equal(f.lifecycle.snapshot().expiresAtUnixMs,deadline);assert.equal(f.lifecycle.snapshot().ready,true);await f.lifecycle.stop();
});
test('deadline withdraws and stays expired; explicit recovery re-inspects a new window',async()=>{
  const f=fixture();await f.lifecycle.start(context);const old=f.lifecycle.snapshot().expiresAtUnixMs;f.now=old;assert.equal(f.lifecycle.snapshot().ready,false);f.timers[0].fn();await settle();assert.equal(f.lifecycle.snapshot().state,'expired');assert.equal(f.sets[0].closes,1);assert.equal(f.inspects,1);
  await f.lifecycle.start(context);assert.equal(f.inspects,2);assert.ok(f.lifecycle.snapshot().expiresAtUnixMs>old);await f.lifecycle.stop();
});
test('receipt/endpoint failure drains and never automatically retries authority',async()=>{
  const f=fixture();await f.lifecycle.start(context);f.sets[0].endpoints[0].reject(error('OBC_DELIVERY_UNCONFIRMED'));await settle();assert.deepEqual(f.lifecycle.snapshot(),{state:'failed',code:'OBC_DELIVERY_UNCONFIRMED',ready:false,expiresAtUnixMs:f.now+30000});assert.equal(f.inspects,1);assert.equal(f.signal.aborted,true);assert.equal(f.sets[0].closes,1);await f.lifecycle.stop();
});
test('generation capacity failure drains without extending or silently retrying',async()=>{
  const f=fixture();await f.lifecycle.start(context);f.sets[0].refresh=async()=>{throw error('OBS_CAPACITY');};f.sets[0].endpoints[0].resolve({issued:true});await settle();assert.equal(f.lifecycle.snapshot().code,'OBS_CAPACITY');assert.equal(f.sets[0].closes,1);assert.equal(f.inspects,1);await f.lifecycle.stop();
});
test('stop before queued start cancels it without any inspection or file acquisition',async()=>{
  const f=fixture(),start=f.lifecycle.start(context),stop=f.lifecycle.stop();await assert.rejects(start,{code:'OSV_STOPPED'});await stop;assert.equal(f.inspects,0);assert.equal(f.sets.length,0);assert.equal(f.lifecycle.snapshot().state,'stopped');
});
test('stop aborts in-flight inspection and prevents late publication',async()=>{
  const d=deferred();let signal;const f=fixture({inspect:async(c,options)=>{signal=options.signal;await d.promise;return f.trusted();}});
  const start=f.lifecycle.start(context);await settle();const stop=f.lifecycle.stop();assert.equal(signal.aborted,true);d.resolve();await assert.rejects(start,{code:'OSV_STOPPED'});await stop;assert.equal(f.sets.length,0);
});
test('stop during refresh immediately gates issuer and late token is revoked',async()=>{
  const f=fixture(),d=deferred();await f.lifecycle.start(context);const set=f.sets[0];let finish;
  const g=fixture({issueOwnerSession:()=>new Promise(done=>{finish=done;})});await g.lifecycle.start(context);const issuing=g.sets[0].options.issueOwnerSession();await settle();const stopping=g.lifecycle.stop();finish('d'.repeat(64));await assert.rejects(issuing,{code:'OSV_STOPPED'});await stopping;assert.deepEqual(g.revoked,['d'.repeat(64)]);
  set.refresh=()=>d.promise;set.endpoints[0].resolve({issued:true});await settle();const stop=f.lifecycle.stop();await assert.rejects(set.options.issueOwnerSession(),{code:'OSV_STOPPED'});d.resolve(set.endpoint());await stop;assert.equal(f.lifecycle.snapshot().state,'stopped');
});
test('unconfirmed cleanup retains controller and blocks re-inspection until stop retry',async()=>{
  const f=fixture();await f.lifecycle.start(context);const set=f.sets[0],close=set.close;set.close=async()=>{throw error('OBP_CLOSE_UNCONFIRMED');};await assert.rejects(f.lifecycle.stop(),{code:'OBP_CLOSE_UNCONFIRMED'});assert.equal(f.lifecycle.snapshot().state,'cleanup-required');await assert.rejects(f.lifecycle.start(context),{code:'OSV_ALREADY_ACTIVE'});assert.equal(f.inspects,1);set.close=close;await f.lifecycle.stop();assert.equal(f.lifecycle.snapshot().state,'stopped');
});
test('duplicate start cannot invalidate active callbacks; trust failure creates no publisher',async()=>{
  const f=fixture();await f.lifecycle.start(context);await assert.rejects(f.lifecycle.start(context),{code:'OSV_ALREADY_ACTIVE'});f.sets[0].endpoints[0].resolve({issued:true});await settle();assert.equal(f.lifecycle.snapshot().ready,true);await f.lifecycle.stop();
  const refused=fixture({inspect:async()=>{throw error('OBD_RELEASE_NOT_INSTALLED');}});await assert.rejects(refused.lifecycle.start(context),{code:'OBD_RELEASE_NOT_INSTALLED'});assert.equal(refused.sets.length,0);assert.equal(refused.lifecycle.snapshot().ready,false);await refused.lifecycle.stop();
});
function activation(f,overrides={}){
  const a=f.trusted().authority,policy={domain:'owner.activation.v1',instanceId:a.instanceId,controlSid:a.controlSid,ownerSid:a.ownerSid,ownerSessionId:a.ownerSessionId};
  return {policy,event:{kind:'request',facts:{pid:999,createdTicks:'134368500000000000',sid:a.ownerSid,sessionId:a.ownerSessionId,integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true},
    frame:{version:1,operation:'owner.activation.request',instanceId:a.instanceId,requestId:Math.random().toString(16).slice(2).padEnd(32,'a').slice(0,32),expiresAtUnixMs:f.now+20000,challenge:'a'.repeat(43),launchNonce:'b'.repeat(64),...overrides}}};
}
test('native activation after expiry re-inspects and clamps new authority to original request deadline',async()=>{
  const f=fixture();await f.lifecycle.start(context);f.now=f.lifecycle.snapshot().expiresAtUnixMs;
  const {event,policy}=activation(f),lease=await f.lifecycle.activate(context,event,policy);
  assert.equal(f.inspects,2);assert.equal(f.sets[0].closes,1);assert.equal(f.sets.length,2);assert.equal(f.lifecycle.snapshot().expiresAtUnixMs,event.frame.expiresAtUnixMs);
  await lease.commit();await lease.complete();await lease.rollback();assert.equal(f.lifecycle.snapshot().ready,true);await f.lifecycle.stop();
});
test('concurrent explicit requests reuse current authority without extension; replay fails before inspection',async()=>{
  const f=fixture(),a=activation(f),b=activation(f);await f.lifecycle.start(context);const expiry=f.lifecycle.snapshot().expiresAtUnixMs;f.now+=1000;
  const leases=await Promise.all([f.lifecycle.activate(context,a.event,a.policy),f.lifecycle.activate(context,b.event,b.policy)]);
  assert.equal(f.sets.length,1);assert.equal(f.inspects,3);assert.equal(f.lifecycle.snapshot().expiresAtUnixMs,expiry);
  await leases[0].rollback();await leases[1].commit();assert.equal(f.lifecycle.snapshot().ready,true);
  await assert.rejects(f.lifecycle.activate(context,a.event,a.policy),{code:'OSV_ACTIVATION_REPLAY'});assert.equal(f.inspects,3);await f.lifecycle.stop();
});
test('lost activation receipt revokes raced durable tokens and closes only the newly opened window',async()=>{
  const f=fixture(),a=activation(f),lease=await f.lifecycle.activate(context,a.event,a.policy);
  await assert.rejects(f.sets[0].options.issueOwnerSession(),{code:'OSV_STOPPED'});await lease.commit();const token=await f.sets[0].options.issueOwnerSession();await lease.rollback();assert.deepEqual(f.revoked,[token]);assert.equal(f.lifecycle.snapshot().ready,false);assert.equal(f.sets[0].closes,1);
  const b=activation(f),next=await f.lifecycle.activate(context,b.event,b.policy);await next.commit();await next.complete();await lease.rollback();assert.equal(f.lifecycle.snapshot().ready,true);await f.lifecycle.stop();
});
test('activation rejects wrong OS peer/domain/extra credentials and stale binding before new authority',async()=>{
  const f=fixture(),a=activation(f);
  for(const event of [{...a.event,facts:{...a.event.facts,sid:'S-1-5-18'}},{...a.event,facts:{...a.event.facts,queryOnlyAuthorityVerified:false}},
    {...a.event,frame:{...a.event.frame,operation:'owner.cli'}},{...a.event,frame:{...a.event.frame,sessionToken:'a'.repeat(64)}}])await assert.rejects(f.lifecycle.activate(context,event,a.policy));
  assert.equal(f.inspects,0);assert.equal(f.sets.length,0);
  const b=activation(f);b.policy.ownerSessionId=2;b.event.facts.sessionId=2;await assert.rejects(f.lifecycle.activate(context,b.event,b.policy),{code:'OSV_ACTIVATION_BINDING_MISMATCH'});
  assert.equal(f.sets.length,0);await f.lifecycle.stop();
});
test('activation stop aborts inspection and never publishes late; failed rollback cleanup quarantines',async()=>{
  const d=deferred();let signal;const f=fixture({inspect:async(c,o)=>{signal=o.signal;await d.promise;return f.trusted();}}),a=activation(f),pending=f.lifecycle.activate(context,a.event,a.policy);await settle();const stop=f.lifecycle.stop();assert.equal(signal.aborted,true);d.resolve();await assert.rejects(pending,{code:'OSV_STOPPED'});await stop;assert.equal(f.sets.length,0);
  const g=fixture(),b=activation(g),lease=await g.lifecycle.activate(context,b.event,b.policy);await lease.commit();await g.sets[0].options.issueOwnerSession();const close=g.sets[0].close;g.sets[0].close=async()=>{throw error('OBP_CLOSE_UNCONFIRMED');};
  await assert.rejects(lease.rollback(),{code:'OBP_CLOSE_UNCONFIRMED'});assert.equal(g.lifecycle.snapshot().state,'cleanup-required');assert.equal(g.revoked.length,1);
  const c=activation(g);await assert.rejects(g.lifecycle.activate(context,c.event,c.policy),{code:'OSV_STOPPED'});g.sets[0].close=close;await g.lifecycle.stop();
});
test('activation cannot extend authority when fresh inspection consumes the request deadline',async()=>{
  const f=fixture({inspect:async()=>{f.now+=21000;return f.trusted();}}),a=activation(f);
  await assert.rejects(f.lifecycle.activate(context,a.event,a.policy),{code:'OBC_ACTIVATION_REQUEST_INVALID'});assert.equal(f.sets.length,0);await f.lifecycle.stop();
});
test('rollback attempts all durable revocations and quarantines any unconfirmed revocation',async()=>{
  let minted=0;const revoked=[];const f=fixture({issueOwnerSession:async()=>(++minted).toString(16).padStart(64,'0'),revokeOwnerSession:async token=>{revoked.push(token);if(token.endsWith('1'))throw error('OSV_REVOKE_UNCONFIRMED');}}),a=activation(f),lease=await f.lifecycle.activate(context,a.event,a.policy);
  await lease.commit();await f.sets[0].options.issueOwnerSession();await f.sets[0].options.issueOwnerSession();
  await assert.rejects(lease.rollback(),{code:'OSV_REVOKE_UNCONFIRMED'});assert.equal(revoked.length,2);assert.equal(f.lifecycle.snapshot().state,'cleanup-required');
  const b=activation(f);await assert.rejects(f.lifecycle.activate(context,b.event,b.policy),{code:'OSV_STOPPED'});await assert.rejects(f.lifecycle.stop(),{code:'OSV_REVOCATION_UNCONFIRMED'});await assert.rejects(f.lifecycle.start(context),{code:'OSV_REVOCATION_UNCONFIRMED'});await assert.rejects(f.lifecycle.assertRecoverySafe());
});
test('recovery barrier never mints or extends authority and blocks unresolved issue and revoke work',async()=>{
  const issue=deferred(),revoke=deferred(),f=fixture({issueOwnerSession:()=>issue.promise,revokeOwnerSession:()=>revoke.promise});
  assert.equal(await f.lifecycle.assertRecoverySafe(),true);assert.equal(f.inspects,0);
  const a=activation(f),lease=await f.lifecycle.activate(context,a.event,a.policy);await lease.commit();const expires=f.lifecycle.snapshot().expiresAtUnixMs;
  const issuing=f.sets[0].options.issueOwnerSession();await assert.rejects(f.lifecycle.assertRecoverySafe(),{code:'OSV_RECOVERY_PENDING'});
  issue.resolve('d'.repeat(64));await issuing;assert.equal(await f.lifecycle.assertRecoverySafe(),true);assert.equal(f.lifecycle.snapshot().expiresAtUnixMs,expires);assert.equal(f.inspects,1);
  const revoking=f.sets[0].options.revokeOwnerSession('d'.repeat(64));await assert.rejects(f.lifecycle.assertRecoverySafe(),{code:'OSV_RECOVERY_PENDING'});revoke.resolve();await revoking;await lease.rollback();assert.equal(await f.lifecycle.assertRecoverySafe(),true);assert.equal(f.inspects,1);await f.lifecycle.stop();await assert.rejects(f.lifecycle.assertRecoverySafe(),{code:'OSV_RECOVERY_REFUSED'});
});
test('late issue revocation failure remains quarantined after a mock endpoint reports close',async()=>{
  const d=deferred(),f=fixture({issueOwnerSession:()=>d.promise,revokeOwnerSession:async()=>{throw error('OSV_REVOKE_UNCONFIRMED');}}),a=activation(f),lease=await f.lifecycle.activate(context,a.event,a.policy);await lease.commit();const issuing=f.sets[0].options.issueOwnerSession();await lease.rollback();await assert.rejects(f.lifecycle.assertRecoverySafe(),{code:'OSV_RECOVERY_PENDING'});d.resolve('e'.repeat(64));await assert.rejects(issuing,{code:'OSV_REVOKE_UNCONFIRMED'});await assert.rejects(f.lifecycle.assertRecoverySafe(),{code:'OSV_REVOCATION_UNCONFIRMED'});await assert.rejects(f.lifecycle.activate(context,activation(f).event,a.policy),{code:'OSV_REVOCATION_UNCONFIRMED'});await assert.rejects(f.lifecycle.stop(),{code:'OSV_REVOCATION_UNCONFIRMED'});
});
