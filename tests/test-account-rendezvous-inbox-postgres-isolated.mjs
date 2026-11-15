import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { startAccountsServer } from '../accounts/server.mjs';
import { loadOrCreateSigningKeyRing } from '../accounts/keys.mjs';
import { inboxWaitFixture } from './fixtures/rendezvous-inbox-wait.mjs';

const database = process.env.RAGENT_QA_OWNED_DATABASE, socket = process.env.RAGENT_QA_SOCKET;
assert(/^qa_rendezvous_read_[a-f0-9]{16}$/.test(database || ''));
assert(/^\/tmp\/ragent-scoped-result-pg-[a-f0-9]{16}\/socket$/.test(socket || ''));
const worker = process.argv.includes('--accounts-worker');
const pool = new Pool({ database, host: socket, user: 'postgres', max: worker ? 1 : 2,
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000,
  options: '-c application_name=ragent-inbox-wait-qa -c statement_timeout=10000 -c lock_timeout=1500' });
assert.equal((await pool.query('select current_database() as name')).rows[0].name, database);
const store = createPostgresStore({ pool }), sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const keyPaths = ['qa-inbox-signing.json', 'qa-inbox-turn-signing.json'].map(name => resolve(sourceRoot, name));

if (worker) {
  let completedReads = 0, inFlightWaits = 0;
  const originalRead = store.readAccountRendezvousInboxSnapshot;
  store.readAccountRendezvousInboxSnapshot = async input => {
    const result = await originalRead(input); completedReads++; return result;
  };
  const app = await startAccountsServer({ port: 0, host: '127.0.0.1', store,
    publicBaseUrl: 'https://accounts.example.test', dataFile: resolve(sourceRoot, 'unused-inbox-data.json'),
    signingKeyFile: keyPaths[0], turnBrokerSigningKeyFile: keyPaths[1],
    harnessPolicyFile: resolve(sourceRoot, 'unused-inbox-policy.json'), logger: { level: 'silent' },
    verifyGoogleCredential: async () => { throw new Error('No Google in private inbox QA'); },
    verifyNativeGoogleCredential: async () => { throw new Error('No native Google in private inbox QA'); },
  });
  const original = app.broker.pollAccountRendezvousInbox;
  app.broker.pollAccountRendezvousInbox = async (input, options) => {
    const waiting = input.waitMs > 0; if (waiting) inFlightWaits++;
    try { return await original(input, options); } finally { if (waiting) inFlightWaits--; }
  };
  process.on('message', async input => {
    if (input?.stop) { await app.close(); await pool.end(); process.disconnect(); return; }
    if (input?.probe) process.send({ id: input.id, stats: { completedReads, inFlightWaits,
      poolIdle: pool.idleCount, poolTotal: pool.totalCount } });
  });
  process.send({ ready: true, port: app.server.address().port });
} else {
  const report = { scope: 'two isolated Fastify Accounts processes and private Postgres; no phone speed claim',
    success: false, checks: [] }, children = [], calls = [];
  let fixture, sequence = 0;
  function query(child) {
    const id = ++sequence;
    return new Promise((complete, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Owned worker probe timeout')); }, 5000);
      const message = value => { if (value.id === id) { cleanup(); complete(value.stats); } };
      const fail = () => { cleanup(); reject(new Error('Owned worker exited')); };
      function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', fail); }
      child.on('message', message); child.once('exit', fail); child.send({ probe: true, id });
    });
  }
  async function stats(child, predicate) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const result = await query(child); if (predicate(result)) return result;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Owned inbox state deadline exceeded');
  }
  function start() {
    const child = fork(fileURLToPath(import.meta.url), ['--accounts-worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push(child);
    child.ready = new Promise((complete, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Owned startup timeout')); }, 15000);
      const message = value => { if (value.ready) { cleanup(); child.port = value.port; complete(); } };
      const fail = () => { cleanup(); reject(new Error('Owned startup failed')); };
      function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', fail); }
      child.on('message', message); child.once('exit', fail);
    });
    return child;
  }
  function http(child, path, body, token) {
    let req;
    const done = new Promise((complete, reject) => {
      req = request({ host: '127.0.0.1', port: child.port, method: 'POST', path,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', part => { data += part; });
        res.on('end', () => complete({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    done.catch(() => {}); const call = { req, done }; calls.push(call); return call;
  }
  async function waiting(child) {
    const before = await query(child);
    const call = http(child, '/v1/owner-auth/rendezvous/inbox', fixture.proof(5000));
    await stats(child, s => s.inFlightWaits === 1 && s.completedReads >= before.completedReads + 2
      && s.poolTotal === 1 && s.poolIdle === 1);
    return call;
  }
  const expireOffers = () => pool.query('update account_join_intents set expires_at=now()-interval \'1 second\' where instance_id=$1', [fixture.instance.instanceId]);
  function authorize(child, offer) {
    return http(child, `/v1/owner-auth/account-intents/${offer.intent.intentId}/authorize`,
      offer.authorization, fixture.credential.credential).done;
  }
  try {
    const migrationRoot = new URL('../accounts/migrations/', import.meta.url);
    const migrations = (await readdir(migrationRoot)).filter(name => name.endsWith('.up.sql')).sort();
    for (const name of migrations) {
      const sql = await readFile(new URL(name, migrationRoot), 'utf8');
      assert(!/\b(?:alter\s+system|create\s+database|drop\s+database)\b/i.test(sql)); await pool.query(sql);
    }
    fixture = await inboxWaitFixture({ store });
    for (const path of keyPaths) await loadOrCreateSigningKeyRing(path);
    const [a, b] = [start(), start()]; await Promise.all([a.ready, b.ready]);
    const crossOffer = await fixture.prepareOffer(), cross = await waiting(a);
    const transactions = await pool.query(`select count(*)::int as count from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend' and xact_start is not null`);
    assert.equal(transactions.rows[0].count, 0); report.waitingOpenTransactions = 0;
    report.checks.push('bounded HTTP wait releases its database connection and holds no transaction');
    const crossStart = performance.now(); assert.equal((await authorize(b, crossOffer)).status, 200);
    const response = await cross.done; assert.equal(response.status, 200);
    assert.equal(response.body.intent.intentId, crossOffer.intent.intentId); assert.equal(response.body.inboxWaitVersion, 1);
    assert.match(response.headers['cache-control'], /no-store/);
    report.crossProcessDeliveryMs = performance.now() - crossStart; assert(report.crossProcessDeliveryMs < 3000);
    report.checks.push('second process signed authorization reaches a fresh scoped checkpoint');
    await expireOffers(); const revoked = await waiting(a);
    await pool.query('update instance_bindings set revoked_at=now() where instance_id=$1', [fixture.instance.instanceId]);
    assert.equal((await revoked.done).status, 403);
    report.checks.push('revocation while waiting refuses the original signed proof');
    // Restore disposable fixture authority only. This suite cannot accept a production database.
    await pool.query('update instance_bindings set revoked_at=null where instance_id=$1', [fixture.instance.instanceId]);
    const dropped = await waiting(a); dropped.req.destroy(new Error('owned inbox socket disconnected'));
    await assert.rejects(dropped.done, /owned inbox socket disconnected/);
    await stats(a, s => s.inFlightWaits === 0 && s.poolIdle === s.poolTotal);
    report.checks.push('actual HTTP disconnect cancels the waiter and releases capacity');
    const localOffer = await fixture.prepareOffer(), local = await waiting(a), localStart = performance.now();
    assert.equal((await authorize(a, localOffer)).status, 200);
    assert.equal((await local.done).body.intent.intentId, localOffer.intent.intentId);
    report.localDeliveryMs = performance.now() - localStart; assert(report.localDeliveryMs < 1000);
    report.checks.push('same process notifies after commit and delivers without the polling gap');
    report.success = true;
  } catch (error) { report.error = { code: error.code || error.name, message: error.message }; process.exitCode = 1; }
  finally {
    for (const call of calls) call.req.destroy();
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = new Promise(resolve => child.once('exit', resolve)); if (child.connected) child.send({ stop: true });
      const timer = setTimeout(() => { report.success = false; report.cleanupForced = true; process.exitCode = 1; child.kill('SIGTERM'); }, 3000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 6000);
      try { await ended; } finally { clearTimeout(timer); clearTimeout(kill); }
    }));
    (fixture?.broker.closeRendezvousInboxWaiters || fixture?.broker.closeRendezvousResultWaiters)?.();
    await pool.end();
    for (const path of keyPaths) { assert(path.startsWith(resolve(sourceRoot) + '/')); await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    await writeFile(new URL('../inbox-postgres-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
}
