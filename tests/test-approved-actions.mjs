#!/usr/bin/env node
import assert from 'assert/strict';
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  APPROVED_ACTION_HOST_CAPABILITY_TTL_MS,
  APPROVED_ACTION_PRODUCT_CAPABILITY_TTL_MS,
  APPROVED_ACTION_EXECUTION_CLASS,
  approvedActionCapabilityTtlMs,
  getApprovedActionCapability,
  isPrivilegeRoutingEnabled,
} from '../chat/approved-action-policy.mjs';
import {
  APPROVED_ACTION_TTL_MS,
  APPROVED_ACTION_STATE,
  buildApprovedAction,
  buildApprovedActionBatch,
  computeApprovedActionManifestHash,
  createApprovedActionClientProjection,
  isApprovedActionManifestIntact,
  isApprovedActionExpired,
  redactApprovedActionText,
  transitionApprovedAction,
} from '../chat/approved-actions.mjs';
import { createApprovedActionStore } from '../chat/approved-action-store.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function throwsCode(label, fn, code) {
  assert.throws(fn, (error) => error?.code === code, label);
  passed += 1;
}

check('risk mode enables routing', isPrivilegeRoutingEnabled({ riskMode: 'recommended' }));
check('Windows full-auto enables managed routing', isPrivilegeRoutingEnabled({ riskMode: 'full-auto' }) === (process.platform === 'win32'));
assert.deepEqual(getApprovedActionCapability({
  session: { riskMode: 'recommended' },
  runtime: { runtimeFamily: 'codex-app-server-json', supportsManagedActionMcp: true },
}), { state: 'available', reason: '' });
assert.equal(getApprovedActionCapability({
  session: { riskMode: 'recommended' },
  runtime: { runtimeFamily: 'codex-json', supportsManagedActionMcp: true },
}).reason, 'runtime_unsupported');
// Owner-click policy: an unregistered passkey no longer makes host actions
// unavailable; restoring the passkey checkpoint keeps the old gate.
assert.deepEqual(getApprovedActionCapability({
  session: { riskMode: 'recommended' },
  runtime: { runtimeFamily: 'codex-app-server-json', supportsManagedActionMcp: true },
  passkeyAvailable: false,
  requiresHost: true,
}), { state: 'available', reason: '' });
process.env.RAGENT_OWNER_HOST_PASSKEY_REQUIRED = '1';
assert.equal(getApprovedActionCapability({
  session: { riskMode: 'recommended' },
  runtime: { runtimeFamily: 'codex-app-server-json', supportsManagedActionMcp: true },
  passkeyAvailable: false,
  requiresHost: true,
}).reason, 'passkey_missing');
delete process.env.RAGENT_OWNER_HOST_PASSKEY_REQUIRED;
passed += 2;
check('host capability TTL remains 15 minutes', approvedActionCapabilityTtlMs('host') === APPROVED_ACTION_HOST_CAPABILITY_TTL_MS
  && APPROVED_ACTION_HOST_CAPABILITY_TTL_MS === 15 * 60 * 1000);
check('product capability TTL is bounded to two minutes', approvedActionCapabilityTtlMs('product') === APPROVED_ACTION_PRODUCT_CAPABILITY_TTL_MS
  && APPROVED_ACTION_PRODUCT_CAPABILITY_TTL_MS === 2 * 60 * 1000);

const context = { sessionId: 's1', runId: 'r1', turnId: 't1', cwd: '/tmp/project', projectRoot: '/tmp/project' };
const host = buildApprovedAction({
  command: 'sudo systemctl restart nginx',
  description: 'Reload the proxy',
  reason: 'Apply the approved configuration',
}, context);
check('leading sudo is removed', host.canonicalCommand === 'systemctl restart nginx');
check('host action is manifest bound', host.executionClass === APPROVED_ACTION_EXECUTION_CLASS.HOST && isApprovedActionManifestIntact(host));
// Default policy is owner-click: host actions no longer project needsPasskey.
check('host action is click-only by default', host.needsPasskey === false);
check('passkey checkpoint returns under policy env', (() => {
  process.env.RAGENT_OWNER_HOST_PASSKEY_REQUIRED = '1';
  try {
    const repasskey = buildApprovedAction({
      command: 'sudo systemctl restart nginx',
      description: 'Reload the proxy',
      reason: 'Apply the approved configuration',
    }, context);
    return repasskey.needsPasskey === true;
  } finally {
    delete process.env.RAGENT_OWNER_HOST_PASSKEY_REQUIRED;
  }
})());
check('approved action carries bounded expiry', Date.parse(host.expiresAt) - Date.parse(host.createdAt) === APPROVED_ACTION_TTL_MS);
check('expired action is recognized', isApprovedActionExpired({ expiresAt: new Date(0).toISOString() }, Date.now()));
check('hash changes with session binding', computeApprovedActionManifestHash(host) !== computeApprovedActionManifestHash({ ...host, sessionId: 's2' }));
const legacyManifest = {
  schemaVersion: 1,
  actionId: host.actionId,
  sessionId: host.sessionId,
  runId: host.runId,
  turnId: host.turnId,
  command: host.command || '',
  cwd: host.cwd,
  category: host.category,
  executionClass: host.executionClass,
  riskTier: host.risk.tier,
  semanticManifestHash: host.semanticManifestHash,
  expiresAt: host.expiresAt,
};
const legacyManifestHash = createHash('sha256').update(JSON.stringify(legacyManifest), 'utf8').digest('hex');
check('old command action hash remains readable', computeApprovedActionManifestHash({ ...host, commandBinding: '' }) === legacyManifestHash);
check('new action binds canonical command and argv', isApprovedActionManifestIntact(host));
check('altered command invalidates action', !isApprovedActionManifestIntact({ ...host, canonicalCommand: 'systemctl restart sshd' }));
check('altered argv invalidates action', !isApprovedActionManifestIntact({ ...host, argv: ['systemctl', 'restart', 'sshd'] }));
const ambiguous = buildApprovedAction({ command: 'sudo systemctl restart "a b"' }, context);
check('canonical command preserves argument boundaries', ambiguous.canonicalCommand === 'systemctl restart "a b"');
check('argument boundaries are bound', !isApprovedActionManifestIntact({ ...ambiguous, argv: ['systemctl', 'restart', 'a', 'b'] }));
check('review shows argument boundaries', createApprovedActionClientProjection(ambiguous).command === 'systemctl restart "a b"');
for (const command of ['New-LocalUser -Name fixture', 'New-Service -Name fixture', 'Restart-Service -Name fixture', 'sc.exe config fixture start= demand', 'net.exe user fixture /add']) {
  const action = buildApprovedAction({ command }, { ...context, platform: 'win32' });
  check(`${command} is a host action on Windows`, action.executionClass === APPROVED_ACTION_EXECUTION_CLASS.HOST && isApprovedActionManifestIntact(action));
}
throwsCode('Windows read-only account query does not become a host action', () => buildApprovedAction({ command: 'Get-LocalUser' }, { ...context, platform: 'win32' }), 'APPROVED_ACTION_NOT_REQUIRED');

const sessionAction = buildApprovedAction({ command: 'rm -f /tmp/project/cache.db', description: 'Remove a generated cache' }, context);
check('dangerous non-root action stays in session class', sessionAction.executionClass === APPROVED_ACTION_EXECUTION_CLASS.SESSION);
throwsCode('composite command rejected', () => buildApprovedAction({ command: 'rm -f /tmp/a && touch /tmp/b' }, context), 'APPROVED_ACTION_COMPOSITE_COMMAND');
throwsCode('nested shell rejected', () => buildApprovedAction({ command: 'sudo sh -c "rm -rf /"' }, context), 'APPROVED_ACTION_NESTED_ESCALATION');
throwsCode('ordinary command rejected', () => buildApprovedAction({ command: 'ls -la' }, context), 'APPROVED_ACTION_NOT_REQUIRED');
check('audit text redacts secrets', redactApprovedActionText('curl --token abc SECRET_KEY=def') === 'curl --token=[redacted] SECRET_KEY=[redacted]');

const authorized = transitionApprovedAction({ ...host, state: APPROVED_ACTION_STATE.WAITING_USER }, APPROVED_ACTION_STATE.AUTHORIZED, { authorization: { method: 'owner' } });
check('authorized transition', authorized.state === APPROVED_ACTION_STATE.AUTHORIZED);
throwsCode('completed cannot replay', () => transitionApprovedAction({ ...host, state: APPROVED_ACTION_STATE.COMPLETED }, APPROVED_ACTION_STATE.EXECUTING), 'APPROVED_ACTION_INVALID_TRANSITION');

const root = mkdtempSync(join(tmpdir(), 'approved-actions-'));
const events = [];
const store = createApprovedActionStore({
  readEvents: async () => events.slice(),
  appendEvent: async (event) => { const stored = { ...event, seq: events.length + 1 }; events.push(stored); return stored; },
});
const first = await store.propose([
  { requestKey: 'req-1', command: 'rm -f /tmp/project/cache.db', description: 'Remove cache' },
], { ...context, requestKey: 'req-1' });
check('proposal is durable', first.batch.actions[0].state === APPROVED_ACTION_STATE.WAITING_USER && events.length === 4);
const duplicate = await store.propose([{ requestKey: 'req-1', command: 'rm -f /tmp/project/other.db' }], { ...context, requestKey: 'req-1' });
check('duplicate request is idempotent', duplicate.duplicate === true);
const actionId = first.batch.actions[0].actionId;
const auth = await store.transition(actionId, APPROVED_ACTION_STATE.AUTHORIZED, { authorization: { method: 'owner' } });
check('authorized state persisted', (await store.get(first.batch.batchId)).actions[0].state === APPROVED_ACTION_STATE.AUTHORIZED && auth.authorization.method === 'owner');
const recovered = createApprovedActionStore({ readEvents: async () => events.slice(), appendEvent: async (event) => event });
check('recovery reconstructs state', (await recovered.get(first.batch.batchId)).actions[0].state === APPROVED_ACTION_STATE.AUTHORIZED);
const sensitiveAuthorization = {
  source: 'owner',
  capabilityRef: 'capref_1234567890abcdef',
  capabilities: [{ grantId: 'cgrant_secret', grantProof: { sig: 'secret-proof' } }],
  factsProofs: { op: { sig: 'secret-facts-proof' } },
  useNonces: { cgrant_secret: 'secret-use-nonce' },
};
await store.transition(actionId, APPROVED_ACTION_STATE.DENIED, { authorization: sensitiveAuthorization });
const safeAuth = (await store.get(first.batch.batchId)).actions[0].authorization;
check('canonical approved-action authorization keeps opaque ref only', safeAuth.capabilityRef === sensitiveAuthorization.capabilityRef
  && safeAuth.capabilities === undefined
  && safeAuth.factsProofs === undefined
  && safeAuth.useNonces === undefined);
check('history event does not contain signed grant material', events.some((event) => event.type === 'approved_action_state'
  && event.authorization?.capabilityRef === sensitiveAuthorization.capabilityRef
  && !JSON.stringify(event).includes('secret-proof')
  && !JSON.stringify(event).includes('secret-facts-proof')
  && !JSON.stringify(event).includes('secret-use-nonce')));
check('test temp root exists', Boolean(root));

// Expiry is durable: an owner response after the window closes must materialize
// EXPIRED in the event log, and restart recovery must preserve that terminal
// state instead of resurrecting WAITING_USER.
const expiredBatch = buildApprovedActionBatch([
  { command: 'rm -f /tmp/project/expired.db', description: 'Expired action' },
], { ...context, requestKey: 'req-expired' });
const expiredAction = {
  ...expiredBatch.actions[0],
  batchId: expiredBatch.batchId,
  expiresAt: new Date(0).toISOString(),
};
expiredAction.manifestHash = computeApprovedActionManifestHash(expiredAction);
const expiredEvents = [{
  type: 'approved_action_batch_request',
  channel: 'approved_action',
  schemaVersion: 1,
  batchId: expiredBatch.batchId,
  requestKey: expiredBatch.requestKey,
  sessionId: expiredBatch.sessionId,
  runId: expiredBatch.runId,
  turnId: expiredBatch.turnId,
  state: APPROVED_ACTION_STATE.WAITING_USER,
  createdAt: expiredBatch.createdAt,
  actions: [{ ...expiredAction, state: APPROVED_ACTION_STATE.WAITING_USER }],
}];
const expiredStore = createApprovedActionStore({
  readEvents: async () => expiredEvents.slice(),
  appendEvent: async (event) => { expiredEvents.push(event); return event; },
});
const expiredResolution = await expiredStore.resolveBatch(expiredBatch.batchId, { [expiredAction.actionId]: 'approve' });
check('expired approval resolves to terminal state', expiredResolution.actions[0].state === APPROVED_ACTION_STATE.EXPIRED);
check('expired state is durable', expiredEvents.some((event) => event.type === 'approved_action_state' && event.state === APPROVED_ACTION_STATE.EXPIRED));
const expiredRecovered = createApprovedActionStore({
  readEvents: async () => expiredEvents.slice(),
  appendEvent: async (event) => event,
});
check('expired state survives recovery', (await expiredRecovered.get(expiredBatch.batchId)).actions[0].state === APPROVED_ACTION_STATE.EXPIRED);

const authorizedExpired = { ...expiredAction, state: APPROVED_ACTION_STATE.AUTHORIZED };
const authorizedExpiredEvents = [{
  ...expiredEvents[0],
  batchId: 'aab-authorized-expired',
  actions: [{ ...authorizedExpired, batchId: 'aab-authorized-expired' }],
}];
const authorizedExpiredStore = createApprovedActionStore({
  readEvents: async () => authorizedExpiredEvents.slice(),
  appendEvent: async (event) => event,
});
await assert.rejects(
  authorizedExpiredStore.transition(expiredAction.actionId, APPROVED_ACTION_STATE.EXECUTING),
  (error) => error?.code === 'APPROVED_ACTION_EXPIRED',
);
passed += 1;

console.log(`approved-actions: ${passed} checks passed`);
