import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileStore, startAccountsServer } from '../accounts/server.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildAccountSessionMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { createDemoAccountAuth } from '../accounts/demo-credentials.mjs';
import { createPostgresStoreFromUrl } from '../accounts/store/postgres.mjs';
import { ensureDefaultRagentAccount } from '../accounts/default-ragent-account.mjs';

const dir = await mkdtemp(join(tmpdir(), 'ragent-account-init-'));
try {
  const dataFile = join(dir, 'accounts.json');
  const store = createFileStore(dataFile);
  await store.mutate(draft => { draft.accounts = [{ accountId: 'acct_google_fixture', provider: 'google',
    providerSubject: 'fixture-existing-google', createdAt: '2026-01-01T00:00:00.000Z' }]; });
  const options = { store, dataDirectory: dir };
  const [first, second] = await Promise.all([ensureDefaultRagentAccount(options), ensureDefaultRagentAccount(options)]);
  assert.equal(first.status, 'configured');
  assert.deepEqual(second, first);
  const bytes = await readFile(first.policyPath, 'utf8');
  const policy = JSON.parse(bytes);
  assert.equal(policy.username, 'ragent');
  assert.match(policy.password, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await createDemoAccountAuth(policy).verify({ username: policy.username, password: policy.password })).accountId, policy.accountId);
  assert.equal(bytes.includes('fixture-existing-google'), false);
  const stored = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(stored.accounts.length, 2);
  assert.equal(stored.accounts.find(account => account.provider === 'google').accountId, 'acct_google_fixture');
  assert.equal(stored.accounts.find(account => account.provider === 'demo').accountId, policy.accountId);
  assert.equal(JSON.stringify(stored).includes(policy.password), false);
  if (process.platform === 'win32') {
    const privateDir = join(dir, 'ragent-account');
    execFileSync('icacls.exe', [privateDir, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore', windowsHide: true });
    await ensureDefaultRagentAccount(options);
    const inspect = `$d = [System.IO.DirectoryInfo]::new($env:RAGENT_ACCOUNT_TEST_DIR)
      foreach ($rule in $d.GetAccessControl().Access) { $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`;
    const sids = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inspect], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, RAGENT_ACCOUNT_TEST_DIR: privateDir },
    });
    assert.equal(sids.includes('S-1-1-0'), false, 'startup removes unrelated explicit grants');
  }
  const restarted = await ensureDefaultRagentAccount({ ...options, store: createFileStore(dataFile) });
  assert.equal(restarted.status, 'configured');
  assert.equal(await readFile(first.policyPath, 'utf8'), bytes, 'restart preserves credentials and account identity');
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dir, 'ragent-account'))).mode & 0o077, 0);
    assert.equal((await stat(first.policyPath)).mode & 0o077, 0);
  }
  await writeFile(first.policyPath, '{ damaged', { mode: 0o600 });
  await assert.rejects(ensureDefaultRagentAccount(options), /policy is unavailable/);
  assert.equal(await readFile(first.policyPath, 'utf8'), '{ damaged', 'bad data is not silently overwritten');
  await rm(first.policyPath);
  const missing = await ensureDefaultRagentAccount(options);
  assert.equal(missing.status, 'unavailable', 'missing policy cannot create a different account');
  await assert.rejects(readFile(first.policyPath));
  const storedAfter = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.deepEqual(storedAfter, stored);
  const liveDir = join(dir, 'live');
  await mkdir(liveDir);
  const liveOptions = { host: '127.0.0.1', port: 0, logger: { level: 'silent' },
    dataFile: join(liveDir, 'accounts.json'), signingKeyFile: join(liveDir, 'signing-key.json'),
    publicBaseUrl: 'http://127.0.0.1', allowInsecurePublicBaseUrl: true,
    verifyNativeGoogleCredential: async () => ({ sub: 'google-owner-fixture' }) };
  let app = await startAccountsServer(liveOptions);
  try {
    const url = `http://127.0.0.1:${app.server.address().port}`;
    assert.deepEqual(await (await fetch(`${url}/v1/owner-auth/demo-status`)).json(), { status: 'configured' });
    const livePolicy = JSON.parse(await readFile(join(liveDir, 'ragent-account', 'account.json'), 'utf8'));
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const requestId = 'request_default_ragent_fixture', deviceId = 'adev_default_ragent_fixture';
    const challengeResponse = await fetch(`${url}/v1/owner-auth/native/session/challenge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, device: { deviceId, publicKey } }),
    });
    assert.equal(challengeResponse.status, 201);
    const challenge = await challengeResponse.json();
    const signature = sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: challenge.transactionId,
      requestId, deviceId, publicKeyFingerprint: createDevicePublicKeyFingerprint(publicKey), nonce: challenge.nonce })), key.privateKey).toString('base64url');
    const login = await fetch(`${url}/v1/owner-auth/native/session/demo`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId,
        transactionId: challenge.transactionId, username: livePolicy.username, password: livePolicy.password, signature }) });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).accountId, livePolicy.accountId);
    await app.close(); app = null;
    app = await startAccountsServer(liveOptions);
    assert.equal(JSON.parse(await readFile(join(liveDir, 'ragent-account', 'account.json'), 'utf8')).accountId, livePolicy.accountId);
    assert.equal((await (await fetch(`http://127.0.0.1:${app.server.address().port}/v1/owner-auth/demo-status`)).json()).status, 'configured');
    await app.close(); app = null;
    const livePolicyPath = join(liveDir, 'ragent-account', 'account.json');
    await writeFile(livePolicyPath, '{ corrupted', { mode: 0o600 });
    app = await startAccountsServer(liveOptions);
    assert.equal((await (await fetch(`http://127.0.0.1:${app.server.address().port}/v1/owner-auth/demo-status`)).json()).status, 'unavailable');
    assert.equal(await readFile(livePolicyPath, 'utf8'), '{ corrupted');
    const googleRequestId = 'request_google_after_default_failure', googleDeviceId = 'adev_google_default_failure';
    const googleChallenge = await app.broker.createAccountSessionChallenge({ requestId: googleRequestId,
      device: { deviceId: googleDeviceId, publicKey } });
    const googleSignature = sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: googleChallenge.transactionId,
      requestId: googleRequestId, deviceId: googleDeviceId, publicKeyFingerprint: createDevicePublicKeyFingerprint(publicKey),
      nonce: googleChallenge.nonce })), key.privateKey).toString('base64url');
    const googleSession = await app.broker.completeAccountSession({ requestId: googleRequestId,
      transactionId: googleChallenge.transactionId, idToken: 'fixture', signature: googleSignature });
    assert.match(googleSession.accountId, /^acct_google_/);
  } finally { await app?.close(); }
  if (process.env.RAGENT_DEFAULT_TEST_DATABASE_URL) {
    const databaseUrl = process.env.RAGENT_DEFAULT_TEST_DATABASE_URL;
    const parsed = new URL(databaseUrl);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.equal(parsed.port, '18422');
    assert.equal(parsed.pathname, '/ragent_default_fixture');
    const pgDir = join(dir, 'postgres'); await mkdir(pgDir);
    let pg = createPostgresStoreFromUrl(databaseUrl);
    for (const name of (await readdir(new URL('../accounts/migrations/', import.meta.url))).filter(name => name.endsWith('.up.sql')).sort()) {
      await pg.pool.query(await readFile(new URL(`../accounts/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const pgOptions = { ...liveOptions, dataFile: join(pgDir, 'accounts.json'), signingKeyFile: join(pgDir, 'signing-key.json'), store: pg };
    let pgApp;
    try {
      pgApp = await startAccountsServer(pgOptions);
      const firstPolicy = await readFile(join(pgDir, 'ragent-account', 'account.json'), 'utf8');
      const firstAccount = JSON.parse(firstPolicy);
      assert.equal((await (await fetch(`http://127.0.0.1:${pgApp.server.address().port}/v1/owner-auth/demo-status`)).json()).status, 'configured');
      const row = await pg.pool.query('select provider, provider_subject from accounts where account_id=$1', [firstAccount.accountId]);
      assert.equal(row.rows.length, 1); assert.equal(row.rows[0].provider, 'demo');
      const pgKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const pgPublicKey = pgKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const pgRequestId = 'request_default_postgres_fixture', pgDeviceId = 'adev_default_postgres_fixture';
      const pgChallenge = await pgApp.broker.createAccountSessionChallenge({ requestId: pgRequestId,
        device: { deviceId: pgDeviceId, publicKey: pgPublicKey } });
      const pgSignature = sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: pgChallenge.transactionId,
        requestId: pgRequestId, deviceId: pgDeviceId, publicKeyFingerprint: createDevicePublicKeyFingerprint(pgPublicKey),
        nonce: pgChallenge.nonce })), pgKey.privateKey).toString('base64url');
      const pgSession = await pgApp.broker.completeDemoAccountSession({ transactionId: pgChallenge.transactionId,
        requestId: pgRequestId, username: firstAccount.username, password: firstAccount.password, signature: pgSignature });
      assert.equal(pgSession.accountId, firstAccount.accountId);
      await pgApp.close(); pgApp = null;
      pg = createPostgresStoreFromUrl(databaseUrl);
      pgApp = await startAccountsServer({ ...pgOptions, store: pg });
      assert.equal(await readFile(join(pgDir, 'ragent-account', 'account.json'), 'utf8'), firstPolicy);
      assert.equal((await (await fetch(`http://127.0.0.1:${pgApp.server.address().port}/v1/owner-auth/demo-status`)).json()).status, 'configured');
      assert.deepEqual((await pgApp.broker.discoverInstances({}, { credential: pgSession.credential.token })).instances, []);
      console.log('PASS default account PostgreSQL: initialization, persistent identity and restart');
    } finally { if (pgApp) await pgApp.close(); else await pg?.close(); }
  }
  console.log('PASS default account: persistent identity, random private credentials, concurrent startup, HTTP login and restart');
} finally {
  await rm(dir, { recursive: true, force: true });
}
