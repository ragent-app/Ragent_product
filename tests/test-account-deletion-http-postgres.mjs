import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import http from 'node:http';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { startAccountsServer, createAccountsServer } from '../accounts/server.mjs';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { createAccountDeletionService } from '../accounts/account-deletion-service.mjs';
import { createAccountsLogger, createAccountsLoggerOptions } from '../accounts/log.mjs';
import { GOOGLE_JWKS_URL } from '../lib/google-id-token.mjs';

const databaseUrl = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
test('actual HTTP and isolated PostgreSQL purpose-bound Google deletion assembly', { skip: !databaseUrl }, async t => {
  const url = new URL(databaseUrl), nonce = process.env.RAGENT_TEST_RUN_NONCE;
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'qa_deletion'); assert.equal(url.pathname, '/postgres');
  assert(/^[a-f0-9]{32}$/.test(nonce || ''));
  const schema = 'qa_deletion_http_' + randomBytes(10).toString('hex');
  const bootstrap = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  const pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c application_name=ragent-deletion-http-qa` });
  const cluster = (await bootstrap.query("select current_setting('cluster_name') as name")).rows[0].name;
  assert.equal(cluster, 'ragent-deletion-' + nonce);
  let owned = false, app;
  const dir = await mkdtemp(join(tmpdir(), 'ragent-deletion-http-'));
  t.after(async () => {
    try { await app?.close(); } finally {
      await pool.end();
      try { if (owned) await bootstrap.query(`drop schema "${schema}" cascade`); }
      finally { await bootstrap.end();
        const target = await realpath(dir);
        assert.equal(dirname(target), await realpath(tmpdir())); assert(basename(target).startsWith('ragent-deletion-http-'));
        await rm(target, { recursive: true, force: true }); }
    }
  });
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
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  let at = 1_800_000_000_000, jwksCalls = 0;
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'owned-fixture', alg: 'RS256', use: 'sig' };
  const fetchJwks = async (destination, options) => {
    assert.equal(destination, GOOGLE_JWKS_URL); assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal); assert(!JSON.stringify(options).includes('idToken'));
    jwksCalls++;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
  };
  const issue = (challenge, subject, overrides = {}) => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'owned-fixture' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: challenge.googleClientId,
      sub: subject, iat: Math.floor(at / 1000), exp: Math.floor(at / 1000) + 3600, nonce: challenge.nonce,
      email: 'synthetic-review@example.invalid', name: 'Synthetic fixture', ...overrides })).toString('base64url');
    return head + '.' + body + '.' + sign('RSA-SHA256', Buffer.from(head + '.' + body), rsa.privateKey).toString('base64url');
  };
  const seed = async (label, provider = 'google') => {
    const id = 'acct_http_' + label, sub = 'synthetic_http_' + label;
    await pool.query('insert into accounts(account_id,provider,provider_subject,created_at) values($1,$2,$3,$4)',
      [id, provider, sub, new Date(at).toISOString()]);
    return { id, sub };
  };
  const store = createPostgresStore({ pool, schema });
  assert.equal(store.accountDeletionContext().schema, schema);
  assert.equal(store.accountDeletionContext().pool, pool);
  let logs = '';
  const stream = new Writable({ write(chunk, encoding, callback) { logs += chunk.toString(); callback(); } });
  const options = { store, publicBaseUrl: 'http://127.0.0.1:0/accounts', allowInsecurePublicBaseUrl: true,
    signingKeyFile: join(dir, 'signing.json'), turnBrokerSigningKeyFile: join(dir, 'turn.json'),
    googleWebClientId: 'web.fixture', googleNativeClientIds: ['native.fixture'], fetchImpl: fetchJwks,
    clock: () => at, accountDeletionEnabled: true, accountDeletionWorkerIntervalMs: 60_000,
    // A deliberately permissive ordinary verifier must never authorize deletion.
    verifyGoogleCredential: async () => ({ providerSubject: 'forged-ordinary-login' }),
    verifyNativeGoogleCredential: async () => ({ sub: 'forged-ordinary-native-login' }),
    logger: { ...createAccountsLoggerOptions(), stream }, port: 0, host: '127.0.0.1' };
  app = await startAccountsServer(options);
  const call = (path, body, { method = 'POST', headers = {}, raw, chunked = false } = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? '' : JSON.stringify(body));
    const request = http.request({ hostname: '127.0.0.1', port: app.server.address().port, method,
      path: '/accounts/v1/account-deletion/' + path,
      headers: { 'content-type': 'application/json', ...(chunked ? { 'transfer-encoding': 'chunked' }
        : { 'content-length': Buffer.byteLength(payload) }), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); let json;
        try { json = JSON.parse(text); } catch {} resolve({ status: response.statusCode, headers: response.headers, text, json }); });
    });
    request.setTimeout(10_000, () => request.destroy(Error('Owned HTTP fixture timed out')));
    request.on('error', reject); request.end(payload);
  });
  const newInput = (account, channel = 'web') => ({ requestId: randomUUID(), receiptSecret: randomBytes(32).toString('base64url'),
    confirmationSecret: randomBytes(32).toString('base64url'), channel, ...(account ? { expectedAccountId: account.id } : {}) });
  const challenge = async input => { const result = await call('challenges', input); assert.equal(result.status, 200, result.text); return result.json; };
  const confirm = (input, ch, token) => call('confirmations', { requestId: input.requestId,
    confirmationId: ch.confirmationId, confirmationSecret: input.confirmationSecret, idToken: token });
  const submitBody = (input, ch) => ({ requestId: input.requestId, receiptSecret: input.receiptSecret,
    confirmationId: ch.confirmationId, confirmationSecret: input.confirmationSecret, confirmation: 'delete-account-and-associated-data' });
  const countJobs = async () => Number((await pool.query('select count(*) as n from account_deletion_jobs')).rows[0].n);

  await t.test('feature defaults off and missing schema/context is unavailable without breaking ordinary routes', async () => {
    const off = await createAccountsServer({ ...options, accountDeletionEnabled: false });
    assert.equal(off.accountDeletionStatus, 'disabled'); assert.equal(off.accountDeletion, null);
    const missing = await createAccountsServer({ ...options, store: { mutate: fn => fn({}) } });
    assert.equal(missing.accountDeletionStatus, 'unavailable');
    const unmigrated = await createAccountsServer({ ...options, store: { ...store,
      accountDeletionContext: () => ({ pool, schema: 'qa_deletion_absent_' + randomBytes(6).toString('hex') }) } });
    assert.equal(unmigrated.accountDeletionStatus, 'unavailable'); assert.equal(unmigrated.accountDeletion, null);
    await assert.rejects(createAccountsServer({ ...options, publicBaseUrl: 'http://external.invalid/accounts' }), /fixed HTTPS/);
    assert.equal(app.accountDeletionStatus, 'ready'); assert.equal(app.accountDeletion.workerStatus().running, true);
  });
  await t.test('query, method, cross-origin, generic bearer and malformed/oversized bodies cannot mutate', async () => {
    const canary = 'owned-query-secret-' + randomBytes(8).toString('hex');
    assert.equal((await call('challenges?receiptSecret=' + canary, {})).status, 400);
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const result = await call('challenges', method === 'GET' ? undefined : {}, { method }); assert.equal(result.status, 405); assert.equal(result.headers.allow, 'POST');
    }
    assert.equal((await call('challenges', {}, { headers: { origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await call('challenges', {}, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call('challenges', {}, { headers: { authorization: 'Bearer ' + canary } })).status, 400);
    assert.equal((await call('challenges', {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
    const malformed = await call('challenges', undefined, { raw: '{"idToken":"' + canary + '"' });
    assert.equal(malformed.status, 400); assert(!malformed.text.includes(canary));
    assert.equal((await call('challenges', undefined, { raw: JSON.stringify({ idToken: 'x'.repeat(25 * 1024) }) })).status, 413);
    assert.equal((await call('challenges', undefined, { raw: JSON.stringify({ idToken: 'x'.repeat(70 * 1024) }) })).status, 413);
    // Whitespace disappears when Fastify reserializes JSON: enforce raw bytes
    // before parsing, even without Content-Length, rather than only counting {}.
    assert.equal((await call('challenges', undefined, { raw: ' '.repeat(25 * 1024) + '{}', chunked: true })).status, 413);
    assert.equal(await countJobs(), 0); assert(!logs.includes(canary));
  });
  const first = await seed('first'), foreign = await seed('foreign');
  const firstInput = newInput(first), firstChallenge = await challenge(firstInput);
  await t.test('durable challenge survives cold service and keeps only capability hashes', async () => {
    const cold = createAccountDeletionService({ ...store.accountDeletionContext(), googleWebClientId: 'web.fixture', clock: () => at, fetchImpl: fetchJwks });
    assert.deepEqual(await cold.createChallenge(firstInput), firstChallenge);
    const row = (await pool.query('select * from account_deletion_confirmations where request_id=$1', [firstInput.requestId])).rows[0];
    const raw = JSON.stringify(row); assert(!raw.includes(firstInput.receiptSecret)); assert(!raw.includes(firstInput.confirmationSecret));
    assert.equal(row.account_id, null); assert.equal(row.verified_at, null);
    assert.equal((await call('challenges', { ...firstInput, expectedAccountId: foreign.id })).status, 409);
    assert.equal((await call('challenges', { ...firstInput, confirmationSecret: randomBytes(32).toString('base64url') })).status, 409);
    await cold.close();
  });
  await t.test('real RS256 verifier rejects fake ordinary login, wrong nonce/audience/issuer, stale and forged tokens', async () => {
    const good = issue(firstChallenge, first.sub);
    const cases = ['forged-ordinary-login', issue(firstChallenge, first.sub, { nonce: 'wrong' }),
      issue(firstChallenge, first.sub, { aud: 'native.fixture' }), issue(firstChallenge, first.sub, { iss: 'https://evil.invalid' }),
      issue(firstChallenge, first.sub, { iat: Math.floor(at / 1000) - 100 }),
      issue(firstChallenge, first.sub, { exp: Math.floor(at / 1000) - 1 }),
      good.slice(0, -4) + 'AAAA', issue(firstChallenge, ' ' + first.sub)];
    for (const token of cases) assert.equal((await confirm(firstInput, firstChallenge, token)).status, 401);
    assert.equal(await countJobs(), 0);
    assert.equal((await confirm(firstInput, firstChallenge, issue(firstChallenge, foreign.sub))).status, 409);
  });
  await t.test('verified identity is shown before explicit deletion and cannot be rebound', async () => {
    const response = await confirm(firstInput, firstChallenge, issue(firstChallenge, first.sub, { azp: 'android-hybrid.fixture' }));
    assert.equal(response.status, 200, response.text); assert.equal(response.json.phase, 'confirmed');
    assert.equal(response.json.account.accountId, first.id); assert.equal(await countJobs(), 0);
    assert.equal((await call('requests', { ...submitBody(firstInput, firstChallenge), confirmation: 'sign-out' })).status, 400);
    assert.equal((await call('requests', { ...submitBody(firstInput, firstChallenge), accountId: foreign.id })).status, 400);
    const row = (await pool.query('select * from account_deletion_confirmations where request_id=$1', [firstInput.requestId])).rows[0];
    assert(!JSON.stringify(row).includes('synthetic-review@example.invalid'));
    assert.equal((await confirm(firstInput, firstChallenge, issue(firstChallenge, foreign.sub))).status, 409);
  });
  let accepted;
  await t.test('concurrent HTTP submits commit one fence/job and recover one private receipt', async () => {
    const responses = await Promise.all([call('requests', submitBody(firstInput, firstChallenge)), call('requests', submitBody(firstInput, firstChallenge))]);
    for (const response of responses) assert([200, 201].includes(response.status), response.text);
    accepted = responses[0].json.receipt;
    assert.equal(responses[1].json.receipt.jobId, accepted.jobId); assert.equal(await countJobs(), 1);
    assert.equal((await pool.query('select count(*) as n from account_deletion_fences where account_id=$1', [first.id])).rows[0].n, '1');
    const bad = await call('receipts/lookup', { requestId: firstInput.requestId, receiptSecret: randomBytes(32).toString('base64url') });
    assert.equal(bad.status, 404);
    const recovered = await call('requests', submitBody(firstInput, firstChallenge));
    assert.equal(recovered.status, 200); assert.equal(recovered.json.recovered, true);
    assert.equal(recovered.json.receipt.jobId, accepted.jobId);
  });
  await t.test('worker actually drains bounded cleanup, deletes only the selected account and leaves cold receipt usable', async () => {
    for (let n = 0; n < 30; n++) await app.accountDeletion.runWorkerBatch();
    assert.equal((await pool.query('select count(*) as n from accounts where account_id=$1', [first.id])).rows[0].n, '0');
    assert.equal((await pool.query('select count(*) as n from accounts where account_id=$1', [foreign.id])).rows[0].n, '1');
    const result = await call('receipts/lookup', { requestId: firstInput.requestId, receiptSecret: firstInput.receiptSecret });
    assert.equal(result.status, 200); assert.equal(result.json.status, 'completed'); assert(result.json.cloudErasedAt);
    assert.equal(result.json.localFilesAutomaticallyErased, false);
    at += 360_000;
    assert.equal((await call('requests', submitBody(firstInput, firstChallenge))).json.receipt.jobId, accepted.jobId);
    assert.equal((await call('challenges', firstInput)).json.phase, 'receipt');
  });
  await t.test('native channel requires its own configured audience and challenge nonce', async () => {
    const input = newInput(foreign, 'native'), ch = await challenge(input);
    assert.equal(ch.googleClientId, 'native.fixture');
    assert.equal((await confirm(input, ch, issue(ch, foreign.sub, { aud: 'web.fixture' }))).status, 401);
    assert.equal((await confirm(input, ch, issue(ch, foreign.sub, { nonce: '' }))).status, 401);
    assert.equal((await confirm(input, ch, issue(ch, foreign.sub))).status, 200);
    const demo = await seed('managed', 'demo'), demoInput = newInput(demo), demoCh = await challenge(demoInput);
    assert.equal((await confirm(demoInput, demoCh, issue(demoCh, demo.sub))).status, 404);
    assert.equal(await countJobs(), 1);
  });
  await t.test('unavailable or oversized JWKS fails closed without passing token or secret upstream', async () => {
    for (const oversized of [false, true]) {
      const isolated = createAccountDeletionService({ ...store.accountDeletionContext(), googleWebClientId: 'web.fixture', clock: () => at,
        fetchImpl: async (destination, options) => {
          assert.equal(destination, GOOGLE_JWKS_URL); assert.equal(options.redirect, 'error');
          assert.equal(options.body, undefined); assert(!options.headers.authorization);
          if (!oversized) throw Error('owned network failure');
          return new Response('x'.repeat(128 * 1024 + 1));
        } });
      const input = newInput(foreign), ch = await isolated.createChallenge(input);
      await assert.rejects(isolated.verifyGoogle({ requestId: input.requestId, confirmationId: ch.confirmationId,
        confirmationSecret: input.confirmationSecret, idToken: issue(ch, foreign.sub) }),
      error => error.code === 'account_deletion_google_unavailable' && error.statusCode === 503);
      await isolated.close();
    }
    assert.equal(await countJobs(), 1);
  });
  await t.test('expired challenge renews once without old-token or secret reuse, and rollback clock fails closed cold', async () => {
    const input = newInput(foreign), ch = await challenge(input), oldToken = issue(ch, foreign.sub);
    at += 300_001;
    assert.equal((await confirm(input, ch, oldToken)).status, 410);
    const changed = { ...input, confirmationSecret: randomBytes(32).toString('base64url') };
    const next = await challenge(changed); assert.notEqual(next.confirmationId, ch.confirmationId); assert.notEqual(next.nonce, ch.nonce);
    assert.equal((await confirm(changed, next, oldToken)).status, 401);
    assert.equal((await confirm(changed, next, issue(next, foreign.sub))).status, 200);
    at--;
    const cold = createAccountDeletionService({ ...store.accountDeletionContext(), googleWebClientId: 'web.fixture', clock: () => at, fetchImpl: fetchJwks });
    await assert.rejects(cold.createChallenge(newInput(foreign)), error => error.code === 'account_deletion_clock_invalid');
    assert.equal((await cold.getReceipt({ requestId: firstInput.requestId, receiptSecret: firstInput.receiptSecret })).jobId, accepted.jobId);
    await cold.close(); at++;
  });
  await t.test('capacity and down-migration guards protect pending intents without allowing expired rows to accumulate', async () => {
    const current = Number((await pool.query('select count(*) as n from account_deletion_confirmations')).rows[0].n);
    const bounded = createAccountDeletionService({ ...store.accountDeletionContext(), googleWebClientId: 'web.fixture', clock: () => at,
      fetchImpl: fetchJwks, maxConfirmations: current + 1 });
    await bounded.createChallenge(newInput(foreign));
    await assert.rejects(bounded.createChallenge(newInput(foreign)), error => error.code === 'account_deletion_confirmation_capacity');
    await assert.rejects(pool.query(await readFile(new URL('034_account_deletion_confirmations.down.sql', migrations), 'utf8')), /rollback_unsafe/);
    at += 300_001; await bounded.runWorkerBatch();
    assert.equal((await pool.query('select count(*) as n from account_deletion_confirmations')).rows[0].n, '0');
    await bounded.close();
  });
  await t.test('a failed cleanup job cannot stop another job; bounded worker reports failure and cold retry resumes', async () => {
    const jobs = [];
    for (const label of ['worker_fault', 'worker_healthy']) {
      const account = await seed(label), input = newInput(account), ch = await challenge(input);
      assert.equal((await confirm(input, ch, issue(ch, account.sub))).status, 200);
      const result = await call('requests', submitBody(input, ch)); assert.equal(result.status, 201, result.text);
      jobs.push(result.json.receipt.jobId);
    }
    const brokenPool = { connect: async () => {
      const client = await pool.connect(); return { release: () => client.release(), query: (sql, args) => {
        if (sql.startsWith('select * from account_deletion_jobs where job_id=') && args[0] === jobs[0]) {
          throw Error('owned synthetic cleanup fault');
        }
        return client.query(sql, args);
      } };
    } };
    let notify;
    const failed = new Promise(resolve => { notify = resolve; });
    const worker = createAccountDeletionService({ pool: brokenPool, schema, googleWebClientId: 'web.fixture',
      clock: () => at, fetchImpl: fetchJwks, workerIntervalMs: 60_000,
      audit: fields => { notify(fields); throw Error('owned broken audit sink'); } });
    await assert.rejects(worker.runWorkerBatch(), /owned synthetic cleanup fault/);
    const phase = async jobId => (await pool.query('select phase_index from account_deletion_jobs where job_id=$1', [jobId])).rows[0].phase_index;
    assert.equal(await phase(jobs[0]), 0); assert.equal(await phase(jobs[1]), 1);
    worker.startWorker();
    let timeout;
    try {
      const event = await Promise.race([failed, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(Error('Owned worker did not report failure')), 3000); })]);
      assert.equal(event.code, 'account_deletion_unavailable');
      assert.equal(worker.workerStatus().lastFailure, 'account_deletion_unavailable');
    } finally { clearTimeout(timeout); await worker.close(); }
    assert.equal(worker.workerStatus().running, false);
    const previous = await phase(jobs[1]); await app.accountDeletion.runWorkerBatch();
    assert.equal(await phase(jobs[0]), 1); assert.equal(await phase(jobs[1]), previous + 1);
  });
  await t.test('default structured logs redact body capabilities and rejected query data; shutdown joins worker', async () => {
    const sentinel = 'owned-log-secret-' + randomBytes(12).toString('hex');
    const logger = createAccountsLogger({ stream });
    logger.info({ receiptSecret: sentinel, confirmationSecret: sentinel, proof: sentinel, body: { idToken: sentinel },
      request: { body: { receiptSecret: sentinel } }, req: { method: 'POST', url: '/accounts/v1/account-deletion/requests?secret=' + sentinel } });
    assert(!logs.includes(sentinel)); assert(!logs.includes(firstInput.receiptSecret)); assert(!logs.includes(firstInput.confirmationSecret));
    assert(logs.includes('[redacted]')); assert(jwksCalls > 0);
    await app.close(); assert.equal(app.accountDeletion.workerStatus().running, false); app = null;
  });
});
