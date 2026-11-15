import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';

if(process.argv[2]==='--worker'){
  const root=process.argv[3],enabled=process.env.RAGENT_TEMPORARY_PAIRING_ENABLED==='1';
  const {getTemporaryPairingHost}=await import('../chat/temporary-pairing-runtime.mjs');
  const {getTemporaryControlRegistry}=await import('../chat/temporary-control-runtime.mjs');
  globalThis.fetch=()=>{throw new Error('Feature gate probe must not contact an external service');};
  if(enabled){
    const host=await getTemporaryPairingHost(),registry=await getTemporaryControlRegistry();
    assert.deepEqual(await registry.list(),[]);
    assert.equal(resolve(registry.filePath),resolve(root,'config','temporary-control.json'));
    assert.ok(host);host.close?.();
  }else{
    await assert.rejects(getTemporaryPairingHost(),{code:'temporary_host_disabled',statusCode:503});
    await assert.rejects(getTemporaryControlRegistry(),{code:'temporary_host_disabled',statusCode:503});
    await assert.rejects(access(join(root,'config')),{code:'ENOENT'});
  }
  console.log('temporary-runtime-feature-gate-verified');
}else{
  const exec=promisify(execFile);
  for(const value of [undefined,'0','true','01','1 ','1'])test(`temporary runtimes require explicit 1 (value: ${value??'unset'})`,async()=>{
    const root=await mkdtemp(join(tmpdir(),'ragent-feature-gate-'));
    const env=Object.fromEntries(['SystemRoot','WINDIR','ComSpec','PATH','PATHEXT','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    Object.assign(env,{HOME:root,USERPROFILE:root,APPDATA:join(root,'AppData/Roaming'),LOCALAPPDATA:join(root,'AppData/Local'),
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES:'1',RAGENT_INSTANCE_ROOT:root,RAGENT_CONFIG_DIR:join(root,'config'),
      RAGENT_INSTANCE_KEY_FILE:join(root,'config','instance-identity.json'),RAGENT_HARNESS_ROOT:join(root,'harnesses'),
      RAGENT_ACCOUNTS_URL:'https://accounts.invalid',RAGENT_TURN_BROKER_URL:''});
    if(value!==undefined)env.RAGENT_TEMPORARY_PAIRING_ENABLED=value;
    try{
      const {stdout}=await exec(process.execPath,[fileURLToPath(import.meta.url),'--worker',root],{env,windowsHide:true,timeout:15000,maxBuffer:65536});
      assert.match(stdout,/temporary-runtime-feature-gate-verified/);
    }finally{
      assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&root.includes('ragent-feature-gate-'));
      await rm(root,{recursive:true,force:true});
    }
  });
}
