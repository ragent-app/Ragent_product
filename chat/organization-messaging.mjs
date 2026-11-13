// S18: durable organization events and typed internal communication.
//
// Organization events are append-only facts. Internal envelopes are durable
// notifications and never become an independent state authority: a command
// must still perform the domain mutation before an envelope is acknowledged.
// Both tables live in the Collaboration SQLite WAL and use its serialized
// mutation path so this module cannot create a second organization store.
import { randomBytes } from 'crypto';
import { canonicalJson } from './execution-scope.mjs';
import { withDatabase } from './collaboration-store.mjs';
import { publishOrganizationInvalidation } from './organization-invalidation.mjs';
import { assertOrganizationCapability } from './organization-runtime-capabilities.mjs';

export const INTERNAL_ENVELOPE_TYPES = Object.freeze([
  'TASK_ASSIGNED',
  'TASK_RESUME',
  'RESULT_AVAILABLE',
  'CHECKPOINT_AVAILABLE',
  'HANDOFF_AVAILABLE',
  'REVIEW_REQUESTED',
  'REVIEW_COMPLETED',
  'BLOCKER_REPORTED',
  'BLOCKER_ESCALATED',
  'PLAN_AMENDMENT_AVAILABLE',
  'PHASE_COMPLETED',
  'CANCEL_REQUESTED',
  'SESSION_REPLACED',
  'OWNER_MESSAGE',
]);

export const INTERNAL_ENVELOPE_STATES = Object.freeze([
  'pending', 'claimed', 'delivered', 'acknowledged', 'dead_letter',
]);

const ENVELOPE_TYPES = new Set(INTERNAL_ENVELOPE_TYPES);
const ENVELOPE_STATES = new Set(INTERNAL_ENVELOPE_STATES);
const EVENT_TYPE_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,95}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_REF_BYTES = 8192;
const MAX_SUBJECT = 240;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export const ORG_ENVELOPE_INVALID = 'ORG_ENVELOPE_INVALID';
export const ORG_ENVELOPE_CONFLICT = 'ORG_ENVELOPE_CONFLICT';
export const ORG_EVENT_INVALID = 'ORG_EVENT_INVALID';
export const ORG_EVENT_CONFLICT = 'ORG_EVENT_CONFLICT';

function makeError(code, message, statusCode = 400, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function id(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function json(value, fallback = null) {
  try {
    const encoded = JSON.stringify(value ?? fallback);
    return encoded === undefined ? JSON.stringify(fallback) : encoded;
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function nowIso() {
  return new Date().toISOString();
}

function assertInternalEnvelopeCapability() {
  return assertOrganizationCapability('internalEnvelopes', 'internal organization envelopes are disabled');
}

function boundedInteger(value, fallback, max = 1_000_000) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
}

function ensureId(value, label, code = ORG_ENVELOPE_INVALID) {
  const normalized = text(value);
  if (!normalized || !ID_RE.test(normalized)) throw makeError(code, `${label} is required`, 400, { field: label });
  return normalized;
}

function ensureOrganization(db, organizationId, code) {
  const row = db.prepare('SELECT id FROM organizations WHERE id = ?').get(organizationId);
  if (!row) throw makeError(code, `organization ${organizationId} does not exist`, 404, { organizationId });
  return row;
}

function ensureNode(db, organizationId, nodeId, label, code) {
  const normalized = ensureId(nodeId, label, code);
  const row = db.prepare('SELECT id, current_session_id FROM organization_nodes WHERE id = ? AND organization_id = ?').get(normalized, organizationId);
  if (!row) throw makeError(code, `${label} is not a node in organization ${organizationId}`, 400, { field: label, nodeId: normalized });
  return row;
}

function validatePayloadRef(payloadRef, code = ORG_ENVELOPE_INVALID) {
  if (!payloadRef || typeof payloadRef !== 'object' || Array.isArray(payloadRef)) {
    throw makeError(code, 'payloadRef must be a bounded object reference');
  }
  const keys = Object.keys(payloadRef);
  if (keys.length === 0 || keys.length > 16) throw makeError(code, 'payloadRef must contain a bounded reference');
  const forbidden = new Set(['content', 'text', 'body', 'message', 'messages', 'history', 'raw', 'prompt', 'secret']);
  for (const key of keys) {
    if (forbidden.has(key.toLowerCase())) throw makeError(code, `payloadRef field is not an object reference: ${key}`, 400, { field: key });
    const value = payloadRef[key];
    if (typeof value === 'object' && value !== null) throw makeError(code, 'payloadRef values must be scalar reference fields');
    if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
      throw makeError(code, 'payloadRef contains an unsupported value');
    }
  }
  const encoded = json(payloadRef, {});
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REF_BYTES) throw makeError(code, 'payloadRef exceeds its size limit');
  return payloadRef;
}

function ensureEventSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      type TEXT NOT NULL,
      phase_id TEXT,
      gate_generation INTEGER,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(organization_events)').all().map((column) => column.name));
  const additions = [
    ['event_key', 'TEXT'],
    ['schema_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['organization_revision', 'INTEGER'],
    ['node_id', 'TEXT'],
    ['task_id', 'TEXT'],
    ['attempt_id', 'TEXT'],
    ['packet_id', 'TEXT'],
    ['envelope_id', 'TEXT'],
    ['actor_node_id', 'TEXT'],
    ['actor_session_id', 'TEXT'],
    ['payload_ref_json', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE organization_events ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_events_event_key
    ON organization_events(organization_id, event_key) WHERE event_key IS NOT NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_org_events_revision ON organization_events(organization_id, organization_revision, id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_org_events_envelope ON organization_events(organization_id, envelope_id, id)');
}

function ensureEnvelopeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS internal_envelopes (
      envelope_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      organization_revision INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      from_session_id TEXT,
      to_node_id TEXT NOT NULL,
      to_session_id TEXT,
      task_id TEXT,
      attempt_id TEXT,
      payload_ref_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      delivery_generation INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      delivered_at TEXT,
      acknowledged_at TEXT,
      lease_until TEXT,
      claimed_by_session_id TEXT,
      UNIQUE(organization_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_internal_envelopes_delivery
      ON internal_envelopes(organization_id, delivery_state, created_at);
    CREATE INDEX IF NOT EXISTS idx_internal_envelopes_target
      ON internal_envelopes(organization_id, to_node_id, delivery_state, delivery_generation);
  `);
}

function ensureSchema(db) {
  ensureEventSchema(db);
  ensureEnvelopeSchema(db);
}

// Used by the team-message store so body and delivery reference can be
// committed together without opening a nested transaction.
export function ensureOrganizationMessageEnvelopeSchema(db) { ensureSchema(db); }

async function read(fn) {
  return withDatabase((db) => { ensureSchema(db); return fn(db); });
}

async function mutate(fn) {
  return withDatabase((db) => { ensureSchema(db); return fn(db); }, { mutate: true });
}

function rowEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    organizationId: row.organization_id,
    eventKey: row.event_key || '',
    type: row.type,
    schemaVersion: Number(row.schema_version || 1),
    organizationRevision: row.organization_revision ?? null,
    phaseId: row.phase_id || '',
    gateGeneration: row.gate_generation ?? null,
    nodeId: row.node_id || '',
    taskId: row.task_id || '',
    attemptId: row.attempt_id || '',
    packetId: row.packet_id || '',
    envelopeId: row.envelope_id || '',
    actorNodeId: row.actor_node_id || '',
    actorSessionId: row.actor_session_id || '',
    payloadRef: parseJson(row.payload_ref_json, null),
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function rowEnvelope(row) {
  if (!row) return null;
  return {
    envelopeId: row.envelope_id,
    organizationId: row.organization_id,
    organizationRevision: row.organization_revision,
    type: row.type,
    fromNodeId: row.from_node_id,
    fromSessionId: row.from_session_id || '',
    toNodeId: row.to_node_id,
    toSessionId: row.to_session_id || '',
    taskId: row.task_id || '',
    attemptId: row.attempt_id || '',
    payloadRef: parseJson(row.payload_ref_json, {}),
    subject: row.subject,
    deliveryState: row.delivery_state,
    deliveryGeneration: row.delivery_generation,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    claimedAt: row.claimed_at || '',
    deliveredAt: row.delivered_at || '',
    acknowledgedAt: row.acknowledged_at || '',
    leaseUntil: row.lease_until || '',
    claimedBySessionId: row.claimed_by_session_id || '',
  };
}

function validateEventInput(input = {}) {
  const organizationId = ensureId(input.organizationId, 'organizationId', ORG_EVENT_INVALID);
  const eventKey = ensureId(input.eventKey, 'eventKey', ORG_EVENT_INVALID);
  const type = text(input.type);
  if (!EVENT_TYPE_RE.test(type)) throw makeError(ORG_EVENT_INVALID, 'event type is invalid', 400, { type });
  const schemaVersion = boundedInteger(input.schemaVersion, 1, 100);
  const revision = input.organizationRevision ?? input.revision ?? null;
  if (revision !== null && (!Number.isInteger(revision) || revision < 0)) throw makeError(ORG_EVENT_INVALID, 'organizationRevision must be non-negative');
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  const payloadRef = input.payloadRef === undefined ? null : validatePayloadRef(input.payloadRef, ORG_EVENT_INVALID);
  return {
    organizationId,
    eventKey,
    type,
    schemaVersion,
    organizationRevision: revision,
    phaseId: text(input.phaseId),
    gateGeneration: input.gateGeneration ?? null,
    nodeId: text(input.nodeId),
    taskId: text(input.taskId),
    attemptId: text(input.attemptId),
    packetId: text(input.packetId),
    envelopeId: text(input.envelopeId),
    actorNodeId: text(input.actorNodeId),
    actorSessionId: text(input.actorSessionId),
    payloadRef,
    payload,
  };
}

function validateEnvelopeInput(input = {}) {
  const organizationId = ensureId(input.organizationId, 'organizationId');
  const envelopeId = text(input.envelopeId) || id('env');
  const idempotencyKey = ensureId(input.idempotencyKey, 'idempotencyKey');
  if (!ID_RE.test(envelopeId)) throw makeError(ORG_ENVELOPE_INVALID, 'envelopeId is invalid');
  const type = text(input.type);
  if (!ENVELOPE_TYPES.has(type)) throw makeError(ORG_ENVELOPE_INVALID, 'unsupported internal envelope type', 400, { type });
  if (type === 'OWNER_MESSAGE') throw makeError(ORG_ENVELOPE_INVALID, 'owner messages require the authenticated team-message boundary', 403);
  const revision = input.organizationRevision ?? input.revision ?? 0;
  if (!Number.isInteger(revision) || revision < 0) throw makeError(ORG_ENVELOPE_INVALID, 'organizationRevision must be non-negative');
  const subject = text(input.subject);
  if (!subject || subject.length > MAX_SUBJECT) throw makeError(ORG_ENVELOPE_INVALID, 'subject is required and bounded');
  const payloadRef = validatePayloadRef(input.payloadRef);
  return {
    organizationId,
    envelopeId,
    idempotencyKey,
    organizationRevision: revision,
    type,
    fromNodeId: text(input.fromNodeId),
    fromSessionId: text(input.fromSessionId),
    toNodeId: text(input.toNodeId),
    toSessionId: text(input.toSessionId),
    taskId: text(input.taskId),
    attemptId: text(input.attemptId),
    payloadRef,
    subject,
  };
}

function sameEnvelope(row, value) {
  return row.organization_id === value.organizationId
    && row.type === value.type
    && row.organization_revision === value.organizationRevision
    && row.from_node_id === value.fromNodeId
    && row.to_node_id === value.toNodeId
    && row.task_id === (value.taskId || null)
    && row.attempt_id === (value.attemptId || null)
    && row.subject === value.subject
    && row.payload_ref_json === json(value.payloadRef, {});
}

function resolveTargetSession(db, organizationId, toNodeId, requestedSessionId = '') {
  const node = ensureNode(db, organizationId, toNodeId, 'toNodeId', ORG_ENVELOPE_INVALID);
  const current = node.current_session_id || '';
  return current || requestedSessionId || '';
}

export async function initializeOrganizationMessaging() {
  await mutate(() => true);
  return true;
}

export async function appendOrganizationEvent(input = {}) {
  const value = validateEventInput(input);
  const event = await mutate((db) => {
    ensureOrganization(db, value.organizationId, ORG_EVENT_INVALID);
    if (value.nodeId) ensureNode(db, value.organizationId, value.nodeId, 'nodeId', ORG_EVENT_INVALID);
    if (value.actorNodeId) ensureNode(db, value.organizationId, value.actorNodeId, 'actorNodeId', ORG_EVENT_INVALID);
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT * FROM organization_events WHERE organization_id = ? AND event_key = ?').get(value.organizationId, value.eventKey);
      if (replay) {
        const replayPayload = replay.payload_json === json(value.payload, {})
          && replay.type === value.type
          && Number(replay.organization_revision ?? -1) === Number(value.organizationRevision ?? -1);
        if (!replayPayload) throw makeError(ORG_EVENT_CONFLICT, 'event_key already belongs to a different event', 409, { eventKey: value.eventKey });
        db.exec('COMMIT');
        return rowEvent(replay);
      }
      const inserted = db.prepare(`INSERT INTO organization_events
        (organization_id, event_key, type, schema_version, organization_revision, phase_id,
         gate_generation, node_id, task_id, attempt_id, packet_id, envelope_id,
         actor_node_id, actor_session_id, payload_ref_json, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.organizationId, value.eventKey, value.type, value.schemaVersion, value.organizationRevision,
        value.phaseId || null, value.gateGeneration, value.nodeId || null, value.taskId || null,
        value.attemptId || null, value.packetId || null, value.envelopeId || null,
        value.actorNodeId || null, value.actorSessionId || null, value.payloadRef ? json(value.payloadRef, {}) : null,
        json(value.payload, {}), timestamp);
      db.exec('COMMIT');
      return rowEvent(db.prepare('SELECT * FROM organization_events WHERE id = ?').get(inserted.lastInsertRowid));
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      if (String(cause?.message || '').includes('UNIQUE')) throw makeError(ORG_EVENT_CONFLICT, 'event conflicts with an existing event', 409, { cause });
      throw cause;
    }
  });
  publishOrganizationInvalidation({
    organizationId: event.organizationId,
    eventId: event.id,
    revision: event.organizationRevision || 0,
  });
  return event;
}

export async function getOrganizationEvent(eventId) {
  if (!Number.isInteger(Number(eventId)) || Number(eventId) < 1) return null;
  return read((db) => rowEvent(db.prepare('SELECT * FROM organization_events WHERE id = ?').get(Number(eventId))));
}

export async function listOrganizationEvents(organizationId, { limit = 500, latest = false } = {}) {
  const orgId = ensureId(organizationId, 'organizationId', ORG_EVENT_INVALID);
  const boundedLimit = Math.max(1, Math.min(5000, boundedInteger(limit, 500)));
  return read((db) => {
    ensureOrganization(db, orgId, ORG_EVENT_INVALID);
    const rows = db.prepare(`SELECT * FROM organization_events WHERE organization_id = ? ORDER BY id ${latest ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(orgId, boundedLimit);
    return (latest ? rows.reverse() : rows).map(rowEvent);
  });
}

export async function enqueueInternalEnvelope(input = {}) {
  assertInternalEnvelopeCapability();
  const value = validateEnvelopeInput(input);
  return mutate((db) => {
    ensureOrganization(db, value.organizationId, ORG_ENVELOPE_INVALID);
    const from = ensureNode(db, value.organizationId, value.fromNodeId, 'fromNodeId', ORG_ENVELOPE_INVALID);
    const to = ensureNode(db, value.organizationId, value.toNodeId, 'toNodeId', ORG_ENVELOPE_INVALID);
    if (value.fromSessionId && from.current_session_id && value.fromSessionId !== from.current_session_id) {
      throw makeError(ORG_ENVELOPE_INVALID, 'fromSessionId is not the current sender binding', 400);
    }
    const targetSessionId = resolveTargetSession(db, value.organizationId, value.toNodeId, value.toSessionId);
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT * FROM internal_envelopes WHERE organization_id = ? AND idempotency_key = ?')
        .get(value.organizationId, value.idempotencyKey);
      if (replay) {
        if (!sameEnvelope(replay, value)) throw makeError(ORG_ENVELOPE_CONFLICT, 'idempotency key belongs to a different envelope', 409);
        db.exec('COMMIT');
        return rowEnvelope(replay);
      }
      const existing = db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(value.envelopeId);
      if (existing) throw makeError(ORG_ENVELOPE_CONFLICT, 'envelopeId already exists', 409);
      db.prepare(`INSERT INTO internal_envelopes
        (envelope_id, organization_id, organization_revision, type, from_node_id, from_session_id,
         to_node_id, to_session_id, task_id, attempt_id, payload_ref_json, subject,
         delivery_state, delivery_generation, idempotency_key, created_at,
         claimed_at, delivered_at, acknowledged_at, lease_until, claimed_by_session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, NULL, NULL, NULL)`)
        .run(value.envelopeId, value.organizationId, value.organizationRevision, value.type,
          value.fromNodeId, value.fromSessionId || from.current_session_id || null, value.toNodeId,
          targetSessionId || null, value.taskId || null, value.attemptId || null,
          json(value.payloadRef, {}), value.subject, value.idempotencyKey, timestamp);
      db.exec('COMMIT');
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      if (String(cause?.message || '').includes('UNIQUE')) throw makeError(ORG_ENVELOPE_CONFLICT, 'envelope conflicts with an existing envelope', 409, { cause });
      throw cause;
    }
    return rowEnvelope(db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(value.envelopeId));
  });
}

export async function getInternalEnvelope(envelopeId) {
  const idValue = ensureId(envelopeId, 'envelopeId');
  return read((db) => rowEnvelope(db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue)));
}

export async function listInternalEnvelopes(organizationId, { deliveryState = '', toNodeId = '', limit = 500 } = {}) {
  const orgId = ensureId(organizationId, 'organizationId');
  if (deliveryState && !ENVELOPE_STATES.has(deliveryState)) throw makeError(ORG_ENVELOPE_INVALID, 'deliveryState is invalid');
  const boundedLimit = Math.max(1, Math.min(5000, boundedInteger(limit, 500)));
  return read((db) => {
    ensureOrganization(db, orgId, ORG_ENVELOPE_INVALID);
    const clauses = ['organization_id = ?'];
    const params = [orgId];
    if (deliveryState) { clauses.push('delivery_state = ?'); params.push(deliveryState); }
    if (toNodeId) { clauses.push('to_node_id = ?'); params.push(toNodeId); }
    params.push(boundedLimit);
    return db.prepare(`SELECT * FROM internal_envelopes WHERE ${clauses.join(' AND ')} ORDER BY created_at, envelope_id LIMIT ?`)
      .all(...params).map(rowEnvelope);
  });
}

export async function listExpiredInternalEnvelopes(organizationId, { now = new Date(), limit = 500 } = {}) {
  const orgId = ensureId(organizationId, 'organizationId');
  const nowText = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString();
  const boundedLimit = Math.max(1, Math.min(5000, boundedInteger(limit, 500)));
  return read((db) => {
    ensureOrganization(db, orgId, ORG_ENVELOPE_INVALID);
    return db.prepare(`SELECT * FROM internal_envelopes
      WHERE organization_id = ? AND delivery_state = 'claimed'
        AND lease_until IS NOT NULL AND lease_until <= ?
      ORDER BY created_at, envelope_id LIMIT ?`).all(orgId, nowText, boundedLimit).map(rowEnvelope);
  });
}

function assertGenerationAndState(current, expectedGeneration, expectedState, envelopeId) {
  if (expectedGeneration !== undefined && Number(expectedGeneration) !== Number(current.delivery_generation)) {
    throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${envelopeId} delivery generation changed`, 409, { actualGeneration: current.delivery_generation, expectedGeneration });
  }
  if (current.delivery_state !== expectedState) {
    throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${envelopeId} is ${current.delivery_state}, expected ${expectedState}`, 409);
  }
}

export async function claimInternalEnvelope(envelopeId, { expectedGeneration, consumerSessionId = '', leaseMs = DEFAULT_LEASE_MS } = {}) {
  assertInternalEnvelopeCapability();
  const idValue = ensureId(envelopeId, 'envelopeId');
  const lease = Math.max(1000, Math.min(30 * 60 * 1000, boundedInteger(leaseMs, DEFAULT_LEASE_MS)));
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue);
      if (!current) throw makeError(ORG_ENVELOPE_INVALID, `envelope ${idValue} not found`, 404);
      if (current.delivery_state === 'claimed' && current.lease_until && current.lease_until <= nowIso()) {
        // An expired claim is reclaimable, but still advances the generation so
        // the old consumer cannot deliver or acknowledge after its lease.
        expectedGeneration = expectedGeneration === undefined ? current.delivery_generation : expectedGeneration;
      } else {
        assertGenerationAndState(current, expectedGeneration, 'pending', idValue);
      }
      if (current.delivery_state === 'claimed' && (!current.lease_until || current.lease_until > nowIso())) {
        throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${idValue} lease is active`, 409);
      }
      if (current.delivery_state !== 'pending' && current.delivery_state !== 'claimed') {
        throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${idValue} cannot be claimed from ${current.delivery_state}`, 409);
      }
      const generation = Number(current.delivery_generation) + 1;
      const claimedAt = nowIso();
      const leaseUntil = new Date(Date.now() + lease).toISOString();
      const changed = db.prepare(`UPDATE internal_envelopes SET
        delivery_state = 'claimed', delivery_generation = ?, claimed_at = ?, lease_until = ?,
        claimed_by_session_id = ?, to_session_id = COALESCE(
          (SELECT current_session_id FROM organization_nodes WHERE id = internal_envelopes.to_node_id AND organization_id = internal_envelopes.organization_id),
          to_session_id)
        WHERE envelope_id = ? AND delivery_generation = ? AND delivery_state IN ('pending', 'claimed')`).run(
        generation, claimedAt, leaseUntil, text(consumerSessionId) || null, idValue, current.delivery_generation);
      if (changed.changes !== 1) throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${idValue} changed concurrently`, 409);
      db.exec('COMMIT');
      return rowEnvelope(db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue));
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

// Recovery fencing: an expired consumer must be returned to pending with a new
// generation before any replacement consumer can claim it. The old consumer's
// delivery/ack CAS therefore cannot succeed after recovery.
export async function reclaimExpiredInternalEnvelope(envelopeId, { expectedGeneration, now = new Date() } = {}) {
  assertInternalEnvelopeCapability();
  const idValue = ensureId(envelopeId, 'envelopeId');
  const nowText = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString();
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue);
      if (!current) throw makeError(ORG_ENVELOPE_INVALID, `envelope ${idValue} not found`, 404);
      if (expectedGeneration !== undefined && Number(current.delivery_generation) !== Number(expectedGeneration)) {
        throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${idValue} delivery generation changed`, 409, { actualGeneration: current.delivery_generation, expectedGeneration });
      }
      if (current.delivery_state !== 'claimed' || !current.lease_until || current.lease_until > nowText) {
        db.exec('COMMIT');
        return rowEnvelope(current);
      }
      const updated = db.prepare(`UPDATE internal_envelopes SET delivery_state = 'pending',
        delivery_generation = delivery_generation + 1, lease_until = NULL, claimed_by_session_id = NULL
        WHERE envelope_id = ? AND delivery_state = 'claimed' AND delivery_generation = ? AND lease_until <= ?`)
        .run(idValue, current.delivery_generation, nowText);
      if (updated.changes !== 1) throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${idValue} changed concurrently`, 409);
      db.exec('COMMIT');
      return rowEnvelope(db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue));
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

async function transitionEnvelope(envelopeId, {
  expectedGeneration,
  expectedState,
  nextState,
  sessionId,
  allowExpired = false,
} = {}) {
  assertInternalEnvelopeCapability();
  const idValue = ensureId(envelopeId, 'envelopeId');
  if (!ENVELOPE_STATES.has(nextState)) throw makeError(ORG_ENVELOPE_INVALID, 'next delivery state is invalid');
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue);
      if (!current) throw makeError(ORG_ENVELOPE_INVALID, `envelope ${idValue} not found`, 404);
      assertGenerationAndState(current, expectedGeneration, expectedState, idValue);
      if (!allowExpired && current.lease_until && current.lease_until <= nowIso()) throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${idValue} lease expired`, 409);
      const allowed = expectedState === 'claimed' && ['delivered', 'dead_letter'].includes(nextState)
        || expectedState === 'delivered' && ['acknowledged', 'dead_letter'].includes(nextState)
        || expectedState === 'pending' && nextState === 'dead_letter';
      if (!allowed) throw makeError(ORG_ENVELOPE_CONFLICT, `invalid envelope transition ${expectedState} -> ${nextState}`, 409);
      const timestamp = nowIso();
      const updated = db.prepare(`UPDATE internal_envelopes SET delivery_state = ?, delivery_generation = delivery_generation + 1,
        delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
        acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE acknowledged_at END,
        lease_until = NULL, claimed_by_session_id = COALESCE(?, claimed_by_session_id)
        WHERE envelope_id = ? AND delivery_state = ? AND delivery_generation = ?`).run(
        nextState, nextState, timestamp, nextState, timestamp, text(sessionId) || null,
        idValue, current.delivery_state, current.delivery_generation);
      if (updated.changes !== 1) throw makeError(ORG_ENVELOPE_CONFLICT, `envelope ${idValue} changed concurrently`, 409);
      db.exec('COMMIT');
      return rowEnvelope(db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue));
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

export async function deliverInternalEnvelope(envelopeId, options = {}) {
  return transitionEnvelope(envelopeId, { ...options, expectedState: 'claimed', nextState: 'delivered' });
}

export async function acknowledgeInternalEnvelope(envelopeId, options = {}) {
  return transitionEnvelope(envelopeId, { ...options, expectedState: 'delivered', nextState: 'acknowledged' });
}

export async function deadLetterInternalEnvelope(envelopeId, options = {}) {
  const current = await getInternalEnvelope(envelopeId);
  if (!current) throw makeError(ORG_ENVELOPE_INVALID, `envelope ${envelopeId} not found`, 404);
  return transitionEnvelope(envelopeId, {
    ...options,
    expectedState: options.expectedState || current.deliveryState,
    nextState: 'dead_letter',
    allowExpired: true,
  });
}

export async function resolveInternalEnvelopeTarget(envelopeId, { resolveSessionId } = {}) {
  assertInternalEnvelopeCapability();
  const idValue = ensureId(envelopeId, 'envelopeId');
  return mutate(async (db) => {
    const current = db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue);
    if (!current) throw makeError(ORG_ENVELOPE_INVALID, `envelope ${idValue} not found`, 404);
    let sessionId = resolveSessionId ? await resolveSessionId({ organizationId: current.organization_id, nodeId: current.to_node_id, currentSessionId: current.to_session_id || '' }) : '';
    if (!sessionId) sessionId = resolveTargetSession(db, current.organization_id, current.to_node_id, current.to_session_id || '');
    if (!sessionId) throw makeError(ORG_ENVELOPE_CONFLICT, `node ${current.to_node_id} has no current session`, 409);
    const changed = db.prepare(`UPDATE internal_envelopes SET to_session_id = ?
      WHERE envelope_id = ? AND delivery_state IN ('pending', 'claimed')`).run(sessionId, idValue);
    if (changed.changes !== 1 && current.to_session_id !== sessionId) throw makeError(ORG_ENVELOPE_CONFLICT, 'envelope target changed or is no longer redirectable', 409);
    return rowEnvelope(db.prepare('SELECT * FROM internal_envelopes WHERE envelope_id = ?').get(idValue));
  });
}

export async function listInternalEnvelopeTypes() {
  return [...INTERNAL_ENVELOPE_TYPES];
}
