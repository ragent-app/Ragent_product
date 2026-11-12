import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAccountsServer } from '../accounts/server.mjs';
import { createDemoAccountPolicy } from '../accounts/demo-credentials.mjs';
import { createAccountsLogger } from '../accounts/log.mjs';
import { createPostgresStoreFromUrl } from '../accounts/store/postgres.mjs';
import { buildAccountSessionMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';

const dir = await mkdtemp(join(tmpdir(), 'agentoc-demo-server-'));
const password = 'fixture-only-password-32-characters';
let log = '';
createAccountsLogger({ stream: new Writable({ write(chunk, encoding, done) { log += chunk; done(); } }) })
  .info({ password, body: { password }, req: { body: { password } }, passwordHash: { key: 'fixture-key' } });
assert.equal(log.includes(password), false); assert.equal(log.includes('fixture-key'), false);
const provisionPath = fileURLToPath(new URL('../accounts/provision-demo-account.mjs', import.meta.url));
const provisionFile = join(dir, 'provisioned-policy.json');
const provision = spawnSync(process.execPath, [provisionPath, provisionFile], {
  input: JSON.stringify({ username: 'review-fixture', password, instanceId: 'inst_demo_server' }), encoding: 'utf8', timeout: 10_000,
});
assert.equal(provision.status, 0); assert.equal(provision.stdout.includes(password), false);
const provisionedBytes = await readFile(provisionFile, 'utf8');
assert.equal(provisionedBytes.includes(password), false);
const provisionedPolicy = JSON.parse(provisionedBytes);
assert.equal(provisionedPolicy.accessMode, 'full');
assert.equal(provisionedPolicy.instanceAccess, 'account');
assert.equal(provisionedPolicy.unlimitedConnections, false);
const independentFile = join(dir, 'independent-policy.json');
const independentProvision = spawnSync(process.execPath, [provisionPath, independentFile], {
  input: JSON.stringify({ username: 'independent-fixture', password }), encoding: 'utf8', timeout: 10_000,
});
assert.equal(independentProvision.status, 0);
assert.deepEqual(JSON.parse(await readFile(independentFile, 'utf8')).allowedInstanceIds, []);
const repeat = spawnSync(process.execPath, [provisionPath, provisionFile], {
  input: JSON.stringify({ username: 'review-fixture', password, instanceId: 'inst_demo_server' }), encoding: 'utf8', timeout: 10_000,
});
assert.equal(repeat.status, 1); assert.equal(await readFile(provisionFile, 'utf8'), provisionedBytes);

async function run(store) {
  const policy = await createDemoAccountPolicy({ username: 'review-fixture', password, instanceId: 'inst_demo_server',
    accessMode: 'restricted', instanceAccess: 'allowlist' });
  const file = join(dir, store ? 'pg-policy.json' : 'file-policy.json');
  await writeFile(file, JSON.stringify(policy), { mode: 0o600 });
  const options = { dataFile: join(dir, 'accounts.json'), signingKeyFile: join(dir, 'signing.json'),
    publicBaseUrl: 'http://127.0.0.1', allowInsecurePublicBaseUrl: true, demoAccountPolicyFile: file,
    verifyGoogleCredential: async () => ({ sub: 'google-fixture' }),
    verifyNativeGoogleCredential: async () => ({ sub: 'google-fixture' }), ...(store ? { store } : {}) };
  const app = await createAccountsServer(options);
  const server = createServer((req, res) => app.handler(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const statusResponse = await fetch(`http://127.0.0.1:${server.address().port}/v1/owner-auth/demo-status`);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), { status: 'configured' }, 'legacy policy is interpreted as a normal account');
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  try {
    async function establish(demo, suffix) {
      const requestId = `request_server_fixture_${suffix}`, deviceId = `adev_server_fixture_${suffix}`;
      const c = await app.broker.createAccountSessionChallenge({ requestId, device: { deviceId, publicKey } });
      const body = { requestId, transactionId: c.transactionId,
        signature: sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: c.transactionId, requestId,
          deviceId, publicKeyFingerprint: createDevicePublicKeyFingerprint(publicKey), nonce: c.nonce })), key.privateKey).toString('base64url') };
      if (demo) { body.username = 'review-fixture'; body.password = password; } else body.idToken = 'google-fixture';
      const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/owner-auth/native/session/${demo ? 'demo' : 'complete'}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200); return res.json();
    }
    const google = await establish(false, 'google');
    const demo = await establish(true, 'demo');
    assert.equal(demo.accountId, policy.accountId); assert.match(google.accountId, /^acct_google_/);
    const snapshot = await app.store.mutate(draft => structuredClone(draft));
    assert.equal(snapshot.accounts.length, 2); assert.equal(snapshot.accountDevices.length, 2);
    assert.equal(new Set(snapshot.accountDeviceKeys.map(row => row.keyId)).size, 2);
    assert.equal(JSON.stringify(snapshot).includes(password), false);
    assert.equal(JSON.stringify(snapshot).includes(demo.credential.token), false);
    const restarted = await createAccountsServer(options);
    assert.equal((await restarted.broker.discoverInstances({}, { credential: demo.credential.token })).instances.length, 0);
    await restarted.broker.logoutAccountSession({ credential: demo.credential.token });
    await assert.rejects(app.broker.discoverInstances({}, { credential: demo.credential.token }), { statusCode: 401 });
    assert.equal((await app.broker.discoverInstances({}, { credential: google.credential.token })).instances.length, 0);
    const unavailableApp = await createAccountsServer({ ...options, demoAccountPolicyFile: join(dir, 'missing-policy') });
    assert.equal(unavailableApp.broker.demoSignInStatus, 'unavailable');
    await assert.rejects(unavailableApp.broker.completeDemoAccountSession({}), { code: 'owner_auth_demo_unavailable' });
    assert.equal((await unavailableApp.broker.discoverInstances({}, { credential: google.credential.token })).instances.length, 0,
      'an unavailable test policy must not interrupt an existing Google session');
    const requestId = 'request_server_fixture_google_after_invalid_policy';
    const deviceId = 'adev_server_google_after_invalid_policy';
    const challenge = await unavailableApp.broker.createAccountSessionChallenge({ requestId, device: { deviceId, publicKey } });
    const googleAfterFailure = await unavailableApp.broker.completeAccountSession({
      requestId, transactionId: challenge.transactionId, idToken: 'google-fixture',
      signature: sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: challenge.transactionId, requestId,
        deviceId, publicKeyFingerprint: createDevicePublicKeyFingerprint(publicKey), nonce: challenge.nonce })), key.privateKey).toString('base64url'),
    });
    assert.match(googleAfterFailure.accountId, /^acct_google_/, 'Google sign-in remains available when the test policy is broken');
    console.log(`PASS demo server ${store ? 'Postgres' : 'file'}: configured HTTP login, separate key rows, restart persistence, logout and unchanged Google session`);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
let pg;
try {
  await run();
  const url = process.env.AGENTOC_DEMO_TEST_DATABASE_URL;
  if (url) {
    const parsed = new URL(url);
    assert.ok(parsed.hostname === 'agentoc-demo-review-pg-20261026'
      || (parsed.hostname === '127.0.0.1' && parsed.port === '18422'));
    assert.equal(parsed.pathname, '/agentoc_demo_fixture');
    pg = createPostgresStoreFromUrl(url);
    for (const name of (await readdir(new URL('../accounts/migrations/', import.meta.url))).filter(n => n.endsWith('.up.sql')).sort()) {
      await pg.pool.query(await readFile(new URL(`../accounts/migrations/${name}`, import.meta.url), 'utf8'));
    }
    await run(pg);
  }
} finally {
  await pg?.close();
  assert.ok(basename(dir).startsWith('agentoc-demo-server-'));
  await rm(dir, { recursive: true, force: true });
}
