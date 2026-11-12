import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {validateOwnerActivationEvidence} from '../lib/windows-owner-activation-trust.mjs';
import {validateOwnerActivationPolicy} from '../lib/windows-owner-activation-protocol.mjs';
import {createOwnerActivationService} from '../lib/windows-owner-activation-service.mjs';
const policy={domain:'owner.activation.v1',instanceId:'inst_'+'a'.repeat(32),ownerSid:'S-1-5-21-1-2-3-1001',controlSid:'S-1-5-80-1-2-3-4-5',ownerSessionId:1};
const release={version:1,protocolVersion:2,helperFile:'AgentoC.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)};
function observed(){return {version:1,aclVerified:true,signatureStatus:'Valid',helperSha256:release.helperSha256,publisherSha256:release.publisherSha256,ownerSid:policy.ownerSid,ownerSessionId:1,
  releaseJson:JSON.stringify(release),installationJson:JSON.stringify({version:1,instanceId:policy.instanceId,ownerSid:policy.ownerSid,controlSid:policy.controlSid,executorSid:'S-1-5-80-6-7-8-9-10',port:7690})};}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return {promise,resolve,reject};}
const settle=async()=>{await tick();await tick();};
test('activation installed evidence is signed, fixed, exact and independent of expired CLI discovery',()=>{
  const o=observed(),trusted=validateOwnerActivationEvidence(o);assert.deepEqual(trusted.policy,policy);assert.equal(trusted.executablePath,'C:/Program Files/AgentoC/payload/AgentoC.OwnerBootstrap.exe');assert.ok(Object.isFrozen(trusted));
  for(const patch of [{aclVerified:false},{signatureStatus:'NotSigned'},{helperSha256:'c'.repeat(64)},{ownerSid:'S-1-5-21-1-2-3-999'},{ownerSessionId:0},{liveJson:'{}'},
    {installationJson:'{'},{releaseJson:JSON.stringify({...release,protocolVersion:1})},{installationJson:JSON.stringify({...JSON.parse(o.installationJson),executorSid:policy.controlSid})}])assert.throws(()=>validateOwnerActivationEvidence({...o,...patch}));
  for(const patch of [{domain:'owner.cli'},{expiresAtUnixMs:Date.now()+30000},{sessionToken:'a'.repeat(64)},{ownerSessionId:'1'},{ownerSid:policy.ownerSid+'\n'}])assert.throws(()=>validateOwnerActivationPolicy({...policy,...patch}));
});
const error=code=>Object.assign(Error(code),{code});
function fixture(){
  const f={inspects:0,activates:0,safetyChecks:0,endpoints:[],waits:[],now:100000,trusted:{binding:{...policy,ownerSessionId:0},releaseJson:JSON.stringify(release),executablePath:'private-fixture'}};
  f.service=createOwnerActivationService({clock:()=>f.now,wait:(ms,signal)=>{const d=deferred();f.waits.push({ms,signal,d});signal.addEventListener('abort',()=>d.reject(error('OBC_ABORTED')),{once:true});return d.promise;},
    inspect:async()=>{f.inspects++;if(f.inspectError)throw error(f.inspectError);return f.trusted;},lifecycle:{async assertRecoverySafe(){f.safetyChecks++;if(f.safetyError)throw error(f.safetyError);},async activate(context,event,p){assert.deepEqual(p,policy);f.activates++;return {commit:async()=>{},rollback:async()=>{}};}},serve:async options=>{
    const d=deferred(),e={options,d,closes:0,completion:d.promise,async close(){e.closes++;if(e.closeError)throw error(e.closeError);d.reject(error('OBC_ABORTED'));}};
    options.signal.addEventListener('abort',()=>d.reject(Object.assign(Error('aborted'),{code:'OBC_ABORTED'})),{once:true});f.endpoints.push(e);return e;
  }});return f;
}
test('idle listener re-inspects without issuing authority; only actual native callback reaches activation',async()=>{
  const f=fixture();f.service.start({});await settle();assert.equal(f.service.snapshot().ready,true);assert.equal(f.activates,0);
  f.endpoints[0].d.reject(Object.assign(Error('idle'),{code:'OBC_ACTIVATION_IDLE'}));await settle();assert.equal(f.inspects,2);assert.equal(f.activates,0);assert.equal(f.endpoints.length,2);
  await f.endpoints[1].options.activate({facts:{sessionId:1},frame:{}},{...policy,ownerSessionId:0});assert.equal(f.activates,1);f.endpoints[1].d.resolve();await settle();assert.equal(f.inspects,3);
  await f.service.stop();assert.equal(f.service.snapshot().ready,false);assert.equal(f.endpoints[2].closes,1);
});
test('confirmed delivery rollback and pipe close permit delayed listening with no new authority',async()=>{
  for(const code of ['OBC_DELIVERY_UNCONFIRMED','OBC_PEER_DISCONNECTED','OBC_ACTIVATION_FRAME_INVALID','OBC_OPERATION_DENIED','OBC_BINDING_MISMATCH','OBC_EXPIRED','OBC_LAUNCH_NONCE_INVALID','OBC_LAUNCH_NONCE_MISMATCH','OSV_STOPPED']){
    const f=fixture();f.service.start({});await settle();f.endpoints[0].d.reject(error(code));await settle();
    assert.equal(f.endpoints[0].closes,1);assert.equal(f.safetyChecks,1);assert.deepEqual(f.service.snapshot(),{state:'backoff',code,ready:false});assert.equal(f.inspects,1);assert.equal(f.activates,0);
    assert.equal(f.waits[0].ms,250);f.now+=250;f.waits[0].d.resolve();await settle();assert.equal(f.inspects,2);assert.equal(f.service.snapshot().ready,true);assert.equal(f.activates,0);
    await f.endpoints[1].options.activate({facts:{sessionId:1},frame:{}},{...policy,ownerSessionId:0});assert.equal(f.activates,1);await f.service.stop();
  }
});
test('unconfirmed closure or lifecycle barrier refuses recovery and retains failed endpoint for stop',async()=>{
  const f=fixture(),task=f.service.start({});await settle();f.endpoints[0].closeError='OBP_CLOSE_UNCONFIRMED';f.endpoints[0].d.reject(error('OBC_DELIVERY_UNCONFIRMED'));await assert.rejects(task,{code:'OBP_CLOSE_UNCONFIRMED'});
  assert.equal(f.safetyChecks,0);assert.equal(f.waits.length,0);await assert.rejects(f.service.stop(),{code:'OBP_CLOSE_UNCONFIRMED'});assert.equal(f.service.snapshot().state,'cleanup-required');f.endpoints[0].closeError=null;await f.service.stop();assert.equal(f.endpoints[0].closes,3);
  for(const code of ['OSV_REVOCATION_UNCONFIRMED','OSV_RECOVERY_PENDING','OSV_RECOVERY_REFUSED']){const g=fixture();g.safetyError=code;const t=g.service.start({});await settle();g.endpoints[0].d.reject(error('OBC_DELIVERY_UNCONFIRMED'));await assert.rejects(t,{code});assert.equal(g.inspects,1);assert.equal(g.waits.length,0);await g.service.stop();}
});
test('trust, ambiguous pipe failure and unknown errors stay closed without retry',async()=>{
  for(const code of ['OBD_RELEASE_NOT_INSTALLED','OBC_TRANSPORT_FAILED','OSV_ACTIVATION_BINDING_MISMATCH','UNKNOWN']){const f=fixture(),task=f.service.start({});await settle();f.endpoints[0].d.reject(error(code));await assert.rejects(task,{code});assert.equal(f.safetyChecks,0);assert.equal(f.waits.length,0);await f.service.stop();}
  for(const change of [f=>{f.trusted.binding={...f.trusted.binding,ownerSid:'S-1-5-21-1-2-3-999'};},f=>{f.trusted.releaseJson=JSON.stringify({...release,helperSha256:'c'.repeat(64)});},f=>{f.trusted.executablePath='changed';}]){
    const f=fixture(),t=f.service.start({});await settle();f.endpoints[0].d.reject(error('OBC_DELIVERY_UNCONFIRMED'));await settle();change(f);f.waits[0].d.resolve();await assert.rejects(t,{code:'OSV_RECOVERY_BINDING_CHANGED'});assert.equal(f.endpoints.length,1);assert.equal(f.activates,0);await f.service.stop();
  }
});
test('repeated failures share rolling retry budget across successful idle listens; cooldown is abortable',async()=>{
  const f=fixture();f.service.start({});await settle();
  for(const delay of [250,1000,3000]){f.endpoints.at(-1).d.reject(error('OBC_PEER_DISCONNECTED'));await settle();assert.equal(f.waits.at(-1).ms,delay);f.now+=delay;f.waits.at(-1).d.resolve();await settle();f.endpoints.at(-1).d.resolve();await settle();}
  f.endpoints.at(-1).d.reject(error('OBC_PEER_DISCONNECTED'));await settle();assert.equal(f.service.snapshot().state,'cooldown');assert.equal(f.waits.at(-1).ms,55750);assert.equal(f.activates,0);
  f.now+=55750;f.waits.at(-1).d.resolve();await settle();assert.equal(f.service.snapshot().state,'backoff');assert.equal(f.waits.at(-1).ms,3000);const n=f.inspects;await f.service.stop();assert.equal(f.inspects,n);assert.equal(f.service.snapshot().state,'stopped');
  const g=fixture();g.service.start({});await settle();for(const delay of [250,1000,3000]){g.endpoints.at(-1).d.reject(error('OBC_PEER_DISCONNECTED'));await settle();g.now+=delay;g.waits.at(-1).d.resolve();await settle();}g.endpoints.at(-1).d.reject(error('OBC_PEER_DISCONNECTED'));await settle();assert.equal(g.service.snapshot().state,'cooldown');await g.service.stop();assert.equal(g.waits.at(-1).signal.aborted,true);
});
test('stop during listener inspection prevents late native publication',async()=>{
  const d=deferred();let signal,served=0;const service=createOwnerActivationService({lifecycle:{activate(){},assertRecoverySafe(){}},inspect:async(c,o)=>{signal=o.signal;return d.promise;},serve:()=>{served++;}});
  service.start({});await settle();const stopping=service.stop();assert.equal(signal.aborted,true);d.resolve({});await stopping;assert.equal(served,0);assert.equal(service.snapshot().state,'stopped');
});
