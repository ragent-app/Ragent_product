import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRunPublication, bindRunPublication } from '../chat/run-publication-contract.mjs';
import { computeExecutionScopeDigest } from '../chat/execution-scope.mjs';
import { signLinuxRunScopeGrant } from '../chat/linux-run-scope-grant.mjs';
import { enrollLinuxServiceKeyPin } from '../scripts/linux-service-key-pin.mjs';
import { registerLinuxRunContext, readLinuxRunContext, renewLinuxRunContext, revokeLinuxRunContext } from '../scripts/linux-run-context-store.mjs';

test('root state binds a signed scope to the live unit and revokes durably',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 || !process.env.AGENTOC_TEST_SYSTEMD_INVOCATION }, async () => {
    const root = await mkdtemp('/srv/agentoc-run-state-test-');
    const directory = `${root}/runs`, pinDirectory = `${root}/pin`;
    try {
      await mkdir(directory, { mode: 0o700 }); await mkdir(pinDirectory, { mode: 0o700 });
      const keys = generateKeyPairSync('ed25519');
      const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      await enrollLinuxServiceKeyPin({ directory: pinDirectory, publicKey: keys.publicKey, expectedKeyId: keyId });
      const run = { id: 'run_test12345678', sessionId: 'session_test', requestId: 'turn_test', runPublication: createRunPublication() };
      const scope = { sessionId: run.sessionId, cwd: { realPath: '/srv/work' }, scopeRoot: { realPath: '/srv/work' },
        riskContext: { platform: 'linux', cwd: '/srv/work', trustedWorkspaceRoot: '/srv/work' } };
      const manifest = bindRunPublication(run, { executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope),
        options: { approvedActionChannel: { turnId: run.requestId, token: 'secret-must-not-be-persisted' } } });
      const grant = signLinuxRunScopeGrant({ run, manifest, launchAttempt: 2, privateKey: keys.privateKey, ttlMs: 60000 });
      const args = { directory, pinDirectory, run, manifest, grant, launchAttempt: 2 };
      await assert.rejects(registerLinuxRunContext({ ...args, launchAttempt: 1 }));
      const result = await registerLinuxRunContext(args);
      assert.equal(result.invocationId, process.env.AGENTOC_TEST_SYSTEMD_INVOCATION);
      await assert.rejects(registerLinuxRunContext(args));
      const loaded = await readLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 2 });
      assert.equal(loaded.cwd, '/srv/work');
      assert.equal(loaded.sessionId, run.sessionId);
      assert.equal(await readLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 1 }), null);
      const renewed = signLinuxRunScopeGrant({ run, manifest, launchAttempt: 2, privateKey: keys.privateKey, ttlMs: 300000 });
      await renewLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 2, grant: renewed });
      assert.equal((await readLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 2 })).invocationId, result.invocationId);
      await assert.rejects(renewLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 2, grant }));
      const otherKeys = generateKeyPairSync('ed25519');
      const forged = signLinuxRunScopeGrant({ run, manifest, launchAttempt: 2, privateKey: otherKeys.privateKey });
      await assert.rejects(renewLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 2, grant: forged }));
      const recordName = `${createHash('sha256').update(run.id).digest('hex')}-2.json`;
      assert.equal((await readFile(`${directory}/${recordName}`, 'utf8')).includes('secret-must-not-be-persisted'), false);
      const lockPath = `${directory}/${createHash('sha256').update(run.id).digest('hex')}-2.renew.lock`;
      await writeFile(lockPath, '', { mode: 0o600, flag: 'wx' });
      const later = signLinuxRunScopeGrant({ run, manifest, launchAttempt: 2, privateKey: keys.privateKey });
      await assert.rejects(renewLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 2, grant: later }));
      await rm(lockPath);
      await revokeLinuxRunContext({ directory, runId: run.id, launchAttempt: 2 });
      await revokeLinuxRunContext({ directory, runId: run.id, launchAttempt: 2 });
      assert.equal(await readLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 2 }), null);
      await assert.rejects(renewLinuxRunContext({ directory, pinDirectory, runId: run.id, launchAttempt: 2, grant: renewed }));
      await assert.rejects(registerLinuxRunContext(args));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
