// No services/UAC/credentials. Actual compiled helper rejects ordinary callers.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {join} from 'node:path';
const hash=x=>createHash('sha256').update(x).digest('hex');
const prepared=JSON.parse(await readFile('artifacts/showcase/T2-current-20261017/service-identities/prepared.json','utf8'));
const spec=JSON.parse(await readFile(join(prepared.bundle,'manifest.json'),'utf8'));assert.equal(spec.crossServiceCredentialChannel,true);
const exe=join(prepared.bundle,'RunCredentialChannel.exe');assert.equal(hash(await readFile(exe)),spec['RunCredentialChannel.exe']);
const binding={version:1,instanceId:'isolated',leaseId:randomUUID(),runId:'run_'+randomBytes(16).toString('hex'),requestId:'qa',grantId:'rtg_0123456789abcdef',authorityHash:'a'.repeat(64),expiresAtUnixMs:Date.now()+30000};
const base={pipeName:'ragent-run-credential-'+randomBytes(16).toString('hex'),binding,controlSid:'S-1-5-80-1-2-3-4-5',executorSid:'S-1-5-80-5-4-3-2-1'};
const report={pass:false,caseId:spec.caseId,checks:[],servicesCreated:false};
try{for(const [mode,policy,expected] of [
  ['owner.session',base,'RCC_MODE_INVALID'],['server',base,'RCC_LOCAL_IDENTITY_DENIED'],['client',{...base,peer:{}},'RCC_LOCAL_IDENTITY_DENIED'],
  ['server',{...base,command:'cmd.exe'},'RCC_FRAME_INVALID'],['server',{...base,executorSid:base.controlSid},'RCC_POLICY_INVALID'],
  ['server',{...base,pipeName:'\\\\remote\\pipe\\x'},'RCC_POLICY_INVALID'],['server',{...base,binding:{...binding,version:true}},'RCC_BINDING_INVALID'],
  ['server',{...base,binding:{...binding,expiresAtUnixMs:String(binding.expiresAtUnixMs)}},'RCC_BINDING_INVALID'],
]){const child=spawn(exe,[mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',b=>output+=b);child.stderr.resume();child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill(),10000);const code=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);child.stdin.end(JSON.stringify(policy)+'\n');});clearTimeout(timer);
  assert.equal(code,1);const value=JSON.parse(output);assert.equal(value.code,expected);report.checks.push({mode,expected,pass:true});}
  report.pass=true;
}finally{await writeFile(join(prepared.bundle,'credential-native-admission.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({pass:true,caseId:spec.caseId,actualRefusals:report.checks.length}));
