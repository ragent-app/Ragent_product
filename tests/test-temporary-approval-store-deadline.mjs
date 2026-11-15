import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApprovedActionStore } from '../chat/approved-action-store.mjs';
import { executeApprovedAction } from '../chat/approved-action-executor.mjs';
import { spawnManagedProviderProcess } from '../lib/windows-managed-spawn.mjs';
import { makeDeadlineTempRoot } from './helpers/deadline-temp-root.mjs';

test('a queued approved-action decision refuses an expired control grant before append', async (t) => {
  const fixture = await makeDeadlineTempRoot('ragent-approval-deadline-');
  t.after(() => fixture.cleanup());
  const { root } = fixture;
  const events = [];
  let delayRead = false;
  const originalNow = Date.now;
  let now = originalNow();
  const deadline = now + 1000;
  const store = createApprovedActionStore({
    readEvents: async () => {
      const snapshot = events.slice();
      if (delayRead) now = deadline;
      return snapshot;
    },
    appendEvent: async event => { events.push(event); return event; },
  });
  const proposed = await store.propose([{
    command: 'sudo systemctl restart nginx', cwd: root, category: 'privileged_other',
    description: 'Restart nginx',
  }], {
    requestKey: 'deadline-fixture', sessionId: 'session-deadline', runId: 'run-deadline',
    turnId: 'turn-deadline', cwd: root, projectRoot: root, home: root,
  });
  const action = proposed.batch.actions[0];
  const before = events.length;
  Date.now = () => now;
  delayRead = true;
  try {
    await assert.rejects(store.resolveBatch(proposed.batch.batchId, { [action.actionId]: 'approve' }, {
      assertAuthorization: () => {
        if (Date.now() >= deadline) throw Object.assign(new Error('control grant expired'),
          { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
      },
    }), { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
    assert.equal(events.length, before);
  } finally { Date.now = originalNow; }
});

test('an approved action does not execute after its temporary grant expires', async () => {
  const result = await executeApprovedAction({ executionClass: 'session' },
    { authorization: { temporaryControlExpiresAt: Date.now() - 1 } });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'TEMPORARY_CONTROL_APPROVAL_DENIED');
});

test('a session revalidation that finishes after expiry cannot launch argv', async (t) => {
  const fixture = await makeDeadlineTempRoot('ragent-session-deadline-');
  t.after(() => fixture.cleanup());
  const { root } = fixture;
  const marker = join(root, 'launched.txt');
  const originalNow = Date.now;
  const start = originalNow();
  let now = start;
  Date.now = () => now;
  try {
    const result = await executeApprovedAction({
      executionClass: 'session',
      argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`],
      cwd: root,
    }, {
      authorization: { temporaryControlExpiresAt: start + 1000 },
      revalidate: async () => { now = start + 1000; return { ok: true }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'TEMPORARY_CONTROL_APPROVAL_DENIED');
    assert.equal(existsSync(marker), false);
  } finally { Date.now = originalNow; }
});

test('a delayed Windows Job host refuses process creation after approval expiry', async () => {
  const originalNow = Date.now;
  const start = originalNow();
  let now = start;
  let created = false;
  let closed = false;
  Date.now = () => now;
  try {
    await assert.rejects(spawnManagedProviderProcess({ file: process.execPath, args: [] }, {
      assertAuthorization: () => {
        if (Date.now() >= start + 1000) throw Object.assign(new Error('Temporary control approval expired'),
          { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
      },
    }, {
      platform: 'win32',
      createWindowsJobObject: async () => {
        now = start + 1000;
        return {
          createProcess: async () => { created = true; throw new Error('must not create'); },
          terminate: async () => {},
          close: async () => { closed = true; },
        };
      },
    }), { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
    assert.equal(created, false);
    assert.equal(closed, true);
  } finally { Date.now = originalNow; }
});
