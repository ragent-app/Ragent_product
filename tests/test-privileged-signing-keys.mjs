#!/usr/bin/env node
import assert from 'assert/strict';
import { randomBytes } from 'crypto';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { chmod, mkdtemp, rm, stat } from 'fs/promises';

// The modules under test read config.mjs's CONFIG_DIR (env-resolved at import
// time), so RAGENT_CONFIG_DIR must point at a throwaway dir BEFORE they are
// loaded — otherwise the install-auto quota gate records into a real config
// dir (hit live once: 8 quota units landed in a provider-runtime home).
const envHome = await mkdtemp(join(tmpdir(), 'ragent-p3d-home-'));
process.env.RAGENT_CONFIG_DIR = join(envHome, 'ragent-config');
// This suite mints many install-auto tokens; the default 5/1h quota would
// reject the later cases. The env knobs exist exactly for this.
process.env.RAGENT_INSTALL_AUTO_QUOTA_MAX = '100';
process.env.RAGENT_INSTALL_AUTO_QUOTA_WINDOW_MS = '3600000';
const {
  executePrivilegedOp,
  executePrivilegedOpAsEvent,
  getActivePrivilegedSigningKey,
  getPrivilegedPublicKeys,
  loadOrCreatePrivilegedSigningKeys,
} = await import('../chat/privileged-signing-keys.mjs');
const { buildPrivilegedCgroupFromRunId, verifyPrivilegedToken } = await import('../chat/privileged-token.mjs');
const { computeBatchManifestHash, computeOpManifestHash } = await import('../chat/privileged-ops.mjs');

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

// --- helpers ---
function makeFakeServer(socketPath, handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\n')) {
          try {
            const req = JSON.parse(buf.slice(0, buf.indexOf('\n')));
            handler(sock, req);
          } catch (err) {
            sock.end(JSON.stringify({ ok: false, error: 'invalid request' }) + '\n');
          }
        }
      });
    });
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

const tmpDir = await mkdtemp(join(tmpdir(), 'ragent-p3d-test-'));
const keysFile = join(tmpDir, 'privileged-signing-keys.json');

// =============================================================================
// Key management (load-or-create, mirror push.mjs VAPID pattern)
// =============================================================================

// --- before load: cache empty ---
check('no key before load', getActivePrivilegedSigningKey() === null);
check('no public keys before load', getPrivilegedPublicKeys().length === 0);

// --- fresh generation ---
const keys1 = await loadOrCreatePrivilegedSigningKeys(keysFile);
check('keys1 has current', keys1.current !== null);
check('keys1 current.kid starts pkx_', keys1.current.kid.startsWith('pkx_'));
check('keys1 current.publicKey is string', typeof keys1.current.publicKey === 'string');
check('keys1 current.privateKey is string', typeof keys1.current.privateKey === 'string');
check('keys1 current.created is iso', Date.parse(keys1.current.created) > 0);
check('keys1 previous is null', keys1.previous === null);
check('generated keys file mode 0600', ((await stat(keysFile)).mode & 0o777) === 0o600);

// --- loading existing keys repairs overly broad permissions ---
await chmod(keysFile, 0o644);
const repairScript = `
  import { loadOrCreatePrivilegedSigningKeys } from ${JSON.stringify(`${new URL('../chat/privileged-signing-keys.mjs', import.meta.url).href}?repair-mode-test`)};
  await loadOrCreatePrivilegedSigningKeys(${JSON.stringify(keysFile)});
`;
await import(`data:text/javascript;base64,${Buffer.from(repairScript).toString('base64')}`);
check('existing keys file mode repaired to 0600', ((await stat(keysFile)).mode & 0o777) === 0o600);

// --- cache hit (same file) ---
const keys2 = await loadOrCreatePrivilegedSigningKeys(keysFile);
check('cache returns same object', keys1 === keys2);

// --- getActivePrivilegedSigningKey ---
const active = getActivePrivilegedSigningKey();
check('active signing key not null', active !== null);
check('active has publicKey KeyObject', active.publicKey && typeof active.publicKey.export === 'function');
check('active has privateKey KeyObject', active.privateKey && typeof active.privateKey.export === 'function');
check('active kid matches stored', active.kid === keys1.current.kid);

// --- getPrivilegedPublicKeys ---
const publicKeys = getPrivilegedPublicKeys();
check('public keys length 1', publicKeys.length === 1);
check('public key kid matches', publicKeys[0].kid === active.kid);

// =============================================================================
// executePrivilegedOp — full mint → sign → send → verify round-trip
// =============================================================================

const sampleOp = {
  opId: 'pop_deadbeefcafe01',
  command: 'apt-get install -y nginx',
  category: 'software_install',
  cwd: '/tmp/project',
  manifestHash: computeOpManifestHash({ command: 'apt-get install -y nginx', category: 'software_install', cwd: '/tmp/project' }),
};

const sessionOpts = {
  sessionId: 'sess_test01',
  runId: 'run_test01',
  turnId: 'turn_test01',
  authMode: 'install-auto',
  auditLabel: 'P3d test: install nginx',
};

// --- happy path ---
{
  const sockPath = join(tmpDir, 'happy.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('happy req.action exec', req.action === 'exec');
    check('happy req.token present', req.token && typeof req.token === 'object');
    check('happy req.token.opId matches', req.token.opId === sampleOp.opId);
    check('happy req.token.command matches', req.token.command === sampleOp.command);
    check('happy req.token.authMode install-auto', req.token.authMode === 'install-auto');
    check('happy req.token.cgroup derived', req.token.cgroup === buildPrivilegedCgroupFromRunId(sessionOpts.runId));
    // Verify the token signature using the public key
    const verifyResult = verifyPrivilegedToken(req.token, { publicKey: active.publicKey });
    check('happy token signature valid', verifyResult.ok === true);
    // Respond success
    sock.end(JSON.stringify({
      ok: true,
      id: req.id,
      result: { opId: req.token.opId, exitCode: 0, auditId: 'paud_test01', durationMs: 234 },
    }) + '\n');
  });

  const result = await executePrivilegedOp(sampleOp, { ...sessionOpts, socketPath: sockPath });
  check('happy result ok true', result.ok === true);
  check('happy result opId preserved', result.opId === sampleOp.opId);
  check('happy result exitCode 0', result.exitCode === 0);
  check('happy result auditId', result.auditId === 'paud_test01');
  server.close();
}

// --- executor returns ok:false (token expired) ---
{
  const sockPath = join(tmpDir, 'rejected.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    sock.end(JSON.stringify({
      ok: false,
      id: req.id,
      error: 'Token expired',
      code: 'PRIVILEGED_TOKEN_EXPIRED',
    }) + '\n');
  });

  const result = await executePrivilegedOp(sampleOp, { ...sessionOpts, socketPath: sockPath });
  check('rejected result ok false', result.ok === false);
  check('rejected result error', result.error === 'Token expired');
  check('rejected result code', result.code === 'PRIVILEGED_TOKEN_EXPIRED');
  server.close();
}

// --- socket transport error (connection refused) ---
{
  const badPath = join(tmpDir, 'does-not-exist.sock');
  const result = await executePrivilegedOp(sampleOp, { ...sessionOpts, socketPath: badPath, timeoutMs: 500 });
  check('conn-refused result ok false', result.ok === false);
  check('conn-refused has error', result.error.length > 0);
  check('conn-refused has code', result.code && result.code.length > 0);
}

// --- socket timeout ---
{
  const sockPath = join(tmpDir, 'timeout.sock');
  const server = await makeFakeServer(sockPath, (_sock, _req) => {
    // never respond — trigger timeout
  });

  const result = await executePrivilegedOp(sampleOp, { ...sessionOpts, socketPath: sockPath, timeoutMs: 500 });
  check('timeout result ok false', result.ok === false);
  check('timeout code is TIMEOUT', result.code === 'PRIVILEGED_EXECUTOR_TIMEOUT');
  server.close();
}

// --- P2 passkey gate (design §5.6): rejected without a signed subset ---
{
  const deleteOp = { ...sampleOp, opId: 'pop_delete01', command: 'rm -rf /var/log/old', category: 'destructive_delete' };
  const result = await executePrivilegedOp(deleteOp, {
    ...sessionOpts,
    authMode: 'passkey',
  });
  check('passkey gate: no credential rejected', result.ok === false);
  check('passkey gate: code PASSKEY_REQUIRED', result.code === 'PRIVILEGED_PASSKEY_REQUIRED');
}

// --- P2 passkey gate: credential but manifest mismatch rejected ---
{
  const deleteOp = { ...sampleOp, opId: 'pop_delete02', command: 'rm -rf /var/log/old', category: 'destructive_delete' };
  const result = await executePrivilegedOp(deleteOp, {
    ...sessionOpts,
    authMode: 'passkey',
    webauthnCredentialId: 'cred_test01',
    signedManifestHash: 'hash-signed-for-a-different-subset',
  });
  check('passkey gate: manifest mismatch rejected', result.ok === false);
  check('passkey gate: code MANIFEST_MISMATCH', result.code === 'PRIVILEGED_PASSKEY_MANIFEST_MISMATCH');
}

// --- P2 passkey gate: signed subset matches → mint proceeds ---
{
  const sockPath = join(tmpDir, 'passkey.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('passkey token authMode', req.token.authMode === 'passkey');
    check('passkey token opId', req.token.opId === 'pop_delete03');
    sock.end(JSON.stringify({ ok: true, id: req.id, result: { exitCode: 0, auditId: 'paud_passkey' } }) + '\n');
  });

  const batchManifestHash = computeBatchManifestHash([{
    opId: 'pop_delete03',
    category: 'destructive_delete',
    command: 'rm -rf /var/log/old',
    manifestHash: sampleOp.manifestHash,
  }], 'destructive_delete');
  const deleteOp = {
    ...sampleOp,
    opId: 'pop_delete03',
    command: 'rm -rf /var/log/old',
    category: 'destructive_delete',
    batchManifestHash,
  };
  const result = await executePrivilegedOp(deleteOp, {
    ...sessionOpts,
    authMode: 'passkey',
    webauthnCredentialId: 'cred_test01',
    signedManifestHash: batchManifestHash,
    socketPath: sockPath,
  });
  check('passkey gate: matching subset mints', result.ok === true);
  check('passkey gate: auditId', result.auditId === 'paud_passkey');
  server.close();
}

// --- owner-click gate: no credential needed, subset binding still enforced ---
{
  const batchManifestHash = computeBatchManifestHash([{
    opId: 'pop_delete04',
    category: 'destructive_delete',
    command: 'rm -rf /var/log/old',
    manifestHash: sampleOp.manifestHash,
  }], 'destructive_delete');
  const deleteOp = {
    ...sampleOp,
    opId: 'pop_delete04',
    command: 'rm -rf /var/log/old',
    category: 'destructive_delete',
    batchManifestHash,
  };
  // Subset mismatch still fails closed in owner-click mode.
  const mismatch = await executePrivilegedOp(deleteOp, {
    ...sessionOpts,
    authMode: 'owner-click',
    signedManifestHash: 'hash-for-a-different-subset',
  });
  check('owner-click gate: manifest mismatch rejected', mismatch.ok === false);
  check('owner-click gate: code MANIFEST_MISMATCH', mismatch.code === 'PRIVILEGED_PASSKEY_MANIFEST_MISMATCH');

  const sockPath = join(tmpDir, 'owner-click.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('owner-click token authMode', req.token.authMode === 'owner-click');
    check('owner-click token opId', req.token.opId === 'pop_delete04');
    sock.end(JSON.stringify({ ok: true, id: req.id, result: { exitCode: 0, auditId: 'aud_owner_click' } }) + '\n');
  });
  const result = await executePrivilegedOp(deleteOp, {
    ...sessionOpts,
    authMode: 'owner-click',
    signedManifestHash: batchManifestHash,
    socketPath: sockPath,
  });
  check('owner-click gate: matching subset mints without credential', result.ok === true);
  check('owner-click gate: auditId', result.auditId === 'aud_owner_click');
  server.close();
}

// --- unknown authMode fails closed at mint (no coercion, no socket) ---
{
  for (const badMode of ['weird-mode', '', '  ', 'PASSKEY', 'sudo']) {
    const sockPath = join(tmpDir, 'unused-auth-mode.sock');
    const result = await executePrivilegedOp(sampleOp, {
      ...sessionOpts,
      authMode: badMode,
      socketPath: sockPath,
    });
    check(`unknown authMode rejected (${JSON.stringify(badMode)})`, result.ok === false);
    check(`unknown authMode code (${JSON.stringify(badMode)})`, result.code === 'PRIVILEGED_AUTH_MODE_INVALID');
  }
}

// --- empty command (returns error without socket) ---
{
  const result = await executePrivilegedOp({ opId: 'pop_empty', command: '' }, sessionOpts);
  check('empty command ok false', result.ok === false);
  check('empty command code', result.code === 'EMPTY_COMMAND');
}

// --- missing opId handled ---
{
  const result = await executePrivilegedOp({ command: 'echo hi' }, sessionOpts);
  check('no opId handled', result.ok !== undefined); // doesn't crash
}

// --- manifestHash auto-compute when absent ---
{
  const sockPath = join(tmpDir, 'auto-hash.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    const expectedHash = computeOpManifestHash({
      command: sampleOp.command,
      category: sampleOp.category,
      cwd: sampleOp.cwd,
    });
    check('auto-hash token manifestHash matches', req.token.manifestHash === expectedHash);
    sock.end(JSON.stringify({ ok: true, id: req.id, result: { exitCode: 0 } }) + '\n');
  });

  const opWithoutHash = { ...sampleOp };
  delete opWithoutHash.manifestHash;
  const result = await executePrivilegedOp(opWithoutHash, { ...sessionOpts, socketPath: sockPath });
  check('auto-hash result ok', result.ok === true);
  server.close();
}

// --- executePrivilegedOpAsEvent ---
{
  const sockPath = join(tmpDir, 'as-event.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    sock.end(JSON.stringify({
      ok: true,
      id: req.id,
      result: { opId: req.token.opId, exitCode: 0, auditId: 'paud_event01', stdout: 'installed ok\n' },
    }) + '\n');
  });

  const event = await executePrivilegedOpAsEvent(sampleOp, { ...sessionOpts, socketPath: sockPath });
  check('event type', event.type === 'privileged_exec_result');
  check('event opId', event.opId === sampleOp.opId);
  check('event category', event.category === sampleOp.category);
  check('event exitCode', event.exitCode === 0);
  check('event auditId', event.auditId === 'paud_event01');
  check('event stdoutRef', event.stdoutRef === 'installed ok'); // trimmed
  server.close();
}

// --- executePrivilegedOpAsEvent on failure ---
{
  const sockPath = join(tmpDir, 'as-event-fail.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    sock.end(JSON.stringify({
      ok: false,
      id: req.id,
      error: 'cgroup mismatch',
      code: 'PRIVILEGED_CGROUP_MISMATCH',
    }) + '\n');
  });

  const event = await executePrivilegedOpAsEvent(sampleOp, { ...sessionOpts, socketPath: sockPath });
  check('fail event type still correct', event.type === 'privileged_exec_result');
  check('fail event opId preserved', event.opId === sampleOp.opId);
  check('fail event error propagated', event.error === 'cgroup mismatch');
  server.close();
}

// --- runId-less op (cgroup becomes empty) ---
{
  const sockPath = join(tmpDir, 'no-runid.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('no-runid cgroup empty', req.token.cgroup === '');
    sock.end(JSON.stringify({ ok: true, id: req.id, result: { exitCode: 0 } }) + '\n');
  });

  const result = await executePrivilegedOp(sampleOp, {
    sessionId: 'sess_x',
    runId: '',
    turnId: 'turn_x',
    authMode: 'install-auto',
    socketPath: sockPath,
  });
  check('no-runid result ok', result.ok === true);
  server.close();
}

// --- token has TTL ≤ 60s ---
{
  const sockPath = join(tmpDir, 'ttl.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    const issued = Date.parse(req.token.issuedAt);
    const expires = Date.parse(req.token.expiresAt);
    const ttlMs = expires - issued;
    check('ttl is 60s', ttlMs === 60_000); // PRIVILEGED_TOKEN_TTL_MAX_MS
    sock.end(JSON.stringify({ ok: true, id: req.id, result: { exitCode: 0 } }) + '\n');
  });

  await executePrivilegedOp(sampleOp, { ...sessionOpts, socketPath: sockPath });
  server.close();
}

// --- auditLabel passed through to request ---
{
  const sockPath = join(tmpDir, 'audit.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('auditLabel in request', req.auditLabel === 'install nginx v1.2.3');
    sock.end(JSON.stringify({ ok: true, id: req.id, result: { exitCode: 0 } }) + '\n');
  });

  await executePrivilegedOp(sampleOp, { ...sessionOpts, auditLabel: 'install nginx v1.2.3', socketPath: sockPath });
  server.close();
}

// --- auditLabel omitted when empty ---
{
  const sockPath = join(tmpDir, 'no-audit-label.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('auditLabel omitted', req.auditLabel === undefined);
    sock.end(JSON.stringify({ ok: true, id: req.id, result: { exitCode: 0 } }) + '\n');
  });

  await executePrivilegedOp(sampleOp, { ...sessionOpts, auditLabel: '', socketPath: sockPath });
  server.close();
}

// --- cleanup ---
await rm(tmpDir, { recursive: true, force: true });

console.log(`privileged-signing-keys: ${passed} checks passed`);
