import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createAccountDeletionRepository, buildAccountDeletionAcknowledgment } from '../accounts/store/account-deletions.mjs';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { normalizeDevicePublicKey, createDevicePublicKeyFingerprint, buildAccountSessionMessage } from '../lib/device-auth-protocol.mjs';

const urlText = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
test('actual isolated PostgreSQL account deletion and legacy admission boundary', { skip: !urlText }, async t => {
  const url = new URL(urlText), nonce = process.env.RAGENT_TEST_RUN_NONCE;
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'qa_deletion'); assert.equal(url.pathname, '/postgres');
  assert(/^[a-f0-9]{32}$/.test(nonce || ''));
  const schema = 'qa_deletion_' + randomBytes(12).toString('hex');
  const bootstrap = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  const pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c application_name=ragent-deletion-qa` });
  const check = (await bootstrap.query("select current_setting('cluster_name') as name")).rows[0];
  assert.equal(check.name, 'ragent-deletion-' + nonce);
  let owned = false;
  t.after(async () => { await pool.end(); try { if (owned) await bootstrap.query(`drop schema "${schema}" cascade`); } finally { await bootstrap.end(); } });
  await bootstrap.query(`create schema "${schema}"`); owned = true;
  const migrations = new URL('../accounts/migrations/', import.meta.url);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const name of (await readdir(migrations)).filter(x => x.endsWith('.up.sql')).sort()) {
      const sql = await readFile(new URL(name, migrations), 'utf8');
      assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
      await client.query(sql);
    }
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }

  const identity = generateKeyPairSync('ed25519');
  const publicKey = identity.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const seal = claims => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return payload + '.' + sign(null, Buffer.from(payload), identity.privateKey).toString('base64url');
  };
  const verifyConfirmation = async ({ proof }) => {
    const [payload, signature, extra] = proof.split('.'); assert.equal(extra, undefined);
    assert(verify(null, Buffer.from(payload), identity.publicKey, Buffer.from(signature, 'base64url')));
    return JSON.parse(Buffer.from(payload, 'base64url'));
  };
  const repository = options => createAccountDeletionRepository({ pool, schema, verifyDeletionConfirmation: verifyConfirmation, ...options });
  const request = (accountId, overrides = {}) => {
    const requestId = randomUUID(), receiptSecret = randomBytes(32).toString('base64url'), now = Date.now();
    const claims = { accountId, providerSubject:'synthetic_'+accountId.replace('acct_deletion_',''), confirmationId: randomUUID(), requestId, receiptSecretHash: hash(receiptSecret),
      audience: 'ragent-account-deletion', purpose: 'delete-account-and-associated-data', issuedAt: now, expiresAt: now + 120_000, ...overrides };
    return { requestId, receiptSecret, proof: seal(claims) };
  };
  const store = createPostgresStore({ pool, schema });
  const broker = createOwnerAuthBroker({ store, verifyGoogleCredential: async () => { throw Error('No Google network calls in this fixture'); },
    resolveAccount: async () => { throw Error('No account substitution in this fixture'); }, signAssertion: () => { throw Error('No fabricated grant'); } });
  const fixtures = [];
  async function seed(label, computers = 1) {
    const id = 'acct_deletion_' + label, device = 'adev_' + label, token = 'rac_' + randomBytes(32).toString('base64url');
    const keys = generateKeyPairSync('ed25519'), pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const normalized = normalizeDevicePublicKey(pem), at = new Date().toISOString();
    await pool.query('insert into accounts(account_id,provider,provider_subject,created_at) values($1,\'google\',$2,$3)', [id, 'synthetic_' + label, at]);
    await pool.query('insert into account_devices(device_id,account_id,created_at,last_seen_at) values($1,$2,$3,$3)', [device, id, at]);
    await pool.query('insert into account_device_keys(key_id,account_id,device_id,public_key,fingerprint,created_at) values($1,$2,$3,$4,$5,$6)',
      [normalized.keyId, id, device, normalized.publicKey, createDevicePublicKeyFingerprint(pem), at]);
    await pool.query(`insert into account_credentials(credential_id,token_hash,account_id,device_id,key_id,scope,issued_at,expires_at)
      values($1,$2,$3,$4,$5,'account-directory',$6,$7)`, ['cred_' + label, hash(token), id, device, normalized.keyId, at, new Date(Date.now() + 3600_000).toISOString()]);
    const targets = [];
    for (let n = 0; n < computers; n++) {
      const key = generateKeyPairSync('ed25519'), keyText = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const instanceId = 'inst_' + label + '_' + n, fingerprint = createInstancePublicKeyFingerprint(keyText);
      await pool.query(`insert into instance_bindings(instance_id,account_id,provider,bound_at,instance_public_key,instance_key_fingerprint)
        values($1,$2,'google',$3,$4,$5)`, [instanceId, id, at, keyText, fingerprint]);
      await pool.query(`insert into binding_history(instance_id,account_id,action,occurred_at) values($1,$2,'bind',$3)`, [instanceId, id, at]);
      await pool.query(`insert into devices(device_id,instance_id,account_id,device_kind,created_at)
        values($1,$1,$2,'computer',$3)`, [instanceId,id,at]);
      targets.push({ instanceId, key });
    }
    if(targets[0]) await pool.query(`insert into account_connection_leases
      (connection_id,account_id,instance_id,device_id,status,created_at,updated_at,expires_at)
      values($1,$2,$3,$4,'connected',$5,$5,$6)`, ['turn_'+label,id,targets[0].instanceId,device,at,new Date(Date.now()+300_000).toISOString()]);
    for (let n = 0; n < 7; n++) await pool.query(`insert into account_sync_catalog
      (account_id,scope,content_key,version,source_instance_id,updated_at) values($1,'agent-profile',$2,$3,$4,$5)`,
    [id, 'profile_' + n, { updatedAt:at,counter:n,writerId:targets[0]?.instanceId || 'inst_none' }, targets[0]?.instanceId || 'inst_none', at]);
    const fixture = { id, device, token, targets }; fixtures.push(fixture); return fixture;
  }
  const foreign = await seed('foreign');
  const foreignDigest = async () => (await pool.query(`select jsonb_build_object(
    'account',(select to_jsonb(a) from accounts a where account_id=$1),
    'credential',(select to_jsonb(c) from account_credentials c where account_id=$1),
    'catalog',(select jsonb_agg(c order by content_key) from account_sync_catalog c where account_id=$1),
    'binding',(select to_jsonb(b) from instance_bindings b where account_id=$1),
    'authority',(select to_jsonb(r) from instance_authority_revisions r where instance_id=$2)) as value`, [foreign.id,foreign.targets[0].instanceId])).rows[0].value;
  const foreignBefore = await foreignDigest();
  async function unchanged() { assert.deepEqual(await foreignDigest(), foreignBefore); }
  const code = expected => error => error.code === expected;
  const count = async (table, id) => Number((await pool.query(`select count(*) as n from ${table} where account_id=$1`, [id])).rows[0].n);

  await t.test('migration can roll back only before any deletion; current identity remains normal', async () => {
    await pool.query(await readFile(new URL('033_account_deletion_jobs.down.sql', migrations), 'utf8'));
    await pool.query(await readFile(new URL('033_account_deletion_jobs.up.sql', migrations), 'utf8'));
    const directory = await broker.listAccountDirectoryDevices({ credential: foreign.token });
    assert(directory.devices.length>=2 && directory.devices.every(d=>d.sub===foreign.id));
    // Presence timestamps legitimately change on this authenticated read; reset the comparison baseline below.
  });
  const foreignStable = await foreignDigest();
  Object.assign(foreignBefore, foreignStable);

  await t.test('missing verifier and forged stale wrong-purpose or unbound confirmations never create jobs', async () => {
    assert.throws(() => createAccountDeletionRepository({ pool, schema }), /trusted fresh/);
    const f = await seed('invalid');
    for (const input of [request(f.id, { purpose: 'sign-out' }), request(f.id, { issuedAt: Date.now()-600_000, expiresAt: Date.now()-1 }),
      { ...request(f.id), proof: 'forged.bad' }, { ...request(f.id), accountId: foreign.id }]) {
      await assert.rejects(repository().accept(input));
    }
    const input = request(f.id); input.receiptSecret = randomBytes(32).toString('base64url');
    await assert.rejects(repository().accept(input), code('account_deletion_confirmation_invalid'));
    assert.equal(await count('account_deletion_jobs', f.id), 0); await unchanged();
  });

  await t.test('failure after revocation writes rolls back the job fence keys and bindings atomically', async () => {
    const f = await seed('rollback'); let injected = false;
    const brokenPool = { connect: async () => {
      const c = await pool.connect(); return { release: () => c.release(), query: async (sql, args) => {
        const result = await c.query(sql,args);
        if (/^with revoked as/.test(sql.trim())) { injected = true; throw Error('owned failure after binding revoke'); }
        return result;
      } };
    } };
    await assert.rejects(repository({ pool: brokenPool }).accept(request(f.id)), /owned failure/); assert(injected);
    assert.equal(await count('account_deletion_jobs', f.id),0); assert.equal(await count('account_deletion_fences', f.id),0);
    assert.equal((await pool.query('select revoked_at from account_credentials where account_id=$1',[f.id])).rows[0].revoked_at,null);
    assert((await broker.listAccountDirectoryDevices({ credential:f.token })).devices.every(d=>d.sub===f.id)); await unchanged();
  });

  await t.test('another verified subject or the shared managed demo cannot start consumer account deletion',async()=>{
    const f=await seed('identity');
    await assert.rejects(repository().accept(request(f.id,{providerSubject:'synthetic_foreign'})),code('account_deletion_confirmation_invalid'));
    assert.equal(await count('account_deletion_jobs',f.id),0);
    await pool.query("update accounts set provider='demo' where account_id=$1",[f.id]);
    await assert.rejects(repository().accept(request(f.id)),code('account_deletion_managed_account'));
    assert.equal(await count('account_deletion_fences',f.id),0);await unchanged();
  });

  const victim = await seed('victim',2), input = request(victim.id); let accepted;
  await t.test('concurrent cold repositories create one durable job with the same receipt and no raw secret', async () => {
    const results = await Promise.all([repository().accept(input),repository().accept(input)]);
    assert.deepEqual(results[0],results[1]); accepted = results[0];
    assert.equal(await count('account_deletion_jobs',victim.id),1); assert.equal(accepted.computers.awaitingAcknowledgment,2);
    const raw=JSON.stringify((await pool.query('select * from account_deletion_jobs where account_id=$1',[victim.id])).rows[0]);
    assert(!raw.includes(input.receiptSecret) && !raw.includes(input.proof));
    await assert.rejects(repository().accept(request(victim.id)),code('account_deletion_already_requested')); await unchanged();
  });

  await t.test('all current account keys and bindings are revoked and RAC directory reads are refused', async () => {
    for(const table of ['account_devices','account_device_keys','account_credentials','instance_bindings']) {
      assert.equal(Number((await pool.query(`select count(*) as n from ${table} where account_id=$1 and revoked_at is null`,[victim.id])).rows[0].n),0);
    }
    const lease=(await pool.query('select status,release_reason from account_connection_leases where account_id=$1',[victim.id])).rows[0];
    assert.equal(lease.status,'released');assert.equal(lease.release_reason,'account-deleted');
    for(const table of ['account_devices','account_device_keys','account_credentials','instance_bindings']) {
      await assert.rejects(pool.query(`update ${table} set revoked_at=null where account_id=$1`,[victim.id]),code('23514'));
    }
    await assert.rejects(pool.query('update devices set unbound_at=null where account_id=$1',[victim.id]),code('23514'));
    await assert.rejects(pool.query("update account_connection_leases set status='connected' where account_id=$1",[victim.id]),code('23514'));
    await assert.rejects(broker.listAccountDirectoryDevices({credential:victim.token}));
    await assert.rejects(repository().getReceipt({...input,receiptSecret:randomBytes(32).toString('base64url')}),code('account_deletion_receipt_not_found'));
    assert.deepEqual(await repository().getReceipt(input),accepted); await unchanged();
  });

  await t.test('fresh signed phone challenge cannot obtain a new credential for the fenced account',async()=>{
    const phone=generateKeyPairSync('ed25519'),phoneKey=phone.publicKey.export({type:'spki',format:'pem'}).toString();
    let verified=false;
    const login=createOwnerAuthBroker({store,verifyGoogleCredential:async ({idToken,nonce})=>{
      assert.equal(idToken,'synthetic-purpose-test');assert(nonce);verified=true;return{sub:'synthetic_victim'};
    },resolveAccount:async ({draft})=>draft.accounts.find(a=>a.accountId===victim.id),signAssertion:()=>{throw Error('No assertion may be issued');}});
    const requestId='qa_deleted_phone_'+randomUUID(),deviceId='adev_new_deleted';
    const challenge=await login.createAccountSessionChallenge({requestId,device:{deviceId,publicKey:phoneKey,platform:'android'}});
    const fields={transactionId:challenge.transactionId,requestId,deviceId,publicKeyFingerprint:createDevicePublicKeyFingerprint(phoneKey),nonce:challenge.nonce};
    await assert.rejects(login.completeAccountSession({transactionId:challenge.transactionId,requestId,idToken:'synthetic-purpose-test',
      signature:sign(null,Buffer.from(buildAccountSessionMessage(fields)),phone.privateKey).toString('base64url')}),code('account_deletion_pending'));
    assert(verified);assert.equal((await pool.query('select 1 from account_devices where device_id=$1',[deviceId])).rowCount,0);await unchanged();
  });

  await t.test('one confirmation cannot authorize a second account or request',async()=>{
    const claims=JSON.parse(Buffer.from(input.proof.split('.')[0],'base64url'));
    await assert.rejects(repository().accept(request('acct_deletion_invalid',{confirmationId:claims.confirmationId})),code('account_deletion_conflict'));
    assert.equal(await count('account_deletion_jobs','acct_deletion_invalid'),0);await unchanged();
  });

  await t.test('old snapshot writer preserves the fence on unrelated work and cannot reactivate the account', async () => {
    const path=process.env.RAGENT_TEST_SECOND_STORE_MODULE; assert(path,'Pin the exact previous PG writer');
    const legacy=(await import(pathToFileURL(resolve(path)))).createPostgresStore({pool,schema});
    await legacy.mutate(draft=>{const x=draft.accounts.find(a=>a.accountId===victim.id);assert.equal(x.deletionRequestedAt,undefined);});
    await legacy.mutate(draft=>{draft.accounts.find(a=>a.accountId==='acct_deletion_invalid').name='unrelated fixture write';});
    const row=(await pool.query('select deletion_requested_at,deletion_job_id from accounts where account_id=$1',[victim.id])).rows[0];
    assert(row.deletion_requested_at);assert.equal(row.deletion_job_id,accepted.jobId);
    await assert.rejects(legacy.mutate(draft=>{draft.instanceBindings.find(b=>b.accountId===victim.id).revokedAt='';}));
    await assert.rejects(store.mutate(draft=>{draft.accountCredentials.find(c=>c.accountId===victim.id).revokedAt='';})); await unchanged();
  });

  await t.test('same transaction lock blocks deletion until the preceding writer actually commits',async()=>{
    const f=await seed('lock'), blocker=await pool.connect(); await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock(hashtext($1))',['ragent_accounts_store_v1']);
    let pending;
    try {
      pending=repository().accept(request(f.id));
      let seen=false;
      for(let n=0;n<40;n++) {
        const r=await pool.query("select 1 from pg_stat_activity where application_name='ragent-deletion-qa' and wait_event_type='Lock' and query like '%pg_advisory_xact_lock%'");
        if(r.rowCount){seen=true;break;} await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert(seen,'Observe the actual blocked backend, not a timer-only wait');
      assert.equal((await repository().getReceipt(input)).jobId,accepted.jobId,'Read-only receipt must not wait for the writer lock');
      assert.equal(await count('account_deletion_jobs',f.id),0); await blocker.query('commit');
      assert.equal((await pending).status,'revoked');
    }finally{await blocker.query('rollback').catch(()=>{});blocker.release();if(pending)await pending.catch(()=>{});}
    await unchanged();
  });

  await t.test('bounded cleanup failure keeps the same cursor and a new repository resumes without foreign deletion', async()=>{
    let fault=true, witnessed=false;
    const brokenPool={connect:async()=>{const c=await pool.connect();return{release:()=>c.release(),query:async(sql,args)=>{
      const result=await c.query(sql,args);
      if(fault && /^delete from account_sync_catalog/.test(sql)){fault=false;witnessed=true;throw Error('owned catalog batch rollback');}return result;
    }}}};
    let before;
    for(let n=0;n<80&&!witnessed;n++) {
      before=(await pool.query('select phase_index from account_deletion_jobs where job_id=$1',[accepted.jobId])).rows[0].phase_index;
      try{await repository({pool:brokenPool}).cleanBatch({jobId:accepted.jobId,limit:3});}catch(e){assert.match(e.message,/owned catalog batch/);}
    }
    assert(witnessed);assert.equal(await count('account_sync_catalog',victim.id),7);
    assert.equal((await pool.query('select phase_index from account_deletion_jobs where job_id=$1',[accepted.jobId])).rows[0].phase_index,before);
    await repository().cleanBatch({jobId:accepted.jobId,limit:3});assert.equal(await count('account_sync_catalog',victim.id),4);
    let receipt;
    for(let n=0;n<100;n++){receipt=await repository().cleanBatch({jobId:accepted.jobId,limit:3});if(receipt.cloudErasedAt)break;}
    assert.equal(receipt.status,'waiting-for-devices');assert.equal(receipt.computers.awaitingAcknowledgment,2);
    for(const table of ['accounts','account_devices','account_credentials','account_sync_catalog','instance_bindings','binding_history']) assert.equal(await count(table,victim.id),0);
    await unchanged();
  });

  await t.test('post-erasure restore and migration down cannot resurrect original identity or drop fences',async()=>{
    await assert.rejects(pool.query("insert into accounts(account_id,provider,provider_subject) values($1,'google','synthetic_victim')",[victim.id]),code('23514'));
    await assert.rejects(pool.query('delete from account_deletion_fences where account_id=$1',[victim.id]),code('23514'));
    const c=await pool.connect();try{await c.query('begin');await assert.rejects(c.query(await readFile(new URL('033_account_deletion_jobs.down.sql',migrations),'utf8')),/rollback_would_remove_fences/);await c.query('rollback');}finally{c.release();}
    assert.equal(await count('account_deletion_fences',victim.id),1);await unchanged();
    for(const target of victim.targets){
      const authority=await store.readInstanceAuthority(target.instanceId);
      assert.equal(authority.binding,null);assert(BigInt(authority.revision)>1n);
      const state=(await pool.query('select authority_state from instance_authority_revisions where instance_id=$1',[target.instanceId])).rows[0].authority_state;
      assert.equal(state.binding,null);assert.equal(JSON.stringify(state).includes(victim.id),false);
    }
  });

  await t.test('cleanup clock rollback cannot move update or cloud-erasure timestamps backwards',async()=>{
    const f=await seed('clock',0),r=await repository().accept(request(f.id));let final;
    const slowClock=repository({clock:()=>Date.now()-86400_000});
    for(let n=0;n<100;n++){final=await slowClock.cleanBatch({jobId:r.jobId,limit:3});if(final.cloudErasedAt)break;}
    assert.equal(final.status,'completed');assert(Date.parse(final.updatedAt)>=Date.parse(r.requestedAt));
    assert(Date.parse(final.cloudErasedAt)>=Date.parse(r.requestedAt));await unchanged();
  });

  const acknowledgment=(target,localCopies,jobId=accepted.jobId)=>{
    const fields={jobId,instanceId:target.instanceId,issuedAt:Date.now(),localCopies};
    return {...fields,signature:sign(null,Buffer.from(buildAccountDeletionAcknowledgment(fields)),target.key.privateKey).toString('base64url')};
  };
  await t.test('signed exact-job acknowledgments distinguish offline copies owner action and final completion',async()=>{
    await assert.rejects(repository().acknowledgeTarget({...acknowledgment(victim.targets[0],'kept'),signature:'bad'}));
    await assert.rejects(repository().acknowledgeTarget(acknowledgment(foreign.targets[0],'kept')));
    await assert.rejects(repository().acknowledgeTarget(acknowledgment(victim.targets[0],'kept',randomUUID())));
    assert.equal((await repository().acknowledgeTarget(acknowledgment(victim.targets[0],'kept'))).status,'waiting-for-devices');
    const needs=await repository().acknowledgeTarget(acknowledgment(victim.targets[1],'requires-owner'));
    assert.equal(needs.status,'needs-owner');assert.equal(needs.computers.requiresOwner,1);
    assert.equal((await repository().acknowledgeTarget(acknowledgment(victim.targets[1],'deleted'))).status,'completed');
    const final=await repository().getReceipt(input);assert.equal(final.localFilesAutomaticallyErased,false);
    assert.equal(final.computers.awaitingAcknowledgment,0);
    assert.deepEqual(await repository().acknowledgeTarget(acknowledgment(victim.targets[0],'kept')),final);
    await assert.rejects(repository().acknowledgeTarget(acknowledgment(victim.targets[0],'deleted')),code('account_deletion_ack_conflict'));await unchanged();
    await assert.rejects(pool.query(`insert into account_deletion_targets(job_id,instance_id,public_key,key_fingerprint)
      values($1,'inst_extra','key','fingerprint')`,[accepted.jobId]),code('23514'));
    await assert.rejects(pool.query('update account_deletion_jobs set phase_index=0 where job_id=$1',[accepted.jobId]),code('23514'));
    await assert.rejects(pool.query("update account_deletion_targets set public_key='substituted' where job_id=$1",[accepted.jobId]),code('23514'));
  });

  await t.test('owned repository process killed after COMMIT recovers its original receipt from a cold connection',async()=>{
    const f=await seed('crash'), req=request(f.id);
    const child=fork(new URL('./helpers/account-deletion-commit-child.mjs',import.meta.url),[],{silent:true,
      env:{...process.env,RAGENT_DELETION_CHILD_INPUT:JSON.stringify({schema,request:req,publicKey})}});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),15_000); let message;
    try{
      message=await Promise.race([once(child,'message').then(x=>x[0]),once(child,'exit').then(()=>{throw Error('Owned child exited before commit signal');})]);
      const closed=once(child,'exit');child.kill('SIGKILL');const [,signal]=await closed;assert.equal(signal,'SIGKILL');
    }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
    const recovered=await repository().getReceipt(req);assert.equal(recovered.jobId,message.committed);assert.equal(await count('account_deletion_jobs',f.id),1);
    assert.equal(recovered.status,'revoked');await unchanged();
  });
});
