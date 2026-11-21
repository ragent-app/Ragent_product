import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { ACCOUNTS_URL } from '../lib/config.mjs';
import { loadInstanceIdentity } from '../lib/instance-identity.mjs';
import { getTrustedDeviceStatus } from './trusted-devices.mjs';
import { authorizeDeviceBinding, OWNER_ACCOUNT_AUTHORITY_FILE } from '../lib/binding-authority-runtime.mjs';
import { getOwnerAccountBinding } from '../lib/owner-account-auth.mjs';
import { hasResponsibilityWebSubscription, responsibilitySubscriptionCredentialHash, sendResponsibilityWebPush } from './push.mjs';
import { getAccountPushStatus, getAccountPushEntriesStatus } from './account-push-outbox.mjs';
import {
  describeResponsibilityNotification,
  buildResponsibilityCloudPushEvent,
  enqueueResponsibilityAccountPush,
  resolveResponsibilityAccountPush,
} from './attention-push.mjs';

export const ACCOUNT_CLOUD_PUSH_ENDPOINT = 'account_cloud_push';
const STALE_SENDING_MS = 300_000;
const PROCESS_BATCH_LIMIT = 50;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const RESOLUTION_TYPES = new Set(['plan_approved', 'plan_approved_by_policy', 'cancel', 'archive']);

const schema = `
CREATE TABLE IF NOT EXISTS responsibility_notification_settings (responsibility_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_notification_bindings (endpoint_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, device_id TEXT NOT NULL, account_id TEXT NOT NULL, authority_revision TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_notification_outbox (event_id TEXT NOT NULL, responsibility_id TEXT NOT NULL, owner_id TEXT NOT NULL, endpoint_hash TEXT NOT NULL, settings_version INTEGER NOT NULL, binding_version INTEGER NOT NULL, type TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(event_id,owner_id,endpoint_hash));`;

function ensureSchema(db) {
  db.exec(schema);
  if (!db.prepare('PRAGMA table_info(responsibility_notification_bindings)').all().some(c => c.name === 'credential_hash')) {
    db.exec('ALTER TABLE responsibility_notification_bindings ADD COLUMN credential_hash TEXT');
  }
  const outboxCols = db.prepare('PRAGMA table_info(responsibility_notification_outbox)').all();
  if (!outboxCols.some(c => c.name === 'cloud_kind')) {
    db.exec('ALTER TABLE responsibility_notification_outbox ADD COLUMN cloud_kind TEXT');
  }
  if (!outboxCols.some(c => c.name === 'cloud_event_id')) {
    db.exec('ALTER TABLE responsibility_notification_outbox ADD COLUMN cloud_event_id TEXT');
  }
}

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, code: 'RESPONSIBILITY_NOTIFICATION_CONFLICT' });
const stamp = () => new Date().toISOString();
const owner = actor => { if (actor?.kind !== 'user' || actor?.role !== 'owner' || !actor.principalId) throw fail('Owner required', 403); return actor.principalId; };

function parseDetails(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseAlertSequence(eventId) {
  if (typeof eventId !== 'string' || !eventId.startsWith('responsibility:')) return null;
  const seq = Number(eventId.slice(eventId.lastIndexOf(':') + 1));
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function parseResolutionSequences(eventId) {
  if (typeof eventId !== 'string' || !eventId.startsWith('responsibility-resolved:')) return null;
  const lastColon = eventId.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const prevColon = eventId.lastIndexOf(':', lastColon - 1);
  if (prevColon <= 0) return null;
  const sequence = Number(eventId.slice(prevColon + 1, lastColon));
  const originalSequence = Number(eventId.slice(lastColon + 1));
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isSafeInteger(originalSequence) || originalSequence <= 0) {
    return null;
  }
  return { sequence, originalSequence };
}

function computeCloudEventId(prefix, raw) {
  if (Buffer.byteLength(raw, 'utf8') <= 256 && !/[\u0000-\u001f]/.test(raw)) return raw;
  return `${prefix}-${createHash('sha256').update(raw).digest('hex')}`;
}

function mapOutboxState(entry) {
  if (!entry) return null;
  if (entry.state === 'accepted') return 'provider_accepted';
  if (entry.state === 'rejected') return entry.lastResult === 'expired' ? 'expired' : 'provider_rejected';
  if (entry.state === 'pending') return 'queued';
  return null;
}

function enqueueResolutionNotifications(db, { responsibilityId, ownerId, sequence, type, settingsVersion }) {
  const ts = stamp();
  if (type === 'plan_approved' || type === 'plan_approved_by_policy') {
    const act = db.prepare('SELECT details_json FROM responsibility_activity WHERE responsibility_id=? AND sequence=?').get(responsibilityId, sequence);
    const targetPlanId = parseDetails(act?.details_json).planId;
    const planRows = db.prepare(`SELECT * FROM responsibility_notification_outbox
      WHERE responsibility_id=? AND owner_id=? AND type IN ('plan_proposed','plan_awaiting_approval')
      AND state IN ('pending','sending','queued','provider_accepted')`).all(responsibilityId, ownerId);
    for (const row of planRows) {
      const origSeq = parseAlertSequence(row.event_id);
      if (!origSeq) continue;
      const origAct = db.prepare('SELECT details_json FROM responsibility_activity WHERE responsibility_id=? AND sequence=?').get(responsibilityId, origSeq);
      const origPlanId = parseDetails(origAct?.details_json).planId;
      if (targetPlanId && origPlanId && origPlanId !== targetPlanId) continue;
      if (row.state === 'pending') {
        db.prepare("UPDATE responsibility_notification_outbox SET state='suppressed',updated_at=? WHERE event_id=? AND owner_id=? AND endpoint_hash=? AND state='pending'")
          .run(ts, row.event_id, row.owner_id, row.endpoint_hash);
      } else if (row.endpoint_hash === ACCOUNT_CLOUD_PUSH_ENDPOINT) {
        const resolvedId = `responsibility-resolved:${responsibilityId}:${sequence}:${origSeq}`;
        const cloudId = computeCloudEventId('responsibility-resolved', resolvedId);
        db.prepare(`INSERT OR IGNORE INTO responsibility_notification_outbox
          (event_id,responsibility_id,owner_id,endpoint_hash,settings_version,binding_version,type,state,updated_at,cloud_kind,cloud_event_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(resolvedId, responsibilityId, ownerId, ACCOUNT_CLOUD_PUSH_ENDPOINT, settingsVersion || row.settings_version, 0, 'attention_resolved', 'pending', ts, 'attention_resolved', cloudId);
      }
    }
    return;
  }
  if (type === 'cancel' || type === 'archive') {
    db.prepare(`UPDATE responsibility_notification_outbox SET state='suppressed',updated_at=?
      WHERE responsibility_id=? AND owner_id=? AND state='pending' AND type<>'attention_resolved'`)
      .run(ts, responsibilityId, ownerId);
    const activeCloud = db.prepare(`SELECT * FROM responsibility_notification_outbox
      WHERE responsibility_id=? AND owner_id=? AND endpoint_hash=? AND type<>'attention_resolved'
      AND state IN ('sending','queued','provider_accepted')`).all(responsibilityId, ownerId, ACCOUNT_CLOUD_PUSH_ENDPOINT);
    for (const row of activeCloud) {
      const desc = describeResponsibilityNotification(row.type);
      if (!desc || desc.kind === 'completion') continue;
      const origSeq = parseAlertSequence(row.event_id);
      if (!origSeq) continue;
      const resolvedId = `responsibility-resolved:${responsibilityId}:${sequence}:${origSeq}`;
      const cloudId = computeCloudEventId('responsibility-resolved', resolvedId);
      db.prepare(`INSERT OR IGNORE INTO responsibility_notification_outbox
        (event_id,responsibility_id,owner_id,endpoint_hash,settings_version,binding_version,type,state,updated_at,cloud_kind,cloud_event_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(resolvedId, responsibilityId, ownerId, ACCOUNT_CLOUD_PUSH_ENDPOINT, settingsVersion || row.settings_version, 0, 'attention_resolved', 'pending', ts, 'attention_resolved', cloudId);
    }
  }
}

// Called inside the responsibility activity transaction, never sends network I/O.
export function enqueueResponsibilityNotification(db, { responsibilityId, sequence, type }) {
  ensureSchema(db);
  const r = db.prepare('SELECT r.owner_principal_id, r.lifecycle FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=?').get(responsibilityId);
  if (!r) return;
  const settings = db.prepare('SELECT * FROM responsibility_notification_settings WHERE responsibility_id=? AND owner_id=? AND enabled=1').get(responsibilityId, r.owner_principal_id);
  if (RESOLUTION_TYPES.has(type)) {
    enqueueResolutionNotifications(db, { responsibilityId, ownerId: r.owner_principal_id, sequence, type, settingsVersion: settings?.version || 0 });
    return;
  }
  const descriptor = describeResponsibilityNotification(type);
  if (!descriptor) return;
  if (['cancelled', 'archived'].includes(r.lifecycle)) return;
  if (!settings) return;
  const ts = stamp();
  const eventId = `responsibility:${responsibilityId}:${sequence}`;
  const bindings = db.prepare('SELECT * FROM responsibility_notification_bindings WHERE owner_id=? AND enabled=1').all(r.owner_principal_id);
  const insert = db.prepare(`INSERT OR IGNORE INTO responsibility_notification_outbox
    (event_id,responsibility_id,owner_id,endpoint_hash,settings_version,binding_version,type,state,updated_at,cloud_kind,cloud_event_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for (const binding of bindings) {
    insert.run(eventId, responsibilityId, r.owner_principal_id, binding.endpoint_hash, settings.version, binding.version, type, 'pending', ts, null, null);
  }
  const cloudEventId = computeCloudEventId('responsibility', eventId);
  insert.run(eventId, responsibilityId, r.owner_principal_id, ACCOUNT_CLOUD_PUSH_ENDPOINT, settings.version, 0, type, 'pending', ts, descriptor.kind, cloudEventId);
}

async function verifiedDevice(session) {
  if (session?.principalKind !== 'trusted_device' || !session.deviceId || !session.accountId || !session.bindingAuthorityRevision || session.workspaceAccess) throw fail('Authenticated owner device required', 403);
  const device = await getTrustedDeviceStatus(session.deviceId);
  if (!device || device.status !== 'bound' || device.revokedAt || device.accountId !== session.accountId || device.bindingAuthorityRevision !== session.bindingAuthorityRevision) throw fail('Device binding unavailable', 403);
  const account = await getOwnerAccountBinding(); if (!account?.accountId || account.accountId !== device.accountId) throw fail('Owner account binding changed', 403);
  await authorizeDeviceBinding(device, { credential: true, tokenRevision: session.bindingAuthorityRevision });
  return device;
}

export async function registerResponsibilityNotificationSubscription(input, actor, session) {
  const principal = owner(actor), device = await verifiedDevice(session);
  const subscription = input?.subscription, endpoint = subscription?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 4096 || !endpoint.startsWith('https://')) throw fail('Valid existing subscription required', 400);
  const endpointHash = createHash('sha256').update(endpoint).digest('hex');
  if (!await hasResponsibilityWebSubscription(subscription)) throw fail('Subscription is not registered', 404);
  const credentialHash = responsibilitySubscriptionCredentialHash(subscription); if (!credentialHash) throw fail('Subscription credentials unavailable', 400);
  const { transaction } = await import('./responsibility-store.mjs');
  return transaction(db => {
    ensureSchema(db);
    const prior = db.prepare('SELECT * FROM responsibility_notification_bindings WHERE endpoint_hash=?').get(endpointHash);
    if (prior && (prior.owner_id !== principal || prior.device_id !== device.id)) throw fail('Subscription is already bound');
    const version = (prior?.version || 0) + 1;
    db.prepare('INSERT INTO responsibility_notification_bindings(endpoint_hash,owner_id,device_id,account_id,authority_revision,enabled,version,credential_hash) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET account_id=excluded.account_id,authority_revision=excluded.authority_revision,enabled=1,version=excluded.version,credential_hash=excluded.credential_hash').run(endpointHash, principal, device.id, device.accountId, device.bindingAuthorityRevision, version, credentialHash);
    return { schemaVersion: 1, subscriptionId: endpointHash, version };
  });
}

export async function setResponsibilityNotificationSettings(id, input, actor) {
  const principal = owner(actor);
  if (typeof input?.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.confirmed !== true) throw fail('Confirmation, version and idempotency key required', 400);
  const { transaction, receipt } = await import('./responsibility-store.mjs');
  return transaction(db => {
    ensureSchema(db);
    return receipt(db, principal, 'notification_settings', id, input.idempotencyKey, input, () => {
      const r = db.prepare('SELECT r.owner_principal_id FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=?').get(id);
      if (!r || r.owner_principal_id !== principal) throw fail('Responsibility unavailable', 404);
      const old = db.prepare('SELECT * FROM responsibility_notification_settings WHERE responsibility_id=?').get(id);
      if ((old?.version || 0) !== input.expectedVersion) throw fail('Notification settings changed');
      const version = input.expectedVersion + 1;
      db.prepare('INSERT INTO responsibility_notification_settings VALUES(?,?,?,?) ON CONFLICT(responsibility_id) DO UPDATE SET enabled=excluded.enabled,version=excluded.version').run(id, principal, input.enabled ? 1 : 0, version);
      return { schemaVersion: 1, enabled: input.enabled, version };
    });
  });
}

export async function getResponsibilityNotificationSettings(id, actor) {
  const principal = owner(actor);
  const { read } = await import('./responsibility-store.mjs');
  const snapshot = await read(db => {
    ensureSchema(db);
    const r = db.prepare('SELECT r.owner_principal_id FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=?').get(id);
    if (!r || r.owner_principal_id !== principal) throw fail('Responsibility unavailable', 404);
    const s = db.prepare('SELECT * FROM responsibility_notification_settings WHERE responsibility_id=?').get(id);
    const bindings = db.prepare('SELECT endpoint_hash AS subscriptionId,device_id AS deviceId,version FROM responsibility_notification_bindings WHERE owner_id=? AND enabled=1').all(principal);
    const rawReceipts = db.prepare('SELECT event_id,endpoint_hash,type,state,updated_at,cloud_kind,cloud_event_id FROM responsibility_notification_outbox WHERE responsibility_id=? AND owner_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 20').all(id, principal);
    return { s, bindings, rawReceipts };
  });
  const cloudPairs = snapshot.rawReceipts
    .filter(row => row.endpoint_hash === ACCOUNT_CLOUD_PUSH_ENDPOINT && row.cloud_kind && row.cloud_event_id)
    .map(row => ({ kind: row.cloud_kind, eventId: row.cloud_event_id }));
  const [account, identity, outboxStatus, cloudStates] = await Promise.all([
    getOwnerAccountBinding().catch(() => null),
    loadInstanceIdentity().catch(() => null),
    getAccountPushStatus().catch(() => null),
    getAccountPushEntriesStatus(cloudPairs).catch(() => new Map()),
  ]);
  const receipts = snapshot.rawReceipts.map(row => {
    let state = row.state;
    if (row.endpoint_hash === ACCOUNT_CLOUD_PUSH_ENDPOINT && row.cloud_kind && row.cloud_event_id && ['queued', 'sending'].includes(state)) {
      const entry = cloudStates.get(`${row.cloud_kind}\0${row.cloud_event_id}`);
      const mapped = mapOutboxState(entry);
      if (mapped && (state === 'queued' || mapped !== 'queued')) state = mapped;
    }
    return {
      eventId: row.event_id,
      type: row.type,
      state,
      updatedAt: row.updated_at,
      channel: row.endpoint_hash === ACCOUNT_CLOUD_PUSH_ENDPOINT ? 'account_cloud_push' : 'web_push',
    };
  });
  const deliveryEnabled = process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED === '1';
  const accountBound = Boolean(account?.accountId);
  const accountsConfigured = Boolean(ACCOUNTS_URL);
  const instanceReady = Boolean(identity?.instanceId);
  const accountCloudPush = {
    supported: true,
    deliveryEnabled,
    accountBound,
    accountsConfigured,
    instanceReady,
    configured: accountBound && accountsConfigured && instanceReady,
    outbox: outboxStatus ? {
      pending: outboxStatus.pending,
      accepted: outboxStatus.accepted,
      rejected: outboxStatus.rejected,
      lastLocalError: outboxStatus.lastLocalError,
      lastAttemptAt: outboxStatus.lastAttemptAt,
      lastResult: outboxStatus.lastResult,
    } : null,
    statusNote: 'Accounts acceptance means the cloud accepted the event; it is not proof of Firebase delivery or user reading.',
  };
  return {
    schemaVersion: 1,
    enabled: snapshot.s?.enabled === 1,
    version: snapshot.s?.version || 0,
    deliveryEnabled,
    bindings: snapshot.bindings,
    receipts,
    accountCloudPush,
    channels: {
      webPush: { bindingCount: snapshot.bindings.length, deliveryEnabled },
      accountCloudPush: {
        supported: true,
        configured: accountCloudPush.configured,
        deliveryEnabled,
      },
    },
  };
}

export async function revokeResponsibilityNotificationSubscription(input, actor) {
  const principal = owner(actor);
  if (!/^[a-f0-9]{64}$/.test(String(input?.subscriptionId || '')) || !Number.isSafeInteger(input.expectedVersion) || input.confirmed !== true || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw fail('Confirmation, version and idempotency key required', 400);
  const { transaction, receipt } = await import('./responsibility-store.mjs');
  return transaction(db => {
    ensureSchema(db);
    return receipt(db, principal, 'notification_revoke', input.subscriptionId, input.idempotencyKey, input, () => {
      const b = db.prepare('SELECT * FROM responsibility_notification_bindings WHERE endpoint_hash=? AND owner_id=?').get(input.subscriptionId, principal);
      if (!b || b.version !== input.expectedVersion) throw fail('Subscription binding changed');
      const version = b.version + 1;
      db.prepare('UPDATE responsibility_notification_bindings SET enabled=0,version=? WHERE endpoint_hash=? AND owner_id=?').run(version, input.subscriptionId, principal);
      return { schemaVersion: 1, subscriptionId: input.subscriptionId, enabled: false, version };
    });
  });
}

async function reconcileAccountCloudPushRows() {
  const { read, transaction } = await import('./responsibility-store.mjs');
  const cutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
  const candidates = await read(db => {
    ensureSchema(db);
    return db.prepare(`SELECT event_id, owner_id, endpoint_hash, state, updated_at, cloud_kind, cloud_event_id
      FROM responsibility_notification_outbox
      WHERE endpoint_hash=? AND ((state='sending' AND updated_at<?) OR state='queued')`)
      .all(ACCOUNT_CLOUD_PUSH_ENDPOINT, cutoff);
  });
  if (!candidates.length) return;
  const pairs = candidates.filter(c => c.cloud_kind && c.cloud_event_id).map(c => ({ kind: c.cloud_kind, eventId: c.cloud_event_id }));
  const statuses = await getAccountPushEntriesStatus(pairs).catch(() => new Map());
  await transaction(db => {
    ensureSchema(db);
    const ts = stamp();
    for (const row of candidates) {
      const entry = row.cloud_kind && row.cloud_event_id ? statuses.get(`${row.cloud_kind}\0${row.cloud_event_id}`) : null;
      const mapped = mapOutboxState(entry);
      if (row.state === 'sending') {
        const nextState = mapped || 'unknown';
        db.prepare("UPDATE responsibility_notification_outbox SET state=?,updated_at=? WHERE event_id=? AND owner_id=? AND endpoint_hash=? AND state='sending'")
          .run(nextState, ts, row.event_id, row.owner_id, row.endpoint_hash);
      } else if (row.state === 'queued') {
        const nextState = mapped || 'unknown';
        if (nextState !== 'queued') {
          db.prepare("UPDATE responsibility_notification_outbox SET state=?,updated_at=? WHERE event_id=? AND owner_id=? AND endpoint_hash=? AND state='queued'")
            .run(nextState, ts, row.event_id, row.owner_id, row.endpoint_hash);
        }
      }
    }
  });
}

async function hasAuthorityLedger() {
  try {
    await lstat(OWNER_ACCOUNT_AUTHORITY_FILE);
    return true;
  } catch {
    return false;
  }
}

async function processSingleNotificationRow(row) {
  const { transaction } = await import('./responsibility-store.mjs');
  let state = 'unknown';
  let cloudKind = row.cloud_kind || null;
  let cloudEventId = row.cloud_event_id || null;
  try {
    const configuredOwner = String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID || '').trim();
    if (configuredOwner && configuredOwner !== row.owner_id) {
      state = 'authorization_revoked';
    } else if (row.type === 'attention_resolved') {
      const parsedSeqs = parseResolutionSequences(row.event_id);
      if (!parsedSeqs || !row.activity || !row.originalActivity) {
        state = 'suppressed';
      } else {
        const occurredAt = Date.parse(row.activity.created_at || row.updated_at);
        const origDesc = describeResponsibilityNotification(row.originalActivity.type, parseDetails(row.originalActivity.details_json));
        if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0 || occurredAt + 24 * 60 * 60_000 <= Date.now() || !origDesc) {
          state = 'expired';
        } else if (origDesc.kind === 'completion') {
          state = 'suppressed';
        } else if (!SAFE_ID_RE.test(String(row.root_session_id || ''))) {
          state = 'not_configured';
        } else {
          const account = await getOwnerAccountBinding();
          if (!account?.accountId) {
            state = (await hasAuthorityLedger()) ? 'authorization_revoked' : 'not_configured';
          } else {
            await authorizeDeviceBinding(
              { accountId: account.accountId, bindingAuthorityRevision: account.bindingAuthorityRevision },
              { credential: true, tokenRevision: account.bindingAuthorityRevision },
            );
            const stillOwned = await transaction(db => !!db.prepare(`SELECT 1 FROM responsibility_notification_outbox o
              JOIN responsibilities r ON r.id=o.responsibility_id AND r.owner_principal_id=o.owner_id
              WHERE o.event_id=? AND o.owner_id=? AND o.endpoint_hash=? AND o.state='sending'`)
              .get(row.event_id, row.owner_id, row.endpoint_hash));
            if (!stillOwned || process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED !== '1') {
              state = 'authorization_revoked';
            } else {
              const res = await resolveResponsibilityAccountPush({
                responsibilityId: row.responsibility_id,
                sessionId: row.root_session_id,
                sequence: parsedSeqs.sequence,
                originalSequence: parsedSeqs.originalSequence,
                originalType: row.originalActivity.type,
                originalDetails: parseDetails(row.originalActivity.details_json),
                occurredAt,
              });
              if (res.skipped) state = 'suppressed';
              else {
                state = 'queued';
                cloudKind = res.kind;
                cloudEventId = res.eventId;
              }
            }
          }
        }
      }
    } else {
      const details = parseDetails(row.activity?.details_json);
      const descriptor = describeResponsibilityNotification(row.type, details);
      const seq = parseAlertSequence(row.event_id);
      const occurredAt = Date.parse(row.activity?.created_at || row.updated_at);
      if (!descriptor || !seq) {
        state = 'suppressed';
      } else if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0 || occurredAt + descriptor.ttlMs <= Date.now()) {
        state = 'expired';
      } else if (row.alreadyApprovedPlan) {
        state = 'suppressed';
      } else if (row.endpoint_hash === ACCOUNT_CLOUD_PUSH_ENDPOINT) {
        if (!SAFE_ID_RE.test(String(row.root_session_id || ''))) {
          state = 'not_configured';
        } else {
          const account = await getOwnerAccountBinding();
          if (!account?.accountId) {
            state = (await hasAuthorityLedger()) ? 'authorization_revoked' : 'not_configured';
          } else {
            await authorizeDeviceBinding(
              { accountId: account.accountId, bindingAuthorityRevision: account.bindingAuthorityRevision },
              { credential: true, tokenRevision: account.bindingAuthorityRevision },
            );
            const allowed = await transaction(db => !!db.prepare(`SELECT 1 FROM responsibility_notification_outbox o
              JOIN responsibility_notification_settings s ON s.responsibility_id=o.responsibility_id AND s.owner_id=o.owner_id
              JOIN responsibilities r ON r.id=o.responsibility_id AND r.owner_principal_id=o.owner_id
              WHERE o.event_id=? AND o.owner_id=? AND o.endpoint_hash=? AND o.state='sending'
              AND r.lifecycle NOT IN ('cancelled','archived') AND s.enabled=1 AND s.version=o.settings_version`)
              .get(row.event_id, row.owner_id, row.endpoint_hash));
            if (!allowed || process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED !== '1') {
              state = 'authorization_revoked';
            } else {
              const expected = buildResponsibilityCloudPushEvent({
                responsibilityId: row.responsibility_id,
                sessionId: row.root_session_id,
                sequence: seq,
                type: row.type,
                details,
                occurredAt,
              });
              cloudKind = expected.kind;
              cloudEventId = expected.eventId;
              await enqueueResponsibilityAccountPush({
                responsibilityId: row.responsibility_id,
                sessionId: row.root_session_id,
                sequence: seq,
                type: row.type,
                details,
                occurredAt,
              });
              state = 'queued';
            }
          }
        }
      } else {
        const device = await getTrustedDeviceStatus(row.device_id);
        const account = await getOwnerAccountBinding();
        if (!row.credential_hash || !account?.accountId || account.accountId !== row.account_id || !device || device.status !== 'bound' || device.revokedAt || device.accountId !== row.account_id || device.bindingAuthorityRevision !== row.authority_revision) {
          state = 'authorization_revoked';
        } else {
          await authorizeDeviceBinding(device, { credential: true, tokenRevision: row.authority_revision });
          const allowed = await transaction(db => !!db.prepare(`SELECT 1 FROM responsibility_notification_outbox o
            JOIN responsibility_notification_bindings b ON b.endpoint_hash=o.endpoint_hash AND b.owner_id=o.owner_id
            JOIN responsibility_notification_settings s ON s.responsibility_id=o.responsibility_id AND s.owner_id=o.owner_id
            JOIN responsibilities r ON r.id=o.responsibility_id AND r.owner_principal_id=o.owner_id
            WHERE o.event_id=? AND o.owner_id=? AND o.endpoint_hash=? AND o.state='sending'
            AND r.lifecycle NOT IN ('cancelled','archived') AND b.enabled=1 AND b.version=o.binding_version AND s.enabled=1 AND s.version=o.settings_version`)
            .get(row.event_id, row.owner_id, row.endpoint_hash));
          if (!allowed || process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED !== '1') {
            state = 'authorization_revoked';
          } else {
            const query = new URLSearchParams({ tab: 'sessions', session: row.root_session_id, responsibility: row.responsibility_id });
            state = (await sendResponsibilityWebPush(row.endpoint_hash, row.credential_hash, {
              title: descriptor.title,
              body: descriptor.body,
              kind: 'responsibility',
              eventId: row.event_id,
              tag: row.event_id,
              sessionId: row.root_session_id,
              responsibilityId: row.responsibility_id,
              activityType: row.type,
              category: descriptor.category,
              ...(descriptor.planId ? { planId: descriptor.planId } : {}),
              url: `/?${query}`,
            })).state;
          }
        }
      }
    }
  } catch (error) {
    if (error?.code === 'RESPONSIBILITY_PUSH_EXPIRED') state = 'expired';
    else if (error?.code === 'RESPONSIBILITY_PUSH_DISABLED' || /^owner_auth_/.test(error?.code || '')) state = 'authorization_revoked';
    else state = 'unknown';
  }
  await transaction(db => {
    ensureSchema(db);
    db.prepare(`UPDATE responsibility_notification_outbox
      SET state=?,updated_at=?,cloud_kind=coalesce(?,cloud_kind),cloud_event_id=coalesce(?,cloud_event_id)
      WHERE event_id=? AND owner_id=? AND endpoint_hash=? AND state='sending'`)
      .run(state, stamp(), cloudKind, cloudEventId, row.event_id, row.owner_id, row.endpoint_hash);
  });
}

export async function processResponsibilityNotifications() {
  if (process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED !== '1') return;
  const { transaction } = await import('./responsibility-store.mjs');
  await reconcileAccountCloudPushRows();
  for (let i = 0; i < PROCESS_BATCH_LIMIT; i++) {
    if (process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED !== '1') break;
    const row = await transaction(db => {
      ensureSchema(db);
      const ts = stamp();
      const staleCutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
      db.prepare("UPDATE responsibility_notification_outbox SET state='unknown',updated_at=? WHERE state='sending' AND endpoint_hash<>? AND updated_at<?")
        .run(ts, ACCOUNT_CLOUD_PUSH_ENDPOINT, staleCutoff);
      db.prepare(`UPDATE responsibility_notification_outbox SET state='suppressed',updated_at=? WHERE state='pending' AND endpoint_hash<>? AND NOT EXISTS (
        SELECT 1 FROM responsibilities r JOIN organizations g ON g.id=r.organization_id AND g.project_id=r.project_id
        JOIN responsibility_notification_settings s ON s.responsibility_id=r.id AND s.owner_id=r.owner_principal_id
        JOIN responsibility_notification_bindings b ON b.owner_id=r.owner_principal_id AND b.endpoint_hash=responsibility_notification_outbox.endpoint_hash
        WHERE r.id=responsibility_notification_outbox.responsibility_id AND r.owner_principal_id=responsibility_notification_outbox.owner_id
        AND r.lifecycle NOT IN ('cancelled','archived') AND s.enabled=1 AND s.version=responsibility_notification_outbox.settings_version
        AND b.enabled=1 AND b.version=responsibility_notification_outbox.binding_version)`)
        .run(ts, ACCOUNT_CLOUD_PUSH_ENDPOINT);
      db.prepare(`UPDATE responsibility_notification_outbox SET state='suppressed',updated_at=? WHERE state='pending' AND endpoint_hash=? AND type<>'attention_resolved' AND NOT EXISTS (
        SELECT 1 FROM responsibilities r JOIN organizations g ON g.id=r.organization_id AND g.project_id=r.project_id
        JOIN responsibility_notification_settings s ON s.responsibility_id=r.id AND s.owner_id=r.owner_principal_id
        WHERE r.id=responsibility_notification_outbox.responsibility_id AND r.owner_principal_id=responsibility_notification_outbox.owner_id
        AND r.lifecycle NOT IN ('cancelled','archived') AND s.enabled=1 AND s.version=responsibility_notification_outbox.settings_version)`)
        .run(ts, ACCOUNT_CLOUD_PUSH_ENDPOINT);
      const next = db.prepare(`SELECT o.*, g.root_session_id, b.device_id, b.account_id, b.authority_revision, b.credential_hash
        FROM responsibility_notification_outbox o
        JOIN responsibilities r ON r.id=o.responsibility_id AND r.owner_principal_id=o.owner_id
        JOIN organizations g ON g.id=r.organization_id AND g.project_id=r.project_id
        LEFT JOIN responsibility_notification_settings s ON s.responsibility_id=o.responsibility_id AND s.owner_id=o.owner_id
        LEFT JOIN responsibility_notification_bindings b ON b.endpoint_hash=o.endpoint_hash AND b.owner_id=o.owner_id
        WHERE o.state='pending' AND (
          (o.endpoint_hash=? AND o.type='attention_resolved')
          OR (o.endpoint_hash=? AND o.type<>'attention_resolved' AND r.lifecycle NOT IN ('cancelled','archived') AND s.enabled=1 AND s.version=o.settings_version)
          OR (o.endpoint_hash<>? AND r.lifecycle NOT IN ('cancelled','archived') AND b.enabled=1 AND b.version=o.binding_version AND s.enabled=1 AND s.version=o.settings_version)
        )
        ORDER BY o.rowid ASC LIMIT 1`)
        .get(ACCOUNT_CLOUD_PUSH_ENDPOINT, ACCOUNT_CLOUD_PUSH_ENDPOINT, ACCOUNT_CLOUD_PUSH_ENDPOINT);
      if (!next) return null;
      const claim = db.prepare("UPDATE responsibility_notification_outbox SET state='sending',updated_at=? WHERE event_id=? AND owner_id=? AND endpoint_hash=? AND state='pending'")
        .run(ts, next.event_id, next.owner_id, next.endpoint_hash);
      if (!claim.changes) return null;
      const resSeqs = parseResolutionSequences(next.event_id);
      const alertSeq = parseAlertSequence(next.event_id);
      const actSeq = resSeqs ? resSeqs.sequence : alertSeq;
      const activity = actSeq
        ? db.prepare('SELECT sequence,type,details_json,created_at FROM responsibility_activity WHERE responsibility_id=? AND sequence=?').get(next.responsibility_id, actSeq)
        : null;
      const originalActivity = resSeqs
        ? db.prepare('SELECT sequence,type,details_json,created_at FROM responsibility_activity WHERE responsibility_id=? AND sequence=?').get(next.responsibility_id, resSeqs.originalSequence)
        : null;
      let alreadyApprovedPlan = false;
      if (['plan_proposed', 'plan_awaiting_approval'].includes(next.type) && activity) {
        const planId = parseDetails(activity.details_json).planId;
        if (planId) {
          alreadyApprovedPlan = !!db.prepare('SELECT 1 FROM responsibility_plan_approvals WHERE plan_id=? LIMIT 1').get(planId);
        }
      }
      return { ...next, activity, originalActivity, alreadyApprovedPlan };
    });
    if (!row) break;
    await processSingleNotificationRow(row);
  }
}
