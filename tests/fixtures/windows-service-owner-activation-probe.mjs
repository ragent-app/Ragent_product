// Real service-SID/native-pipe QA. Installation paths/signatures are isolated
// synthetic metadata; actual token, pipe peer, WTS, auth SQLite and revokes are real.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,rename,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import {createOwnerServiceLifecycle} from '../../lib/windows-owner-service.mjs';
import {createOwnerActivationService} from '../../lib/windows-owner-activation-service.mjs';
import {serveOwnerActivationOnce} from '../../lib/windows-owner-bootstrap.mjs';
import {createOwnerDiscoverySetController} from '../../lib/windows-owner-discovery-set.mjs';
import {createOwnerDiscoveryFileStore} from '../../lib/windows-owner-discovery-publication.mjs';
export const activationStages=['initial','idle','first','reuse','first-issued','expired','second','second-issued','fault','fault-issued','after-fault','recovered','recovered-issued','finish','done','commit-release'];
export async function serviceOwnerActivation(root,role,spec){
 const round=spec.ipcRound,prefix=`r${round}-activation-`,pub=join(root,'handoff/control'),denied=join(root,'handoff/executor'),inbox=join(root,'control/inbox');
 const report={pass:false,round,role,productionCredentialsRead:false,actualNative:true,installedTrust:false,issues:0,revocations:0,inspections:0,listenerInspections:0,starts:0,completions:0,rollbacks:0,peers:[],servers:[],cliServers:[],cliPeers:[],nativeFacts:[],peerProofs:[],cases:[]};
 let lifecycle,listener,listenerTask,auth,server,signingFile='',faultMode='',controllerPaths,tokens=[],revoked=new Set();
 const err=code=>Object.assign(Error(code),{code});
 async function until(predicate,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return;await new Promise(done=>setTimeout(done,30));}throw err('OBC_QA_DEADLINE');}
 async function put(dir,stage,value){const p=join(dir,prefix+stage+'.json');await writeFile(p+'.tmp',JSON.stringify(value),{flag:'wx'});await rename(p+'.tmp',p);}
 async function get(dir,stage,ms=25000){let value;await until(async()=>{try{const p=join(dir,prefix+stage+'.json'),stat=await lstat(p);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<65536);value=JSON.parse(await readFile(p,'utf8'));return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}},ms);return value;}
 async function consume(stage){const v=await get(inbox,stage);await unlink(join(inbox,prefix+stage+'.json'));return v;}
 async function absent(p){await assert.rejects(lstat(p),{code:'ENOENT'});}
 async function deny(stage,cli){const paths=[...stage==='fault-issued'?[]:['ragent-owner-activation-'+spec.ownerInstanceId],...cli?[cli.policy.pipeName]:[]],values=[];
  for(const pipeName of paths){const code=await new Promise(done=>{const c=net.connect('\\\\.\\pipe\\'+pipeName),t=setTimeout(()=>{c.destroy();done('timeout');},2000);c.once('connect',()=>{clearTimeout(t);c.destroy();done('connected');});c.once('error',e=>{clearTimeout(t);c.destroy();done(e.code);});});assert.ok(['EACCES','EPERM'].includes(code),stage+':'+code);values.push({pipeName,code});}
  await put(denied,stage,{pass:true,denials:values});return values;
 }
 async function inspectFacts(exe,args=[]){const {stdout}=await promisify(execFile)(join(root,'runtime',exe),args,{windowsHide:true,timeout:5000,maxBuffer:16384,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});return JSON.parse(stdout.trim());}
 // execFile does not forward input: use spawn-free exec wrapper below for WTS.
 async function queryPeer(peer){const {spawn}=await import('node:child_process');const child=spawn(join(root,'runtime/OwnerBootstrap.exe'),['peer-facts'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});let output='';child.stdout.on('data',b=>{output+=b;if(output.length>16384)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});const t=setTimeout(()=>child.kill(),5000);try{const code=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);child.stdin.end(JSON.stringify({pid:peer.pid,createdTicks:peer.createdTicks,ownerSid:spec.requestorSid,ownerSessionId:peer.sessionId,controlSid:spec.controlSid})+'\n');});const result=JSON.parse(output.trim());report.peerProofs.push(result);assert.equal(code,0,result.code);assert.equal(result.kind,'peer-identity');assert.equal(result.facts.sid,spec.requestorSid);assert.equal(result.facts.sessionId,spec.ownerSessionId);assert.equal(result.facts.pid,peer.pid);assert.equal(result.facts.createdTicks,peer.createdTicks);return result.facts.sessionId;}finally{clearTimeout(t);}}
 try{
  if(role==='executor'){
   for(const stage of ['initial','idle','first','second',...round===2?['fault-issued']:[],'recovered']){const value=await get(pub,stage,stage==='idle'?40000:25000);report.cases.push({stage,denials:await deny(stage,value.cli)});}
   assert.equal((await get(pub,'done')).pass,true);report.pass=true;return report;
  }
  const instance=join(root,'state/control',`owner-auth-r${round}`),config=join(instance,'config');await mkdir(config,{recursive:true});
  const signing=randomBytes(32).toString('hex');signingFile=join(config,'auth-session-secret');await writeFile(signingFile,signing,{flag:'wx'});
  await writeFile(join(config,'auth.json'),JSON.stringify({username:'isolated-activation-qa',passwordHash:'SYNTHETIC-NO-PASSWORD-LOGIN'}));
  Object.assign(process.env,{RAGENT_WINDOWS_SERVICE_MODE:'1',RAGENT_RUN_SPOOL_DIR:join(instance,'data/chat-runs'),RAGENT_PROVIDER_HOMES_DIR:join(instance,'provider-homes'),RAGENT_INSTANCE_ROOT:instance,RAGENT_CONFIG_DIR:config,RAGENT_MEMORY_DIR:join(instance,'memory'),RAGENT_WORK_ROOT_DIR:join(instance,'workspace'),RAGENT_AUTH_SESSION_SECRET:signing,RAGENT_LOCAL_WEB_AUTH:'0',ProgramData:'C:/ProgramData'});
  auth=await import('../../lib/auth.mjs');
  const revoke=async token=>{assert.equal(auth.revokeSession(token),true);await auth.saveAuthSessions();revoked.add(token);report.revocations++;};
  server=http.createServer((req,res)=>{if(req.url!=='/api/owner-proof'){res.writeHead(404);res.end();return;}const owner=auth.isAuthenticated(req)&&auth.getAuthSession(req)?.role==='owner';res.writeHead(owner?200:401,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({owner}));});await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const releaseJson=JSON.stringify({version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:spec['OwnerBootstrap.exe'],publisherSha256:'a'.repeat(64)}),installationJson=JSON.stringify({version:1,instanceId:spec.ownerInstanceId,controlSid:spec.controlSid,executorSid:spec.executorSid,ownerSid:spec.requestorSid,port:7690});
  const binding={domain:'owner.activation.v1',instanceId:spec.ownerInstanceId,controlSid:spec.controlSid,ownerSid:spec.requestorSid,ownerSessionId:0},context={qa:spec.caseId};
  const inspect=async(context,{ownerPeer})=>{report.inspections++;const identity=await inspectFacts('OwnerBootstrap.exe',['facts']);assert.equal(identity.kind,'identity');assert.equal(identity.facts.sid,spec.controlSid);assert.equal(identity.facts.sessionId,0);assert.equal(identity.facts.integrityRid,8192);report.nativeFacts.push(identity.facts);const ownerSessionId=await queryPeer(ownerPeer);return {releaseJson,installationJson,executablePath:join(root,'runtime/OwnerBootstrap.exe'),authority:{instanceId:binding.instanceId,controlSid:binding.controlSid,ownerSid:binding.ownerSid,ownerSessionId,expiresAtUnixMs:Date.now()+5000}};};
  controllerPaths={cli:join(config,'owner-bootstrap-cli-live.json'),browser:join(config,'owner-bootstrap-browser-live.json'),publisher:join(config,'owner-bootstrap-publisher.json')};
  lifecycle=createOwnerServiceLifecycle({inspect,issueOwnerSession:async()=>{const token=await auth.issueSession({role:'owner',authMethod:'native_cli'});report.issues++;tokens.push(token);return token;},revokeOwnerSession:revoke,
   createSet:options=>createOwnerDiscoverySetController({...options,serveEndpoint:async o=>{const e=await options.serveEndpoint(o);report.cliServers.push(e.self.facts);e.completion.then(v=>report.cliPeers.push(v.facts)).catch(()=>{});return e;},publisherStore:createOwnerDiscoveryFileStore({filePath:controllerPaths.publisher}),stores:Object.fromEntries(['cli','browser'].map(p=>[p,createOwnerDiscoveryFileStore({filePath:controllerPaths[p]})]))})});
  listener=createOwnerActivationService({lifecycle,inspect:async()=>{report.listenerInspections++;return {binding,releaseJson,executablePath:join(root,'runtime/OwnerBootstrap.exe')};},serve:async options=>{
   const e=await serveOwnerActivationOnce({...options,activate:async(request,p)=>{report.peers.push({facts:request.facts,requestId:request.frame.requestId,requestExpiresAtUnixMs:request.frame.expiresAtUnixMs});const lease=await options.activate(request,p);return {
    async commit(){await lease.commit();if(faultMode==='commit-abort'){const cli=JSON.parse(await readFile(controllerPaths.cli,'utf8'));await put(pub,'fault-issued',{cli,snapshot:lifecycle.snapshot()});assert.equal((await consume('commit-release')).abort,true);throw err('OBC_DELIVERY_UNCONFIRMED');}},
    async complete(){await lease.complete();report.completions++;},async rollback(){await lease.rollback();report.rollbacks++;}};}});
   report.starts++;report.servers.push(e.self.facts);return e;
  }});listenerTask=listener.start(context);listenerTask.catch(error=>{report.listenerError={code:error.code||error.name,message:String(error.message).slice(0,150)};});
  async function ready(count){await until(()=>report.starts>=count&&listener.snapshot().ready);}
  async function active(stage,count,starts=count+2){await until(()=>report.completions>=count);await ready(starts);const cli=JSON.parse(await readFile(controllerPaths.cli,'utf8'));await put(pub,stage,{cli,snapshot:lifecycle.snapshot(),completions:report.completions});return cli;}
  await ready(1);assert.equal(lifecycle.snapshot().ready,false);await put(pub,'initial',{binding,port:server.address().port,listener:listener.snapshot()});
  await until(()=>report.starts>=2,38000);assert.equal(report.issues,0);assert.equal(report.inspections,0);assert.equal(lifecycle.snapshot().state,'idle');await put(pub,'idle',{noAuthority:true,starts:report.starts});report.cases.push({stage:'idle',noAuthority:true});
  const first=await active('first',1),reuse=await active('reuse',2);assert.equal(reuse.policy.expiresAtUnixMs,first.policy.expiresAtUnixMs);report.cases.push({stage:'reuse',deadline:first.policy.expiresAtUnixMs,unchanged:true});
  assert.equal((await consume('first-issued')).received,true);assert.equal(report.issues,1);await revoke(tokens[0]);await put(pub,'first-issued',{revocations:report.revocations});
  await until(async()=>{if(lifecycle.snapshot().state!=='expired')return false;for(const p of Object.values(controllerPaths)){try{await lstat(p);return false;}catch(e){if(e.code!=='ENOENT')throw e;}}return true;});for(const p of Object.values(controllerPaths))await absent(p);await put(pub,'expired',{expired:true,deadline:first.policy.expiresAtUnixMs});
  const second=await active('second',3);assert.ok(second.policy.expiresAtUnixMs>first.policy.expiresAtUnixMs);report.cases.push({stage:'reactivated',oldDeadline:first.policy.expiresAtUnixMs,newDeadline:second.policy.expiresAtUnixMs});
  assert.equal((await consume('second-issued')).received,true);assert.equal(report.issues,2);await revoke(tokens[1]);await put(pub,'second-issued',{revocations:report.revocations});
  await until(async()=>{if(lifecycle.snapshot().state!=='expired')return false;for(const p of Object.values(controllerPaths)){try{await lstat(p);return false;}catch(e){if(e.code!=='ENOENT')throw e;}}return true;});faultMode=round===1?'receipt-missing':'commit-abort';await put(pub,'fault',{fault:faultMode});
  await until(()=>report.rollbacks===1);await ready(6);assert.equal(lifecycle.snapshot().ready,false);for(const p of Object.values(controllerPaths))await absent(p);
  assert.equal(report.rollbacks,1);assert.equal(report.issues,round===1?2:3);assert.equal(report.revocations,report.issues);assert.equal(auth.sessions.size,0);
  assert.equal(report.inspections,4);report.recoveryNoAuthority=true;
  await put(pub,'after-fault',{fault:faultMode,issues:report.issues,revocations:report.revocations,rollbacks:report.rollbacks,listener:listener.snapshot(),snapshot:lifecycle.snapshot(),recoveryNoAuthority:true});report.cases.push({stage:'fault',fault:faultMode,revoked:true});faultMode='';
  const recovered=await active('recovered',4,7);assert.ok(recovered.policy.expiresAtUnixMs>second.policy.expiresAtUnixMs);assert.equal((await consume('recovered-issued')).received,true);assert.equal(report.issues,round===1?3:4);await revoke(tokens.at(-1));assert.equal(auth.sessions.size,0);await put(pub,'recovered-issued',{revocations:report.revocations});report.cases.push({stage:'recovered',deadline:recovered.policy.expiresAtUnixMs,freshOwner:true});
  assert.equal((await consume('finish')).pass,true);await Promise.all([lifecycle.stop(),listener.stop()]);report.publicationWithdrawn=true;for(const p of Object.values(controllerPaths)){await absent(p);await absent(p+'.publisher-lock');}
  report.pass=true;await put(pub,'done',{pass:true,issues:report.issues,revocations:report.revocations,cases:report.cases});
 }catch(error){report.error={code:error.code||error.name,message:String(error.message).replace(/[a-f0-9]{64}/g,'[redacted]').slice(0,500)};}
 finally{if(lifecycle||listener)await Promise.all([lifecycle?.stop(),listener?.stop()]);if(server)await new Promise(done=>server.close(done));if(auth){for(const token of tokens)if(!revoked.has(token)){auth.revokeSession(token);}auth.closeAuthSessionStore();}if(signingFile){await unlink(signingFile);report.signingFileRemoved=true;delete process.env.RAGENT_AUTH_SESSION_SECRET;}}
 return report;
}
