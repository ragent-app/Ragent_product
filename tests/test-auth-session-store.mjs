import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm,mkdir,unlink,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openAuthSessionStore,readAuthSessionStoreUsage} from '../lib/auth-session-store.mjs';
const secret='SYNTHETIC-AUTH-STORE-TEST-SECRET',key=()=> 's'+randomBytes(32).toString('hex'),session=()=>({role:'owner',expiry:Date.now()+60000});
const fixtureCleanups=new Map();
async function fixture(t){
  const root=await mkdtemp(join(await realpath(tmpdir()),'ragent-auth-store-')),stores=[],cleanups=[];fixtureCleanups.set(root,cleanups);
  t.after(async()=>{for(const cleanup of cleanups.reverse())await cleanup();for(const store of stores)store.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:25});fixtureCleanups.delete(root);});
  const options={legacyFile:join(root,'auth-sessions.json'),databaseFile:join(root,'auth-sessions.sqlite'),secret};
  const open=(patch={})=>{const store=openAuthSessionStore({...options,...patch});stores.push(store);return store;};return {root,options,open,cleanups};
}
async function worker(t,root,mode='store'){
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/auth-session-store-worker.mjs',import.meta.url)),root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout}),queue=[],waiting=[];let exited=false;
  lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}if(waiting.length)waiting.shift()(value);else queue.push(value);});child.stderr.resume();child.stdin.on('error',()=>{});
  const exit=new Promise(done=>{child.once('error',()=>done(-1));child.once('close',code=>{exited=true;for(const done of waiting.splice(0))done({error:'WORKER_EXIT'});done(code);});});
  const timer=setTimeout(()=>child.kill(),15000);const next=()=>queue.length?Promise.resolve(queue.shift()):exited?Promise.resolve({error:'WORKER_EXIT'}):new Promise(done=>waiting.push(done));
  const send=command=>{child.stdin.write(JSON.stringify(command)+'\n');return next();};
  fixtureCleanups.get(root).push(async()=>{clearTimeout(timer);child.kill();await exit;lines.close();});
  assert.deepEqual(await send({op:'open',secret,mode}),{ready:true});return {send,child,exit};
}
test('legacy hashed/raw cookie migration commits once; legacy edits never restore revoked rows',async t=>{
  const f=await fixture(t),raw=randomBytes(32).toString('hex'),hashed=key(),expired=key();
  await writeFile(f.options.legacyFile,JSON.stringify({[raw]:session(),[hashed]:{...session(),role:'visitor'},[expired]:{role:'owner',expiry:1}}));
  const store=f.open(),converted='s'+createHmac('sha256',secret).update(raw).digest('hex');assert.equal(store.snapshot().size,2);assert.equal(store.get(converted).role,'owner');
  assert.equal(store.revoke(converted),true);store.close();await writeFile(f.options.legacyFile,JSON.stringify({[raw]:session()}));
  const reopened=f.open();assert.equal(reopened.get(converted),null);assert.equal(reopened.get(hashed).role,'visitor');
  for(const suffix of ['','-wal']){try{assert.equal((await readFile(f.options.databaseFile+suffix)).includes(Buffer.from(raw)),false);}catch(error){if(error.code!=='ENOENT')throw error;}}
});
test('missing DB after cutover, wrong key and incomplete cutover refuse legacy fallback',async t=>{
  const f=await fixture(t),store=f.open();store.close();await unlink(f.options.databaseFile);assert.throws(()=>f.open(),{code:'AUTH_SESSION_CUTOVER_INVALID'});
  assert.throws(()=>f.open({secret:'DIFFERENT'}),{code:'AUTH_SESSION_CUTOVER_INVALID'});
});
test('corrupt database and malformed legacy fail closed instead of creating empty authority',async t=>{
  const f=await fixture(t);await writeFile(f.options.legacyFile,'{"secret":"invalid"}');assert.throws(()=>f.open(),{code:'AUTH_SESSION_DATA_INVALID'});
  await unlink(f.options.legacyFile);const store=f.open();store.close();await writeFile(f.options.databaseFile,'NOT SQLITE, DO NOT REIMPORT');assert.throws(()=>f.open(),{code:'AUTH_SESSION_STORE_UNAVAILABLE'});
});
test('two actual connections see revocation; refresh never recreates a deleted row',async t=>{
  const f=await fixture(t),first=f.open(),second=f.open(),id=key();first.insert(id,session());assert.equal(second.get(id).role,'owner');
  assert.equal(second.revoke(id),true);assert.equal(first.get(id),null);assert.equal(first.refresh(id,{force:true,windowMs:1000,expiryMs:60000}),false);assert.equal(first.snapshot().size,0);
});
test('real SQLite statement rejection cannot publish a provisional session and poisons connection',async t=>{
  const f=await fixture(t),store=f.open(),sql=new DatabaseSync(f.options.databaseFile);f.cleanups.push(()=>sql.close());
  sql.exec("CREATE TRIGGER deny_issue BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'SYNTHETIC-WRITE-FAILURE'); END");
  assert.throws(()=>store.insert(key(),session()),{code:'AUTH_SESSION_STORE_UNAVAILABLE'});assert.equal(store.healthy,false);assert.throws(()=>store.snapshot(),{code:'AUTH_SESSION_STORE_UNAVAILABLE'});
  sql.exec('DROP TRIGGER deny_issue');assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,0);
});
test('actual second process write lock returns bounded typed busy; no provisional row',async t=>{
  const f=await fixture(t),store=f.open(),child=await worker(t,f.root);assert.deepEqual(await child.send({op:'hold'}),{held:true});const id=key();
  const start=Date.now();assert.throws(()=>store.insert(id,session()),{code:'AUTH_SESSION_STORE_BUSY'});assert.ok(Date.now()-start<3000);assert.equal(store.healthy,true);assert.equal(store.get(id),null);
  child.child.kill();await child.exit;store.insert(id,session());assert.equal(store.get(id).role,'owner');
});
test('two actual Node writers issue independently; neither full snapshot overwrites the other',async t=>{
  const f=await fixture(t),store=f.open(),a=await worker(t,f.root),b=await worker(t,f.root),ids=Array.from({length:24},key);
  const results=await Promise.all(ids.map((id,i)=>(i%2?a:b).send({op:'insert',key:id,session:session()})));assert.ok(results.every(x=>x.ok));assert.equal(store.snapshot().size,24);
  assert.deepEqual(await a.send({op:'revoke',key:ids[0]}),{removed:true});assert.deepEqual(await b.send({op:'refresh',key:ids[0]}),{refreshed:false});assert.equal(store.get(ids[0]),null);
});
test('actual killed uncommitted writer rolls back; killed committed writer survives cold open',async t=>{
  const f=await fixture(t),store=f.open(),uncommitted=key(),a=await worker(t,f.root);
  assert.deepEqual(await a.send({op:'hold',key:uncommitted,session:session()}),{held:true});a.child.kill();await a.exit;assert.equal(store.get(uncommitted),null);
  const committed=key(),b=await worker(t,f.root);assert.deepEqual(await b.send({op:'insert',key:committed,session:session()}),{ok:true});b.child.kill();await b.exit;
  store.close();const cold=f.open();assert.equal(cold.get(committed).role,'owner');assert.equal(cold.get(uncommitted),null);
});
test('original auth returns durable cookies only; kill/reopen preserves issue and revoke',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'config'));await writeFile(join(f.root,'config/auth.json'),JSON.stringify({username:'synthetic-owner',passwordHash:'SYNTHETIC'}));
  const a=await worker(t,f.root,'auth'),issued=await a.send({op:'issue'});assert.match(issued.token,/^[a-f0-9]{64}$/);a.child.kill();await a.exit;
  const b=await worker(t,f.root,'auth');assert.deepEqual(await b.send({op:'validate',token:issued.token}),{allowed:true});assert.deepEqual(await b.send({op:'auth-revoke',token:issued.token}),{removed:true});b.child.kill();await b.exit;
  const c=await worker(t,f.root,'auth');assert.deepEqual(await c.send({op:'validate',token:issued.token}),{allowed:false});assert.deepEqual(await c.send({op:'auth-refresh',token:issued.token}),{refreshed:false});
});
test('actual symlink/hardlink store namespaces and replaced cutover refuse',async t=>{
  const f=await fixture(t),store=f.open();store.close();const alias=join(f.root,'alias');await symlink(f.root,alias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.open({legacyFile:join(alias,'auth-sessions.json'),databaseFile:join(alias,'auth-sessions.sqlite')}),{code:'AUTH_SESSION_PATH_UNSAFE'});await unlink(alias);
  const extra=join(f.root,'extra');await link(f.options.databaseFile,extra);assert.throws(()=>f.open(),{code:'AUTH_SESSION_PATH_UNSAFE'});await unlink(extra);
  const marker=JSON.parse(await readFile(f.options.databaseFile+'.cutover','utf8'));marker.id='different';await writeFile(f.options.databaseFile+'.cutover',JSON.stringify(marker));assert.throws(()=>f.open(),{code:'AUTH_SESSION_CUTOVER_INVALID'});
});
test('original auth under actual writer contention returns no token and publishes no session',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'config'));await writeFile(join(f.root,'config/auth.json'),JSON.stringify({username:'synthetic-owner',passwordHash:'SYNTHETIC'}));
  const child=await worker(t,f.root,'auth');assert.deepEqual(await child.send({op:'hold'}),{held:true});
  assert.deepEqual(await child.send({op:'issue'}),{error:'AUTH_SESSION_STORE_BUSY'});assert.deepEqual(await child.send({op:'auth-count'}),{count:0});
});
test('admin counts committed rows read-only and reports unavailable instead of stale legacy count',async t=>{
  const f=await fixture(t);assert.deepEqual(readAuthSessionStoreUsage(f.options.databaseFile),{migrated:false,count:null});
  const store=f.open();store.insert(key(),session());assert.deepEqual(readAuthSessionStoreUsage(f.options.databaseFile),{migrated:true,count:1});store.close();await unlink(f.options.databaseFile);
  assert.deepEqual(readAuthSessionStoreUsage(f.options.databaseFile),{migrated:true,count:null});
});
test('full session store reclaims only a disposable loopback session for local recovery',async t=>{
  const f=await fixture(t),store=f.open(),sql=new DatabaseSync(f.options.databaseFile);f.cleanups.push(()=>sql.close());
  const expiry=Date.now()+600000,google=key(),local=key(),newLocal=key();
  const insert=sql.prepare('INSERT INTO sessions VALUES(?,?,?)');sql.exec('BEGIN');
  insert.run(google,expiry,JSON.stringify({role:'owner',authMethod:'google_accounts',expiry}));
  insert.run(local,expiry-1,JSON.stringify({role:'owner',authMethod:'local_web',expiry:expiry-1}));
  for(let i=0;i<9998;i++)insert.run(key(),expiry,JSON.stringify({role:'visitor',authMethod:'guest',expiry}));
  sql.exec('COMMIT');
  assert.throws(()=>store.insert(key(),{role:'owner',authMethod:'google_accounts',expiry}),{code:'AUTH_SESSION_CAPACITY'});
  store.insert(newLocal,{role:'owner',authMethod:'local_web',expiry});
  assert.equal(store.get(local),null);assert.equal(store.get(google).authMethod,'google_accounts');
  assert.equal(store.get(newLocal).authMethod,'local_web');assert.equal(store.snapshot().size,10000);
  assert.throws(()=>store.insert(key(),{role:'owner',authMethod:'google_accounts',expiry}),{code:'AUTH_SESSION_CAPACITY'});
});
