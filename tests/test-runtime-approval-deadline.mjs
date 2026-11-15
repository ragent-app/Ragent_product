import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { renameWithWindowsRetry } from '../lib/windows-file-replace.mjs';
import { makeDeadlineTempRoot } from './helpers/deadline-temp-root.mjs';

function expiryGuard(deadline) {
  if (Date.now() >= deadline) {
    throw Object.assign(new Error('Temporary control approval expired'),
      { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
  }
}

test('run approval queue rejects expiry during the awaited latest read and before atomic commit', async (t) => {
  const fixture = await makeDeadlineTempRoot('ragent-run-approval-deadline-');
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
  };
  const previousEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const originalNow = Date.now;
  try {
    Object.assign(process.env, overrides);
    const { createRun, runStatusPath, updateRun } = await import('../chat/runs.mjs');
    const run = await createRun({
      status: { sessionId: 'session-deadline', requestId: 'request-deadline', state: 'accepted', tool: 'codex' },
      manifest: { sessionId: 'session-deadline', requestId: 'request-deadline', folder: root,
        tool: 'codex', runtimeFamily: 'codex-app-server-json', prompt: 'test', options: {} },
    });
    const path = runStatusPath(run.id);
    const original = await readFile(path, 'utf8');
    let now = originalNow();
    const deadline = now + 1000;
    Date.now = () => now;
    let checkedBeforeWrite = false;
    await assert.rejects(updateRun(run.id, (current) => {
      // This microtask fires while updateRun awaits getRunUnlocked for its
      // second read, after the synchronous updater has already authorized.
      queueMicrotask(() => { now = deadline; });
      return { ...current, appServerApprovalResponseQueue: [{ approvalId: 'late-read' }] };
    }, {
      beforeWrite: () => { checkedBeforeWrite = true; expiryGuard(deadline); },
      beforeCommit: () => expiryGuard(deadline),
    }), { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
    assert.equal(checkedBeforeWrite, true);
    assert.equal(await readFile(path, 'utf8'), original);

    now = deadline - 1;
    let reachedCommit = false;
    await assert.rejects(updateRun(run.id, (current) => ({
      ...current, appServerApprovalResponseQueue: [{ approvalId: 'late-commit' }],
    }), {
      beforeWrite: () => expiryGuard(deadline),
      beforeCommit: () => { reachedCommit = true; now = deadline; expiryGuard(deadline); },
    }), { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
    assert.equal(reachedCommit, true);
    assert.equal(await readFile(path, 'utf8'), original);

    // Ordinary owner writes carry no temporary deadline callback.
    await updateRun(run.id, (current) => ({
      ...current, appServerApprovalResponseQueue: [{ approvalId: 'owner' }],
    }));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).appServerApprovalResponseQueue,
      [{ approvalId: 'owner' }]);
  } finally {
    Date.now = originalNow;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Windows retry rechecks expiry before replacing an approval queue file', async (t) => {
  const fixture = await makeDeadlineTempRoot('ragent-run-approval-deadline-');
  t.after(() => fixture.cleanup());
  const { root } = fixture;
  const source = join(root, 'next-status.json');
  const target = join(root, 'status.json');
  await writeFile(source, JSON.stringify({ appServerApprovalResponseQueue: [{ approvalId: 'retry' }] }));
  await writeFile(target, JSON.stringify({ appServerApprovalResponseQueue: [] }));
  const originalNow = Date.now;
  let now = originalNow();
  const deadline = now + 1000;
  let attempts = 0;
  Date.now = () => now;
  try {
    await assert.rejects(renameWithWindowsRetry(source, target, {
      platform: 'win32',
      beforeAttempt: () => expiryGuard(deadline),
      renameImpl: async () => {
        attempts += 1;
        throw Object.assign(new Error('busy'), { code: 'EPERM' });
      },
      waitImpl: async () => { now = deadline; },
      jitterImpl: () => 0,
    }), { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
    assert.equal(attempts, 1);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).appServerApprovalResponseQueue, []);
  } finally { Date.now = originalNow; }
});
