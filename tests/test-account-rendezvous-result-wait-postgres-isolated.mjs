import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { startAccountsServer } from '../accounts/server.mjs';
import { loadOrCreateSigningKeyRing } from '../accounts/keys.mjs';
import { rendezvousWaitFixture } from './fixtures/rendezvous-result-wait.mjs';

const database=process.env.RAGENT_QA_OWNED_DATABASE,socket=process.env.RAGENT_QA_SOCKET;
assert(/^qa_rendezvous_read_[a-f0-9]{16}$/.test(database||''));
assert(/^\/tmp\/ragent-scoped-result-pg-[a-f0-9]{16}\/socket$/.test(socket||''));
const worker=process.argv.includes('--accounts-worker');
const pool=new Pool({database,host:socket,user:'postgres',max:worker?1:2,
  connectionTimeoutMillis:5000,idleTimeoutMillis:5000,
  options:'-c application_name=ragent-result-wait-qa -c statement_timeout=10000 -c lock_timeout=1500'});
assert.equal((await pool.query('select current_database() as name')).rows[0].name,database);
const scopedWrites=process.env.RAGENT_QA_SCOPED_WRITES==='1';
const store=createPostgresStore({pool,enableScopedRendezvousResult:scopedWrites,
  enableScopedRendezvousCreation:scopedWrites});
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const keyPaths=[resolve(sourceRoot,'qa-wait-signing.json'),resolve(sourceRoot,'qa-wait-turn-signing.json')];

if(worker){
  let completedReads=0,inFlightWaits=0;
  const originalRead=store.readAccountRendezvousSnapshot;
  store.readAccountRendezvousSnapshot=async input=>{
    const result=await originalRead(input);completedReads++;return result;
  };
  const app=await startAccountsServer({port:0,host:'127.0.0.1',store,
    publicBaseUrl:'https://accounts.example.test',dataFile:resolve(sourceRoot,'unused-account-data.json'),
    signingKeyFile:keyPaths[0],turnBrokerSigningKeyFile:keyPaths[1],
    harnessPolicyFile:resolve(sourceRoot,'unused-policy.json'),logger:{level:'silent'},
    verifyGoogleCredential:async()=>{throw new Error('No Google in private wait QA');},
    verifyNativeGoogleCredential:async()=>{throw new Error('No native Google in private wait QA');},
  });
  const original=app.broker.getAccountRendezvousResult;
  app.broker.getAccountRendezvousResult=async(input,options)=>{
    const waiting=input.waitMs>0;if(waiting)inFlightWaits++;
    try{return await original(input,options);}finally{if(waiting)inFlightWaits--;}
  };
  process.on('message',async input=>{
    if(input?.stop){await app.close();await pool.end();process.disconnect();return;}
    if(input?.probe)process.send({id:input.id,stats:{completedReads,inFlightWaits,
      poolIdle:pool.idleCount,poolTotal:pool.totalCount}});
  });
  process.send({ready:true,port:app.server.address().port});
}else{
  const report={scope:'two private Fastify Accounts processes, synthetic result wait only; no production or phone speed acceptance',
    scopedWrites,success:false,checks:[]};
  const children=[],calls=[];
  let fixture,sequence=0;
  function query(child){
    const id=++sequence;
    return new Promise((complete,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error('Owned Accounts probe timeout'));},5000);
      const message=value=>{if(value.id===id){cleanup();complete(value.stats);}};
      const fail=()=>{cleanup();reject(new Error('Owned Accounts worker stopped'));};
      function cleanup(){clearTimeout(timer);child.off('message',message);child.off('exit',fail);}
      child.on('message',message);child.once('exit',fail);child.send({probe:true,id});
    });
  }
  async function waitForStats(child,predicate){
    const deadline=performance.now()+5000;
    while(performance.now()<deadline){const stats=await query(child);if(predicate(stats))return stats;
      await new Promise(resolve=>setTimeout(resolve,5));}
    throw new Error('Owned Accounts wait-state deadline exceeded');
  }
  function start(){
    const child=fork(fileURLToPath(import.meta.url),['--accounts-worker'],{stdio:['ignore','inherit','inherit','ipc']});
    children.push(child);
    child.ready=new Promise((complete,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error('Owned Accounts startup timeout'));},15000);
      const message=value=>{if(value.ready){cleanup();child.port=value.port;complete();}};
      const fail=()=>{cleanup();reject(new Error('Owned Accounts startup failed'));};
      function cleanup(){clearTimeout(timer);child.off('message',message);child.off('exit',fail);}
      child.on('message',message);child.once('exit',fail);
    });
    return child;
  }
  function http(child,action,body){
    let req;
    const done=new Promise((complete,reject)=>{
      req=request({host:'127.0.0.1',port:child.port,method:'POST',
        path:`/v1/owner-auth/rendezvous/${fixture.requestId}/${action}`,
        headers:{'Content-Type':'application/json',...(action==='result'?{Authorization:'Bearer '+fixture.token}:{})},
      },res=>{let text='';res.setEncoding('utf8');res.on('data',part=>{text+=part;});
        res.on('end',()=>complete({status:res.statusCode,headers:res.headers,body:JSON.parse(text)}));res.on('error',reject);});
      req.on('error',reject);req.end(JSON.stringify(body));
    });
    done.catch(()=>{});const call={req,done};calls.push(call);return call;
  }
  async function waiting(child){
    const before=await query(child);
    const call=http(child,'result',{requestId:fixture.requestId,waitMs:5000});
    await waitForStats(child,s=>s.inFlightWaits===1&&s.completedReads>=before.completedReads+2
      &&s.poolTotal===1&&s.poolIdle===1);
    return call;
  }
  async function resetPending(){
    await pool.query('update account_join_intents set rendezvous_result=null,status=$1 where rendezvous_request_id=$2',
      ['completed',fixture.requestId]);
  }
  try{
    const migrationRoot=new URL('../accounts/migrations/',import.meta.url);
    const migrations=(await readdir(migrationRoot)).filter(name=>name.endsWith('.up.sql')).sort();
    for(const name of migrations){const sql=await readFile(new URL(name,migrationRoot),'utf8');
      assert(!/\b(?:alter\s+system|create\s+database|drop\s+database)\b/i.test(sql));await pool.query(sql);}
    report.migrations=migrations.length;
    fixture=rendezvousWaitFixture({lifetimeMs:90_000});
    await store.mutate(draft=>Object.assign(draft,structuredClone(fixture.state)));
    for(const path of keyPaths)await loadOrCreateSigningKeyRing(path);
    const [a,b]=[start(),start()];await Promise.all([a.ready,b.ready]);
    report.processes=children.map(child=>child.pid);

    const cross=await waiting(a);
    const open=await pool.query(`select count(*)::int as count from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend' and xact_start is not null`);
    assert.equal(open.rows[0].count,0);report.waitingOpenTransactions=0;
    report.checks.push('admitted HTTP wait releases the pool client and leaves no DB transaction open');
    const started=performance.now();
    assert.equal((await http(b,'complete',fixture.completion()).done).status,200);
    const response=await cross.done;assert.equal(response.status,200);assert.equal(response.body.result.fixture,'ready');
    assert.equal(response.body.resultWaitVersion,1);
    assert.match(response.headers['cache-control'],/no-store/);
    report.crossProcessDeliveryMs=performance.now()-started;assert(report.crossProcessDeliveryMs<2800);
    report.checks.push('second Accounts process commit wakes the first through fresh scoped checkpoint without a local notification');

    await resetPending();const revoked=await waiting(a);
    await pool.query('update account_device_keys set revoked_at=now() where key_id=$1',[fixture.state.accountDeviceKeys[0].keyId]);
    assert.equal((await revoked.done).status,403);
    await waitForStats(a,s=>s.inFlightWaits===0&&s.poolIdle===s.poolTotal);
    report.checks.push('committed key revocation is rechecked after wait and refuses a result');
    // These are disposable fixture rows, never a production authority restore.
    await pool.query('update account_device_keys set revoked_at=null where key_id=$1',[fixture.state.accountDeviceKeys[0].keyId]);

    const dropped=await waiting(a);dropped.req.destroy(new Error('private socket test disconnected'));
    await assert.rejects(dropped.done,/private socket test disconnected/);
    await waitForStats(a,s=>s.inFlightWaits===0&&s.poolIdle===s.poolTotal);
    report.checks.push('actual Fastify socket disconnect cancels its wait and releases DB/admission work');

    const local=await waiting(a),localStarted=performance.now();
    assert.equal((await http(a,'complete',fixture.completion({fixture:'same-process'})).done).status,200);
    const localResponse=await local.done;assert.equal(localResponse.status,200);
    assert.equal(localResponse.body.result.fixture,'same-process');
    report.localNotificationDeliveryMs=performance.now()-localStarted;assert(report.localNotificationDeliveryMs<1000);
    report.checks.push('same-process post-commit notification immediately delivers a freshly read result');

    await resetPending();const expiring=await waiting(a);
    await pool.query('update account_join_intents set expires_at=now()-interval \'1 second\' where rendezvous_request_id=$1',[fixture.requestId]);
    assert.equal((await expiring.done).status,410);report.checks.push('original intent expiry during wait is refused after fresh read');

    // The database and rows are disposable. Exercise the actual immutable
    // deletion fence while the result request is already waiting.
    await pool.query('update account_join_intents set expires_at=now()+interval \'60 seconds\' where rendezvous_request_id=$1',[fixture.requestId]);
    const deleting=await waiting(a);
    await pool.query(`with job as (
      insert into account_deletion_jobs(job_id,request_id,account_id,confirmation_id,receipt_secret_hash,status,requested_at,updated_at)
      values ('71111111-1111-4111-8111-111111111111','72222222-2222-4222-8222-222222222222',$1,
        '73333333-3333-4333-8333-333333333333',repeat('a',64),'revoked',now(),now())
      returning job_id,account_id,requested_at
    ) insert into account_deletion_fences(account_id,job_id,requested_at) select account_id,job_id,requested_at from job`,
      [fixture.state.accounts[0].accountId]);
    await pool.query('update accounts set account_id=account_id where account_id=$1',[fixture.state.accounts[0].accountId]);
    assert.equal((await deleting.done).status,410);
    report.checks.push('committed account deletion fence is rechecked during a waiting result request');
    report.success=true;
  }catch(error){report.error={code:error.code||error.name,message:error.message};process.exitCode=1;}
  finally{
    for(const call of calls)call.req.destroy();
    await Promise.all(children.map(async child=>{
      if(child.exitCode!==null||child.signalCode!==null)return;
      const ended=new Promise(resolve=>child.once('exit',resolve));if(child.connected)child.send({stop:true});
      const stop=setTimeout(()=>{report.success=false;report.workerCleanupForced=true;process.exitCode=1;child.kill('SIGTERM');},3000);
      const kill=setTimeout(()=>child.kill('SIGKILL'),6000);
      try{await ended;}finally{clearTimeout(stop);clearTimeout(kill);}
    }));
    await pool.end();
    for(const path of keyPaths){assert(path.startsWith(resolve(sourceRoot)+'/'));await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    await writeFile(new URL('../wait-postgres-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  }
}
