import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import net from 'node:net';
import { makeDeadlineTempRoot } from './helpers/deadline-temp-root.mjs';

test('native execution token is capped at the temporary approval deadline', async (t) => {
  const fixture = await makeDeadlineTempRoot('ragent-token-deadline-');
  t.after(() => fixture.cleanup());
  const { root } = fixture;
  const overrides = {
    RAGENT_INSTANCE_ROOT: root,
    RAGENT_CONFIG_DIR: join(root, 'config'),
    RAGENT_RUN_SPOOL_DIR: join(root, 'data', 'chat-runs'),
    RAGENT_PROVIDER_HOMES_DIR: join(root, 'provider-homes'),
    RAGENT_MEMORY_DIR: join(root, 'memory'),
    RAGENT_WORK_ROOT_DIR: join(root, 'workspace'),
    RAGENT_PLATFORM_SKILLS_DIR: join(root, 'platform', 'skills'),
    RAGENT_INSTANCE_KEY_FILE: join(root, 'config', 'instance-identity.json'),
    RAGENT_INSTALL_AUTO_QUOTA_MAX: '100',
  };
  const previousEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  let server;
  try {
    Object.assign(process.env, overrides);
    const { executePrivilegedOp, loadOrCreatePrivilegedSigningKeys } = await import('../chat/privileged-signing-keys.mjs');
    const { computeOpManifestHash } = await import('../chat/privileged-ops.mjs');
    await loadOrCreatePrivilegedSigningKeys(join(root, 'keys.json'));
    const pipe = `\\\\.\\pipe\\ragent-temp-deadline-${randomUUID()}`;
    const deadline = Date.now() + 5000;
    let observedExpiry = 0;
    server = net.createServer(socket => {
      let body = '';
      socket.on('data', chunk => {
        body += chunk.toString();
        if (!body.includes('\n')) return;
        const request = JSON.parse(body.slice(0, body.indexOf('\n')));
        observedExpiry = Date.parse(request.token.expiresAt);
        socket.end(JSON.stringify({ ok: true, id: request.id,
          result: { opId: request.token.opId, exitCode: 0, auditId: 'deadline-test' } }) + '\n');
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
    const op = { opId: 'pop_deadline_test', command: 'echo deadline', category: 'software_install', cwd: root };
    op.manifestHash = computeOpManifestHash(op);
    const options = { sessionId: 'session-deadline', runId: 'run-deadline', turnId: 'turn-deadline',
      authMode: 'install-auto', socketPath: pipe, temporaryControlExpiresAt: deadline };
    const result = await executePrivilegedOp(op, options);
    assert.equal(result.ok, true);
    assert.ok(observedExpiry > 0 && observedExpiry <= deadline);
    const expired = await executePrivilegedOp(op, { ...options, temporaryControlExpiresAt: Date.now() - 1 });
    assert.equal(expired.code, 'TEMPORARY_CONTROL_APPROVAL_DENIED');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
