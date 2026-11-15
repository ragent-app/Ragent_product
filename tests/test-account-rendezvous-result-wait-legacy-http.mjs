import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve, join, sep } from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { rendezvousWaitFixture } from './fixtures/rendezvous-result-wait.mjs';

const legacy=process.env.RAGENT_QA_LEGACY_SOURCE_ROOT;
assert(legacy,'An explicitly frozen legacy source closure is required');
const meta=JSON.parse(await readFile(join(legacy,'legacy-source-manifest.json'),'utf8'));
assert.equal(meta.sourceRevision,'0a69be6e262af6fc82783447a35da263d019cfe2');
const { startAccountsServer }=await import(pathToFileURL(join(legacy,'accounts/server.mjs')));

test('original Accounts42 accepts waitMs as an unknown field and returns no capability marker',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ragent-legacy-wait-body-'));
  await writeFile(join(root,'.ragent-owned-qa'),'legacy-body-compatibility');
  const f=rendezvousWaitFixture();let app;
  try{
    assert(!process.env.RAGENT_TEMPORARY_PAIRING_KEY_FILE);
    app=await startAccountsServer({port:0,host:'127.0.0.1',store:f.store,
      publicBaseUrl:'https://accounts.example.test',dataFile:join(root,'unused-data.json'),
      signingKeyFile:join(root,'signing.json'),turnBrokerSigningKeyFile:join(root,'turn-signing.json'),
      harnessPolicyFile:join(root,'unused-harness-policy.json'),logger:{level:'silent'},
      verifyGoogleCredential:async()=>{throw new Error('No Google exchange');},
      verifyNativeGoogleCredential:async()=>{throw new Error('No native Google exchange');},
    });
    const started=performance.now();
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/v1/owner-auth/rendezvous/${f.requestId}/result`,{
      method:'POST',headers:{Authorization:'Bearer '+f.token,'Content-Type':'application/json'},
      body:JSON.stringify({requestId:f.requestId,waitMs:10000}),
    });
    const result=await response.json();
    assert.equal(response.status,200);assert.equal(result.result,null);
    assert(!('resultWaitVersion' in result));assert.match(response.headers.get('cache-control'),/no-store/);
    assert(performance.now()-started<1000,'Old endpoint unexpectedly held the request');
    assert.equal(f.activity.reads,0,'Old source uses its legacy mutable adapter, not the new scoped reader');
  }finally{
    if(app)await app.close();
    assert(resolve(root).startsWith(resolve(tmpdir())+sep));
    assert.equal(await readFile(join(root,'.ragent-owned-qa'),'utf8'),'legacy-body-compatibility');
    await rm(root,{recursive:true});
  }
});
