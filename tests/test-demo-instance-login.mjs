import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDemoAccountAuth, createDemoAccountPolicy } from '../accounts/demo-credentials.mjs';
import {createAccountEntitlementResolver} from '../accounts/turn-lease-policy.mjs';
import { createOwnerAuthBroker, deriveDesktopReplayValues } from '../accounts/owner-auth-broker.mjs';
import { buildInstanceProofMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
const username='review-fixture',password='fixture-password-for-native-login';
const policy=await createDemoAccountPolicy({username,password,instanceId:'inst_seed_fixture',accessMode:'full',instanceAccess:'account',unlimitedConnections:true});
let state={};const claims=[];const demoAuth=createDemoAccountAuth(policy);
const broker=createOwnerAuthBroker({store:{mutate:async fn=>fn(state)},demoAccountAuth:demoAuth,resolveEntitlement:createAccountEntitlementResolver(demoAuth),
 verifyGoogleCredential:async()=>{throw new Error('Password login must not invoke Google');},
 resolveAccount:async()=>{throw new Error('Must not manufacture Google identity');},signAssertion:async claim=>{claims.push(claim);return 'fixture-signed-assertion';}});
assert.equal(broker.canSignInDemoInstances,true);
assert.equal(broker.demoSignInStatus,'configured');
for(let i=0;i<2;i++){
 const key=generateKeyPairSync('ed25519');const publicKey=key.publicKey.export({type:'spki',format:'pem'}).toString();
 const instance={instanceId:'inst_password_fixture_'+i,algorithm:'ed25519',publicKey,keyFingerprint:createInstancePublicKeyFingerprint(publicKey)};
 const transactionId='tx_password_fixture_'+i,returnUrl='https://instance.example.test/api/auth/google/complete?tx='+transactionId;
 const proof={instance,transactionId,purpose:'bind',returnUrl,issuedAt:new Date().toISOString(),audience:'agentoc-owner-auth'};
 proof.signature=sign(null,Buffer.from(buildInstanceProofMessage({...proof,instanceId:instance.instanceId})),key.privateKey).toString('base64url');
 const started=await broker.start(proof);
 const {desktopState}=deriveDesktopReplayValues({transactionId,bootstrap:started.bootstrap});const phoneState='phone_fixture_state_'+i;
 const desktop=await broker.beginDesktop({transactionId,bootstrap:started.bootstrap,desktopState});
 await broker.beginPhone({transactionId,phoneTicket:desktop.phoneTicket,phoneState});
 await assert.rejects(broker.completePhoneDemoCredential({transactionId,phoneState,username,password:'wrong-password-long-fixture'}),{code:'owner_auth_demo_rejected'});
 await assert.rejects(broker.completePhoneDemoCredential({transactionId,phoneState:'forged',username,password}),{code:'owner_auth_phone_state_invalid'});
 await broker.completePhoneDemoCredential({transactionId,phoneState,username,password});
 assert.equal((await broker.getDesktopStatus({transactionId,desktopState})).status,'completed');
 assert.equal(state.instanceBindings.find(x=>x.instanceId===instance.instanceId).accountId,policy.accountId);
 await assert.rejects(broker.completePhoneDemoCredential({transactionId,phoneState,username,password}),{code:'owner_auth_transaction_replayed'});
 await broker.redeem({...proof,grant:desktop.deliveryGrant});
 assert.equal(claims.at(-1).limits.unlimited,true,'unlimited policy reaches the signed instance credential');
}
assert.equal(state.instanceBindings.length,2);
assert.ok(state.instanceBindings.every(binding=>binding.provider==='demo'));
createDemoAccountAuth(policy).assertAccount(state,policy.accountId,state.instanceBindings[1].instanceId);
const restricted=createDemoAccountAuth({...policy,instanceAccess:'allowlist'});
assert.throws(()=>restricted.assertAccount(state,policy.accountId),{code:'owner_auth_demo_unavailable'});
{
 const key=generateKeyPairSync('ed25519');const publicKey=key.publicKey.export({type:'spki',format:'pem'}).toString();
 const instance={instanceId:'inst_existing_owner_fixture',algorithm:'ed25519',publicKey,keyFingerprint:createInstancePublicKeyFingerprint(publicKey)};
 const transactionId='tx_existing_owner_fixture',returnUrl='https://instance.example.test/api/auth/google/complete?tx='+transactionId;
 state.instanceBindings.push({instanceId:instance.instanceId,accountId:'acct_google_existing',provider:'google'});
 const proof={instance,transactionId,purpose:'bind',returnUrl,issuedAt:new Date().toISOString(),audience:'agentoc-owner-auth'};
 proof.signature=sign(null,Buffer.from(buildInstanceProofMessage({...proof,instanceId:instance.instanceId})),key.privateKey).toString('base64url');
 const started=await broker.start(proof);
 const {desktopState}=deriveDesktopReplayValues({transactionId,bootstrap:started.bootstrap});
 const desktop=await broker.beginDesktop({transactionId,bootstrap:started.bootstrap,desktopState});
 const phoneState='phone_existing_owner_fixture';
 await broker.beginPhone({transactionId,phoneTicket:desktop.phoneTicket,phoneState});
 await assert.rejects(broker.completePhoneDemoCredential({transactionId,phoneState,username,password}),{code:'owner_auth_demo_binding_conflict'});
 assert.equal(state.instanceBindings.find(binding=>binding.instanceId===instance.instanceId).accountId,'acct_google_existing');
}
assert.equal(JSON.stringify(state).includes(password),false);
console.log('PASS password QR transactions: two signed instances, CSRF state, wrong password, replay, legacy allowlist and no Google identity');
