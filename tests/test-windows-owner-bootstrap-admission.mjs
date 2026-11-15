// Real native refusals, no elevation, services or production credentials.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {openOwnerBootstrapEndpoint} from '../lib/windows-owner-bootstrap.mjs';
const source=resolve('.'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const prepared=JSON.parse(await readFile(join(source,'artifacts/showcase/T2-current-20261017/service-identities/prepared.json'),'utf8'));
const bytes=await readFile(join(prepared.bundle,'manifest.json'));assert.equal(hash(bytes),prepared.manifestSha256);
const spec=JSON.parse(bytes);assert.equal(spec.crossServiceOwnerBootstrap,true);
const exe=join(prepared.bundle,'OwnerBootstrap.exe');assert.equal(hash(await readFile(exe)),spec['OwnerBootstrap.exe']);
async function native(mode,input){
  const child=spawn(exe,[mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';
  child.stdout.on('data',bytes=>{output+=bytes;if(output.length>32768)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill(),10000);
  const code=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);child.stdin.end(input===undefined?'':typeof input==='string'?input:JSON.stringify(input)+'\n');});
  clearTimeout(timer);return {code,event:JSON.parse(output.trim())};
}
const report={pass:false,caseId:spec.caseId,servicesCreated:false,productionChanged:false,checks:[],nativeSha256:spec['OwnerBootstrap.exe'],testSha256:hash(await readFile(new URL(import.meta.url)))};
try{
  const self=await native('facts');assert.equal(self.code,0);assert.equal(self.event.facts.sid,spec.requestorSid);assert.equal(self.event.facts.sessionId,spec.ownerSessionId);
  assert.equal(self.event.facts.integrityRid,8192);assert.equal(self.event.facts.elevated,false);assert.equal(self.event.facts.enabledAdministrators,false);report.ordinaryIdentity=self.event.facts;
  const policy={pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId:spec.ownerInstanceId,requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+20000,
    controlSid:'S-1-5-80-1-2-3-4-5',ownerSid:spec.requestorSid,ownerSessionId:spec.ownerSessionId};
  for(const [name,mode,input,expected] of [
    ['unknown-mode','shell',undefined,'OBC_MODE_INVALID'],
    ['ordinary-user-not-control','server',policy,'OBC_LOCAL_IDENTITY_DENIED'],
    ['remote-pipe','client',{...policy,peer:{},pipeName:'\\\\remote\\pipe\\x'},'OBC_POLICY_INVALID'],
    ['unknown-identity-claim','client',{...policy,peer:{},sid:spec.requestorSid},'OBC_POLICY_INVALID'],
    ['owner-session-mismatch','client',{...policy,peer:{},ownerSessionId:spec.ownerSessionId+1},'OBC_LOCAL_IDENTITY_DENIED'],
    ['invalid-owner-sid','client',{...policy,peer:{},ownerSid:policy.controlSid},'OBC_POLICY_INVALID'],
    ['expired-private-policy','server',{...policy,expiresAtUnixMs:Date.now()-1},'OBC_DEADLINE_INVALID'],
    ['oversized-private-policy','server','x'.repeat(8193)+'\n','OBC_FRAME_TOO_LARGE'],
  ]){const result=await native(mode,input);assert.equal(result.code,1);assert.equal(result.event.kind,'error');assert.equal(result.event.code,expected);report.checks.push({name,pass:true,code:expected});}
  await assert.rejects(openOwnerBootstrapEndpoint({mode:'client',policy:{...policy,peer:{}},executablePath:exe,executableSha256:'0'.repeat(64)}),{code:'OBC_HELPER_INVALID'});
  report.checks.push({name:'adapter-refuses-modified-helper',pass:true,code:'OBC_HELPER_INVALID'});report.pass=true;
}finally{await writeFile(join(prepared.bundle,'owner-bootstrap-admission.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({pass:true,caseId:spec.caseId,actualNativeRefusals:8,adapterRefusals:1}));
