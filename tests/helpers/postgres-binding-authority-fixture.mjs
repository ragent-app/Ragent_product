// Private loopback cluster only. This helper deliberately refuses a generic
// database URL before any DDL; the owning runner supplies and verifies its marker.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,readdir,writeFile,realpath} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createPostgresStore} from '../../accounts/store/postgres.mjs';

export async function createPostgresBindingAuthorityFixture({identity,accountId}) {
  const url=new URL(process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL || 'invalid:');
  assert.equal(url.protocol,'postgresql:');assert.equal(url.hostname,'127.0.0.1');
  assert.equal(url.username,'qa_authority');assert.equal(url.pathname,'/postgres');
  const data=process.env.RAGENT_TEST_OWNED_CLUSTER_DATA,nonce=process.env.RAGENT_TEST_RUN_NONCE;
  assert(data && /^[a-f0-9]{32}$/.test(nonce || ''));
  const root=await realpath(dirname(data));
  assert.equal((await readFile(join(root,'.qa-owned'),'utf8')).replaceAll('-',''),nonce);
  const bootstrap=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000});
  const pools=[];let owned=false;
  const schema='qa_auth_rev_'+randomBytes(12).toString('hex');
  const lockKey='ragent_accounts_store_v1:'+schema;
  const initial='2026-10-25T00:00:00.000Z';
  assert(identity.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'));
  const store=factory=>{
    const pool=new Pool({connectionString:url.href,max:2,connectionTimeoutMillis:5000,
      options:`-c search_path=${schema} -c statement_timeout=15000 -c application_name=ragent-pg-pc-qa`});pools.push(pool);
    return factory({schema,pool:{connect:async()=>{
      const client=await pool.connect();
      try {assert.equal((await client.query('select current_schema() as schema')).rows[0].schema,schema);}
      catch(e){client.release();throw e;}
      return {release:()=>client.release(),query:async(sql,values=[])=>{
        assert(!/\bpublic\s*\./i.test(sql));
        if(/pg_advisory/.test(sql)){
          assert.equal(sql,'select pg_advisory_xact_lock(hashtext($1))');assert.deepEqual(values,['ragent_accounts_store_v1']);
          return client.query(sql,[lockKey]);
        }
        return client.query(sql,values);
      }};
    }}});
  };
  async function close(){
    await Promise.all(pools.map(pool=>pool.end()));
    try{if(owned){await bootstrap.query(`drop schema "${schema}" cascade`);owned=false;}}
    finally{await bootstrap.end();}
  }
  try {
    const {rows}=await bootstrap.query("select current_setting('data_directory') as directory, inet_server_addr()::text as address");
    assert.equal((await realpath(rows[0].directory)).toLowerCase(),(await realpath(data)).toLowerCase());
    assert.equal(rows[0].address,'127.0.0.1/32');
    const legacyPath=process.env.RAGENT_TEST_SECOND_STORE_MODULE;assert(legacyPath);
    const legacyFactory=(await import(pathToFileURL(resolve(legacyPath)))).createPostgresStore;
    await bootstrap.query(`create schema "${schema}"`);owned=true;
    if(process.env.RAGENT_TEST_OWNED_SCHEMA_REPORT)await writeFile(process.env.RAGENT_TEST_OWNED_SCHEMA_REPORT,JSON.stringify({schema,runNonce:nonce,pid:process.pid}));
    const migrations=new URL('../../accounts/migrations/',import.meta.url);
    const names=(await readdir(migrations)).filter(f=>f.endsWith('.up.sql')).sort();
    assert(names.includes('028_temporary_control_exchanges.up.sql'));
    assert(names.includes('029_account_pairing_exchanges.up.sql'));
    async function migrate(files){const client=await bootstrap.connect();try{
      await client.query('begin');await client.query(`set local search_path to "${schema}"`);
      for(const file of files){const sql=await readFile(new URL(file,migrations),'utf8');
        assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));await client.query(sql);}
      await client.query('commit');
    }catch(e){await client.query('rollback');throw e;}finally{client.release();}}
    await migrate(names.filter(f=>f<'030_'));
    const old=store(legacyFactory),current=store(createPostgresStore);
    assert.equal(old.readInstanceAuthority,undefined);
    await old.mutate(draft=>{
      draft.accounts.push({accountId,provider:'google',providerSubject:'pg-pc-synthetic',createdAt:initial});
      draft.instanceBindings.push({instanceId:identity.instanceId,accountId,provider:'google',
        instancePublicKey:identity.publicKey,instanceKeyFingerprint:identity.keyFingerprint,
        boundAt:initial,revokedAt:'',lastSeenAt:initial});
      draft.bindingHistory.push({instanceId:identity.instanceId,accountId,action:'bind',occurredAt:initial});
    });
    await migrate(names.filter(f=>f>='030_'));
    async function transition(expectedRevision,revokedAt){
      await old.mutate(draft=>{
        const binding=draft.instanceBindings.find(b=>b.instanceId===identity.instanceId);assert(binding);
        binding.revokedAt=revokedAt;
        draft.bindingHistory.push({instanceId:identity.instanceId,accountId,action:revokedAt?'unbind':'bind',occurredAt:initial});
      });
      const state=await current.readInstanceAuthority(identity.instanceId);assert.equal(state.revision,expectedRevision);return state;
    }
    assert.equal((await current.readInstanceAuthority(identity.instanceId)).revision,'1');
    // Match the existing runtime's revision-7 enrollment while advancing only
    // through real unaware-writer transactions and migration-030 triggers.
    for(let n=2;n<=7;n++)await transition(String(n),n%2===0?initial:'');
    return {store:current,transition,close,schema,migrations:names,
      realPostgres:true,legacyWriterCommit:'5960967218f77b7f32819c429f94af69e130a3df'};
  }catch(e){await close();throw e;}
}
