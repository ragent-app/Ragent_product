// Product process/HTTP/SQLite test; native issuer substituted only in CLI child.
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {randomBytes} from 'node:crypto';
const root=resolve(process.env.RAGENT_INSTANCE_ROOT||''),config=resolve(process.env.RAGENT_CONFIG_DIR||'');
assert.ok(process.env.RAGENT_TEST_INSTANCE_ID&&relative(root,config)==='config');assert.ok(![7690,7699].includes(Number(process.env.CHAT_PORT)));
assert.equal(new URL(process.env.RAGENT_ACCOUNTS_URL).hostname,'127.0.0.1');
process.env.RAGENT_LOCAL_WEB_AUTH='1';
const old=randomBytes(32).toString('hex');await writeFile(join(config,'auth-sessions.json'),JSON.stringify({[old]:{role:'owner',authMethod:'local_web',expiry:Date.now()+60000}}));
const exec=promisify(execFile);
try{
  await import('../../chat-server.mjs');const auth=await import('../../lib/auth.mjs');const origin='http://127.0.0.1:'+process.env.CHAT_PORT;
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/healthz')).status===200){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,50));}assert.equal(ready,true);
  const call=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
  assert.equal((await call('/api/auth/me')).status,401);
  const html=await call('/',{headers:{Accept:'text/html'}});assert.equal(html.status,200);assert.match(html.headers.get('set-cookie'),/^session_token=/);
  assert.equal((await call('/api/auth/me',{headers:{Cookie:html.headers.get('set-cookie').split(';')[0]}})).status,200);
  assert.equal((await call('/api/auth/me',{headers:{Cookie:'session_token='+old}})).status,200);
  const endpoint=await (await import('../../lib/instance-runtime.mjs')).resolveCliIpcEndpoint();
  const legacy=await new Promise((done,reject)=>{const req=http.request({socketPath:endpoint,path:'/api/cli/auth',method:'POST',headers:{'Content-Type':'application/json'}},res=>{let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>done({status:res.statusCode,cookie:res.headers['set-cookie'],body:JSON.parse(data)}));});req.setTimeout(3000,()=>req.destroy(Error('LEGACY_PIPE_TIMEOUT')));req.on('error',reject);req.end();});
  if(process.platform==='win32'){assert.equal(legacy.status,503);assert.equal(legacy.cookie,undefined);assert.equal(legacy.body.code,'CLI_NATIVE_OWNER_REQUIRED');}
  else{assert.equal(legacy.status,201);assert.ok(legacy.cookie);}
  assert.equal((await call('/api/cli/auth',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status,404);
  const token=await auth.issueSession({role:'owner',authMethod:'cli-native-qa'});
  const cliExits=[];
  const invoke=async mode=>{const task=exec(process.execPath,['--import','./tests/fixtures/windows-cli-product-preload.mjs','cli.js','api','GET','/api/auth/me','--base-url','http://127.0.0.1:7690'],{cwd:new URL('../..',import.meta.url),windowsHide:true,timeout:8000,maxBuffer:65536,env:{...process.env,QA_CLI_HTTP_ORIGIN:origin,QA_CLI_SESSION_TOKEN:token,QA_CLI_MODE:mode}});const startedAt=new Date().toISOString();
    try{const result=await task;cliExits.push({pid:task.child.pid,mode,exitCode:0,startedAt,finishedAt:new Date().toISOString()});return result;}
    catch(error){cliExits.push({pid:task.child.pid,mode,exitCode:error.code,startedAt,finishedAt:new Date().toISOString()});throw error;}
  };
  const ok=await invoke('ok');assert.equal(JSON.parse(ok.stdout).role,'owner');assert.match(ok.stderr,/QA_CLI_FETCHES=1/);assert.ok(!ok.stdout.includes(token));
  assert.equal(auth.revokeSession(token),true);
  await assert.rejects(invoke('ok'),error=>{if(error.code!==1)console.error('QA_REVOKED_CHILD_EXIT',error.code,String(error.stderr||'').replace(/[a-f0-9]{64}/g,'[redacted]'));assert.equal(error.code,1);assert.match(error.stderr,/QA_CLI_FETCHES=2/);assert.ok(!error.stderr.includes(token));return true;});
  await assert.rejects(invoke('refuse'),error=>{assert.equal(error.code,1);assert.match(error.stderr,/OBD_SYNTHETIC_REFUSAL/);assert.match(error.stderr,/QA_CLI_FETCHES=0/);return true;});
  let actualInstalledRefusal=false;
  if(process.platform==='win32'&&process.env.QA_VERIFY_INSTALLED_REFUSAL==='1'){
    await assert.rejects(invoke('installed-refuse'),error=>{assert.equal(error.code,1);assert.match(error.stderr,/OBD_RELEASE_NOT_INSTALLED/);assert.match(error.stderr,/QA_CLI_FETCHES=0/);return true;});actualInstalledRefusal=true;
  }
  assert.ok(cliExits.every(child=>Number.isSafeInteger(child.pid)&&child.pid>0));
  console.log('WINDOWS_CLI_PRODUCT_PASS '+JSON.stringify({actualCliProcess:true,actualHttpAuth:true,actualSqliteRevoke:true,localwebHtmlAndOldSessionPreserved:true,legacyPipe:process.platform==='win32'?'503-no-cookie':'201-unix-compatible',tcpCliAuth:404,issuerSubstituted:true,nativeInstalledTrust:false,actualInstalledRefusal,platformSimulatedInChild:process.platform!=='win32',cliExits}));
  process.emit('SIGTERM');
}catch(error){console.error('WINDOWS_CLI_PRODUCT_FAIL',error.code||error.name,String(error.message||'').replace(/[a-f0-9]{64}/g,'[redacted]'));process.exit(1);}
