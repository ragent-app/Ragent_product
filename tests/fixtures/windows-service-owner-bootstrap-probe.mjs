// Actual service QA: product auth library stays only in the control identity.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHash,createHmac} from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import {createOwnerDiscoveryController,createOwnerDiscoveryFileStore} from '../../lib/windows-owner-discovery-publication.mjs';
export const ownerBootstrapScenarios=['success','replay','instance','request','nonce','operation','claimed-sid','extend','server-pin','disconnect'];
export async function serviceOwnerBootstrap(root,role,spec){
  const round=spec.ipcRound,report={pass:false,role,round,cases:[],productionCredentialsRead:false};
  const publicDir=join(root,'handoff/control'),executorDir=join(root,'handoff/executor'),inbox=join(root,'control/inbox');
  const prefix=`r${round}-owner-`;let httpServer,active,controller,signingKey='',signingFile='';
  async function put(dir,name,value){const path=join(dir,prefix+name+'.json');await writeFile(path+'.tmp',JSON.stringify(value),{flag:'wx'});await rename(path+'.tmp',path);}
  async function get(dir,name,ms=15000){const path=join(dir,prefix+name+'.json'),until=Date.now()+ms;while(Date.now()<until){try{const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<32768);return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(done=>setTimeout(done,30));}throw Object.assign(new Error('OBC_QA_DEADLINE'),{code:'OBC_QA_DEADLINE'});}
  try{
    let auth,issuedToken='',issuances=0,validHttp=0;
    if(role==='control'){
      const instance=join(root,'state/control','owner-auth-r'+round),config=join(instance,'config');await mkdir(config,{recursive:true});
      signingKey=randomBytes(32).toString('hex');signingFile=join(config,'auth-session-secret');await writeFile(signingFile,signingKey,{flag:'wx'});
      await writeFile(join(config,'auth.json'),JSON.stringify({username:'isolated-owner-qa',passwordHash:'SYNTHETIC-NO-PASSWORD-LOGIN'}));
      Object.assign(process.env,{RAGENT_WINDOWS_SERVICE_MODE:'1',RAGENT_INSTANCE_ROOT:instance,RAGENT_CONFIG_DIR:config,
        RAGENT_RUN_SPOOL_DIR:join(instance,'data/chat-runs'),RAGENT_PROVIDER_HOMES_DIR:join(instance,'provider-homes'),
        RAGENT_MEMORY_DIR:join(instance,'memory'),RAGENT_WORK_ROOT_DIR:join(instance,'workspace'),RAGENT_AUTH_SESSION_SECRET:signingKey,
        RAGENT_LOCAL_WEB_AUTH:'0',ProgramData:'C:/ProgramData'});
      auth=await import('../../lib/auth.mjs');
      httpServer=http.createServer((req,res)=>{
        if(req.url!=='/api/owner-proof'){res.writeHead(404);res.end();return;}
        const session=auth.getAuthSession(req),allowed=auth.isAuthenticated(req)&&session?.role==='owner';
        if(allowed)validHttp++;res.writeHead(allowed?200:401,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({owner:allowed}));
      });await new Promise(done=>httpServer.listen(0,'127.0.0.1',done));
      const releaseJson=JSON.stringify({version:1,protocolVersion:1,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:spec['OwnerBootstrap.exe'],publisherSha256:'a'.repeat(64)});
      const installationJson=JSON.stringify({version:1,instanceId:spec.ownerInstanceId,controlSid:spec.controlSid,executorSid:spec.executorSid,ownerSid:spec.requestorSid,port:7690});
      const publicationPath=join(config,'owner-bootstrap-live.json');
      for(const scenario of ownerBootstrapScenarios){
        const policy={pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId:spec.ownerInstanceId,
          requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+20000,controlSid:spec.controlSid,ownerSid:spec.requestorSid,ownerSessionId:spec.ownerSessionId};
        const before=issuances;
        controller=await createOwnerDiscoveryController({releaseJson,installationJson,store:createOwnerDiscoveryFileStore({filePath:publicationPath}),executablePath:join(root,'runtime/OwnerBootstrap.exe'),
          issueOwnerSession:async()=>{issuances++;issuedToken=await auth.issueSession({role:'owner'});assert.ok(typeof issuedToken==='string'&&issuedToken.length===64);
            const hash='s'+createHmac('sha256',signingKey).update(issuedToken).digest('hex');assert.equal(auth.sessions.get(hash)?.role,'owner');
            for(const suffix of ['','-wal']){try{assert.equal((await readFile(join(config,'auth-sessions.sqlite'+suffix))).includes(Buffer.from(issuedToken)),false);}catch(error){if(error.code!=='ENOENT')throw error;}}return issuedToken;},
          revokeOwnerSession:async token=>{auth.revokeSession(token);await auth.saveAuthSessions();}});
        const first=await controller.start(policy);let retired=null;
        if(scenario==='success'){
          retired={policy:first.descriptor.policy,peer:first.ready.facts};
          const replacement={...policy,pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),requestId:randomBytes(16).toString('hex')};
          active={...await controller.refresh(replacement),close:()=>controller.close()};
          assert.notEqual(active.descriptor.policy.requestId,retired.policy.requestId);
        }else active={...first,close:()=>controller.close()};
        assert.deepEqual(JSON.parse(await readFile(publicationPath,'utf8')),active.descriptor);
        assert.equal(active.ready.protectedDacl,true);assert.equal(active.ready.firstInstance,true);assert.equal(active.ready.rejectRemote,true);
        await put(publicDir,scenario+'-ready',{policy:active.descriptor.policy,descriptor:active.descriptor,retired,peer:active.ready.facts,port:httpServer.address().port});
        const completion=active.completion.then(value=>({value}),error=>({error:error.code||error.name}));
        const ack=await get(inbox,scenario+'-ack',25000);await unlink(join(inbox,prefix+scenario+'-ack.json'));
        await active.close();const completed=await completion;
        await assert.rejects(lstat(publicationPath),{code:'ENOENT'});await assert.rejects(lstat(publicationPath+'.publisher-lock'),{code:'ENOENT'});
        const positive=['success','replay'].includes(scenario);
        assert.equal(issuances-before,positive?1:0);assert.equal(ack.received,positive);
        let replayRefused=false;
        if(positive){assert.equal(completed.value.issued,true);assert.equal(completed.value.facts.sid,spec.requestorSid);
          assert.equal(completed.value.facts.sessionId,spec.ownerSessionId);assert.equal(completed.value.facts.queryOnlyAuthorityVerified,true);
          assert.ok(validHttp>0);auth.revokeSession(issuedToken);await auth.saveAuthSessions();
          await assert.rejects(active.issuer.accept({}),{code:'OBC_ALREADY_USED'});replayRefused=true;
        }else assert.ok(completed.error);
        const denial=await get(executorDir,scenario+'-denied');assert.equal(denial.denied,true);
        const item={scenario,pass:true,issued:issuances-before,replayRefused,executorDenied:true,publicationVerified:true,publicationWithdrawn:true,
          ...(retired?{retiredEndpoint:retired.peer,refreshVerified:true}:{}),
          ...(positive?{peer:completed.value.facts}:{}),nativeError:completed.error||null};
        report.cases.push(item);await put(publicDir,scenario+'-done',item);
        const finish=await get(inbox,scenario+'-finish');await unlink(join(inbox,prefix+scenario+'-finish.json'));assert.equal(finish.pass,true);
        issuedToken='';active=null;controller=null;
      }
      assert.equal(auth.sessions.size,0);report.signingKeyNeverInEndpointEnvironment=true;report.syntheticOwnerSessionsRevoked=true;
    }else{
      for(const scenario of ownerBootstrapScenarios){
        const ready=await get(publicDir,scenario+'-ready',25000);
        const denied=await new Promise(resolve=>{const socket=net.connect('\\\\.\\pipe\\'+ready.policy.pipeName),timer=setTimeout(()=>{socket.destroy();resolve(false);},2000);
          socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});socket.once('error',error=>{clearTimeout(timer);socket.destroy();resolve(['EACCES','EPERM'].includes(error.code));});});
        await put(executorDir,scenario+'-denied',{denied});assert.equal(denied,true);
        const done=await get(publicDir,scenario+'-done',25000);assert.equal(done.pass,true);report.cases.push({scenario,pass:true,executorDenied:true});
      }
    }
    report.pass=true;
  }catch(error){report.error=error.code||error.name;}
  finally{if(controller)await controller.close();if(httpServer)await new Promise(done=>httpServer.close(done));
    if(signingFile){await unlink(signingFile).catch(error=>{if(error.code!=='ENOENT')throw error;});report.signingFileRemoved=true;delete process.env.RAGENT_AUTH_SESSION_SECRET;}
  }
  return report;
}
