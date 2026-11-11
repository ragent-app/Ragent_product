import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=await mkdtemp(join(await realpath(tmpdir()),'agentoc-local-cookie-'));
await mkdir(join(root,'config'));
await writeFile(join(root,'config','auth.json'),JSON.stringify({username:'fixture',passwordHash:'fixture'}));
Object.assign(process.env,{AGENTOC_WINDOWS_SERVICE_MODE:'1',AGENTOC_INSTANCE_ROOT:root,
  AGENTOC_CONFIG_DIR:join(root,'config'),AGENTOC_MEMORY_DIR:join(root,'memory'),
  AGENTOC_WORK_ROOT_DIR:join(root,'workspace'),AGENTOC_AUTH_SESSION_SECRET:'local-cookie-test-secret',AGENTOC_LOCAL_WEB_AUTH:'1'});
const auth=await import('../lib/auth.mjs');
const {requireAuth}=await import('../chat/middleware.mjs');
function request(cookie='',accept='text/html',extra={}){return {url:'/?desktop=manager',headers:{accept,cookie,...extra},socket:{remoteAddress:'127.0.0.1'}};}
function response(){return {headersSent:false,headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(s){this.status=s;},end(){}};}
try {
  const first=response();assert.equal(await requireAuth(request(),first),true);
  const cookie=first.headers['Set-Cookie'].split(';')[0];assert.equal(auth.sessions.size,1);
  for(let i=0;i<100;i++){const res=response();assert.equal(await requireAuth(request(cookie),res),true);assert.equal(res.headers['Set-Cookie'],undefined);}
  assert.equal(auth.sessions.size,1,'a valid local cookie must be reused');
  const passwordToken=await auth.issueSession({role:'owner'});
  const passwordCookie=`session_token=${passwordToken}`;
  const explicit=response();assert.equal(await requireAuth(request(passwordCookie),explicit),true);
  assert.equal(explicit.headers['Set-Cookie'],undefined,'a password owner session must not be replaced by a local-only session');
  const explicitTunnel=response();assert.equal(await requireAuth(request(passwordCookie,'text/html',{'x-agentoc-tunnel':'1'}),explicitTunnel),true);
  const tunneled=response();assert.equal(await requireAuth(request(cookie,'text/html',{'x-agentoc-tunnel':'1'}),tunneled),false);assert.equal(tunneled.status,302);
  for(let i=0;i<1000;i++){const probe=response();await requireAuth(request('','*/*'),probe);}
  assert.equal(auth.sessions.size,2,'cookie-free non-HTML probes must not mint sessions');
  console.log('local web session reuse, tunnel isolation, and cookie-free probes: passed');
} finally {auth.closeAuthSessionStore();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
