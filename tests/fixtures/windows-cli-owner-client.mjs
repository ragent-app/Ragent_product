// Test-only loader: actual HTTP client/bridge, substituted installed issuer and
// HTTP transport. No production test switch or path/policy override is added.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test,beforeEach,afterEach} from 'node:test';
if(process.platform!=='win32')Object.defineProperty(process,'platform',{value:'win32'});
process.env.CHAT_BIND_HOST='untrusted-default';process.env.CHAT_PORT='9999';delete process.env.AGENTOC_CHAT_BASE_URL;
for(const key of Object.keys(process.env))if(key.startsWith('AGENTOC_SESSION_CONTROL_'))delete process.env[key];
const clientUrl=new URL('../../lib/agentoc-http-client.mjs',import.meta.url).href;
const bridgeUrl=new URL('../../lib/windows-cli-owner-auth.mjs',import.meta.url).href;
const state={};globalThis.__cliOwnerQa=state;
const sources={
  'qa:config':`export const AUTH_FILE='NO-CREDENTIAL-READ';export const CHAT_PORT=7690;`,
  'qa:runtime':`export async function resolveCliIpcEndpoint(){globalThis.__cliOwnerQa.legacy++;throw Error('LEGACY_PIPE_USED');}`,
  'qa:fs':`export async function readFile(){globalThis.__cliOwnerQa.reads++;throw Error('CREDENTIAL_FILE_READ');}`,
  'qa:issuer':`export async function requestInstalledOwnerActivation(options){if(globalThis.__cliOwnerQa?.activate)await globalThis.__cliOwnerQa.activate(options);}
export async function requestInstalledOwnerBootstrap(options){return globalThis.__cliOwnerQa.issue(options);}`,
};
registerHooks({resolve(specifier,context,next){let key;
  if(context.parentURL===clientUrl)key=({'./config.mjs':'qa:config','./instance-runtime.mjs':'qa:runtime','fs/promises':'qa:fs'})[specifier];
  if(context.parentURL===bridgeUrl&&specifier==='./windows-owner-bootstrap.mjs')key='qa:issuer';
  return key?{url:key,shortCircuit:true}:next(specifier,context);
},load(url,context,next){return sources[url]?{format:'module',source:sources[url],shortCircuit:true}:next(url,context);}});
const {createAgentoCHttpClient:rawClient}=await import(clientUrl);
const {requestWindowsCliOwnerCookie}=await import(bridgeUrl);
const origin='http://127.0.0.1:7690';
const createAgentoCHttpClient=options=>rawClient({baseUrl:origin,...options});
const response=(status=200)=>new Response(JSON.stringify({ok:status===200}),{status});
beforeEach(()=>{Object.assign(state,{legacy:0,reads:0,calls:0,activations:0,activate:async options=>{assert.deepEqual(Object.keys(options),['signal']);state.activations++;},http:[],issue:async options=>{assert.deepEqual(Object.keys(options),['signal']);state.calls++;await Promise.resolve();return {baseUrl:origin,sessionToken:state.calls.toString(16).padStart(64,'0')};}});
  globalThis.fetch=async(url,options)=>{state.http.push({url,...options,headers:{...options.headers}});return response();};});
afterEach(()=>{assert.equal(state.legacy,0);assert.equal(state.reads,0);});
test('fixed target refuses aliases, ports, credentials and remote defaults before issuance',async()=>{
  for(const baseUrl of [undefined,'http://localhost:7690','http://127.0.0.1:7691','https://127.0.0.1:7690','http://127.0.0.1:7690/path','http://user@127.0.0.1:7690','http://remote:7690'])
    await assert.rejects(requestWindowsCliOwnerCookie({baseUrl}),{code:'CLI_OWNER_TARGET_REFUSED'});
  await assert.rejects(rawClient().request('/api/auth/me'),{code:'CLI_OWNER_TARGET_REFUSED'});
  assert.equal(state.calls,0);assert.equal(state.http.length,0);
  assert.equal(state.activations,0);
});
test('bridge forwards only abort signal and rejects malformed/native wrong target results',async()=>{
  const signal=new AbortController().signal;
  state.issue=async options=>{assert.deepEqual(options,{signal});return {baseUrl:origin,sessionToken:'c'.repeat(64)};};
  assert.equal(await requestWindowsCliOwnerCookie({baseUrl:origin+'/',signal,executablePath:'evil',policy:{}}),'session_token='+'c'.repeat(64));
  for(const result of [null,undefined,{baseUrl:origin,sessionToken:['c'.repeat(64)]},{baseUrl:origin,sessionToken:'bad'},{baseUrl:'http://remote',sessionToken:'c'.repeat(64)},{baseUrl:origin,sessionToken:'c'.repeat(64)+'\r\nX: y'}]){
    state.issue=async()=>result;await assert.rejects(requestWindowsCliOwnerCookie({baseUrl:origin}),{code:'CLI_OWNER_RESULT_INVALID'});
  }
});
test('pre-connection endpoint rotation retries authorization before any HTTP request',async()=>{
  for (const code of ['OBD_ENDPOINT_UNAVAILABLE','OBC_DEADLINE_INVALID']) {
    state.calls=0;state.activations=0;state.http=[];
    state.issue=async()=>{state.calls++;if(state.calls<3)throw Object.assign(Error(code),{code});return {baseUrl:origin,sessionToken:'a'.repeat(64)};};
    const result=await createAgentoCHttpClient().request('/api/fixture',{method:'POST',body:{value:'fixture'}});
    assert.equal(result.response.status,200);assert.equal(state.calls,3);assert.equal(state.activations,3);assert.equal(state.http.length,1);
  }
});
test('pre-connection retries are bounded and do not replay unconfirmed or trust failures',async()=>{
  for (const code of ['OBD_ENDPOINT_UNAVAILABLE','OBC_DEADLINE_INVALID']) {
    state.calls=0;state.activations=0;state.http=[];
    state.issue=async()=>{state.calls++;throw Object.assign(Error(code),{code});};
    await assert.rejects(createAgentoCHttpClient().request('/api/fixture',{method:'POST',body:{}}),{code});
    assert.equal(state.calls,3);assert.equal(state.activations,3);assert.equal(state.http.length,0);
  }
  for (const code of ['OBC_DELIVERY_UNCONFIRMED','OBC_PEER_DISCONNECTED','OBD_ENDPOINT_POLICY_INVALID']) {
    state.calls=0;state.activations=0;state.http=[];
    state.issue=async()=>{state.calls++;throw Object.assign(Error(code),{code});};
    await assert.rejects(createAgentoCHttpClient().request('/api/fixture',{method:'POST',body:{}}),{code});
    assert.equal(state.calls,1);assert.equal(state.activations,1);assert.equal(state.http.length,0);
  }
});
test('aborting authorization cancels a scheduled pre-connection retry',async()=>{
  const controller=new AbortController();state.calls=0;state.activations=0;
  state.issue=async()=>{state.calls++;controller.abort();throw Object.assign(Error('expired'),{code:'OBC_DEADLINE_INVALID'});};
  await assert.rejects(requestWindowsCliOwnerCookie({baseUrl:origin,signal:controller.signal}),{name:'AbortError'});
  assert.equal(state.calls,1);assert.equal(state.activations,1);assert.equal(state.http.length,0);
});
test('concurrent requests share one exchange and cache the cookie',async()=>{
  const client=createAgentoCHttpClient();await Promise.all(Array.from({length:12},()=>client.request('/api/auth/me')));await client.request('/api/auth/me');
  assert.equal(state.calls,1);assert.equal(state.http.length,13);for(const call of state.http){assert.equal(call.url,origin+'/api/auth/me');assert.equal(call.redirect,'manual');assert.equal(call.headers.Cookie,'session_token='+'1'.padStart(64,'0'));}
  assert.equal(state.activations,1);
});
test('trust and receipt failures propagate unchanged without HTTP/password/legacy fallback; a later explicit attempt can retry',async()=>{
  const activationError=Object.assign(Error('OBC_ACTIVATION_REFUSED'),{code:'OBC_ACTIVATION_REFUSED'}),activate=state.activate;
  state.activate=async()=>{throw activationError;};await assert.rejects(createAgentoCHttpClient().request('/api/auth/me'),e=>e===activationError);
  assert.equal(state.calls,0);assert.equal(state.http.length,0);state.activate=activate;
  let lastClient;
  for(const code of ['OBD_RELEASE_NOT_INSTALLED','OBC_PEER_MISMATCH','OBC_RECEIPT_FAILED']){
    const error=Object.assign(Error(code),{code});state.issue=async()=>{throw error;};const client=createAgentoCHttpClient({authToken:'legacy-token'});
    lastClient=client;
    await assert.rejects(client.request('/api/auth/me'),e=>e===error);await assert.rejects(client.request('/api/auth/me'),e=>e===error);
  }
  assert.equal(state.http.length,0);
  state.issue=async()=>({baseUrl:origin,sessionToken:'d'.repeat(64)});assert.equal((await lastClient.request('/api/auth/me')).response.status,200);
});
test('GET/HEAD 401 renews once; a second 401 is returned without an infinite loop',async()=>{
  globalThis.fetch=async(url,options)=>{state.http.push({url,...options});return response(401);};
  for(const method of ['GET','HEAD']){state.calls=0;state.http=[];assert.equal((await createAgentoCHttpClient().request('/api/auth/me',{method})).response.status,401);assert.equal(state.calls,2);assert.equal(state.http.length,2);}
});
test('late concurrent 401 uses the already renewed cookie instead of minting again',async()=>{
  let release;const late=new Promise(done=>{release=done;});let oldReads=0;
  globalThis.fetch=async(url,options)=>{const cookie=options.headers.Cookie;state.http.push({cookie});if(cookie.endsWith('1'.padStart(64,'0'))){if(++oldReads===2)await late;return response(401);}release();return response();};
  const client=createAgentoCHttpClient();const results=await Promise.all([client.request('/a'),client.request('/b')]);assert.ok(results.every(r=>r.response.status===200));assert.equal(state.calls,2);assert.equal(state.http.length,4);
});
test('403 does not renew and writes are never replayed on 401/403',async()=>{
  for(const method of ['GET','POST','PUT','PATCH','DELETE'])for(const status of [401,403]){
    if(method==='GET'&&status===401)continue;state.calls=0;state.http=[];
    globalThis.fetch=async(url,options)=>{state.http.push({url,...options});return response(status);};
    assert.equal((await createAgentoCHttpClient().request('/operation',{method,body:method==='GET'?undefined:{synthetic:true}})).response.status,status);
    assert.equal(state.calls,1);assert.equal(state.http.length,1);
  }
});
test('explicit capability and session-control requests never acquire Owner on denial',async()=>{
  globalThis.fetch=async(url,options)=>{state.http.push({url,...options,headers:{...options.headers}});return response(403);};
  const capabilities=[{capabilityToken:'synthetic-capability'},{sessionControlToken:'synthetic-sc',sessionControlRunId:'run',sessionControlSessionId:'session',sessionControlTurnId:'turn'}];
  for(const options of capabilities)assert.equal((await createAgentoCHttpClient(options).request('/operation')).response.status,403);
  assert.equal(state.calls,0);assert.ok(state.http.every(r=>!r.headers.Cookie));assert.equal(state.http[0].headers.Authorization,'Bearer synthetic-capability');assert.equal(state.http[1].headers['x-agentoc-session-control-token'],'synthetic-sc');
});
test('explicit cookie is retained; explicit remote target does not receive a native Owner cookie',async()=>{
  for(const baseUrl of [origin,'http://explicit-remote:8888'])await createAgentoCHttpClient({baseUrl,authCookie:'session_token=explicit'}).request('/api/auth/me');
  assert.equal(state.calls,0);assert.equal(state.http.length,2);assert.ok(state.http.every(r=>r.headers.Cookie==='session_token=explicit'));
});
