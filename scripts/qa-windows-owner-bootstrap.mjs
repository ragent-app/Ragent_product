// Explicit isolated Owner IPC QA. Native clients run as the ordinary interactive
// owner; the issuer runs as a distinct virtual control service. No production auth.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,lstat,rename} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {requestOwnerBootstrap} from '../lib/windows-owner-bootstrap.mjs';
import {assertOrdinaryWindowsExecutionIdentity} from '../lib/windows-execution-identity.mjs';
import {ownerBootstrapScenarios} from '../tests/fixtures/windows-service-owner-bootstrap-probe.mjs';
if(!process.argv.includes('--live-owner-bootstrap'))throw new Error('Explicit --live-owner-bootstrap required');
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evidence=join(source,'artifacts/showcase/T2-current-20261017/service-identities');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const prepared=JSON.parse(await readFile(join(evidence,'prepared.json'),'utf8'));
assert.equal(dirname(resolve(prepared.bundle)).toLowerCase(),evidence.toLowerCase());
assert.match(basename(prepared.bundle),/^bundle-[a-f0-9]{32}$/);
const bytes=await readFile(join(prepared.bundle,'manifest.json'));assert.equal(hash(bytes),prepared.manifestSha256);
const spec=JSON.parse(bytes);assert.equal(spec.crossServiceOwnerBootstrap,true);
const identity=await assertOrdinaryWindowsExecutionIdentity();assert.equal(identity.sid,spec.requestorSid);
const root=join(process.env.ProgramData,'RagentIdentityQA','case-'+spec.caseId);
const report={caseId:spec.caseId,pass:false,productionChanged:false,phoneTouched:false,providerUsed:false,
  actualPhoneOrTurn:false,credentialSource:'synthetic isolated signing key; original product auth',cases:[]};
let launchStatus,launchOutput='',launchError='';
async function production(){const {stdout}=await promisify(execFile)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`[pscustomobject]@{services=@(Get-CimInstance Win32_Service -Filter "Name='Ragent-ControlPlane' OR Name='Ragent-RunnerSupervisor'"|Sort-Object Name|Select-Object Name,State,ProcessId,StartName)}|ConvertTo-Json -Compress`],{windowsHide:true,timeout:10000});return JSON.parse(stdout.trim());}
const productionBefore=await production();await writeFile(join(prepared.bundle,'production-before.json'),JSON.stringify(productionBefore));
const launch=spawn(process.execPath,[join(source,'scripts/qa-windows-service-identities.mjs'),'--live'],
  {windowsHide:true,cwd:source,stdio:['ignore','pipe','pipe']});
launch.stdout.on('data',bytes=>{launchOutput=(launchOutput+bytes).slice(-32768);});
launch.stderr.on('data',bytes=>{launchError=(launchError+bytes).slice(-32768);});
const finished=new Promise(done=>{launch.once('error',()=>{launchStatus=-1;done(-1);});launch.once('close',code=>{launchStatus=code;done(code);});});
async function waitJson(path,ms=30000){const until=Date.now()+ms;while(Date.now()<until){
  try{const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=131072);return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(launchStatus!==undefined)throw Object.assign(new Error('Owner service ended before reply'),{code:'OBC_QA_SERVICE_ENDED'});
  await new Promise(done=>setTimeout(done,40));
}throw Object.assign(new Error('Owner reply deadline'),{code:'OBC_QA_DEADLINE'});}
async function put(path,value){await writeFile(path+'.tmp',JSON.stringify(value),{flag:'wx'});await rename(path+'.tmp',path);}
async function ownerHttp(port,token){assert.ok(Number.isInteger(port)&&port>0&&port<65536);
  const response=await fetch(`http://127.0.0.1:${port}/api/owner-proof`,{headers:token?{Cookie:'session_token='+token}:{},redirect:'error',signal:AbortSignal.timeout(3000)});
  return {status:response.status,owner:(await response.json()).owner};}
async function rawClient(policy,fault){
  const exe=join(prepared.bundle,'OwnerBootstrapRaw.exe');assert.equal(hash(await readFile(exe)),spec['OwnerBootstrapRaw.exe']);
  const child=spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});
  let output='';child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');if(output.length>32768)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill(),14000);
  const code=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);child.stdin.end(JSON.stringify({policy,fault})+'\n');});clearTimeout(timer);
  const lines=output.trim().split('\n').map(line=>JSON.parse(line));assert.equal(lines.length,1);
  return {code,event:lines[0]}; // May contain a synthetic cookie; never persist this object.
}
try{
  for(const round of [1,2])for(const scenario of ownerBootstrapScenarios){
    const prefix=`r${round}-owner-${scenario}-`,ready=await waitJson(join(root,'handoff/control',prefix+'ready.json'),round===1&&scenario==='success'?180000:35000);
    const denied=await waitJson(join(root,'handoff/executor',prefix+'denied.json'));assert.equal(denied.denied,true);
    const policy={...ready.policy,peer:ready.peer};let token='',server,clientError='';
    assert.deepEqual(ready.descriptor.policy,ready.policy);assert.deepEqual(ready.descriptor.peer,ready.peer);
    let retiredRefused=false;
    if(ready.retired){
      await assert.rejects(requestOwnerBootstrap({policy:{...ready.retired.policy,peer:ready.retired.peer},executablePath:join(prepared.bundle,'OwnerBootstrap.exe'),executableSha256:spec['OwnerBootstrap.exe']}),{code:'OBC_TRANSPORT_FAILED'});
      retiredRefused=true;
    }
    assert.equal((await ownerHttp(ready.port)).status,401);
    if(scenario==='success'){
      const result=await requestOwnerBootstrap({policy,executablePath:join(prepared.bundle,'OwnerBootstrap.exe'),executableSha256:spec['OwnerBootstrap.exe']});
      token=result.sessionToken;server=result.server;
    }else if(scenario==='server-pin'){
      try{await requestOwnerBootstrap({policy:{...policy,peer:{...policy.peer,createdTicks:'1'}},executablePath:join(prepared.bundle,'OwnerBootstrap.exe'),executableSha256:spec['OwnerBootstrap.exe']});}
      catch(error){clientError=error.code;}
      assert.equal(clientError,'OBC_PEER_PIN_MISMATCH');
    }else{
      const raw=await rawClient(policy,scenario);
      if(scenario==='replay'){assert.equal(raw.code,0);assert.equal(raw.event.kind,'result');token=raw.event.outcome.sessionToken;server=raw.event.facts;}
      else if(scenario==='disconnect'){assert.equal(raw.code,0);assert.equal(raw.event.kind,'disconnected');}
      else{assert.notEqual(raw.code,0);assert.equal(raw.event.kind,'error');clientError=raw.event.code;}
    }
    const positive=['success','replay'].includes(scenario);assert.equal(Boolean(token),positive);
    if(positive){assert.ok(/^[a-f0-9]{64}$/.test(token));assert.equal(server.sid,policy.controlSid);assert.equal(server.sessionId,0);
      assert.equal(server.pid,policy.peer.pid);assert.equal(server.createdTicks,policy.peer.createdTicks);assert.equal(server.queryOnlyAuthorityVerified,true);
      assert.equal(server.integrityRid,8192);assert.equal(server.elevated,false);assert.equal(server.enabledAdministrators,false);
      assert.deepEqual(await ownerHttp(ready.port,token),{status:200,owner:true});}
    await put(join(root,'control/inbox',prefix+'ack.json'),{received:positive});
    const done=await waitJson(join(root,'handoff/control',prefix+'done.json'));assert.equal(done.pass,true);assert.equal(done.issued,positive?1:0);
    if(positive){assert.deepEqual(await ownerHttp(ready.port,token),{status:401,owner:false});assert.equal(done.replayRefused,true);}
    else if(!['server-pin','disconnect'].includes(scenario)){
      const expected={instance:'OBC_BINDING_MISMATCH',request:'OBC_BINDING_MISMATCH',extend:'OBC_BINDING_MISMATCH',nonce:'OBC_CHALLENGE_DENIED',operation:'OBC_OPERATION_DENIED','claimed-sid':'OBC_FRAME_INVALID'};
      assert.equal(done.nativeError,expected[scenario]);
    }
    report.cases.push({round,scenario,pass:true,issued:done.issued,executorDenied:true,anonymousHttpDenied:true,
      publicationVerified:true,publicationWithdrawn:done.publicationWithdrawn,retiredRefused,
      authenticatedHttpAccepted:positive,revokedHttpDenied:positive,server:ready.peer,...(positive?{owner:done.peer}:{}),clientError,nativeError:done.nativeError});
    token='';await put(join(root,'control/inbox',prefix+'finish.json'),{pass:true});
  }
  assert.equal(await finished,0);
  const summary=JSON.parse(await readFile(join(prepared.bundle,'summary.json'),'utf8'));assert.equal(summary.pass,true);assert.equal(summary.ownerHandoffRemoved,true);
  for(const item of spec.sourceFiles)assert.equal(hash(await readFile(join(source,item.path))),item.sha256);
  const index=JSON.parse(await readFile(join(prepared.bundle,'owner-files.json'),'utf8'));
  for(const item of index.files)assert.equal(hash(await readFile(join(source,item.path))),item.sha256);
  report.pass=true;
}catch(error){report.error=error.code||error.name;report.failedAfter=report.cases.length;
  // Native and service watchdogs remain responsible for their owned children;
  // never terminate by process name or bypass a pending UAC decision.
  await finished;
}finally{
  const productionAfter=await production();await writeFile(join(prepared.bundle,'production-after.json'),JSON.stringify(productionAfter));
  report.productionObservationUnchanged=JSON.stringify(productionBefore)===JSON.stringify(productionAfter);report.pass&&=report.productionObservationUnchanged;
  report.launchExitCode=launchStatus;report.completedAt=new Date().toISOString();
  await writeFile(join(prepared.bundle,'owner-bootstrap-client.json'),JSON.stringify(report,null,2));
  if(!report.pass)await writeFile(join(prepared.bundle,'owner-bootstrap-launch.json'),JSON.stringify({stdout:launchOutput,stderr:launchError}));
}
console.log(JSON.stringify({pass:report.pass,caseId:spec.caseId,cases:report.cases.length,evidence:join(prepared.bundle,'owner-bootstrap-client.json')}));
if(!report.pass)process.exitCode=1;
