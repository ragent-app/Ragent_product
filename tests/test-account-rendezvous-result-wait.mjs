import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { rendezvousWaitFixture, makeRendezvousWaitBroker, until } from './fixtures/rendezvous-result-wait.mjs';

const read=(f,waitMs,signal)=>f.broker.getAccountRendezvousResult({requestId:f.requestId,...(waitMs===undefined?{}:{waitMs})},{credential:f.token,signal});

test('legacy requests return pending immediately without waiting or admission',async()=>{
  const f=rendezvousWaitFixture();
  const result=await read(f);assert.equal(result.result,null);assert(!('resultWaitVersion' in result));
  assert.equal(f.activity.reads,1);assert.equal(f.hub.stats().total,0);
});
test('already completed results do not enter wait admission',async()=>{
  const f=rendezvousWaitFixture();f.state.accountJoinIntents[0].rendezvousResult={fixture:'ready'};
  assert.equal((await read(f,500)).result.fixture,'ready');assert.equal(f.hub.stats().total,0);
});
test('notification follows the actual commit, with no connection held while waiting',async()=>{
  const f=rendezvousWaitFixture();let commit;
  const gate=new Promise(resolve=>{commit=resolve;});
  f.hooks.beforeCommit=()=>gate;
  const pending=read(f,500);await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
  assert.equal(f.activity.heldReadConnections,0);
  const completion=f.broker.completeAccountRendezvous(f.completion());
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.hub.stats().total,1);
  commit();await completion;
  assert.equal((await pending).result.fixture,'ready');assert.equal(f.hub.stats().total,0);
});
test('completion between initial read and subscription is not lost',async()=>{
  const f=rendezvousWaitFixture(),started=performance.now();
  f.hooks.afterRead=count=>{if(count===1)f.state.accountJoinIntents[0].rendezvousResult={fixture:'raced'};};
  assert.equal((await read(f,500)).result.fixture,'raced');assert.equal(f.activity.reads,2);assert.equal(f.hub.stats().total,0);
  assert(performance.now()-started<250,'Result must not wait for the timeout after the race');
});
test('notification during the second read forces a fresh post-notification snapshot',async()=>{
  const f=rendezvousWaitFixture();
  f.hooks.afterRead=count=>{if(count===2){f.state.accountJoinIntents[0].rendezvousResult={fixture:'during-read'};f.hub.notify(f.requestId);}};
  assert.equal((await read(f,500)).result.fixture,'during-read');
  assert.equal(f.activity.reads,3);assert.equal(f.hub.stats().total,0);
});
test('revocation notified during the second read cannot return the older view',async()=>{
  const f=rendezvousWaitFixture();
  f.hooks.afterRead=count=>{if(count===2){f.state.accountDeviceKeys[0].revokedAt=new Date().toISOString();f.hub.notify(f.requestId);}};
  await assert.rejects(read(f,500),{statusCode:403});
  assert.equal(f.activity.reads,3);assert.equal(f.hub.stats().total,0);
});
test('wait timeout returns a freshly authorized pending response and releases capacity',async()=>{
  const f=rendezvousWaitFixture(),result=await read(f,20);
  assert.equal(result.result,null);assert.equal(result.resultWaitVersion,1);
  assert.equal(f.activity.reads,3);assert.equal(f.hub.stats().total,0);
});
for(const [name,change,statusCode] of [
  ['credential revocation',f=>{f.state.accountCredentials[0].revokedAt=new Date().toISOString();},401],
  ['phone revocation',f=>{f.state.accountDevices[0].revokedAt=new Date().toISOString();},403],
  ['key revocation',f=>{f.state.accountDeviceKeys[0].revokedAt=new Date().toISOString();},403],
  ['scope removal',f=>{f.state.accountCredentials[0].scope='other';},403],
  ['intent expiry',f=>{f.state.accountJoinIntents[0].expiresAt=new Date(0).toISOString();},410],
])test(`a notification cannot bypass ${name} after admission`,async()=>{
  const f=rendezvousWaitFixture(),pending=read(f,500);
  await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
  change(f);f.hub.notify(f.requestId);
  await assert.rejects(pending,{statusCode});assert.equal(f.hub.stats().total,0);
});

test('signed intent expiration bounds a longer requested wait',async()=>{
  const f=rendezvousWaitFixture({lifetimeMs:30});
  await assert.rejects(read(f,500),{statusCode:410});assert.equal(f.hub.stats().total,0);
});
test('unauthenticated callers cannot consume wait capacity',async()=>{
  const f=rendezvousWaitFixture();
  await assert.rejects(f.broker.getAccountRendezvousResult({requestId:f.requestId,waitMs:500},{credential:'invalid'}),{statusCode:401});
  assert.equal(f.activity.reads,0);assert.equal(f.hub.stats().total,0);
});
test('capacity rejects another valid waiter, preserving the first',async()=>{
  const f=rendezvousWaitFixture({capacities:{maximumWaiters:1}}),controller=new AbortController();
  const first=read(f,500,controller.signal);await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
  await assert.rejects(read(f,500),{statusCode:429});assert.equal(f.hub.stats().total,1);
  controller.abort(new Error('finished fixture'));await assert.rejects(first,/finished fixture/);assert.equal(f.hub.stats().total,0);
});
test('external cancellation preserves its reason and releases all waiters',async()=>{
  const f=rendezvousWaitFixture(),controller=new AbortController(),reason=new Error('caller left');
  const pending=read(f,500,controller.signal);await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
  controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(f.hub.stats().total,0);
});
test('an in-process notification is only a hint and cannot supply a cached result',async()=>{
  const f=rendezvousWaitFixture(),pending=read(f,500);await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
  f.hub.notify(f.requestId);assert.equal((await pending).result,null);assert.equal(f.activity.reads,3);
});
test('a different broker committing is observed by the bounded fresh-read checkpoint',async()=>{
  const f=rendezvousWaitFixture(),other=makeRendezvousWaitBroker(f.store),started=performance.now();
  const pending=read(f,3000);await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
  await other.completeAccountRendezvous(f.completion({fixture:'other-process-shaped-broker'}));
  assert.equal((await pending).result.fixture,'other-process-shaped-broker');
  assert(performance.now()-started<2800);assert.equal(f.hub.stats().total,0);
});
test('shutdown releases a waiter and the response still requires a fresh read',async()=>{
  const f=rendezvousWaitFixture(),pending=read(f,500);await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
  f.broker.closeRendezvousResultWaiters();assert.equal((await pending).result,null);assert.equal(f.activity.reads,3);
});


test('an expired unused join grant ends result wait without waiting for intent expiry', async () => {
  const f = rendezvousWaitFixture();
  const intent = f.state.accountJoinIntents[0];
  const raw = 'raj_fixture_expiring';
  intent.status = 'rendezvous_offered';
  intent.rendezvousGrant = raw;
  f.state.accountJoinGrants = [{ intentId: intent.intentId, accountId: intent.accountId,
    grantHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + 200).toISOString(), redeemedAt: null }];
  const started = performance.now();
  const result = await read(f, 3000);
  assert.equal(result.grantExpired, true);
  assert.equal(result.result, null);
  assert(performance.now() - started < 1800);
  assert.equal(f.hub.stats().total, 0);
});

test('a redeemed grant remains eligible for its in-flight result after grant expiry', async () => {
  const f = rendezvousWaitFixture();
  const intent = f.state.accountJoinIntents[0];
  const raw = 'raj_fixture_redeemed';
  intent.status = 'completed';
  intent.rendezvousGrant = raw;
  f.state.accountJoinGrants = [{ intentId: intent.intentId, accountId: intent.accountId,
    grantHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() - 1000).toISOString(), redeemedAt: new Date().toISOString() }];
  const pending = read(f, 1000);
  await until(() => f.hub.stats().total === 1);
  await f.broker.completeAccountRendezvous(f.completion());
  const result = await pending;
  assert.equal(result.result.fixture, 'ready');
  assert.notEqual(result.grantExpired, true);
});


test('expiry is rechecked after a concurrent redemption before asking the phone to retry', async () => {
  const f = rendezvousWaitFixture();
  const intent = f.state.accountJoinIntents[0];
  const raw = 'raj_fixture_race';
  intent.status = 'rendezvous_offered';
  intent.rendezvousGrant = raw;
  f.state.accountJoinGrants = [{ intentId: intent.intentId, accountId: intent.accountId,
    grantHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() - 1).toISOString(), redeemedAt: null }];
  const mutate = f.store.mutate;
  let confirmed = false;
  f.store.mutate = async fn => {
    if (!confirmed) {
      confirmed = true;
      intent.status = 'completed';
      f.state.accountJoinGrants[0].redeemedAt = new Date().toISOString();
    }
    return mutate(fn);
  };
  const result = await read(f);
  assert.equal(confirmed, true);
  assert.equal(result.status, 'completed');
  assert.notEqual(result.grantExpired, true);
});
