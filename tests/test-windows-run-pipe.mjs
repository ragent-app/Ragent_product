import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { assertOrdinaryWindowsExecutionIdentity } from '../lib/windows-execution-identity.mjs';
import { compileRunPipe, exchangeRunPipe, probeRawRunPipe, endpoint } from './helpers/windows-run-pipe-fixture.mjs';

if(process.platform!=='win32')throw new Error('Actual Windows pipe QA requires Windows');
const identity=await assertOrdinaryWindowsExecutionIdentity();
const {stdout}=await promisify(execFile)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoLogo','-NoProfile','-NonInteractive','-Command','[Diagnostics.Process]::GetCurrentProcess().SessionId'],{windowsHide:true,timeout:10000});
const sessionId=Number(stdout.trim()); assert.ok(Number.isInteger(sessionId));
const caseId=randomBytes(16).toString('hex');
const root=await mkdtemp(join(tmpdir(),'ragent-run-pipe-'));
const evidence=resolve('artifacts/showcase/T2-current-20261017/restricted-ipc');
const sources=['chat/restricted-run-ipc.mjs','native/windows-run-pipe-candidate.cs','tests/helpers/windows-run-pipe-fixture.mjs','tests/test-windows-run-pipe.mjs'];
const sourceFiles=await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
const report={schemaVersion:1,caseId,startedAt:new Date().toISOString(),pass:false,identity,sessionId,sourceFiles,
  providerUsed:false,credentialsUsed:false,productionChanged:false,phoneTouched:false,
  distinctServiceIdentitiesVerified:false,tests:[]};
const lease=()=>({version:1,leaseId:randomUUID(),runId:'run_appapi_'+randomBytes(16).toString('hex'),
  requestId:'pipe-request-'+randomBytes(8).toString('hex'),grantId:'rtg_'+randomBytes(24).toString('base64url'),
  authorityHash:randomBytes(32).toString('hex'),expiresAtUnixMs:Date.now()+30000});
try {
  await mkdir(evidence,{recursive:true});
  const exe=await compileRunPipe(root);
  report.helperSha256=createHash('sha256').update(await readFile(exe)).digest('hex');
  const forbidden=endpoint(exe,'server');
  try{
    forbidden.send({pipeName:'ragent-run-candidate-'+randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+10000,
      localSid:identity.sid,localSessionId:sessionId,peerSid:'S-1-5-80-1-2-3-4-5',peerSessionId:0,permitVirtualPeerQuery:true});
    const event=await forbidden.next();assert.equal(event.kind,'error');assert.equal(event.code,'IPC_QUERY_POLICY_INVALID');
    report.tests.push({name:'interactive-caller-cannot-enable-virtual-peer-query',pass:true,code:event.code});
  }finally{await forbidden.close();}
  let duplicateRefused=false;
  const success=await exchangeRunPipe({exe,identity,sessionId,instanceId:'isolated-pipe-'+caseId,lease:lease(),
    onReady:async({attemptDuplicateServer})=>{
      const duplicate=await attemptDuplicateServer();assert.equal(duplicate.kind,'error');
      assert.equal(duplicate.code,'IPC_TRANSPORT_FAILED');assert.ok([5,231].includes(duplicate.win32));duplicateRefused=true;
      report.tests.push({name:'duplicate-pipe-server',pass:true,code:duplicate.code,win32:duplicate.win32});
    },
    text:'Sum 17 and 25',execute:async(binding,input)=>{
      assert.equal(input,'Sum 17 and 25');return {...binding,stopped:true,completed:true,text:'42'};
    }});
  assert.equal(success.outcome.text,'42');assert.equal(success.dispatched,1);
  assert.equal(duplicateRefused,true);
  assert.equal(success.protectedDacl,true);assert.equal(success.client.sid,identity.sid);
  assert.equal(success.server.sid,identity.sid);assert.equal(success.client.sessionId,sessionId);
  assert.equal(success.server.sessionId,sessionId);assert.notEqual(success.client.pid,success.server.pid);
  assert.ok(!/;;;(?:WD|AU|BU)\)/.test(success.dacl));
  report.tests.push({name:'actual-mutual-peer-pins-and-one-result',pass:true,...success});
  console.log('PASS: actual mutual OS process/token/session pins, protected DACL, one bound result');
  for(const fault of ['server-pid','server-created','server-session','server-sid',
    'client-pid','client-created','client-session','client-sid','capability','cross-run','owner-operation','oversized',
    'peer-disconnect','idle-client']) {
    let calls=0,code='';
    try {await exchangeRunPipe({exe,identity,sessionId,instanceId:'isolated-pipe-'+caseId,lease:lease(),fault,
      timeoutMs:fault==='idle-client'?1500:15000,
      execute:async()=>{calls++;throw new Error('Forbidden dispatch');}});assert.fail('Expected refusal');}
    catch(error){code=error.code||error.message;assert.ok(/^IPC_/.test(code),code);}
    assert.equal(calls,0);report.tests.push({name:fault,pass:true,code,dispatched:calls});console.log('PASS: '+fault+' refused, zero dispatch');
  }
  let calls=0;
  const disconnected=await exchangeRunPipe({exe,identity,sessionId,instanceId:'isolated-pipe-'+caseId,lease:lease(),fault:'parent-disconnect',
    execute:async()=>{calls++;throw new Error('Forbidden dispatch');}});
  assert.equal(disconnected.event.kind,'error');assert.equal(disconnected.event.code,'IPC_PARENT_DISCONNECTED');assert.equal(calls,0);
  report.tests.push({name:'parent-disconnect',pass:true,code:disconnected.event.code,dispatched:0});
  for(const fault of ['raw-oversized-length','raw-invalid-utf8','raw-owner-operation']){
    const refused=await probeRawRunPipe({exe,identity,sessionId,lease:lease(),fault});
    assert.ok(/^IPC_/.test(refused.code));report.tests.push({name:fault,pass:true,code:refused.code,dispatched:0});
    console.log('PASS: '+fault+' rejected by actual server');
  }
  report.sourceUnchangedDuringRun=(await Promise.all(sourceFiles.map(async s=>createHash('sha256').update(await readFile(s.path)).digest('hex')===s.sha256))).every(Boolean);
  assert.equal(report.sourceUnchangedDuringRun,true);report.pass=true;
} catch(error){report.failure={code:error.code||'',message:error.message};throw error;}
finally {
  report.completedAt=new Date().toISOString();await writeFile(join(evidence,'case-'+caseId+'.json'),JSON.stringify(report,null,2));
  const actual=await realpath(root),parent=await realpath(tmpdir());
  assert.equal(dirname(actual).toLowerCase(),parent.toLowerCase());assert.ok(basename(actual).startsWith('ragent-run-pipe-'));
  await rm(actual,{recursive:true,force:true});
  console.log('Evidence: '+join(evidence,'case-'+caseId+'.json'));
}
