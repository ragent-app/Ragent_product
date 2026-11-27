import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=await mkdtemp(join(tmpdir(),'ragent-ledger-recovery-'));
const configDir=join(root,'config');const directory=join(configDir,'native-provider-runtime');
process.env.RAGENT_CONFIG_DIR=configDir;process.env.RAGENT_INSTANCE_ROOT=root;
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES='1';
const {createNativeProviderRegistry}=await import('../lib/provider-runtime/registry.mjs');
const {createSecretStore}=await import('../lib/provider-runtime/secret-store.mjs');
const {createCredentialMutationLedger}=await import('../lib/provider-runtime/credential-mutation.mjs');
const {createProviderSyncLedger}=await import('../lib/provider-runtime/sync-ledger.mjs');
const {repairProviderLedgers}=await import('../scripts/repair-provider-ledgers.mjs');
const management=await import(process.env.RAGENT_TEST_OAUTH_MODULE?pathToFileURL(process.env.RAGENT_TEST_OAUTH_MODULE).href:'../chat/native-provider-management.mjs');
const registry=createNativeProviderRegistry({configDir});const secretStore=createSecretStore({configDir});
await registry.upsertAuthProfile({id:'auth-existing',agentType:'codex',authType:'api-key',storageType:'secret-store',storageRef:'secret-existing',accountMetadata:{accountKey:'provider:codex:existing',credentialInstanceId:'instance-existing',credentialVersion:7}});
await registry.upsertProviderProfile({id:'existing',agentType:'codex',protocol:'openai-responses',baseUrl:'https://example.invalid/v1',authProfileId:'auth-existing'});
await secretStore.writeSecret('secret-existing',{authType:'api-key',apiKey:'fixture-existing-key'});
await writeFile(join(directory,'credential-ledger.json'),Buffer.alloc(1085));
await writeFile(join(directory,'provider-sync-ledger.json'),Buffer.alloc(5696));
const context={configDir,registry,secretStore,credentialLedger:createCredentialMutationLedger({configDir}),ledger:createProviderSyncLedger({configDir}),sourceInstanceId:'recovery-fixture',resolveProxyEnvironment:async()=>({})};
const marker=join(root,'login-spawned');const helper=join(root,'login.mjs');
await writeFile(helper,`import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(${JSON.stringify(marker)},'spawned');fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh',account_id:'fixture-account'}}));`);
const commandPath=join(root,'login.cmd');
if(process.platform==='win32')await writeFile(commandPath,`@echo off\r\n"${process.execPath}" "${helper}"\r\n`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=['providers.json','auth-profiles.json','credential-ledger.json','provider-sync-ledger.json','secrets/secret-existing.json'];
const expectedFiles=await Promise.all(paths.map(async path=>({path,sha256:hash(await readFile(join(directory,path)))})));
if(process.platform==='win32'){
  await assert.rejects(management.startNativeOAuthLogin({...context,commandPath,agentType:'codex'}),error=>error.code==='PROVIDER_DATA_CORRUPT'&&/credential-ledger|provider-sync-ledger/.test(error.message));
  await assert.rejects(stat(marker),{code:'ENOENT'});
  console.log('PASS: all-zero ledger fails before native login spawn, with a safe filename');
}
const options={configDir,runtimeRoot:resolve('.'),backupDir:join(root,'private-repair'),expectedFiles,writerId:'recovery-fixture'};
const dry=await repairProviderLedgers(options);assert.equal(dry.peerSyncPaused,true);assert.equal(dry.credentialRecordCount,1);
assert.equal((await readFile(join(directory,'credential-ledger.json'))).every(byte=>byte===0),true,'dry-run must not change damaged files');
await repairProviderLedgers({...options,apply:true});
assert.equal((await readFile(join(root,'private-repair','credential-ledger.json'))).every(byte=>byte===0),true);
assert.equal((await context.credentialLedger.getRecord('provider:codex:existing')).credentialVersion,7);
assert.equal((await context.credentialLedger.getRecord('provider:codex:existing')).credentialInstanceId,'instance-existing');
for(const file of expectedFiles.filter(file=>!file.path.includes('ledger')))assert.equal(hash(await readFile(join(directory,file.path))),file.sha256);
await assert.rejects(management.listAccountSyncRecords(context),{code:'PROVIDER_SYNC_RECOVERY_REQUIRED'});
await assert.rejects(management.applyAccountSyncRecords({...context,incoming:[]}),{code:'PROVIDER_SYNC_RECOVERY_REQUIRED'});
let peerSideEffect=false;
await assert.rejects(context.credentialLedger.merge([], {apply(){peerSideEffect=true;}}),{code:'PROVIDER_SYNC_RECOVERY_REQUIRED'});assert.equal(peerSideEffect,false);
await context.ledger.nextVersion('recovery-fixture');await context.ledger.merge([]);
assert.equal((await context.ledger.readState()).recoveryRequired,true,'ordinary local writes must retain the history fence');
console.log('PASS: verified current identities/versions preserved; damaged evidence retained; peer imports/exports fenced');
if(process.platform==='win32'){
  const job=await management.startNativeOAuthLogin({...context,commandPath,agentType:'codex',displayName:'Recovered official login'});
  let result;const deadline=Date.now()+15000;
  do{result=management.getNativeOAuthLoginJob(job.id);if(['completed','failed'].includes(result.state))break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
  assert.equal(result.state,'completed',result.error);
  const provider=await registry.getProviderProfile(result.providerId);const auth=await registry.getAuthProfile(provider.authProfileId);
  const secret=await secretStore.resolveSecret(auth.storageRef);assert.equal(secret.ok,true);assert.equal(secret.tokens.refresh_token==='fixture-refresh',true);
  assert.equal((await context.credentialLedger.getRecord(auth.accountMetadata.accountKey)).credentialVersion,auth.accountMetadata.credentialVersion);
  assert.equal(JSON.parse(await readFile(join(directory,'credential-ledger.json'),'utf8')).recoveryRequired,true);
  assert.equal((await secretStore.resolveSecret('secret-existing')).apiKey==='fixture-existing-key',true);
  await assert.rejects(management.listAccountSyncRecords(context),{code:'PROVIDER_SYNC_RECOVERY_REQUIRED'});
  console.log('PASS: native OAuth fully saves a new Provider, secret and matching CAS version after repair; fence survives');
}
await assert.rejects(repairProviderLedgers({...options,apply:true}),/changed since repair preflight/,'stale repair plans cannot overwrite current facts');
const {chmod,link,rename,rm,unlink}=await import('node:fs/promises');
const {createProviderSyncKeyStore}=await import('../lib/provider-runtime/sync.mjs');
const flushDir=join(root,'flush-check');
const assertFlushedBeforeCommit=async(commitOp,run)=>{
  const ops=[];
  const fsDeps={
    readFileImpl:readFile,
    mkdirImpl:mkdir,
    chmodImpl:chmod,
    unlinkImpl:unlink,
    writeFileImpl:async(filePath,data,options)=>{ops.push({op:'write',filePath,options:{...options}});return writeFile(filePath,data,options);},
    renameImpl:async(fromPath,toPath)=>{ops.push({op:'rename',fromPath,toPath});return rename(fromPath,toPath);},
    linkImpl:async(fromPath,toPath)=>{ops.push({op:'link',fromPath,toPath});return link(fromPath,toPath);},
  };
  await run(fsDeps);
  const commitIndex=ops.findIndex(entry=>entry.op===commitOp);
  assert.notEqual(commitIndex,-1,`expected ${commitOp} call`);
  const commitEvent=ops[commitIndex];
  const writeIndex=ops.findIndex((entry,index)=>index<commitIndex&&entry.op==='write'&&entry.filePath===commitEvent.fromPath);
  assert.notEqual(writeIndex,-1,`expected writeFileImpl before ${commitOp}`);
  assert.equal(ops[writeIndex].options.flush,true,`expected flush: true before ${commitOp}`);
  assert.equal(ops[writeIndex].options.mode,0o600,`expected mode 0o600 before ${commitOp}`);
};
try{
  await assertFlushedBeforeCommit('rename',fsDeps=>createProviderSyncLedger({configDir:flushDir,...fsDeps}).nextVersion('flush-fixture'));
  await assertFlushedBeforeCommit('rename',fsDeps=>createCredentialMutationLedger({configDir:flushDir,...fsDeps}).submit({accountKey:'provider:codex:flush',credentialInstanceId:'instance-flush',expectedVersion:0,secretPayload:{authType:'api-key',apiKey:'fixture-flush-key'},sourceDeviceId:'flush-fixture'}));
  await assertFlushedBeforeCommit('rename',fsDeps=>createNativeProviderRegistry({configDir:flushDir,...fsDeps}).upsertProviderProfile({id:'flush-provider',agentType:'codex',protocol:'openai-responses',baseUrl:'https://example.invalid/v1',authProfileId:'auth-flush'}));
  await assertFlushedBeforeCommit('rename',fsDeps=>createSecretStore({configDir:flushDir,...fsDeps}).writeSecret('secret-flush',{authType:'api-key',apiKey:'fixture-flush-key'}));
  await assertFlushedBeforeCommit('link',fsDeps=>createProviderSyncKeyStore({configDir:flushDir,...fsDeps}).getKeyPair());
  console.log('PASS: provider runtime files pass flush: true before atomic rename/link');
}finally{
  await rm(flushDir,{recursive:true,force:true});
}
