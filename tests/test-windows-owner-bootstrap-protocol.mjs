import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {createOwnerBootstrapIssuer,validateOwnerBootstrapPolicy} from '../lib/windows-owner-bootstrap-protocol.mjs';
const ownerSid='S-1-5-21-1-2-3-1001',controlSid='S-1-5-80-1-2-3-4-5';
function fixture(){let now=100000,calls=0;const policy={pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId:randomUUID(),requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:now+10000,controlSid,ownerSid,ownerSessionId:1};
  const event={kind:'request',facts:{sid:ownerSid,sessionId:1,pid:4321,createdTicks:'134368500000000000',integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true},
    frame:{version:1,operation:'owner.bootstrap',instanceId:policy.instanceId,requestId:policy.requestId,expiresAtUnixMs:policy.expiresAtUnixMs,challenge:randomBytes(32).toString('base64url')}};
  return {policy,event,clock:()=>now,advance:()=>now+=11000,issue:async()=>{calls++;return 'a'.repeat(64);},calls:()=>calls};}
test('private authenticated event issues once, including concurrent replay',async()=>{const f=fixture(),issuer=createOwnerBootstrapIssuer({policy:f.policy,clock:f.clock,issueOwnerSession:f.issue});
  const first=issuer.accept(f.event);await assert.rejects(issuer.accept(f.event),{code:'OBC_ALREADY_USED'});assert.equal((await first).operation,'owner.bootstrap.result');assert.equal(f.calls(),1);});
test('service/other SID/session, Low/elevated and unverified query facts cannot issue',async()=>{
  for(const patch of [{sid:controlSid},{sid:'S-1-5-21-9-8-7-1002'},{sessionId:0},{integrityRid:4096},{elevated:true},{enabledAdministrators:true},{queryOnlyAuthorityVerified:false},{createdTicks:'bad'}]){
    const f=fixture(),issuer=createOwnerBootstrapIssuer({policy:f.policy,clock:f.clock,issueOwnerSession:f.issue});Object.assign(f.event.facts,patch);await assert.rejects(issuer.accept(f.event),{code:'OBC_PEER_IDENTITY_DENIED'});assert.equal(f.calls(),0);}
});
test('unknown claims, operations, cross-instance/request and deadline extension cannot issue',async()=>{
  for(const patch of [{sid:ownerSid},{operation:'run.execute'},{instanceId:randomUUID()},{requestId:'0'.repeat(32)},{expiresAtUnixMs:120000}]){
    const f=fixture(),issuer=createOwnerBootstrapIssuer({policy:f.policy,clock:f.clock,issueOwnerSession:f.issue});Object.assign(f.event.frame,patch);await assert.rejects(issuer.accept(f.event));assert.equal(f.calls(),0);}
});
test('expired event fails before issue; expiry while issuing cannot return a token',async()=>{const f=fixture(),issuer=createOwnerBootstrapIssuer({policy:f.policy,clock:f.clock,issueOwnerSession:f.issue});f.advance();await assert.rejects(issuer.accept(f.event),{code:'OBC_EXPIRED'});assert.equal(f.calls(),0);
  const g=fixture(),late=createOwnerBootstrapIssuer({policy:g.policy,clock:g.clock,issueOwnerSession:async()=>{g.advance();return g.issue();}});await assert.rejects(late.accept(g.event),{code:'OBC_EXPIRED'});await assert.rejects(late.accept(g.event),{code:'OBC_ALREADY_USED'});});
test('issuer failure consumes the event; malformed token never leaves parent',async()=>{for(const issue of [async()=>{throw new Error('failure');},async()=> 'INVALID']){const f=fixture(),issuer=createOwnerBootstrapIssuer({policy:f.policy,clock:f.clock,issueOwnerSession:issue});await assert.rejects(issuer.accept(f.event));await assert.rejects(issuer.accept(f.event),{code:'OBC_ALREADY_USED'});}});
test('private policy is frozen and cannot be extended with caller identity or arbitrary pipe',()=>{for(const patch of [{pipeName:'\\\\remote\\pipe\\x'},{ownerSid:controlSid},{ownerSessionId:0},{extra:true},{expiresAtUnixMs:999999}]){const f=fixture();assert.throws(()=>validateOwnerBootstrapPolicy({...f.policy,...patch},{clock:f.clock}),{code:'OBC_POLICY_INVALID'});}});
test('product inst_ identity is preserved exactly and never aliases another instance',async()=>{
  const f=fixture(),instanceId='inst_'+'a'.repeat(32);f.policy.instanceId=instanceId;f.event.frame.instanceId=instanceId;
  const issuer=createOwnerBootstrapIssuer({policy:f.policy,clock:f.clock,issueOwnerSession:f.issue});assert.equal((await issuer.accept(f.event)).instanceId,instanceId);
  for(const bad of [instanceId+'\n',instanceId+'x',instanceId.toUpperCase(),'inst_'+ 'g'.repeat(32),'inst_'+ 'a'.repeat(31)])assert.throws(()=>validateOwnerBootstrapPolicy({...f.policy,instanceId:bad},{clock:f.clock}),{code:'OBC_POLICY_INVALID'});
  const other=createOwnerBootstrapIssuer({policy:f.policy,clock:f.clock,issueOwnerSession:f.issue});await assert.rejects(other.accept({...f.event,frame:{...f.event.frame,instanceId:'inst_'+'b'.repeat(32)}}),{code:'OBC_BINDING_MISMATCH'});
});
