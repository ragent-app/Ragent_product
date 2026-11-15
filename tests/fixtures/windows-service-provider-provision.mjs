// One fixed admin QA provisioning step; no executable/secret path from a Run.
// Writes only the selected static API key to the isolated control vault.
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createNativeProviderRegistry} from '../../lib/provider-runtime/registry.mjs';
import {createSecretStore} from '../../lib/provider-runtime/secret-store.mjs';
try{
  const root=resolve(process.argv[2]);
  assert.equal(dirname(root).toLowerCase(),'c:\\programdata\\ragentidentityqa');
  assert.match(root.split('\\').at(-1),/^case-[a-f0-9]{32}$/);
  for(let path=root;;path=dirname(path)){assert.equal((await lstat(path)).isSymbolicLink(),false);assert.equal((await realpath(path)).toLowerCase(),path.toLowerCase());if(dirname(path)===path)break;}
  const spec=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));assert.equal(spec.crossServiceCredentialProvider,true);
  assert.ok([1,2].includes(spec.ipcRound));assert.equal(await readFile(join(root,'.ragent-identity-qa'),'utf8'),'case-'+spec.caseId);
  const configDir='C:/ProgramData/Ragent/instances/owner/config',registry=createNativeProviderRegistry({configDir});
  const selected=await registry.getProviderProfile(spec.providerSource.profileId),auth=await registry.getAuthProfile(selected?.authProfileId);
  assert.equal(selected?.revision,spec.providerSource.profileRevision);assert.equal(selected?.agentType,'claude');assert.equal(selected?.protocol,'anthropic-messages');
  assert.equal(selected?.enabled,true);assert.equal(selected?.status,'ready');assert.equal(selected?.baseUrl,spec.providerSource.baseUrl);
  assert.equal(selected?.modelPolicy?.defaultModel,spec.providerSource.model);assert.equal(auth?.revision,spec.providerSource.authRevision);
  assert.equal(auth?.authType,'api-key');assert.equal(auth?.storageType,'secret-store');assert.match(auth.storageRef,/^[A-Za-z0-9._-]{1,128}$/);assert.ok(!auth.storageRef.includes('..'));
  const secretPath=join(configDir,'native-provider-runtime/secrets',auth.storageRef+'.json');
  for(let path=resolve(secretPath);;path=dirname(path)){assert.equal((await lstat(path)).isSymbolicLink(),false);assert.equal((await realpath(path)).toLowerCase(),path.toLowerCase());if(dirname(path)===path)break;}
  assert.equal((await lstat(secretPath)).nlink,1);assert.ok((await lstat(secretPath)).size<32768);
  const secret=await createSecretStore({configDir}).resolveSecret(auth.storageRef);
  assert.equal(secret.ok,true);assert.equal(secret.authType,'api-key');assert.ok(typeof secret.apiKey==='string'&&secret.apiKey.length>0&&Buffer.byteLength(secret.apiKey)<=8192&&!/[\x00-\x1f\x7f]/.test(secret.apiKey));
  assert.equal((await registry.getProviderProfile(selected.id)).revision,selected.revision);
  assert.equal((await registry.getAuthProfile(auth.id)).revision,auth.revision);
  const target=join(root,'state/control',`credential-r${spec.ipcRound}`,'config/native-provider-runtime/secrets/selected.json');
  for(let path=dirname(target);;path=dirname(path)){assert.equal((await lstat(path)).isSymbolicLink(),false);assert.equal((await realpath(path)).toLowerCase(),path.toLowerCase());if(dirname(path)===path)break;}
  await writeFile(target,JSON.stringify({authType:'api-key',apiKey:secret.apiKey}),{flag:'wx'});
  await writeFile(join(root,'state/control',`provider-provision-r${spec.ipcRound}.json`),JSON.stringify({pass:true,profileRevision:selected.revision,authRevision:auth.revision}),{flag:'wx'});
  console.log(JSON.stringify({pass:true,round:spec.ipcRound}));
}catch{console.error('CREDENTIAL_PROVIDER_PROVISION_FAILED');process.exitCode=1;}
