function asrError(code, statusCode, message = code) {
  return Object.assign(new Error(message), { code, statusCode });
}

function safeSchema(schema) {
  const value = String(schema || 'public');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new TypeError('Invalid Accounts schema name');
  return value;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function rowToRequest(row) {
  return {
    state: String(row.state),
    audioSha256: String(row.audio_sha256),
    audioDurationMs: number(row.audio_duration_ms),
    reservedDurationMs: number(row.reserved_duration_ms),
    errorCode: row.error_code ? String(row.error_code) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  };
}

/** Narrow SQL repository: ASR events never enter the whole-account snapshot writer. */
export function createAccountAsrPostgresStore({ pool, schema = 'public', clock = Date.now } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('An Accounts PostgreSQL pool is required');
  const tenantSchema = safeSchema(schema);

  async function withClient(run) {
    const client = await pool.connect();
    try {
      // A transaction-local search_path is valid only after BEGIN. Keep every
      // query in the same transaction so tenant schemas work as intended.
      await client.query('begin');
      try {
        if (tenantSchema !== 'public') {
          await client.query('select set_config($1, $2, true)', ['search_path', tenantSchema]);
        }
        const result = await run(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    } finally { client.release(); }
  }

  async function transaction(run) {
    return withClient(async (client) => {
      await client.query("select set_config($1, $2, true)", ['lock_timeout', '3000ms']);
      await client.query("select set_config($1, $2, true)", ['statement_timeout', '10000ms']);
      return run(client);
    });
  }

  async function reserve({ accountId, deviceId, requestId, periodStart, audioSha256,
    audioBytes, audioDurationMs, monthlyLimitMs, providerName = 'elevenlabs', modelId = 'scribe_v2',
    priceVersion, policyVersion, maxConcurrent = 2 }) {
    return transaction(async (client) => {
      await client.query(`insert into account_asr_usage (account_id, period_start)
        values ($1, $2::date) on conflict (account_id, period_start) do nothing`, [accountId, periodStart]);
      const usageResult = await client.query(`select used_audio_ms, reserved_audio_ms
        from account_asr_usage where account_id=$1 and period_start=$2::date for update`, [accountId, periodStart]);
      if (!usageResult.rows.length) throw asrError('asr_usage_unavailable', 503);

      // A process may have died after marking a provider call in progress. Never
      // retry it: retain the reservation and mark the outcome uncertain.
      await client.query(`update account_asr_requests set state='unknown', error_code='asr_provider_outcome_unknown', updated_at=now()
        where account_id=$1 and state='processing' and updated_at < now() - interval '2 minutes'`, [accountId]);

      const existingResult = await client.query(`select state, audio_sha256, audio_duration_ms,
        reserved_duration_ms, error_code, updated_at from account_asr_requests
        where account_id=$1 and request_id=$2 for update`, [accountId, requestId]);
      const existing = existingResult.rows[0];
      if (existing) {
        const prior = rowToRequest(existing);
        if (prior.audioSha256 !== audioSha256 || prior.audioDurationMs !== audioDurationMs) {
          throw asrError('asr_idempotency_conflict', 409, 'The idempotency key was already used for different audio.');
        }
        if (prior.state === 'reserved' && clock() - prior.updatedAt >= 120_000) {
          await client.query(`update account_asr_requests set updated_at=now()
            where account_id=$1 and request_id=$2 and state='reserved'`, [accountId, requestId]);
          return { kind: 'reserved', reclaimed: true, reservedDurationMs: prior.reservedDurationMs };
        }
        if (prior.state === 'reserved' || prior.state === 'processing') return { kind: 'pending' };
        if (prior.state === 'succeeded') return { kind: 'result_expired' };
        if (prior.state === 'failed') return { kind: 'failed', errorCode: prior.errorCode || 'asr_request_failed' };
        return { kind: 'unknown' };
      }

      const activeResult = await client.query(`select count(*)::int as count from account_asr_requests
        where account_id=$1 and state in ('reserved','processing')`, [accountId]);
      if (number(activeResult.rows[0]?.count) >= maxConcurrent) {
        throw asrError('asr_concurrency_limit', 429, 'Too many concurrent transcriptions are active for this account.');
      }
      const usage = usageResult.rows[0];
      const usedMs = number(usage.used_audio_ms);
      const reservedMs = number(usage.reserved_audio_ms);
      if (usedMs + reservedMs + audioDurationMs > monthlyLimitMs) {
        throw asrError('asr_monthly_quota_exceeded', 429, 'The account has reached its monthly speech recognition limit.');
      }
      await client.query(`insert into account_asr_requests
        (account_id, request_id, device_id, period_start, state, audio_sha256, audio_bytes,
         audio_duration_ms, reserved_duration_ms, provider_name, model_id, price_version, policy_version,
         created_at, updated_at)
        values ($1,$2,$3,$4::date,'reserved',$5,$6,$7,$7,$8,$9,$10,$11,now(),now())`,
      [accountId, requestId, deviceId, periodStart, audioSha256, audioBytes, audioDurationMs,
        providerName, modelId, priceVersion, policyVersion]);
      await client.query(`update account_asr_usage set reserved_audio_ms=reserved_audio_ms+$3,
        request_count=request_count+1, updated_at=now() where account_id=$1 and period_start=$2::date`,
      [accountId, periodStart, audioDurationMs]);
      return { kind: 'reserved', reclaimed: false, reservedDurationMs: audioDurationMs };
    });
  }

  async function markProcessing({ accountId, requestId }) {
    return transaction(async (client) => {
      const result = await client.query(`update account_asr_requests set state='processing', updated_at=now()
        where account_id=$1 and request_id=$2 and state='reserved'`, [accountId, requestId]);
      return result.rowCount === 1;
    });
  }

  async function settle({ accountId, requestId, periodStart, billableDurationMs, costMicroUsd, latencyMs, languageCode }) {
    return transaction(async (client) => {
      // Use the same aggregate-then-request lock order as reserve().
      const usage = await client.query(`select account_id from account_asr_usage
        where account_id=$1 and period_start=$2::date for update`, [accountId, periodStart]);
      if (!usage.rows.length) throw asrError('asr_request_state_conflict', 409);
      // PostgreSQL DATE is parsed as a JavaScript Date by node-postgres. Read
      // the canonical SQL date text here so the period comparison is stable
      // across driver timezone/parser behavior.
      const request = await client.query(`select reserved_duration_ms, period_start::text as period_start from account_asr_requests
        where account_id=$1 and request_id=$2 and state='processing' for update`, [accountId, requestId]);
      if (!request.rows.length || String(request.rows[0].period_start).slice(0, 10) !== periodStart) {
        throw asrError('asr_request_state_conflict', 409);
      }
      const reservedMs = number(request.rows[0].reserved_duration_ms);
      await client.query(`update account_asr_requests set state='succeeded', reserved_duration_ms=0,
        billable_duration_ms=$3, provider_cost_microusd=$4, provider_latency_ms=$5,
        language_code=$6, error_code=null, updated_at=now()
        where account_id=$1 and request_id=$2`,
      [accountId, requestId, billableDurationMs, costMicroUsd, latencyMs, languageCode]);
      await client.query(`update account_asr_usage set reserved_audio_ms=greatest(0,reserved_audio_ms-$3),
        used_audio_ms=used_audio_ms+$4, provider_cost_microusd=provider_cost_microusd+$5,
        updated_at=now() where account_id=$1 and period_start=$2::date`,
      [accountId, periodStart, reservedMs, billableDurationMs, costMicroUsd]);
    });
  }

  async function fail({ accountId, requestId, periodStart, errorCode }) {
    return transaction(async (client) => {
      const usage = await client.query(`select account_id from account_asr_usage
        where account_id=$1 and period_start=$2::date for update`, [accountId, periodStart]);
      if (!usage.rows.length) return false;
      const request = await client.query(`select reserved_duration_ms, period_start from account_asr_requests
        where account_id=$1 and request_id=$2 and state in ('reserved','processing') for update`, [accountId, requestId]);
      if (!request.rows.length || String(request.rows[0].period_start).slice(0, 10) !== periodStart) return false;
      const reservedMs = number(request.rows[0].reserved_duration_ms);
      await client.query(`update account_asr_requests set state='failed', reserved_duration_ms=0,
        error_code=$3, updated_at=now() where account_id=$1 and request_id=$2`,
      [accountId, requestId, errorCode]);
      await client.query(`update account_asr_usage set reserved_audio_ms=greatest(0,reserved_audio_ms-$3),
        updated_at=now() where account_id=$1 and period_start=$2::date`, [accountId, periodStart, reservedMs]);
      return true;
    });
  }

  async function markUnknown({ accountId, requestId, errorCode }) {
    return transaction(async (client) => {
      const result = await client.query(`update account_asr_requests set state='unknown',
        error_code=$3, updated_at=now() where account_id=$1 and request_id=$2
        and state in ('reserved','processing')`, [accountId, requestId, errorCode]);
      return result.rowCount === 1;
    });
  }

  async function getUsage({ accountId, periodStart }) {
    return withClient(async (client) => {
      const result = await client.query(`select used_audio_ms, reserved_audio_ms,
        request_count from account_asr_usage
        where account_id=$1 and period_start=$2::date limit 1`, [accountId, periodStart]);
      const row = result.rows[0] || {};
      return {
        usedMs: number(row.used_audio_ms),
        reservedMs: number(row.reserved_audio_ms),
        requestCount: number(row.request_count),
      };
    });
  }

  function rowToConsent(row) {
    if (!row) return null;
    return {
      action: String(row.action),
      policyVersion: String(row.policy_version),
      occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
    };
  }

  async function getConsent({ accountId }) {
    return withClient(async (client) => {
      const result = await client.query(`select action, policy_version, occurred_at
        from account_asr_consent_events where account_id=$1
        order by consent_event_id desc limit 1`, [accountId]);
      return rowToConsent(result.rows[0]);
    });
  }

  async function setConsent({ accountId, deviceId, action, policyVersion }) {
    if (!['accepted', 'revoked'].includes(action) || !policyVersion) {
      throw asrError('asr_consent_invalid', 400);
    }
    return transaction(async (client) => {
      // Serialize per-account consent changes so the latest event always wins.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [accountId]);
      const priorResult = await client.query(`select action, policy_version, occurred_at
        from account_asr_consent_events where account_id=$1
        order by consent_event_id desc limit 1`, [accountId]);
      const prior = rowToConsent(priorResult.rows[0]);
      if (prior?.action === action && prior.policyVersion === policyVersion) return prior;
      if (action === 'revoked' && !prior) return null;
      const inserted = await client.query(`insert into account_asr_consent_events
        (account_id, device_id, policy_version, action)
        values ($1,$2,$3,$4)
        returning action, policy_version, occurred_at`,
      [accountId, deviceId, policyVersion, action]);
      return rowToConsent(inserted.rows[0]);
    });
  }

  async function purgeExpiredConsents({ batchSize = 1_000 } = {}) {
    const limit = Number(batchSize);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new TypeError('A valid ASR consent retention batch size is required');
    }
    return transaction(async (client) => {
      const result = await client.query(`with expired as (
          select consent_event_id from account_asr_consent_events
          where retain_until <= now()
          order by retain_until limit $1 for update skip locked
        ) delete from account_asr_consent_events event using expired
          where event.consent_event_id=expired.consent_event_id`, [limit]);
      return result.rowCount || 0;
    });
  }

  async function expireStaleReservations({ olderThanMs = 120_000, batchSize = 500 } = {}) {
    const age = Number(olderThanMs);
    const limit = Number(batchSize);
    if (!Number.isSafeInteger(age) || age < 1_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new TypeError('Valid ASR reservation maintenance bounds are required');
    }
    return transaction(async (client) => {
      const candidates = await client.query(`select account_id, period_start, request_id from account_asr_requests
        where state='reserved' and updated_at < now() - ($1::double precision * interval '1 millisecond')
        order by updated_at limit $2`, [age, limit]);
      const groups = new Map();
      for (const row of candidates.rows) {
        const periodStart = String(row.period_start).slice(0, 10);
        const key = `${row.account_id}\0${periodStart}`;
        const group = groups.get(key) || { accountId: String(row.account_id), periodStart, requestIds: [] };
        group.requestIds.push(String(row.request_id));
        groups.set(key, group);
      }

      let expiredCount = 0;
      for (const group of [...groups.values()].sort((a, b) =>
        a.accountId.localeCompare(b.accountId) || a.periodStart.localeCompare(b.periodStart))) {
        await client.query(`select 1 from account_asr_usage where account_id=$1 and period_start=$2::date for update`,
          [group.accountId, group.periodStart]);
        const expired = await client.query(`update account_asr_requests set state='failed', reserved_duration_ms=0,
          error_code='asr_reservation_expired', updated_at=now()
          where account_id=$1 and period_start=$2::date and request_id=any($3::text[])
            and state='reserved' and updated_at < now() - ($4::double precision * interval '1 millisecond')
          returning reserved_duration_ms`, [group.accountId, group.periodStart, group.requestIds, age]);
        const releasedMs = expired.rows.reduce((total, row) => total + number(row.reserved_duration_ms), 0);
        if (releasedMs > 0) {
          await client.query(`update account_asr_usage set reserved_audio_ms=greatest(0,reserved_audio_ms-$3),
            updated_at=now() where account_id=$1 and period_start=$2::date`,
          [group.accountId, group.periodStart, releasedMs]);
        }
        expiredCount += expired.rowCount || 0;
      }
      return expiredCount;
    });
  }

  async function markStaleProcessingUnknown({ olderThanMs = 120_000, batchSize = 500 } = {}) {
    const age = Number(olderThanMs);
    const limit = Number(batchSize);
    if (!Number.isSafeInteger(age) || age < 1_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new TypeError('Valid ASR processing maintenance bounds are required');
    }
    return transaction(async (client) => {
      const result = await client.query(`with stale as (
          select ctid from account_asr_requests
          where state='processing' and updated_at < now() - ($1::double precision * interval '1 millisecond')
          order by updated_at for update skip locked limit $2
        ) update account_asr_requests request set state='unknown',
          error_code='asr_provider_outcome_unknown', updated_at=now()
          from stale where request.ctid=stale.ctid`, [age, limit]);
      return result.rowCount || 0;
    });
  }

  async function purgeTerminalRequests({ olderThanMs = 90 * 24 * 60 * 60_000, batchSize = 1_000 } = {}) {
    const age = Number(olderThanMs);
    const limit = Number(batchSize);
    if (!Number.isSafeInteger(age) || age < 24 * 60 * 60_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new TypeError('Valid ASR request retention bounds are required');
    }
    return transaction(async (client) => {
      const result = await client.query(`with expired as (
          select ctid from account_asr_requests
          where state in ('succeeded','failed')
            and updated_at < now() - ($1::double precision * interval '1 millisecond')
          order by updated_at for update skip locked limit $2
        ) delete from account_asr_requests request using expired
          where request.ctid=expired.ctid`, [age, limit]);
      return result.rowCount || 0;
    });
  }

  async function checkReady() {
    return withClient(async (client) => {
      const result = await client.query(`select to_regclass('account_asr_usage') as usage_table,
        to_regclass('account_asr_requests') as requests_table,
        to_regclass('account_asr_consent_events') as consent_events_table`);
      if (!result.rows[0]?.usage_table || !result.rows[0]?.requests_table || !result.rows[0]?.consent_events_table) {
        throw asrError('asr_schema_unavailable', 503, 'The ASR usage schema has not been installed.');
      }
      return true;
    });
  }

  return Object.freeze({ reserve, markProcessing, settle, fail, markUnknown, getUsage,
    getConsent, setConsent, purgeExpiredConsents,
    expireStaleReservations, markStaleProcessingUnknown, purgeTerminalRequests, checkReady });
}
