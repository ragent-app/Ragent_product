import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile,mkdir,symlink,unlink,link} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {request} from 'node:http';
import {bootstrapFixture} from './helpers/local-ui-bootstrap-fixture.mjs';
import {createLocalUiBootstrap,createLocalUiBootstrapClaimStore} from '../lib/local-ui-bootstrap.mjs';
const nonce=()=>randomBytes(32).toString('hex');
test('fragment-only private issue exchanges once for HttpOnly cookie; claim has hashes only',async t=>{
  const f=await bootstrapFixture(t),issued=f.issue(),url=new URL(issued.url);assert.equal(url.search,'');assert.ok(url.hash);
  const result=await f.send(issued);assert.equal(result.status,204);assert.equal(result.text,'');assert.equal(f.issued(),1);
  const cookie=result.headers['set-cookie'][0];assert.match(cookie,/^session_token=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\//);
  assert.equal(result.headers['cache-control'],'no-store, max-age=0');
  assert.equal((await f.send(issued)).status,410);assert.equal(f.issued(),1);
  const files=await readdir(f.root);assert.equal(files.length,1);const stored=await readFile(join(f.root,files[0]),'utf8');
  assert.equal(stored.includes(f.payload(issued).ticket),false);assert.equal(stored.includes(f.payload(issued).nonce),false);assert.equal(stored.includes(cookie.split('=')[1].split(';')[0]),false);
  assert.equal(JSON.parse(stored).instance,f.instanceId);assert.equal(JSON.parse(stored).version,1);
});
test('actual concurrent exchanges consume before async claim/issuer and mint once',async t=>{
  let minted=0;const f=await bootstrapFixture(t,{issueOwnerSession:async()=>{await new Promise(done=>setTimeout(done,30));minted++;return nonce();}}),value=f.issue();
  const results=await Promise.all(Array.from({length:12},()=>f.send(value)));assert.equal(results.filter(x=>x.status===204).length,1);assert.equal(results.filter(x=>x.status===410).length,11);assert.equal(minted,1);
});
test('exact Host/Origin, duplicate headers and forwarding/Fetch Metadata deny before issuance',async t=>{
  const f=await bootstrapFixture(t),value=f.issue();
  const bad=[{Host:'evil.example:'+f.port},{Host:'localhost:'+f.port},{Host:'127.1:'+f.port},{Host:'127.0.0.1:'+String(f.port+1)},
    {Origin:'null'},{Origin:undefined},{Origin:f.origin+'/'},{Origin:'http://127.0.0.1:'+String(f.port+1)},
    {'Sec-Fetch-Site':'same-site'},{'Sec-Fetch-Site':'cross-site'},{'X-Ragent-Tunnel':'1'},{Forwarded:'for=127.0.0.1'}, {'X-Forwarded-Host':'127.0.0.1:'+f.port},{Via:'test'}];
  for(const headers of bad){if(headers.Origin===undefined&&Object.hasOwn(headers,'Origin'))headers.Origin='';const result=await f.send(value,{headers});assert.equal(result.status,403,JSON.stringify(headers));assert.equal(result.headers['set-cookie'],undefined);}
  for(const name of ['Host','Origin']){
    const raw=['Host','127.0.0.1:'+f.port,'Origin',f.origin,'Content-Type','application/json',name,name==='Host'?'127.0.0.1:'+f.port:f.origin];
    assert.equal((await f.send(value,{raw})).status,403);
  }
  assert.equal(f.issued(),0);assert.equal((await f.send(value)).status,204);
});
test('method/query/body content-type/size and unknown fields refuse without minting',async t=>{
  const f=await bootstrapFixture(t),value=f.issue();
  for(const options of [{method:'GET'},{method:'OPTIONS'},{path:'/api/auth/local-bootstrap?ticket=bad'},
    {headers:{'Content-Type':'text/plain'}},{headers:{'Content-Encoding':'gzip'}},{bodyText:'{bad'}, {bodyText:'x'.repeat(1100)},
    {bodyText:JSON.stringify({...f.payload(value),redirect:'https://evil.example'})}]){
    const result=await f.send(value,options);assert.ok([400,410].includes(result.status));assert.equal(result.headers['set-cookie'],undefined);
  }
  assert.equal(f.issued(),0);assert.equal((await f.send(value)).status,204);
});
test('binding/instance/nonce/expiry refuse; changing nonce cannot consume the legitimate launch',async t=>{
  let now=Date.now();const f=await bootstrapFixture(t,{clock:()=>now}),value=f.issue(),payload=f.payload(value);
  for(const patch of [{nonce:nonce()},{instance:randomUUID()},{ticket:nonce()}])assert.equal((await f.send(value,{bodyText:JSON.stringify({...payload,...patch})})).status,410);
  assert.equal(f.issued(),0);now=value.expiresAtUnixMs;assert.equal((await f.send(value)).status,410);assert.equal(f.issued(),0);
});
test('claim fsync failure burns ticket, mints zero, and redacts internal errors',async t=>{
  const f=await bootstrapFixture(t,{claimStore:{claim:async()=>{throw new Error('SECRET/PATH/SHOULD/NOT/LEAK');}}}),value=f.issue();
  const result=await f.send(value);assert.equal(result.status,503);assert.equal(result.text,'{"code":"LUB_UNAVAILABLE"}');assert.equal(f.issued(),0);assert.equal((await f.send(value)).status,410);
});
test('issuer failure burns a durably claimed ticket; no retry after unknown side effect',async t=>{
  let attempts=0;const f=await bootstrapFixture(t,{issueOwnerSession:async()=>{attempts++;throw new Error('SECRET');}}),value=f.issue();
  assert.equal((await f.send(value)).status,503);assert.equal((await readdir(f.root)).length,1);assert.equal((await f.send(value)).status,410);assert.equal(attempts,1);
});
test('close/expiry during issuance revokes late token and emits no cookie',async t=>{
  for(const reason of ['close','expire']){
    let now=Date.now(),entered,finish,revoked='';const waiting=new Promise(done=>{entered=done;});
    const f=await bootstrapFixture(t,{clock:()=>now,issueOwnerSession:()=>{entered();return new Promise(done=>{finish=done;});},revokeOwnerSession:async token=>{revoked=token;}}),value=f.issue();
    const pending=f.send(value);await waiting;if(reason==='close')f.component.close();else now=value.expiresAtUnixMs;
    const token=nonce();finish(token);const result=await pending;assert.equal(result.status,410);assert.equal(result.headers['set-cookie'],undefined);assert.equal(revoked,token);
  }
});
test('closed/new broker generation cannot adopt outstanding URLs after restart',async t=>{
  const f=await bootstrapFixture(t),value=f.issue();f.component.close();assert.equal((await f.send(value)).status,410);assert.throws(()=>f.issue(),{code:'LUB_CLOSED'});
  const other=await bootstrapFixture(t,{instanceId:f.instanceId});assert.equal((await other.send(value)).status,410);assert.equal(other.issued(),0);
});
test('ticket budgets and explicit authority deadline are bounded',async t=>{
  const f=await bootstrapFixture(t);for(const expiresAtUnixMs of [0,Date.now()+61000])assert.throws(()=>f.component.issue({launchNonce:nonce(),expiresAtUnixMs}),{code:'LUB_BINDING_INVALID'});
  for(let i=0;i<32;i++)f.issue();assert.throws(()=>f.issue(),{code:'LUB_CAPACITY'});assert.equal(f.issued(),0);
  const options={instanceId:randomUUID(),claimStore:f.store,issueOwnerSession:async()=>nonce(),revokeOwnerSession:async()=>{},setCookie:()=>''};
  for(const origin of ['http://127.1:7690','http://127.0.0.1:80','https://127.0.0.1:7690','http://user@localhost:7690','http://localhost:7690/'])assert.throws(()=>createLocalUiBootstrap({...options,origin}),{code:'LUB_ORIGIN_INVALID'});
});
test('actual claim exclusivity, existing hardlink and junction refuse without altering target',async t=>{
  const f=await bootstrapFixture(t),record={version:1,generation:randomUUID(),instance:randomUUID(),ticketHash:nonce(),nonceHash:nonce(),expiresAtUnixMs:Date.now()+30000};
  await f.store.claim(record);await assert.rejects(f.store.claim(record),{code:'EEXIST'});
  const file=join(f.root,record.generation+'-'+record.ticketHash+'.json'),other=join(f.root,'second-link');await link(file,other);
  await assert.rejects(f.store.claim(record),{code:'EEXIST'});assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),createHash('sha256').update(await readFile(other)).digest('hex'));await unlink(other);
  const target=join(f.root,'target'),alias=join(f.root,'alias');await mkdir(target);await symlink(target,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(createLocalUiBootstrapClaimStore({directory:alias}).claim({...record,ticketHash:nonce()}),{code:'LUB_STORE_UNSAFE'});await unlink(alias);
});
test('expired while claim flushes cannot reach issuer; per-generation durable claim budget stops at 128',async t=>{
  let now=Date.now(),expired=false;const f=await bootstrapFixture(t,{clock:()=>now,claimStore:{claim:async record=>{if(expired)now=record.expiresAtUnixMs;}}});
  const first=f.issue();expired=true;assert.equal((await f.send(first)).status,410);assert.equal(f.issued(),0);expired=false;now=Date.now();
  for(let i=1;i<128;i++){const value=f.issue();assert.equal((await f.send(value)).status,204);}
  assert.throws(()=>f.issue(),{code:'LUB_CAPACITY'});
});
test('blocked issuer concurrency stays bounded without consuming the fifth private ticket',async t=>{
  const completions=[];let calls=0;const f=await bootstrapFixture(t,{issueOwnerSession:()=>{calls++;return new Promise(done=>completions.push(()=>done(nonce())));}});
  const held=Array.from({length:4},()=>f.send(f.issue())),fifth=f.issue();
  for(let i=0;i<100&&calls<4;i++)await new Promise(done=>setTimeout(done,10));assert.equal(calls,4);
  assert.equal((await f.send(fifth)).status,503);assert.equal(calls,4);for(const done of completions)done();assert.ok((await Promise.all(held)).every(x=>x.status===204));
  const next=f.send(fifth);for(let i=0;i<100&&calls<5;i++)await new Promise(done=>setTimeout(done,10));completions[4]();assert.equal((await next).status,204);
});
test('actual HTTP disconnect during mint revokes late session without restoring ticket',async t=>{
  let entered,finish,revoked='';const waiting=new Promise(done=>{entered=done;}),f=await bootstrapFixture(t,{issueOwnerSession:()=>{entered();return new Promise(done=>{finish=done;});},revokeOwnerSession:async token=>{revoked=token;}}),value=f.issue();
  const req=request({hostname:'127.0.0.1',port:f.port,path:'/api/auth/local-bootstrap',method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'}},res=>res.resume());
  req.on('error',()=>{});req.end(JSON.stringify(f.payload(value)));await waiting;req.destroy();
  await new Promise(done=>setTimeout(done,20));const token=nonce();finish(token);
  for(let i=0;i<100&&!revoked;i++)await new Promise(done=>setTimeout(done,10));assert.equal(revoked,token);assert.equal((await f.send(value)).status,410);
});
test('actual stalled body times out and cannot hold or mint an Owner session',async t=>{
  const f=await bootstrapFixture(t),value=f.issue();
  const result=await new Promise((done,reject)=>{
    const req=request({hostname:'127.0.0.1',port:f.port,path:'/api/auth/local-bootstrap',method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','Content-Length':'100'}},res=>{res.resume();res.on('end',()=>done(res.statusCode));});
    req.on('error',reject);req.write('{');
  });assert.equal(result,400);assert.equal(f.issued(),0);assert.equal((await f.send(value)).status,204);
});
