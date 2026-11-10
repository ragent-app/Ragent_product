// Scoped PostgreSQL deletion transactions. Not a public route or an identity
// verifier: the trusted assembler must inject fresh, purpose-bound verification.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createInstancePublicKeyFingerprint, verifyInstanceProofSignature } from '../../lib/instance-proof-protocol.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,160}$/;
const PURPOSE = 'delete-account-and-associated-data';
const AUDIENCE = 'agentoc-account-deletion';
const sha = value => createHash('sha256').update(value).digest('hex');
const sameHash = (a, b) => /^[a-f0-9]{64}$/.test(a || '') && /^[a-f0-9]{64}$/.test(b || '')
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const iso = value => value ? new Date(value).toISOString() : null;
function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { code, statusCode });
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('account_deletion_id_invalid');
  return value;
}
function secretHash(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)
    || Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) {
    fail('account_deletion_receipt_secret_invalid');
  }
  return sha(value);
}
function time(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('account_deletion_clock_invalid', 503);
  return value;
}
function fresh(claims, now) {
  if (claims.audience !== AUDIENCE || claims.purpose !== PURPOSE || !ACCOUNT.test(claims.accountId || '')
    || typeof claims.providerSubject !== 'string' || !claims.providerSubject || claims.providerSubject.length>256
    || /[\s\0]/.test(claims.providerSubject)
    || !UUID.test(claims.confirmationId || '') || !Number.isSafeInteger(claims.issuedAt)
    || !Number.isSafeInteger(claims.expiresAt) || claims.issuedAt > now + 30_000
    || claims.issuedAt < now - 300_000 || claims.expiresAt <= now
    || claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > 300_000) {
    fail('account_deletion_confirmation_invalid', 401);
  }
}

// Indirect rows are removed before their parent. Names and predicates are fixed
// code, not request input. One bounded batch commits with the same phase cursor.
const CLEANUP = [
  ['owner_auth_browser_states', 'exists(select 1 from owner_auth_transactions t where t.transaction_id=q.transaction_id and t.account_id=$1)'],
  ['account_credential_refreshes', 'exists(select 1 from account_credentials c where c.credential_id=q.credential_id and c.account_id=$1)'],
  ['account_session_challenges', 'exists(select 1 from account_devices d where d.device_id=q.device_id and d.account_id=$1)'],
  ...['account_join_grants', 'account_pairing_exchanges', 'temporary_control_exchanges', 'temporary_pairing_exchanges',
    'target_runtime_authorizations', 'provider_refresh_leases', 'provider_refresh_meta', 'account_sync_catalog',
    'account_connection_leases', 'native_owner_auth_requests', 'account_join_intents', 'owner_auth_transactions',
    'instance_authority_completions', 'account_credentials', 'account_device_keys', 'account_devices',
    'devices', 'instance_bindings', 'account_asr_requests', 'account_asr_usage', 'account_file_uploads',
    'account_entitlements', 'binding_history', 'accounts'].map(table => [table, 'q.account_id=$1']),
];

export function buildAccountDeletionAcknowledgment({ jobId, instanceId, issuedAt, localCopies }) {
  uuid(jobId);
  if (!ACCOUNT.test(instanceId || '') || !Number.isSafeInteger(issuedAt)
    || !['kept', 'deleted', 'requires-owner'].includes(localCopies)) fail('account_deletion_ack_invalid');
  return ['agentoc-account-deletion-observed-v1', jobId, instanceId, issuedAt, localCopies].join('\n');
}

export function createAccountDeletionRepository({ pool, schema = 'public', verifyDeletionConfirmation, clock = Date.now } = {}) {
  if (!pool?.connect || typeof verifyDeletionConfirmation !== 'function') {
    throw new TypeError('Account deletion requires PostgreSQL and a trusted fresh identity-confirmation verifier');
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new TypeError('A single fixed schema is required');
  async function transaction(run, readOnly = false) {
    const client = await pool.connect();
    try {
      await client.query(readOnly ? 'begin isolation level repeatable read read only' : 'begin');
      await client.query('select set_config($1,$2,true)', ['search_path', schema]);
      await client.query('select set_config($1,$2,true)', ['lock_timeout', '5000ms']);
      await client.query('select set_config($1,$2,true)', ['statement_timeout', '15000ms']);
      // Same lock as the existing Accounts writer and authority finalization.
      if (!readOnly) await client.query('select pg_advisory_xact_lock(hashtext($1))', ['agentoc_accounts_store_v1']);
      const result = await run(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      if (error?.code === '23505') fail('account_deletion_conflict', 409);
      if (error?.code === '23514') fail('account_deletion_store_constraint', 409);
      if (['42P01', '42703'].includes(error?.code)) fail('account_deletion_migration_required', 503);
      if (['55P03', '57014'].includes(error?.code)) fail('account_deletion_store_busy', 503);
      throw error;
    } finally { client.release(); }
  }
  async function receipt(client, job) {
    const counts = (await client.query(`select count(*)::integer as total,
      count(*) filter(where acknowledged_at is null)::integer as waiting,
      count(*) filter(where local_copies='requires-owner')::integer as requires_owner
      from account_deletion_targets where job_id=$1`, [job.job_id])).rows[0];
    return { schemaVersion: 1, jobId: job.job_id, requestId: job.request_id, status: job.status,
      requestedAt: iso(job.requested_at), updatedAt: iso(job.updated_at), cloudErasedAt: iso(job.cloud_erased_at),
      computers: { total: counts.total, awaitingAcknowledgment: counts.waiting, requiresOwner: counts.requires_owner },
      retainedRecords: ['deletion-receipt', 'account-revocation-fence', 'instance-authority-generations', 'workbench-deletion-acknowledgments', 'voice-processing-consent-evidence'],
      localFilesAutomaticallyErased: false };
  }

  async function accept(input) {
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !['requestId', 'receiptSecret', 'proof'].includes(k))) {
      fail('account_deletion_request_invalid');
    }
    const requestId = uuid(input.requestId), receiptHash = secretHash(input.receiptSecret);
    if (typeof input.proof !== 'string' || !input.proof || input.proof.length > 16_384) fail('account_deletion_confirmation_invalid', 401);
    let verified;
    try { verified = await verifyDeletionConfirmation({ proof: input.proof, requestId, receiptSecretHash: receiptHash, purpose: PURPOSE, audience: AUDIENCE }); }
    catch { fail('account_deletion_confirmation_invalid', 401); }
    const claims = Object.freeze({ accountId: verified?.accountId, providerSubject: verified?.providerSubject, confirmationId: verified?.confirmationId,
      issuedAt: verified?.issuedAt, expiresAt: verified?.expiresAt, purpose: verified?.purpose, audience: verified?.audience });
    fresh(claims, time(clock));
    if (verified?.requestId !== requestId || !sameHash(verified?.receiptSecretHash, receiptHash)) fail('account_deletion_confirmation_invalid', 401);
    return transaction(async client => {
      fresh(claims, time(clock)); // A lock wait must not extend proof validity.
      const prior = (await client.query('select * from account_deletion_jobs where request_id=$1', [requestId])).rows[0];
      if (prior) {
        if (prior.account_id !== claims.accountId || prior.confirmation_id !== claims.confirmationId
          || !sameHash(prior.receipt_secret_hash, receiptHash)) fail('account_deletion_request_conflict', 409);
        return receipt(client, prior);
      }
      const account = (await client.query('select account_id,provider,provider_subject from accounts where account_id=$1 for update', [claims.accountId])).rows[0];
      if (!account) fail('account_deletion_account_unavailable', 404);
      if (account.provider !== 'google') fail('account_deletion_managed_account', 403);
      if (claims.providerSubject !== account.provider_subject) fail('account_deletion_confirmation_invalid', 401);
      if ((await client.query('select 1 from account_deletion_fences where account_id=$1', [claims.accountId])).rowCount) {
        fail('account_deletion_already_requested', 409);
      }
      const at = new Date(time(clock)).toISOString(), jobId = randomUUID(), accountId = claims.accountId;
      const job = (await client.query(`insert into account_deletion_jobs
        (job_id,request_id,account_id,confirmation_id,receipt_secret_hash,status,requested_at,updated_at)
        values($1,$2,$3,$4,$5,'revoked',$6,$6) returning *`,
      [jobId, requestId, accountId, claims.confirmationId, receiptHash, at])).rows[0];
      await client.query(`insert into account_deletion_targets(job_id,instance_id,public_key,key_fingerprint)
        select $1,instance_id,coalesce(instance_public_key,''),coalesce(instance_key_fingerprint,'')
        from instance_bindings where account_id=$2`, [jobId, accountId]);
      await client.query('insert into account_deletion_fences(account_id,job_id,requested_at) values($1,$2,$3)', [accountId, jobId, at]);
      await client.query('update accounts set deletion_requested_at=$2,deletion_job_id=$3 where account_id=$1', [accountId, at, jobId]);
      for (const table of ['account_credentials', 'account_device_keys', 'account_devices']) {
        await client.query(`update ${table} set revoked_at=$2 where account_id=$1 and revoked_at is null`, [accountId, at]);
      }
      await client.query(`with revoked as (
        update instance_bindings set revoked_at=$2 where account_id=$1 and revoked_at is null returning instance_id
      ) insert into binding_history(instance_id,account_id,action,occurred_at) select instance_id,$1,'unbind',$2 from revoked`, [accountId, at]);
      await client.query('update devices set unbound_at=$2 where account_id=$1 and unbound_at is null', [accountId, at]);
      await client.query(`update account_connection_leases set status='released',released_at=$2,release_reason='account-deleted',
        updated_at=greatest(updated_at,$2::timestamptz) where account_id=$1 and status<>'released'`, [accountId, at]);
      await client.query(`delete from owner_auth_browser_states b using owner_auth_transactions t
        where b.transaction_id=t.transaction_id and (t.account_id=$1 or (t.account_id is null and t.created_at<=$3
        and exists(select 1 from account_deletion_targets d where d.job_id=$2 and d.instance_id=t.instance_id)))`, [accountId, jobId, at]);
      for (const table of ['owner_auth_transactions','account_join_intents']) {
        await client.query(`delete from ${table} t where t.account_id=$1 or (t.account_id is null and t.created_at<=$3
          and exists(select 1 from account_deletion_targets d where d.job_id=$2 and d.instance_id=t.instance_id))`, [accountId,jobId,at]);
      }
      // Replays/issuers must have no retained grant to rebuild. Other content is
      // erased later in bounded batches; all operations remain account-scoped.
      for (const table of ['account_join_grants', 'account_join_intents', 'owner_auth_transactions', 'native_owner_auth_requests',
        'provider_refresh_leases', 'provider_refresh_meta', 'target_runtime_authorizations',
        'temporary_pairing_exchanges', 'temporary_control_exchanges', 'account_pairing_exchanges', 'instance_authority_completions']) {
        await client.query(`delete from ${table} where account_id=$1`, [accountId]);
      }
      await client.query('set constraints instance_authority_flush immediate');
      return receipt(client, job);
    });
  }

  async function getReceipt({ requestId, receiptSecret } = {}) {
    uuid(requestId); const digest = secretHash(receiptSecret);
    return transaction(async client => {
      const job = (await client.query('select * from account_deletion_jobs where request_id=$1 and receipt_secret_hash=$2', [requestId, digest])).rows[0];
      if (!job) fail('account_deletion_receipt_not_found', 404);
      return receipt(client, job);
    }, true);
  }

  async function cleanBatch({ jobId, limit = 100 } = {}) {
    uuid(jobId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('account_deletion_batch_invalid');
    return transaction(async client => {
      let job = (await client.query('select * from account_deletion_jobs where job_id=$1 for update', [jobId])).rows[0];
      if (!job) fail('account_deletion_job_not_found', 404);
      if (job.plan_version !== 1) fail('account_deletion_plan_unsupported', 503);
      if (job.cloud_erased_at) return receipt(client, job);
      const phase = CLEANUP[job.phase_index], at = new Date(time(clock)).toISOString();
      if (!phase) fail('account_deletion_cursor_invalid', 503);
      if (phase) {
        const [table, predicate] = phase;
        const removed = await client.query(`delete from ${table} d where d.ctid in
          (select q.ctid from ${table} q where ${predicate} limit $2)`, [job.account_id, limit]);
        if (table === 'accounts') {
          // The account PK permits at most one row. Its erasure and the fence's
          // irreversible resurrection boundary must commit together.
          job = (await client.query(`update account_deletion_jobs set phase_index=phase_index+1,
            cloud_erased_at=greatest(updated_at,$2::timestamptz),updated_at=greatest(updated_at,$2::timestamptz),
            status=case when exists(select 1 from account_deletion_targets where job_id=$1 and acknowledged_at is null)
            then 'waiting-for-devices' when exists(select 1 from account_deletion_targets where job_id=$1 and local_copies='requires-owner')
            then 'needs-owner' else 'completed' end where job_id=$1 returning *`, [jobId, at])).rows[0];
          return receipt(client, job);
        }
        job = (await client.query(`update account_deletion_jobs set status='cleaning',
          phase_index=phase_index+$2,updated_at=greatest(updated_at,$3::timestamptz) where job_id=$1 returning *`,
        [jobId, removed.rowCount ? 0 : 1, at])).rows[0];
      }
      return receipt(client, job);
    });
  }

  async function acknowledgeTarget(input = {}) {
    if (Object.keys(input).some(k => !['jobId','instanceId','issuedAt','localCopies','signature'].includes(k))) fail('account_deletion_ack_invalid');
    const { jobId, instanceId, issuedAt, localCopies, signature } = input;
    const message = buildAccountDeletionAcknowledgment(input);
    if (typeof signature !== 'string' || signature.length > 1024 || Math.abs(time(clock) - issuedAt) > 120_000) fail('account_deletion_ack_invalid', 401);
    return transaction(async client => {
      const job = (await client.query('select * from account_deletion_jobs where job_id=$1 for update', [jobId])).rows[0];
      const target = (await client.query('select * from account_deletion_targets where job_id=$1 and instance_id=$2', [jobId, instanceId])).rows[0];
      if (!job || !target || !verifyInstanceProofSignature({ publicKey: target.public_key, message, signature })) fail('account_deletion_ack_invalid', 401);
      if (createInstancePublicKeyFingerprint(target.public_key) !== target.key_fingerprint) fail('account_deletion_ack_invalid', 401);
      if (target.acknowledged_at) {
        if (target.local_copies === localCopies) return receipt(client, job);
        if (target.local_copies !== 'requires-owner' || !['kept','deleted'].includes(localCopies)) fail('account_deletion_ack_conflict', 409);
      }
      const at = new Date(time(clock)).toISOString();
      await client.query('update account_deletion_targets set acknowledged_at=coalesce(acknowledged_at,$3),local_copies=$4 where job_id=$1 and instance_id=$2', [jobId, instanceId, at, localCopies]);
      const updated = (await client.query(`update account_deletion_jobs set updated_at=greatest(updated_at,$2::timestamptz),
        status=case when cloud_erased_at is not null and not exists
        (select 1 from account_deletion_targets where job_id=$1 and acknowledged_at is null)
        then case when exists(select 1 from account_deletion_targets where job_id=$1 and local_copies='requires-owner')
        then 'needs-owner' else 'completed' end else status end where job_id=$1 returning *`, [jobId, at])).rows[0];
      return receipt(client, updated);
    });
  }
  return Object.freeze({ accept, getReceipt, cleanBatch, acknowledgeTarget });
}
