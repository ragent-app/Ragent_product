import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { startAccountsServer } from '../accounts/server.mjs';
import { rendezvousWaitFixture, until } from './fixtures/rendezvous-result-wait.mjs';

function resultRequest(port, f, waitMs = 1000, token = f.token) {
  let req;
  const done = new Promise((complete, reject) => {
    req = request({ host:'127.0.0.1',port,method:'POST',
      path:`/v1/owner-auth/rendezvous/${f.requestId}/result`,
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    }, res=>{
      let body='';res.setEncoding('utf8');res.on('data',part=>{body+=part;});
      res.on('end',()=>complete({status:res.statusCode,headers:res.headers,body:JSON.parse(body)}));
      res.on('error',reject);
    });
    req.on('error',reject);
    req.end(JSON.stringify({requestId:f.requestId,waitMs}));
  });
  // Tests deliberately destroy sockets. Keep the original rejection awaitable.
  done.catch(()=>{});
  return {req,done};
}

async function native(f) {
  const server=createServer((req,res)=>{
    handleOwnerAuthRoutes({req,res,pathname:new URL(req.url,'http://127.0.0.1').pathname,
      broker:f.broker,publicBaseUrl:'https://accounts.example.test'}).catch(error=>{
        if (!res.destroyed) {res.statusCode=500;res.end(JSON.stringify({code:error.code||'fixture_error'}));}
      });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {port:server.address().port,close:async()=>{
    f.hub.close();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));
  }};
}

test('native HTTP result waits for a signed completion and keeps no-store',async()=>{
  const f=rendezvousWaitFixture(),server=await native(f);
  try {
    const call=resultRequest(server.port,f);
    await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
    await f.broker.completeAccountRendezvous(f.completion());
    const response=await call.done;
    assert.equal(response.status,200);assert.equal(response.body.result.fixture,'ready');
    assert.equal(response.body.resultWaitVersion,1);
    assert.match(response.headers['cache-control'],/no-store/);assert.equal(f.hub.stats().total,0);
  } finally {await server.close();}
});

test('signed quota denial crosses the real Accounts HTTP routes without credentials',async()=>{
  const f=rendezvousWaitFixture(),server=await native(f);
  try {
    const pending=resultRequest(server.port,f);
    await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
    const completion=f.completion({error:{code:'turn_connection_quota_exceeded'}});
    const endpoint=`http://127.0.0.1:${server.port}/v1/owner-auth/rendezvous/${f.requestId}/complete`;
    const rejected=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...completion,signature:'invalid'})});
    assert.notEqual(rejected.status,200);
    const accepted=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(completion)});
    assert.equal(accepted.status,200);
    const result=await pending.done;
    assert.equal(result.status,200);
    assert.deepEqual(result.body.result,{error:{code:'turn_connection_quota_exceeded'}});
    assert.equal(Object.hasOwn(result.body.result,'credential'),false);
    assert.equal(Object.hasOwn(result.body.result,'p2p'),false);
    assert.match(result.headers['cache-control'],/no-store/);
  } finally {await server.close();}
});

test('native socket disconnect cancels the exact admitted request',async()=>{
  const f=rendezvousWaitFixture(),server=await native(f);
  try {
    const call=resultRequest(server.port,f);
    await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
    call.req.destroy(new Error('fixture disconnected'));
    await assert.rejects(call.done,/fixture disconnected/);
    await until(()=>f.hub.stats().total===0);assert.equal(f.activity.heldReadConnections,0);
  } finally {await server.close();}
});

test('HTTP admission overload returns Retry-After and leaves the first waiter intact',async()=>{
  const f=rendezvousWaitFixture({capacities:{maximumWaiters:1}}),server=await native(f);
  const first=resultRequest(server.port,f);
  try {
    await until(()=>f.activity.reads>=2&&f.hub.stats().total===1);
    const busy=await resultRequest(server.port,f).done;
    assert.equal(busy.status,429);assert.equal(busy.headers['retry-after'],'1');
    assert.equal(busy.body.code,'owner_auth_rendezvous_wait_busy');assert.equal(f.hub.stats().total,1);
  } finally {first.req.destroy();await server.close();}
});

async function fastifyFixture() {
  assert(!process.env.RAGENT_TEMPORARY_PAIRING_KEY_FILE,'No production claim key may enter this fixture');
  const root=await mkdtemp(join(tmpdir(),'ragent-result-wait-fastify-'));
  await writeFile(join(root,'.ragent-owned-qa'),'result-wait-http');
  const f=rendezvousWaitFixture();
  const app=await startAccountsServer({port:0,host:'127.0.0.1',store:f.store,
    publicBaseUrl:'https://accounts.example.test',dataFile:join(root,'accounts.json'),
    signingKeyFile:join(root,'signing.json'),turnBrokerSigningKeyFile:join(root,'turn-signing.json'),
    harnessPolicyFile:join(root,'unused-harness-policy.json'),
    verifyGoogleCredential:async()=>{throw new Error('No Google exchange');},
    verifyNativeGoogleCredential:async()=>{throw new Error('No native Google exchange');},
    logger:{level:'silent'},
  });
  let stopped=false;
  const stop=async()=>{if(!stopped){await app.close();stopped=true;}};
  return {f,app,stop,port:app.server.address().port,close:async()=>{
    await stop();
    assert(resolve(root).startsWith(resolve(tmpdir())+sep));
    assert(basename(root).startsWith('ragent-result-wait-fastify-'));
    assert.equal(await readFile(join(root,'.ragent-owned-qa'),'utf8'),'result-wait-http');
    await rm(root,{recursive:true});
  }};
}

test('Fastify hijacked raw response still propagates socket cancellation',async()=>{
  const x=await fastifyFixture();let signal,finished=false;
  const original=x.app.broker.getAccountRendezvousResult;
  x.app.broker.getAccountRendezvousResult=async(input,options)=>{
    signal=options.signal;
    try{return await original(input,options);}finally{finished=true;}
  };
  try {
    const call=resultRequest(x.port,x.f);
    await until(()=>x.f.activity.reads>=2);
    assert(signal&&!signal.aborted);call.req.destroy(new Error('Fastify fixture disconnected'));
    await assert.rejects(call.done,/Fastify fixture disconnected/);
    await until(()=>signal.aborted&&finished);
    assert.equal(x.f.activity.heldReadConnections,0);
  } finally {await x.close();}
});

test('Fastify preClose wakes an in-flight wait before closing the store',async()=>{
  const x=await fastifyFixture();
  try {
    const call=resultRequest(x.port,x.f,10_000);
    await until(()=>x.f.activity.reads>=2);
    const started=performance.now(),close=x.stop();
    const response=await call.done;await close;
    assert.equal(response.status,200);assert.equal(response.body.result,null);
    assert(performance.now()-started<1000);
  } finally {await x.close();}
});
