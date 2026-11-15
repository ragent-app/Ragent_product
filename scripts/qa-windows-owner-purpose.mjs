// Ordinary interactive Owner driver for a frozen, isolated v2 service batch.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,lstat,rename} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {requestOwnerBootstrap,requestOwnerBrowserBootstrap} from '../lib/windows-owner-bootstrap.mjs';
import {assertOrdinaryWindowsExecutionIdentity} from '../lib/windows-execution-identity.mjs';
import {ownerPurposeScenarios,ownerPurposePositive,ownerPurposeDeliveryFailure} from '../tests/fixtures/windows-service-owner-purpose-probe.mjs';
if(!process.argv.includes('--live-owner-purpose-v2'))throw new Error('Explicit --live-owner-purpose-v2 required');
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..'),evidence=join(source,'artifacts/showcase/T2-current-20261017/service-identities');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),prepared=JSON.parse(await readFile(join(evidence,'prepared.json'),'utf8'));
assert.equal(dirname(resolve(prepared.bundle)).toLowerCase(),evidence.toLowerCase());assert.match(basename(prepared.bundle),/^bundle-[a-f0-9]{32}$/);
const bytes=await readFile(join(prepared.bundle,'manifest.json'));assert.equal(hash(bytes),prepared.manifestSha256);
const spec=JSON.parse(bytes);assert.equal(spec.crossServiceOwnerBootstrap,true);assert.equal(spec.ownerPurposeV2,true);
const identity=await assertOrdinaryWindowsExecutionIdentity();assert.equal(identity.sid,spec.requestorSid);
for(const item of spec.sourceFiles)assert.equal(hash(await readFile(join(source,item.path))),item.sha256);
const index=JSON.parse(await readFile(join(prepared.bundle,'owner-files.json'),'utf8'));
for(const item of index.files)assert.equal(hash(await readFile(join(source,item.path))),item.sha256);
const root=join(process.env.ProgramData,'RagentIdentityQA','case-'+spec.caseId);
const report={caseId:spec.caseId,pass:false,protocolVersion:2,productionChanged:false,phoneTouched:false,providerUsed:false,
  actualPhoneOrTurn:false,credentialSource:'synthetic isolated signing key; original product SQLite auth and local UI broker',cases:[]};
let launchStatus,launchOutput='',launchError='';
async function production(){const {stdout}=await promisify(execFile)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`[pscustomobject]@{services=@(Get-CimInstance Win32_Service -Filter "Name='Ragent-ControlPlane' OR Name='Ragent-RunnerSupervisor'"|Sort-Object Name|Select-Object Name,State,ProcessId,StartName)}|ConvertTo-Json -Compress`],{windowsHide:true,timeout:10000});return JSON.parse(stdout.trim());}
const productionBefore=await production();await writeFile(join(prepared.bundle,'production-before.json'),JSON.stringify(productionBefore));
const launch=spawn(process.execPath,[join(source,'scripts/qa-windows-service-identities.mjs'),'--live'],{windowsHide:true,cwd:source,stdio:['ignore','pipe','pipe']});
launch.stdout.on('data',bytes=>{launchOutput=(launchOutput+bytes).slice(-32768);});launch.stderr.on('data',bytes=>{launchError=(launchError+bytes).slice(-32768);});
const finished=new Promise(done=>{launch.once('error',()=>{launchStatus=-1;done(-1);});launch.once('close',code=>{launchStatus=code;done(code);});});
async function waitJson(path,ms=30000){const until=Date.now()+ms;while(Date.now()<until){try{const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=131072);return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}if(launchStatus!==undefined)throw Object.assign(new Error('OBC_QA_SERVICE_ENDED'),{code:'OBC_QA_SERVICE_ENDED'});await new Promise(done=>setTimeout(done,40));}throw Object.assign(new Error('OBC_QA_DEADLINE'),{code:'OBC_QA_DEADLINE'});}
async function put(path,value){await writeFile(path+'.tmp',JSON.stringify(value),{flag:'wx'});await rename(path+'.tmp',path);}
async function ownerHttp(port,token){const response=await fetch(`http://127.0.0.1:${port}/api/owner-proof`,{headers:token?{Cookie:'session_token='+token}:{},redirect:'error',signal:AbortSignal.timeout(3000)});return {status:response.status,owner:(await response.json()).owner};}
async function exchange(port,ticket,nonce){const origin='http://127.0.0.1:'+port,response=await fetch(origin+'/api/auth/local-bootstrap',{
  method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({ticket,nonce,instance:spec.ownerInstanceId}),redirect:'error',signal:AbortSignal.timeout(3000)});
  const cookie=response.headers.get('set-cookie');assert.equal(await response.text(),'');return {status:response.status,cookie};}
// For expected rejection, body contains only the broker's fixed error code.
async function rejectedExchange(port,ticket,nonce){const origin='http://127.0.0.1:'+port,response=await fetch(origin+'/api/auth/local-bootstrap',{
  method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({ticket,nonce,instance:spec.ownerInstanceId}),redirect:'error',signal:AbortSignal.timeout(3000)});
  assert.equal(response.headers.get('set-cookie'),null);await response.arrayBuffer();return response.status;}
async function rawClient(policy,fault,onResult){
  const exe=join(prepared.bundle,'OwnerBootstrapRaw.exe');assert.equal(hash(await readFile(exe)),spec['OwnerBootstrapRaw.exe']);
  const child=spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});
  let output='',lineResolve;const firstLine=new Promise(done=>{lineResolve=done;});
  child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');if(output.length>32768)child.kill();if(output.includes('\n'))lineResolve();});child.stderr.resume();child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill(),14000),exit=new Promise(done=>{child.once('error',()=>{lineResolve();done(-1);});child.once('close',code=>{lineResolve();done(code);});});
  try{child.stdin.write(JSON.stringify({policy,fault})+'\n');if(!onResult)child.stdin.end();
    await firstLine;const event=JSON.parse(output.trim().split('\n')[0]);
    if(onResult){assert.equal(event.kind,'result');await onResult(event);child.stdin.end(JSON.stringify({release:true})+'\n');}
    const code=await exit;assert.equal(output.trim().split('\n').length,1);return {code,event};
  }finally{clearTimeout(timer);child.stdin.end();if(child.exitCode===null)child.kill();await exit;}
}
const options=policy=>({policy,executablePath:join(prepared.bundle,'OwnerBootstrap.exe'),executableSha256:spec['OwnerBootstrap.exe']});
try{
  for(const round of [1,2])for(const scenario of ownerPurposeScenarios){
    const prefix=`r${round}-owner-${scenario}-`,ready=await waitJson(join(root,'handoff/control',prefix+'ready.json'),round===1&&scenario===ownerPurposeScenarios[0]?180000:35000);
    assert.equal((await waitJson(join(root,'handoff/executor',prefix+'denied.json'))).denied,true);
    assert.deepEqual(ready.descriptor.policy,ready.policy);assert.deepEqual(ready.descriptor.peer,ready.peer);assert.equal(ready.policy.protocolVersion,2);
    const nonce=randomBytes(32).toString('hex'),policy={...ready.policy,peer:ready.peer,launchNonce:nonce},browser=policy.purpose==='browser';
    const positive=ownerPurposePositive.has(scenario),delivery=ownerPurposeDeliveryFailure.has(scenario),received=positive||delivery;
    let token='',ticket='',server,clientError='',owner,retiredRefused=false,nonceDenied=false,ticketNotCookie=false,ticketReplayDenied=false;
    if(ready.retired){await assert.rejects(requestOwnerBrowserBootstrap(options({...ready.retired.policy,peer:ready.retired.peer,launchNonce:nonce})),{code:'OBC_TRANSPORT_FAILED'});retiredRefused=true;}
    assert.deepEqual(await ownerHttp(ready.port),{status:401,owner:false});
    async function useTicket(value){assert.match(value,/^[a-f0-9]{64}$/);ticket=value;
      assert.deepEqual(await ownerHttp(ready.port,ticket),{status:401,owner:false});ticketNotCookie=true;
      assert.equal(await rejectedExchange(ready.port,ticket,'0'.repeat(64)),410);nonceDenied=true;
      const result=await exchange(ready.port,ticket,nonce);assert.equal(result.status,204);
      assert.match(result.cookie,/^session_token=[a-f0-9]{64};/);assert.ok(result.cookie.includes('; HttpOnly'));token=result.cookie.slice(14,78);
      assert.deepEqual(await ownerHttp(ready.port,token),{status:200,owner:true});
      assert.equal(await rejectedExchange(ready.port,ticket,nonce),410);ticketReplayDenied=true;
    }
    if(positive){
      const result=await (browser?requestOwnerBrowserBootstrap:requestOwnerBootstrap)(options(policy));server=result.server;
      if(browser){assert.equal(result.launchNonce,nonce);assert.equal(result.instanceId,spec.ownerInstanceId);await useTicket(result.bootstrapTicket);}else{token=result.sessionToken;assert.deepEqual(await ownerHttp(ready.port,token),{status:200,owner:true});}
    }else if(scenario==='browser-server-pin'){
      try{await requestOwnerBrowserBootstrap(options({...policy,peer:{...policy.peer,createdTicks:'1'}}));}catch(error){clientError=error.code;}assert.equal(clientError,'OBC_PEER_PIN_MISMATCH');
    }else{
      const fault=scenario.replace(/^(?:browser|cli)-/,''),raw=await rawClient(policy,fault,delivery?async event=>{server=event.facts;await useTicket(event.outcome.bootstrapTicket);}:null);
      if(delivery){assert.equal(raw.code,0);assert.equal(raw.event.kind,'result');}
      else if(scenario==='browser-disconnect'){assert.equal(raw.code,0);assert.equal(raw.event.kind,'disconnected');}
      else{assert.notEqual(raw.code,0);assert.equal(raw.event.kind,'error');clientError=raw.event.code;}
    }
    assert.equal(Boolean(token),received);
    if(received){assert.equal(server.sid,policy.controlSid);assert.equal(server.sessionId,0);assert.equal(server.pid,policy.peer.pid);assert.equal(server.createdTicks,policy.peer.createdTicks);assert.equal(server.queryOnlyAuthorityVerified,true);assert.equal(server.integrityRid,8192);assert.equal(server.elevated,false);assert.equal(server.enabledAdministrators,false);}
    await put(join(root,'control/inbox',prefix+'ack.json'),{received});
    const done=await waitJson(join(root,'handoff/control',prefix+'done.json'));assert.equal(done.pass,true);
    if(received){assert.deepEqual(await ownerHttp(ready.port,token),{status:401,owner:false});assert.equal(done.replayRefused,true);if(browser)assert.equal(await rejectedExchange(ready.port,ticket,nonce),410);}
    if(received)owner=done.peer;
    report.cases.push({round,scenario,purpose:policy.purpose,pass:true,...Object.fromEntries(['cliIssues','ticketIssues','cookieIssues','revocations','confirmations'].map(key=>[key,done[key]])),
      executorDenied:true,anonymousHttpDenied:true,publicationVerified:true,publicationWithdrawn:done.publicationWithdrawn,retiredRefused,
      authenticatedHttpAccepted:received,revokedHttpDenied:received,nonceDenied,ticketNotCookie,ticketReplayDenied,
      nativeReceiptConfirmed:positive,nativeReceiptFailureRevoked:delivery,server:ready.peer,...owner?{owner}:{},clientError,nativeError:done.nativeError});
    token='';ticket='';await put(join(root,'control/inbox',prefix+'finish.json'),{pass:true});
  }
  assert.equal(await finished,0);const summary=JSON.parse(await readFile(join(prepared.bundle,'summary.json'),'utf8'));assert.equal(summary.pass,true);assert.equal(summary.ownerHandoffRemoved,true);
  for(const item of [...spec.sourceFiles,...index.files])assert.equal(hash(await readFile(join(source,item.path))),item.sha256);
  assert.equal(report.cases.length,28);report.pass=true;
}catch(error){report.error=error.code||error.name;report.failedAfter=report.cases.length;await finished;}
finally{const productionAfter=await production();await writeFile(join(prepared.bundle,'production-after.json'),JSON.stringify(productionAfter));
  report.productionObservationUnchanged=JSON.stringify(productionBefore)===JSON.stringify(productionAfter);report.pass&&=report.productionObservationUnchanged;
  report.launchExitCode=launchStatus;report.completedAt=new Date().toISOString();await writeFile(join(prepared.bundle,'owner-purpose-client.json'),JSON.stringify(report,null,2));
  if(!report.pass)await writeFile(join(prepared.bundle,'owner-purpose-launch.json'),JSON.stringify({stdout:launchOutput,stderr:launchError}));}
console.log(JSON.stringify({caseId:report.caseId,pass:report.pass,checks:report.cases.length,bundle:prepared.bundle,error:report.error}));if(!report.pass)process.exitCode=1;
