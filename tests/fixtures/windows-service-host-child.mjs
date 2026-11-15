// Synthetic script at the installed control/supervisor entry path in a fresh
// disposable guest. No product API, provider, network, or Owner authority.
import assert from 'node:assert/strict';
import {readFile,writeFile,access,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
const root='C:/ProgramData/Ragent/instances/owner',role=process.env.RAGENT_WINDOWS_SERVICE_ROLE;
assert.ok(['control','supervisor'].includes(role));assert.equal(process.env.RAGENT_INSTANCE_ROOT.replaceAll('\\','/'),root);
const config=role==='control'?join(root,'config'):join(root,'executor/config');
assert.equal(process.env.RAGENT_CONFIG_DIR.replaceAll('\\','/'),config.replaceAll('\\','/'));
assert.equal(process.env.RAGENT_HARNESS_ROOT.replaceAll('\\','/'),'C:/ProgramData/Ragent/harnesses');
assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.NODE_PATH,undefined);
assert.equal(process.env.OPENAI_API_KEY,undefined);
const {stdout}=await promisify(execFile)('C:/Program Files/Ragent/payload/HostTokenProbe.exe',['--self'],{windowsHide:true,timeout:8000});
const token=JSON.parse(stdout);assert.equal(token.integrityRid,8192);assert.equal(token.postIntegrityRid,8192);assert.equal(token.elevated,false);assert.equal(token.enabledAdministrators,false);assert.equal(token.sessionId,0);assert.equal(token.privilegeReenableDenied,true);assert.equal(token.integrityRaiseDenied,true);
const attacks=join(process.env.TEMP,'ancestor-attacks');await mkdir(attacks);
const ancestorGuard=JSON.parse((await promisify(execFile)('C:/Program Files/Ragent/payload/AncestorPinProbe.exe',[attacks],{windowsHide:true,timeout:10000})).stdout);
assert.equal(ancestorGuard.pass,true);assert.equal(ancestorGuard.checks.length,9);assert.equal(ancestorGuard.sid,token.sid);assert.equal(ancestorGuard.metadataOnlyAccess,256);
const denied=[];
async function refuses(path,op){await assert.rejects(op(path),e=>['EACCES','EPERM'].includes(e.code));denied.push(path.replaceAll('\\','/'));}
if(role==='supervisor'){
 const until=Date.now()+30000;
 for(;;){try{await access(join(root,'workspace/control.txt'));break;}catch(e){if(e.code!=='ENOENT')throw e;assert.ok(Date.now()<until,'controller readiness fixture missing');await new Promise(r=>setTimeout(r,100));}}
 assert.equal(process.env.RAGENT_AUTH_SESSION_SECRET,undefined);
 await refuses(join(root,'config/auth-session-secret'),p=>readFile(p));
 await refuses(join(root,'config/blocked-write'),p=>writeFile(p,'SYNTHETIC'));
 await refuses(join(root,'runtime/blocked-write'),p=>writeFile(p,'SYNTHETIC'));
 await refuses('C:/ProgramData/Ragent/harnesses/blocked-write',p=>writeFile(p,'SYNTHETIC'));
}else{
 const secret=(await readFile(join(config,'auth-session-secret'),'utf8')).trim();assert.ok(/^[a-f0-9]{64}$/.test(secret),'owned secret format');assert.ok(process.env.RAGENT_AUTH_SESSION_SECRET===secret,'owned secret reuse');
 await writeFile('C:/ProgramData/Ragent/harnesses/control-install-probe','SYNTHETIC');
}
await refuses('C:/Program Files/Ragent/payload/node.exe',p=>writeFile(p,'SYNTHETIC'));
await refuses('C:/Program Files/Ragent/payload/immutable-probe.txt',p=>writeFile(p,'SYNTHETIC'));
await writeFile(join(config,'private-write-probe'),'SYNTHETIC');
await writeFile(join(root,'workspace',role+'.txt'),'SYNTHETIC');
await writeFile(join(root,'data/chat-runs',role+'.txt'),'SYNTHETIC');
await writeFile(join(process.env.TEMP,'private-temp-probe'),'SYNTHETIC');
await writeFile(join(config,'runtime-proof.json'),JSON.stringify({pass:true,role,pid:process.pid,parentPid:process.ppid,node:process.version,token,ancestorGuard,denied,authorityIssued:false,productApiStarted:false}));
const end=Date.now()+90000;
for(;;){
 try{await access(process.env.RAGENT_WINDOWS_SERVICE_STOP_FILE);break;}catch(e){if(e.code!=='ENOENT')throw e;}
 assert.ok(Date.now()<end,'QA child lifetime exceeded');await new Promise(r=>setTimeout(r,100));
}
console.log('MANAGED_HOST_QA_STOPPED');
