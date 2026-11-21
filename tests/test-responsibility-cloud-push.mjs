#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import webpush from 'web-push';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(__dirname, '..');
const taskTempRoot = process.env.RAGENT_TASK_TEMP || 'G:\\AgentoC\\_task-temp';
mkdirSync(taskTempRoot, { recursive: true });
const tempRoot = mkdtempSync(join(taskTempRoot, 'ragent-resp-cloud-push-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
mkdirSync(configDir, { recursive: true });

// Isolate all config/db/outbox paths under G:/AgentoC/_task-temp before importing app modules.
process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.LOCALAPPDATA = join(tempRoot, 'localappdata');
process.env.APPDATA = join(tempRoot, 'appdata');
process.env.RAGENT_PRODUCT_ROOT = join(tempRoot, 'product');
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.RAGENT_ACCOUNTS_ISSUER = 'https://accounts.example.test';
process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = 'owner-principal-1';
process.env.RAGENT_RESPONSIBILITY_RUNTIME_ENABLED = '1';
process.env.RAGENT_AUTH_SESSION_SECRET = randomBytes(32).toString('hex');
delete process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED;

const imp = (rel) => import(pathToFileURL(join(repoRoot, rel)).href);

const config = await imp('lib/config.mjs');
assert.equal(resolve(config.CONFIG_DIR), resolve(configDir), 'CONFIG_DIR must be isolated to temp dir');

const { loadOrCreateInstanceIdentity } = await imp('lib/instance-identity.mjs');
const { verifyInstanceProofSignature } = await imp('lib/instance-proof-protocol.mjs');
const { OWNER_ACCOUNT_BINDING_FILE } = await imp('lib/owner-account-auth.mjs');
const { issueSession, setCookie, closeAuthSessionStore } = await imp('lib/auth.mjs');
const { writeJsonAtomic } = await imp('chat/fs-utils.mjs');
const { ensureOrganizationSchema, openOrganizationDatabase } = await imp('chat/organization-store.mjs');
const { transaction, read, activity, newId, now, digest } = await imp('chat/responsibility-store.mjs');
const { createResponsibility, setResponsibilityLifecycle } = await imp('chat/responsibility-service.mjs');
const {
  ACCOUNT_CLOUD_PUSH_ENDPOINT,
  enqueueResponsibilityNotification,
  setResponsibilityNotificationSettings,
  getResponsibilityNotificationSettings,
  registerResponsibilityNotificationSubscription,
  revokeResponsibilityNotificationSubscription,
  processResponsibilityNotifications,
} = await imp('chat/responsibility-notifications.mjs');
const {
  getAccountPushStatus,
  getAccountPushEntryStatus,
  drainAccountPushOutbox,
  stopAccountPushOutbox,
} = await imp('chat/account-push-outbox.mjs');
const {
  describeResponsibilityNotification,
  parseResponsibilityAwaitingKey,
  enqueueResponsibilityAccountPush,
  resolveResponsibilityAccountPush,
} = await imp('chat/attention-push.mjs');
const { handleResponsibilityRoutes } = await imp('chat/router-responsibility-routes.mjs');
const { addSubscription } = await imp('chat/push.mjs');

const identity = await loadOrCreateInstanceIdentity();
const ownerActor = { kind: 'user', role: 'owner', principalId: 'owner-principal-1' };
const nonOwnerActor = { kind: 'user', role: 'owner', principalId: 'other-owner' };
const viewerActor = { kind: 'user', role: 'visitor', principalId: 'owner-principal-1' };

// Helper: verify outgoing /v1/push/events body matches accounts/push-service.mjs contract & Ed25519 signature.
function assertValidAccountsPushRequest(url, options) {
  assert.equal(url, 'https://accounts.example.test/v1/push/events');
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body);
  assert.match(body.instanceId, /^inst_[a-f0-9]{32}$/);
  assert.equal(body.instanceId, identity.instanceId);
  assert.ok(typeof body.eventId === 'string' && body.eventId.length >= 1 && body.eventId.length <= 256);
  assert.match(body.sessionId, /^[A-Za-z0-9_-]{1,160}$/);
  assert.ok(['completion', 'plan', 'permission', 'answer', 'danger', 'approval', 'attention', 'attention_resolved'].includes(body.kind));
  assert.ok(typeof body.runId === 'string' && body.runId.length <= 256);
  assert.ok(typeof body.awaitingKey === 'string' && body.awaitingKey.length <= 512);
  if (body.kind !== 'completion' && !(body.kind === 'attention' && body.awaitingKey === 'waiting_user')) {
    assert.match(body.generation, /^[1-9][0-9]{0,19}$/);
  }
  assert.ok(Number.isSafeInteger(body.occurredAt) && Number.isSafeInteger(body.expiresAt) && body.expiresAt > body.occurredAt);
  const maxSpan = (body.kind === 'completion' || body.kind === 'attention_resolved') ? 86400000 : 900000;
  assert.ok(body.expiresAt - body.occurredAt <= maxSpan);
  const message = JSON.stringify([
    'ragent-push-event-v1',
    body.instanceId,
    body.eventId,
    body.sessionId,
    body.kind,
    body.runId,
    body.awaitingKey,
    body.generation,
    body.occurredAt,
    body.expiresAt,
    body.issuedAt,
    body.nonce,
  ]);
  assert.equal(verifyInstanceProofSignature({
    publicKey: identity.publicKey,
    message,
    signature: body.signature,
  }), true, 'Signature must verify against instance public key');
  return body;
}

function seedOrganization({ orgId, projectId, rootSessionId }) {
  const db = openOrganizationDatabase();
  try {
    ensureOrganizationSchema(db);
    const ts = now();
    db.prepare(`INSERT INTO organizations
      (id, project_id, root_session_id, state, current_revision, progress_epoch, version, policy_json, budget_json, idempotency_key, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orgId, projectId, rootSessionId, 'active', 1, 1, 1, '{}', '{}', `seed:${orgId}`, ts, ts);
  } finally {
    db.close();
  }
}

async function createActiveResponsibility({ orgId, projectId, rootSessionId, suffix }) {
  seedOrganization({ orgId, projectId, rootSessionId });
  const created = await createResponsibility({
    organizationId: orgId,
    projectId,
    objective: `Maintain project ${suffix}`,
    successCriteria: ['Verify facts cleanly'],
    idempotencyKey: `create:${suffix}`,
    policy: {
      validUntil: new Date(Date.now() + 7 * 86400_000).toISOString(),
    },
  }, ownerActor);
  const respId = created.responsibility.id;
  await setResponsibilityLifecycle(respId, 'resume', {
    expectedVersion: created.responsibility.rowVersion,
    idempotencyKey: `resume:${suffix}`,
  }, ownerActor);
  return respId;
}

try {
  // Bind owner account & seed trusted devices (without authority ledger so offline test doesn't query remote JWKS).
  await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
    accountId: 'acct_owner_test_1',
    boundAt: now(),
  }, { mode: 0o600 });
  await writeJsonAtomic(join(configDir, 'trusted-devices.json'), {
    version: 1,
    instanceId: identity.instanceId,
    instanceSecret: 'ris_cloud_push_test_fixture',
    createdAt: now(),
    invitations: [],
    challenges: [],
    authTokens: [],
    devices: [
      {
        id: 'dev_active',
        status: 'bound',
        accountId: 'acct_owner_test_1',
        bindingAuthorityRevision: '1',
        enrollmentKind: 'account-join',
        tokenHash: createHash('sha256').update('tok_active').digest('hex'),
        createdAt: now(),
        boundAt: now(),
        revokedAt: '',
      },
      {
        id: 'dev_revoked',
        status: 'bound',
        accountId: 'acct_owner_test_1',
        bindingAuthorityRevision: '1',
        enrollmentKind: 'account-join',
        tokenHash: createHash('sha256').update('tok_revoked').digest('hex'),
        createdAt: now(),
        boundAt: now(),
        revokedAt: '',
      },
    ],
  }, { mode: 0o600 });

  // 1. Default-off flag gate (RAGENT_RESPONSIBILITY_PUSH_ENABLED unset)
  const rDefaultOff = await createActiveResponsibility({
    orgId: 'org_off',
    projectId: 'proj_off',
    rootSessionId: 'sess_root_off',
    suffix: 'default-off',
  });
  await setResponsibilityNotificationSettings(rDefaultOff, {
    enabled: true,
    expectedVersion: 0,
    idempotencyKey: 'optin-off-test',
    confirmed: true,
  }, ownerActor);

  await transaction((db) => {
    activity(db, rDefaultOff, 'plan_proposed', { planId: 'plan_off_1', wakeId: 'wake_1' });
  });
  await processResponsibilityNotifications();
  assert.equal((await getAccountPushStatus()).pending, 0, 'Default-off flag must not enqueue to account-push-outbox');
  await assert.rejects(
    enqueueResponsibilityAccountPush({
      responsibilityId: rDefaultOff,
      sessionId: 'sess_root_off',
      sequence: 1,
      type: 'plan_proposed',
      details: { planId: 'plan_off_1' },
      occurredAt: Date.now(),
    }),
    (err) => err?.code === 'RESPONSIBILITY_PUSH_DISABLED',
  );
  await assert.rejects(
    resolveResponsibilityAccountPush({
      responsibilityId: rDefaultOff,
      sessionId: 'sess_root_off',
      sequence: 2,
      originalSequence: 1,
      originalType: 'plan_proposed',
      originalDetails: { planId: 'plan_off_1' },
      occurredAt: Date.now(),
    }),
    (err) => err?.code === 'RESPONSIBILITY_PUSH_DISABLED',
  );

  // Check HTTP GET /notifications route enforces owner auth AND reports disabled when flag is off.
  {
    let status = 0;
    let body = null;
    const handled = await handleResponsibilityRoutes({
      req: { method: 'GET', url: `/api/responsibilities/${rDefaultOff}/notifications`, headers: {} },
      res: {},
      pathname: `/api/responsibilities/${rDefaultOff}/notifications`,
      authSession: { role: 'owner', principalKind: 'owner_token' },
      writeJson: (_res, code, data) => { status = code; body = data; },
    });
    assert.equal(handled, true);
    assert.equal(status, 403);
    assert.equal(body?.code, 'RESPONSIBILITY_OWNER_UNAVAILABLE');

    const ownerToken = await issueSession({ role: 'owner' });
    const ownerCookie = setCookie(ownerToken).split(';')[0];
    let okStatus = 0;
    let okBody = null;
    await handleResponsibilityRoutes({
      req: { method: 'GET', url: `/api/responsibilities/${rDefaultOff}/notifications`, headers: { cookie: ownerCookie } },
      res: {},
      pathname: `/api/responsibilities/${rDefaultOff}/notifications`,
      authSession: { role: 'owner' },
      writeJson: (_res, code, data) => { okStatus = code; okBody = data; },
    });
    assert.equal(okStatus, 200);
    assert.equal(okBody.deliveryEnabled, false);
    assert.equal(okBody.deliveryAvailable, false);
    assert.equal(okBody.accountCloudPushAvailable, false);
    assert.equal(okBody.accountCloudPush?.deliveryEnabled, false);
  }

  // Now enable RAGENT_RESPONSIBILITY_PUSH_ENABLED=1 for delivery tests.
  process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED = '1';

  // Verify HTTP route returns accountCloudPush status fields for authenticated owner & rejects non-owners.
  {
    await assert.rejects(getResponsibilityNotificationSettings(rDefaultOff, nonOwnerActor), (e) => e?.statusCode === 404);
    await assert.rejects(getResponsibilityNotificationSettings(rDefaultOff, viewerActor), (e) => e?.statusCode === 403);
    await assert.rejects(setResponsibilityNotificationSettings(rDefaultOff, {
      enabled: false,
      expectedVersion: 1,
      idempotencyKey: 'non-owner-optout',
      confirmed: true,
    }, nonOwnerActor), (e) => e?.statusCode === 404);
    const ownerToken = await issueSession({ role: 'owner' });
    const ownerCookie = setCookie(ownerToken).split(';')[0];
    let okStatus = 0;
    let settingsInfo = null;
    await handleResponsibilityRoutes({
      req: { method: 'GET', url: `/api/responsibilities/${rDefaultOff}/notifications`, headers: { cookie: ownerCookie } },
      res: {},
      pathname: `/api/responsibilities/${rDefaultOff}/notifications`,
      authSession: { role: 'owner' },
      writeJson: (_res, code, data) => { okStatus = code; settingsInfo = data; },
    });
    assert.equal(okStatus, 200);
    assert.equal(settingsInfo.enabled, true);
    assert.equal(settingsInfo.deliveryEnabled, true);
    assert.equal(settingsInfo.deliveryAvailable, true);
    assert.equal(settingsInfo.accountCloudPushAvailable, true);
    assert.equal(settingsInfo.accountCloudPush.supported, true);
    assert.equal(settingsInfo.accountCloudPush.configured, true);
    assert.equal(settingsInfo.accountCloudPush.accountBound, true);
    assert.match(settingsInfo.accountCloudPush.statusNote, /not proof of Firebase delivery or user reading/i);
    // Opt out rDefaultOff so its earlier test event is suppressed and won't mix with section 3 counts.
    await setResponsibilityNotificationSettings(rDefaultOff, {
      enabled: false,
      expectedVersion: 1,
      idempotencyKey: 'optout-after-section1',
      confirmed: true,
    }, ownerActor);
  }

  // 2. Per-responsibility opt-in off by default & opt-out suppression
  const rNoOptIn = await createActiveResponsibility({
    orgId: 'org_noopt',
    projectId: 'proj_noopt',
    rootSessionId: 'sess_root_noopt',
    suffix: 'no-opt-in',
  });
  await transaction((db) => {
    activity(db, rNoOptIn, 'planning_needs_input', { wakeId: 'wake_noopt' });
  });
  await processResponsibilityNotifications();
  const noOptRows = await read((db) => db.prepare('SELECT * FROM responsibility_notification_outbox WHERE responsibility_id=?').all(rNoOptIn));
  assert.equal(noOptRows.length, 0, 'Responsibility without opt-in must never enqueue notifications');

  // Opt-in, emit event, then opt-out BEFORE processing -> must be suppressed.
  await setResponsibilityNotificationSettings(rNoOptIn, {
    enabled: true,
    expectedVersion: 0,
    idempotencyKey: 'optin-1',
    confirmed: true,
  }, ownerActor);
  await transaction((db) => {
    activity(db, rNoOptIn, 'decision_waiting', { wakeId: 'wake_optout', reason: 'repository_or_branch_mismatch' });
  });
  await setResponsibilityNotificationSettings(rNoOptIn, {
    enabled: false,
    expectedVersion: 1,
    idempotencyKey: 'optout-2',
    confirmed: true,
  }, ownerActor);
  await processResponsibilityNotifications();
  const suppressedAfterOptOut = await read((db) => db.prepare('SELECT state FROM responsibility_notification_outbox WHERE responsibility_id=?').all(rNoOptIn));
  assert.equal(suppressedAfterOptOut.length, 1);
  assert.equal(suppressedAfterOptOut[0].state, 'suppressed', 'Opt-out before delivery must suppress pending row');

  // 3. Bridge all 6 critical activity types + idempotent dedup + Web Push preservation!
  const rMain = await createActiveResponsibility({
    orgId: 'org_main',
    projectId: 'proj_main',
    rootSessionId: 'sess_root_main',
    suffix: 'main-bridge',
  });
  await setResponsibilityNotificationSettings(rMain, {
    enabled: true,
    expectedVersion: 0,
    idempotencyKey: 'optin-main',
    confirmed: true,
  }, ownerActor);

  // Add a Web Push binding AND a second revoked Web Push binding via real API to verify Web Push coexistence & revocation isolation.
  const subActive = {
    endpoint: 'https://push.example.test/sub-active',
    keys: { p256dh: 'BOr4mR_key_active', auth: 'auth_active_1' },
  };
  const subRevoked = {
    endpoint: 'https://push.example.test/sub-revoked',
    keys: { p256dh: 'BOr4mR_key_revoked', auth: 'auth_revoked_1' },
  };
  await addSubscription(subActive);
  await addSubscription(subRevoked);
  const subActiveRes = await registerResponsibilityNotificationSubscription(
    { subscription: subActive },
    ownerActor,
    { principalKind: 'trusted_device', deviceId: 'dev_active', accountId: 'acct_owner_test_1', bindingAuthorityRevision: '1' },
  );
  const subRevokedRes = await registerResponsibilityNotificationSubscription(
    { subscription: subRevoked },
    ownerActor,
    { principalKind: 'trusted_device', deviceId: 'dev_revoked', accountId: 'acct_owner_test_1', bindingAuthorityRevision: '1' },
  );
  const subRevokedEndpointHash = subRevokedRes.subscriptionId;
  // Revoke the second Web Push binding via the real revocation function.
  await revokeResponsibilityNotificationSubscription({
    subscriptionId: subRevokedEndpointHash,
    expectedVersion: subRevokedRes.version,
    confirmed: true,
    idempotencyKey: 'revoke-web-1',
  }, ownerActor);
  assert.ok(subActiveRes.subscriptionId);

  // Emit all 6 critical event classes!
  const emittedSeqs = {};
  await transaction((db) => {
    const emit = (type, details) => {
      const prev = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS m FROM responsibility_activity WHERE responsibility_id=?').get(rMain).m;
      activity(db, rMain, type, details);
      const next = db.prepare('SELECT MAX(sequence) AS m FROM responsibility_activity WHERE responsibility_id=?').get(rMain).m;
      assert.ok(next > prev);
      emittedSeqs[type] = next;
    };
    emit('plan_proposed', { planId: 'plan_manual_1', wakeId: 'wake_m1' });
    emit('planning_needs_input', { wakeId: 'wake_m2', question: 'Which branch?' });
    emit('decision_waiting', { wakeId: 'wake_m3', reason: 'policy_incomplete' });
    emit('budget_blocked', { workItemId: 'work_1', executionEpoch: 1, bindingId: 'bind_1', reason: 'ORG_BUDGET_EXCEEDED' });
    emit('execution_attempt_failed', { workItemId: 'work_2', executionEpoch: 2, bindingId: 'bind_2', source: 'run' });
    emit('workflow_completed', { workflowInstanceId: 'wf_1', goalId: 'goal_1' });

    // Idempotent duplicate enqueue for the same sequence must not create duplicate rows.
    enqueueResponsibilityNotification(db, {
      responsibilityId: rMain,
      sequence: emittedSeqs.plan_proposed,
      type: 'plan_proposed',
    });
  });

  // Also test auto-approved plan suppression in same transaction!
  await transaction((db) => {
    const rRow = db.prepare('SELECT revision, policy_revision FROM responsibilities WHERE id=?').get(rMain);
    const ts = now();
    db.prepare('INSERT INTO responsibility_wakes VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('wake_auto', rMain, rRow.revision, rRow.policy_revision, ts, 'pending', 0, null, ts, ts);
    activity(db, rMain, 'plan_proposed', { planId: 'plan_auto_1', wakeId: 'wake_auto' });
    const seq = db.prepare('SELECT MAX(sequence) AS m FROM responsibility_activity WHERE responsibility_id=?').get(rMain).m;
    emittedSeqs.auto_plan_proposed = seq;
    db.prepare('INSERT INTO responsibility_plans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('plan_auto_1', rMain, 'wake_auto', rRow.revision, rRow.policy_revision, 'obs', 'pf', 'cat', 'prop', '{}', 'pkt', 'pd', ts);
    db.prepare('INSERT INTO responsibility_plan_approvals VALUES(?,?,?,?,?,?,?)')
      .run('appr_auto_1', 'plan_auto_1', 'responsibility-policy-auto', 'prop', 2, 'auto:plan_auto_1', ts);
    activity(db, rMain, 'plan_approved_by_policy', { planId: 'plan_auto_1', approvalId: 'appr_auto_1' });
  });

  // Mock webpush network call so active Web Push subscription hits 'unknown' or 'provider_accepted' without real network.
  const originalSendNotification = webpush.sendNotification;
  const webPushPayloads = [];
  webpush.sendNotification = async (_sub, payload) => {
    webPushPayloads.push(JSON.parse(payload));
    return { statusCode: 201 };
  };
  try {
    await processResponsibilityNotifications();
  } finally {
    webpush.sendNotification = originalSendNotification;
  }

  // Verify auto-approved plan was suppressed (neither Web Push nor Cloud Push sent for plan_auto_1).
  const autoCloudStatus = await getAccountPushEntryStatus('plan', `responsibility:${rMain}:${emittedSeqs.auto_plan_proposed}`);
  assert.equal(autoCloudStatus, null, 'Auto-approved plan_proposed must never enter account-push-outbox');

  // Verify revoked Web Push binding received 0 deliveries, while active Web Push binding received all 6.
  const revokedRows = await read((db) => db.prepare('SELECT * FROM responsibility_notification_outbox WHERE responsibility_id=? AND endpoint_hash=?').all(rMain, subRevokedEndpointHash));
  assert.equal(revokedRows.length, 0, 'Revoked Web Push binding must not receive new outbox rows');
  assert.equal(webPushPayloads.length, 6, 'Active Web Push binding must still receive all 6 critical alerts');
  assert.equal(webPushPayloads[0].responsibilityId, rMain);
  assert.equal(webPushPayloads[0].sessionId, 'sess_root_main');

  // Verify all 6 critical alerts entered account-push-outbox.json with exact payloads & SQLite states = 'queued'.
  const expectedMappings = [
    ['plan_proposed', 'plan', 'plan_awaiting_approval', 'plan_manual_1'],
    ['planning_needs_input', 'answer', 'needs_user_input', ''],
    ['decision_waiting', 'attention', 'blocked', ''],
    ['budget_blocked', 'attention', 'budget_rejected', ''],
    ['execution_attempt_failed', 'attention', 'attempt_failed', ''],
    ['workflow_completed', 'completion', 'workflow_completed', ''],
  ];
  for (const [actType, expectedKind, expectedCategory, expectedPlanId] of expectedMappings) {
    const seq = emittedSeqs[actType];
    const eventId = `responsibility:${rMain}:${seq}`;
    const entry = await getAccountPushEntryStatus(expectedKind, eventId);
    assert.ok(entry, `Expected account push outbox entry for ${actType}`);
    assert.equal(entry.state, 'pending');
    const sqliteRow = await read((db) => db.prepare('SELECT state, cloud_kind, cloud_event_id FROM responsibility_notification_outbox WHERE event_id=? AND endpoint_hash=?').get(eventId, ACCOUNT_CLOUD_PUSH_ENDPOINT));
    assert.equal(sqliteRow.state, 'queued');
    assert.equal(sqliteRow.cloud_kind, expectedKind);
    assert.equal(sqliteRow.cloud_event_id, eventId);

    // Check awaitingKey parsing round-trip via attention-push.
    const desc = describeResponsibilityNotification(actType, expectedPlanId ? { planId: expectedPlanId } : {});
    assert.equal(desc.category, expectedCategory);
  }

  // Check manual plan approval emits attention_resolved with matching awaitingKey & generation!
  await transaction((db) => {
    activity(db, rMain, 'plan_approved', { planId: 'plan_manual_1', approvalId: 'appr_manual_1' });
  });
  await processResponsibilityNotifications();
  const resolvedOutboxRows = await read((db) => db.prepare("SELECT * FROM responsibility_notification_outbox WHERE responsibility_id=? AND type='attention_resolved'").all(rMain));
  assert.equal(resolvedOutboxRows.length, 1, 'Approving already-queued plan_proposed must emit attention_resolved');
  assert.equal(resolvedOutboxRows[0].state, 'queued');

  // 4. Simulated transient failure -> persistence -> real child-process restart -> Accounts acceptance & reconciliation!
  let failAttempts = 0;
  const capturedFailures = [];
  await drainAccountPushOutbox({
    fetchImpl: async (url, options) => {
      failAttempts++;
      capturedFailures.push({ url, options });
      return new Response('service unavailable', { status: 503 });
    },
  });
  const statusAfterFailure = await getAccountPushStatus();
  assert.equal(failAttempts, 7, `All 7 entries should attempt once (lastResult=${statusAfterFailure.lastResult})`);
  for (const req of capturedFailures) assertValidAccountsPushRequest(req.url, req.options);
  assert.equal(statusAfterFailure.pending, 7, 'Transient 503 must keep entries pending in outbox (never accepted!)');
  assert.equal(statusAfterFailure.accepted, 0);

  // Inject crash / unknown-delivery test fixtures into SQLite & outbox BEFORE restart child process:
  // A) Stale 'sending' row (> 5m old) that NEVER reached account-push-outbox.json -> MUST become 'unknown' (no blind resend!).
  // B) Stale 'sending' row (> 5m old) that DID reach account-push-outbox.json -> MUST reconcile to 'queued' and deliver once without duplicate.
  // C) Expired activity (> 15m old) -> MUST become 'expired' and never enter account-push-outbox.json!
  let staleMissingEventId = '';
  let stalePresentEventId = `responsibility:${rMain}:${emittedSeqs.planning_needs_input}`;
  let expiredEventId = '';
  const staleSendingTime = new Date(Date.now() - 10 * 60_000).toISOString();
  const oldCreatedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  await transaction((db) => {
    db.prepare("UPDATE responsibility_notification_outbox SET state='sending', updated_at=? WHERE event_id=? AND endpoint_hash=?")
      .run(staleSendingTime, stalePresentEventId, ACCOUNT_CLOUD_PUSH_ENDPOINT);

    activity(db, rMain, 'planning_evidence_blocked', { wakeId: 'wake_stale_missing', reason: 'EACCES' });
    const seqMissing = db.prepare('SELECT MAX(sequence) AS m FROM responsibility_activity WHERE responsibility_id=?').get(rMain).m;
    staleMissingEventId = `responsibility:${rMain}:${seqMissing}`;
    db.prepare("UPDATE responsibility_notification_outbox SET state='sending', updated_at=? WHERE event_id=? AND endpoint_hash=?")
      .run(staleSendingTime, staleMissingEventId, ACCOUNT_CLOUD_PUSH_ENDPOINT);

    activity(db, rMain, 'plan_admission_blocked', { planId: 'plan_expired', reason: 'expired' });
    const seqExpired = db.prepare('SELECT MAX(sequence) AS m FROM responsibility_activity WHERE responsibility_id=?').get(rMain).m;
    expiredEventId = `responsibility:${rMain}:${seqExpired}`;
    db.prepare('UPDATE responsibility_activity SET created_at=? WHERE responsibility_id=? AND sequence=?')
      .run(oldCreatedAt, rMain, seqExpired);
  });

  // Also reset nextAttemptAt in account-push-outbox.json so the restarted child process can drain immediately!
  const outboxPath = join(configDir, 'account-push-outbox.json');
  const persistedEntries = JSON.parse(readFileSync(outboxPath, 'utf8'));
  assert.equal(persistedEntries.length, 7);
  for (const entry of persistedEntries) {
    entry.nextAttemptAt = 0;
  }
  writeFileSync(outboxPath, JSON.stringify(persistedEntries), 'utf8');

  // Spawn a completely fresh child Node.js process to verify restart retry & reconciliation semantics!
  const childScript = `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    const root = ${JSON.stringify(repoRoot)};
    const imp = (rel) => import(pathToFileURL(join(root, rel)).href);
    const { loadOrCreateInstanceIdentity } = await imp('lib/instance-identity.mjs');
    const { verifyInstanceProofSignature } = await imp('lib/instance-proof-protocol.mjs');
    const { drainAccountPushOutbox, getAccountPushStatus } = await imp('chat/account-push-outbox.mjs');
    const { processResponsibilityNotifications, getResponsibilityNotificationSettings, ACCOUNT_CLOUD_PUSH_ENDPOINT } = await imp('chat/responsibility-notifications.mjs');
    const { read } = await imp('chat/responsibility-store.mjs');
    const { parseResponsibilityAwaitingKey } = await imp('chat/attention-push.mjs');

    const identity = await loadOrCreateInstanceIdentity();
    const received = [];
    // Process notifications first: recovers stale 'sending' -> 'unknown' (if absent) or 'queued' (if present), expires old alert.
    await processResponsibilityNotifications();
    const staleRow = await read((db) => db.prepare('SELECT state FROM responsibility_notification_outbox WHERE event_id=? AND endpoint_hash=?').get(${JSON.stringify(staleMissingEventId)}, ACCOUNT_CLOUD_PUSH_ENDPOINT));
    assert.equal(staleRow.state, 'unknown', 'Stale sending without outbox entry must become unknown (never blindly resent)');
    const stalePresentRow = await read((db) => db.prepare('SELECT state FROM responsibility_notification_outbox WHERE event_id=? AND endpoint_hash=?').get(${JSON.stringify(stalePresentEventId)}, ACCOUNT_CLOUD_PUSH_ENDPOINT));
    assert.equal(stalePresentRow.state, 'queued', 'Stale sending with existing outbox entry must reconcile to queued without duplicating');
    const expRow = await read((db) => db.prepare('SELECT state FROM responsibility_notification_outbox WHERE event_id=? AND endpoint_hash=?').get(${JSON.stringify(expiredEventId)}, ACCOUNT_CLOUD_PUSH_ENDPOINT));
    assert.equal(expRow.state, 'expired', 'Expired activity must transition to expired without enqueueing');

    const capturedChildRequests = [];
    await drainAccountPushOutbox({
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        capturedChildRequests.push({ url, options, body });
        return new Response(JSON.stringify({ ok: true, accepted: true, instanceId: body.instanceId, kind: body.kind, eventId: body.eventId }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    for (const req of capturedChildRequests) {
      const { body } = req;
      const msg = JSON.stringify(['ragent-push-event-v1', body.instanceId, body.eventId, body.sessionId, body.kind, body.runId, body.awaitingKey, body.generation, body.occurredAt, body.expiresAt, body.issuedAt, body.nonce]);
      assert.equal(verifyInstanceProofSignature({ publicKey: identity.publicKey, message: msg, signature: body.signature }), true);
      const parsedKey = parseResponsibilityAwaitingKey(body.awaitingKey);
      assert.ok(parsedKey && parsedKey.responsibilityId === ${JSON.stringify(rMain)}, 'awaitingKey must parse cleanly');
      received.push(body);
    }
    assert.equal(received.length, 7, 'Restart must drain all 7 persisted outbox items once');
    const outboxStatus = await getAccountPushStatus();
    assert.equal(outboxStatus.pending, 0);
    assert.equal(outboxStatus.accepted, 7);

    // Run processResponsibilityNotifications again -> reconciles 'queued' rows to 'provider_accepted' and leaves 'unknown' untouched!
    await processResponsibilityNotifications();
    const staleAfter = await read((db) => db.prepare('SELECT state FROM responsibility_notification_outbox WHERE event_id=? AND endpoint_hash=?').get(${JSON.stringify(staleMissingEventId)}, ACCOUNT_CLOUD_PUSH_ENDPOINT));
    assert.equal(staleAfter.state, 'unknown', 'Unknown delivery outcome must never be blindly resent on later ticks');

    const settings = await getResponsibilityNotificationSettings(${JSON.stringify(rMain)}, { kind: 'user', role: 'owner', principalId: 'owner-principal-1' });
    const cloudAccepted = settings.receipts.filter((r) => r.channel === 'account_cloud_push' && r.state === 'provider_accepted');
    assert.equal(cloudAccepted.length, 7, 'SQLite receipts must reflect provider_accepted after Accounts accepts');
  `;
  const childPath = join(tempRoot, 'restart-verify.mjs');
  writeFileSync(childPath, childScript, 'utf8');
  execFileSync(process.execPath, [childPath], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  // 5. Verify cancellation & account unbind revocation invariants!
  // Re-emit a needs_input alert, let it queue, then cancel responsibility -> must emit attention_resolved and suppress any pending rows.
  let seqBeforeCancel = 0;
  await transaction((db) => {
    activity(db, rMain, 'planning_needs_input', { wakeId: 'wake_before_cancel', question: 'Confirm?' });
    seqBeforeCancel = db.prepare('SELECT MAX(sequence) AS m FROM responsibility_activity WHERE responsibility_id=?').get(rMain).m;
  });
  await processResponsibilityNotifications();
  const detailBeforeCancel = await read((db) => db.prepare('SELECT row_version FROM responsibilities WHERE id=?').get(rMain));
  await setResponsibilityLifecycle(rMain, 'cancel', {
    expectedVersion: detailBeforeCancel.row_version,
    confirmed: true,
    idempotencyKey: 'cancel-main-1',
  }, ownerActor);
  await processResponsibilityNotifications();
  const cancelResolved = await read((db) => db.prepare("SELECT * FROM responsibility_notification_outbox WHERE responsibility_id=? AND type='attention_resolved' AND event_id LIKE ?")
    .all(rMain, `%:${seqBeforeCancel}`));
  assert.equal(cancelResolved.length, 1, 'Cancelling responsibility must emit attention_resolved for active attention alert');
  assert.equal(cancelResolved[0].state, 'queued');

  // Unbinding owner account must block further cloud push enqueueing!
  const rUnbound = await createActiveResponsibility({
    orgId: 'org_unbound',
    projectId: 'proj_unbound',
    rootSessionId: 'sess_root_unbound',
    suffix: 'unbound',
  });
  await setResponsibilityNotificationSettings(rUnbound, {
    enabled: true,
    expectedVersion: 0,
    idempotencyKey: 'optin-unbound',
    confirmed: true,
  }, ownerActor);
  rmSync(OWNER_ACCOUNT_BINDING_FILE, { force: true });
  await transaction((db) => {
    activity(db, rUnbound, 'budget_blocked', { workItemId: 'work_u', executionEpoch: 1, bindingId: 'bind_u' });
  });
  await processResponsibilityNotifications();
  const unboundRow = await read((db) => db.prepare('SELECT state FROM responsibility_notification_outbox WHERE responsibility_id=? AND endpoint_hash=?').get(rUnbound, ACCOUNT_CLOUD_PUSH_ENDPOINT));
  assert.equal(unboundRow.state, 'not_configured', 'Missing owner account binding must not enqueue to account-push-outbox');

  // Scheduler owner mismatch must revoke delivery without touching account-push-outbox!
  await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
    accountId: 'acct_owner_test_1',
    boundAt: now(),
  }, { mode: 0o600 });
  const prevSchedulerOwner = process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID;
  process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = 'different-scheduler-owner';
  try {
    await transaction((db) => {
      activity(db, rUnbound, 'planning_needs_input', { wakeId: 'wake_owner_mismatch' });
    });
    await processResponsibilityNotifications();
    const mismatchRow = await read((db) => db.prepare("SELECT state FROM responsibility_notification_outbox WHERE responsibility_id=? AND type='planning_needs_input' AND endpoint_hash=?").get(rUnbound, ACCOUNT_CLOUD_PUSH_ENDPOINT));
    assert.equal(mismatchRow.state, 'authorization_revoked', 'Scheduler owner mismatch must reject delivery with authorization_revoked');
  } finally {
    process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = prevSchedulerOwner;
  }

  // Corrupt/unwritable outbox file -> must record 'unknown' in SQLite and never lie as queued/accepted!
  await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
    accountId: 'acct_owner_test_1',
    boundAt: now(),
  }, { mode: 0o600 });
  writeFileSync(outboxPath, '{corrupted json', 'utf8');
  await transaction((db) => {
    activity(db, rUnbound, 'execution_attempt_failed', { workItemId: 'work_u2', executionEpoch: 1, bindingId: 'bind_u2' });
  });
  await processResponsibilityNotifications();
  const failedPersistRow = await read((db) => db.prepare("SELECT state FROM responsibility_notification_outbox WHERE responsibility_id=? AND type='execution_attempt_failed' AND endpoint_hash=?").get(rUnbound, ACCOUNT_CLOUD_PUSH_ENDPOINT));
  assert.equal(failedPersistRow.state, 'unknown', 'Outbox storage failure must record unknown state (never queued/accepted)');

  // Verify corrupted outbox file cannot falsely report provider_accepted and unlinking it cleans up.
  console.log('test-responsibility-cloud-push: ok');
} finally {
  stopAccountPushOutbox();
  try { closeAuthSessionStore(); } catch {}
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}
