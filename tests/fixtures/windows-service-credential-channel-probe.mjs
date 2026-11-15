import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rename,lstat,unlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createRestrictedControlRunBroker,createControlRunClaims,controlRunSnapshotHash} from '../../chat/restricted-control-run-broker.mjs';
import {createCredentialDispatchReceiver} from '../../chat/restricted-credential-dispatch.mjs';
import {openControlCredentialChannel,listenExecutorCredentialChannel} from '../../lib/windows-run-credential-channel.mjs';
import {localControlAuthority} from './local-control-authority.mjs';
import {credentialProviderWorkerInput} from '../../chat/restricted-provider-worker-input.mjs';
export const credentialScenarios=['success','server-pin','snapshot','cross-run','owner-operation'];
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function serviceCredentialChannel(root,role,spec){
  const live=spec.crossServiceCredentialProvider===true;
  const round=spec.ipcRound,report={pass:false,role,round,cases:[],productionCredentialsRead:false,providerUsed:false};
  const control=join(root,'handoff/control'),executor=join(root,'handoff/executor'),inbox=join(root,'control/inbox');
  let channel,store,selected='',unselected='',authority;
  const paths={executablePath:join(root,'runtime/RunCredentialChannel.exe'),executableSha256:spec['RunCredentialChannel.exe']};
  async function put(dir,prefix,kind,value){const path=join(dir,prefix+kind+'.json');await writeFile(path+'.tmp',JSON.stringify(value),{flag:'wx'});await rename(path+'.tmp',path);}
  async function get(dir,prefix,kind,ms=25000){const path=join(dir,prefix+kind+'.json'),until=Date.now()+ms;
    while(Date.now()<until){try{const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<131072);return JSON.parse(await readFile(path,'utf8'));}
      catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(done=>setTimeout(done,30));}throw Object.assign(new Error('CC_QA_DEADLINE'),{code:'CC_QA_DEADLINE'});}
  try{
    if(live){
      if(role==='executor'){
        const workerPath='./windows-service-provider-worker.mjs';
        const {serviceProviderWorker}=await import(workerPath);
        report.preflight=await serviceProviderWorker(root,spec,null,{boundaryOnly:true});
        assert.equal(report.preflight.pass,true);assert.equal(report.preflight.stopped,true);
        await put(executor,`r${round}-provider-`,'preflight',{pass:true,stopped:true,modelInvocations:0});
      }else assert.equal((await get(executor,`r${round}-provider-`,'preflight',30000)).pass,true);
    }
    if(role==='control'){
      authority=await localControlAuthority(join(root,'state/control','credential-r'+round));
      const {createNativeProviderRegistry}=await import('../../lib/provider-runtime/registry.mjs');
      const {createSecretStore}=await import('../../lib/provider-runtime/secret-store.mjs');
      const {RestrictedRunHost}=await import('../../chat/restricted-run-host.mjs');
      const registry=createNativeProviderRegistry({configDir:authority.config});store=createSecretStore({configDir:authority.config});
      selected=live?'':'SELECTED-'+randomBytes(32).toString('hex');unselected='UNSELECTED-'+randomBytes(32).toString('hex');
      if(!live)await store.writeSecret('selected',{authType:'api-key',apiKey:selected});await store.writeSecret('unselected',{authType:'api-key',apiKey:unselected});
      if(live){
        await put(control,`r${round}-provider-`,'vault-ready',{pass:true});
        assert.equal((await get(join(root,'state/control'),'',`provider-provision-r${round}`,30000)).pass,true);
        report.adminProvisionedStaticKey=true;
      }
      assert.equal((await registry.upsertAuthProfile({id:'qa-auth',agentType:'claude',authType:'api-key',storageType:'secret-store',storageRef:'selected'})).ok,true);
      const saved=await registry.upsertProviderProfile({id:'qa-provider',agentType:'claude',protocol:'anthropic-messages',authProfileId:'qa-auth',baseUrl:live?spec.providerSource.baseUrl:'https://synthetic-provider.example.test/',modelPolicy:{defaultModel:live?spec.providerSource.model:'synthetic-model'}});assert.equal(saved.ok,true);
      const claimsDir=join(root,'state/control','credential-claims-r'+round);await mkdir(claimsDir);
      for(const scenario of credentialScenarios){
        const prefix=`r${round}-credential-${scenario}-`,csv='name,amount\n甲,17\n乙,11\n甲,25\n';
        const task=live?'Read input.csv in the current workspace and sum amount by name. Write exactly the JSON object mapping each name to its total into output.json. Use Read and Write tools; do not execute commands, browse, access other paths or echo credentials. Input CSV:\n'+csv:csv;
        const value=await authority.seed(saved.profile,task);let reads=0,opens=0,authenticated=false,peer,broker,options,workerCalls=0,replay=false,controlNativeError='',dispatchSnapshotHash='';
        const coordinator=new RestrictedRunHost({host:authority.host,worker:{tool:'claude',preflight:async()=>{},execute:async context=>{
          workerCalls++;try{const result=await broker.execute(context);
            await assert.rejects(broker.execute(context),{code:'CB_ALREADY_CONSUMED'});await assert.rejects(createRestrictedControlRunBroker(options).execute(context),{code:'CB_ALREADY_CONSUMED'});replay=true;return result;
          }catch(error){if(error.stopConfirmed)return {...Object.fromEntries(['leaseId','runId','requestId','grantId','authorityHash'].map(key=>[key,context.lease[key]])),stopped:true,completed:false,text:error.code};throw error;}
        }}});
        options={instanceId:authority.identity.instanceId,executorSid:spec.executorSid,authority:coordinator,registry,claims:createControlRunClaims({root:claimsDir}),
          secretStore:{resolveSecret:async ref=>{assert.equal(authenticated,true);assert.equal(ref,'selected');reads++;return store.resolveSecret(ref);}},
          authorizeEndpoint:async url=>({allowed:url===saved.profile.baseUrl,revision:'isolated-endpoint-v1'}),
          transport:{open:async({binding,signal})=>{
            opens++;await put(control,prefix,'offer',{binding,selectedKeyHash:live?null:hash(selected)});
            const ready=await get(executor,prefix,'ready');assert.equal(controlRunSnapshotHash(ready.policy.binding),controlRunSnapshotHash(binding));
            assert.equal((await get(inbox,prefix,'owner-denied')).denied,true);
            const policy={...ready.policy,peer:scenario==='server-pin'?{...ready.ready.facts,createdTicks:'1'}:ready.ready.facts};
            try{channel=await openControlCredentialChannel({...paths,policy,signal});}catch(error){controlNativeError=error.code||error.name;throw error;}
            authenticated=true;peer=channel.peer;
            const send=channel.send;channel.send=async payload=>{dispatchSnapshotHash=payload.snapshotHash;if(scenario==='snapshot')payload.snapshotHash='f'.repeat(64);
              if(scenario==='cross-run')payload.frame.runId='run_cross_scope_12345';if(scenario==='owner-operation')payload.operation='owner.session';return send(payload);};return channel;
          }}};
        broker=createRestrictedControlRunBroker(options);await coordinator.start(value.runId);const run=await authority.runs.getRunAcceptanceEvidence(value.runId);
        const done=await get(executor,prefix,'done');const positive=scenario==='success';assert.equal(opens,1);assert.equal(reads,scenario==='server-pin'?0:2);assert.equal(done.calls,positive?1:0);
        if(positive){assert.equal(run.state,'completed');assert.deepEqual(JSON.parse((await authority.results.preview(value.principal,value.scope,value.runId)).text),{'甲':42,'乙':11});
          if(live){assert.equal(done.worker.modelInvocations,1);assert.equal(done.worker.stopped,true);report.providerUsed=true;}
          const other=await authority.enroll();await assert.rejects(authority.results.preview(other.principal,value.scope,value.runId));
          await coordinator.start(value.runId);assert.equal(workerCalls,1);assert.equal(replay,true);assert.equal(done.warmReplayRefused,true);assert.equal(done.coldReplayRefused,true);
        }else{assert.equal(run.state,scenario==='server-pin'?'failed':'running');if(scenario!=='server-pin')assert.equal(run.restrictedExecution.state,'stop-unconfirmed');}
        const item={scenario,pass:true,reads,authenticated,controlNativeError,dispatchSnapshotHash,peer:peer||null,executor:done,runId:value.runId,state:run.state,restrictedExecution:run.restrictedExecution,
          ...(positive?{receipt:run.result.restrictedReceipt,originalDeviceResult:true,otherDeviceDenied:true,replayRefused:replay}:{}),ownerDenied:true};report.cases.push(item);
        await put(control,prefix,'settled',{pass:true});channel=null;
      }
      for(const file of await readdir(control)){const data=await readFile(join(control,file),'utf8');assert.equal((selected&&data.includes(selected))||data.includes(unselected),false);}
      assert.equal((selected&&JSON.stringify(report).includes(selected))||JSON.stringify(report).includes(unselected),false);report.noCredentialFileHandoff=true;
    }else{
      const claimsDir=join(root,'state/executor','credential-claims-r'+round);await mkdir(claimsDir);
      for(const scenario of credentialScenarios){const prefix=`r${round}-credential-${scenario}-`,offer=await get(control,prefix,'offer');
        const privateRoot=join(root,'state/control','credential-r'+round,'config');const denials=[];
        for(const file of ['authority-identity.json','temporary-registry.json','native-provider-runtime/providers.json','native-provider-runtime/secrets/selected.json','native-provider-runtime/secrets/unselected.json']){
          let denied=false;try{await readFile(join(privateRoot,file));}catch(error){denied=['EACCES','EPERM'].includes(error.code);}assert.equal(denied,true);denials.push({file,denied});}
        const policy={pipeName:'ragent-run-credential-'+randomBytes(16).toString('hex'),binding:offer.binding,controlSid:spec.controlSid,executorSid:spec.executorSid};
        channel=await listenExecutorCredentialChannel({...paths,policy});assert.equal(channel.ready.protectedDacl,true);assert.equal(channel.ready.firstInstance,true);assert.equal(channel.ready.rejectRemote,true);
        const serverFacts=channel.ready.facts;await put(executor,prefix,'ready',{policy,ready:channel.ready});let calls=0,peer,code='',warmReplayRefused=false,coldReplayRefused=false,worker;
        try{const request=await channel.receive();peer=request.peer;assert.equal(peer.sid,spec.controlSid);assert.equal(peer.queryOnlyAuthorityVerified,true);
          const receiver=createCredentialDispatchReceiver({binding:policy.binding,claims:createControlRunClaims({root:claimsDir})});
          const execute=async fields=>{calls++;
            if(live){
              const workerPath='./windows-service-provider-worker.mjs';const {serviceProviderWorker}=await import(workerPath);
              const request={...credentialProviderWorkerInput(fields,policy.binding),inputCSV:fields.text.split('Input CSV:\n')[1]};
              assert.ok(typeof request.inputCSV==='string'&&request.inputCSV.length<8192);
              worker=await serviceProviderWorker(root,spec,request);report.providerUsed=worker.modelInvocations===1;
              return {...fields.binding,stopped:worker.stopped===true,completed:worker.pass,text:JSON.stringify(worker.output||{})};
            }
            assert.equal(hash(fields.apiKey),offer.selectedKeyHash);const output={};
            for(const row of fields.text.trim().split(/\r?\n/).slice(1)){const [key,n]=row.split(',');output[key]=(output[key]||0)+Number(n);}
            await writeFile(join(root,'workspace',`credential-r${round}-${scenario}.json`),JSON.stringify(output));return {...fields.binding,stopped:true,completed:true,text:JSON.stringify(output)};};
          const result=await receiver.accept(request.payload,execute);await assert.rejects(receiver.accept(request.payload,execute),{code:'CD_ALREADY_USED'});warmReplayRefused=true;
          await assert.rejects(createCredentialDispatchReceiver({binding:policy.binding,claims:createControlRunClaims({root:claimsDir})}).accept(request.payload,execute),{code:'CB_ALREADY_CONSUMED'});coldReplayRefused=true;
          await channel.respond(result);
        }catch(error){code=error.code||error.name;}finally{await channel.close();channel=null;}
        const positive=scenario==='success';assert.equal(calls,positive?1:0);if(positive)assert.equal(code,'');else assert.ok(code);
        if(live&&positive){assert.equal(worker?.pass,true);assert.equal(worker.stopped,true);}
        const done={scenario,pass:true,calls,peer:peer||null,server:serverFacts,code,denials,warmReplayRefused,coldReplayRefused,...(worker?{worker}:{})};report.cases.push(done);await put(executor,prefix,'done',done);
        assert.equal((await get(control,prefix,'settled')).pass,true);
      }
    }report.pass=true;
  }catch(error){report.error=error.code||error.name;if(error.code==='ERR_MODULE_NOT_FOUND')report.missingPackage=error.message.match(/^Cannot find package '([@a-zA-Z0-9_./-]+)'/)?.[1]||'unresolved-local-path';}
  finally{if(channel)await channel.close();if(store){await store.deleteSecret('selected');await store.deleteSecret('unselected');
    await unlink(join(authority.config,'authority-identity.json'));report.controlKeysRemoved=true;}}
  return report;
}
