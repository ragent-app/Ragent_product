// S23: progress allowlist, durable budget reservations, and bounded stall policy.
//
// This module records governor facts only. Task/Attempt/Run and usage ledger
// facts remain owned by their existing stores. Usage accepted by settlement is
// explicitly backend-shaped; an Agent-provided usage field is rejected.
import { withDatabase } from './collaboration-store.mjs';
import { getOrganization } from './organization-store.mjs';
import { assertOrganizationCapability } from './organization-runtime-capabilities.mjs';

export const ORG_BUDGET_EXCEEDED = 'ORG_BUDGET_EXCEEDED';
export const ORG_STALLED = 'ORG_STALLED';
export const ORG_PROGRESS_INVALID = 'ORG_PROGRESS_INVALID';
export const ORG_BUDGET_INVALID = 'ORG_BUDGET_INVALID';
// C2: consultation scope reuses ORG_BUDGET_EXCEEDED semantics but is
// distinguished by scope. Over-limit on a consult: ledger throws this code.
export const CONSULTATION_BUDGET_EXCEEDED = 'CONSULTATION_BUDGET_EXCEEDED';

export const PROGRESS_MUTATIONS = Object.freeze([
  'result.created',
  'acceptance.completed',
  'review.passed',
  'blocker.resolved',
  'artifact.referenced',
  'phase.completed',
]);

const PROGRESS_SET = new Set(PROGRESS_MUTATIONS);
const GOVERNOR_DIMENSIONS = Object.freeze([
  'agents', 'runs', 'retries', 'replans', 'sessionReplacements', 'tokens', 'cost', 'elapsedMs',
]);
const STALL_ACTIONS = Object.freeze(['retry', 'replace', 'replan', 'escalate', 'ask_user']);

function governorError(code, message, statusCode = 409, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function integer(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function json(value, fallback = null) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parse(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function nowIso() {
  return new Date().toISOString();
}

// C2: scope-based ledger key encoding. The org scope keeps its existing
// (organization_id, revision) table untouched; the consult scope is carried by
// an isomorphic scope ledger addressed by `consult:<roundId>`.
function orgScopeKey(organizationId, revision) {
  return `org:${organizationId}:${revision}`;
}

function consultScopeKey(roundId) {
  return `consult:${roundId}`;
}

function ensureIdentity(value, label) {
  const normalized = text(value);
  if (!normalized || normalized.length > 255) throw governorError(ORG_BUDGET_INVALID, `${label} is required`, 400);
  return normalized;
}

function normalizeDelta(input = {}) {
  const delta = {};
  for (const key of GOVERNOR_DIMENSIONS) {
    if (input[key] !== undefined) {
      const value = key === 'cost' ? finite(input[key]) : integer(input[key], -1);
      if (value < 0) throw governorError(ORG_BUDGET_INVALID, `${key} must be non-negative`, 400);
      delta[key] = value;
    } else delta[key] = 0;
  }
  return delta;
}

function normalizeLimits(input = {}) {
  const limits = {};
  const map = {
    agents: 'maxTotalAgents', runs: 'maxTotalRuns', retries: 'maxRetries',
    replans: 'maxReplans', sessionReplacements: 'maxSessionReplacements',
    tokens: 'maxTokens', cost: 'maxCost', elapsedMs: 'maxElapsedMs',
  };
  for (const key of GOVERNOR_DIMENSIONS) {
    const field = map[key];
    if (input[field] !== undefined) {
      const value = key === 'cost' ? finite(input[field], -1) : integer(input[field], -1);
      if (value < 0) throw governorError(ORG_BUDGET_INVALID, `${field} must be non-negative`, 400);
      limits[key] = value;
    }
  }
  return limits;
}

function mergeLimits(authoritative, requested) {
  const merged = { ...authoritative };
  for (const key of GOVERNOR_DIMENSIONS) {
    if (requested[key] === undefined) continue;
    merged[key] = merged[key] === undefined
      ? requested[key]
      : Math.min(merged[key], requested[key]);
  }
  return merged;
}

function emptyTotals() {
  return Object.fromEntries(GOVERNOR_DIMENSIONS.map((key) => [key, 0]));
}

function add(left, right) {
  return Object.fromEntries(GOVERNOR_DIMENSIONS.map((key) => [key, (left[key] || 0) + (right[key] || 0)]));
}

function subtract(left, right) {
  return Object.fromEntries(GOVERNOR_DIMENSIONS.map((key) => [key, Math.max(0, (left[key] || 0) - (right[key] || 0))]));
}

function rowCounter(row) {
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    revision: row.revision,
    version: row.version,
    totals: parse(row.totals_json, emptyTotals()),
    reserved: parse(row.reserved_json, emptyTotals()),
    reservations: parse(row.reservations_json, {}),
    actionCounts: parse(row.action_counts_json, {}),
    updatedAt: row.updated_at,
  };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_budget_counters (
      organization_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      totals_json TEXT NOT NULL,
      reserved_json TEXT NOT NULL,
      reservations_json TEXT NOT NULL,
      action_counts_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_org_budget_counters_updated
      ON organization_budget_counters(organization_id, updated_at);
    CREATE TABLE IF NOT EXISTS budget_scope_counters (
      scope TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      totals_json TEXT NOT NULL,
      reserved_json TEXT NOT NULL,
      reservations_json TEXT NOT NULL,
      action_counts_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_budget_scope_counters_updated
      ON budget_scope_counters(scope, updated_at);
  `);
}

async function read(fn) {
  return withDatabase((db) => { ensureSchema(db); return fn(db); });
}

async function mutate(fn) {
  return withDatabase((db) => { ensureSchema(db); return fn(db); }, { mutate: true });
}

function getOrCreate(db, organizationId, revision) {
  const existing = db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(organizationId, revision);
  if (existing) return existing;
  const timestamp = nowIso();
  db.prepare(`INSERT INTO organization_budget_counters
    (organization_id, revision, version, totals_json, reserved_json, reservations_json, action_counts_json, updated_at)
    VALUES (?, ?, 1, ?, ?, '{}', '{}', ?)`).run(
    organizationId, revision, json(emptyTotals()), json(emptyTotals()), timestamp);
  return db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(organizationId, revision);
}

// Isomorphic scope ledger for non-org scopes (currently `consult:<roundId>`).
// Same column shape as organization_budget_counters so reservation semantics
// (reserved → settled / released) and dimensions are identical.
function scopeCounterRow(row) {
  if (!row) return null;
  return {
    scope: row.scope,
    version: row.version,
    totals: parse(row.totals_json, emptyTotals()),
    reserved: parse(row.reserved_json, emptyTotals()),
    reservations: parse(row.reservations_json, {}),
    actionCounts: parse(row.action_counts_json, {}),
    updatedAt: row.updated_at,
  };
}

function getOrCreateScopeCounter(db, scope) {
  const existing = db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope);
  if (existing) return existing;
  const timestamp = nowIso();
  db.prepare(`INSERT INTO budget_scope_counters
    (scope, version, totals_json, reserved_json, reservations_json, action_counts_json, updated_at)
    VALUES (?, 1, ?, ?, '{}', '{}', ?)`).run(
    scope, json(emptyTotals()), json(emptyTotals()), timestamp);
  return db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope);
}

function organizationBudgetLimits(db, organizationId) {
  const organization = db.prepare('SELECT budget_json FROM organizations WHERE id = ?').get(organizationId);
  if (!organization) throw governorError('ORGANIZATION_NOT_FOUND', `organization ${organizationId} not found`, 404);
  return normalizeLimits(parse(organization.budget_json, {}));
}

function assertWithinBudget(totals, reserved, delta, limits) {
  const combined = add(add(totals, reserved), delta);
  for (const key of GOVERNOR_DIMENSIONS) {
    if (limits[key] !== undefined && combined[key] > limits[key]) {
      throw governorError(ORG_BUDGET_EXCEEDED, `${key} budget exhausted`, 409, { dimension: key, actual: combined[key], limit: limits[key] });
    }
  }
}

// Consultation scope shares ORG_BUDGET_EXCEEDED semantics but is distinguished
// by scope: the ledger lives under a `consult:` key and throws the consultation
// code so callers can tell consult over-limit apart from org over-limit.
function assertConsultationWithinBudget(totals, reserved, delta, limits) {
  const combined = add(add(totals, reserved), delta);
  for (const key of GOVERNOR_DIMENSIONS) {
    if (limits[key] !== undefined && combined[key] > limits[key]) {
      throw governorError(CONSULTATION_BUDGET_EXCEEDED, `${key} consultation budget exhausted`, 409, { dimension: key, actual: combined[key], limit: limits[key] });
    }
  }
}

export async function initializeOrganizationGovernor() {
  await mutate(() => true);
  return true;
}

export async function getBudgetCounter(organizationId, revision) {
  return read((db) => rowCounter(db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(organizationId, revision)));
}

export async function listBudgetCounters(organizationId, { limit = 500 } = {}) {
  const orgId = ensureIdentity(organizationId, 'organizationId');
  const boundedLimit = Math.max(1, Math.min(5000, integer(limit, 500) || 500));
  return read((db) => db.prepare(`SELECT * FROM organization_budget_counters
    WHERE organization_id = ? ORDER BY revision LIMIT ?`).all(orgId, boundedLimit).map(rowCounter));
}

export async function reserveOrganizationBudget({ organizationId, revision, reservationId, idempotencyKey, delta = {}, limits = {}, reservationTtlMs = 0, expiresAt = '', cumulativeAcrossRevisions = false } = {}) {
  assertOrganizationCapability('stallGovernor', 'organization budget governance is disabled');
  const orgId = ensureIdentity(organizationId, 'organizationId');
  const key = ensureIdentity(idempotencyKey || reservationId, 'idempotencyKey');
  const revisionNumber = integer(revision, -1);
  if (revisionNumber < 0) throw governorError(ORG_BUDGET_INVALID, 'revision is required', 400);
  const reservation = ensureIdentity(reservationId || `reservation:${key}`, 'reservationId');
  const normalizedDelta = normalizeDelta(delta);
  const normalizedLimits = normalizeLimits(limits);
  const ttl = Number.isFinite(Number(reservationTtlMs)) ? Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(reservationTtlMs))) : 0;
  const requestedExpiry = text(expiresAt);
  if (requestedExpiry && Number.isNaN(new Date(requestedExpiry).getTime())) {
    throw governorError(ORG_BUDGET_INVALID, 'expiresAt must be an ISO timestamp', 400);
  }
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getOrCreate(db, orgId, revisionNumber);
      const authoritativeLimits = organizationBudgetLimits(db, orgId);
      const effectiveLimits = mergeLimits(authoritativeLimits, normalizedLimits);
      const reservations = parse(current.reservations_json, {});
      const replay = reservations[key];
      if (replay) {
        if (replay.reservationId !== reservation || JSON.stringify(replay.delta) !== JSON.stringify(normalizedDelta)) {
          throw governorError(ORG_BUDGET_INVALID, 'idempotency key belongs to a different reservation', 409);
        }
        db.exec('COMMIT');
        return { ...rowCounter(current), reservation: replay, replay: true };
      }
      const totals = parse(current.totals_json, emptyTotals());
      const reservedTotals = parse(current.reserved_json, emptyTotals());
      const allCounters = cumulativeAcrossRevisions
        ? db.prepare('SELECT totals_json, reserved_json FROM organization_budget_counters WHERE organization_id = ?').all(orgId)
        : [current];
      const cumulative = allCounters.reduce((sum, row) => ({
        totals: add(sum.totals, parse(row.totals_json, emptyTotals())),
        reserved: add(sum.reserved, parse(row.reserved_json, emptyTotals())),
      }), { totals: emptyTotals(), reserved: emptyTotals() });
      assertWithinBudget(cumulative.totals, cumulative.reserved, normalizedDelta, effectiveLimits);
      const nextReserved = add(reservedTotals, normalizedDelta);
      const nextReservations = {
        ...reservations,
        [key]: {
          reservationId: reservation,
          idempotencyKey: key,
          delta: normalizedDelta,
          state: 'reserved',
          createdAt: nowIso(),
          ...(requestedExpiry || ttl > 0 ? { expiresAt: requestedExpiry || new Date(Date.now() + ttl).toISOString() } : {}),
        },
      };
      const timestamp = nowIso();
      db.prepare(`UPDATE organization_budget_counters SET version = version + 1,
        reserved_json = ?, reservations_json = ?, updated_at = ?
        WHERE organization_id = ? AND revision = ? AND version = ?`).run(
        json(nextReserved), json(nextReservations), timestamp, orgId, revisionNumber, current.version);
      if (db.prepare('SELECT changes() AS changes').get().changes !== 1) throw governorError(ORG_BUDGET_INVALID, 'budget counter changed concurrently', 409);
      db.exec('COMMIT');
      const row = db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(orgId, revisionNumber);
      return { ...rowCounter(row), reservation: nextReservations[key], replay: false };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

// A Factory reservation is durable until settled or explicitly released with
// terminal evidence by the execution reconciler; lease expiry is not evidence
// that a worker stopped or that it consumed nothing.
export async function reserveFactoryBudget({ organizationId, revision, reservationId, idempotencyKey, delta = {}, limits = {} } = {}) {
  return reserveOrganizationBudget({ organizationId, revision, reservationId, idempotencyKey, delta, limits,
    cumulativeAcrossRevisions: true, reservationTtlMs: 0, expiresAt: '' });
}

export async function settleOrganizationBudget({ organizationId, revision, reservationId, idempotencyKey, backendUsage, recordActualOverBudget = false } = {}) {
  assertOrganizationCapability('stallGovernor', 'organization budget governance is disabled');
  const orgId = ensureIdentity(organizationId, 'organizationId');
  const key = ensureIdentity(idempotencyKey || reservationId, 'idempotencyKey');
  if (!backendUsage || typeof backendUsage !== 'object' || Array.isArray(backendUsage) || Object.hasOwn(backendUsage, 'agentReportedUsage')) {
    throw governorError(ORG_BUDGET_INVALID, 'settlement requires backend usage and rejects Agent-reported usage', 400);
  }
  const usage = normalizeDelta(backendUsage);
  const revisionNumber = integer(revision, -1);
  if (revisionNumber < 0) throw governorError(ORG_BUDGET_INVALID, 'revision is required', 400);
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(orgId, revisionNumber);
      if (!current) throw governorError(ORG_BUDGET_INVALID, 'budget counter does not exist', 404);
      const authoritativeLimits = organizationBudgetLimits(db, orgId);
      const reservations = parse(current.reservations_json, {});
      const entry = reservations[key];
      if (!entry) throw governorError(ORG_BUDGET_INVALID, 'reservation does not exist', 404);
      if (entry.state === 'settled') {
        db.exec('COMMIT');
        return { ...rowCounter(current), reservation: entry, replay: true };
      }
      if (entry.state !== 'reserved') throw governorError(ORG_BUDGET_INVALID, 'reservation is not settleable', 409);
      const totals = parse(current.totals_json, emptyTotals());
      const reserved = parse(current.reserved_json, emptyTotals());
      const nextReserved = subtract(reserved, entry.delta);
      const nextTotals = add(totals, usage);
      if (!recordActualOverBudget) assertWithinBudget(totals, nextReserved, usage, authoritativeLimits);
      reservations[key] = { ...entry, state: 'settled', usage, settledAt: nowIso() };
      db.prepare(`UPDATE organization_budget_counters SET version = version + 1,
        totals_json = ?, reserved_json = ?, reservations_json = ?, updated_at = ?
        WHERE organization_id = ? AND revision = ? AND version = ?`).run(
        json(nextTotals), json(nextReserved), json(reservations), nowIso(), orgId, revisionNumber, current.version);
      if (db.prepare('SELECT changes() AS changes').get().changes !== 1) throw governorError(ORG_BUDGET_INVALID, 'budget counter changed concurrently', 409);
      db.exec('COMMIT');
      const row = db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(orgId, revisionNumber);
      return { ...rowCounter(row), reservation: reservations[key], replay: false };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

export async function settleFactoryBudget({ organizationId, revision, reservationId, idempotencyKey, backendUsage } = {}) {
  return settleOrganizationBudget({ organizationId, revision, reservationId, idempotencyKey, backendUsage,
    recordActualOverBudget: true });
}

export async function releaseOrganizationBudgetReservation({ organizationId, revision, reservationId, idempotencyKey, reason = 'reservation expired' } = {}) {
  assertOrganizationCapability('stallGovernor', 'organization budget governance is disabled');
  const orgId = ensureIdentity(organizationId, 'organizationId');
  const key = ensureIdentity(idempotencyKey || reservationId, 'idempotencyKey');
  const revisionNumber = integer(revision, -1);
  if (revisionNumber < 0) throw governorError(ORG_BUDGET_INVALID, 'revision is required', 400);
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(orgId, revisionNumber);
      if (!current) throw governorError(ORG_BUDGET_INVALID, 'budget counter does not exist', 404);
      const reservations = parse(current.reservations_json, {});
      const entry = reservations[key];
      if (!entry) throw governorError(ORG_BUDGET_INVALID, 'reservation does not exist', 404);
      if (entry.state === 'released') {
        db.exec('COMMIT');
        return { ...rowCounter(current), reservation: entry, replay: true };
      }
      if (entry.state !== 'reserved') throw governorError(ORG_BUDGET_INVALID, 'reservation is not releasable', 409);
      reservations[key] = { ...entry, state: 'released', releaseReason: text(reason) || 'reservation expired', releasedAt: nowIso() };
      const nextReserved = subtract(parse(current.reserved_json, emptyTotals()), entry.delta);
      const updated = db.prepare(`UPDATE organization_budget_counters SET version = version + 1,
        reserved_json = ?, reservations_json = ?, updated_at = ?
        WHERE organization_id = ? AND revision = ? AND version = ?`).run(
        json(nextReserved), json(reservations), nowIso(), orgId, revisionNumber, current.version);
      if (updated.changes !== 1) throw governorError(ORG_BUDGET_INVALID, 'budget counter changed concurrently', 409);
      db.exec('COMMIT');
      const row = db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(orgId, revisionNumber);
      return { ...rowCounter(row), reservation: reservations[key], replay: false };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

export async function releaseExpiredOrganizationBudgetReservations({ organizationId, revision, now = new Date(), limit = 200 } = {}) {
  assertOrganizationCapability('stallGovernor', 'organization budget governance is disabled');
  const orgId = ensureIdentity(organizationId, 'organizationId');
  const revisionNumber = integer(revision, -1);
  if (revisionNumber < 0) throw governorError(ORG_BUDGET_INVALID, 'revision is required', 400);
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowTime)) throw governorError(ORG_BUDGET_INVALID, 'now must be a valid date', 400);
  const counter = await getBudgetCounter(orgId, revisionNumber);
  if (!counter) return [];
  const keys = Object.entries(counter.reservations || {})
    .filter(([, entry]) => entry?.state === 'reserved' && entry.expiresAt && new Date(entry.expiresAt).getTime() <= nowTime)
    .slice(0, Math.max(1, Math.min(1000, integer(limit, 200) || 200)))
    .map(([key]) => key);
  const released = [];
  for (const key of keys) {
    const outcome = await releaseOrganizationBudgetReservation({ organizationId: orgId, revision: revisionNumber, idempotencyKey: key });
    if (outcome?.reservation?.state === 'released' && outcome.replay !== true) released.push(outcome.reservation);
  }
  return released;
}

// ── C2 consultation scope ledger ─────────────────────────────────────────────
// The consult scope is an isomorphic scope ledger: the same GOVERNOR_DIMENSIONS
// and reservation lifecycle (reserve → settle → release → expired release), but
// addressed by `consult:<roundId>` in budget_scope_counters. Org behavior is
// untouched; usage settlement is backend-shaped and a model-provided usage
// field is rejected exactly as in the org path.

export async function getConsultationBudgetCounter(roundId) {
  const round = ensureIdentity(roundId, 'roundId');
  const scope = consultScopeKey(round);
  return read((db) => scopeCounterRow(db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope)));
}

export async function listConsultationBudgetCounters({ limit = 500 } = {}) {
  const boundedLimit = Math.max(1, Math.min(5000, integer(limit, 500) || 500));
  return read((db) => db.prepare('SELECT * FROM budget_scope_counters WHERE scope LIKE ? ORDER BY scope LIMIT ?').all('consult:%', boundedLimit).map(scopeCounterRow));
}

export async function reserveConsultationBudget({ roundId, reservationId, idempotencyKey, delta = {}, limits = {}, reservationTtlMs = 0, expiresAt = '', organizationId = '' } = {}) {
  const round = ensureIdentity(roundId, 'roundId');
  const key = ensureIdentity(idempotencyKey || reservationId, 'idempotencyKey');
  const reservation = ensureIdentity(reservationId || `reservation:${key}`, 'reservationId');
  const scope = consultScopeKey(round);
  const normalizedDelta = normalizeDelta(delta);
  const normalizedLimits = normalizeLimits(limits);
  const ttl = Number.isFinite(Number(reservationTtlMs)) ? Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(reservationTtlMs))) : 0;
  const requestedExpiry = text(expiresAt);
  if (requestedExpiry && Number.isNaN(new Date(requestedExpiry).getTime())) {
    throw governorError(ORG_BUDGET_INVALID, 'expiresAt must be an ISO timestamp', 400);
  }
  const orgBinding = text(organizationId);
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getOrCreateScopeCounter(db, scope);
      const reservations = parse(current.reservations_json, {});
      const replay = reservations[key];
      if (replay) {
        if (replay.reservationId !== reservation || JSON.stringify(replay.delta) !== JSON.stringify(normalizedDelta)) {
          throw governorError(ORG_BUDGET_INVALID, 'idempotency key belongs to a different reservation', 409);
        }
        db.exec('COMMIT');
        return { ...scopeCounterRow(current), scope, reservation: replay, replay: true };
      }
      const totals = parse(current.totals_json, emptyTotals());
      const reservedTotals = parse(current.reserved_json, emptyTotals());
      assertConsultationWithinBudget(totals, reservedTotals, normalizedDelta, normalizedLimits);
      const nextReserved = add(reservedTotals, normalizedDelta);
      const nextReservations = {
        ...reservations,
        [key]: {
          reservationId: reservation,
          idempotencyKey: key,
          roundId: round,
          delta: normalizedDelta,
          limits: normalizedLimits,
          state: 'reserved',
          createdAt: nowIso(),
          ...(orgBinding ? { organizationId: orgBinding } : {}),
          ...(requestedExpiry || ttl > 0 ? { expiresAt: requestedExpiry || new Date(Date.now() + ttl).toISOString() } : {}),
        },
      };
      const timestamp = nowIso();
      db.prepare(`UPDATE budget_scope_counters SET version = version + 1,
        reserved_json = ?, reservations_json = ?, updated_at = ?
        WHERE scope = ? AND version = ?`).run(
        json(nextReserved), json(nextReservations), timestamp, scope, current.version);
      if (db.prepare('SELECT changes() AS changes').get().changes !== 1) throw governorError(ORG_BUDGET_INVALID, 'budget scope counter changed concurrently', 409);
      db.exec('COMMIT');
      const row = db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope);
      return { ...scopeCounterRow(row), scope, reservation: nextReservations[key], replay: false };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

export async function settleConsultationBudget({ roundId, reservationId, idempotencyKey, backendUsage } = {}) {
  const round = ensureIdentity(roundId, 'roundId');
  const key = ensureIdentity(idempotencyKey || reservationId, 'idempotencyKey');
  if (!backendUsage || typeof backendUsage !== 'object' || Array.isArray(backendUsage) || Object.hasOwn(backendUsage, 'agentReportedUsage')) {
    throw governorError(ORG_BUDGET_INVALID, 'settlement requires backend usage and rejects Agent-reported usage', 400);
  }
  const usage = normalizeDelta(backendUsage);
  const scope = consultScopeKey(round);
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope);
      if (!current) throw governorError(ORG_BUDGET_INVALID, 'budget scope counter does not exist', 404);
      const reservations = parse(current.reservations_json, {});
      const entry = reservations[key];
      if (!entry) throw governorError(ORG_BUDGET_INVALID, 'reservation does not exist', 404);
      if (entry.state === 'settled') {
        db.exec('COMMIT');
        return { ...scopeCounterRow(current), scope, reservation: entry, replay: true };
      }
      if (entry.state !== 'reserved') throw governorError(ORG_BUDGET_INVALID, 'reservation is not settleable', 409);
      const totals = parse(current.totals_json, emptyTotals());
      const reserved = parse(current.reserved_json, emptyTotals());
      const nextReserved = subtract(reserved, entry.delta);
      const nextTotals = add(totals, usage);
      assertConsultationWithinBudget(totals, nextReserved, usage, entry.limits || {});
      reservations[key] = { ...entry, state: 'settled', usage, settledAt: nowIso() };
      db.prepare(`UPDATE budget_scope_counters SET version = version + 1,
        totals_json = ?, reserved_json = ?, reservations_json = ?, updated_at = ?
        WHERE scope = ? AND version = ?`).run(
        json(nextTotals), json(nextReserved), json(reservations), nowIso(), scope, current.version);
      if (db.prepare('SELECT changes() AS changes').get().changes !== 1) throw governorError(ORG_BUDGET_INVALID, 'budget scope counter changed concurrently', 409);
      db.exec('COMMIT');
      const row = db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope);
      return { ...scopeCounterRow(row), scope, reservation: reservations[key], replay: false };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

export async function releaseConsultationBudgetReservation({ roundId, reservationId, idempotencyKey, reason = 'reservation expired' } = {}) {
  const round = ensureIdentity(roundId, 'roundId');
  const key = ensureIdentity(idempotencyKey || reservationId, 'idempotencyKey');
  const scope = consultScopeKey(round);
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope);
      if (!current) throw governorError(ORG_BUDGET_INVALID, 'budget scope counter does not exist', 404);
      const reservations = parse(current.reservations_json, {});
      const entry = reservations[key];
      if (!entry) throw governorError(ORG_BUDGET_INVALID, 'reservation does not exist', 404);
      if (entry.state === 'released') {
        db.exec('COMMIT');
        return { ...scopeCounterRow(current), scope, reservation: entry, replay: true };
      }
      if (entry.state !== 'reserved') throw governorError(ORG_BUDGET_INVALID, 'reservation is not releasable', 409);
      reservations[key] = { ...entry, state: 'released', releaseReason: text(reason) || 'reservation expired', releasedAt: nowIso() };
      const nextReserved = subtract(parse(current.reserved_json, emptyTotals()), entry.delta);
      const updated = db.prepare(`UPDATE budget_scope_counters SET version = version + 1,
        reserved_json = ?, reservations_json = ?, updated_at = ?
        WHERE scope = ? AND version = ?`).run(
        json(nextReserved), json(reservations), nowIso(), scope, current.version);
      if (updated.changes !== 1) throw governorError(ORG_BUDGET_INVALID, 'budget scope counter changed concurrently', 409);
      db.exec('COMMIT');
      const row = db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope);
      return { ...scopeCounterRow(row), scope, reservation: reservations[key], replay: false };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

export async function releaseExpiredConsultationBudgetReservations({ roundId = '', now = new Date(), limit = 200 } = {}) {
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowTime)) throw governorError(ORG_BUDGET_INVALID, 'now must be a valid date', 400);
  const boundedLimit = Math.max(1, Math.min(1000, integer(limit, 200) || 200));
  const scopes = [];
  const explicitRound = text(roundId);
  if (explicitRound) {
    scopes.push(consultScopeKey(explicitRound));
  } else {
    scopes.push(...await read((db) => db.prepare('SELECT scope FROM budget_scope_counters WHERE scope LIKE ? ORDER BY scope LIMIT ?').all('consult:%', 5000).map((row) => row.scope)));
  }
  const released = [];
  for (const scope of scopes) {
    const counter = await read((db) => scopeCounterRow(db.prepare('SELECT * FROM budget_scope_counters WHERE scope = ?').get(scope)));
    if (!counter) continue;
    const keys = Object.entries(counter.reservations || {})
      .filter(([, entry]) => entry?.state === 'reserved' && entry.expiresAt && new Date(entry.expiresAt).getTime() <= nowTime)
      .slice(0, boundedLimit)
      .map(([key]) => key);
    for (const key of keys) {
      const outcome = await releaseConsultationBudgetReservation({ roundId: scope.replace(/^consult:/, ''), idempotencyKey: key });
      if (outcome?.reservation?.state === 'released' && outcome.replay !== true) released.push({ ...outcome.reservation, scope });
    }
  }
  return released;
}

export async function recordProgressMutation({ organizationId, kind, idempotencyKey, expectedProgressEpoch = undefined } = {}) {
  assertOrganizationCapability('stallGovernor', 'organization progress governance is disabled');
  const orgId = ensureIdentity(organizationId, 'organizationId');
  const eventKind = text(kind);
  const key = ensureIdentity(idempotencyKey, 'idempotencyKey');
  if (!PROGRESS_SET.has(eventKind)) throw governorError(ORG_PROGRESS_INVALID, `progress mutation ${eventKind} is not allowed`, 403);
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
      if (!org) throw governorError('ORGANIZATION_NOT_FOUND', `organization ${orgId} not found`, 404);
      const counter = getOrCreate(db, orgId, Number(org.current_revision || 0));
      const actions = parse(counter.action_counts_json, {});
      const progressKeys = actions.progressKeys || {};
      if (progressKeys[key]) {
        db.exec('COMMIT');
        return { organizationId: orgId, kind: eventKind, progressEpoch: Number(org.progress_epoch || 0), replay: true };
      }
      const epoch = Number(org.progress_epoch || 0);
      if (expectedProgressEpoch !== undefined && Number(expectedProgressEpoch) !== epoch) throw governorError(ORG_PROGRESS_INVALID, 'progress epoch changed concurrently', 409);
      progressKeys[key] = { kind: eventKind, at: nowIso() };
      actions.progressKeys = progressKeys;
      const nextEpoch = epoch + 1;
      const changed = db.prepare(`UPDATE organizations SET progress_epoch = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND progress_epoch = ?`).run(nextEpoch, nowIso(), orgId, epoch).changes;
      if (changed !== 1) throw governorError(ORG_PROGRESS_INVALID, 'progress epoch changed concurrently', 409);
      db.prepare(`UPDATE organization_budget_counters SET version = version + 1, action_counts_json = ?, updated_at = ?
        WHERE organization_id = ? AND revision = ? AND version = ?`).run(json(actions), nowIso(), orgId, Number(org.current_revision || 0), counter.version);
      if (db.prepare('SELECT changes() AS changes').get().changes !== 1) throw governorError(ORG_PROGRESS_INVALID, 'progress counter changed concurrently', 409);
      db.exec('COMMIT');
      return { organizationId: orgId, kind: eventKind, progressEpoch: nextEpoch, replay: false };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

export function evaluateStall({ progressEpoch = 0, lastProgressAt = null, managerAggregationRuns = 0, now = new Date(), maxAggregationRuns = 3, stallWindowMs = 15 * 60 * 1000 } = {}) {
  const runStalled = integer(managerAggregationRuns) >= integer(maxAggregationRuns, 3);
  const progressTime = lastProgressAt ? new Date(lastProgressAt).getTime() : NaN;
  const timeStalled = Number.isFinite(progressTime) && now.getTime() - progressTime >= integer(stallWindowMs, 15 * 60 * 1000);
  return {
    progressEpoch: integer(progressEpoch),
    stalled: runStalled || timeStalled,
    reason: runStalled ? 'aggregation_runs' : timeStalled ? 'wall_clock' : '',
    observedAt: now.toISOString(),
  };
}

export async function claimStallAction({ organizationId, revision, action, idempotencyKey, limits = {} } = {}) {
  assertOrganizationCapability('stallGovernor', 'organization stall governance is disabled');
  const orgId = ensureIdentity(organizationId, 'organizationId');
  const actionName = text(action);
  const key = ensureIdentity(idempotencyKey, 'idempotencyKey');
  if (!STALL_ACTIONS.includes(actionName)) throw governorError(ORG_STALLED, `unknown stall action ${actionName}`, 409);
  const revisionNumber = integer(revision, -1);
  if (revisionNumber < 0) throw governorError(ORG_STALLED, 'revision is required', 409);
  const maxByAction = { retry: 'maxRetries', replace: 'maxSessionReplacements', replan: 'maxReplans', escalate: 'maxEscalations', ask_user: 'maxUserEscalations' };
  const max = limits[maxByAction[actionName]] === undefined ? 0 : integer(limits[maxByAction[actionName]], 0);
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getOrCreate(db, orgId, revisionNumber);
      const actions = parse(current.action_counts_json, {});
      const keys = actions.stallKeys || {};
      if (keys[key]) {
        db.exec('COMMIT');
        return { ...rowCounter(current), action: keys[key], replay: true };
      }
      const count = integer(actions[actionName], 0);
      if (count >= max) throw governorError(ORG_STALLED, `${actionName} stall action budget is exhausted`, 409, { action: actionName, count, max });
      actions[actionName] = count + 1;
      actions.stallKeys = { ...keys, [key]: { action: actionName, count: count + 1, claimedAt: nowIso() } };
      db.prepare(`UPDATE organization_budget_counters SET version = version + 1, action_counts_json = ?, updated_at = ?
        WHERE organization_id = ? AND revision = ? AND version = ?`).run(json(actions), nowIso(), orgId, revisionNumber, current.version);
      if (db.prepare('SELECT changes() AS changes').get().changes !== 1) throw governorError(ORG_STALLED, 'stall action changed concurrently', 409);
      db.exec('COMMIT');
      const row = db.prepare('SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?').get(orgId, revisionNumber);
      return { ...rowCounter(row), action: actions.stallKeys[key], replay: false };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

export { GOVERNOR_DIMENSIONS, STALL_ACTIONS };
