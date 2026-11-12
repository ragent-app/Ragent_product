import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceAuthorityController } from '../lib/workspace-authority-controller.mjs';

const identity = { ownerAccountId: 'acct_workspace_owner', accountId: 'acct_workspace_member',
  grantId: 'iag_' + 'a'.repeat(24), revision: '7' };

test('workspace proof is short-lived and invalidated on disabled membership or revision change', async () => {
  let now = 1_800_000_000_000, mono = 1_000, state = 'active', revision = '7', calls = 0;
  const timers = new Set(), events = [];
  const controller = createWorkspaceAuthorityController({ clock: () => now, monotonicNow: () => mono,
    setTimer: fn => { const timer = { fn }; timers.add(timer); return timer; }, clearTimer: timer => timers.delete(timer),
    onInvalidate: event => events.push(event), query: async input => { calls++; return { ...input,
      authorityProtocol: 1, state, revision, checkedAt: now, expiresAt: now + 30_000 }; } });
  assert.equal(controller.allows(identity), false);
  await controller.authorize(identity); assert.equal(controller.allows(identity), true);
  await controller.authorize(identity); assert.equal(calls, 1, 'usable proof does not repeat the query');
  state = 'inactive';
  await assert.rejects(controller.refresh(identity), { code: 'workspace_authority_superseded' });
  assert.equal(controller.allows(identity), false); assert.equal(events.at(-1).reason, 'workspace-inactive');
  state = 'active'; await controller.authorize(identity);
  revision = '8';
  await assert.rejects(controller.refresh(identity), { code: 'workspace_authority_superseded' });
  assert.equal(controller.allows(identity), false); assert.equal(events.at(-1).reason, 'workspace-generation-changed');
  revision = '7'; await controller.authorize(identity);
  now += 30_001; mono += 30_001;
  assert.equal(controller.allows(identity), false); assert.equal(events.at(-1).reason, 'workspace-expired');
  controller.stop(); assert.equal(timers.size, 0);
});

test('late queries cannot reactivate invalidated workspace access', async () => {
  const now = 1_800_000_000_000; let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const controller = createWorkspaceAuthorityController({ clock: () => now, monotonicNow: () => 1,
    query: async input => { calls++; await gate; return { ...input, authorityProtocol: 1,
      state: 'active', revision: '7', checkedAt: now, expiresAt: now + 30_000 }; } });
  const first = controller.authorize(identity), second = controller.authorize(identity);
  controller.invalidate(identity); release();
  await assert.rejects(first, { code: 'workspace_authority_superseded' });
  await assert.rejects(second, { code: 'workspace_authority_superseded' });
  assert.equal(calls, 1); assert.equal(controller.allows(identity), false); controller.stop();
});

test('forged or overlong proof cannot authorize a workspace', async () => {
  const now = 1_800_000_000_000;
  for (const override of [{ accountId: 'acct_wrong_member' }, { authorityProtocol: 2 },
    { expiresAt: now + 30_001 }, { checkedAt: now + 1 }, { state: 'unknown' }]) {
    const controller = createWorkspaceAuthorityController({ clock: () => now, monotonicNow: () => 1,
      query: async input => ({ ...input, authorityProtocol: 1, state: 'active', revision: '7',
        checkedAt: now, expiresAt: now + 30_000, ...override }) });
    await assert.rejects(controller.authorize(identity), { code: 'workspace_authority_assertion_invalid' });
    assert.equal(controller.allows(identity), false); controller.stop();
  }
});

test('scheduled refresh invalidates an existing live session without a new request', async () => {
  const now = 1_800_000_000_000, timers = new Set(), events = []; let state = 'active';
  const controller = createWorkspaceAuthorityController({ clock: () => now, monotonicNow: () => 1,
    setTimer: (fn, delay) => { const timer = { fn, delay }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer), onInvalidate: event => events.push(event),
    query: async input => ({ ...input, authorityProtocol: 1, state, revision: '7', checkedAt: now, expiresAt: now + 30_000 }) });
  await controller.authorize(identity);
  state = 'inactive';
  const refreshTimer = [...timers].find(timer => timer.delay === 10_000);
  assert.ok(refreshTimer); refreshTimer.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.allows(identity), false); assert.equal(events.at(-1).reason, 'workspace-inactive');
  controller.stop();
});
