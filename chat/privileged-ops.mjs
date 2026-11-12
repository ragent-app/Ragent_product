import { randomBytes } from 'crypto';

import {
  CATEGORY_DELETE,
  CATEGORY_INSTALL,
  CATEGORY_OTHER,
  canonicalPrivilegedJson,
  classifyPrivilegedOperation,
  sha256Hex,
  stripSudo,
  tokenizeCommand,
} from './privileged-classifier.mjs';
import { explanationForApproval } from './risk-explanation.mjs';
import { isOwnerHostPasskeyRequired } from './approved-action-policy.mjs';

// Batch model + event builders for the AgentoC sudo-approval gate (design:
// notes/current/privileged-approval-design.md). Pure logic, no I/O.
//
// P1 scope: classification, batch construction, default per-category selection
// (other = opt-out / all selected; delete = opt-in / none selected), per-op and
// per-popup manifest hashing, and event/resolve shapes. These builders are NOT
// yet wired into the live session event stream or the provider turn loop — that
// runner integration (privileged_op tool routing + waiting_user batch drain +
// two confirmations) is a separate slice.

export const PRIVILEGED_OP_PREFIX = 'pop_';
export const PRIVILEGED_BATCH_PREFIX = 'pbatch_';

export const PRIVILEGED_BATCH_STATUS = Object.freeze({
  PENDING: 'pending',
  RESOLVED: 'resolved',
  CANCELLED: 'cancelled',
  EXECUTING: 'executing',
});

export const PRIVILEGED_EVENT_SOURCE = 'privileged_approval';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix, bytes = 12) {
  return `${prefix}${randomBytes(bytes).toString('hex')}`;
}

// Per-op manifest hash: binds the exact command + category + cwd. The future
// privileged executor only runs an op whose token carries this hash, so the
// agent cannot swap a command after approval (TOCTOU).
export function computeOpManifestHash({ command, category, cwd }) {
  const canonical = canonicalPrivilegedJson({
    command: trimString(command),
    category: trimString(category),
    cwd: trimString(cwd),
  });
  return sha256Hex(canonical);
}

export function buildPrivilegedOp(input = {}) {
  const command = trimString(input.command);
  if (!command) {
    const error = new Error('command is required');
    error.code = 'COMMAND_REQUIRED';
    throw error;
  }
  const classification = classifyPrivilegedOperation({
    command,
    declaredCategory: input.declaredCategory,
    cwd: input.cwd,
  });
  const description = trimString(input.description) || command.slice(0, 120);
  const manifestHash = computeOpManifestHash({
    command,
    category: classification.category,
    cwd: input.cwd,
  });
  return {
    opId: trimString(input.opId) || createId(PRIVILEGED_OP_PREFIX),
    approvalId: trimString(input.approvalId),
    command,
    description,
    reason: trimString(input.reason),
    cwd: trimString(input.cwd),
    category: classification.category,
    classification,
    manifestHash,
    wrapperCommand: trimString(input.wrapperCommand),
    // Phase 5: thread the gate's risk assessment ({tier, signals}) onto the op
    // so the approval event can light up the mobile risk badge. Absent on ops
    // built before the risk-gated path (e.g. legacy direct calls) — stay optional.
    ...(input.risk ? { risk: input.risk } : {}),
  };
}

// Build a batch for one assistant turn's tool calls. Splits classified ops into:
//   installAuto  — in-scope installs (auto-approved, do not block)
//   other        — privileged_other + out-of-scope installs (deferred to passkey)
//   delete       — destructive_delete (deferred to passkey, defaults unchecked)
export function buildPrivilegedBatch({ runId, turnId, ops } = {}) {
  const built = (Array.isArray(ops) ? ops : []).map((op) => buildPrivilegedOp(op));
  const installAuto = built.filter((op) => op.category === CATEGORY_INSTALL && op.classification.inScope);
  const installDeferred = built
    .filter((op) => op.category === CATEGORY_INSTALL && !op.classification.inScope)
    .map((op) => ({ ...op, deferredFromInstall: true }));
  const other = built
    .filter((op) => op.category === CATEGORY_OTHER)
    .concat(installDeferred);
  const remove = built.filter((op) => op.category === CATEGORY_DELETE);

  return {
    batchId: createId(PRIVILEGED_BATCH_PREFIX),
    runId: trimString(runId),
    turnId: trimString(turnId),
    installAuto,
    other,
    delete: remove,
    status: PRIVILEGED_BATCH_STATUS.PENDING,
    createdAt: nowIso(),
  };
}

export function summarizePrivilegedOps(ops) {
  return (Array.isArray(ops) ? ops : []).map((op) => ({
    opId: op.opId,
    category: op.category,
    command: op.command,
    description: op.description,
    cwd: trimString(op.cwd),
    manifestHash: op.manifestHash,
    ...(op.approvalId ? { approvalId: op.approvalId } : {}),
    ...(op.wrapperCommand ? { wrapperCommand: op.wrapperCommand } : {}),
    ...(op.deferredFromInstall ? { deferredFromInstall: true } : {}),
    // Phase 5: surface the risk assessment so the mobile decision sheet can show
    // the danger badge + reasons. resolveApprovalRisk already probes evt.risk.
    ...(op.risk ? { risk: op.risk } : {}),
    // 人话解释快照：用 gate 判定的权威 tier 走模板/缓存（纯同步，display-only）。
    ...(op.command && op.risk?.tier ? { explanation: explanationForApproval({ command: op.command, cwd: op.cwd }) } : {}),
  }));
}

// New event types (not yet wired into the live stream). Mirror the established
// `{ type, role: 'system', ... }` shape so future normalizer/display wiring is
// straightforward. Return null on invalid input, like the approval event builders.
export function privilegedBatchRequestEvent(batch, { platform = process.platform } = {}) {
  if (!batch?.batchId) return null;
  // Phase 5: worst-risk tier across all batched ops, as a top-level string the
  // frontend layers already probe (decision-sheet/approval-notify/live-bar).
  // Per-op risk stays on each op for the sheet's signals detail.
  const worst = worstRiskTier([...(batch.other || []), ...(batch.delete || []), ...(batch.installAuto || [])]);
  return {
    type: 'privileged_batch_request',
    role: 'system',
    source: PRIVILEGED_EVENT_SOURCE,
    batchId: batch.batchId,
    runId: trimString(batch.runId),
    turnId: trimString(batch.turnId),
    other: summarizePrivilegedOps(batch.other),
    delete: summarizePrivilegedOps(batch.delete),
    installAuto: summarizePrivilegedOps(batch.installAuto),
    status: batch.status || PRIVILEGED_BATCH_STATUS.PENDING,
    createdAt: batch.createdAt || nowIso(),
    // Server-projected approval signal for the owner passkey checkpoint. When
    // false, approval surfaces authorize a dangerous batch with the owner
    // click alone (warnings stay). Absent on older persisted events, which
    // clients must treat as required (safe default).
    passkeyRequired: isOwnerHostPasskeyRequired(),
    ...(platform === 'darwin' ? { executorUnavailableReasonCode: 'macos_administrator_unavailable' } : {}),
    ...(worst ? { risk: worst } : {}),
  };
}

// Worst risk tier among ops: danger > caution > safe. Accepts either the gate's
// risk object ({tier, signals}) or a plain string. Empty when no op carries risk.
function worstRiskTier(ops) {
  const WEIGHT = { danger: 3, caution: 2, safe: 1 };
  let worst = '';
  let weight = 0;
  for (const op of Array.isArray(ops) ? ops : []) {
    const raw = op?.risk && typeof op.risk === 'object' ? op.risk.tier : op?.risk;
    const tier = trimString(raw).toLowerCase();
    const w = WEIGHT[tier] || 0;
    if (w > weight) {
      weight = w;
      worst = tier;
    }
  }
  return worst;
}

export function privilegedBatchResponseEvent({
  batchId,
  category,
  decisions = {},
  webauthnCredentialId = '',
  signedManifestHash = '',
  source = PRIVILEGED_EVENT_SOURCE,
  temporaryControlGrantId = '',
} = {}) {
  if (!batchId || !category) return null;
  return {
    type: 'privileged_batch_response',
    role: 'system',
    source: trimString(source) || PRIVILEGED_EVENT_SOURCE,
    batchId,
    category,
    decisions,
    ...(webauthnCredentialId ? { webauthnCredentialId } : {}),
    ...(signedManifestHash ? { signedManifestHash } : {}),
    ...(trimString(temporaryControlGrantId) ? { temporaryControlGrantId: trimString(temporaryControlGrantId) } : {}),
  };
}

export function privilegedExecResultEvent({
  opId,
  category,
  exitCode = null,
  auditId = '',
  stdoutRef = '',
  error = '',
} = {}) {
  if (!opId) return null;
  return {
    type: 'privileged_exec_result',
    role: 'system',
    source: PRIVILEGED_EVENT_SOURCE,
    opId,
    category: trimString(category),
    exitCode,
    auditId: trimString(auditId),
    stdoutRef: trimString(stdoutRef),
    error: trimString(error),
  };
}

export function selectOps(ops, selectedOpIds) {
  const ids = new Set((Array.isArray(selectedOpIds) ? selectedOpIds : [])
    .map((id) => trimString(id))
    .filter(Boolean));
  return (Array.isArray(ops) ? ops : []).filter((op) => ids.has(op.opId));
}

// Per-popup signed manifest: the WebAuthn challenge (P2) = this hash over the
// checked subset of one category. Two popups ⇒ two hashes; the two categories'
// signed manifests never mix.
export function computeBatchManifestHash(selectedOps, category) {
  const payload = (Array.isArray(selectedOps) ? selectedOps : []).map((op) => ({
    opId: op.opId,
    category: op.category,
    command: op.command,
    manifestHash: op.manifestHash,
  }));
  return sha256Hex(canonicalPrivilegedJson({ category: trimString(category), ops: payload }));
}

// Unknown shell/interpreter programs can hide deletion or other effects from
// the simple privileged classifier. Do not preselect them just because they
// fell into the "other" bucket. This changes only the review default, never
// the authorization or executable allowlist.
const OPAQUE_REVIEW_PROGRAMS = new Set([
  'sh', 'bash', 'dash', 'ash', 'zsh', 'ksh', 'fish', 'csh', 'tcsh',
  'powershell', 'pwsh', 'cmd', 'python', 'python2', 'python3', 'node',
  'perl', 'ruby', 'php', 'env', 'command', 'exec', 'nohup', 'nice', 'timeout', 'xargs', 'find',
]);

function needsExplicitReviewSelection(op) {
  const command = trimString(op?.command);
  if (!command || /[\u0000-\u001f\u007f]/.test(command)) return true;
  const { tokens, composite } = tokenizeCommand(command);
  const { program } = stripSudo(tokens);
  const base = String(program || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
  return composite || !base || OPAQUE_REVIEW_PROGRAMS.has(base);
}

// Known other actions default checked; opaque actions and deletions require
// explicit selection.
export function defaultSelectedOpIds(category, ops) {
  const list = Array.isArray(ops) ? ops : [];
  if (category === CATEGORY_DELETE) return [];
  return list.filter((op) => !needsExplicitReviewSelection(op)).map((op) => op.opId);
}

// Resolve a batch given the user's per-category selections (P1 stand-in: no real
// passkey yet, so webauthnCredentialId stays empty but the manifest hashes are
// computed exactly as P2 will sign them).
export function resolvePrivilegedBatch(batch, {
  otherSelectedOpIds = [],
  deleteSelectedOpIds = [],
} = {}) {
  if (!batch?.batchId) {
    const error = new Error('batch is required');
    error.code = 'BATCH_REQUIRED';
    throw error;
  }
  const otherOps = Array.isArray(batch.other) ? batch.other : [];
  const deleteOps = Array.isArray(batch.delete) ? batch.delete : [];

  const otherSelected = selectOps(otherOps, otherSelectedOpIds);
  const deleteSelected = selectOps(deleteOps, deleteSelectedOpIds);

  const decisions = {};
  for (const op of otherOps) decisions[op.opId] = 'denied';
  for (const op of deleteOps) decisions[op.opId] = 'denied';
  for (const op of otherSelected) decisions[op.opId] = 'approved';
  for (const op of deleteSelected) decisions[op.opId] = 'approved';

  return {
    batchId: batch.batchId,
    other: {
      approved: otherSelected,
      manifestHash: computeBatchManifestHash(otherSelected, CATEGORY_OTHER),
    },
    delete: {
      approved: deleteSelected,
      manifestHash: computeBatchManifestHash(deleteSelected, CATEGORY_DELETE),
    },
    decisions,
  };
}

// Pure quota check given a mutable counter state (persistence is a later slice).
export function checkInstallQuota({ count = 0, max = 5, windowMs = 60 * 60 * 1000 } = {}) {
  const used = Math.max(0, Number(count) || 0);
  const cap = Math.max(0, Number(max) || 0);
  return {
    allowed: used < cap,
    used,
    max: cap,
    remaining: Math.max(0, cap - used),
    windowMs: Math.max(0, Number(windowMs) || 0),
  };
}
