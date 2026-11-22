import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR } from '../lib/config.mjs';
import { read, transaction, newId, now, digest, error } from './responsibility-store.mjs';
import {
  getResponsibility,
  listResponsibilities,
  listResponsibilityActivity,
  listResponsibilityWorkLinks,
} from './responsibility-service.mjs';
import { listResponsibilityPlans } from './responsibility-plans.mjs';
import {
  listOwnerEpisodicMemory,
  listResponsibilityMemoryConflicts,
} from './responsibility-memory.mjs';
import { getSession } from './session-manager.mjs';
import { getRun } from './runs.mjs';
import { getResultPacket } from './result-packets.mjs';

const VOICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS responsibility_voice_sessions (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  responsibility_id TEXT NOT NULL DEFAULT '',
  root_session_id TEXT NOT NULL DEFAULT '',
  active_device_id TEXT NOT NULL DEFAULT '',
  active_device_type TEXT NOT NULL DEFAULT 'unknown',
  active_device_label TEXT NOT NULL DEFAULT '',
  asr_engine_id TEXT NOT NULL DEFAULT 'local',
  reasoner_engine_id TEXT NOT NULL DEFAULT 'deterministic-butler',
  tts_engine_id TEXT NOT NULL DEFAULT 'client-tts',
  language TEXT NOT NULL DEFAULT 'zh-CN',
  state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','listening','thinking','speaking','interrupted','awaiting_approval','closed')),
  turn_seq INTEGER NOT NULL DEFAULT 0,
  playback_generation INTEGER NOT NULL DEFAULT 0,
  active_turn_id TEXT NOT NULL DEFAULT '',
  last_interrupted_generation INTEGER NOT NULL DEFAULT 0,
  context_summary_json TEXT NOT NULL DEFAULT '{}',
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_turn_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_resp_voice_sessions_owner
  ON responsibility_voice_sessions(owner_principal_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_resp_voice_sessions_resp
  ON responsibility_voice_sessions(owner_principal_id, responsibility_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS responsibility_voice_turns (
  id TEXT PRIMARY KEY,
  voice_session_id TEXT NOT NULL REFERENCES responsibility_voice_sessions(id) ON DELETE CASCADE,
  owner_principal_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  playback_generation INTEGER NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT 'unknown',
  responsibility_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('speaking','completed','interrupted','asr_failed','clarification_required','requires_visual_approval','draft_prepared')),
  intent TEXT NOT NULL DEFAULT '',
  asr_json TEXT NOT NULL DEFAULT '{}',
  transcript TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL DEFAULT '',
  tts_json TEXT NOT NULL DEFAULT '{}',
  approval_card_json TEXT,
  draft_json TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  interrupted_at TEXT,
  interrupt_reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(voice_session_id, turn_seq)
);
CREATE INDEX IF NOT EXISTS idx_resp_voice_turns_session_seq
  ON responsibility_voice_turns(voice_session_id, turn_seq ASC);

CREATE TABLE IF NOT EXISTS responsibility_voice_handoffs (
  id TEXT PRIMARY KEY,
  voice_session_id TEXT NOT NULL REFERENCES responsibility_voice_sessions(id) ON DELETE CASCADE,
  owner_principal_id TEXT NOT NULL,
  from_device_id TEXT NOT NULL DEFAULT '',
  from_device_type TEXT NOT NULL DEFAULT '',
  to_device_id TEXT NOT NULL,
  to_device_type TEXT NOT NULL,
  to_device_label TEXT NOT NULL DEFAULT '',
  responsibility_id TEXT NOT NULL DEFAULT '',
  root_session_id TEXT NOT NULL DEFAULT '',
  turn_seq INTEGER NOT NULL,
  playback_generation INTEGER NOT NULL,
  handoff_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resp_voice_handoffs_session
  ON responsibility_voice_handoffs(voice_session_id, created_at DESC);
`;

const DEFAULT_MIN_ASR_CONFIDENCE = 0.55;
const DEVICE_TYPES = new Set(['android', 'desktop', 'web', 'cli', 'other', 'unknown']);
const activeTtsControllers = new Map();

function text(value, max = 0) {
  const s = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? s.slice(0, max) : s;
}

function parseJson(raw, fallback = null) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

function ensureVoiceButlerSchema(db) {
  db.exec(VOICE_SCHEMA);
}

function assertOwnerActor(actor) {
  if (actor?.kind !== 'user' || actor?.role !== 'owner' || !text(actor?.principalId, 256)) {
    throw error('Owner access required', 403, 'RESPONSIBILITY_FORBIDDEN');
  }
  return text(actor.principalId, 256);
}

function normalizeDeviceType(value) {
  const lower = text(value, 32).toLowerCase();
  if (DEVICE_TYPES.has(lower)) return lower;
  if (lower === 'win32' || lower === 'windows' || lower === 'macos' || lower === 'darwin' || lower === 'linux') {
    return 'desktop';
  }
  if (lower === 'mobile' || lower === 'phone') return 'android';
  return 'unknown';
}

function resolveMinAsrConfidence(value) {
  const envRaw = Number(process.env.RAGENT_VOICE_MIN_ASR_CONFIDENCE);
  const base = Number.isFinite(envRaw) && envRaw >= 0.1 && envRaw <= 0.99 ? envRaw : DEFAULT_MIN_ASR_CONFIDENCE;
  if (value === undefined || value === null || value === '') return base;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0.05 || num > 0.99) {
    throw error('minConfidence must be between 0.05 and 0.99', 400, 'VOICE_INVALID_INPUT');
  }
  return num;
}

function computeStopStatus(workRow) {
  const blockedReason = parseJson(workRow.blocked_json, null);
  if (blockedReason?.code === 'completed_pending_review' || workRow.binding_status === 'finished') {
    return 'completed_pending_review';
  }
  if (workRow.binding_status === 'stopped' || (workRow.state === 'cancelled' && !workRow.active_binding)) {
    return 'stopped';
  }
  if (workRow.control_state === 'cancel_requested') return 'cancel_requested_pending';
  if (workRow.control_state === 'pause_requested') return 'pause_requested_pending';
  if (workRow.control_state === 'paused') return 'paused';
  return 'none';
}

function computeIsUnknownOutcome(workRow, remoteOp = null) {
  const blocked = parseJson(workRow.blocked_json, null);
  if (
    workRow.binding_status === 'unknown'
    || workRow.attempt_failure_kind === 'unknown_outcome'
    || (workRow.binding_status === 'intent' && !workRow.binding_run_id && workRow.state === 'blocked')
  ) {
    return true;
  }
  if (remoteOp && remoteOp.offline_state === 'dispatched_unconfirmed') {
    return true;
  }
  const code = text(blocked?.code, 120);
  if (code === 'unknown_outcome' || code === 'reconciliation_unknown') {
    return true;
  }
  return false;
}

function readConnectorLedgerEntriesSafe() {
  const ledgerPath = join(CONFIG_DIR, 'connector-action-ledger.sqlite');
  if (!existsSync(ledgerPath)) return [];
  let db = null;
  try {
    db = new DatabaseSync(ledgerPath, { readOnly: true, timeout: 5000 });
    if (!tableExists(db, 'connector_action_ledger')) return [];
    const rows = db.prepare(`
      SELECT * FROM connector_action_ledger
      WHERE state IN ('pending_approval', 'unknown_outcome', 'failed_pre_dispatch', 'conflict')
      ORDER BY updated_at DESC
      LIMIT 100
    `).all();
    return rows.map((row) => ({
      idempotencyKey: row.idempotency_key,
      capability: row.capability,
      connectorId: row.connector_id,
      riskLevel: row.risk_level,
      confirmationPolicy: row.confirmation_policy,
      scope: parseJson(row.scope_json, {}),
      requestDigest: row.request_digest,
      state: row.state,
      deliveryState: row.delivery_state,
      wireCrossed: row.wire_crossed === 1,
      safeToRetry: row.safe_to_retry === 1,
      approvalId: row.approval_id || '',
      errorCode: row.error_code || '',
      errorMessage: row.error_message || '',
      updatedAt: row.updated_at,
    }));
  } catch {
    return [];
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

function resolveWorkItemAttemptInTx(db, workItemId, binding = null) {
  if (!tableExists(db, 'collaboration_attempts')) return null;
  if (binding?.attempt_id) {
    const byId = db.prepare('SELECT id, state, failure_kind, failure_reason, result_packet_id, run_id FROM collaboration_attempts WHERE id=?').get(binding.attempt_id);
    if (byId) return byId;
  }
  if (tableExists(db, 'collaboration_dispatch_commands')) {
    const cmd = binding?.collaboration_id
      ? db.prepare('SELECT attempt_id FROM collaboration_dispatch_commands WHERE collaboration_id=? AND task_id=? ORDER BY created_at DESC LIMIT 1').get(binding.collaboration_id, workItemId)
      : db.prepare('SELECT attempt_id FROM collaboration_dispatch_commands WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(workItemId);
    if (cmd?.attempt_id) {
      const byCmd = db.prepare('SELECT id, state, failure_kind, failure_reason, result_packet_id, run_id FROM collaboration_attempts WHERE id=? AND task_id=?').get(cmd.attempt_id, workItemId);
      if (byCmd) return byCmd;
    }
  }
  return db.prepare(`
    SELECT id, state, failure_kind, failure_reason, result_packet_id, run_id
    FROM collaboration_attempts
    WHERE task_id=?
    ORDER BY attempt_number DESC, rowid DESC
    LIMIT 1
  `).get(workItemId) || null;
}

function loadLinkedWorkInTx(db, responsibilityRow) {
  if (!tableExists(db, 'factory_work_items')) return [];
  const hasPlans = tableExists(db, 'responsibility_plan_executions');
  const hasCandidates = tableExists(db, 'factory_candidates');
  const hasMilestones = tableExists(db, 'factory_delivery_milestones');
  const hasRemote = tableExists(db, 'remote_factory_source_operations');
  const goalsSql = hasPlans
    ? 'SELECT goal_id FROM responsibility_work_links WHERE responsibility_id=? UNION SELECT e.goal_id FROM responsibility_plan_executions e JOIN responsibility_plans p ON p.id=e.plan_id WHERE p.responsibility_id=?'
    : 'SELECT goal_id FROM responsibility_work_links WHERE responsibility_id=?';
  const items = db.prepare(`
    SELECT w.*,
      EXISTS(
        SELECT 1 FROM factory_execution_bindings b
        WHERE b.work_item_id=w.id AND b.status IN ('intent','running','unknown')
      ) AS active_binding
    FROM factory_work_items w
    WHERE w.organization_id=? AND w.project_id=? AND w.goal_id IN (${goalsSql})
    ORDER BY w.updated_at DESC, w.id DESC
  `).all(
    ...(hasPlans
      ? [responsibilityRow.organization_id, responsibilityRow.project_id, responsibilityRow.id, responsibilityRow.id]
      : [responsibilityRow.organization_id, responsibilityRow.project_id, responsibilityRow.id]),
  );

  return items.map((w) => {
    const binding = db.prepare(`
      SELECT * FROM factory_execution_bindings
      WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?
    `).get(w.id, w.contract_revision, w.execution_epoch, w.binding_generation);
    const attempt = resolveWorkItemAttemptInTx(db, w.id, binding);
    const contractRow = db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(w.id, w.contract_revision);
    const contract = parseJson(contractRow?.contract_json, {});
    const candidate = hasCandidates
      ? db.prepare(`
          SELECT * FROM factory_candidates
          WHERE work_item_id=? AND contract_revision=? AND execution_epoch=?
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(w.id, w.contract_revision, w.execution_epoch)
      : null;
    const milestone = hasMilestones
      ? db.prepare(`
          SELECT * FROM factory_delivery_milestones
          WHERE work_item_id=?
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(w.id)
      : null;
    const remoteOp = hasRemote && binding?.id
      ? db.prepare('SELECT * FROM remote_factory_source_operations WHERE source_factory_binding_id=?').get(binding.id)
      : null;

    return {
      ...w,
      contract,
      binding_id: binding?.id || null,
      binding_status: binding?.status || null,
      binding_run_id: binding?.run_id || null,
      binding_details: parseJson(binding?.details_json, {}),
      attempt_state: attempt?.state || null,
      attempt_failure_kind: attempt?.failure_kind || null,
      attempt_failure_reason: attempt?.failure_reason || null,
      attempt_packet_id: attempt?.result_packet_id || null,
      candidate: candidate ? {
        id: candidate.id,
        digest: candidate.digest,
        details: parseJson(candidate.details_json, {}),
        createdAt: candidate.created_at,
      } : null,
      milestone: milestone ? {
        id: milestone.id,
        milestone: milestone.milestone,
        target: milestone.target,
        candidateDigest: milestone.candidate_digest,
        resultDigest: milestone.result_digest,
        evidence: parseJson(milestone.evidence_json, {}),
        createdAt: milestone.created_at,
      } : null,
      remoteOp,
    };
  });
}

function makeOverviewItem({
  itemId,
  itemType,
  bucket,
  responsibility,
  title,
  summary,
  status,
  state,
  controlState = 'none',
  stopStatus = 'none',
  isUnknownOutcome = false,
  severity = 'info',
  updatedAt,
  diagnostics = null,
  artifact = null,
  actionTarget = null,
}) {
  return {
    itemId,
    itemType,
    bucket,
    responsibilityId: responsibility?.id || null,
    organizationId: responsibility?.organization_id || responsibility?.organizationId || null,
    projectId: responsibility?.project_id || responsibility?.projectId || null,
    responsibilityObjective: responsibility?.objective || '',
    responsibilityLifecycle: responsibility?.lifecycle || null,
    responsibilityRowVersion: responsibility?.row_version ?? responsibility?.rowVersion ?? null,
    title,
    summary,
    status,
    state,
    controlState,
    stopStatus,
    isUnknownOutcome: Boolean(isUnknownOutcome),
    severity,
    updatedAt: updatedAt || now(),
    diagnostics,
    artifact,
    actionTarget,
  };
}

/**
 * Converged 4-bucket overview for the Voice & Mobile Butler:
 * - inProgress
 * - awaitingDecision
 * - deliveredArtifacts
 * - blockedAndAlerts
 * Strictly derived from real persisted stores without optimistic fabrication.
 */
export async function getButlerOverview({ organizationId = '', projectId = '', limit = 100 } = {}, actor) {
  const principalId = assertOwnerActor(actor);
  const orgFilter = text(organizationId, 160);
  const projectFilter = text(projectId, 160);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));

  const rawOverview = await read((db) => {
    ensureVoiceButlerSchema(db);
    const respRows = db.prepare(`
      SELECT r.* FROM responsibilities r
      JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id
      WHERE r.owner_principal_id=?
        AND (?='' OR r.organization_id=?)
        AND (?='' OR r.project_id=?)
      ORDER BY r.updated_at DESC, r.id ASC
      LIMIT ?
    `).all(principalId, orgFilter, orgFilter, projectFilter, projectFilter, boundedLimit);

    const hasPlanExecutions = tableExists(db, 'responsibility_plan_executions');
    const hasEpisodic = tableExists(db, 'episodic_memory_records');

    const perResponsibility = [];
    for (const r of respRows) {
      const workItems = loadLinkedWorkInTx(db, r);
      const plans = db.prepare('SELECT * FROM responsibility_plans WHERE responsibility_id=? ORDER BY created_at DESC LIMIT 50').all(r.id).map((p) => {
        const approval = db.prepare('SELECT * FROM responsibility_plan_approvals WHERE plan_id=? ORDER BY created_at DESC LIMIT 1').get(p.id);
        const executions = hasPlanExecutions
          ? db.prepare('SELECT step_id, goal_id, workflow_instance_id FROM responsibility_plan_executions WHERE plan_id=? ORDER BY rowid').all(p.id)
          : [];
        const dispatchRetry = db.prepare('SELECT reason, next_retry_at FROM responsibility_plan_dispatch_retry WHERE plan_id=?').get(p.id);
        return {
          ...p,
          proposal: parseJson(p.proposal_json, null),
          approval,
          admitted: executions.length > 0,
          executions,
          dispatchBlockedReason: dispatchRetry?.reason || null,
          dispatchNextRetryAt: dispatchRetry?.next_retry_at || null,
          state: executions.length ? 'admitted' : approval ? 'approved' : 'pending_review',
        };
      });
      const activeWakes = db.prepare(`
        SELECT w.*, o.kind AS observation_kind
        FROM responsibility_wakes w
        LEFT JOIN responsibility_observations o ON o.wake_id=w.id
        WHERE w.responsibility_id=? AND w.state IN ('pending','waiting','deciding')
        ORDER BY w.updated_at DESC LIMIT 10
      `).all(r.id);
      const latestOutcome = db.prepare(`
        SELECT * FROM responsibility_planning_outcomes
        WHERE responsibility_id=?
        ORDER BY created_at DESC LIMIT 1
      `).get(r.id);
      const recentActivity = db.prepare(`
        SELECT * FROM responsibility_activity
        WHERE responsibility_id=?
        ORDER BY sequence DESC LIMIT 15
      `).all(r.id).map((a) => ({
        ...a,
        details: parseJson(a.details_json, {}),
      }));
      const episodes = hasEpisodic
        ? db.prepare(`
            SELECT * FROM episodic_memory_records
            WHERE owner_principal_id=? AND responsibility_id=? AND status='active'
            ORDER BY occurred_at DESC LIMIT 15
          `).all(principalId, r.id).map((e) => ({
            ...e,
            artifactLinks: parseJson(e.artifact_links_json, []),
          }))
        : [];
      perResponsibility.push({
        responsibility: r,
        workItems,
        plans,
        activeWakes,
        latestOutcome,
        recentActivity,
        episodes,
      });
    }
    const allOwnedRows = db.prepare('SELECT id FROM responsibilities WHERE owner_principal_id=?').all(principalId);
    const ownedRespIds = new Set(allOwnedRows.map((x) => x.id));
    return { perResponsibility, ownedRespIds };
  });

  const { perResponsibility: rawOverviewList, ownedRespIds } = rawOverview;
  const inProgress = [];
  const awaitingDecision = [];
  const deliveredArtifacts = [];
  const blockedAndAlerts = [];
  const seenIds = new Set();

  const pushUnique = (bucketList, item) => {
    if (seenIds.has(item.itemId)) return;
    seenIds.add(item.itemId);
    bucketList.push(item);
  };

  for (const entry of rawOverviewList) {
    const {
      responsibility: r,
      workItems,
      plans,
      activeWakes,
      latestOutcome,
      recentActivity,
      episodes,
    } = entry;

    const latestFailureEpisode = episodes.find((e) => ['failed', 'blocked', 'unknown_outcome'].includes(e.outcome)) || null;

    // 1. Plans awaiting approval, admission-blocked, or approved awaiting admission
    for (const plan of plans) {
      const currentAuthority = r.lifecycle === 'active'
        && r.revision === plan.responsibility_revision
        && r.policy_revision === plan.policy_revision;
      if (plan.dispatchBlockedReason && currentAuthority) {
        pushUnique(blockedAndAlerts, makeOverviewItem({
          itemId: `plan_blocked:${plan.id}`,
          itemType: 'plan',
          bucket: 'blockedAndAlerts',
          responsibility: r,
          title: `Plan admission blocked: ${plan.id}`,
          summary: `Plan ${plan.id} failed admission (${plan.dispatchBlockedReason}).`,
          status: 'plan_admission_blocked',
          state: 'blocked',
          severity: 'warning',
          updatedAt: plan.dispatchNextRetryAt || plan.created_at,
          diagnostics: {
            code: plan.dispatchBlockedReason,
            message: `Plan admission blocked: ${plan.dispatchBlockedReason}`,
            rootCause: plan.dispatchBlockedReason,
            repairAttempt: null,
            safeToRetry: true,
            requiresVerification: false,
          },
        }));
      } else if (plan.state === 'pending_review' && currentAuthority) {
        const stepsCount = Array.isArray(plan.proposal?.steps) ? plan.proposal.steps.length : 0;
        pushUnique(awaitingDecision, makeOverviewItem({
          itemId: `plan:${plan.id}`,
          itemType: 'plan',
          bucket: 'awaitingDecision',
          responsibility: r,
          title: `Plan awaiting approval (${stepsCount} step${stepsCount === 1 ? '' : 's'})`,
          summary: `Responsibility "${r.objective}" has a proposed plan (${plan.id}) awaiting owner approval.`,
          status: 'pending_review',
          state: 'pending_review',
          severity: 'warning',
          updatedAt: plan.created_at,
          actionTarget: {
            kind: 'plan_approval',
            planId: plan.id,
            proposalDigest: plan.proposal_digest,
            workItemId: null,
            approvalId: null,
            conflictGroupId: null,
            expectedVersion: r.row_version,
            target: plan.id,
            impactSummary: `Approve ${stepsCount}-step execution plan for "${r.objective}"`,
            confirmationPath: `/api/responsibilities/${encodeURIComponent(r.id)}/plans/${encodeURIComponent(plan.id)}/approve`,
            confirmationMethod: 'POST',
          },
        }));
      } else if (plan.state === 'approved' && !plan.admitted && currentAuthority) {
        pushUnique(inProgress, makeOverviewItem({
          itemId: `plan_admitting:${plan.id}`,
          itemType: 'plan',
          bucket: 'inProgress',
          responsibility: r,
          title: `Approved plan queued for admission`,
          summary: `Plan ${plan.id} is approved and awaiting Factory admission.`,
          status: 'approved_pending_admission',
          state: 'approved',
          severity: 'info',
          updatedAt: plan.approval?.created_at || plan.created_at,
        }));
      }
    }

    // 2. Linked Work Items (unknown_outcome, blocked/failed, review, completed artifacts, active execution)
    let hasRunningOrActiveWork = false;
    let hasBlockedOrFailedWork = false;
    let hasCompletedWork = false;

    for (const w of workItems) {
      const blockedReason = parseJson(w.blocked_json, null);
      const stopStatus = computeStopStatus(w);
      const isUnknownOutcome = computeIsUnknownOutcome(w, w.remoteOp);
      const itemTitle = text(w.contract?.objective, 160) || `${w.kind} work item ${w.id}`;
      const matchedEpisode = episodes.find((e) => e.work_item_id === w.id) || latestFailureEpisode;

      if (isUnknownOutcome) {
        hasBlockedOrFailedWork = true;
        const reasonMsg = w.remoteOp?.offline_state === 'dispatched_unconfirmed'
          ? 'Remote execution was dispatched before disconnect and remains unconfirmed (unknown_outcome). Query receipt before any retry.'
          : (w.attempt_failure_reason || blockedReason?.code || 'Execution boundary crossed with unverified outcome (unknown_outcome). Do not blindly replay.');
        pushUnique(blockedAndAlerts, makeOverviewItem({
          itemId: `work:${w.id}`,
          itemType: 'work_item',
          bucket: 'blockedAndAlerts',
          responsibility: r,
          title: itemTitle,
          summary: reasonMsg,
          status: 'unknown_outcome',
          state: w.state,
          controlState: w.control_state,
          stopStatus,
          isUnknownOutcome: true,
          severity: 'critical',
          updatedAt: w.updated_at,
          diagnostics: {
            code: blockedReason?.code || w.attempt_failure_kind || 'unknown_outcome',
            message: reasonMsg,
            rootCause: matchedEpisode?.failure_root_cause || w.attempt_failure_reason || 'Execution outcome could not be verified across crash or network boundary.',
            repairAttempt: matchedEpisode?.repair_attempt || null,
            safeToRetry: false,
            requiresVerification: true,
          },
          actionTarget: {
            kind: 'unknown_outcome_reconcile',
            planId: null,
            proposalDigest: null,
            workItemId: w.id,
            approvalId: null,
            conflictGroupId: null,
            expectedVersion: w.row_version,
            target: w.id,
            impactSummary: `Verify or reconcile unconfirmed execution ${w.id} before any retry`,
            confirmationPath: `/api/organizations/${encodeURIComponent(r.organization_id)}/factory/work-items/${encodeURIComponent(w.id)}/reconcile`,
            confirmationMethod: 'GET',
          },
        }));
        continue;
      }

      if (w.state === 'review' || stopStatus === 'completed_pending_review') {
        const packetId = w.candidate?.details?.packetId || w.binding_details?.packetId || w.attempt_packet_id || null;
        pushUnique(awaitingDecision, makeOverviewItem({
          itemId: `work_review:${w.id}`,
          itemType: 'work_item',
          bucket: 'awaitingDecision',
          responsibility: r,
          title: itemTitle,
          summary: stopStatus === 'completed_pending_review'
            ? `Execution completed before pause/cancel and awaits owner review.`
            : `Candidate ready for owner review and acceptance.`,
          status: stopStatus === 'completed_pending_review' ? 'completed_pending_review' : 'awaiting_acceptance',
          state: w.state,
          controlState: w.control_state,
          stopStatus,
          severity: 'warning',
          updatedAt: w.updated_at,
          actionTarget: {
            kind: 'manual_acceptance',
            planId: null,
            proposalDigest: null,
            workItemId: w.id,
            approvalId: null,
            conflictGroupId: null,
            expectedVersion: w.row_version,
            target: w.id,
            impactSummary: `Review candidate ${w.candidate_digest || packetId || w.id} for "${itemTitle}"`,
            confirmationPath: `/api/organizations/${encodeURIComponent(r.organization_id)}/factory/work-items/${encodeURIComponent(w.id)}/accept`,
            confirmationMethod: 'POST',
          },
        }));
        continue;
      }

      if (w.state === 'completed') {
        hasCompletedWork = true;
        const packetId = w.candidate?.details?.packetId || w.binding_details?.packetId || w.attempt_packet_id || null;
        let packet = null;
        if (packetId) {
          try {
            packet = await getResultPacket(packetId);
          } catch {}
        }
        const artifactLinks = Array.isArray(packet?.artifacts)
          ? packet.artifacts.map((a) => (typeof a === 'string' ? a : a?.path || a?.uri || a?.name)).filter(Boolean)
          : (matchedEpisode?.artifactLinks || []);
        const summaryText = text(packet?.summary, 400)
          || (w.milestone ? `Delivered (${w.milestone.milestone}) to ${w.milestone.target}` : `Completed work item ${w.id}`);
        pushUnique(deliveredArtifacts, makeOverviewItem({
          itemId: `artifact:${w.id}`,
          itemType: 'work_item',
          bucket: 'deliveredArtifacts',
          responsibility: r,
          title: itemTitle,
          summary: summaryText,
          status: w.milestone?.milestone || 'accepted',
          state: w.state,
          controlState: w.control_state,
          stopStatus,
          severity: 'info',
          updatedAt: w.milestone?.createdAt || w.updated_at,
          artifact: {
            packetId: packet?.packetId || packetId || null,
            candidateDigest: w.candidate_digest || w.candidate?.digest || w.milestone?.candidateDigest || null,
            milestone: w.milestone?.milestone || 'accepted',
            target: w.milestone?.target || w.contract?.candidateScope || r.project_id,
            summary: summaryText,
            artifactLinks,
            deliveredAt: w.milestone?.createdAt || w.updated_at,
          },
        }));
        continue;
      }

      if (w.state === 'failed' || w.state === 'blocked') {
        hasBlockedOrFailedWork = true;
        const code = blockedReason?.code || w.attempt_failure_kind || (w.state === 'failed' ? 'execution_failed' : 'blocked');
        const rootCause = matchedEpisode?.failure_root_cause
          || w.attempt_failure_reason
          || blockedReason?.message
          || (code === 'budget_reservation_failed' ? 'Admission budget reservation rejected (no provider cap assumed).' : `Work item ${w.state}: ${code}`);
        pushUnique(blockedAndAlerts, makeOverviewItem({
          itemId: `work:${w.id}`,
          itemType: 'work_item',
          bucket: 'blockedAndAlerts',
          responsibility: r,
          title: itemTitle,
          summary: rootCause,
          status: w.state,
          state: w.state,
          controlState: w.control_state,
          stopStatus,
          severity: w.state === 'failed' ? 'critical' : 'warning',
          updatedAt: w.updated_at,
          diagnostics: {
            code,
            message: rootCause,
            rootCause,
            repairAttempt: matchedEpisode?.repair_attempt || null,
            safeToRetry: code !== 'budget_reservation_failed',
            requiresVerification: false,
          },
        }));
        continue;
      }

      if (['proposed', 'ready', 'claimed', 'running'].includes(w.state) || w.active_binding) {
        hasRunningOrActiveWork = true;
        const activeStatus = stopStatus === 'cancel_requested_pending'
          ? 'cancelling_pending'
          : stopStatus === 'pause_requested_pending'
            ? 'pausing_pending'
            : w.state;
        pushUnique(inProgress, makeOverviewItem({
          itemId: `work_active:${w.id}`,
          itemType: 'work_item',
          bucket: 'inProgress',
          responsibility: r,
          title: itemTitle,
          summary: stopStatus === 'cancel_requested_pending'
            ? 'Cancellation requested; execution has not yet confirmed stopped.'
            : stopStatus === 'pause_requested_pending'
              ? 'Pause requested; awaiting run yield confirmation.'
              : `Work item is currently ${w.state}.`,
          status: activeStatus,
          state: w.state,
          controlState: w.control_state,
          stopStatus,
          severity: 'info',
          updatedAt: w.updated_at,
        }));
      }
    }

    // 3. Planning outcomes (needs_input / invalid_output)
    if (latestOutcome) {
      const hasNewerPlan = plans.some((p) => p.created_at > latestOutcome.created_at);
      if (!hasNewerPlan && r.lifecycle === 'active') {
        const payload = parseJson(latestOutcome.reason, {});
        if (latestOutcome.kind === 'needs_input') {
          pushUnique(awaitingDecision, makeOverviewItem({
            itemId: `outcome:${latestOutcome.wake_id}`,
            itemType: 'planning_outcome',
            bucket: 'awaitingDecision',
            responsibility: r,
            title: `Input needed: ${r.objective}`,
            summary: text(payload?.question || payload?.reason, 400) || 'Planner requires owner input to proceed.',
            status: 'needs_user_input',
            state: 'needs_input',
            severity: 'warning',
            updatedAt: latestOutcome.created_at,
            actionTarget: {
              kind: 'planning_input',
              planId: null,
              proposalDigest: null,
              workItemId: null,
              approvalId: null,
              conflictGroupId: null,
              expectedVersion: r.row_version,
              target: r.id,
              impactSummary: text(payload?.requiredInput || payload?.question, 300),
              confirmationPath: `/api/responsibilities/${encodeURIComponent(r.id)}/wake`,
              confirmationMethod: 'POST',
            },
          }));
        } else if (latestOutcome.kind === 'invalid_output') {
          pushUnique(blockedAndAlerts, makeOverviewItem({
            itemId: `outcome:${latestOutcome.wake_id}`,
            itemType: 'planning_outcome',
            bucket: 'blockedAndAlerts',
            responsibility: r,
            title: `Planner output rejected: ${r.objective}`,
            summary: text(payload?.reason, 400) || 'Planner output did not satisfy authorized catalog/schema.',
            status: 'planning_invalid_output',
            state: 'invalid_output',
            severity: 'warning',
            updatedAt: latestOutcome.created_at,
            diagnostics: {
              code: 'planning_invalid_output',
              message: text(payload?.reason, 400) || 'Planner output rejected',
              rootCause: text(payload?.reason, 400),
              repairAttempt: null,
              safeToRetry: true,
              requiresVerification: false,
            },
          }));
        }
      }
    }

    // 4. Recent unresolved responsibility-level blocker activity (when no work item already surfaced it)
    const latestAlertAct = recentActivity.find((a) => [
      'budget_blocked',
      'planning_evidence_blocked',
      'plan_admission_blocked',
      'execution_attempt_failed',
    ].includes(a.type));
    if (latestAlertAct && !hasBlockedOrFailedWork && !hasCompletedWork) {
      const reason = text(latestAlertAct.details?.reason, 300) || latestAlertAct.type;
      pushUnique(blockedAndAlerts, makeOverviewItem({
        itemId: `activity_alert:${r.id}:${latestAlertAct.sequence}`,
        itemType: 'responsibility',
        bucket: 'blockedAndAlerts',
        responsibility: r,
        title: `Alert on ${r.objective}`,
        summary: `Recent event ${latestAlertAct.type}: ${reason}`,
        status: latestAlertAct.type,
        state: 'alert',
        severity: latestAlertAct.type === 'execution_attempt_failed' ? 'critical' : 'warning',
        updatedAt: latestAlertAct.created_at,
        diagnostics: {
          code: latestAlertAct.type,
          message: reason,
          rootCause: latestFailureEpisode?.failure_root_cause || reason,
          repairAttempt: latestFailureEpisode?.repair_attempt || null,
          safeToRetry: true,
          requiresVerification: false,
        },
      }));
    }

    // 5. Episodic artifacts when not represented by completed work items
    if (!hasCompletedWork) {
      for (const ep of episodes) {
        if (!['succeeded', 'repaired'].includes(ep.outcome) || !ep.artifactLinks.length) continue;
        pushUnique(deliveredArtifacts, makeOverviewItem({
          itemId: `episode_artifact:${ep.id}`,
          itemType: 'work_item',
          bucket: 'deliveredArtifacts',
          responsibility: r,
          title: r.objective,
          summary: ep.summary,
          status: ep.outcome,
          state: 'completed',
          severity: 'info',
          updatedAt: ep.occurred_at,
          artifact: {
            packetId: ep.packet_id || null,
            candidateDigest: null,
            milestone: 'accepted',
            target: ep.artifactLinks[0] || r.project_id,
            summary: ep.summary,
            artifactLinks: ep.artifactLinks,
            deliveredAt: ep.occurred_at,
          },
        }));
      }
    }

    // 6. Unreviewed memory conflicts on active/paused responsibilities
    if (['active', 'paused'].includes(r.lifecycle)) {
      try {
        const conflictData = await listResponsibilityMemoryConflicts(r.id, actor);
        for (const group of conflictData?.groups || []) {
          if (group.reviewed) continue;
          pushUnique(awaitingDecision, makeOverviewItem({
            itemId: `memory_conflict:${r.id}:${group.groupId}`,
            itemType: 'memory_conflict',
            bucket: 'awaitingDecision',
            responsibility: r,
            title: `Memory conflict needs review (${group.factKey || group.groupId})`,
            summary: group.conflictReason || 'Candidate semantic or cross-layer memory conflict flagged for human review.',
            status: 'memory_conflict_unreviewed',
            state: 'pending_review',
            severity: 'warning',
            updatedAt: r.updated_at,
            actionTarget: {
              kind: 'memory_conflict',
              planId: null,
              proposalDigest: null,
              workItemId: null,
              approvalId: null,
              conflictGroupId: group.groupId,
              expectedVersion: r.row_version,
              target: group.groupId,
              impactSummary: group.conflictReason || 'Review conflicting memory facts',
              confirmationPath: `/api/responsibilities/${encodeURIComponent(r.id)}/memory/conflicts/commit`,
              confirmationMethod: 'POST',
            },
          }));
        }
      } catch {
        // Concurrent memory read conflict must not break overview rendering.
      }
    }

    // 7. Responsibility-level lifecycle placements
    if (r.lifecycle === 'draft') {
      pushUnique(awaitingDecision, makeOverviewItem({
        itemId: `resp_draft:${r.id}`,
        itemType: 'responsibility',
        bucket: 'awaitingDecision',
        responsibility: r,
        title: r.objective,
        summary: 'Draft responsibility awaits policy review and activation.',
        status: 'draft_awaiting_activation',
        state: 'draft',
        severity: 'info',
        updatedAt: r.updated_at,
        actionTarget: {
          kind: 'responsibility_activation',
          planId: null,
          proposalDigest: null,
          workItemId: null,
          approvalId: null,
          conflictGroupId: null,
          expectedVersion: r.row_version,
          target: r.id,
          impactSummary: `Activate draft responsibility "${r.objective}"`,
          confirmationPath: `/api/responsibilities/${encodeURIComponent(r.id)}/resume`,
          confirmationMethod: 'POST',
        },
      }));
    } else if (r.lifecycle === 'active') {
      if (!hasRunningOrActiveWork) {
        const hasPendingWake = activeWakes.length > 0;
        pushUnique(inProgress, makeOverviewItem({
          itemId: `resp_active:${r.id}`,
          itemType: 'responsibility',
          bucket: 'inProgress',
          responsibility: r,
          title: r.objective,
          summary: hasPendingWake
            ? `Active wake (${activeWakes[0].state}) queued for observation and planning.`
            : 'Active responsibility continuously monitoring triggers and workspace changes.',
          status: hasPendingWake ? `wake_${activeWakes[0].state}` : 'monitoring',
          state: 'active',
          severity: 'info',
          updatedAt: activeWakes[0]?.updated_at || r.updated_at,
        }));
      }
    } else if (r.lifecycle === 'paused') {
      if (!hasRunningOrActiveWork && !hasBlockedOrFailedWork) {
        pushUnique(awaitingDecision, makeOverviewItem({
          itemId: `resp_paused:${r.id}`,
          itemType: 'responsibility',
          bucket: 'awaitingDecision',
          responsibility: r,
          title: r.objective,
          summary: 'Responsibility is paused; new admission is stopped. Resume or archive when ready.',
          status: 'paused_awaiting_decision',
          state: 'paused',
          stopStatus: 'paused',
          severity: 'info',
          updatedAt: r.updated_at,
          actionTarget: {
            kind: 'responsibility_resume',
            planId: null,
            proposalDigest: null,
            workItemId: null,
            approvalId: null,
            conflictGroupId: null,
            expectedVersion: r.row_version,
            target: r.id,
            impactSummary: `Resume paused responsibility "${r.objective}"`,
            confirmationPath: `/api/responsibilities/${encodeURIComponent(r.id)}/resume`,
            confirmationMethod: 'POST',
          },
        }));
      }
    } else if (r.lifecycle === 'completed' && !hasCompletedWork) {
      pushUnique(deliveredArtifacts, makeOverviewItem({
        itemId: `resp_completed:${r.id}`,
        itemType: 'responsibility',
        bucket: 'deliveredArtifacts',
        responsibility: r,
        title: r.objective,
        summary: 'Responsibility completed and accepted by owner.',
        status: 'completed',
        state: 'completed',
        severity: 'info',
        updatedAt: r.updated_at,
        artifact: {
          packetId: null,
          candidateDigest: null,
          milestone: 'accepted',
          target: r.project_id,
          summary: 'Responsibility objective marked completed.',
          artifactLinks: [],
          deliveredAt: r.updated_at,
        },
      }));
    }
  }

  // 8. Surface Stage 4 connector ledger pending approvals & unknown_outcome alerts
  const connectorEntries = readConnectorLedgerEntriesSafe();
  for (const conn of connectorEntries) {
    const scopeOrg = text(conn.scope?.organizationId, 160);
    const scopeProj = text(conn.scope?.projectId, 160);
    const scopeResp = text(conn.scope?.responsibilityId, 160);
    const scopeOwner = text(conn.scope?.ownerPrincipalId || conn.scope?.actorId, 256);
    if (scopeOwner && scopeOwner !== principalId) continue;
    if (scopeResp && !ownedRespIds.has(scopeResp)) continue;
    if (orgFilter && scopeOrg !== orgFilter) continue;
    if (projectFilter && scopeProj !== projectFilter) continue;

    const syntheticResp = {
      id: text(conn.scope?.responsibilityId, 160) || null,
      organization_id: scopeOrg || null,
      project_id: scopeProj || null,
      objective: `${conn.connectorId}: ${conn.capability}`,
      lifecycle: null,
      row_version: null,
    };

    if (conn.state === 'pending_approval') {
      pushUnique(awaitingDecision, makeOverviewItem({
        itemId: `connector:${conn.idempotencyKey}`,
        itemType: 'connector_action',
        bucket: 'awaitingDecision',
        responsibility: syntheticResp,
        title: `Connector approval required: ${conn.capability}`,
        summary: `External connector action (${conn.connectorId} · ${conn.riskLevel}) requires explicit owner approval.`,
        status: 'pending_approval',
        state: conn.state,
        severity: 'warning',
        updatedAt: conn.updatedAt,
        actionTarget: {
          kind: 'connector_approval',
          planId: null,
          proposalDigest: conn.requestDigest,
          workItemId: null,
          approvalId: conn.approvalId || conn.idempotencyKey,
          conflictGroupId: null,
          expectedVersion: null,
          target: conn.capability,
          impactSummary: `${conn.capability} (${conn.riskLevel})`,
          confirmationPath: null,
          confirmationMethod: null,
        },
      }));
    } else {
      const isUnknown = conn.state === 'unknown_outcome';
      pushUnique(blockedAndAlerts, makeOverviewItem({
        itemId: `connector:${conn.idempotencyKey}`,
        itemType: 'connector_action',
        bucket: 'blockedAndAlerts',
        responsibility: syntheticResp,
        title: isUnknown ? `Unverified connector outcome: ${conn.capability}` : `Connector blocked: ${conn.capability}`,
        summary: conn.errorMessage || (isUnknown
          ? `Connector action ${conn.capability} crossed wire without verified receipt (unknown_outcome). Verify external receipt before retry.`
          : `Connector action ${conn.capability} is in state ${conn.state}.`),
        status: conn.state,
        state: conn.state,
        isUnknownOutcome: isUnknown,
        severity: isUnknown ? 'critical' : 'warning',
        updatedAt: conn.updatedAt,
        diagnostics: {
          code: conn.errorCode || conn.state,
          message: conn.errorMessage || conn.state,
          rootCause: conn.errorMessage || null,
          repairAttempt: null,
          safeToRetry: conn.safeToRetry,
          requiresVerification: isUnknown,
        },
      }));
    }
  }

  const sortNewest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  inProgress.sort(sortNewest);
  awaitingDecision.sort(sortNewest);
  deliveredArtifacts.sort(sortNewest);
  blockedAndAlerts.sort(sortNewest);

  const unknownOutcomeCount = blockedAndAlerts.filter((item) => item.isUnknownOutcome).length;
  return {
    schemaVersion: 1,
    asOf: now(),
    counts: {
      inProgress: inProgress.length,
      awaitingDecision: awaitingDecision.length,
      deliveredArtifacts: deliveredArtifacts.length,
      blockedAndAlerts: blockedAndAlerts.length,
      unknownOutcomeCount,
      total: inProgress.length + awaitingDecision.length + deliveredArtifacts.length + blockedAndAlerts.length,
    },
    inProgress,
    awaitingDecision,
    deliveredArtifacts,
    blockedAndAlerts,
  };
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
}

/**
 * Built-in local/client ASR adapter: validates client-supplied transcript &
 * confidence or rejects missing/unconfigured raw audio without inventing text.
 */
export const localPassthroughAsrAdapter = {
  id: 'local',
  mode: 'local',
  providerKind: 'client_or_local_asr',
  supportsStreaming: false,
  async transcribe(input = {}, options = {}) {
    const minConfidence = resolveMinAsrConfidence(options.minConfidence);
    const engineId = text(input.engineId, 80) || 'local';
    const mode = text(input.mode, 16).toLowerCase() === 'cloud' ? 'cloud' : 'local';
    const language = text(input.language, 32) || text(options.language, 32) || 'zh-CN';
    const statusRaw = text(input.status, 32).toLowerCase();
    const errorCode = text(input.errorCode, 80) || null;
    const errorMessage = text(input.errorMessage, 400) || null;

    if (errorCode || ['failed', 'error', 'asr_failed', 'asr_error', 'timeout', 'unavailable'].includes(statusRaw)) {
      return {
        ok: false,
        status: 'asr_error',
        transcript: '',
        confidence: null,
        language,
        engineId,
        mode,
        errorCode: errorCode || 'ASR_RECOGNITION_FAILED',
        errorMessage: errorMessage || 'Speech recognition failed. Please repeat your request.',
      };
    }

    const transcript = text(input.transcript, 4000);
    if (!transcript) {
      const hasAudio = Boolean(input.audioBase64 || input.audioBuffer);
      return {
        ok: false,
        status: hasAudio ? 'asr_error' : 'empty_transcript',
        transcript: '',
        confidence: null,
        language,
        engineId,
        mode,
        errorCode: hasAudio ? 'ASR_AUDIO_DECODER_UNCONFIGURED' : 'ASR_EMPTY_TRANSCRIPT',
        errorMessage: hasAudio
          ? 'No server audio ASR decoder is configured for raw audio payload.'
          : 'No speech transcript was recognized. Please try speaking again.',
      };
    }

    const confidence = normalizeConfidence(input.confidence);
    if (Number.isNaN(confidence)) {
      return {
        ok: false,
        status: 'asr_error',
        transcript: '',
        confidence: null,
        language,
        engineId,
        mode,
        errorCode: 'ASR_INVALID_CONFIDENCE',
        errorMessage: 'Speech recognition confidence score was invalid.',
      };
    }
    if (confidence !== null && confidence < minConfidence) {
      return {
        ok: false,
        status: 'low_confidence',
        transcript,
        confidence,
        language,
        engineId,
        mode,
        errorCode: 'ASR_LOW_CONFIDENCE',
        errorMessage: `Speech recognition confidence (${confidence.toFixed(2)}) is below threshold (${minConfidence.toFixed(2)}).`,
      };
    }

    return {
      ok: true,
      status: 'ok',
      transcript,
      confidence,
      language,
      engineId,
      mode,
      errorCode: null,
      errorMessage: null,
    };
  },
};

function splitTtsSegments(content) {
  const cleaned = text(content, 8000);
  if (!cleaned) return [];
  const parts = cleaned
    .split(/(?<=[。！？.!?\n])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [cleaned];
}

/**
 * Built-in client-delegated streaming TTS adapter: emits cancellable text chunks
 * with generation fencing so Android TextToSpeech or Desktop Web Speech can stop immediately on barge-in.
 */
export const clientStreamingTtsAdapter = {
  id: 'client-tts',
  mode: 'local',
  providerKind: 'client_tts_stream',
  supportsStreaming: true,
  async *synthesizeStream({ text: content, language = 'zh-CN', voice = '' } = {}, { signal } = {}) {
    const segments = splitTtsSegments(content);
    for (let i = 0; i < segments.length; i += 1) {
      if (signal?.aborted) return;
      yield {
        chunkIndex: i,
        text: segments[i],
        audioChunkBase64: null,
        mimeType: null,
        language,
        voice: text(voice, 80),
        isFinal: i === segments.length - 1,
        engineId: 'client-tts',
        mode: 'local',
      };
    }
  },
};

const READ_DIAGNOSTIC_PATTERNS = [
  /为什么|为啥|原因|根因|为何|怎么回事|发生了什么|查一下|查看|查询|告诉我|汇报|进展|进度|状态|总览|概览|有哪些|有什么|待决定|待审批|等待确认|产出|成果|报告/u,
  /\b(?:why|what happened|what failed|root cause|diagnose|explain|status|progress|overview|summary|list|show|tell me|check|artifacts?|deliverables?|pending approvals?|pending decisions?|blocked|alerts?)\b/i,
];

const HIGH_RISK_ACTION_RULES = [
  {
    kind: 'privilege_escalation',
    riskLevel: 'privilege_escalation',
    actionKind: 'privilege_escalation',
    pattern: /(?:提权|提升[^\n.!?。！？]{0,12}权限|管理员权限|关闭沙箱|绕过审批|授予[^\n.!?。！？]{0,12}权限|sudo|privilege|escalat|disable(?:\s+[a-z0-9_-]+){0,3}\s+sandbox|bypass(?:\s+[a-z0-9_-]+){0,3}\s+approval|grant(?:\s+[a-z0-9_-]+){0,3}\s+(?:admin|permission|privilege)|elevate)/iu,
    title: 'Privilege or permission boundary change',
  },
  {
    kind: 'code_merge',
    riskLevel: 'irreversible_write',
    actionKind: 'code_merge',
    pattern: /(?:合并[^\n.!?。！？]{0,16}(?:pr|pull\s*request|代码|分支)|合入[^\n.!?。！？]{0,16}(?:pr|分支|代码)|提交[^\n.!?。！？]{0,12}pr|推送[^\n.!?。！？]{0,12}代码|强推|\bmerge(?:\s+[a-z0-9_-]+){0,4}\s+(?:pr|pull\s+request|branch|code)\b|\bgit\s+push\b|\bforce\s+push\b|\bcreate(?:\s+[a-z0-9_-]+){0,3}\s+pr\b)/iu,
    title: 'Code merge or repository push',
  },
  {
    kind: 'external_send',
    riskLevel: 'external_broadcast',
    actionKind: 'external_send',
    pattern: /(?:发(?:个|封|一封|条|一条|送)?[^\n.!?。！？]{0,12}(?:邮件|email|gmail|消息|通知)|群发|对外发送|发给|发送[^\n.!?。！？]{0,12}gmail|\bsend(?:\s+[a-z0-9_-]+){0,4}\s+(?:email|mail|message|reply|broadcast)\b|\breply\s+to\s+all\b|\bpublish\s+externally\b)/iu,
    title: 'External message or email broadcast',
  },
  {
    kind: 'plan_approval',
    riskLevel: 'irreversible_write',
    actionKind: 'approve_plan',
    pattern: /(?:批准[^\n.!?。！？]{0,16}计划|审批通过|通过[^\n.!?。！？]{0,16}计划|确认[^\n.!?。！？]{0,16}计划|批准执行|同意执行|\bapprove(?:\s+[a-z0-9_-]+){0,4}\s+plan\b|\bconfirm(?:\s+[a-z0-9_-]+){0,4}\s+plan\b|\badmit(?:\s+[a-z0-9_-]+){0,4}\s+plan\b)/iu,
    title: 'Execution plan approval',
  },
  {
    kind: 'responsibility_lifecycle',
    riskLevel: 'reversible_write',
    actionKind: 'lifecycle_change',
    pattern: /(?:暂停|恢复运行|恢复[^\n.!?。！？]{0,16}责任|立即唤醒|唤醒|取消[^\n.!?。！？]{0,16}责任|取消任务|终止|完成[^\n.!?。！？]{0,16}责任|归档|\bpause\b|\bresume\b|\bwake\b|\bcancel\b|\bcomplete(?:\s+[a-z0-9_-]+){0,3}\s+(?:responsibility|task)\b|\barchive\b)/iu,
    title: 'Responsibility lifecycle change',
  },
  {
    kind: 'write_action',
    riskLevel: 'irreversible_write',
    actionKind: 'write_action',
    pattern: /(?:删除[^\n.!?。！？]{0,16}文件|清空|修改[^\n.!?。！？]{0,16}(?:文件|配置|代码)|写入[^\n.!?。！？]{0,16}文件|执行命令|运行部署|发布版本|\bdeploy\b|\brelease\b|\bdelete(?:\s+[a-z0-9_-]+){0,4}\s+file\b|\bremove(?:\s+[a-z0-9_-]+){0,4}\s+file\b|\bwrite(?:\s+[a-z0-9_-]+){0,4}\s+file\b|\bmodify(?:\s+[a-z0-9_-]+){0,3}\s+code\b|\bexecute\s+now\b)/iu,
    title: 'Write or state-mutating action',
  },
];

const DRAFT_PATTERN = /(?:起草|草稿|拟定|新建一个责任草稿|draft\s+(?:a\s+)?(?:responsibility|action|plan|email|message)|prepare\s+a\s+draft)/iu;

function extractLifecycleAction(utterance) {
  if (/(?:暂停|pause)/iu.test(utterance)) return 'pause';
  if (/(?:恢复|resume)/iu.test(utterance)) return 'resume';
  if (/(?:唤醒|wake)/iu.test(utterance)) return 'wake';
  if (/(?:完成|complete)/iu.test(utterance)) return 'complete';
  if (/(?:取消|终止|cancel)/iu.test(utterance)) return 'cancel';
  if (/(?:归档|archive)/iu.test(utterance)) return 'archive';
  return 'update';
}

function isPureReadQuestion(utterance) {
  const trimmed = text(utterance, 4000);
  if (!trimmed) return false;
  // Never treat imperative cues or compound read+action clauses as pure read questions.
  const hasImperativeOrCompoundCue = /(?:帮我|请|立刻|马上|现在|去|把|给我|想要|同意|执行|并且|顺便|然后|并(?=[去把批准合并发暂停恢复唤醒取消完成归档])|please|can you|could you|would you|let's|go ahead|now\b|execute|do it|\band\b|\bthen\b|\balso\b|&&|;|；)/iu.test(trimmed);
  if (hasImperativeOrCompoundCue) return false;
  // Strict explanatory diagnostic question about a past failure/block ("为什么上次合并 PR 失败了？", "Why did email send fail?")
  const isExplanatoryFailureQuestion = /(?:为什么|为啥|为何|原因|根因|why\s+(?:did|was|were|is)|what\s+caused|how\s+come).*(?:失败|阻塞|出错|卡住|被暂停|需要审批|fail|failed|error|block|blocked|reject|rejected)/iu.test(trimmed);
  if (isExplanatoryFailureQuestion) return true;
  // Strict standalone listing query ("有哪些待审批的计划？", "List pending approvals") without command verbs
  const isPureListQuery = /^(?:查看|显示|列出|有哪些|有什么|show|list|check|what\s+(?:are|is))\s+(?:所有|当前|the\s+)?(?:待审批|待确认|待决定|阻塞|异常|失败|pending\s+approvals?|pending\s+decisions?|blocked|failures?)(?:的?(?:计划|事项|任务))?[?？。.\s]*$/iu.test(trimmed);
  return isPureListQuery;
}

function buildApprovalCard({
  kind,
  riskLevel,
  actionKind,
  title,
  utterance,
  responsibilitySnapshot,
}) {
  const resp = responsibilitySnapshot?.responsibility || null;
  const pendingPlan = responsibilitySnapshot?.pendingPlans?.[0] || null;
  const blockedWork = responsibilitySnapshot?.workSummary?.find((w) => w.isUnknownOutcome || w.state === 'failed' || w.state === 'blocked') || null;

  let target = resp ? `${resp.id} (${resp.objective})` : 'unspecified_target';
  let impactSummary = `Voice request requires explicit visual confirmation before executing ${actionKind}.`;
  let diffSummary = `Requested via voice: "${utterance}"`;
  let planId = null;
  let proposalDigest = null;
  let workItemId = blockedWork?.workItemId || null;
  let confirmationEndpoint = null;

  if (kind === 'plan_approval' && resp) {
    if (pendingPlan) {
      planId = pendingPlan.id;
      proposalDigest = pendingPlan.proposalDigest;
      target = `Plan ${pendingPlan.id} on ${resp.id}`;
      impactSummary = `Approve and queue plan ${pendingPlan.id} (${Array.isArray(pendingPlan.proposal?.steps) ? pendingPlan.proposal.steps.length : 0} step(s)) for "${resp.objective}".`;
      diffSummary = `proposalDigest=${pendingPlan.proposalDigest}; responsibilityVersion=${resp.rowVersion}`;
      confirmationEndpoint = {
        method: 'POST',
        path: `/api/responsibilities/${encodeURIComponent(resp.id)}/plans/${encodeURIComponent(pendingPlan.id)}/approve`,
        bodyTemplate: {
          expectedVersion: resp.rowVersion,
          proposalDigest: pendingPlan.proposalDigest,
          confirmed: true,
        },
      };
    } else {
      target = `No pending plan on ${resp.id}`;
      impactSummary = `No pending_review plan exists on "${resp.objective}" to approve.`;
    }
  } else if (kind === 'responsibility_lifecycle' && resp) {
    const lcAction = extractLifecycleAction(utterance);
    target = `Responsibility ${resp.id} -> ${lcAction}`;
    impactSummary = `Transition responsibility "${resp.objective}" (current: ${resp.lifecycle}, version ${resp.rowVersion}) with action "${lcAction}".`;
    diffSummary = `lifecycle: ${resp.lifecycle} -> action=${lcAction} (expectedVersion=${resp.rowVersion})`;
    confirmationEndpoint = {
      method: 'POST',
      path: `/api/responsibilities/${encodeURIComponent(resp.id)}/${encodeURIComponent(lcAction)}`,
      bodyTemplate: {
        expectedVersion: resp.rowVersion,
        confirmed: true,
        ...(lcAction === 'pause' || lcAction === 'cancel' ? { stopExisting: false } : {}),
      },
    };
  } else if (kind === 'code_merge') {
    target = resp ? `Code merge / push on project ${resp.projectId}` : 'Repository merge / push';
    impactSummary = 'Code merge, PR submission, or branch push alters repository history and requires visual diff & branch review.';
  } else if (kind === 'external_send') {
    target = resp ? `External communication scoped to ${resp.id}` : 'External email / message broadcast';
    impactSummary = 'External transmission leaves the Ragent boundary and cannot be rolled back once delivered.';
  } else if (kind === 'privilege_escalation') {
    target = resp ? `Privilege boundary for ${resp.id}` : 'Instance / sandbox privilege boundary';
    impactSummary = 'Privilege elevation or sandbox relaxation is forbidden via voice and requires explicit visual security confirmation.';
  }

  const actionPayload = {
    kind,
    actionKind,
    utterance,
    responsibilityId: resp?.id || null,
    expectedVersion: resp?.rowVersion ?? null,
    planId,
    proposalDigest,
    workItemId,
  };

  return {
    schemaVersion: 1,
    approvalId: newId('vapp'),
    kind,
    title,
    target,
    impactSummary,
    diffSummary,
    actionDigest: digest(actionPayload),
    responsibilityId: resp?.id || null,
    expectedVersion: resp?.rowVersion ?? null,
    planId,
    proposalDigest,
    workItemId,
    connectorId: null,
    riskLevel,
    confirmationPolicy: 'require_visual_approval',
    confirmationEndpoint,
    requiresExplicitConfirm: true,
    executableViaVoice: false,
    status: 'pending_visual_confirmation',
    createdAt: now(),
  };
}

function summarizeSnapshotForSpeech(snapshot, overview, utterance, historyTurns = []) {
  const resp = snapshot?.responsibility || null;
  const isFailureQuery = /(?:为什么|为啥|失败|报错|异常|阻塞|卡住|根因|错误|why|fail|error|block|unknown|cause|issue)/iu.test(utterance);
  const isArtifactQuery = /(?:产出|成果|报告|交付|结果|artifact|deliver|report|output|result)/iu.test(utterance);
  const isDecisionQuery = /(?:待审批|待决定|审批|决定|确认|pending|approval|decision|review)/iu.test(utterance);
  const isOverviewQuery = !resp || /(?:总览|概览|全局|所有责任|全部|哪些事|overview|summary|everything|all responsibilities)/iu.test(utterance);

  if (isFailureQuery && resp) {
    const diags = snapshot.failureDiagnostics || [];
    const unknownItems = diags.filter((d) => d.isUnknownOutcome);
    if (unknownItems.length) {
      const first = unknownItems[0];
      return `责任“${resp.objective}”存在 ${unknownItems.length} 项未确认结果（unknown_outcome）：${first.message}。系统禁止盲目重放，请先核实外部回执或人工核对后再决定。`;
    }
    if (diags.length) {
      const top = diags[0];
      const repairNote = top.repairAttempt ? ` 已记录修复建议：${top.repairAttempt}。` : '';
      return `责任“${resp.objective}”当前有 ${diags.length} 条异常记录。主要原因为 ${top.code || 'failure'}：${top.rootCause || top.message}。${repairNote}`;
    }
    return `责任“${resp.objective}”当前生命周期为 ${resp.lifecycle}，暂未记录失败或阻塞项。`;
  }

  if (isArtifactQuery && resp) {
    const artifacts = snapshot.deliveredArtifacts || [];
    if (!artifacts.length) {
      return `责任“${resp.objective}”目前暂无已交付产物。`;
    }
    const first = artifacts[0];
    return `责任“${resp.objective}”已有 ${artifacts.length} 项已交付产物，最新为 ${first.title}（${first.milestone}）：${first.summary}`;
  }

  if (isDecisionQuery && resp) {
    const pendingPlans = snapshot.pendingPlans || [];
    if (pendingPlans.length) {
      return `责任“${resp.objective}”有 ${pendingPlans.length} 个待审批计划（最新 ${pendingPlans[0].id}）。如需批准，请在可视化审批卡片中确认。`;
    }
    if (overview?.awaitingDecision?.length) {
      return `当前共有 ${overview.awaitingDecision.length} 项待决定事项，首项为：${overview.awaitingDecision[0].title}。`;
    }
    return `责任“${resp.objective}”当前没有待审批的计划。`;
  }

  if (isOverviewQuery && overview) {
    const c = overview.counts;
    const alertHint = c.unknownOutcomeCount > 0
      ? `其中包含 ${c.unknownOutcomeCount} 项未确认结果（unknown_outcome），需优先核实。`
      : '';
    return `当前管家总览：正在推进 ${c.inProgress} 项，待您决定 ${c.awaitingDecision} 项，已交付成果 ${c.deliveredArtifacts} 项，阻塞与异常 ${c.blockedAndAlerts} 项。${alertHint}`;
  }

  if (resp) {
    const work = snapshot.workSummary || [];
    const activeCount = work.filter((w) => ['ready', 'claimed', 'running', 'proposed'].includes(w.state)).length;
    const unknownCount = work.filter((w) => w.isUnknownOutcome).length;
    const failedCount = work.filter((w) => w.state === 'failed' || (w.state === 'blocked' && !w.isUnknownOutcome)).length;
    const pendingPlanCount = (snapshot.pendingPlans || []).length;
    const lastTurnNote = historyTurns.length ? `（已延续第 ${historyTurns.length + 1} 轮上下文）` : '';
    const parts = [
      `责任“${resp.objective}”当前状态为 ${resp.lifecycle}（版本 ${resp.rowVersion}）${lastTurnNote}`,
      `关联工作项 ${work.length} 个（推进中 ${activeCount}，待审批计划 ${pendingPlanCount}，异常/阻塞 ${failedCount}，未确认结果 ${unknownCount}）`,
    ];
    if (unknownCount > 0) {
      parts.push('注意：存在 unknown_outcome 项，不能直接重放，请先核实状态');
    } else if ((snapshot.failureDiagnostics || []).length > 0) {
      parts.push(`最近诊断：${snapshot.failureDiagnostics[0].rootCause || snapshot.failureDiagnostics[0].message}`);
    }
    return `${parts.join('。')}。`;
  }

  return '我是 Ragent 语音管家。你可以询问任意责任的进度、失败原因、待审批事项或已交付成果。';
}

/**
 * Built-in grounded deterministic butler reasoner.
 * Uses real persisted responsibility state, episodic diagnostics, and multi-turn history.
 */
export const deterministicButlerReasonerAdapter = {
  id: 'deterministic-butler',
  mode: 'deterministic',
  providerKind: 'grounded_butler',
  model: '',
  supportsTools: false,
  async reason({ utterance, responsibilitySnapshot, butlerOverview, historyTurns = [] } = {}) {
    const trimmed = text(utterance, 4000);

    // 1. Check high-risk write / external send / merge / privilege / approval requests first.
    for (const rule of HIGH_RISK_ACTION_RULES) {
      if (rule.pattern.test(trimmed) && !isPureReadQuestion(trimmed, rule)) {
        return {
          intent: rule.actionKind,
          riskLevel: rule.riskLevel,
          actionKind: rule.actionKind,
          requiresVisualApproval: true,
          approvalKind: rule.kind,
          approvalTitle: rule.title,
          responseText: `该操作（${rule.title}）涉及状态变更或高风险边界，语音模式不会自动执行。已为您生成可视化审批卡片，请核对影响对象与摘要后手动确认。`,
          model: '',
          engineId: 'deterministic-butler',
          mode: 'deterministic',
        };
      }
    }

    // 2. Check non-executing draft creation.
    if (DRAFT_PATTERN.test(trimmed)) {
      const objectiveDraft = trimmed
        .replace(/^(?:请|帮我)?(?:起草|拟定|新建一个责任草稿|准备草稿|draft\s+(?:a\s+)?(?:responsibility|action|plan|email|message)|prepare\s+a\s+draft)[:：]?\s*/iu, '')
        .trim() || trimmed;
      return {
        intent: 'draft_responsibility',
        riskLevel: 'draft',
        actionKind: 'create_draft',
        requiresVisualApproval: false,
        draft: {
          schemaVersion: 1,
          kind: 'responsibility_draft',
          objective: objectiveDraft,
          responsibilityId: responsibilitySnapshot?.responsibility?.id || null,
          executable: false,
          requiresReview: true,
        },
        responseText: `已为您整理草稿：“${objectiveDraft}”。该草稿尚未提交或授予任何执行权限，请在界面中审阅后再确认创建。`,
        model: '',
        engineId: 'deterministic-butler',
        mode: 'deterministic',
      };
    }

    // 3. Read-only grounded diagnostic / status / overview / artifact response.
    const isFailureQuery = /(?:为什么|为啥|失败|报错|异常|阻塞|根因|why|fail|error|block|unknown|cause)/iu.test(trimmed);
    const isOverviewQuery = !responsibilitySnapshot?.responsibility || /(?:总览|概览|overview|summary)/iu.test(trimmed);
    const intent = isFailureQuery
      ? 'query_failure'
      : isOverviewQuery
        ? 'query_overview'
        : historyTurns.length > 0
          ? 'follow_up'
          : 'query_status';

    return {
      intent,
      riskLevel: 'read',
      actionKind: null,
      requiresVisualApproval: false,
      responseText: summarizeSnapshotForSpeech(responsibilitySnapshot, butlerOverview, trimmed, historyTurns),
      model: '',
      engineId: 'deterministic-butler',
      mode: 'deterministic',
    };
  },
};

/**
 * Deterministic safety guard applied AFTER any reasoning adapter output.
 * Ensures no LLM/custom reasoner can bypass visual approval or execute writes via voice.
 */
function enforceVoiceSafetyPolicy({ utterance, reasonerOutput, responsibilitySnapshot }) {
  for (const rule of HIGH_RISK_ACTION_RULES) {
    if (rule.pattern.test(utterance) && !isPureReadQuestion(utterance, rule)) {
      const approvalCard = buildApprovalCard({
        kind: rule.kind,
        riskLevel: rule.riskLevel,
        actionKind: rule.actionKind,
        title: rule.title,
        utterance,
        responsibilitySnapshot,
      });
      return {
        outcome: 'requires_visual_approval',
        safetyDecision: 'visual_approval_required',
        intent: rule.actionKind,
        responseText: text(reasonerOutput?.responseText, 2000)
          || `该操作（${rule.title}）需要显式可视化审批，语音不会自动执行。请核对审批卡片后确认。`,
        approvalCard,
        draft: null,
      };
    }
  }

  const READ_OR_DRAFT_ACTIONS = new Set([
    '', 'read', 'query', 'query_status', 'query_failure', 'query_overview',
    'query_artifacts', 'query_decisions', 'follow_up', 'clarify',
    'create_draft', 'draft', 'draft_responsibility',
  ]);
  const proposedOutcome = text(reasonerOutput?.outcome, 60).toLowerCase();
  const proposedRisk = text(reasonerOutput?.riskLevel, 40).toLowerCase();
  const proposedActionKind = text(reasonerOutput?.actionKind, 60).toLowerCase();
  const proposedHighRisk = reasonerOutput?.requiresVisualApproval === true
    || proposedOutcome === 'requires_visual_approval'
    || ['high', 'critical', 'write', 'external', 'high_risk', 'high_risk_write', 'reversible_write', 'irreversible_write', 'external_broadcast', 'privilege_escalation'].includes(proposedRisk)
    || (proposedActionKind !== '' && !READ_OR_DRAFT_ACTIONS.has(proposedActionKind));

  if (proposedHighRisk) {
    const kind = text(reasonerOutput?.approvalKind, 60) || 'write_action';
    const actionKind = text(reasonerOutput?.actionKind, 60) || 'write_action';
    const riskLevel = ['reversible_write', 'irreversible_write', 'external_broadcast', 'privilege_escalation'].includes(proposedRisk)
      ? proposedRisk
      : 'irreversible_write';
    const approvalCard = buildApprovalCard({
      kind,
      riskLevel,
      actionKind,
      title: text(reasonerOutput?.approvalTitle, 160) || 'Visual approval required',
      utterance,
      responsibilitySnapshot,
    });
    return {
      outcome: 'requires_visual_approval',
      safetyDecision: 'visual_approval_required',
      intent: text(reasonerOutput?.intent, 80) || actionKind,
      responseText: text(reasonerOutput?.responseText, 2000)
        || '该高风险或写操作需要可视化确认卡片批准，语音模式不会自动执行。',
      approvalCard,
      draft: null,
    };
  }

  if (reasonerOutput?.draft && typeof reasonerOutput.draft === 'object') {
    return {
      outcome: 'draft_prepared',
      safetyDecision: 'draft_only_no_execute',
      intent: text(reasonerOutput?.intent, 80) || 'draft_responsibility',
      responseText: text(reasonerOutput?.responseText, 2000) || '已生成待审阅草稿，不会自动执行。',
      approvalCard: null,
      draft: {
        ...reasonerOutput.draft,
        executable: false,
        requiresReview: true,
      },
    };
  }

  return {
    outcome: 'answered',
    safetyDecision: 'read_only_allowed',
    intent: text(reasonerOutput?.intent, 80) || 'query_status',
    responseText: text(reasonerOutput?.responseText, 2000) || '已完成只读状态查询。',
    approvalCard: null,
    draft: null,
  };
}

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    organizationId: row.organization_id || '',
    projectId: row.project_id || '',
    responsibilityId: row.responsibility_id || '',
    rootSessionId: row.root_session_id || '',
    activeDeviceId: row.active_device_id || '',
    activeDeviceType: row.active_device_type || 'unknown',
    activeDeviceLabel: row.active_device_label || '',
    asrEngineId: row.asr_engine_id || 'local',
    reasonerEngineId: row.reasoner_engine_id || 'deterministic-butler',
    ttsEngineId: row.tts_engine_id || 'client-tts',
    language: row.language || 'zh-CN',
    state: row.state,
    turnSeq: Number(row.turn_seq || 0),
    playbackGeneration: Number(row.playback_generation || 0),
    activeTurnId: row.active_turn_id || '',
    lastInterruptedGeneration: Number(row.last_interrupted_generation || 0),
    contextSummary: parseJson(row.context_summary_json, {}),
    rowVersion: Number(row.row_version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTurnAt: row.last_turn_at || null,
  };
}

function mapTurnRow(row) {
  if (!row) return null;
  const asr = parseJson(row.asr_json, {});
  const ttsStream = parseJson(row.tts_json, { chunks: [], interrupted: false, completed: false });
  const diagnostics = parseJson(row.diagnostics_json, {});
  return {
    id: row.id,
    voiceSessionId: row.voice_session_id,
    sessionId: row.voice_session_id,
    turnSeq: Number(row.turn_seq),
    playbackGeneration: Number(row.playback_generation),
    deviceId: row.device_id || '',
    deviceType: row.device_type || 'unknown',
    responsibilityId: row.responsibility_id || '',
    status: row.status,
    outcome: row.status === 'completed' ? 'answered' : row.status,
    safetyDecision: diagnostics?.safetyDecision || 'read_only_allowed',
    intent: row.intent || '',
    transcript: row.transcript || '',
    confidence: asr?.confidence ?? null,
    asrStatus: asr?.status || '',
    responseText: row.response_text || '',
    asr,
    ttsStream,
    interrupted: Boolean(ttsStream?.interrupted || row.status === 'interrupted'),
    approvalCard: parseJson(row.approval_card_json, null),
    draft: parseJson(row.draft_json, null),
    diagnostics,
    interruptedAt: row.interrupted_at || null,
    interruptReason: row.interrupt_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHandoffRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    voiceSessionId: row.voice_session_id,
    sessionId: row.voice_session_id,
    fromDeviceId: row.from_device_id || '',
    fromDeviceType: row.from_device_type || '',
    toDeviceId: row.to_device_id,
    toDeviceType: row.to_device_type,
    toDeviceLabel: row.to_device_label || '',
    responsibilityId: row.responsibility_id || '',
    rootSessionId: row.root_session_id || '',
    turnSeq: Number(row.turn_seq),
    turnSeqAtHandoff: Number(row.turn_seq),
    playbackGeneration: Number(row.playback_generation),
    handoffDigest: row.handoff_digest,
    createdAt: row.created_at,
  };
}

async function buildResponsibilitySnapshot(responsibilityId, rootSessionId, actor) {
  const rid = text(responsibilityId, 160);
  if (!rid) return null;
  const detail = await getResponsibility(rid, actor);
  const [plansRes, activityRes, episodesRes, linksRes, dbExtra] = await Promise.all([
    listResponsibilityPlans(rid, actor).catch(() => ({ plans: [] })),
    listResponsibilityActivity(rid, { limit: 20 }, actor).catch(() => ({ activity: [] })),
    listOwnerEpisodicMemory({ responsibilityId: rid, limit: 20 }, actor).catch(() => ({ records: [] })),
    listResponsibilityWorkLinks(rid, actor).catch(() => ({ links: [] })),
    read((db) => {
      ensureVoiceButlerSchema(db);
      const sessionContext = rootSessionId
        ? db.prepare('SELECT * FROM responsibility_session_contexts WHERE session_id=?').get(rootSessionId)
        : null;
      const latestOutcome = db.prepare('SELECT * FROM responsibility_planning_outcomes WHERE responsibility_id=? ORDER BY created_at DESC LIMIT 1').get(rid);
      const hasMilestones = tableExists(db, 'factory_delivery_milestones');
      const hasCandidates = tableExists(db, 'factory_candidates');
      const hasWorkItems = tableExists(db, 'factory_work_items');
      const workIds = (detail.workSummary || []).map((w) => w.workItemId);
      const workAttemptMeta = new Map();
      if (hasWorkItems) {
        for (const w of detail.workSummary || []) {
          const rawWork = db.prepare('SELECT contract_revision, execution_epoch, binding_generation FROM factory_work_items WHERE id=?').get(w.workItemId);
          const binding = rawWork
            ? db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(w.workItemId, rawWork.contract_revision, rawWork.execution_epoch, rawWork.binding_generation)
            : null;
          const attempt = resolveWorkItemAttemptInTx(db, w.workItemId, binding);
          const isFallbackUnknown = Boolean(
            w.isUnknownOutcome
            || attempt?.failure_kind === 'unknown_outcome'
            || (binding?.status === 'intent' && !binding?.run_id && attempt?.state === 'failed'),
          );
          workAttemptMeta.set(w.workItemId, {
            attemptState: attempt?.state || w.attemptState || null,
            attemptFailureKind: attempt?.failure_kind || w.attemptFailureKind || null,
            attemptFailureReason: attempt?.failure_reason || null,
            runId: w.runId || binding?.run_id || attempt?.run_id || null,
            isUnknownOutcome: isFallbackUnknown,
          });
        }
      }
      const delivered = [];
      for (const wid of workIds) {
        const wRow = detail.workSummary.find((x) => x.workItemId === wid);
        if (wRow?.state !== 'completed') continue;
        const m = hasMilestones
          ? db.prepare('SELECT * FROM factory_delivery_milestones WHERE work_item_id=? ORDER BY created_at DESC LIMIT 1').get(wid)
          : null;
        const c = hasCandidates
          ? db.prepare('SELECT * FROM factory_candidates WHERE work_item_id=? ORDER BY created_at DESC LIMIT 1').get(wid)
          : null;
        delivered.push({
          workItemId: wid,
          milestone: m?.milestone || 'accepted',
          target: m?.target || detail.responsibility.projectId,
          candidateDigest: m?.candidate_digest || c?.digest || null,
          details: parseJson(c?.details_json, {}),
          deliveredAt: m?.created_at || detail.responsibility.updatedAt,
        });
      }
      return { sessionContext, latestOutcome, delivered, workAttemptMeta };
    }),
  ]);

  const enrichedWorkSummary = (detail.workSummary || []).map((w) => {
    const extra = dbExtra.workAttemptMeta.get(w.workItemId);
    if (!extra) return w;
    return {
      ...w,
      attemptState: extra.attemptState,
      attemptFailureKind: extra.attemptFailureKind,
      attemptFailureReason: extra.attemptFailureReason,
      runId: extra.runId,
      isUnknownOutcome: extra.isUnknownOutcome,
    };
  });

  const pendingPlans = (plansRes?.plans || []).filter((p) => p.state === 'pending_review').map((p) => ({
    id: p.id,
    wakeId: p.wakeId,
    state: p.state,
    proposalDigest: p.proposalDigest,
    proposal: p.proposal,
    createdAt: p.createdAt,
  }));

  const episodes = episodesRes?.records || [];
  const failureDiagnostics = [];

  for (const w of enrichedWorkSummary) {
    if (!w.isUnknownOutcome && !['failed', 'blocked'].includes(w.state)) continue;
    const ep = episodes.find((e) => e.workItemId === w.workItemId)
      || episodes.find((e) => ['failed', 'blocked', 'unknown_outcome'].includes(e.outcome));
    let runError = null;
    if (w.runId && !w.attemptFailureReason && !ep?.failureRootCause) {
      try {
        const run = await getRun(w.runId);
        runError = text(run?.error || run?.result?.error, 400) || null;
      } catch {}
    }
    const detailReason = w.attemptFailureReason || w.blockedReason?.message || runError || null;
    failureDiagnostics.push({
      source: 'work_item',
      workItemId: w.workItemId,
      state: w.state,
      isUnknownOutcome: Boolean(w.isUnknownOutcome),
      code: w.blockedReason?.code || w.attemptFailureKind || (w.isUnknownOutcome ? 'unknown_outcome' : w.state),
      message: w.isUnknownOutcome
        ? (detailReason ? `Execution outcome is unverified (unknown_outcome): ${detailReason}. Do not blindly replay before verifying external state.` : 'Execution outcome is unverified (unknown_outcome). Do not blindly replay before verifying external state.')
        : (detailReason || w.attemptFailureKind || `Work item ${w.state}`),
      rootCause: ep?.failureRootCause || detailReason || w.attemptFailureKind || null,
      repairAttempt: ep?.repairAttempt || null,
      repairStatus: ep?.repairStatus || 'none',
    });
  }

  for (const ep of episodes) {
    if (!['failed', 'blocked', 'unknown_outcome'].includes(ep.outcome)) continue;
    if (ep.workItemId && failureDiagnostics.some((d) => d.workItemId === ep.workItemId)) continue;
    failureDiagnostics.push({
      source: 'episodic_memory',
      episodeId: ep.id,
      workItemId: ep.workItemId || null,
      state: ep.outcome,
      isUnknownOutcome: ep.outcome === 'unknown_outcome',
      code: ep.outcome,
      message: ep.summary,
      rootCause: ep.failureRootCause || ep.summary,
      repairAttempt: ep.repairAttempt || null,
      repairStatus: ep.repairStatus || 'none',
      sourceRef: ep.sourceRef || null,
    });
  }

  for (const act of activityRes?.activity || []) {
    if (!['execution_attempt_failed', 'budget_blocked', 'planning_invalid_output', 'plan_admission_blocked', 'planning_evidence_blocked'].includes(act.type)) {
      continue;
    }
    failureDiagnostics.push({
      source: 'responsibility_activity',
      sequence: act.sequence,
      workItemId: act.details?.workItemId || null,
      state: act.type,
      isUnknownOutcome: false,
      code: act.details?.reason || act.type,
      message: `${act.type}: ${act.details?.reason || 'see activity details'}`,
      rootCause: act.details?.reason || act.type,
      repairAttempt: null,
      repairStatus: 'none',
      createdAt: act.createdAt,
    });
  }

  const deliveredArtifacts = [];
  for (const item of dbExtra.delivered) {
    let packet = null;
    if (item.details?.packetId) {
      try {
        packet = await getResultPacket(item.details.packetId);
      } catch {}
    }
    deliveredArtifacts.push({
      workItemId: item.workItemId,
      title: packet?.title || item.workItemId,
      milestone: item.milestone,
      target: item.target,
      candidateDigest: item.candidateDigest,
      packetId: packet?.packetId || item.details?.packetId || null,
      summary: text(packet?.summary, 400) || `Completed ${item.workItemId}`,
      deliveredAt: item.deliveredAt,
    });
  }

  return {
    responsibility: detail.responsibility,
    workSummary: enrichedWorkSummary,
    budgetStatus: detail.budgetStatus,
    pendingPlans,
    workLinksCount: (linksRes?.links || []).length,
    failureDiagnostics,
    deliveredArtifacts,
    latestPlanningOutcome: dbExtra.latestOutcome ? {
      wakeId: dbExtra.latestOutcome.wake_id,
      kind: dbExtra.latestOutcome.kind,
      reason: parseJson(dbExtra.latestOutcome.reason, dbExtra.latestOutcome.reason),
      nextCheckAt: dbExtra.latestOutcome.next_check_at || null,
      createdAt: dbExtra.latestOutcome.created_at,
    } : null,
    sessionContext: dbExtra.sessionContext ? {
      sessionId: dbExtra.sessionContext.session_id,
      responsibilityId: dbExtra.sessionContext.responsibility_id,
      confirmedIntent: dbExtra.sessionContext.intent,
      responsibilityVersion: dbExtra.sessionContext.responsibility_version,
      policyRevision: dbExtra.sessionContext.policy_revision,
      activityCursor: dbExtra.sessionContext.activity_cursor,
      rowVersion: dbExtra.sessionContext.row_version,
      updatedAt: dbExtra.sessionContext.updated_at,
    } : null,
  };
}

export function createVoiceAdapterRegistry({ asrAdapters = [], reasonerAdapters = [], ttsAdapters = [] } = {}) {
  const asr = new Map([[localPassthroughAsrAdapter.id, localPassthroughAsrAdapter]]);
  const reasoner = new Map([[deterministicButlerReasonerAdapter.id, deterministicButlerReasonerAdapter]]);
  const tts = new Map([[clientStreamingTtsAdapter.id, clientStreamingTtsAdapter]]);

  for (const adapter of asrAdapters) {
    if (adapter?.id && typeof adapter.transcribe === 'function') asr.set(adapter.id, adapter);
  }
  for (const adapter of reasonerAdapters) {
    if (adapter?.id && typeof adapter.reason === 'function') reasoner.set(adapter.id, adapter);
  }
  for (const adapter of ttsAdapters) {
    if (adapter?.id && (typeof adapter.synthesizeStream === 'function' || typeof adapter.synthesize === 'function')) {
      tts.set(adapter.id, adapter);
    }
  }

  const descriptor = (entry) => ({
    id: entry.id,
    mode: entry.mode || 'local',
    kind: entry.providerKind || 'custom',
    providerKind: entry.providerKind || 'custom',
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.supportsStreaming !== undefined ? { supportsStreaming: Boolean(entry.supportsStreaming) } : {}),
    ...(entry.supportsTools !== undefined ? { supportsTools: Boolean(entry.supportsTools) } : {}),
  });

  return {
    registerAsr(adapter) {
      if (!adapter?.id || typeof adapter.transcribe !== 'function') {
        throw error('ASR adapter must define id and transcribe()', 400, 'VOICE_INVALID_ADAPTER');
      }
      asr.set(adapter.id, adapter);
      return descriptor(adapter);
    },
    registerReasoner(adapter) {
      if (!adapter?.id || typeof adapter.reason !== 'function') {
        throw error('Reasoner adapter must define id and reason()', 400, 'VOICE_INVALID_ADAPTER');
      }
      reasoner.set(adapter.id, adapter);
      return descriptor(adapter);
    },
    registerTts(adapter) {
      if (!adapter?.id || (typeof adapter.synthesizeStream !== 'function' && typeof adapter.synthesize !== 'function')) {
        throw error('TTS adapter must define id and synthesizeStream() or synthesize()', 400, 'VOICE_INVALID_ADAPTER');
      }
      tts.set(adapter.id, adapter);
      return descriptor(adapter);
    },
    getAsr(id) {
      const key = text(id, 80) || text(process.env.RAGENT_VOICE_ASR_ENGINE, 80) || 'local';
      return asr.get(key) || null;
    },
    getReasoner(id) {
      const key = text(id, 80) || text(process.env.RAGENT_VOICE_REASONER_ENGINE, 80) || 'deterministic-butler';
      return reasoner.get(key) || null;
    },
    getTts(id) {
      const key = text(id, 80) || text(process.env.RAGENT_VOICE_TTS_ENGINE, 80) || 'client-tts';
      return tts.get(key) || null;
    },
    list() {
      return {
        schemaVersion: 1,
        asr: [...asr.values()].map(descriptor),
        reasoner: [...reasoner.values()].map(descriptor),
        tts: [...tts.values()].map(descriptor),
      };
    },
  };
}

const defaultVoiceAdapterRegistry = createVoiceAdapterRegistry();

export function registerVoiceAsrAdapter(adapter) {
  return defaultVoiceAdapterRegistry.registerAsr(adapter);
}

export function registerVoiceReasonerAdapter(adapter) {
  return defaultVoiceAdapterRegistry.registerReasoner(adapter);
}

export function registerVoiceTtsAdapter(adapter) {
  return defaultVoiceAdapterRegistry.registerTts(adapter);
}

export function listVoiceAdapters() {
  return defaultVoiceAdapterRegistry.list();
}

export function createVoiceButlerService({ registry = defaultVoiceAdapterRegistry } = {}) {
  async function validateSessionBindings({ responsibilityId, rootSessionId }, actor) {
    let responsibility = null;
    if (responsibilityId) {
      responsibility = (await getResponsibility(responsibilityId, actor)).responsibility;
    }
    if (rootSessionId) {
      const rootSession = await getSession(rootSessionId);
      if (!rootSession?.id || rootSession.archived) {
        throw error('Linked session is unavailable', 404, 'RESPONSIBILITY_SESSION_UNAVAILABLE');
      }
      if (responsibility && rootSession.projectId && rootSession.projectId !== responsibility.projectId) {
        throw error('Session and responsibility projects differ', 409, 'RESPONSIBILITY_CONFLICT');
      }
    }
    return responsibility;
  }

  async function listVoiceSessions({ responsibilityId = '', limit = 50 } = {}, actor) {
    const principalId = assertOwnerActor(actor);
    const rid = text(responsibilityId, 160);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 100));
    return read((db) => {
      ensureVoiceButlerSchema(db);
      const rows = db.prepare(`
        SELECT * FROM responsibility_voice_sessions
        WHERE owner_principal_id=? AND (?='' OR responsibility_id=?)
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `).all(principalId, rid, rid, bounded);
      return {
        schemaVersion: 1,
        sessions: rows.map(mapSessionRow),
      };
    });
  }

  async function createVoiceSession(input = {}, actor, authSession = null) {
    const principalId = assertOwnerActor(actor);
    const responsibilityId = text(input.responsibilityId, 160);
    const rootSessionId = text(input.rootSessionId, 160);
    const responsibility = await validateSessionBindings({ responsibilityId, rootSessionId }, actor);

    const asrEngineId = text(input.asrEngineId, 80) || text(process.env.RAGENT_VOICE_ASR_ENGINE, 80) || 'local';
    const reasonerEngineId = text(input.reasonerEngineId, 80) || text(process.env.RAGENT_VOICE_REASONER_ENGINE, 80) || 'deterministic-butler';
    const ttsEngineId = text(input.ttsEngineId, 80) || text(process.env.RAGENT_VOICE_TTS_ENGINE, 80) || 'client-tts';
    if (!registry.getAsr(asrEngineId)) throw error(`Unknown ASR adapter: ${asrEngineId}`, 400, 'VOICE_UNKNOWN_ADAPTER');
    if (!registry.getReasoner(reasonerEngineId)) throw error(`Unknown reasoner adapter: ${reasonerEngineId}`, 400, 'VOICE_UNKNOWN_ADAPTER');
    if (!registry.getTts(ttsEngineId)) throw error(`Unknown TTS adapter: ${ttsEngineId}`, 400, 'VOICE_UNKNOWN_ADAPTER');

    const deviceId = text(input.deviceId, 160) || text(authSession?.deviceId, 160) || `device_${randomUUID().slice(0, 8)}`;
    const deviceType = normalizeDeviceType(input.deviceType || (authSession?.principalKind === 'trusted_device' ? 'android' : 'desktop'));
    const deviceLabel = text(input.deviceLabel, 120) || deviceType;
    const language = text(input.language, 32) || 'zh-CN';
    const idempotencyKey = text(input.idempotencyKey, 255);

    const created = await transaction((db) => {
      ensureVoiceButlerSchema(db);
      if (idempotencyKey) {
        const existingId = db.prepare(`
          SELECT result_json, payload_digest FROM responsibility_receipts
          WHERE actor_id=? AND operation='voice_create_session' AND target_id=? AND idempotency_key=?
        `).get(principalId, responsibilityId || 'global', idempotencyKey);
        if (existingId) {
          const reqDigest = digest({ responsibilityId, rootSessionId, deviceId, deviceType, language, asrEngineId, reasonerEngineId, ttsEngineId });
          if (existingId.payload_digest !== reqDigest) {
            throw error('Idempotency key reused with different voice session input', 409, 'RESPONSIBILITY_CONFLICT');
          }
          const parsed = parseJson(existingId.result_json, {});
          const row = parsed?.sessionId
            ? db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(parsed.sessionId, principalId)
            : null;
          if (row) return { session: mapSessionRow(row), replayed: true };
        }
      }

      const sessionId = newId('vsess');
      const ts = now();
      const contextSummary = {
        responsibilityObjective: responsibility?.objective || '',
        responsibilityLifecycle: responsibility?.lifecycle || null,
        lastIntent: '',
        pendingApprovalId: null,
        turnCount: 0,
      };
      db.prepare(`
        INSERT INTO responsibility_voice_sessions (
          id, owner_principal_id, organization_id, project_id, responsibility_id, root_session_id,
          active_device_id, active_device_type, active_device_label,
          asr_engine_id, reasoner_engine_id, tts_engine_id, language,
          state, turn_seq, playback_generation, active_turn_id, last_interrupted_generation,
          context_summary_json, row_version, created_at, updated_at, last_turn_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'idle',0,0,'',0,?,1,?,?,NULL)
      `).run(
        sessionId,
        principalId,
        responsibility?.organizationId || '',
        responsibility?.projectId || '',
        responsibility?.id || '',
        rootSessionId,
        deviceId,
        deviceType,
        deviceLabel,
        asrEngineId,
        reasonerEngineId,
        ttsEngineId,
        language,
        JSON.stringify(contextSummary),
        ts,
        ts,
      );
      if (idempotencyKey) {
        const reqDigest = digest({ responsibilityId, rootSessionId, deviceId, deviceType, language, asrEngineId, reasonerEngineId, ttsEngineId });
        db.prepare('INSERT INTO responsibility_receipts VALUES(?,?,?,?,?,?,?)').run(
          principalId,
          'voice_create_session',
          responsibilityId || 'global',
          idempotencyKey,
          reqDigest,
          JSON.stringify({ sessionId }),
          ts,
        );
      }
      const inserted = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=?').get(sessionId);
      return { session: mapSessionRow(inserted), replayed: false };
    });

    const snapshot = await buildResponsibilitySnapshot(created.session.responsibilityId, created.session.rootSessionId, actor);
    return {
      schemaVersion: 1,
      replayed: created.replayed,
      session: created.session,
      turns: [],
      handoffs: [],
      responsibilitySnapshot: snapshot,
    };
  }

  async function getVoiceSession(sessionId, { turnLimit = 100 } = {}, actor) {
    const principalId = assertOwnerActor(actor);
    const sid = text(sessionId, 160);
    if (!sid) throw error('sessionId is required', 400, 'VOICE_INVALID_INPUT');
    const bounded = Math.max(1, Math.min(Number(turnLimit) || 100, 200));

    const data = await read((db) => {
      ensureVoiceButlerSchema(db);
      const row = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(sid, principalId);
      if (!row) throw error('Voice session not found', 404, 'VOICE_SESSION_NOT_FOUND');
      const turnRows = db.prepare(`
        SELECT * FROM responsibility_voice_turns
        WHERE voice_session_id=? AND owner_principal_id=?
        ORDER BY turn_seq DESC LIMIT ?
      `).all(sid, principalId, bounded).reverse();
      const handoffRows = db.prepare(`
        SELECT * FROM responsibility_voice_handoffs
        WHERE voice_session_id=? AND owner_principal_id=?
        ORDER BY created_at ASC, rowid ASC LIMIT 50
      `).all(sid, principalId);
      return {
        session: mapSessionRow(row),
        turns: turnRows.map(mapTurnRow),
        handoffs: handoffRows.map(mapHandoffRow),
      };
    });

    const snapshot = await buildResponsibilitySnapshot(data.session.responsibilityId, data.session.rootSessionId, actor);
    return {
      schemaVersion: 1,
      ...data,
      responsibilitySnapshot: snapshot,
    };
  }

  async function interruptVoiceTurn(sessionId, input = {}, actor, authSession = null) {
    const principalId = assertOwnerActor(actor);
    const sid = text(sessionId, 160);
    if (!sid) throw error('sessionId is required', 400, 'VOICE_INVALID_INPUT');
    const reason = text(input.reason, 160) || 'barge_in';
    const hasTargetGen = Number.isSafeInteger(input.targetGeneration) && input.targetGeneration >= 0;
    const hasTargetSeq = Number.isSafeInteger(input.targetTurnSeq) && input.targetTurnSeq >= 0;
    const interruptedChunkIndex = Number.isSafeInteger(input.interruptedChunkIndex) && input.interruptedChunkIndex >= 0
      ? input.interruptedChunkIndex
      : null;

    const txResult = await transaction((db) => {
      ensureVoiceButlerSchema(db);
      const row = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(sid, principalId);
      if (!row) throw error('Voice session not found', 404, 'VOICE_SESSION_NOT_FOUND');

      const currentGen = Number(row.playback_generation || 0);
      if (hasTargetGen && input.targetGeneration > currentGen) {
        throw error('Target playback generation does not exist yet', 409, 'VOICE_GENERATION_CONFLICT');
      }
      if (hasTargetGen && input.targetGeneration < currentGen) {
        return {
          interrupted: false,
          alreadySuperseded: true,
          previousGeneration: currentGen,
          playbackGeneration: currentGen,
          turnSeq: Number(row.turn_seq || 0),
          session: mapSessionRow(row),
          interruptedTurn: null,
        };
      }

      const ts = now();
      const nextGen = currentGen + 1;
      const targetTurn = row.active_turn_id
        ? db.prepare('SELECT * FROM responsibility_voice_turns WHERE id=? AND voice_session_id=?').get(row.active_turn_id, sid)
        : (hasTargetSeq
          ? db.prepare('SELECT * FROM responsibility_voice_turns WHERE voice_session_id=? AND turn_seq=?').get(sid, input.targetTurnSeq)
          : db.prepare('SELECT * FROM responsibility_voice_turns WHERE voice_session_id=? ORDER BY turn_seq DESC LIMIT 1').get(sid));

      let updatedTurnRow = null;
      if (targetTurn) {
        const ttsMeta = parseJson(targetTurn.tts_json, { chunks: [] });
        const nextTts = {
          ...ttsMeta,
          interrupted: true,
          completed: false,
          interruptedAt: ts,
          interruptReason: reason,
          ...(interruptedChunkIndex !== null ? { interruptedChunkIndex } : {}),
        };
        const preserveStatus = ['requires_visual_approval', 'asr_failed', 'clarification_required', 'draft_prepared'].includes(targetTurn.status);
        const nextStatus = preserveStatus ? targetTurn.status : 'interrupted';
        db.prepare(`
          UPDATE responsibility_voice_turns
          SET status=?, tts_json=?, interrupted_at=?, interrupt_reason=?, updated_at=?
          WHERE id=? AND voice_session_id=?
        `).run(nextStatus, JSON.stringify(nextTts), ts, reason, ts, targetTurn.id, sid);
        updatedTurnRow = db.prepare('SELECT * FROM responsibility_voice_turns WHERE id=?').get(targetTurn.id);
      }

      const deviceId = text(input.deviceId, 160) || text(authSession?.deviceId, 160) || row.active_device_id;
      const deviceType = input.deviceType ? normalizeDeviceType(input.deviceType) : row.active_device_type;

      db.prepare(`
        UPDATE responsibility_voice_sessions
        SET state='interrupted',
            playback_generation=?,
            last_interrupted_generation=?,
            active_turn_id='',
            active_device_id=?,
            active_device_type=?,
            row_version=row_version+1,
            updated_at=?
        WHERE id=? AND owner_principal_id=? AND row_version=?
      `).run(nextGen, currentGen, deviceId, deviceType, ts, sid, principalId, row.row_version);

      const updatedSession = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=?').get(sid);
      return {
        interrupted: true,
        alreadySuperseded: false,
        previousGeneration: currentGen,
        playbackGeneration: nextGen,
        turnSeq: Number(updatedSession.turn_seq || 0),
        session: mapSessionRow(updatedSession),
        interruptedTurn: mapTurnRow(updatedTurnRow),
      };
    });

    if (txResult.interrupted) {
      const controllerKey = `${sid}:${txResult.previousGeneration}`;
      const controller = activeTtsControllers.get(controllerKey);
      if (controller) {
        try { controller.abort(reason); } catch {}
        activeTtsControllers.delete(controllerKey);
      }
    }

    return {
      schemaVersion: 1,
      ...txResult,
    };
  }

  async function submitVoiceTurn(sessionId, input = {}, actor, authSession = null) {
    const principalId = assertOwnerActor(actor);
    const sid = text(sessionId, 160);
    if (!sid) throw error('sessionId is required', 400, 'VOICE_INVALID_INPUT');
    const idempotencyKey = text(input.idempotencyKey, 255);
    const minConfidence = resolveMinAsrConfidence(input.minConfidence);
    const turnRequestDigest = digest({
      responsibilityId: text(input.responsibilityId, 160),
      transcript: text(input.asr?.transcript ?? input.transcript, 4000),
      status: text(input.asr?.status ?? input.asrStatus, 32),
      errorCode: text(input.asr?.errorCode ?? input.errorCode, 80),
      confidence: input.asr?.confidence ?? input.confidence ?? null,
    });

    // 1. Load current session + turn history (read-only) and verify ownership.
    const initial = await read((db) => {
      ensureVoiceButlerSchema(db);
      if (idempotencyKey) {
        const existingTurn = db.prepare(`
          SELECT * FROM responsibility_voice_turns
          WHERE voice_session_id=? AND owner_principal_id=? AND idempotency_key=?
          LIMIT 1
        `).get(sid, principalId, idempotencyKey);
        if (existingTurn) {
          const oldDiag = parseJson(existingTurn.diagnostics_json, {});
          if (oldDiag?.requestDigest && oldDiag.requestDigest !== turnRequestDigest) {
            throw error('Idempotency key reused with different turn input', 409, 'RESPONSIBILITY_CONFLICT');
          }
          const sessRow = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(sid, principalId);
          return { replayedTurn: existingTurn, sessionRow: sessRow };
        }
      }
      const sessRow = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(sid, principalId);
      if (!sessRow) throw error('Voice session not found', 404, 'VOICE_SESSION_NOT_FOUND');
      const recentTurns = db.prepare(`
        SELECT * FROM responsibility_voice_turns
        WHERE voice_session_id=? AND owner_principal_id=?
        ORDER BY turn_seq DESC LIMIT 12
      `).all(sid, principalId).reverse();
      return { replayedTurn: null, sessionRow: sessRow, recentTurns };
    });

    if (initial.replayedTurn && initial.sessionRow) {
      const session = mapSessionRow(initial.sessionRow);
      const turn = mapTurnRow(initial.replayedTurn);
      const snapshot = await buildResponsibilitySnapshot(turn.responsibilityId || session.responsibilityId, session.rootSessionId, actor);
      const outcome = turn.status === 'completed' ? 'answered' : turn.status;
      return {
        schemaVersion: 1,
        replayed: true,
        session,
        turn,
        outcome,
        safetyDecision: turn.diagnostics?.safetyDecision || 'read_only_allowed',
        mutated: false,
        dispatched: false,
        transcript: turn.transcript,
        asrResult: turn.asr,
        responseText: turn.responseText,
        ttsStream: turn.ttsStream,
        approvalCard: turn.approvalCard,
        draft: turn.draft,
        clarificationPrompt: turn.diagnostics?.clarificationPrompt || null,
        responsibilitySnapshot: snapshot,
      };
    }

    const currentSession = mapSessionRow(initial.sessionRow);
    const historyTurns = initial.recentTurns.map(mapTurnRow);

    if (Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration !== currentSession.playbackGeneration) {
      throw error('Voice session playback generation conflict', 409, 'VOICE_GENERATION_CONFLICT');
    }

    // Optional binding/switching to a verified responsibility owned by the same actor.
    const requestedRespId = text(input.responsibilityId, 160);
    const effectiveRespId = requestedRespId || currentSession.responsibilityId;
    if (requestedRespId && requestedRespId !== currentSession.responsibilityId) {
      await validateSessionBindings({ responsibilityId: requestedRespId, rootSessionId: currentSession.rootSessionId }, actor);
    }

    // 2. Resolve pluggable adapters (never hardcoded models).
    const asrInput = (input.asr && typeof input.asr === 'object' && !Array.isArray(input.asr))
      ? input.asr
      : {
          transcript: input.transcript,
          confidence: input.confidence,
          language: input.language,
          status: input.asrStatus,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          engineId: input.asrEngineId,
          mode: input.asrMode,
          audioBase64: input.audioBase64,
          mimeType: input.mimeType,
        };

    const asrAdapterId = text(input.asrEngineId || asrInput.engineId, 80) || currentSession.asrEngineId || 'local';
    const reasonerAdapterId = text(input.reasonerEngineId, 80) || currentSession.reasonerEngineId || 'deterministic-butler';
    const ttsAdapterId = text(input.ttsEngineId, 80) || currentSession.ttsEngineId || 'client-tts';

    const asrAdapter = registry.getAsr(asrAdapterId);
    const reasonerAdapter = registry.getReasoner(reasonerAdapterId);
    const ttsAdapter = registry.getTts(ttsAdapterId);
    if (!asrAdapter) throw error(`Unknown ASR adapter: ${asrAdapterId}`, 400, 'VOICE_UNKNOWN_ADAPTER');
    if (!reasonerAdapter) throw error(`Unknown reasoner adapter: ${reasonerAdapterId}`, 400, 'VOICE_UNKNOWN_ADAPTER');
    if (!ttsAdapter) throw error(`Unknown TTS adapter: ${ttsAdapterId}`, 400, 'VOICE_UNKNOWN_ADAPTER');

    // 3. Run ASR first (read-only). If ASR failed / empty / low confidence -> NEVER execute writes or dispatch!
    const asrResult = await asrAdapter.transcribe(asrInput, {
      minConfidence,
      language: text(input.language, 32) || currentSession.language,
      session: currentSession,
    });

    const [responsibilitySnapshot, butlerOverview] = await Promise.all([
      buildResponsibilitySnapshot(effectiveRespId, currentSession.rootSessionId, actor),
      getButlerOverview({
        organizationId: currentSession.organizationId,
        projectId: currentSession.projectId,
        limit: 50,
      }, actor),
    ]);

    let outcome;
    let safetyDecision;
    let intent;
    let responseText;
    let approvalCard = null;
    let draft = null;
    let clarificationPrompt = null;
    let reasonerMeta = { engineId: reasonerAdapter.id, mode: reasonerAdapter.mode, model: '' };

    if (!asrResult?.ok) {
      if (asrResult?.status === 'low_confidence') {
        outcome = 'clarification_required';
        safetyDecision = 'blocked_no_write';
        intent = 'clarify';
        clarificationPrompt = `语音识别置信度偏低（“${asrResult.transcript}”），为避免误操作未触发任何改动，请再确认或重说一次。`;
        responseText = clarificationPrompt;
      } else {
        outcome = 'asr_failed';
        safetyDecision = 'blocked_no_write';
        intent = 'asr_error';
        clarificationPrompt = asrResult?.errorMessage || '未能清晰识别语音内容，未执行任何操作，请重试。';
        responseText = clarificationPrompt;
      }
    } else {
      const reasonerOutput = await reasonerAdapter.reason({
        utterance: asrResult.transcript,
        language: asrResult.language,
        session: currentSession,
        historyTurns,
        responsibilitySnapshot,
        butlerOverview,
      });
      reasonerMeta = {
        engineId: text(reasonerOutput?.engineId, 80) || reasonerAdapter.id,
        mode: text(reasonerOutput?.mode, 32) || reasonerAdapter.mode || 'deterministic',
        model: text(reasonerOutput?.model, 120) || '',
      };
      const guarded = enforceVoiceSafetyPolicy({
        utterance: asrResult.transcript,
        reasonerOutput,
        responsibilitySnapshot,
      });
      outcome = guarded.outcome;
      safetyDecision = guarded.safetyDecision;
      intent = guarded.intent;
      responseText = guarded.responseText;
      approvalCard = guarded.approvalCard;
      draft = guarded.draft;
    }

    // 4. Atomically allocate monotonic turnSeq + playbackGeneration, optionally barge-in interrupting any active speaking turn.
    const interruptCurrent = input.interruptCurrent === true;
    const streamTts = input.streamTts !== false;
    const deviceId = text(input.deviceId, 160) || text(authSession?.deviceId, 160) || currentSession.activeDeviceId;
    const deviceType = input.deviceType ? normalizeDeviceType(input.deviceType) : currentSession.activeDeviceType;
    const deviceLabel = text(input.deviceLabel, 120) || currentSession.activeDeviceLabel;

    let priorGenToAbort = null;
    const allocated = await transaction((db) => {
      ensureVoiceButlerSchema(db);
      const row = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(sid, principalId);
      if (!row) throw error('Voice session not found', 404, 'VOICE_SESSION_NOT_FOUND');

      if (Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration !== Number(row.playback_generation || 0)) {
        throw error('Voice session playback generation conflict', 409, 'VOICE_GENERATION_CONFLICT');
      }

      const ts = now();
      let currentGen = Number(row.playback_generation || 0);
      let lastInterruptedGen = Number(row.last_interrupted_generation || 0);

      if (interruptCurrent && row.state === 'speaking' && row.active_turn_id) {
        priorGenToAbort = currentGen;
        lastInterruptedGen = currentGen;
        currentGen += 1;
        const prevTurn = db.prepare('SELECT * FROM responsibility_voice_turns WHERE id=?').get(row.active_turn_id);
        if (prevTurn) {
          const prevTts = parseJson(prevTurn.tts_json, { chunks: [] });
          const preserveStatus = ['requires_visual_approval', 'asr_failed', 'clarification_required', 'draft_prepared'].includes(prevTurn.status);
          db.prepare(`
            UPDATE responsibility_voice_turns
            SET status=?, tts_json=?, interrupted_at=?, interrupt_reason='barge_in_next_turn', updated_at=?
            WHERE id=?
          `).run(
            preserveStatus ? prevTurn.status : 'interrupted',
            JSON.stringify({ ...prevTts, interrupted: true, completed: false, interruptedAt: ts, interruptReason: 'barge_in_next_turn' }),
            ts,
            ts,
            prevTurn.id,
          );
        }
      }

      const turnId = newId('vturn');
      const nextTurnSeq = Number(row.turn_seq || 0) + 1;
      const nextPlaybackGen = currentGen + 1;
      const initialTurnStatus = streamTts && outcome === 'answered' ? 'speaking' : outcome;
      const initialTts = {
        generation: nextPlaybackGen,
        turnSeq: nextTurnSeq,
        engineId: ttsAdapter.id,
        mode: ttsAdapter.mode || 'local',
        interrupted: false,
        completed: !streamTts,
        chunks: [],
      };

      const prevSummary = parseJson(row.context_summary_json, {});
      const nextSummary = {
        ...prevSummary,
        responsibilityObjective: responsibilitySnapshot?.responsibility?.objective || prevSummary.responsibilityObjective || '',
        responsibilityLifecycle: responsibilitySnapshot?.responsibility?.lifecycle || prevSummary.responsibilityLifecycle || null,
        lastIntent: intent,
        pendingApprovalId: approvalCard?.approvalId || prevSummary.pendingApprovalId || null,
        turnCount: nextTurnSeq,
        reasonerMeta,
      };

      db.prepare(`
        INSERT INTO responsibility_voice_turns (
          id, voice_session_id, owner_principal_id, turn_seq, playback_generation,
          device_id, device_type, responsibility_id, status, intent,
          asr_json, transcript, response_text, tts_json, approval_card_json, draft_json,
          diagnostics_json, interrupted_at, interrupt_reason, idempotency_key, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'',?,?,?)
      `).run(
        turnId,
        sid,
        principalId,
        nextTurnSeq,
        nextPlaybackGen,
        deviceId,
        deviceType,
        effectiveRespId,
        initialTurnStatus,
        intent,
        JSON.stringify(asrResult),
        asrResult?.transcript || '',
        responseText,
        JSON.stringify(initialTts),
        approvalCard ? JSON.stringify(approvalCard) : null,
        draft ? JSON.stringify(draft) : null,
        JSON.stringify({ safetyDecision, clarificationPrompt, reasonerMeta, requestDigest: turnRequestDigest }),
        idempotencyKey,
        ts,
        ts,
      );

      const sessionState = streamTts
        ? 'speaking'
        : outcome === 'requires_visual_approval'
          ? 'awaiting_approval'
          : 'idle';

      db.prepare(`
        UPDATE responsibility_voice_sessions
        SET organization_id=?,
            project_id=?,
            responsibility_id=?,
            active_device_id=?,
            active_device_type=?,
            active_device_label=?,
            asr_engine_id=?,
            reasoner_engine_id=?,
            tts_engine_id=?,
            state=?,
            turn_seq=?,
            playback_generation=?,
            active_turn_id=?,
            last_interrupted_generation=?,
            context_summary_json=?,
            row_version=row_version+1,
            updated_at=?,
            last_turn_at=?
        WHERE id=? AND owner_principal_id=? AND row_version=?
      `).run(
        responsibilitySnapshot?.responsibility?.organizationId || row.organization_id,
        responsibilitySnapshot?.responsibility?.projectId || row.project_id,
        effectiveRespId,
        deviceId,
        deviceType,
        deviceLabel,
        asrAdapter.id,
        reasonerAdapter.id,
        ttsAdapter.id,
        sessionState,
        nextTurnSeq,
        nextPlaybackGen,
        streamTts ? turnId : '',
        lastInterruptedGen,
        JSON.stringify(nextSummary),
        ts,
        ts,
        sid,
        principalId,
        row.row_version,
      );

      return {
        turnId,
        turnSeq: nextTurnSeq,
        playbackGeneration: nextPlaybackGen,
        initialTts,
      };
    });

    if (priorGenToAbort !== null) {
      const priorCtrl = activeTtsControllers.get(`${sid}:${priorGenToAbort}`);
      if (priorCtrl) {
        try { priorCtrl.abort('barge_in_next_turn'); } catch {}
        activeTtsControllers.delete(`${sid}:${priorGenToAbort}`);
      }
    }

    // 5. Stream TTS chunks outside SQLite write lock so concurrent interruptVoiceTurn() can abort mid-stream!
    const chunks = [];
    let wasInterrupted = false;
    if (streamTts && responseText) {
      const controllerKey = `${sid}:${allocated.playbackGeneration}`;
      const abortController = new AbortController();
      activeTtsControllers.set(controllerKey, abortController);
      try {
        const preCheck = await read((db) => {
          const s = db.prepare('SELECT playback_generation, state FROM responsibility_voice_sessions WHERE id=?').get(sid);
          return s && Number(s.playback_generation) === allocated.playbackGeneration && s.state !== 'interrupted';
        });
        if (!preCheck) {
          wasInterrupted = true;
        } else if (typeof ttsAdapter.synthesizeStream === 'function') {
          for await (const chunk of ttsAdapter.synthesizeStream(
            { text: responseText, language: asrResult?.language || currentSession.language, voice: input.ttsVoice || '' },
            { signal: abortController.signal },
          )) {
            if (abortController.signal.aborted) {
              wasInterrupted = true;
              break;
            }
            const stillCurrent = await read((db) => {
              const s = db.prepare('SELECT playback_generation, state FROM responsibility_voice_sessions WHERE id=?').get(sid);
              return s && Number(s.playback_generation) === allocated.playbackGeneration && s.state !== 'interrupted';
            });
            if (!stillCurrent) {
              wasInterrupted = true;
              break;
            }
            chunks.push({
              chunkIndex: Number.isInteger(chunk?.chunkIndex) ? chunk.chunkIndex : chunks.length,
              text: text(chunk?.text, 2000),
              audioChunkBase64: chunk?.audioChunkBase64 || null,
              mimeType: chunk?.mimeType || null,
              isFinal: Boolean(chunk?.isFinal),
            });
          }
        } else {
          const single = await ttsAdapter.synthesize(
            { text: responseText, language: asrResult?.language || currentSession.language, voice: input.ttsVoice || '' },
            { signal: abortController.signal },
          );
          if (!abortController.signal.aborted) {
            chunks.push({
              chunkIndex: 0,
              text: text(single?.text, 2000) || responseText,
              audioChunkBase64: single?.audioChunkBase64 || null,
              mimeType: single?.mimeType || null,
              isFinal: true,
            });
          } else {
            wasInterrupted = true;
          }
        }
        if (abortController.signal.aborted) {
          wasInterrupted = true;
        }
      } finally {
        activeTtsControllers.delete(controllerKey);
      }
    }

    // 6. Finalize turn & session state cleanly without overwriting newer generations if interrupted.
    const finalized = await transaction((db) => {
      ensureVoiceButlerSchema(db);
      const sessRow = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(sid, principalId);
      const turnRow = db.prepare('SELECT * FROM responsibility_voice_turns WHERE id=?').get(allocated.turnId);
      const ts = now();
      const sameGeneration = sessRow && Number(sessRow.playback_generation) === allocated.playbackGeneration && sessRow.state !== 'interrupted';
      const actuallyInterrupted = wasInterrupted || !sameGeneration || turnRow?.status === 'interrupted';

      const existingTts = parseJson(turnRow?.tts_json, {});
      const finalTts = {
        generation: allocated.playbackGeneration,
        turnSeq: allocated.turnSeq,
        engineId: ttsAdapter.id,
        mode: ttsAdapter.mode || 'local',
        interrupted: actuallyInterrupted,
        completed: !actuallyInterrupted,
        ...(actuallyInterrupted && existingTts?.interruptedAt ? { interruptedAt: existingTts.interruptedAt } : {}),
        ...(actuallyInterrupted && existingTts?.interruptReason ? { interruptReason: existingTts.interruptReason } : {}),
        ...(actuallyInterrupted && existingTts?.interruptedChunkIndex !== undefined ? { interruptedChunkIndex: existingTts.interruptedChunkIndex } : {}),
        chunks,
      };

      const finalTurnStatus = actuallyInterrupted && !['requires_visual_approval', 'asr_failed', 'clarification_required', 'draft_prepared'].includes(outcome)
        ? 'interrupted'
        : (outcome === 'answered' ? 'completed' : outcome);

      db.prepare(`
        UPDATE responsibility_voice_turns
        SET status=?, tts_json=?, updated_at=?
        WHERE id=?
      `).run(finalTurnStatus, JSON.stringify(finalTts), ts, allocated.turnId);

      if (sameGeneration && !actuallyInterrupted) {
        const nextSessState = outcome === 'requires_visual_approval' ? 'awaiting_approval' : 'idle';
        db.prepare(`
          UPDATE responsibility_voice_sessions
          SET state=?, active_turn_id='', row_version=row_version+1, updated_at=?
          WHERE id=? AND owner_principal_id=? AND playback_generation=?
        `).run(nextSessState, ts, sid, principalId, allocated.playbackGeneration);
      }

      const freshSession = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=?').get(sid);
      const freshTurn = db.prepare('SELECT * FROM responsibility_voice_turns WHERE id=?').get(allocated.turnId);
      return {
        session: mapSessionRow(freshSession),
        turn: mapTurnRow(freshTurn),
        finalTts,
      };
    });

    return {
      schemaVersion: 1,
      replayed: false,
      session: finalized.session,
      turn: finalized.turn,
      outcome: finalized.turn.status === 'completed' ? 'answered' : finalized.turn.status,
      safetyDecision,
      mutated: false,
      dispatched: false,
      transcript: asrResult?.transcript || '',
      asrResult,
      responseText,
      ttsStream: finalized.finalTts,
      approvalCard,
      draft,
      clarificationPrompt,
      responsibilitySnapshot,
    };
  }

  async function handoffVoiceSession(sessionId, input = {}, actor, authSession = null) {
    const principalId = assertOwnerActor(actor);
    const sid = text(sessionId, 160);
    if (!sid) throw error('sessionId is required', 400, 'VOICE_INVALID_INPUT');
    const targetDeviceId = text(input.targetDeviceId || input.deviceId || authSession?.deviceId, 160);
    if (!targetDeviceId) throw error('targetDeviceId is required for cross-device handoff', 400, 'VOICE_INVALID_INPUT');
    const targetDeviceType = normalizeDeviceType(input.targetDeviceType || input.deviceType || 'desktop');
    const targetDeviceLabel = text(input.targetDeviceLabel || input.deviceLabel, 120) || targetDeviceType;
    const targetRootSessionId = text(input.targetRootSessionId, 160);
    const idempotencyKey = text(input.idempotencyKey, 255);

    const existingSession = await read((db) => {
      ensureVoiceButlerSchema(db);
      const r = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(sid, principalId);
      if (!r) throw error('Voice session not found', 404, 'VOICE_SESSION_NOT_FOUND');
      return mapSessionRow(r);
    });

    if (targetRootSessionId) {
      await validateSessionBindings({ responsibilityId: existingSession.responsibilityId, rootSessionId: targetRootSessionId }, actor);
    }

    let previousGenToAbort = null;
    const handoffResult = await transaction((db) => {
      ensureVoiceButlerSchema(db);
      if (idempotencyKey) {
        const old = db.prepare(`
          SELECT * FROM responsibility_voice_handoffs
          WHERE voice_session_id=? AND owner_principal_id=? AND idempotency_key=?
          LIMIT 1
        `).get(sid, principalId, idempotencyKey);
        if (old) {
          if (
            old.to_device_id !== targetDeviceId
            || old.to_device_type !== targetDeviceType
            || (targetRootSessionId && old.root_session_id !== targetRootSessionId)
          ) {
            throw error('Idempotency key reused with different handoff target', 409, 'RESPONSIBILITY_CONFLICT');
          }
          const sessRow = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=?').get(sid);
          const turns = db.prepare('SELECT * FROM responsibility_voice_turns WHERE voice_session_id=? ORDER BY turn_seq ASC').all(sid);
          return {
            replayed: true,
            handoff: mapHandoffRow(old),
            session: mapSessionRow(sessRow),
            turns: turns.map(mapTurnRow),
          };
        }
      }

      const row = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=? AND owner_principal_id=?').get(sid, principalId);
      if (!row) throw error('Voice session not found', 404, 'VOICE_SESSION_NOT_FOUND');
      if (Number.isSafeInteger(input.expectedRowVersion) && input.expectedRowVersion !== Number(row.row_version)) {
        throw error('Voice session version changed', 409, 'RESPONSIBILITY_CONFLICT');
      }

      const ts = now();
      let nextGen = Number(row.playback_generation || 0);
      let lastInterruptedGen = Number(row.last_interrupted_generation || 0);
      if (row.state === 'speaking') {
        previousGenToAbort = nextGen;
        lastInterruptedGen = nextGen;
        nextGen += 1;
      }

      const nextRootSessionId = targetRootSessionId || row.root_session_id;
      const handoffId = newId('vhnd');
      const handoffDigest = digest({
        voiceSessionId: sid,
        fromDeviceId: row.active_device_id,
        toDeviceId: targetDeviceId,
        toDeviceType: targetDeviceType,
        responsibilityId: row.responsibility_id,
        turnSeq: row.turn_seq,
        playbackGeneration: nextGen,
      });

      db.prepare(`
        INSERT INTO responsibility_voice_handoffs (
          id, voice_session_id, owner_principal_id, from_device_id, from_device_type,
          to_device_id, to_device_type, to_device_label, responsibility_id, root_session_id,
          turn_seq, playback_generation, handoff_digest, idempotency_key, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        handoffId,
        sid,
        principalId,
        row.active_device_id || '',
        row.active_device_type || 'unknown',
        targetDeviceId,
        targetDeviceType,
        targetDeviceLabel,
        row.responsibility_id || '',
        nextRootSessionId,
        Number(row.turn_seq || 0),
        nextGen,
        handoffDigest,
        idempotencyKey,
        ts,
      );

      const summary = parseJson(row.context_summary_json, {});
      summary.lastHandoff = {
        handoffId,
        fromDeviceId: row.active_device_id || '',
        fromDeviceType: row.active_device_type || 'unknown',
        toDeviceId: targetDeviceId,
        toDeviceType: targetDeviceType,
        at: ts,
      };

      const nextState = row.state === 'speaking' ? 'interrupted' : row.state;
      db.prepare(`
        UPDATE responsibility_voice_sessions
        SET active_device_id=?,
            active_device_type=?,
            active_device_label=?,
            root_session_id=?,
            state=?,
            playback_generation=?,
            last_interrupted_generation=?,
            active_turn_id='',
            context_summary_json=?,
            row_version=row_version+1,
            updated_at=?
        WHERE id=? AND owner_principal_id=? AND row_version=?
      `).run(
        targetDeviceId,
        targetDeviceType,
        targetDeviceLabel,
        nextRootSessionId,
        nextState,
        nextGen,
        lastInterruptedGen,
        JSON.stringify(summary),
        ts,
        sid,
        principalId,
        row.row_version,
      );

      const updatedSession = db.prepare('SELECT * FROM responsibility_voice_sessions WHERE id=?').get(sid);
      const handoffRow = db.prepare('SELECT * FROM responsibility_voice_handoffs WHERE id=?').get(handoffId);
      const turnRows = db.prepare('SELECT * FROM responsibility_voice_turns WHERE voice_session_id=? ORDER BY turn_seq ASC').all(sid);
      return {
        replayed: false,
        handoff: mapHandoffRow(handoffRow),
        session: mapSessionRow(updatedSession),
        turns: turnRows.map(mapTurnRow),
      };
    });

    if (previousGenToAbort !== null) {
      const ctrl = activeTtsControllers.get(`${sid}:${previousGenToAbort}`);
      if (ctrl) {
        try { ctrl.abort('device_handoff'); } catch {}
        activeTtsControllers.delete(`${sid}:${previousGenToAbort}`);
      }
    }

    const snapshot = await buildResponsibilitySnapshot(
      handoffResult.session.responsibilityId,
      handoffResult.session.rootSessionId,
      actor,
    );

    return {
      schemaVersion: 1,
      ...handoffResult,
      responsibilitySnapshot: snapshot,
    };
  }

  return {
    getButlerOverview,
    listVoiceAdapters: () => registry.list(),
    listVoiceSessions,
    createVoiceSession,
    getVoiceSession,
    submitVoiceTurn,
    interruptVoiceTurn,
    handoffVoiceSession,
  };
}

const defaultVoiceButlerService = createVoiceButlerService();

export const listVoiceSessions = (...args) => defaultVoiceButlerService.listVoiceSessions(...args);
export const createVoiceSession = (...args) => defaultVoiceButlerService.createVoiceSession(...args);
export const getVoiceSession = (...args) => defaultVoiceButlerService.getVoiceSession(...args);
export const submitVoiceTurn = (...args) => defaultVoiceButlerService.submitVoiceTurn(...args);
export const interruptVoiceTurn = (...args) => defaultVoiceButlerService.interruptVoiceTurn(...args);
export const handoffVoiceSession = (...args) => defaultVoiceButlerService.handoffVoiceSession(...args);
