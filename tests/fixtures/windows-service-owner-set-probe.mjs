// Actual virtual control/executor service QA for the paired product lifecycle.
// Public handoff files carry descriptors/facts/counters, never tickets or cookies.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import {createOwnerDiscoverySetController} from '../../lib/windows-owner-discovery-set.mjs';
import {createOwnerDiscoveryFileStore} from '../../lib/windows-owner-discovery-publication.mjs';
import {createLocalUiBootstrap,createLocalUiBootstrapClaimStore} from '../../lib/local-ui-bootstrap.mjs';
export const ownerSetScenarios=['simultaneous','browser-refresh','cli-refresh','browser-failure','browser-completes-first','close-both'];
export const ownerSetPurposes=['cli','browser'];
export async function serviceOwnerSet(root,role,spec){
  const round=spec.ipcRound,prefix=`r${round}-owner-`,publicDir=join(root,'handoff/control'),executorDir=join(root,'handoff/executor'),inbox=join(root,'control/inbox');
  const report={pass:false,role,round,cases:[],productionCredentialsRead:false,protocolVersion:2,pairedController:true};
  let server,broker,controller,auth,signingFile='',current;
  async function put(dir,name,value){const path=join(dir,prefix+name+'.json');await writeFile(path+'.tmp',JSON.stringify(value),{flag:'wx'});await rename(path+'.tmp',path);}
  async function get(dir,name,ms=25000){const path=join(dir,prefix+name+'.json'),until=Date.now()+ms;while(Date.now()<until){try{const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<65536);return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(done=>setTimeout(done,30));}throw Object.assign(new Error('OBS_QA_DEADLINE'),{code:'OBS_QA_DEADLINE'});}
  async function consume(name){const value=await get(inbox,name);await unlink(join(inbox,prefix+name+'.json'));return value;}
  async function absent(path){await assert.rejects(lstat(path),{code:'ENOENT'});}
  function track(endpoint){return endpoint.completion.then(value=>({issued:true,peer:value.facts}),error=>({issued:false,code:error.code||error.name}));}
  function snapshot(pair){return Object.fromEntries(ownerSetPurposes.map(p=>[p,{descriptor:pair[p].descriptor,peer:pair[p].ready.facts}]));}
  async function deny(channels){const values=[];for(const purpose of Object.keys(channels)){
    const denied=await new Promise(resolve=>{const socket=net.connect('\\\\.\\pipe\\'+channels[purpose].descriptor.policy.pipeName),timer=setTimeout(()=>{socket.destroy();resolve(false);},2000);
      socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});socket.once('error',error=>{clearTimeout(timer);socket.destroy();resolve(['EACCES','EPERM'].includes(error.code));});});
    assert.equal(denied,true);values.push({purpose,denied});}return values;}
  try{
    if(role==='control'){
      const instance=join(root,'state/control','owner-auth-r'+round),config=join(instance,'config');await mkdir(config,{recursive:true});
      const signingKey=randomBytes(32).toString('hex');signingFile=join(config,'auth-session-secret');await writeFile(signingFile,signingKey,{flag:'wx'});
      await writeFile(join(config,'auth.json'),JSON.stringify({username:'isolated-owner-set-qa',passwordHash:'SYNTHETIC-NO-PASSWORD-LOGIN'}));
      Object.assign(process.env,{RAGENT_WINDOWS_SERVICE_MODE:'1',RAGENT_INSTANCE_ROOT:instance,RAGENT_CONFIG_DIR:config,
        RAGENT_RUN_SPOOL_DIR:join(instance,'data/chat-runs'),RAGENT_PROVIDER_HOMES_DIR:join(instance,'provider-homes'),
        RAGENT_MEMORY_DIR:join(instance,'memory'),RAGENT_WORK_ROOT_DIR:join(instance,'workspace'),RAGENT_AUTH_SESSION_SECRET:signingKey,RAGENT_LOCAL_WEB_AUTH:'0',ProgramData:'C:/ProgramData'});
      auth=await import('../../lib/auth.mjs');
      async function issue(method){const token=await auth.issueSession({role:'owner',authMethod:method});
        current[method==='local_bootstrap'?'cookieIssues':'cliIssues']++;current.tokens.push(token);
        assert.match(token,/^[a-f0-9]{64}$/);assert.equal(auth.sessions.get('s'+createHmac('sha256',signingKey).update(token).digest('hex'))?.role,'owner');
        for(const suffix of ['','-wal']){try{assert.equal((await readFile(join(config,'auth-sessions.sqlite'+suffix))).includes(Buffer.from(token)),false);}catch(error){if(error.code!=='ENOENT')throw error;}}return token;}
      async function revoke(token){assert.equal(auth.revokeSession(token),true);await auth.saveAuthSessions();current.revoked.add(token);current.revocations++;}
      server=http.createServer((req,res)=>{(async()=>{
        if(broker&&await broker.handle(req,res))return;
        if(req.url!=='/api/owner-proof'){res.writeHead(404);res.end();return;}
        const allowed=auth.isAuthenticated(req)&&auth.getAuthSession(req)?.role==='owner';if(allowed)current.validHttp++;
        res.writeHead(allowed?200:401,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({owner:allowed}));
      })().catch(()=>res.destroy());});await new Promise(done=>server.listen(0,'127.0.0.1',done));
      const origin='http://127.0.0.1:'+server.address().port,claimDir=join(config,'bootstrap-claims');await mkdir(claimDir);
      broker=createLocalUiBootstrap({instanceId:spec.ownerInstanceId,origin,claimStore:createLocalUiBootstrapClaimStore({directory:claimDir}),issueOwnerSession:()=>issue('local_bootstrap'),revokeOwnerSession:revoke,setCookie:token=>'session_token='+token+'; HttpOnly; SameSite=Strict; Path=/'});
      const releaseJson=JSON.stringify({version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:spec['OwnerBootstrap.exe'],publisherSha256:'a'.repeat(64)});
      const installationJson=JSON.stringify({version:1,instanceId:spec.ownerInstanceId,controlSid:spec.controlSid,executorSid:spec.executorSid,ownerSid:spec.requestorSid,port:7690});
      const paths={cli:join(config,'owner-bootstrap-cli-live.json'),browser:join(config,'owner-bootstrap-browser-live.json'),publisher:join(config,'owner-bootstrap-publisher.json')};
      for(const scenario of ownerSetScenarios){
        current={cliIssues:0,ticketIssues:0,cookieIssues:0,confirmations:0,revocations:0,validHttp:0,tokens:[],revoked:new Set(),peers:{}};
        controller=await createOwnerDiscoverySetController({releaseJson,installationJson,executablePath:join(root,'runtime/OwnerBootstrap.exe'),
          publisherStore:createOwnerDiscoveryFileStore({filePath:paths.publisher}),stores:Object.fromEntries(ownerSetPurposes.map(p=>[p,createOwnerDiscoveryFileStore({filePath:paths[p]})])),
          issueOwnerSession:facts=>{current.peers.cli=facts;return issue('native_cli');},revokeOwnerSession:revoke,
          issueBrowserTicket:(facts,binding)=>{current.peers.browser=facts;current.ticketIssues++;return broker.issueTicket(binding);},
          revokeBrowserTicket:ticket=>broker.revokeTicket(ticket),confirmBrowserTicket:ticket=>{broker.confirmTicket(ticket);current.confirmations++;}});
        const authority={instanceId:spec.ownerInstanceId,controlSid:spec.controlSid,ownerSid:spec.requestorSid,ownerSessionId:spec.ownerSessionId,expiresAtUnixMs:Date.now()+25000};
        const pair={...await controller.start(authority)},completed=Object.fromEntries(ownerSetPurposes.map(p=>[p,track(pair[p])]));
        const initial=snapshot(pair);assert.notEqual(initial.cli.descriptor.policy.pipeName,initial.browser.descriptor.policy.pipeName);
        for(const p of ownerSetPurposes){assert.deepEqual(JSON.parse(await readFile(paths[p],'utf8')),initial[p].descriptor);for(const key of ['protectedDacl','firstInstance','rejectRemote'])assert.equal(pair[p].ready[key],true);}
        assert.ok((await lstat(paths.publisher+'.publisher-lock')).isFile());
        await put(publicDir,scenario+'-ready',{authority,channels:initial,port:server.address().port});
        const step=await consume(scenario+'-step');let retired=null,otherPreserved=false,browserWithdrawn=false,allWithdrawn=false;
        if(scenario.endsWith('-refresh')){
          const purpose=scenario.startsWith('cli-')?'cli':'browser',other=purpose==='cli'?'browser':'cli';assert.equal(step.action,'refresh');
          retired={purpose,...initial[purpose],completion:await (async()=>{const old=completed[purpose];pair[purpose]=await controller.refresh(purpose);return old;})()};
          assert.equal(retired.completion.issued,false);completed[purpose]=track(pair[purpose]);
          assert.deepEqual(JSON.parse(await readFile(paths[other],'utf8')),initial[other].descriptor);otherPreserved=true;
          assert.equal(pair[purpose].descriptor.policy.expiresAtUnixMs,authority.expiresAtUnixMs);
        }else if(['browser-failure','browser-completes-first'].includes(scenario)){
          assert.equal(step.action,'observe-browser');const browser=await completed.browser;
          assert.equal(browser.issued,scenario==='browser-completes-first');if(!browser.issued)assert.equal(browser.code,'OBC_DELIVERY_UNCONFIRMED');
          await absent(paths.browser);browserWithdrawn=true;assert.deepEqual(JSON.parse(await readFile(paths.cli,'utf8')),initial.cli.descriptor);otherPreserved=true;
          if(scenario==='browser-failure')assert.equal(current.revocations,1);
        }else if(scenario==='close-both'){
          assert.equal(step.action,'close');await controller.close();allWithdrawn=true;
          for(const path of Object.values(paths)){await absent(path);await absent(path+'.publisher-lock');}
        }else{
          assert.equal(step.action,'settle');for(const p of ownerSetPurposes){assert.equal((await completed[p]).issued,true);await absent(paths[p]);}allWithdrawn=true;
        }
        const after={channels:snapshot(pair),retired,otherPreserved,browserWithdrawn,allWithdrawn};await put(publicDir,scenario+'-after-step',after);
        const ack=await consume(scenario+'-ack');assert.equal(ack.received,scenario!=='close-both');
        const outcomes=Object.fromEntries(await Promise.all(ownerSetPurposes.map(async p=>[p,await completed[p]])));
        for(const p of ownerSetPurposes){assert.equal(outcomes[p].issued,scenario!=='close-both'&&!(p==='browser'&&scenario==='browser-failure'));}
        await controller.close();controller=null;
        const expected=scenario==='close-both'?0:1;
        for(const key of ['cliIssues','ticketIssues','cookieIssues'])assert.equal(current[key],expected);
        assert.equal(current.confirmations,scenario==='close-both'||scenario==='browser-failure'?0:1);
        if(expected)assert.ok(current.validHttp>=2);
        for(const token of current.tokens)if(!current.revoked.has(token))await revoke(token);
        assert.equal(current.revocations,expected*2);assert.equal(auth.sessions.size,0);
        for(const path of Object.values(paths)){await absent(path);await absent(path+'.publisher-lock');}
        const denial=await get(executorDir,scenario+'-denied');assert.equal(denial.denials.length,2);assert.ok(denial.denials.every(x=>x.denied));
        let freshDenials=0;if(retired){const value=await get(executorDir,scenario+'-denied-fresh');assert.equal(value.denials.length,1);assert.equal(value.denials[0].denied,true);freshDenials=1;}
        const {tokens,revoked,...counters}=current;
        const item={scenario,pass:true,...counters,initial,final:after.channels,retired,otherPreserved,browserWithdrawn,allWithdrawn,
          outcomes,executorDenials:2+freshDenials,publicationVerified:true,publicationWithdrawn:true,originalDeadlinePreserved:true,syntheticSessionsRevoked:true};
        report.cases.push(item);await put(publicDir,scenario+'-done',item);assert.equal((await consume(scenario+'-finish')).pass,true);
        current.tokens.length=0;current.revoked.clear();
      }
      report.syntheticOwnerSessionsRevoked=true;report.signingKeyNeverInEndpointEnvironment=true;
    }else{
      for(const scenario of ownerSetScenarios){const ready=await get(publicDir,scenario+'-ready'),denials=await deny(ready.channels);await put(executorDir,scenario+'-denied',{denials});
        let freshDenials=[];if(scenario.endsWith('-refresh')){const after=await get(publicDir,scenario+'-after-step');freshDenials=await deny({[after.retired.purpose]:after.channels[after.retired.purpose]});await put(executorDir,scenario+'-denied-fresh',{denials:freshDenials});}
        assert.equal((await get(publicDir,scenario+'-done')).pass,true);report.cases.push({scenario,pass:true,executorDenials:denials.length+freshDenials.length});}
    }
    report.pass=true;
  }catch(error){report.error=error.code||error.name;}
  finally{if(controller)await controller.close();broker?.close();if(server)await new Promise(done=>server.close(done));
    if(auth)auth.closeAuthSessionStore();if(signingFile){await unlink(signingFile).catch(error=>{if(error.code!=='ENOENT')throw error;});report.signingFileRemoved=true;delete process.env.RAGENT_AUTH_SESSION_SECRET;}}
  return report;
}
