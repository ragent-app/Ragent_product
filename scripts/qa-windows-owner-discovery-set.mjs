// Ordinary interactive Owner driver for a frozen, isolated paired-discovery service batch.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,lstat,rename} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {requestOwnerBootstrap,requestOwnerBrowserBootstrap} from '../lib/windows-owner-bootstrap.mjs';
import {assertOrdinaryWindowsExecutionIdentity} from '../lib/windows-execution-identity.mjs';
import {ownerSetScenarios,ownerSetPurposes} from '../tests/fixtures/windows-service-owner-set-probe.mjs';
if(!process.argv.includes('--live-owner-discovery-set'))throw new Error('Explicit --live-owner-discovery-set required');
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..'),evidence=join(source,'artifacts/showcase/T2-current-20261017/service-identities');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),prepared=JSON.parse(await readFile(join(evidence,'prepared.json'),'utf8'));
assert.equal(dirname(resolve(prepared.bundle)).toLowerCase(),evidence.toLowerCase());assert.match(basename(prepared.bundle),/^bundle-[a-f0-9]{32}$/);
const bytes=await readFile(join(prepared.bundle,'manifest.json'));assert.equal(hash(bytes),prepared.manifestSha256);
const spec=JSON.parse(bytes);assert.equal(spec.crossServiceOwnerBootstrap,true);assert.equal(spec.ownerPurposeV2,true);assert.equal(spec.ownerDiscoverySet,true);
const identity=await assertOrdinaryWindowsExecutionIdentity();assert.equal(identity.sid,spec.requestorSid);
for(const item of spec.sourceFiles)assert.equal(hash(await readFile(join(source,item.path))),item.sha256);
const index=JSON.parse(await readFile(join(prepared.bundle,'owner-files.json'),'utf8'));
for(const item of index.files)assert.equal(hash(await readFile(join(source,item.path))),item.sha256);
const root=join(process.env.ProgramData,'RagentIdentityQA','case-'+spec.caseId);
const report={caseId:spec.caseId,pass:false,protocolVersion:2,productionChanged:false,phoneTouched:false,providerUsed:false,
  actualPhoneOrTurn:false,credentialSource:'synthetic isolated signing key; original product SQLite auth and local UI broker',cases:[]};
let launchStatus,launchOutput='',launchError='',stage='waiting-first-ready';
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
  for(const round of [1,2])for(const scenario of ownerSetScenarios){
    stage=`round-${round}/${scenario}/ready`;
    const prefix=`r${round}-owner-${scenario}-`,ready=await waitJson(join(root,'handoff/control',prefix+'ready.json'),round===1&&scenario===ownerSetScenarios[0]?180000:35000);
    const denial=await waitJson(join(root,'handoff/executor',prefix+'denied.json'));assert.equal(denial.denials.length,2);assert.ok(denial.denials.every(x=>x.denied));
    const controlSid=ready.authority.controlSid;assert.match(controlSid,/^S-1-5-80-(?:\d+-){4}\d+$/);
    const nonces={cli:randomBytes(32).toString('hex'),browser:randomBytes(32).toString('hex')},tokens={},servers={};let ticket='',ticketNotCookie=false,nonceDenied=false,replayDenied=false;
    const policy=(channels,p)=>({...channels[p].descriptor.policy,peer:channels[p].peer,launchNonce:nonces[p]});
    function validateChannels(channels){for(const p of ownerSetPurposes){const {descriptor,peer}=channels[p];assert.equal(descriptor.policy.protocolVersion,2);assert.equal(descriptor.policy.purpose,p);
      assert.equal(descriptor.policy.expiresAtUnixMs,ready.authority.expiresAtUnixMs);assert.equal(descriptor.policy.instanceId,spec.ownerInstanceId);assert.deepEqual(descriptor.peer,peer);
      assert.equal(descriptor.policy.controlSid,controlSid);assert.equal(peer.sid,controlSid);assert.equal(peer.sessionId,0);assert.equal(peer.integrityRid,8192);assert.equal(peer.elevated,false);assert.equal(peer.enabledAdministrators,false);}
      assert.notEqual(channels.cli.descriptor.policy.pipeName,channels.browser.descriptor.policy.pipeName);assert.notEqual(channels.cli.descriptor.policy.requestId,channels.browser.descriptor.policy.requestId);}
    stage=`round-${round}/${scenario}/validate-pair`;validateChannels(ready.channels);assert.deepEqual(await ownerHttp(ready.port),{status:401,owner:false});
    async function acceptTicket(value){ticket=value;assert.match(ticket,/^[a-f0-9]{64}$/);assert.deepEqual(await ownerHttp(ready.port,ticket),{status:401,owner:false});ticketNotCookie=true;
      assert.equal(await rejectedExchange(ready.port,ticket,'0'.repeat(64)),410);nonceDenied=true;
      const response=await exchange(ready.port,ticket,nonces.browser);assert.equal(response.status,204);assert.match(response.cookie,/^session_token=[a-f0-9]{64};/);assert.ok(response.cookie.includes('; HttpOnly'));
      tokens.browser=response.cookie.slice(14,78);assert.deepEqual(await ownerHttp(ready.port,tokens.browser),{status:200,owner:true});
      assert.equal(await rejectedExchange(ready.port,ticket,nonces.browser),410);replayDenied=true;
    }
    async function client(channels,p){const result=await (p==='cli'?requestOwnerBootstrap:requestOwnerBrowserBootstrap)(options(policy(channels,p)));servers[p]=result.server;
      assert.equal(result.server.queryOnlyAuthorityVerified,true);assert.equal(result.server.pid,channels[p].peer.pid);assert.equal(result.server.createdTicks,channels[p].peer.createdTicks);
      if(p==='cli'){tokens.cli=result.sessionToken;assert.match(tokens.cli,/^[a-f0-9]{64}$/);assert.deepEqual(await ownerHttp(ready.port,tokens.cli),{status:200,owner:true});}
      else{assert.equal(result.launchNonce,nonces.browser);assert.equal(result.instanceId,spec.ownerInstanceId);await acceptTicket(result.bootstrapTicket);}}
    let channels=ready.channels,after,retiredRefusals=0,closeRefusals=0,browserFailureCookieRevoked=false;
    async function step(action){await put(join(root,'control/inbox',prefix+'step.json'),{action});after=await waitJson(join(root,'handoff/control',prefix+'after-step.json'));validateChannels(after.channels);return after;}
    stage=`round-${round}/${scenario}/exercise`;
    if(scenario.endsWith('-refresh')){
      await step('refresh');const p=after.retired.purpose,other=p==='cli'?'browser':'cli';assert.equal(after.otherPreserved,true);assert.deepEqual(after.channels[other],ready.channels[other]);
      assert.notEqual(after.channels[p].descriptor.policy.requestId,ready.channels[p].descriptor.policy.requestId);assert.notEqual(after.channels[p].descriptor.policy.pipeName,ready.channels[p].descriptor.policy.pipeName);
      const freshDenied=await waitJson(join(root,'handoff/executor',prefix+'denied-fresh.json'));assert.equal(freshDenied.denials.length,1);assert.equal(freshDenied.denials[0].denied,true);
      await assert.rejects((p==='cli'?requestOwnerBootstrap:requestOwnerBrowserBootstrap)(options(policy(ready.channels,p))),{code:'OBC_TRANSPORT_FAILED'});retiredRefusals++;
      channels=after.channels;await Promise.all(ownerSetPurposes.map(p=>client(channels,p)));
    }else if(scenario==='browser-failure'){
      const raw=await rawClient(policy(channels,'browser'),'delivery-failure',async event=>{servers.browser=event.facts;assert.equal(event.facts.queryOnlyAuthorityVerified,true);await acceptTicket(event.outcome.bootstrapTicket);});
      assert.equal(raw.code,0);await step('observe-browser');assert.equal(after.browserWithdrawn,true);assert.equal(after.otherPreserved,true);assert.deepEqual(after.channels.cli,ready.channels.cli);
      assert.deepEqual(await ownerHttp(ready.port,tokens.browser),{status:401,owner:false});browserFailureCookieRevoked=true;await client(channels,'cli');
    }else if(scenario==='browser-completes-first'){
      await client(channels,'browser');await step('observe-browser');assert.equal(after.browserWithdrawn,true);assert.equal(after.otherPreserved,true);
      assert.deepEqual(await ownerHttp(ready.port,tokens.browser),{status:200,owner:true});await client(channels,'cli');
    }else if(scenario==='close-both'){
      await step('close');assert.equal(after.allWithdrawn,true);
      for(const p of ownerSetPurposes){await assert.rejects((p==='cli'?requestOwnerBootstrap:requestOwnerBrowserBootstrap)(options(policy(channels,p))),{code:'OBC_TRANSPORT_FAILED'});closeRefusals++;}
    }else{await Promise.all(ownerSetPurposes.map(p=>client(channels,p)));await step('settle');assert.equal(after.allWithdrawn,true);}
    const received=scenario!=='close-both';assert.equal(Object.keys(tokens).length,received?2:0);
    if(received){assert.equal(ticketNotCookie,true);assert.equal(nonceDenied,true);assert.equal(replayDenied,true);
      for(const p of ownerSetPurposes){assert.equal(servers[p].sid,controlSid);assert.equal(servers[p].sessionId,0);assert.equal(servers[p].pid,channels[p].peer.pid);assert.equal(servers[p].createdTicks,channels[p].peer.createdTicks);assert.equal(servers[p].queryOnlyAuthorityVerified,true);}}
    stage=`round-${round}/${scenario}/ack`;
    await put(join(root,'control/inbox',prefix+'ack.json'),{received});
    const done=await waitJson(join(root,'handoff/control',prefix+'done.json'));assert.equal(done.pass,true);assert.deepEqual(done.initial,ready.channels);assert.deepEqual(done.final,after.channels);
    if(received){for(const token of Object.values(tokens))assert.deepEqual(await ownerHttp(ready.port,token),{status:401,owner:false});assert.equal(await rejectedExchange(ready.port,ticket,nonces.browser),410);}
    const counters=Object.fromEntries(['cliIssues','ticketIssues','cookieIssues','confirmations','revocations','executorDenials'].map(key=>[key,done[key]]));
    assert.equal(counters.cliIssues,received?1:0);assert.equal(counters.ticketIssues,received?1:0);assert.equal(counters.cookieIssues,received?1:0);assert.equal(counters.revocations,received?2:0);
    assert.equal(counters.confirmations,received&&scenario!=='browser-failure'?1:0);assert.equal(counters.executorDenials,scenario.endsWith('-refresh')?3:2);
    report.cases.push({round,scenario,pass:true,...counters,initial:ready.channels,final:after.channels,retired:after.retired,
      pairedPublished:true,originalDeadlinePreserved:true,otherPreserved:after.otherPreserved,browserWithdrawn:after.browserWithdrawn,allWithdrawn:after.allWithdrawn,
      anonymousHttpDenied:true,ticketNotCookie,nonceDenied,replayDenied,authenticatedBoth:received,revokedBoth:received,browserFailureCookieRevoked,
      publicationWithdrawn:done.publicationWithdrawn,syntheticSessionsRevoked:true,retiredRefusals,closeRefusals,peers:done.peers,outcomes:done.outcomes});
    for(const key of Object.keys(tokens))tokens[key]='';ticket='';await put(join(root,'control/inbox',prefix+'finish.json'),{pass:true});
  }
  assert.equal(await finished,0);const summary=JSON.parse(await readFile(join(prepared.bundle,'summary.json'),'utf8'));assert.equal(summary.pass,true);assert.equal(summary.ownerHandoffRemoved,true);
  for(const row of [...spec.sourceFiles,...index.files])assert.equal(hash(await readFile(join(source,row.path))),row.sha256);
  assert.equal(report.cases.length,12);report.pass=true;
}catch(error){report.error=error.code||error.name;report.failureStage=stage;report.failedAfter=report.cases.length;await finished;}
finally{const productionAfter=await production();await writeFile(join(prepared.bundle,'production-after.json'),JSON.stringify(productionAfter));
  report.productionObservationUnchanged=JSON.stringify(productionBefore)===JSON.stringify(productionAfter);report.pass&&=report.productionObservationUnchanged;
  report.launchExitCode=launchStatus;report.completedAt=new Date().toISOString();await writeFile(join(prepared.bundle,'owner-set-client.json'),JSON.stringify(report,null,2));
  if(!report.pass)await writeFile(join(prepared.bundle,'owner-set-launch.json'),JSON.stringify({stdout:launchOutput,stderr:launchError}));}
console.log(JSON.stringify({caseId:report.caseId,pass:report.pass,checks:report.cases.length,bundle:prepared.bundle,error:report.error}));if(!report.pass)process.exitCode=1;
