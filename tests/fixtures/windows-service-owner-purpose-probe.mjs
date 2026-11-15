// Actual isolated control/executor virtual service identities. The interactive
// Owner driver alone receives native secrets; handoff JSON contains only facts.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import {createOwnerDiscoveryController,createOwnerDiscoveryFileStore} from '../../lib/windows-owner-discovery-publication.mjs';
import {createLocalUiBootstrap,createLocalUiBootstrapClaimStore} from '../../lib/local-ui-bootstrap.mjs';
export const ownerPurposeScenarios=['cli-success','browser-success','browser-ticket-replay','browser-purpose','cli-purpose','browser-downgrade','browser-launch-missing','browser-launch-invalid','browser-instance','browser-server-pin','browser-disconnect','browser-delivery-failure','browser-receipt-nonce','browser-receipt-purpose'];
export const ownerPurposePositive=new Set(['cli-success','browser-success','browser-ticket-replay']);
export const ownerPurposeDeliveryFailure=new Set(['browser-delivery-failure','browser-receipt-nonce','browser-receipt-purpose']);
export async function serviceOwnerPurpose(root,role,spec){
  const round=spec.ipcRound,prefix=`r${round}-owner-`,publicDir=join(root,'handoff/control'),executorDir=join(root,'handoff/executor'),inbox=join(root,'control/inbox');
  const report={pass:false,role,round,cases:[],productionCredentialsRead:false,protocolVersion:2};
  let server,broker,controller,auth,signingFile='',current;
  async function put(dir,name,value){const path=join(dir,prefix+name+'.json');await writeFile(path+'.tmp',JSON.stringify(value),{flag:'wx'});await rename(path+'.tmp',path);}
  async function get(dir,name,ms=25000){const path=join(dir,prefix+name+'.json'),until=Date.now()+ms;while(Date.now()<until){try{const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<32768);return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(done=>setTimeout(done,30));}throw Object.assign(new Error('OBC_QA_DEADLINE'),{code:'OBC_QA_DEADLINE'});}
  try{
    if(role==='control'){
      const instance=join(root,'state/control','owner-auth-r'+round),config=join(instance,'config');await mkdir(config,{recursive:true});
      const signingKey=randomBytes(32).toString('hex');signingFile=join(config,'auth-session-secret');await writeFile(signingFile,signingKey,{flag:'wx'});
      await writeFile(join(config,'auth.json'),JSON.stringify({username:'isolated-owner-v2-qa',passwordHash:'SYNTHETIC-NO-PASSWORD-LOGIN'}));
      Object.assign(process.env,{RAGENT_WINDOWS_SERVICE_MODE:'1',RAGENT_INSTANCE_ROOT:instance,RAGENT_CONFIG_DIR:config,
        RAGENT_RUN_SPOOL_DIR:join(instance,'data/chat-runs'),RAGENT_PROVIDER_HOMES_DIR:join(instance,'provider-homes'),
        RAGENT_MEMORY_DIR:join(instance,'memory'),RAGENT_WORK_ROOT_DIR:join(instance,'workspace'),RAGENT_AUTH_SESSION_SECRET:signingKey,
        RAGENT_LOCAL_WEB_AUTH:'0',ProgramData:'C:/ProgramData'});
      auth=await import('../../lib/auth.mjs');
      async function issue(method){const token=await auth.issueSession({role:'owner',authMethod:method});
        current[method==='local_bootstrap'?'cookieIssues':'cliIssues']++;current.token=token;
        assert.match(token,/^[a-f0-9]{64}$/);assert.equal(auth.sessions.get('s'+createHmac('sha256',signingKey).update(token).digest('hex'))?.role,'owner');
        for(const suffix of ['','-wal']){try{assert.equal((await readFile(join(config,'auth-sessions.sqlite'+suffix))).includes(Buffer.from(token)),false);}catch(error){if(error.code!=='ENOENT')throw error;}}return token;}
      async function revoke(token){assert.equal(auth.revokeSession(token),true);await auth.saveAuthSessions();current.revocations++;}
      server=http.createServer((req,res)=>{(async()=>{
        if(broker&&await broker.handle(req,res))return;
        if(req.url!=='/api/owner-proof'){res.writeHead(404);res.end();return;}
        const allowed=auth.isAuthenticated(req)&&auth.getAuthSession(req)?.role==='owner';if(allowed)current.validHttp++;
        res.writeHead(allowed?200:401,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({owner:allowed}));
      })().catch(()=>{res.destroy();});});await new Promise(done=>server.listen(0,'127.0.0.1',done));
      const origin='http://127.0.0.1:'+server.address().port,claimDir=join(config,'bootstrap-claims');await mkdir(claimDir);
      broker=createLocalUiBootstrap({instanceId:spec.ownerInstanceId,origin,claimStore:createLocalUiBootstrapClaimStore({directory:claimDir}),
        issueOwnerSession:()=>issue('local_bootstrap'),revokeOwnerSession:revoke,setCookie:token=>'session_token='+token+'; HttpOnly; SameSite=Strict; Path=/'});
      const releaseJson=JSON.stringify({version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:spec['OwnerBootstrap.exe'],publisherSha256:'a'.repeat(64)});
      const installationJson=JSON.stringify({version:1,instanceId:spec.ownerInstanceId,controlSid:spec.controlSid,executorSid:spec.executorSid,ownerSid:spec.requestorSid,port:7690});
      const publicationPath=join(config,'owner-bootstrap-live.json');
      for(const scenario of ownerPurposeScenarios){
        current={cliIssues:0,ticketIssues:0,cookieIssues:0,revocations:0,confirmations:0,validHttp:0,token:''};
        const purpose=scenario.startsWith('cli-')?'cli':'browser',positive=ownerPurposePositive.has(scenario),delivery=ownerPurposeDeliveryFailure.has(scenario);
        const policy={protocolVersion:2,purpose,pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId:spec.ownerInstanceId,
          requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+20000,controlSid:spec.controlSid,ownerSid:spec.requestorSid,ownerSessionId:spec.ownerSessionId};
        controller=await createOwnerDiscoveryController({releaseJson,installationJson,store:createOwnerDiscoveryFileStore({filePath:publicationPath}),executablePath:join(root,'runtime/OwnerBootstrap.exe'),
          issueOwnerSession:facts=>{current.ownerPeer=facts;return issue('native_cli');},revokeOwnerSession:revoke,
          issueBrowserTicket:async(facts,binding)=>{assert.equal(facts.sid,spec.requestorSid);assert.equal(facts.sessionId,spec.ownerSessionId);current.ownerPeer=facts;current.ticketIssues++;return broker.issueTicket(binding);},
          revokeBrowserTicket:ticket=>broker.revokeTicket(ticket),confirmBrowserTicket:ticket=>{broker.confirmTicket(ticket);current.confirmations++;}});
        let active=await controller.start(policy),retired=null;
        if(scenario==='browser-success'){retired={policy:active.descriptor.policy,peer:active.ready.facts};active=await controller.refresh({...policy,pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),requestId:randomBytes(16).toString('hex')});}
        assert.deepEqual(JSON.parse(await readFile(publicationPath,'utf8')),active.descriptor);
        for(const key of ['protectedDacl','firstInstance','rejectRemote'])assert.equal(active.ready[key],true);
        const completion=active.completion.then(value=>({value}),error=>({error:error.code||error.name}));
        await put(publicDir,scenario+'-ready',{policy:active.descriptor.policy,descriptor:active.descriptor,retired,peer:active.ready.facts,port:server.address().port});
        const ack=await get(inbox,scenario+'-ack');await unlink(join(inbox,prefix+scenario+'-ack.json'));assert.equal(ack.received,positive||delivery);
        const completed=await completion; // Do not kill a successfully received native receipt during QA cleanup.
        await controller.close();controller=null;
        await assert.rejects(lstat(publicationPath),{code:'ENOENT'});await assert.rejects(lstat(publicationPath+'.publisher-lock'),{code:'ENOENT'});
        assert.equal(current.cliIssues,scenario==='cli-success'?1:0);assert.equal(current.ticketIssues,purpose==='browser'&&(positive||delivery)?1:0);
        assert.equal(current.cookieIssues,purpose==='browser'&&(positive||delivery)?1:0);assert.equal(current.confirmations,purpose==='browser'&&positive?1:0);
        if(positive){assert.equal(completed.value.issued,true);assert.equal(completed.value.facts.sid,spec.requestorSid);assert.equal(completed.value.facts.sessionId,spec.ownerSessionId);
          assert.equal(completed.value.facts.queryOnlyAuthorityVerified,true);assert.ok(current.validHttp>0);await revoke(current.token);
        }else{assert.ok(completed.error);if(delivery){assert.equal(completed.error,'OBC_DELIVERY_UNCONFIRMED');assert.ok(current.validHttp>0);}}
        if(positive||delivery){assert.equal(current.revocations,1);await assert.rejects(active.issuer.accept({}),{code:'OBC_ALREADY_USED'});}
        assert.equal(auth.sessions.size,0);const denial=await get(executorDir,scenario+'-denied');assert.equal(denial.denied,true);
        const {token,ownerPeer,...counters}=current;
        const item={scenario,purpose,pass:true,...counters,executorDenied:true,publicationVerified:true,publicationWithdrawn:true,
          ...(retired?{retiredEndpoint:retired.peer,refreshVerified:true}:{}),...(ownerPeer?{peer:ownerPeer}:{}),nativeError:completed.error||null,replayRefused:positive||delivery};
        report.cases.push(item);await put(publicDir,scenario+'-done',item);
        const finish=await get(inbox,scenario+'-finish');await unlink(join(inbox,prefix+scenario+'-finish.json'));assert.equal(finish.pass,true);current.token='';
      }
      report.syntheticOwnerSessionsRevoked=true;report.signingKeyNeverInEndpointEnvironment=true;
    }else{
      for(const scenario of ownerPurposeScenarios){const ready=await get(publicDir,scenario+'-ready');
        const denied=await new Promise(resolve=>{const socket=net.connect('\\\\.\\pipe\\'+ready.policy.pipeName),timer=setTimeout(()=>{socket.destroy();resolve(false);},2000);
          socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});socket.once('error',error=>{clearTimeout(timer);socket.destroy();resolve(['EACCES','EPERM'].includes(error.code));});});
        await put(executorDir,scenario+'-denied',{denied});assert.equal(denied,true);assert.equal((await get(publicDir,scenario+'-done')).pass,true);
        report.cases.push({scenario,pass:true,executorDenied:true});}
    }
    report.pass=true;
  }catch(error){report.error=error.code||error.name;}
  finally{if(controller)await controller.close();broker?.close();if(server)await new Promise(done=>server.close(done));
    if(auth)auth.closeAuthSessionStore();if(signingFile){await unlink(signingFile).catch(error=>{if(error.code!=='ENOENT')throw error;});report.signingFileRemoved=true;delete process.env.RAGENT_AUTH_SESSION_SECRET;}}
  return report;
}
