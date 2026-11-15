import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createOwnerBootstrapIssuer,validateOwnerBootstrapPolicy} from '../lib/windows-owner-bootstrap-protocol.mjs';
import {requestOwnerBootstrap,requestOwnerBrowserBootstrap,serveOwnerBootstrapOnce,serveOwnerBrowserBootstrapOnce} from '../lib/windows-owner-bootstrap.mjs';
import {bootstrapFixture} from './helpers/local-ui-bootstrap-fixture.mjs';
import {ownerDiscoveryDescriptor,createOwnerDiscoveryController,createOwnerDiscoveryFileStore} from '../lib/windows-owner-discovery-publication.mjs';
import {validateOwnerDiscoveryEvidence} from '../lib/windows-owner-discovery.mjs';
const hex=()=>randomBytes(32).toString('hex');
function fixture(purpose='browser'){
  const policy={protocolVersion:2,purpose,pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId:randomUUID(),requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+20000,controlSid:'S-1-5-80-1-2-3-4-5',ownerSid:'S-1-5-21-1-2-3-1001',ownerSessionId:1};
  const facts={sid:policy.ownerSid,sessionId:1,pid:1234,createdTicks:'134368500000000000',integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true};
  const frame={version:2,operation:'owner.'+purpose,instanceId:policy.instanceId,requestId:policy.requestId,expiresAtUnixMs:policy.expiresAtUnixMs,challenge:randomBytes(32).toString('base64url'),launchNonce:hex()};
  return {policy,event:{kind:'request',facts,frame}};
}
test('browser v2 yields only a ticket bound to client nonce and calls no session issuer',async()=>{
  const f=fixture();let sessions=0,received;
  const issuer=createOwnerBootstrapIssuer({policy:f.policy,issueOwnerSession:async()=>{sessions++;return hex();},issueBrowserTicket:async(facts,binding)=>{received=binding;return 'a'.repeat(64);}});
  const value=await issuer.accept(f.event);assert.equal(value.bootstrapTicket,'a'.repeat(64));assert.equal(value.sessionToken,undefined);assert.equal(value.launchNonce,f.event.frame.launchNonce);assert.equal(value.operation,'owner.browser.result');assert.equal(sessions,0);assert.equal(received.instanceId,f.policy.instanceId);assert.equal(received.launchNonce,f.event.frame.launchNonce);assert.ok(Object.isFrozen(received));
  await assert.rejects(issuer.accept(f.event),{code:'OBC_ALREADY_USED'});
});
test('explicit CLI v2 yields session only; browser callback cannot mint for CLI',async()=>{
  const f=fixture('cli');let tickets=0;const issuer=createOwnerBootstrapIssuer({policy:f.policy,issueOwnerSession:async()=>hex(),issueBrowserTicket:async()=>{tickets++;return hex();}});
  const value=await issuer.accept(f.event);assert.ok(value.sessionToken);assert.equal(value.bootstrapTicket,undefined);assert.equal(value.operation,'owner.cli.result');assert.equal(tickets,0);
});
test('purpose/version downgrade, missing nonce, unknown result claims and malformed client policy deny before mint',async()=>{
  for(const patch of [{operation:'owner.cli'},{operation:'owner.bootstrap',version:1},{launchNonce:'x'},{launchNonce:undefined},{sessionToken:hex()}]){
    const f=fixture();let calls=0;Object.assign(f.event.frame,patch);const issuer=createOwnerBootstrapIssuer({policy:f.policy,issueBrowserTicket:async()=>{calls++;return hex();}});await assert.rejects(issuer.accept(f.event));assert.equal(calls,0);
  }
  for(const patch of [{protocolVersion:1},{protocolVersion:3},{purpose:'owner'},{purpose:undefined},{launchNonce:hex()}]){const f=fixture();assert.throws(()=>validateOwnerBootstrapPolicy({...f.policy,...patch}));}
  const f=fixture();assert.throws(()=>validateOwnerBootstrapPolicy({...f.policy,peer:{}},{server:false}));assert.ok(validateOwnerBootstrapPolicy({...f.policy,peer:{},launchNonce:hex()},{server:false}));
});
test('browser and CLI adapters reject wrong purpose before helper lookup, without downgrade',async()=>{
  const browser=fixture(),cli=fixture('cli');for(const call of [()=>requestOwnerBootstrap({policy:browser.policy}),()=>serveOwnerBootstrapOnce({policy:browser.policy}),()=>requestOwnerBrowserBootstrap({policy:cli.policy}),()=>serveOwnerBrowserBootstrapOnce({policy:cli.policy}),()=>requestOwnerBrowserBootstrap({policy:{}})])await assert.rejects(call(),{code:'OBC_PURPOSE_DENIED'});
});
test('private transcript composes with HTTP one-use ticket, but ticket cannot serve as cookie',async t=>{
  const f=fixture(),http=await bootstrapFixture(t,{instanceId:f.policy.instanceId}),issuer=createOwnerBootstrapIssuer({policy:f.policy,issueBrowserTicket:async(_,binding)=>http.component.issueTicket(binding)});
  const result=await issuer.accept(f.event);assert.equal(http.sessions.has(result.bootstrapTicket),false);assert.equal(http.issued(),0);
  const launch={url:http.origin+'/local-bootstrap#'+new URLSearchParams({ticket:result.bootstrapTicket,nonce:result.launchNonce,instance:f.policy.instanceId})};
  assert.equal((await http.send(launch)).status,204);assert.equal(http.issued(),1);http.component.confirmTicket(result.bootstrapTicket);assert.equal((await http.send(launch)).status,410);
});
test('native delivery failure revokes a ticket even after raced HTTP exchange issued a cookie',async t=>{
  const http=await bootstrapFixture(t),nonce=hex(),ticket=http.component.issueTicket({instanceId:http.instanceId,launchNonce:nonce,expiresAtUnixMs:Date.now()+20000});
  const launch={url:http.origin+'/local-bootstrap#'+new URLSearchParams({ticket,nonce,instance:http.instanceId})};assert.equal((await http.send(launch)).status,204);assert.equal(http.sessions.size,1);
  assert.equal(await http.component.revokeTicket(ticket),true);assert.equal(http.sessions.size,0);assert.equal(http.revoked(),1);assert.equal((await http.send(launch)).status,410);assert.throws(()=>http.component.confirmTicket(ticket),{code:'LUB_TICKET_INVALID'});
});
test('revocation while cookie issuer is pending suppresses and revokes a late session',async t=>{
  let entered,finish,revoked='';const ready=new Promise(done=>{entered=done;}),http=await bootstrapFixture(t,{issueOwnerSession:()=>{entered();return new Promise(done=>{finish=done;});},revokeOwnerSession:async token=>{revoked=token;}}),nonce=hex(),ticket=http.component.issueTicket({instanceId:http.instanceId,launchNonce:nonce,expiresAtUnixMs:Date.now()+20000});
  const launch={url:http.origin+'/local-bootstrap#'+new URLSearchParams({ticket,nonce,instance:http.instanceId})},pending=http.send(launch);await ready;await http.component.revokeTicket(ticket);const cookie=hex();finish(cookie);const response=await pending;assert.equal(response.status,410);assert.equal(response.headers['set-cookie'],undefined);assert.equal(revoked,cookie);
});
test('discovery binds release protocol generation to endpoint purpose without storing launcher nonce',()=>{
  const f=fixture(),release={version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)},installation={version:1,instanceId:f.policy.instanceId,controlSid:f.policy.controlSid,executorSid:'S-1-5-80-6-7-8-9-10',ownerSid:f.policy.ownerSid,port:7690};
  const peer={pid:123,createdTicks:'134368500000000000',sid:f.policy.controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false};const releaseJson=JSON.stringify(release),installationJson=JSON.stringify(installation),descriptor=ownerDiscoveryDescriptor({releaseJson,installationJson,policy:f.policy,peer});
  const observed={version:1,aclVerified:true,signatureStatus:'Valid',helperSha256:release.helperSha256,publisherSha256:release.publisherSha256,ownerSid:f.policy.ownerSid,ownerSessionId:1,releaseJson,installationJson,liveJson:JSON.stringify(descriptor)};
  assert.equal(validateOwnerDiscoveryEvidence(observed).policy.purpose,'browser');assert.equal(descriptor.policy.launchNonce,undefined);
  assert.throws(()=>ownerDiscoveryDescriptor({releaseJson:JSON.stringify({...release,protocolVersion:1}),installationJson,policy:f.policy,peer}),{code:'OBP_DESCRIPTOR_INVALID'});
});
test('browser publication gates its distinct issuer without exposing a session callback',async t=>{
  const f=fixture(),http=await bootstrapFixture(t,{instanceId:f.policy.instanceId}),releaseJson=JSON.stringify({version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)}),installationJson=JSON.stringify({version:1,instanceId:f.policy.instanceId,controlSid:f.policy.controlSid,executorSid:'S-1-5-80-6-7-8-9-10',ownerSid:f.policy.ownerSid,port:7690});
  let options,finish;const completion=new Promise(done=>{finish=done;}),peer={pid:4321,createdTicks:'134368500000000000',sid:f.policy.controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false};
  const controller=await createOwnerDiscoveryController({releaseJson,installationJson,store:createOwnerDiscoveryFileStore({filePath:http.root+'/live.json'}),
    issueBrowserTicket:async(_,binding)=>http.component.issueTicket(binding),revokeBrowserTicket:ticket=>http.component.revokeTicket(ticket),confirmBrowserTicket:ticket=>http.component.confirmTicket(ticket),
    serveEndpoint:async value=>{options=value;await assert.rejects(value.issueBrowserTicket(f.event.facts,{instanceId:f.policy.instanceId,launchNonce:f.event.frame.launchNonce,expiresAtUnixMs:f.policy.expiresAtUnixMs}),{code:'OBP_NOT_PUBLISHED'});return {ready:{facts:peer,protectedDacl:true,firstInstance:true,rejectRemote:true},completion,close:async()=>{finish({issued:true});}};}});
  t.after(()=>controller.close());await controller.start(f.policy);assert.equal(options.issueOwnerSession,undefined);
  const binding={instanceId:f.policy.instanceId,requestId:f.policy.requestId,purpose:'browser',launchNonce:f.event.frame.launchNonce,expiresAtUnixMs:f.policy.expiresAtUnixMs};
  await assert.rejects(options.issueBrowserTicket(f.event.facts,{...binding,expiresAtUnixMs:binding.expiresAtUnixMs+1000}),{code:'OBP_BINDING_MISMATCH'});
  const ticket=await options.issueBrowserTicket(f.event.facts,binding);assert.ok(ticket);assert.equal(http.issued(),0);await controller.close();await assert.rejects(options.issueBrowserTicket(f.event.facts,{}),{code:'OBP_NOT_PUBLISHED'});
});
test('confirmed native delivery releases revocation tracking while ordinary browser session stays valid',async t=>{
  const http=await bootstrapFixture(t),nonce=hex(),ticket=http.component.issueTicket({instanceId:http.instanceId,launchNonce:nonce,expiresAtUnixMs:Date.now()+20000});
  http.component.confirmTicket(ticket);const launch={url:http.origin+'/local-bootstrap#'+new URLSearchParams({ticket,nonce,instance:http.instanceId})};assert.equal((await http.send(launch)).status,204);assert.equal(http.sessions.size,1);assert.equal(await http.component.revokeTicket(ticket),false);assert.equal(http.sessions.size,1);
});
