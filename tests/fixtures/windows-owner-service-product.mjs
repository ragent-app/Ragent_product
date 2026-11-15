// Actual product server/auth/store and publication files; OS and native endpoint
// are explicitly substituted only in the positive branch of this isolated test.
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {registerHooks} from 'node:module';
import {mkdir,lstat,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createOwnerDiscoverySetController} from '../../lib/windows-owner-discovery-set.mjs';
import {createOwnerDiscoveryFileStore} from '../../lib/windows-owner-discovery-publication.mjs';
import {createOwnerBootstrapIssuer} from '../../lib/windows-owner-bootstrap-protocol.mjs';
assert.equal(process.platform,'win32');
const root=resolve(process.env.RAGENT_INSTANCE_ROOT||''),config=resolve(process.env.RAGENT_CONFIG_DIR||''),mode=process.argv[2];
assert.ok(process.env.RAGENT_TEST_INSTANCE_ID&&relative(root,config)==='config');assert.ok(![7690,7699].includes(Number(process.env.CHAT_PORT)));assert.equal(new URL(process.env.RAGENT_ACCOUNTS_URL).hostname,'127.0.0.1');
process.env.RAGENT_WINDOWS_SERVICE_MODE='1';process.env.RAGENT_WINDOWS_SERVICE_ROLE='control';process.env.RAGENT_LOCAL_WEB_AUTH='1';
const runtime=join(config,'native-owner');await mkdir(runtime);
const old=randomBytes(32).toString('hex');await writeFile(join(config,'auth-sessions.json'),JSON.stringify({[old]:{role:'owner',authMethod:'local_web',expiry:Date.now()+60000}}));
const life=new URL('../../lib/windows-owner-service.mjs',import.meta.url).href,serverUrl=new URL('../../chat-server.mjs',import.meta.url).href,authUrl=new URL('../../lib/auth.mjs',import.meta.url).href;
const positive=mode!=='refuse-context';
const activationUrl=new URL('../../lib/windows-owner-activation-service.mjs',import.meta.url).href;
const qa={endpoints:[],inspections:0,drained:false,authClosed:false};globalThis.__ownerServiceProduct=qa;
const paths={cli:join(runtime,'cli.json'),browser:join(runtime,'browser.json'),publisher:join(runtime,'publisher.json')};
qa.inspect=async context=>{assert.equal(resolve(context.instanceRoot),root);assert.equal(context.port,Number(process.env.CHAT_PORT));qa.inspections++;
  const installation={version:1,instanceId:context.instanceId,controlSid:'S-1-5-80-1-2-3-4-5',executorSid:'S-1-5-80-6-7-8-9-10',ownerSid:'S-1-5-21-1-2-3-1001',port:7690};
  return {releaseJson:JSON.stringify({version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)}),installationJson:JSON.stringify(installation),
    authority:{instanceId:context.instanceId,controlSid:installation.controlSid,ownerSid:installation.ownerSid,ownerSessionId:1,expiresAtUnixMs:Date.now()+(mode==='activation'?1500:15000)}};
};
qa.createSet=async options=>{
  assert.deepEqual(options.enabledPurposes,['cli']);const set=await createOwnerDiscoverySetController({...options,publisherStore:createOwnerDiscoveryFileStore({filePath:paths.publisher}),stores:Object.fromEntries(Object.entries(paths).filter(([p])=>p!=='publisher').map(([p,filePath])=>[p,createOwnerDiscoveryFileStore({filePath})])),
    serveEndpoint:async opts=>{let done,fail;const completion=new Promise((yes,no)=>{done=yes;fail=no;});completion.catch(()=>{});
      const peer={pid:100+qa.endpoints.length,createdTicks:'134368500000000000',sid:opts.policy.controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false};
      const endpoint={policy:opts.policy,issuer:createOwnerBootstrapIssuer(opts),done};qa.endpoints.push(endpoint);
      return {ready:{facts:peer,protectedDacl:true,firstInstance:true,rejectRemote:true},completion,close:async()=>{fail(Object.assign(Error('closed'),{code:'OBC_ENDPOINT_EXIT'}));await completion.catch(()=>{});}};
    }});
  return {...set,async close(){await set.close();for(const path of Object.values(paths)){await assert.rejects(lstat(path),{code:'ENOENT'});await assert.rejects(lstat(path+'.publisher-lock'),{code:'ENOENT'});}qa.drained=true;assert.equal(qa.authClosed,false);console.log('SERVICE_OWNER_DRAINED_BEFORE_AUTH_CLOSE');}};
};
qa.closeAuth=original=>{if(positive)assert.equal(qa.drained,true);original();qa.authClosed=true;console.log('SERVICE_AUTH_CLOSED');};
qa.serveActivation=async options=>{qa.activationOptions=options;let reject;const completion=new Promise((yes,no)=>{reject=no;});completion.catch(()=>{});options.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{code:'OBC_ABORTED'})),{once:true});return {completion,async close(){reject(Object.assign(Error('closed'),{code:'OBC_ABORTED'}));}};};
const sources={
  'qa:service-activation':`export const serveOwnerActivationOnce=globalThis.__ownerServiceProduct.serveActivation;`,
  'qa:service-trust':`export const inspectInstalledOwnerService=globalThis.__ownerServiceProduct.inspect; export async function inspectInstalledOwnerActivationService(context){const t=await inspectInstalledOwnerService(context);const {instanceId,controlSid,ownerSid}=t.authority;return {...t,binding:{domain:'owner.activation.v1',instanceId,controlSid,ownerSid,ownerSessionId:0}};}`,
  'qa:service-set':`export const createOwnerDiscoverySetController=globalThis.__ownerServiceProduct.createSet;`,
  'qa:service-auth':`import {closeAuthSessionStore as original} from ${JSON.stringify(authUrl)};export * from ${JSON.stringify(authUrl)};export const closeAuthSessionStore=()=>globalThis.__ownerServiceProduct.closeAuth(original);`,
};
registerHooks({resolve(specifier,context,next){let key;
  if(context.parentURL===life&&positive)key=({'./windows-owner-service-trust.mjs':'qa:service-trust','./windows-owner-discovery-set.mjs':'qa:service-set'})[specifier];
  if(context.parentURL===activationUrl&&positive)key=({'./windows-owner-service-trust.mjs':'qa:service-trust','./windows-owner-bootstrap.mjs':'qa:service-activation'})[specifier];
  if(context.parentURL===serverUrl&&specifier==='./lib/auth.mjs')key='qa:service-auth';
  return key?{url:key,shortCircuit:true}:next(specifier,context);
},load(url,context,next){return sources[url]?{format:'module',source:sources[url],shortCircuit:true}:next(url,context);}});
try{
  await import(serverUrl);const auth=await import(authUrl),origin='http://127.0.0.1:'+process.env.CHAT_PORT,requests=new AbortController();
  const call=(path,options={})=>new Promise((resolve,reject)=>{
    let result;const req=httpRequest(origin+path,{agent:false,signal:requests.signal,...options},response=>{
      result={status:response.statusCode,headers:{get:key=>{const value=response.headers[key.toLowerCase()];return Array.isArray(value)?value.join('; '):value??null;}}};
      response.on('error',reject);response.resume();
    });req.on('error',reject);req.on('close',()=>result?resolve(result):reject(Error('HTTP fixture closed without response')));req.end();
  });
  const callOwnerActivationHealth=()=>new Promise((resolve,reject)=>{
    const req=httpRequest(origin+'/healthz/owner-activation',{agent:false,signal:requests.signal},response=>{
      const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size<=8192)chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}});
    });req.on('error',reject);req.end();
  });
  if(positive){
    for(let i=0;i<100&&!qa.activationOptions;i++)await new Promise(done=>setTimeout(done,20));
    const p=qa.activationOptions.policy,facts={pid:999,createdTicks:'134368500000000000',sid:p.ownerSid,sessionId:1,integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true};
    const lease=await qa.activationOptions.activate({facts,frame:{version:1,operation:'owner.activation.request',instanceId:p.instanceId,requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+10000,challenge:randomBytes(32).toString('base64url'),launchNonce:randomBytes(32).toString('hex')}},p);await lease.commit();await lease.complete();
  }
  let health;for(let i=0;i<120;i++){try{health=await call('/healthz');if(positive?health.status===200&&qa.endpoints.length>0:health.status===503)break;}catch{}await new Promise(done=>setTimeout(done,50));}
  assert.equal(health.status,positive?200:503);
  const activationHealth=await callOwnerActivationHealth();assert.equal(activationHealth.status,positive?200:503);assert.equal(activationHealth.body.ok,positive);assert.equal(activationHealth.body.ownerActivation?.ready,positive);
  if(!positive)assert.match(activationHealth.body.ownerActivation?.code||'OSV_UNAVAILABLE',/^(OBC|OBD|OSV|OBP|OBS)_[A-Z_]+$/);
  assert.equal((await call('/api/auth/me')).status,401);const html=await call('/',{headers:{Accept:'text/html'}});assert.equal(html.status,200);assert.match(html.headers.get('set-cookie'),/^session_token=/);
  assert.equal((await call('/api/auth/me',{headers:{Cookie:'session_token='+old}})).status,200);
  if(positive){
    assert.equal(qa.inspections,2);assert.equal(qa.endpoints.length,1);const first=qa.endpoints[0];assert.equal(first.policy.purpose,'cli');await assert.rejects(lstat(paths.browser),{code:'ENOENT'});
    const facts={pid:999,createdTicks:'134368500000000000',sid:first.policy.ownerSid,sessionId:1,integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true};
    const frame={version:2,operation:'owner.cli',instanceId:first.policy.instanceId,requestId:first.policy.requestId,expiresAtUnixMs:first.policy.expiresAtUnixMs,challenge:randomBytes(32).toString('base64url'),launchNonce:randomBytes(32).toString('hex')};
    await assert.rejects(first.issuer.accept({kind:'request',facts:{...facts,sid:'S-1-5-80-6-7-8-9-10'},frame}),{code:'OBC_PEER_IDENTITY_DENIED'});
    const result=await first.issuer.accept({kind:'request',facts,frame});const cookie='session_token='+result.sessionToken;
    assert.equal((await call('/api/auth/me',{headers:{Cookie:cookie}})).status,200);first.done({issued:true});
    for(let i=0;i<100&&qa.endpoints.length!==2;i++)await new Promise(done=>setTimeout(done,15));assert.equal(qa.endpoints.length,2);
    for(let i=0;i<100;i++){try{const live=JSON.parse(await readFile(paths.cli,'utf8'));if(live.policy.requestId===qa.endpoints[1].policy.requestId)break;}catch{}await new Promise(done=>setTimeout(done,15));}
    const live=JSON.parse(await readFile(paths.cli,'utf8'));assert.notEqual(live.policy.requestId,first.policy.requestId);assert.equal(live.policy.expiresAtUnixMs,first.policy.expiresAtUnixMs);assert.equal(qa.inspections,2);
    assert.equal(auth.revokeSession(result.sessionToken),true);assert.equal((await call('/api/auth/me',{headers:{Cookie:cookie}})).status,401);
  }else{assert.equal(qa.inspections,0);assert.equal(qa.endpoints.length,0);}
  if(mode==='activation'){
    const deadline=qa.endpoints[0].policy.expiresAtUnixMs;await new Promise(done=>setTimeout(done,Math.max(1,deadline-Date.now()+100)));
    for(let i=0;i<100;i++){try{await lstat(paths.cli);}catch(e){if(e.code==='ENOENT')break;}await new Promise(done=>setTimeout(done,15));}
    await assert.rejects(lstat(paths.cli),{code:'ENOENT'});assert.equal((await call('/healthz')).status,200); // listener, no grant
    for(const confirm of [false,true]){
      const p=qa.activationOptions.policy,facts={pid:999,createdTicks:'134368500000000000',sid:p.ownerSid,sessionId:1,integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true};
      const request={facts,frame:{version:1,operation:'owner.activation.request',instanceId:p.instanceId,requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+1000,challenge:randomBytes(32).toString('base64url'),launchNonce:randomBytes(32).toString('hex')}};
      const lease=await qa.activationOptions.activate(request,p),endpoint=qa.endpoints.at(-1);
      const frame={version:2,operation:'owner.cli',instanceId:p.instanceId,requestId:endpoint.policy.requestId,expiresAtUnixMs:endpoint.policy.expiresAtUnixMs,challenge:randomBytes(32).toString('base64url'),launchNonce:randomBytes(32).toString('hex')};
      await lease.commit();const result=await endpoint.issuer.accept({kind:'request',facts,frame}),cookie='session_token='+result.sessionToken;
      assert.equal((await call('/api/auth/me',{headers:{Cookie:cookie}})).status,200);
      if(confirm){await lease.complete();assert.equal(auth.revokeSession(result.sessionToken),true);}else await lease.rollback();
      assert.equal((await call('/api/auth/me',{headers:{Cookie:cookie}})).status,401);
    }
    console.log('OWNER_ACTIVATION_HTTP_SQLITE_PASS');
  }
  console.log('OWNER_SERVICE_PRODUCT_PASS '+JSON.stringify({mode,health:health.status,actualProductHttp:true,actualPublication:positive,actualSqlite:positive,nativeAndOsSubstituted:positive,actualFixedContextRefusal:!positive,localwebPreserved:true}));
  // These HTTP clients belong to the fixture, not to the shipped service.
  // Drain their bodies/abort their resources before asking that service to stop.
  requests.abort();await new Promise(done=>setImmediate(done));
  process.emit('SIGTERM');
}catch(error){console.error('OWNER_SERVICE_PRODUCT_FAIL',error.code||error.name,String(error.message||'').replace(/[a-f0-9]{64}/g,'[redacted]'));process.exitCode=1;process.emit('SIGTERM');}
