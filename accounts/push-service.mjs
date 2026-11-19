import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createSign,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyInstanceProofSignature } from '../lib/instance-proof-protocol.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const fail = (code, statusCode = 400) => {
  throw Object.assign(new Error(code), { code, statusCode });
};
const field = (value, max = 256) =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max && !/[\u0000-\u001f]/.test(value);
const kinds = new Set([
  'completion',
  'plan',
  'permission',
  'answer',
  'danger',
  'approval',
  'attention',
  'attention_resolved',
]);
const equalHash = (a, b) =>
  /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

// Separate narrow repository avoids copying raw device tokens into account snapshots.
export function createAccountPushService({
  pool,
  schema = 'public',
  authenticateAccount,
  encryptionKey,
  accountFile,
  projectId,
  fetchImpl = fetch,
  clock = Date.now,
}) {
  if (!pool || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema) || !/^[a-f0-9]{64}$/i.test(encryptionKey || ''))
    throw new TypeError('Push storage configuration missing');
  const key = Buffer.from(encryptionKey, 'hex');
  const bounded = (value, fallback, maximum) => Math.max(1, Math.min(maximum, Number.parseInt(value, 10) || fallback));
  const batchSize = bounded(process.env.RAGENT_ACCOUNTS_PUSH_BATCH_SIZE, 8, 32);
  const concurrency = bounded(process.env.RAGENT_ACCOUNTS_PUSH_CONCURRENCY, 4, 8);
  let timer,
    running,
    bearer,
    dispatcherFailed = false,
    workerLastError = '';
  async function checkReady() {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '') || !accountFile) {
      fail('push_configuration_unavailable', 503);
    }
    try {
      const account = JSON.parse(await readFile(accountFile, 'utf8'));
      if (!account.client_email || typeof account.private_key !== 'string') throw new Error();
      const privateKey = createPrivateKey(account.private_key);
      if (privateKey.asymmetricKeyType !== 'rsa') throw new Error();
    } catch {
      fail('push_credential_unavailable', 503);
    }
    try {
      await tx(async (c) => {
        await c.query(
          'select registration_id,account_id,device_id,revoke_hash,token_ciphertext,token_hash,request_hash,enabled,revoked_at from account_push_registrations limit 0',
        );
        await c.query('select registration_id,instance_id from account_push_subscriptions limit 0');
        await c.query(
          'select instance_id,account_id,kind,event_id,payload_hash,payload from account_push_events limit 0',
        );
        await c.query(
          'select id,status,attempts,next_attempt_at,lease_token,lease_until,last_error,received_at,posted_at,suppressed_at from account_push_delivery_outbox limit 0',
        );
        await c.query('select instance_id,nonce_hash,expires_at from account_push_nonces limit 0');
      });
    } catch {
      fail('push_schema_unavailable', 503);
    }
    return true;
  }
  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('search_path',$1,true)", [schema]);
      const result = await fn(c);
      await c.query('commit');
      return result;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  function seal(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    return [iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]
      .map((x) => x.toString('base64url'))
      .join('.');
  }
  function open(value) {
    const [iv, body, tail, tag] = value.split('.').map((x) => Buffer.from(x, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(body), cipher.update(tail), cipher.final()]).toString('utf8');
  }
  async function register(input, credential) {
    const auth = await authenticateAccount({ credential });
    const { registrationId, revokeCapability, token, instanceIds, appVersion = '', notificationsEnabled } = input;
    if (
      !/^preg_[a-f0-9]{32}$/.test(registrationId || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(revokeCapability || '') ||
      !field(token, 4096) ||
      !token ||
      !field(appVersion, 128) ||
      typeof notificationsEnabled !== 'boolean' ||
      !Array.isArray(instanceIds) ||
      instanceIds.length > 100 ||
      instanceIds.some((x) => !/^inst_[a-f0-9]{32}$/.test(x)) ||
      new Set(instanceIds).size !== instanceIds.length
    )
      fail('push_invalid');
    const ids = [...instanceIds].sort(),
      requestHash = hash(JSON.stringify([token, ids, appVersion, notificationsEnabled, revokeCapability]));
    return tx(async (c) => {
      // Lock the device row against concurrent logout/revocation and competing registration.
      const device = await c.query(
        'select device_id from account_devices where account_id=$1 and device_id=$2 and revoked_at is null for update',
        [auth.accountId, auth.deviceId],
      );
      if (!device.rowCount) fail('push_unauthorized', 403);
      const valid = await c.query(
        'select instance_id from instance_bindings where account_id=$1 and revoked_at is null and instance_id=any($2::text[]) for share',
        [auth.accountId, ids],
      );
      if (valid.rowCount !== ids.length) fail('push_instance_unauthorized', 403);
      const existing = await c.query(
        'select account_id,device_id,request_hash,revoked_at from account_push_registrations where registration_id=$1 for update',
        [registrationId],
      );
      if (existing.rowCount) {
        const r = existing.rows[0];
        if (
          r.account_id !== auth.accountId ||
          r.device_id !== auth.deviceId ||
          r.request_hash !== requestHash ||
          r.revoked_at
        )
          fail('push_registration_conflict', 409);
        return { ok: true, registrationId };
      }
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [hash(token)]);
      const previous = await c.query(
        `update account_push_registrations set revoked_at=now()
        where revoked_at is null and ((account_id=$1 and device_id=$2) or token_hash=$3)
        returning registration_id,account_id,device_id`,
        [auth.accountId, auth.deviceId, hash(token)],
      );
      await c.query(
        'insert into account_push_registrations(registration_id,account_id,device_id,revoke_hash,token_ciphertext,token_hash,request_hash,app_version,enabled) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          registrationId,
          auth.accountId,
          auth.deviceId,
          hash(revokeCapability),
          seal(token),
          hash(token),
          requestHash,
          appVersion,
          notificationsEnabled,
        ],
      );
      for (const id of ids) await c.query('insert into account_push_subscriptions values($1,$2)', [registrationId, id]);
      const previousOwnIds = previous.rows
        .filter((row) => row.account_id === auth.accountId && row.device_id === auth.deviceId)
        .map((row) => row.registration_id);
      if (notificationsEnabled && previousOwnIds.length && ids.length) {
        // An in-flight old token may already have reached Google. Requeue its
        // stable event for the new generation; the phone deduplicates eventId.
        await c.query(
          `insert into account_push_delivery_outbox(instance_id,kind,event_id,registration_id)
          select o.instance_id,o.kind,o.event_id,$1 from account_push_delivery_outbox o
          join account_push_events e on (e.instance_id,e.kind,e.event_id)=(o.instance_id,o.kind,o.event_id)
          where o.registration_id=any($2::text[]) and o.status in ('pending','retry','sending')
            and o.instance_id=any($3::text[]) and (e.payload->>'expiresAt')::bigint > $4
          on conflict do nothing`,
          [registrationId, previousOwnIds, ids, clock()],
        );
      }
      if (previousOwnIds.length) {
        await c.query(
          `update account_push_delivery_outbox set status='superseded',updated_at=now()
          where registration_id=any($1::text[]) and status in ('pending','retry')`,
          [previousOwnIds],
        );
      }
      return { ok: true, registrationId };
    });
  }
  async function revoke({ registrationId, revokeCapability }) {
    if (!/^preg_[a-f0-9]{32}$/.test(registrationId || '') || !/^[A-Za-z0-9_-]{43}$/.test(revokeCapability || ''))
      fail('push_invalid');
    return tx(async (c) => {
      const r = await c.query(
        'select revoke_hash from account_push_registrations where registration_id=$1 for update',
        [registrationId],
      );
      if (!r.rowCount) return { ok: true };
      if (!equalHash(r.rows[0].revoke_hash, hash(revokeCapability))) fail('push_unauthorized', 403);
      await c.query(
        'update account_push_registrations set revoked_at=coalesce(revoked_at,now()) where registration_id=$1',
        [registrationId],
      );
      return { ok: true };
    });
  }
  async function receipt({ instanceId, eventId, kind, stage }, credential) {
    if (
      !/^inst_[a-f0-9]{32}$/.test(instanceId || '') ||
      !field(eventId) ||
      !eventId ||
      !kinds.has(kind) ||
      !['received', 'posted', 'suppressed'].includes(stage)
    )
      fail('push_invalid');
    const auth = await authenticateAccount({ credential });
    const column = { received: 'received_at', posted: 'posted_at', suppressed: 'suppressed_at' }[stage];
    return tx(async (c) => {
      const result = await c.query(
        `update account_push_delivery_outbox o set ${column}=coalesce(${column},now()),updated_at=now()
        from account_push_events e, account_push_registrations r
        where o.instance_id=e.instance_id and o.kind=e.kind and o.event_id=e.event_id
        and r.registration_id=o.registration_id and r.account_id=$1 and r.device_id=$2
        and e.account_id=$1 and e.instance_id=$3 and e.kind=$4 and e.event_id=$5`,
        [auth.accountId, auth.deviceId, instanceId, kind, eventId],
      );
      if (!result.rowCount) fail('push_event_not_found', 404);
      return { ok: true };
    });
  }
  async function status({ instanceId }, credential) {
    if (!/^inst_[a-f0-9]{32}$/.test(instanceId || '')) fail('push_invalid');
    const auth = await authenticateAccount({ credential });
    let configuration = 'ready';
    let configurationError = '';
    try {
      await checkReady();
    } catch (error) {
      configuration = 'unavailable';
      configurationError = error.code || 'push_unavailable';
    }
    return tx(async (c) => {
      const binding = await c.query(
        'select 1 from instance_bindings where instance_id=$1 and account_id=$2 and revoked_at is null',
        [instanceId, auth.accountId],
      );
      if (!binding.rowCount) fail('push_unauthorized', 403);
      if (configuration !== 'ready') {
        return { ok: true, configuration, configurationError, workerLastError, deliveries: [] };
      }
      const rows = await c.query(
        `select o.event_id,o.kind,o.status,o.last_error,o.created_at,o.updated_at,
        o.received_at,o.posted_at,o.suppressed_at from account_push_delivery_outbox o
        join account_push_events e on (e.instance_id,e.kind,e.event_id)=(o.instance_id,o.kind,o.event_id)
        join account_push_registrations r on r.registration_id=o.registration_id
        where e.instance_id=$1 and e.account_id=$2 and r.device_id=$3 order by o.id desc limit 50`,
        [instanceId, auth.accountId, auth.deviceId],
      );
      return { ok: true, configuration, configurationError, workerLastError, deliveries: rows.rows };
    });
  }
  async function instances(_input, credential) {
    const auth = await authenticateAccount({ credential });
    return tx(async (c) => {
      const result = await c.query(
        'select instance_id from instance_bindings where account_id=$1 and revoked_at is null order by instance_id',
        [auth.accountId],
      );
      return { ok: true, instanceIds: result.rows.map((row) => row.instance_id) };
    });
  }
  async function event(input) {
    const {
      instanceId,
      eventId,
      sessionId,
      kind,
      runId = '',
      awaitingKey = '',
      generation = '',
      occurredAt,
      expiresAt,
      issuedAt,
      nonce,
      signature,
    } = input;
    if (
      !/^inst_[a-f0-9]{32}$/.test(instanceId || '') ||
      !field(eventId) ||
      !eventId ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId || '') ||
      !kinds.has(kind) ||
      !field(runId) ||
      !field(awaitingKey, 512) ||
      !(generation === '' || (typeof generation === 'string' && /^[1-9][0-9]{0,19}$/.test(generation))) ||
      (kind !== 'completion' && !(kind === 'attention' && awaitingKey === 'waiting_user') && !generation) ||
      (kind === 'attention_resolved' && !awaitingKey) ||
      !Number.isSafeInteger(occurredAt) ||
      !Number.isSafeInteger(expiresAt) ||
      occurredAt > clock() + 30000 ||
      expiresAt <= clock() ||
      expiresAt <= occurredAt ||
      expiresAt - occurredAt > (kind === 'completion' || kind === 'attention_resolved' ? 86400000 : 900000) ||
      !Number.isSafeInteger(issuedAt) ||
      Math.abs(clock() - issuedAt) > 30000 ||
      !/^[A-Za-z0-9_-]{24,128}$/.test(nonce || '') ||
      !/^[A-Za-z0-9_-]{1,512}$/.test(signature || '')
    )
      fail('push_invalid');
    const payload = { instanceId, eventId, sessionId, kind, runId, awaitingKey, generation, occurredAt, expiresAt },
      digest = hash(JSON.stringify(payload));
    return tx(async (c) => {
      const b = await c.query(
        'select account_id,instance_public_key from instance_bindings where instance_id=$1 and revoked_at is null for share',
        [instanceId],
      );
      if (!b.rowCount || !b.rows[0].instance_public_key) fail('push_unauthorized', 403);
      const message = JSON.stringify([
        'ragent-push-event-v1',
        instanceId,
        eventId,
        sessionId,
        kind,
        runId,
        awaitingKey,
        generation,
        occurredAt,
        expiresAt,
        issuedAt,
        nonce,
      ]);
      const ok = verifyInstanceProofSignature({ publicKey: b.rows[0].instance_public_key, message, signature });
      if (!ok) fail('push_unauthorized', 403);
      await c.query('delete from account_push_nonces where expires_at<now()');
      const seen = await c.query(
        "insert into account_push_nonces values($1,$2,now()+interval '1 minute') on conflict do nothing",
        [instanceId, hash(nonce)],
      );
      if (!seen.rowCount) fail('push_replayed', 409);
      // One lock per session orders terminal and approval resolution fences.
      await c.query('select pg_advisory_xact_lock(hashtext($1),hashtext($2))', [instanceId, sessionId]);
      const inserted = await c.query(
        'insert into account_push_events(instance_id,account_id,kind,event_id,payload_hash,payload) values($1,$2,$3,$4,$5,$6) on conflict do nothing',
        [instanceId, b.rows[0].account_id, kind, eventId, digest, JSON.stringify(payload)],
      );
      const accepted = { ok: true, accepted: true, instanceId, kind, eventId };
      if (!inserted.rowCount) {
        const prior = await c.query(
          'select account_id,payload_hash from account_push_events where instance_id=$1 and kind=$2 and event_id=$3',
          [instanceId, kind, eventId],
        );
        if (prior.rows[0]?.account_id !== b.rows[0].account_id || prior.rows[0]?.payload_hash !== digest)
          fail('push_event_conflict', 409);
        return accepted;
      }
      // Serialize terminal/attention decisions for a session, including out-of-order arrivals.
      if (runId) {
        if (kind === 'completion')
          await c.query(
            `update account_push_delivery_outbox o set status='superseded',updated_at=now() from account_push_events e where o.instance_id=e.instance_id and o.kind=e.kind and o.event_id=e.event_id and e.instance_id=$1 and e.payload->>'runId'=$2 and e.kind not in ('completion','attention_resolved') and o.status in ('pending','retry')`,
            [instanceId, runId],
          );
        else if (kind !== 'attention_resolved') {
          const terminal = await c.query(
            "select 1 from account_push_events where instance_id=$1 and kind='completion' and payload->>'runId'=$2 limit 1",
            [instanceId, runId],
          );
          if (terminal.rowCount) return accepted;
        }
      }
      if (awaitingKey) {
        if (kind === 'attention_resolved')
          await c.query(
            `update account_push_delivery_outbox o set status='superseded',updated_at=now() from account_push_events e where o.instance_id=e.instance_id and o.kind=e.kind and o.event_id=e.event_id and e.instance_id=$1 and e.payload->>'sessionId'=$2 and ((e.payload->>'awaitingKey'=$3 and e.payload->>'generation'=$5) or ($4<>'' and e.payload->>'awaitingKey'='waiting_user' and e.payload->>'runId'=$4)) and e.kind not in ('completion','attention_resolved') and o.status in ('pending','retry')`,
            [instanceId, sessionId, awaitingKey, runId, generation],
          );
        else if (kind !== 'completion') {
          const resolved = await c.query(
            "select 1 from account_push_events where instance_id=$1 and kind='attention_resolved' and payload->>'sessionId'=$2 and ((payload->>'awaitingKey'=$3 and payload->>'generation'=$5) or ($3='waiting_user' and $4<>'' and payload->>'runId'=$4)) limit 1",
            [instanceId, sessionId, awaitingKey, runId, generation],
          );
          if (resolved.rowCount) return accepted;
        }
      }
      await c.query(
        `insert into account_push_delivery_outbox(instance_id,kind,event_id,registration_id)
        select $1,$2,$3,r.registration_id from account_push_registrations r join account_push_subscriptions s using(registration_id)
        join account_devices d on d.device_id=r.device_id and d.account_id=r.account_id
        where r.account_id=$4 and r.revoked_at is null and r.enabled and d.revoked_at is null and s.instance_id=$1`,
        [instanceId, kind, eventId, b.rows[0].account_id],
      );
      return accepted;
    });
  }
  async function accessToken(account) {
    if (bearer && bearer.expiry > clock() + 60000 && bearer.email === account.client_email) return bearer.value;
    const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url'),
      now = Math.floor(clock() / 1000);
    const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(body);
    const assertion = `${body}.${signer.sign(account.private_key).toString('base64url')}`;
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('oauth_unavailable');
    const data = await response.json();
    if (!data.access_token) throw new Error('oauth_invalid');
    bearer = {
      value: data.access_token,
      expiry: clock() + Number(data.expires_in || 3600) * 1000,
      email: account.client_email,
    };
    return bearer.value;
  }
  async function dispatch() {
    const lease = randomUUID();
    const items = await tx(async (c) => {
      await c.query(
        "update account_push_delivery_outbox set status='retry',lease_token=null,lease_until=null where status='sending' and lease_until<now()",
      );
      await c.query(
        "update account_push_delivery_outbox set status='expired',updated_at=now() where status in ('pending','retry') and created_at<now()-interval '24 hours'",
      );
      await c.query("delete from account_push_events where created_at<now()-interval '7 days'");
      await c.query("delete from account_push_registrations where revoked_at<now()-interval '7 days'");
      const r = await c.query(
        `with selected as (select id from account_push_delivery_outbox where status in ('pending','retry') and next_attempt_at<=now() order by id for update skip locked limit $2)
        update account_push_delivery_outbox o set status='sending',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '5 minutes',updated_at=now() from selected where o.id=selected.id returning o.id`,
        [lease, Math.min(batchSize, concurrency * 2)],
      );
      return r.rows;
    });
    const deliver = async (item) => {
      let disposition = 'retry',
        reason = 'unavailable',
        retrySeconds = 30;
      try {
        const row = await tx(
          async (c) =>
            (
              await c.query(
                `select r.token_ciphertext,r.token_hash,r.registration_id,e.account_id,e.payload from account_push_delivery_outbox o
          join account_push_events e on (e.instance_id,e.kind,e.event_id)=(o.instance_id,o.kind,o.event_id)
          join account_push_registrations r on r.registration_id=o.registration_id
          join account_push_subscriptions s on s.registration_id=r.registration_id and s.instance_id=e.instance_id
          join account_devices d on d.device_id=r.device_id and d.account_id=r.account_id and d.revoked_at is null
          join instance_bindings b on b.instance_id=e.instance_id and b.account_id=e.account_id and b.revoked_at is null
          where o.id=$1 and o.status='sending' and o.lease_token=$2 and r.revoked_at is null and r.enabled
          and (e.kind in ('completion','attention_resolved') or not exists (
            select 1 from account_push_events fence where fence.instance_id=e.instance_id and
              ((fence.kind='completion' and e.payload->>'runId'<>'' and fence.payload->>'runId'=e.payload->>'runId') or
               (fence.kind='attention_resolved' and e.payload->>'awaitingKey'<>'' and fence.payload->>'sessionId'=e.payload->>'sessionId' and ((fence.payload->>'awaitingKey'=e.payload->>'awaitingKey' and fence.payload->>'generation'=e.payload->>'generation') or (e.payload->>'awaitingKey'='waiting_user' and e.payload->>'runId'<>'' and fence.payload->>'runId'=e.payload->>'runId'))))))`,
                [item.id, lease],
              )
            ).rows[0],
        );
        if (!row) {
          disposition = 'superseded';
          reason = 'authorization_changed';
        } else if (row.payload.expiresAt <= clock()) {
          disposition = 'expired';
          reason = 'expired';
        } else {
          const account = JSON.parse(await readFile(accountFile, 'utf8'));
          if (!account.client_email || !account.private_key || !projectId) throw new Error('configuration_missing');
          const title = 'Ragent';
          const body = row.payload.kind === 'completion' ? 'A task has completed' : 'Your attention is needed';
          const data = Object.fromEntries(
            Object.entries({
              ...row.payload,
              accountId: row.account_id,
              notificationContractVersion: '1',
              tab: 'sessions',
              title,
              body,
            }).map(([k, v]) => [k, String(v)]),
          );
          const payloadBytes = Object.entries(data).reduce(
            (total, [name, value]) => total + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8'),
            0,
          );
          if (payloadBytes > 4096) throw Object.assign(new Error('invalid_payload'), { code: 'invalid_payload' });
          const response = await fetchImpl(
            `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
            {
              method: 'POST',
              headers: { authorization: `Bearer ${await accessToken(account)}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                message: {
                  token: open(row.token_ciphertext),
                  android: {
                    priority: 'HIGH',
                    ttl: `${Math.max(1, Math.floor((row.payload.expiresAt - clock()) / 1000))}s`,
                  },
                  data,
                },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          if (response.ok) {
            disposition = 'sent';
            reason = 'accepted';
          } else {
            const error = await response.json().catch(() => ({}));
            const details = Array.isArray(error?.error?.details) ? error.error.details : [];
            const code = details.find(
              (x) => x?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
            )?.errorCode;
            if (code === 'UNREGISTERED') {
              disposition = 'failed';
              reason = 'unregistered';
              await tx((c) =>
                c.query(
                  'update account_push_registrations set revoked_at=coalesce(revoked_at,now()) where registration_id=$1 and token_hash=$2',
                  [row.registration_id, row.token_hash],
                ),
              );
            } else if (response.status === 401) {
              bearer = null;
              reason = 'http_401';
            } else if (response.status === 429 || response.status >= 500) {
              reason = `http_${response.status}`;
              const raw = response.headers.get('retry-after');
              const seconds = Number(raw);
              const date = Date.parse(raw || '');
              const wait =
                Number.isFinite(seconds) && seconds > 0
                  ? seconds
                  : Number.isFinite(date)
                    ? Math.ceil((date - clock()) / 1000)
                    : 0;
              if (wait > 0) retrySeconds = Math.min(3600, wait);
            } else {
              disposition = 'failed';
              reason = `http_${response.status}`;
            }
          }
        }
      } catch (error) {
        if (error?.code === 'invalid_payload') {
          disposition = 'failed';
          reason = 'invalid_payload';
        } else reason = 'transport_or_configuration';
      }
      if (disposition === 'retry' || disposition === 'failed') workerLastError = reason;
      const jitter = randomBytes(1)[0] / 255;
      await tx((c) =>
        c.query(
          `update account_push_delivery_outbox set status=case when $3='retry' and attempts>=12 then 'failed' else $3 end,last_error=$4, next_attempt_at=now()+make_interval(secs=>least(3600,$5+floor($5*power(2,least(attempts,7))*$6)::int)),lease_token=null,lease_until=null,updated_at=now() where id=$1 and lease_token=$2`,
          [item.id, lease, disposition, reason, retrySeconds, jitter],
        ),
      );
    };
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          await deliver(item);
        }
      }),
    );
  }
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (!running)
        running = dispatch()
          .then(() => {
            dispatcherFailed = false;
          })
          .catch(() => {
            if (!dispatcherFailed) console.warn('[account-push] dispatcher unavailable');
            dispatcherFailed = true;
            workerLastError = 'storage_unavailable';
          })
          .finally(() => {
            running = null;
          });
    }, 1000);
    timer.unref?.();
  }
  async function close() {
    clearInterval(timer);
    timer = null;
    await running;
  }
  return { register, revoke, event, receipt, status, instances, start, close, checkReady };
}
