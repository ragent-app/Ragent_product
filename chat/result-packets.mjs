// canonical ResultPacket store (Execution-Scope slice 5, design section 8).
//
// One canonical payload shape for both execution results and project
// checkpoints. Packets are immutable: creation persists the normalized packet
// and its content digest; there is no update path (corrections are new packets
// carrying `supersedesPacketId`). System-owned fields (state, runId, usage,
// scope refs, evidence) are derived by the server from the Run / snapshot /
// Git provenance; a model payload can never override them.
//
//   ResultPacket(kind = execution)          -- one terminal Run
//   ResultPacket(kind = project_checkpoint) -- aggregate of execution packets
//
// Persistence: CONFIG_DIR/project-workflow.db (node:sqlite + WAL, same pattern
// as chat/collaboration-store.mjs). A requestId idempotency key makes
// checkpoint creation replay-safe.
import { createHash, randomBytes } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { CONFIG_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';
import { canonicalJson } from './execution-scope.mjs';
import {
  getRun,
  getRunManifest,
  getRunResult,
  isTerminalRunState,
  listRunIds,
  runArtifactsDir,
} from './runs.mjs';
import {
  acquireWorkspaceLease,
  listActiveLeases,
  releaseLease,
} from './workspace-leases.mjs';
import { executeMutation } from './mutation-coordinator.mjs';
import { getProject } from './projects.mjs';
import { getWorkspaceById } from './workspaces.mjs';
import { assertRunPublication } from './run-publication-contract.mjs';

export const RESULT_PACKET_SCHEMA_VERSION = 1;
export const PACKET_STATES = new Set(['succeeded', 'failed', 'cancelled', 'partial', 'blocked']);
export const PACKET_KINDS = new Set(['execution', 'project_checkpoint']);
export const CONSULTATION_PACKET_INVALID = 'CONSULTATION_PACKET_INVALID';
const TASK_KINDS = new Set(['execution', 'consultation']);
const PACKET_ID_PREFIX = 'rsp_';
const RUN_STATE_TO_PACKET_STATE = {
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};
const MAX_AGGREGATE_SUMMARY_CHARS = 20000;
const EVIDENCE_KEYS = ['evidenceRef', 'evidence', 'ref', 'artifactRef', 'sourceRef'];
const USAGE_FIELDS = ['contextInputTokens', 'contextWindowTokens', 'normalizedLineCount', 'normalizedByteOffset', 'normalizedEventCount'];

const packetMutation = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function createWorkflowError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

export function createResultPacketId() {
  return `${PACKET_ID_PREFIX}${randomBytes(12).toString('hex')}`;
}

function dbPath() {
  return join(CONFIG_DIR, 'project-workflow.db');
}

function openDatabase() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath(), { timeout: 10_000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS result_packets (
      packet_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('execution','project_checkpoint')),
      task_kind TEXT NOT NULL DEFAULT 'execution',
      state TEXT NOT NULL,
      project_id TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL,
      digest TEXT NOT NULL,
      packet_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_result_packets_run ON result_packets(run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_result_packets_project_kind ON result_packets(project_id, kind, created_at DESC, packet_id DESC);
    CREATE TABLE IF NOT EXISTS workflow_idempotency (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // C4 additive column: idempotent migration for stores created before this
  // slice. ADD COLUMN with a default backfills legacy rows without a rebuild.
  const packetColumns = new Set(db.prepare('PRAGMA table_info(result_packets)').all().map((column) => column.name));
  if (!packetColumns.has('task_kind')) {
    db.exec("ALTER TABLE result_packets ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'execution'");
  }
  return db;
}

async function withDatabase(fn, { mutate = false } = {}) {
  const run = async () => {
    const db = openDatabase();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  };
  return mutate ? packetMutation(run) : run();
}

function rowToPacket(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.packet_json);
  } catch {
    return null;
  }
}

/**
 * Content digest over the canonical JSON of the packet, excluding the
 * identity-varying fields (packetId, createdAt) and digest itself. Identical
 * content therefore always produces the same digest regardless of object
 * construction order (same convention as the execution-scope snapshot digest).
 */
export function computeResultPacketDigest(packet) {
  if (!packet || typeof packet !== 'object') {
    throw createWorkflowError('result packet must be an object', 'EINVAL');
  }
  const { packetId, createdAt, digest, ...canonical } = packet;
  return `sha256:${createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex')}`;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => (typeof entry === 'string' ? { path: entry } : entry));
}

// Free-form text lists (decisions / blockers / risks / openQuestions): string
// entries stay strings; objects are kept as-is (must retain source refs).
function normalizeTextList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry !== null && entry !== undefined);
}

function hasEvidence(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return EVIDENCE_KEYS.some((key) => {
    const value = entry[key];
    return typeof value === 'string' ? trimString(value).length > 0 : !!value;
  });
}

// Evidence references projected from an entry: any non-empty EVIDENCE_KEYS
// string on tests / acceptanceResults becomes an evidenceRef (ResultPacket v2,
// constitution §7). Values are trimmed and deduplicated.
function evidenceRefsFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return [];
  return EVIDENCE_KEYS
    .map((key) => trimString(entry[key]))
    .filter(Boolean);
}

// ResultPacket v2 additive: evidenceRefs is a server-side projection of the
// evidence carried by tests / acceptanceResults (plus any explicitly supplied
// refs). Kept honest: only non-empty trimmed string refs survive.
function normalizeRefList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))].sort();
}

function collectEvidenceRefs(input = {}) {
  const refs = normalizeRefList(input.evidenceRefs);
  for (const source of [input.tests, input.acceptanceResults]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (entry && typeof entry === 'object') {
        for (const ref of evidenceRefsFromEntry(entry)) refs.push(ref);
      }
    }
  }
  // Ref lists are unordered sets: sorted so the packet digest is a canonical
  // function of content regardless of the input array order (same convention as
  // the S5 canonical digest).
  return [...new Set(refs)].sort();
}

// Honest evidence rule (design 8.1): tests / acceptanceResults without an
// evidence ref may only be `unknown` or `not_run`; a claimed `passed` (or any
// other claim status) without evidence is never stored.
function normalizeEvidenceList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (entry === null || entry === undefined) return { name: '', status: 'not_run' };
    if (typeof entry !== 'object') return { name: String(entry), status: 'not_run' };
    const status = trimString(entry.status) || 'not_run';
    const has = hasEvidence(entry);
    if (has) {
      if (status === 'passed') return { ...entry, status: 'passed' };
      return { ...entry, status: ['passed', 'failed', 'unknown', 'not_run', 'skipped', 'blocked'].includes(status)
        ? status
        : 'unknown' };
    }
    if (status === 'unknown' || status === 'not_run') return { ...entry, status };
    if (status === 'passed') return { ...entry, status: 'unknown' };
    return { ...entry, status: 'not_run' };
  });
}

function pickUsage(value) {
  if (!value || typeof value !== 'object') return {};
  const usage = {};
  for (const field of USAGE_FIELDS) {
    const number = Number(value[field]);
    if (Number.isFinite(number) && number >= 0) usage[field] = number;
  }
  return usage;
}

function revisionFromGit(git) {
  if (!git || typeof git !== 'object') return {};
  return {
    state: git.state === 'available' || git.state === 'partial' || git.state === 'not_git'
      ? git.state
      : 'not_git',
    ...(typeof git.baseCommit === 'string' && git.baseCommit ? { baseCommit: git.baseCommit } : {}),
    ...(typeof git.headCommit === 'string' && git.headCommit ? { headCommit: git.headCommit } : {}),
    ...(typeof git.trackedDiffHash === 'string' && git.trackedDiffHash ? { trackedDiffHash: git.trackedDiffHash } : {}),
    ...(typeof git.untrackedManifestHash === 'string' && git.untrackedManifestHash
      ? { untrackedManifestHash: git.untrackedManifestHash }
      : {}),
    ...(typeof git.reason === 'string' && git.reason ? { reason: git.reason } : {}),
    dirty: git.dirty === true,
    partial: git.partial === true,
  };
}

function normalizeProvenance(value) {
  const provenance = value && typeof value === 'object' ? value : {};
  const normalized = {
    executionScopeDigest: trimString(provenance.executionScopeDigest),
    baseRevision: provenance.baseRevision && typeof provenance.baseRevision === 'object'
      ? provenance.baseRevision
      : {},
    resultRevision: provenance.resultRevision && typeof provenance.resultRevision === 'object'
      ? provenance.resultRevision
      : {},
    sourceSessionIds: Array.isArray(provenance.sourceSessionIds)
      ? [...new Set(provenance.sourceSessionIds.map((id) => trimString(id)).filter(Boolean))]
      : [],
    sourceRunIds: Array.isArray(provenance.sourceRunIds)
      ? [...new Set(provenance.sourceRunIds.map((id) => trimString(id)).filter(Boolean))]
      : [],
    inputPacketIds: Array.isArray(provenance.inputPacketIds)
      ? [...new Set(provenance.inputPacketIds.map((id) => trimString(id)).filter(Boolean))]
      : [],
  };
  const report=provenance.assistantReport;
  if (report && report.source==='persisted_assistant_final' && Number.isSafeInteger(report.eventSeq) && report.eventSeq>0
      && typeof report.providerMessageId==='string' && report.providerMessageId.length>0 && report.providerMessageId.length<=256
      && /^[a-f0-9]{64}$/.test(report.contentHash || '')) {
    normalized.assistantReport={source:'persisted_assistant_final',eventSeq:report.eventSeq,providerMessageId:report.providerMessageId,contentHash:report.contentHash};
  }
  return normalized;
}

// C4 consultation recommendation: the only model-owned part of the
// consultation block. Must be a non-empty structured suggestion (object or
// array). A fresh shallow copy is produced so mutating the input afterwards
// cannot alias into the normalized packet.
function normalizeRecommendation(value) {
  if (Array.isArray(value)) {
    const entries = value.filter((entry) => entry !== null && entry !== undefined);
    return entries.length > 0 ? entries : null;
  }
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) copy[key] = entry;
    }
    return Object.keys(copy).length > 0 ? copy : null;
  }
  return null;
}

// C4 consultation scope: bound by the backend from the canonical provenance /
// execution-scope digest. Never taken from a model payload.
function consultationScope(provenance) {
  const scope = {};
  const digest = trimString(provenance?.executionScopeDigest);
  if (digest) scope.executionScopeDigest = digest;
  return scope;
}

/**
 * Normalize arbitrary input into the frozen canonical ResultPacket shape.
 * System-owned fields cannot be overridden by a model payload: state is
 * validated against the frozen enum, usage is picked from numeric fields,
 * evidence entries are forced honest, and provenance refs are deduplicated.
 * Callers that need system derivation (state / usage / scope refs) must use
 * deriveExecutionPacketFromRun() / createProjectCheckpoint() instead.
 */
export function normalizeResultPacket(input = {}) {
  const producer = input.producer && typeof input.producer === 'object' ? input.producer : {};
  const taskKind = TASK_KINDS.has(input.taskKind) ? input.taskKind : 'execution';
  const normalized = {
    schemaVersion: RESULT_PACKET_SCHEMA_VERSION,
    packetId: trimString(input.packetId) || createResultPacketId(),
    kind: PACKET_KINDS.has(input.kind) ? input.kind : 'execution',
    taskKind,
    state: PACKET_STATES.has(input.state) ? input.state : 'blocked',
    producer: {
      projectId: trimString(producer.projectId),
      taskId: trimString(producer.taskId),
      attemptId: trimString(producer.attemptId),
      sessionId: trimString(producer.sessionId),
      runId: trimString(producer.runId),
    },
    summary: typeof input.summary === 'string' ? input.summary : '',
    changedFiles: normalizeList(input.changedFiles),
    artifacts: normalizeList(input.artifacts),
    tests: normalizeEvidenceList(input.tests),
    acceptanceResults: normalizeEvidenceList(input.acceptanceResults),
    decisions: normalizeTextList(input.decisions),
    blockers: normalizeTextList(input.blockers),
    risks: normalizeTextList(input.risks),
    openQuestions: normalizeTextList(input.openQuestions),
    usage: pickUsage(input.usage),
    provenance: normalizeProvenance(input.provenance),
    createdAt: nowIso(input.createdAt),
  };
  // C4 system-bound consultation block. Only `recommendation` is model-owned;
  // Task ownership (taskId/attemptId), Run provenance (runId/sessionId), usage
  // and scope are bound by the backend from the normalized producer / usage /
  // provenance. Any backend fields a model tried to place inside
  // input.consultation (taskId, runId, usage, scope, digest, ...) are dropped
  // here — they never reach the stored packet. The top-level digest is computed
  // below over the full packet (consultation block included); it is never
  // embedded inside the block (no cycles).
  if (taskKind === 'consultation') {
    const consultationInput = input.consultation && typeof input.consultation === 'object' && !Array.isArray(input.consultation)
      ? input.consultation
      : {};
    const recommendation = normalizeRecommendation(consultationInput.recommendation);
    if (!recommendation) {
      throw createWorkflowError(
        'consultation packet requires a non-empty structured recommendation',
        CONSULTATION_PACKET_INVALID,
        400,
        { taskKind },
      );
    }
    normalized.consultation = {
      recommendation,
      taskId: normalized.producer.taskId,
      attemptId: normalized.producer.attemptId,
      runId: normalized.producer.runId,
      sessionId: normalized.producer.sessionId,
      usage: normalized.usage,
      scope: consultationScope(normalized.provenance),
    };
  }
  const supersedes = trimString(input.supersedesPacketId);
  if (supersedes) normalized.supersedesPacketId = supersedes;
  // ResultPacket v2 additive context fields (constitution §7). All optional;
  // system-derived by the server, never taken from a model payload. The derive
  // paths pass them explicitly; normalizeResultPacket only rounds them through.
  const organizationId = trimString(input.organizationId);
  if (organizationId) normalized.organizationId = organizationId;
  const nodeId = trimString(input.nodeId);
  if (nodeId) normalized.nodeId = nodeId;
  if (Number.isInteger(input.revision) && input.revision >= 0) normalized.revision = input.revision;
  const phaseId = trimString(input.phaseId);
  if (phaseId) normalized.phaseId = phaseId;
  const evidenceRefs = collectEvidenceRefs(input);
  if (evidenceRefs.length > 0) normalized.evidenceRefs = evidenceRefs;
  const parentPacketIds = normalizeRefList(input.parentPacketIds);
  if (parentPacketIds.length > 0) normalized.parentPacketIds = parentPacketIds;
  normalized.digest = computeResultPacketDigest(normalized);
  return normalized;
}

function uniqueBy(entries, keyOf = (entry) => canonicalJson(entry)) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries || []) {
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function mergeRevisionField(target, source) {
  if (!source || typeof source !== 'object' || Object.keys(source).length === 0) return target;
  return source;
}

async function listRunArtifacts(runId) {
  try {
    const { readdir } = await import('fs/promises');
    const entries = await readdir(runArtifactsDir(runId), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({ ref: entry.name.replace(/\.txt$/i, ''), name: entry.name }));
  } catch {
    return [];
  }
}

/**
 * Derive a canonical execution ResultPacket from a terminal Run. The server
 * re-reads canonical evidence (run record, manifest snapshot, result file,
 * artifact dir); git / usage / run state never come from the client.
 *
 * deps (test injection): { getRun, getRunManifest, getRunResult, listArtifacts }
 */
export async function deriveExecutionPacketFromRun({
  runId,
  projectId,
  sessionId,
  taskId,
  attemptId,
  supersedesPacketId,
  organizationId,
  nodeId,
  revision,
  phaseId,
  parentPacketIds,
  taskKind,
  consultation,
  assistantReport,
  now,
  deps = {},
} = {}) {
  const getRunFn = typeof deps.getRun === 'function' ? deps.getRun : getRun;
  const getManifest = typeof deps.getRunManifest === 'function' ? deps.getRunManifest : getRunManifest;
  const getResult = typeof deps.getRunResult === 'function' ? deps.getRunResult : getRunResult;
  const listArtifacts = typeof deps.listArtifacts === 'function' ? deps.listArtifacts : listRunArtifacts;

  const normalizedRunId = trimString(runId);
  if (!normalizedRunId) {
    throw createWorkflowError('runId is required to derive an execution packet', 'EINVAL');
  }
  const run = await getRunFn(normalizedRunId);
  if (!run) {
    throw createWorkflowError('Run not found', 'RUN_NOT_FOUND', 404, { runId: normalizedRunId });
  }
  if (!isTerminalRunState(run.state)) {
    throw createWorkflowError(
      'Cannot derive a result packet while the Run is still active',
      'WORKSPACE_LEASE_CONFLICT',
      409,
      { runId: normalizedRunId, state: run.state, reason: 'active-writer-run' },
    );
  }
  const manifest = (await getManifest(normalizedRunId)) || {};
  const result = (await getResult(normalizedRunId)) || {};
  let reportProvenance;
  if (assistantReport) {
    if (run.state!=='completed' || !run.finalizedAt || !assertRunPublication(run,manifest)
        || assistantReport.runId!==normalizedRunId || assistantReport.sessionId!==run.sessionId || assistantReport.requestId!==run.requestId
        || !Number.isSafeInteger(assistantReport.eventSeq) || assistantReport.eventSeq<1 || typeof assistantReport.providerMessageId!=='string' || !assistantReport.providerMessageId || assistantReport.providerMessageId.length>256
        || typeof assistantReport.content!=='string' || !assistantReport.content.trim() || Buffer.byteLength(assistantReport.content,'utf8')>32768
        || createHash('sha256').update(assistantReport.content).digest('hex')!==assistantReport.contentHash) {
      throw createWorkflowError('Final assistant report identity is invalid','FACTORY_REPORT_HISTORY_PENDING',409);
    }
    reportProvenance={eventSeq:assistantReport.eventSeq,providerMessageId:assistantReport.providerMessageId,contentHash:assistantReport.contentHash,source:'persisted_assistant_final'};
  }
  const scope = manifest.executionScope && typeof manifest.executionScope === 'object'
    ? manifest.executionScope
    : {};
  const git = result.git && typeof result.git === 'object' ? result.git : (scope.git || null);
  const baseRevision = revisionFromGit(scope.git || manifest.git || {});
  const resultRevision = result.git && typeof result.git === 'object'
    ? revisionFromGit(result.git)
    : baseRevision;

  return normalizeResultPacket({
    kind: 'execution',
    taskKind,
    consultation,
    state: RUN_STATE_TO_PACKET_STATE[run.state] || 'blocked',
    producer: {
      projectId: trimString(projectId) || trimString(scope.projectId) || trimString(manifest.projectId),
      taskId: trimString(taskId) || trimString(manifest.taskId),
      attemptId: trimString(attemptId) || trimString(manifest.attemptId),
      sessionId: trimString(sessionId) || trimString(run.sessionId) || trimString(manifest.sessionId),
      runId: normalizedRunId,
    },
    summary: assistantReport?.content || (typeof result.summary === 'string' && result.summary
      ? result.summary
      : (typeof manifest.summary === 'string' ? manifest.summary : '')),
    changedFiles: Array.isArray(result.changedFiles)
      ? result.changedFiles
      : (Array.isArray(manifest.changedFiles) ? manifest.changedFiles : []),
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : await listArtifacts(normalizedRunId),
    tests: Array.isArray(result.tests) ? result.tests : [],
    acceptanceResults: Array.isArray(result.acceptanceResults) ? result.acceptanceResults : [],
    decisions: Array.isArray(result.decisions) ? result.decisions : (Array.isArray(manifest.decisions) ? manifest.decisions : []),
    blockers: Array.isArray(result.blockers) ? result.blockers : (Array.isArray(manifest.blockers) ? manifest.blockers : []),
    risks: Array.isArray(result.risks) ? result.risks : (Array.isArray(manifest.risks) ? manifest.risks : []),
    openQuestions: Array.isArray(result.openQuestions) ? result.openQuestions : (Array.isArray(manifest.openQuestions) ? manifest.openQuestions : []),
    usage: pickUsage(run),
    provenance: {
      executionScopeDigest: trimString(manifest.executionScopeDigest),
      baseRevision,
      resultRevision,
      sourceSessionIds: [trimString(sessionId) || trimString(run.sessionId) || trimString(manifest.sessionId)].filter(Boolean),
      sourceRunIds: [normalizedRunId],
      inputPacketIds: [],
      ...(reportProvenance ? {assistantReport:reportProvenance} : {}),
    },
    supersedesPacketId,
    // ResultPacket v2 additive org/phase context (constitution §7). These come
    // exclusively from explicit caller options — a model payload inside the Run
    // result can never set them (system-field protection, constitution §2.9).
    organizationId,
    nodeId,
    revision,
    phaseId,
    parentPacketIds,
    createdAt: now,
  });
}

function insertPacketRow(db, packet) {
  db.prepare(`
    INSERT INTO result_packets (packet_id, kind, task_kind, state, project_id, run_id, created_at, digest, packet_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    packet.packetId,
    packet.kind,
    packet.taskKind || 'execution',
    packet.state,
    packet.producer?.projectId || '',
    packet.kind === 'execution' ? (packet.producer?.runId || null) : null,
    packet.createdAt,
    packet.digest,
    JSON.stringify(packet),
  );
}

/**
 * Persist an execution packet for a Run. Idempotent per runId: a packet that
 * already exists for the run is returned unchanged (never duplicated). The
 * packet is immutable once stored; corrections use supersedesPacketId.
 */
export async function createExecutionPacket({
  runId,
  projectId,
  sessionId,
  taskId,
  attemptId,
  supersedesPacketId,
  organizationId,
  nodeId,
  revision,
  phaseId,
  parentPacketIds,
  taskKind,
  consultation,
  assistantReport,
  now,
  deps = {},
} = {}) {
  const normalizedRunId = trimString(runId);
  if (!normalizedRunId) {
    throw createWorkflowError('runId is required to create an execution packet', 'EINVAL');
  }
  const existing = await withDatabase((db) => rowToPacket(
    db.prepare('SELECT * FROM result_packets WHERE run_id = ?').get(normalizedRunId),
  ));
  if (existing) return existing;

  const packet = await deriveExecutionPacketFromRun({
    runId: normalizedRunId,
    projectId,
    sessionId,
    taskId,
    attemptId,
    supersedesPacketId,
    organizationId,
    nodeId,
    revision,
    phaseId,
    parentPacketIds,
    taskKind,
    consultation,
    assistantReport,
    now,
    deps,
  });
  return withDatabase((db) => {
    const row = db.prepare('SELECT * FROM result_packets WHERE run_id = ?').get(normalizedRunId);
    if (row) return rowToPacket(row);
    insertPacketRow(db, packet);
    return packet;
  }, { mutate: true });
}

async function findPreviousCheckpointRevision(projectId) {
  return withDatabase((db) => {
    const row = db.prepare(`
      SELECT packet_json FROM result_packets
      WHERE project_id = ? AND kind = 'project_checkpoint'
      ORDER BY created_at DESC, packet_id DESC LIMIT 1
    `).get(projectId);
    const packet = rowToPacket(row);
    return packet?.provenance?.resultRevision && typeof packet.provenance.resultRevision === 'object'
      ? packet.provenance.resultRevision
      : null;
  });
}

function aggregateUsage(packets) {
  const usage = {};
  for (const packet of packets) {
    for (const field of USAGE_FIELDS) {
      const value = Number(packet.usage?.[field]);
      if (!Number.isFinite(value)) continue;
      usage[field] = (usage[field] || 0) + value;
    }
  }
  return usage;
}

function boundedSummary(packets) {
  const parts = packets.map((packet) => {
    const label = packet.producer?.runId || packet.packetId;
    return `[${label}] ${packet.summary || ''}`.trimEnd();
  }).filter(Boolean);
  const joined = parts.join('\n');
  return joined.length > MAX_AGGREGATE_SUMMARY_CHARS
    ? `${joined.slice(0, MAX_AGGREGATE_SUMMARY_CHARS)}\n[... truncated ...]`
    : joined;
}

function aggregateState(packets) {
  if (packets.length === 0) return 'blocked';
  const states = [...new Set(packets.map((packet) => packet.state))];
  if (states.length === 1) return states[0];
  return 'partial';
}

/**
 * Build and persist a project_checkpoint packet aggregating selected execution
 * packets. The server re-reads canonical evidence from the Run store; a client
 * can never submit git / usage / run state system fields. A checkpoint is
 * refused while any active write mutation lease exists on the project's
 * Workspace (WORKSPACE_LEASE_CONFLICT 409): a checkpoint is a
 * "finished-state" claim for the Workspace and must never be produced
 * mid-change. The capture itself holds a short server-owned READ mutation
 * lease on `workspace:<physicalKey>` through executeMutation.
 *
 * deps (test injection): { getProject, getWorkspaceById, listActiveLeases,
 *                           acquireWorkspaceLease, releaseLease, executeMutation,
 *                           listRunIds, getRun, previousCheckpointRevision }
 */
export async function createProjectCheckpoint({
  projectId,
  project,
  sessionIds = [],
  runIds = [],
  taskId,
  attemptId,
  requestId,
  organizationId,
  nodeId,
  revision,
  phaseId,
  now,
  deps = {},
} = {}) {
  const loadProject = typeof deps.getProject === 'function' ? deps.getProject : getProject;
  const resolvedProject = project && typeof project === 'object'
    ? project
    : (trimString(projectId) ? await loadProject(trimString(projectId)) : null);
  if (!resolvedProject) {
    throw createWorkflowError('Project not found', 'PROJECT_NOT_FOUND', 404, { projectId: trimString(projectId) });
  }
  const resolvedProjectId = trimString(resolvedProject.id) || trimString(projectId);
  if (!resolvedProjectId) {
    throw createWorkflowError('projectId is required to create a checkpoint', 'EINVAL');
  }

  if (trimString(requestId)) {
    const replay = await withDatabase((db) => {
      const row = db.prepare(`
        SELECT result_json FROM workflow_idempotency
        WHERE request_id = ? AND kind = 'checkpoint'
      `).get(trimString(requestId));
      return row ? row.result_json : null;
    });
    if (replay) return JSON.parse(replay);
  }

  const normalizedSessionIds = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => trimString(id)).filter(Boolean))];
  const normalizedRunIds = [...new Set((Array.isArray(runIds) ? runIds : []).map((id) => trimString(id)).filter(Boolean))];
  if (normalizedSessionIds.length === 0 && normalizedRunIds.length === 0) {
    throw createWorkflowError('checkpoint must select at least one source Session or Run', 'EINVAL');
  }

  // Resolve runs for the selected sessions (system-side canonical evidence).
  if (normalizedSessionIds.length > 0) {
    const listRuns = typeof deps.listRunIds === 'function' ? deps.listRunIds : listRunIds;
    const getRunFn = typeof deps.getRun === 'function' ? deps.getRun : getRun;
    const sessionSet = new Set(normalizedSessionIds);
    for (const runId of await listRuns()) {
      const run = await getRunFn(runId);
      if (run && sessionSet.has(trimString(run.sessionId))) normalizedRunIds.push(trimString(runId));
    }
    normalizedRunIds.splice(0, normalizedRunIds.length, ...new Set(normalizedRunIds));
  }

  // Writer gate: no active write MUTATION lease on the project's Workspace.
  // The capture itself holds a server-owned, read-only short mutation lease on
  // `workspace:<physicalKey>` (via executeMutation), so a concurrently admitted
  // workspace-level writer still loses the race through the lease store.
  const getWorkspace = typeof deps.getWorkspaceById === 'function' ? deps.getWorkspaceById : getWorkspaceById;
  const listLeases = typeof deps.listActiveLeases === 'function' ? deps.listActiveLeases : listActiveLeases;
  const workspace = trimString(resolvedProject.workspaceId)
    ? await getWorkspace(trimString(resolvedProject.workspaceId))
    : null;
  const active = await listLeases();
  if (active.some((lease) => lease.mode === 'write'
    && (trimString(lease.workspaceId) === trimString(workspace?.id)
      || (!trimString(lease.workspaceId) && trimString(lease.projectId) === resolvedProjectId)))) {
    throw createWorkflowError(
      'Cannot checkpoint a Workspace with an active write mutation',
      'WORKSPACE_LEASE_CONFLICT',
      409,
      { projectId: resolvedProjectId, reason: 'active-writer-lease' },
    );
  }

  const captureResourceKey = workspace?.physicalKey ? `workspace:${workspace.physicalKey}` : '';
  const capture = async (captureBody) => {
    if (!captureResourceKey) return captureBody();
    const runMutation = typeof deps.executeMutation === 'function' ? deps.executeMutation : executeMutation;
    const { result } = await runMutation({
      workspaceId: workspace?.id,
      runId: '',
      resourceKeys: [captureResourceKey],
      mode: 'read',
      ttlMs: 15_000,
      hardTtlMs: 60_000,
      mutate: captureBody,
      deps,
    });
    return result;
  };
  return capture(async () => {
      const packets = [];
      for (const runId of normalizedRunIds) {
        const packet = await createExecutionPacket({
          runId,
          projectId: resolvedProjectId,
          taskId,
          attemptId,
          now,
          deps,
        });
        if (trimString(packet.producer?.projectId) && trimString(packet.producer.projectId) !== resolvedProjectId) {
          throw createWorkflowError(
            `Run ${runId} belongs to a different project`,
            'RUN_PROJECT_MISMATCH',
            400,
            { runId, projectId: resolvedProjectId, actualProjectId: packet.producer.projectId },
          );
        }
        packets.push(packet);
      }
      if (packets.length === 0) {
        throw createWorkflowError('no source Runs selected by the checkpoint', 'EINVAL');
      }

      const ordered = [...packets].sort((a, b) =>
        (a.createdAt === b.createdAt
          ? (a.packetId < b.packetId ? -1 : a.packetId > b.packetId ? 1 : 0)
          : (a.createdAt < b.createdAt ? -1 : 1)));
      const previousRevision = typeof deps.previousCheckpointRevision === 'function'
        ? await deps.previousCheckpointRevision(resolvedProjectId)
        : await findPreviousCheckpointRevision(resolvedProjectId);

      const checkpoint = normalizeResultPacket({
        kind: 'project_checkpoint',
        state: aggregateState(ordered),
        producer: {
          projectId: resolvedProjectId,
          taskId: trimString(taskId),
          attemptId: trimString(attemptId),
          sessionId: '',
          runId: '',
        },
        // ResultPacket v2 additive org/phase context (constitution §7) — only
        // from explicit caller options; the checkpoint aggregates canonical
        // child packets and never copies Agent-report private fields.
        organizationId,
        nodeId,
        revision,
        phaseId,
        parentPacketIds: ordered.map((packet) => packet.packetId),
        summary: boundedSummary(ordered),
        changedFiles: uniqueBy(ordered.flatMap((packet) => packet.changedFiles || [])),
        artifacts: uniqueBy(ordered.flatMap((packet) => packet.artifacts || [])),
        tests: uniqueBy(ordered.flatMap((packet) => packet.tests || [])),
        acceptanceResults: uniqueBy(ordered.flatMap((packet) => packet.acceptanceResults || [])),
        decisions: uniqueBy(ordered.flatMap((packet) => packet.decisions || [])),
        blockers: uniqueBy(ordered.flatMap((packet) => packet.blockers || [])),
        risks: uniqueBy(ordered.flatMap((packet) => packet.risks || [])),
        openQuestions: uniqueBy(ordered.flatMap((packet) => packet.openQuestions || [])),
        usage: aggregateUsage(ordered),
        provenance: {
          executionScopeDigest: '',
          baseRevision: previousRevision || ordered[0].provenance?.baseRevision || {},
          resultRevision: mergeRevisionField({}, ordered[ordered.length - 1].provenance?.resultRevision),
          sourceSessionIds: uniqueBy(ordered.flatMap((packet) => packet.provenance?.sourceSessionIds || [])),
          sourceRunIds: uniqueBy(ordered.flatMap((packet) => packet.provenance?.sourceRunIds || [])),
          inputPacketIds: uniqueBy(ordered.map((packet) => packet.packetId)),
        },
        createdAt: now,
      });

      const stored = await withDatabase((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (trimString(requestId)) {
            const existing = db.prepare(`
              SELECT result_json FROM workflow_idempotency
              WHERE request_id = ? AND kind = 'checkpoint'
            `).get(trimString(requestId));
            if (existing) {
              db.exec('COMMIT');
              return JSON.parse(existing.result_json);
            }
          }
          insertPacketRow(db, checkpoint);
          if (trimString(requestId)) {
            db.prepare(`
              INSERT INTO workflow_idempotency (request_id, kind, target_id, result_json, created_at)
              VALUES (?, 'checkpoint', ?, ?, ?)
            `).run(trimString(requestId), checkpoint.packetId, JSON.stringify(checkpoint), checkpoint.createdAt);
          }
          db.exec('COMMIT');
          return checkpoint;
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
      });
        return stored;
  });
}

/** Read a stored packet. Returns a fresh object; packets are immutable. */
export async function getResultPacket(packetId, { deps = {} } = {}) {
  const normalized = trimString(packetId);
  if (!normalized) return null;
  return withDatabase((db) => rowToPacket(
    db.prepare('SELECT * FROM result_packets WHERE packet_id = ?').get(normalized),
  ));
}

export async function listExecutionPacketsForRuns(runIds, { deps = {} } = {}) {
  const normalized = [...new Set((Array.isArray(runIds) ? runIds : []).map((id) => trimString(id)).filter(Boolean))];
  if (normalized.length === 0) return [];
  const placeholders = normalized.map(() => '?').join(',');
  return withDatabase((db) => db.prepare(
    `SELECT * FROM result_packets WHERE run_id IN (${placeholders}) ORDER BY created_at, packet_id`,
  ).all(...normalized).map(rowToPacket).filter(Boolean));
}

/**
 * Stable cursor pagination for project checkpoints: createdAt DESC,
 * packetId DESC, never offset. cursor is base64url of [createdAt, packetId].
 */
export async function listProjectCheckpoints(projectId, { cursor = null, limit = 20, deps = {} } = {}) {
  const normalizedProjectId = trimString(projectId);
  const pageSize = Math.min(Math.max(Number.isInteger(limit) ? limit : 20, 1), 100);
  let bound = null;
  if (typeof cursor === 'string' && cursor.trim()) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor.trim(), 'base64url').toString('utf8'));
      if (Array.isArray(decoded) && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') {
        bound = { createdAt: decoded[0], packetId: decoded[1] };
      }
    } catch {
      throw createWorkflowError('Invalid checkpoint cursor', 'EINVAL');
    }
  }
  const rows = await withDatabase((db) => {
    if (!bound) {
      return db.prepare(`
        SELECT * FROM result_packets
        WHERE project_id = ? AND kind = 'project_checkpoint'
        ORDER BY created_at DESC, packet_id DESC LIMIT ?
      `).all(normalizedProjectId, pageSize + 1);
    }
    return db.prepare(`
      SELECT * FROM result_packets
      WHERE project_id = ? AND kind = 'project_checkpoint'
        AND (created_at < ? OR (created_at = ? AND packet_id < ?))
      ORDER BY created_at DESC, packet_id DESC LIMIT ?
    `).all(normalizedProjectId, bound.createdAt, bound.createdAt, bound.packetId, pageSize + 1);
  });
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize).map(rowToPacket).filter(Boolean);
  const last = page[page.length - 1];
  return {
    checkpoints: page,
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify([last.createdAt, last.packetId]), 'utf8').toString('base64url')
      : null,
  };
}

/** Close pooled handles (used by tests). */
export async function closeResultPacketStore() {
  // node:sqlite connections are per-call; nothing to close.
  return true;
}
