// Organization Gate/Phase decision layer (S13, constitution §2.6/§2.7/§2.14).
//
// Builds on the S8 organization store's `organization_gates` table and its
// monotonic `advanceGateGeneration` CAS:
//   - decideGate()   records a one-shot gate decision as a fresh generation
//                    (passed | needs_changes). NEEDS_CHANGES never mutates an
//                    older packet or gate: the caller opens a new Attempt, the
//                    rework packet chains via parentPacketIds, and the next
//                    decision advances the generation again.
//   - completePhase() is the only path that produces `phase.completed`: it
//                    CAS-advances organization.progress_epoch and writes a
//                    phase_completed event, and only when the latest gate is
//                    'passed' AND every acceptance result is passed with
//                    evidence. Any other state throws PHASE_ACCEPTANCE_INCOMPLETE.
//
// Stable error codes (§4): GATE_STALE_GENERATION (409, generation already
// advanced) and PHASE_ACCEPTANCE_INCOMPLETE (409, phase.completed
// preconditions not met). The events table below is additive (CREATE TABLE IF
// NOT EXISTS) and lives in the same Collaboration SQLite file; existing
// collaboration tables and column semantics are untouched.
import { createSerialTaskQueue } from './fs-utils.mjs';
import { createHash } from 'crypto';
import { openDatabase as openCollaborationDatabase } from './collaboration-store.mjs';
import {
  advanceGateGeneration,
  getGate,
} from './organization-store.mjs';
import { publishOrganizationInvalidation } from './organization-invalidation.mjs';

export const GATE_STALE_GENERATION = 'GATE_STALE_GENERATION';
export const PHASE_ACCEPTANCE_INCOMPLETE = 'PHASE_ACCEPTANCE_INCOMPLETE';

export const GATE_DECISIONS = Object.freeze(['passed', 'needs_changes']);
export const GATE_STATES = new Set(['open', 'decided', 'passed', 'needs_changes']);

const EVIDENCE_KEYS = ['evidenceRef', 'evidence', 'ref', 'artifactRef', 'sourceRef'];
const runPhaseGateMutation = createSerialTaskQueue();

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function json(value, fallback = null) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function gateError(code, message, statusCode = 409, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function statusForCode(code) {
  switch (code) {
    case 'GATE_STALE_GENERATION': return 409;
    case 'PHASE_ACCEPTANCE_INCOMPLETE': return 409;
    case 'ORGANIZATION_NOT_FOUND': return 404;
    default: return 400;
  }
}

// Attach the stable HTTP status to a store-thrown error (the store is
// transport-agnostic) so the contract §4 codes surface correctly.
function withStatus(error) {
  if (error && typeof error === 'object' && error.code && !error.statusCode) {
    error.statusCode = statusForCode(error.code);
  }
  return error;
}

function ensurePhaseGateSchema(db) {
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
    CREATE INDEX IF NOT EXISTS idx_org_events_org ON organization_events(organization_id, id);
    CREATE INDEX IF NOT EXISTS idx_org_events_org_phase ON organization_events(organization_id, phase_id, id);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(organization_events)').all().map(column => column.name));
  if (!columns.has('organization_revision')) db.exec('ALTER TABLE organization_events ADD COLUMN organization_revision INTEGER');
}

function rowEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    phaseId: row.phase_id || '',
    gateGeneration: row.gate_generation ?? null,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

/**
 * Phase acceptance is complete iff every acceptance result is `passed` WITH
 * evidence (constitution §2.7 / §7 honest-evidence rule). An empty list, a
 * missing claim, or a claim without an evidence ref never completes a phase.
 */
export function acceptanceSatisfied(acceptanceResults) {
  if (!Array.isArray(acceptanceResults) || acceptanceResults.length === 0) return false;
  return acceptanceResults.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.status !== 'passed') return false;
    return EVIDENCE_KEYS.some((key) => {
      const value = entry[key];
      return typeof value === 'string' ? value.trim().length > 0 : !!value;
    });
  });
}

/**
 * Record a one-shot gate decision as a fresh generation (constitution §2.14).
 * The CAS anchor is `fromGeneration`: when the current generation has already
 * advanced the call fails with GATE_STALE_GENERATION (409). `decision` must be
 * 'passed' or 'needs_changes'; the gate state mirrors the decision and the
 * decision JSON carries the acceptance evidence the phase gate was decided on.
 */
export async function decideGate({
  organizationId,
  phaseId,
  fromGeneration = null,
  decision = 'passed',
  decidedByNodeId = '',
  packetId = '',
  acceptance = [],
  idempotencyKey = '',
  intentContext = null,
} = {}) {
  const normalizedOrg = trimString(organizationId);
  const normalizedPhase = trimString(phaseId);
  if (!normalizedOrg || !normalizedPhase) {
    throw gateError('BAD_REQUEST', 'organizationId and phaseId are required', 400);
  }
  const normalizedDecision = trimString(decision).toLowerCase();
  if (!GATE_DECISIONS.includes(normalizedDecision)) {
    throw gateError('BAD_REQUEST', `decision must be 'passed' or 'needs_changes'`, 400);
  }
  const key = trimString(idempotencyKey);
  const intentDigest = createHash('sha256').update(JSON.stringify({
    organizationId: normalizedOrg, phaseId: normalizedPhase, fromGeneration,
    decision: normalizedDecision, decidedByNodeId: trimString(decidedByNodeId),
    packetId: trimString(packetId), acceptance: Array.isArray(acceptance) ? acceptance : [],
    intentContext,
  })).digest('hex');
  const findReplay = async () => {
    if (!key) return null;
    const db = openCollaborationDatabase();
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_gate_decision_idempotency
        ON organization_gates(json_extract(decision_json, '$.idempotencyKey'))
        WHERE json_extract(decision_json, '$.idempotencyKey') IS NOT NULL`);
      const row = db.prepare(`SELECT generation, decision_json FROM organization_gates
        WHERE json_extract(decision_json, '$.idempotencyKey') = ? LIMIT 1`).get(key);
      if (!row) return null;
      if (parseJson(row.decision_json, {})?.intentDigest !== intentDigest) {
        throw gateError('GATE_IDEMPOTENCY_CONFLICT', 'Gate idempotency key is bound to another decision', 409);
      }
      return getGate(normalizedOrg, normalizedPhase, row.generation);
    } finally { db.close(); }
  };
  const replay = await findReplay();
  if (replay) return replay;
  let from = fromGeneration;
  if (from === null || from === undefined) {
    const latest = await getGate(normalizedOrg, normalizedPhase);
    from = latest ? latest.generation : 0;
  }
  try {
    const gate = await advanceGateGeneration(normalizedOrg, normalizedPhase, {
      fromGeneration: from,
      state: normalizedDecision === 'passed' ? 'passed' : 'needs_changes',
      decision: {
        decision: normalizedDecision,
        acceptance: Array.isArray(acceptance) ? acceptance : [],
        ...(key ? { idempotencyKey: key, intentDigest } : {}),
      },
      decidedByNodeId: trimString(decidedByNodeId),
      packetId: trimString(packetId),
      bindCurrentRevision: true,
    });
    publishOrganizationInvalidation({ organizationId: normalizedOrg });
    return gate;
  } catch (error) {
    if (key) {
      const recovered = await findReplay();
      if (recovered) return recovered;
    }
    throw withStatus(error);
  }
}

/**
 * The single path that produces `phase.completed` (constitution §2.7). Fails
 * closed with PHASE_ACCEPTANCE_INCOMPLETE when the latest gate is not 'passed'
 * or acceptance is incomplete; fails with GATE_STALE_GENERATION when the gate
 * generation moved on from `fromGeneration`. On success it CAS-advances
 * organization.progress_epoch and writes a phase_completed event in one
 * transaction, returning the new epoch and event id.
 */
export async function completePhase({
  organizationId,
  phaseId,
  fromGeneration = null,
  expectedProgressEpoch = null,
  decidedByNodeId = '',
} = {}) {
  const normalizedOrg = trimString(organizationId);
  const normalizedPhase = trimString(phaseId);
  if (!normalizedOrg || !normalizedPhase) {
    throw gateError('BAD_REQUEST', 'organizationId and phaseId are required', 400);
  }
  const result = await runPhaseGateMutation(() => {
    const db = openCollaborationDatabase();
    try {
      ensurePhaseGateSchema(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrg);
        if (!org) {
          throw gateError('ORGANIZATION_NOT_FOUND', `organization ${normalizedOrg} not found`, 404);
        }
        const gate = db.prepare(`SELECT * FROM organization_gates
          WHERE organization_id = ? AND phase_id = ? ORDER BY generation DESC LIMIT 1`).get(normalizedOrg, normalizedPhase);
        if (!gate) {
          throw gateError(PHASE_ACCEPTANCE_INCOMPLETE, `phase ${normalizedPhase} has no gate decision`, 409, { reason: 'no_gate' });
        }
        if (fromGeneration !== null && fromGeneration !== undefined && Number(fromGeneration) !== Number(gate.generation)) {
          throw gateError(GATE_STALE_GENERATION, `gate generation for ${normalizedOrg}/${normalizedPhase} is ${gate.generation}, expected ${fromGeneration}`, 409);
        }
        if (gate.state !== 'passed') {
          throw gateError(PHASE_ACCEPTANCE_INCOMPLETE, `phase ${normalizedPhase} gate is '${gate.state}', not 'passed'`, 409, {
            reason: 'gate_not_passed',
            state: gate.state,
          });
        }
        const decision = parseJson(gate.decision_json, {});
        const revision = db.prepare('SELECT state FROM organization_revisions WHERE organization_id=? AND revision=?').get(normalizedOrg,org.current_revision);
        if (revision?.state !== 'frozen' || decision.organizationRevision !== org.current_revision) {
          throw gateError(PHASE_ACCEPTANCE_INCOMPLETE, 'Gate decision is not bound to the current frozen revision', 409, { reason: 'gate_revision_mismatch' });
        }
        const acceptance = Array.isArray(decision?.acceptance) ? decision.acceptance : [];
        if (!acceptanceSatisfied(acceptance)) {
          throw gateError(PHASE_ACCEPTANCE_INCOMPLETE, `phase ${normalizedPhase} acceptance is not complete`, 409, {
            reason: 'acceptance_incomplete',
            acceptance,
          });
        }
        const currentEpoch = Number(org.progress_epoch || 0);
        if (expectedProgressEpoch !== null && expectedProgressEpoch !== undefined && Number(expectedProgressEpoch) !== currentEpoch) {
          throw gateError(PHASE_ACCEPTANCE_INCOMPLETE, `phase ${normalizedPhase} progress epoch is ${currentEpoch}, expected ${expectedProgressEpoch}`, 409, {
            reason: 'progress_epoch_conflict',
            expectedProgressEpoch,
          });
        }
        const changed = db.prepare(`UPDATE organizations
          SET progress_epoch = progress_epoch + 1, version = version + 1, updated_at = ?
          WHERE id = ? AND progress_epoch = ?`).run(nowIso(), normalizedOrg, currentEpoch).changes;
        if (changed !== 1) {
          throw gateError(PHASE_ACCEPTANCE_INCOMPLETE, `phase ${normalizedPhase} progress epoch advanced concurrently`, 409, {
            reason: 'progress_epoch_conflict',
          });
        }
        const nextEpoch = currentEpoch + 1;
        const eventId = db.prepare(`INSERT INTO organization_events
          (organization_id, organization_revision, type, phase_id, gate_generation, payload_json, created_at)
          VALUES (?, ?, 'phase_completed', ?, ?, ?, ?)`).run(
          normalizedOrg,
          org.current_revision,
          normalizedPhase,
          gate.generation,
          json({
            phaseId: normalizedPhase,
            gateGeneration: gate.generation,
            progressEpoch: nextEpoch,
            decidedByNodeId: trimString(decidedByNodeId) || gate.decided_by_node_id || '',
          }),
          nowIso(),
        ).lastInsertRowid;
        db.exec('COMMIT');
        return {
          organizationId: normalizedOrg,
          phaseId: normalizedPhase,
          gateGeneration: gate.generation,
          progressEpoch: nextEpoch,
          eventId: Number(eventId),
        };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } finally {
      db.close();
    }
  });
  publishOrganizationInvalidation({ organizationId: normalizedOrg, eventId: result?.eventId, progressEpoch: result?.progressEpoch });
  return result;
}

/** Read a phase gate (defaults to the latest generation). */
export async function getPhaseGate(organizationId, phaseId, generation = null) {
  return getGate(organizationId, phaseId, generation);
}

/** Read phase events (phase_id optional); the phase_completed audit trail. */
export async function listPhaseEvents(organizationId, phaseId = null, { limit = 500 } = {}) {
  return runPhaseGateMutation(async () => {
    const db = openCollaborationDatabase();
    try {
      ensurePhaseGateSchema(db);
      const boundedLimit = Math.max(1, Math.min(5000, Number.isInteger(limit) && limit > 0 ? limit : 500));
      const rows = phaseId
        ? db.prepare('SELECT * FROM organization_events WHERE organization_id = ? AND phase_id = ? ORDER BY id LIMIT ?').all(organizationId, phaseId, boundedLimit)
        : db.prepare('SELECT * FROM organization_events WHERE organization_id = ? ORDER BY id LIMIT ?').all(organizationId, boundedLimit);
      return rows.map(rowEvent).filter(Boolean);
    } finally {
      db.close();
    }
  });
}

/** Close pooled handles (used by tests). Connections are per-call. */
export async function closePhaseGateStore() {
  return true;
}
