import { approvalCheckpoint, approvalFact, approvalFactFromGate, decideApprovalFacts } from './approval-policy.mjs';
// Gate-side decision logic for the Ragent privileged-approval flow
// (design §13–§14, Path G). Pure logic, no I/O.
//
// In privileged mode the session runs in a GATED permission mode, so the
// provider asks permission for EVERY tool call (`can_use_tool` on Claude bidi,
// `item/.../requestApproval` on Codex app-server). This module decides, per
// gate request, which of three things happens:
//
//   'pass'        — not privileged mode / not a command gate: leave the request
//                   alone so the existing user-facing approval path handles it.
//   'auto-allow'  — privileged mode, but an ordinary command: respond allow
//                   immediately so gated mode does not stall every read/edit.
//   'accumulate'  — a real privileged op: hold the gate and enqueue it into the
//                   per-turn batch for the approval flow.
//
// IMPORTANT — why we do not use the classifier alone to detect privileged ops:
// `classifyPrivilegedOperation` assigns a category to EVERY command (`ls` comes
// back as `privileged_other`), because its job is to categorize an op already
// known to be privileged. Design §13.3 step 2 says "sentinel (or a classifier
// hit)", which taken literally would treat every tool call as privileged and
// stall the turn on each one. The real signal is:
//   * the agent declared the op via the `ragent-privileged` sentinel, or
//   * the command actually invokes `sudo` (classifier `sawSudo`).
// Everything else auto-allows. The safety backstop is the runner identity and
// deny-listed supplementary groups plus the signed privileged executor; a
// missed detection must not turn raw provider sudo into an authorization.

import { classifyPrivilegedOperation } from './privileged-classifier.mjs';
import { parsePrivilegedSentinel } from './privileged-sentinel.mjs';
import { classifyRisk, RISK_TIER } from './risk-classifier.mjs';
import { decideClaudeToolApproval } from './claude-tool-policy.mjs';
import { assessPosixShellSyntax } from './posix-shell-ast.mjs';
import { isReadOnlyStdinFilter } from './windows-bash-actions.mjs';
import { systemPathRootsForPlatform } from './risk-policy.mjs';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export const PRIVILEGED_GATE_DECISION = Object.freeze({
  PASS: 'pass',
  // Provider-neutral prompt result. PASS remains the legacy spelling used by
  // the existing user-facing approval path; both fall through to that path.
  PROMPT: 'prompt',
  AUTO_ALLOW: 'auto-allow',
  ACCUMULATE: 'accumulate',
});

// Gate request kinds that must stay on the user-facing approval path no matter
// the risk mode. AskUserQuestion (kind 'question') is a real question to the
// user — auto-approving it would silently discard the prompt — and ExitPlanMode
// (kind 'plan') is the plan submission that the plan card / Decision Sheet flow
// presents for review. Auto-approving those would defeat plan mode and drop
// questions. Everything else is a tool permission the classifier may answer.
export const USER_FACING_GATE_KINDS = Object.freeze(['question', 'plan']);

// These are the provider file tools whose no-command permission requests are
// safe to answer immediately. Unknown tools must never inherit this exception:
// a new provider tool may have host-side effects that the risk classifier does
// not understand yet.
const KNOWN_FILE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'List',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

// Codex exposes file changes as a method-level approval rather than a named
// tool. Keep the existing automatic behavior for that known protocol shape.
const KNOWN_FILE_GATE_METHODS = new Set([
  'applyPatchApproval',
  'item/fileChange/requestApproval',
]);

const OWNER_PROMPT_GATE_METHODS = new Set([
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
]);

export function isUserFacingGateKind(kind) {
  return USER_FACING_GATE_KINDS.includes(trimString(kind));
}

export function isKnownFileGate(approval, toolName = '') {
  return KNOWN_FILE_TOOLS.has(trimString(toolName))
    || KNOWN_FILE_GATE_METHODS.has(trimString(approval?.providerMethod));
}

function requiresOwnerPrompt(approval) {
  const requestClass = trimString(approval?.requestClass);
  const method = trimString(approval?.providerMethod);
  const legacyToolInvocation = !requestClass && method === 'can_use_tool'
    && Boolean(trimString(approval?.params?.tool_name));
  return OWNER_PROMPT_GATE_METHODS.has(method)
    || (trimString(approval?.kind) === 'permissions' && requestClass !== 'tool_invocation' && !legacyToolInvocation);
}

function codexFileChangeEntries(approval) {
  const params = approval?.params && typeof approval.params === 'object' ? approval.params : {};
  const raw = params.changes;
  const changes = Array.isArray(raw) ? raw
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([filePath, change]) => ({ ...(change || {}), path: filePath }))
      : [];
  if (!changes.length || changes.length > 1024) return null;

  const entries = [];
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return null;
    const filePath = trimString(change.path || change.file_path);
    if (!filePath || filePath.length > 32768) return null;
    const rawKind = typeof change.kind === 'object' && change.kind
      ? change.kind.type
      : change.kind || change.type;
    const kind = trimString(rawKind).toLowerCase();
    const movePath = trimString(change.kind?.move_path || change.kind?.movePath || change.move_path || change.movePath);
    if (movePath) {
      entries.push({ filePath, kind: 'delete' }, { filePath: movePath, kind: 'write' });
    } else if (['delete', 'remove', 'deleted'].includes(kind)) {
      entries.push({ filePath, kind: 'delete' });
    } else if (['add', 'create', 'created', 'update', 'modify', 'modified', 'write'].includes(kind)) {
      entries.push({ filePath, kind: 'write' });
    } else if (['read', 'unchanged'].includes(kind)) {
      entries.push({ filePath, kind: 'read' });
    } else {
      return null;
    }
  }
  return entries.length <= 2048 ? entries : null;
}

function classifyCodexFileChangeRisk(approval, options) {
  if (!['item/fileChange/requestApproval', 'applyPatchApproval'].includes(trimString(approval?.providerMethod))) return null;
  const entries = codexFileChangeEntries(approval);
  if (!entries) {
    return {
      complete: false,
      risk: { tier: 'unknown', confidence: 'unknown', platform: 'file_change',
        signals: { reasons: ['Codex file-change details are unavailable'], needsPrivilegedExecution: false, targetPaths: [] } },
    };
  }

  const classified = entries.map((entry) => entry.kind === 'delete'
    ? { tier: RISK_TIER.DANGER, confidence: 'high', signals: { reasons: ['Codex file deletion requires owner review'], targetPaths: [entry.filePath], needsPrivilegedExecution: true } }
    : classifyRisk({
      toolName: entry.kind === 'read' ? 'Read' : 'Write',
      toolInput: { file_path: entry.filePath },
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      home: options.home,
      riskContext: options.riskContext,
    }));
  const rank = { [RISK_TIER.SAFE]: 0, [RISK_TIER.CAUTION]: 1, [RISK_TIER.DANGER]: 2 };
  const tier = classified.reduce((highest, item) => (rank[item.tier] > rank[highest] ? item.tier : highest), RISK_TIER.SAFE);
  const reasons = [...new Set(classified.flatMap((item) => item.signals?.reasons || []))];
  const targetPaths = [...new Set(classified.flatMap((item) => item.signals?.targetPaths || []))];
  const needsPrivilegedExecution = classified.some((item) => item.signals?.needsPrivilegedExecution === true);
  return {
    complete: true,
    risk: {
      ...classified.find((item) => item.tier === tier),
      tier,
      platform: 'file_change',
      confidence: classified.some((item) => item.confidence !== 'high') ? 'medium' : 'high',
      signals: { reasons, targetPaths, needsPrivilegedExecution },
    },
  };
}

// Permission modes that still emit a per-tool-call permission request
// (can_use_tool / requestApproval). Bypass modes never emit requests, so they
// are not gated by definition; unknown modes are left to the legacy path so we
// never change behavior for a mode we do not recognize.
const GATED_PERMISSION_MODES = new Set([
  'default',
  'plan',
  'acceptEdits',
  'accept_edits',
  'on-request',
  'on-request-workspace-write',
  'on-request-danger-full-access',
  'untrusted',
  'untrusted-read-only',
  'untrusted-workspace-write',
  'untrusted-danger-full-access',
  'auto',
  'never-read-only',
]);

export function isGatedPermissionMode(mode) {
  return GATED_PERMISSION_MODES.has(trimString(mode));
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Joining argv with spaces is only lossless for this conservative subset.
// In particular, shell scripts, empty arguments and quoted paths cannot be
// safely reconstructed from the joined string for managed execution.
function hasAmbiguousCommandArgv(approval) {
  const command = approval?.params?.command;
  return Array.isArray(command) && (command.length === 0
    || (typeof command[0] === 'string' && command[0].includes('='))
    || command.some((part) => typeof part !== 'string' || !/^[A-Za-z0-9_./:@=+%,-]+$/.test(part)));
}

// Pull the shell command out of a gate request. The two runtimes shape this
// differently:
//   Claude bidi        — { tool_name: 'Bash', input: { command } }
//   Codex app-server   — { command } (string, or argv array on some versions)
export function readGateCommand(approval) {
  const params = approval?.params && typeof approval.params === 'object' ? approval.params : {};

  const bidiToolName = trimString(params.tool_name);
  if (bidiToolName) {
    // Only Bash can carry a privileged command; Read/Edit/etc. never can.
    if (bidiToolName !== 'Bash') return '';
    const input = params.input && typeof params.input === 'object' ? params.input : {};
    return trimString(input.command);
  }

  if (typeof params.command === 'string') return trimString(params.command);
  if (Array.isArray(params.command)) {
    return params.command.map((part) => trimString(part)).filter(Boolean).join(' ');
  }
  return '';
}

/**
 * Decide what to do with one provider gate request.
 *
 * @param {object} approval    Normalized approval record from
 *   readClaudeBidiApprovalRequest / readCodexAppServerApprovalRequest.
 * @param {object} [options]
 * @param {boolean} [options.privilegedMode]  Legacy session gate flag. When
 *   false this returns 'pass'; risk-gated runs use decideRiskGate instead.
 * @param {string} [options.cwd]  Run cwd, bound into the op manifest hash.
 * @param {object} [options.riskContext]  Frozen admission-time path context.
 * @returns {{decision:string, reason:string, command?:string, op?:object, sentinel?:object}}
 */
export function decidePrivilegedGate(approval, options = {}) {
  if (options.privilegedMode !== true) {
    return { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'privileged mode off' };
  }
  if (!approval?.approvalId) {
    return { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'not an approval request' };
  }

  if (hasAmbiguousCommandArgv(approval)) {
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: 'command argument boundaries require owner review' };
  }

  const command = readGateCommand(approval);
  if (!command) {
    // A non-command gate (file change, permissions prompt). Privileged mode has
    // nothing to say about it; auto-allow so gated mode does not stall the turn
    // on ordinary edits the user already authorized by enabling the session.
    return {
      decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW,
      reason: 'non-command gate',
    };
  }

  const sentinel = parsePrivilegedSentinel(command);

  if (sentinel?.isSentinel && !sentinel.valid) {
    // A malformed declaration can still contain shell operators or other
    // commands. The launcher also exists on PATH, so do not assume the whole
    // request is harmless or that it will fail before any other effect.
    return {
      decision: PRIVILEGED_GATE_DECISION.PROMPT,
      reason: `malformed sentinel (${sentinel.malformedReason || 'unparseable'})`,
      command,
      sentinel,
    };
  }

  const realCommand = sentinel?.valid ? sentinel.realCommand : command;
  const classification = classifyPrivilegedOperation({
    command: realCommand,
    declaredCategory: sentinel?.declaredCategory,
    cwd: options.cwd,
  });

  // The two real privilege signals: an explicit sentinel declaration, or an
  // actual sudo invocation the agent did not declare.
  const isPrivileged = Boolean(sentinel?.valid) || classification.sawSudo === true;
  if (!isPrivileged) {
    return {
      decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW,
      reason: 'ordinary command',
      command,
    };
  }

  return {
    decision: PRIVILEGED_GATE_DECISION.ACCUMULATE,
    reason: sentinel?.valid ? 'declared sentinel' : 'undeclared sudo',
    command,
    sentinel: sentinel || null,
    op: {
      approvalId: approval.approvalId,
      command: realCommand,
      declaredCategory: sentinel?.declaredCategory || '',
      description: sentinel?.description || '',
      cwd: trimString(options.cwd),
      // Kept so the resolve slice (P1c-6) can rewrite `updatedInput.command`
      // to the real command and drop the sentinel wrapper.
      wrapperCommand: sentinel?.valid ? command : '',
    },
  };
}

// Pull the tool context (name + input + command) out of a gate request. Broader
// than readGateCommand: file tools (Read/Edit/Write) carry no shell command but
// do carry a target path in `input`, which the risk classifier needs.
function readGateToolContext(approval) {
  const params = approval?.params && typeof approval.params === 'object' ? approval.params : {};
  const toolName = trimString(params.tool_name);
  if (toolName) {
    const input = params.input && typeof params.input === 'object' ? params.input : {};
    if (toolName === 'Bash') return { toolName, toolInput: {}, command: trimString(input.command) };
    return { toolName, toolInput: input, command: '' };
  }
  if (typeof params.command === 'string') return { toolName: '', toolInput: {}, command: trimString(params.command) };
  if (Array.isArray(params.command)) {
    return {
      toolName: '',
      toolInput: {},
      command: params.command.map((part) => trimString(part)).filter(Boolean).join(' '),
    };
  }
  return { toolName: '', toolInput: {}, command: '' };
}

/**
 * Risk-gated decision for one provider gate request (plan phase 2). Replaces the
 * privileged-only trigger (sentinel-or-sudo) with a universal risk assessment:
 * every tool call is classified safe/caution/danger, and the gate accumulates
 * exactly the ops that need the privileged executor or are danger-tier.
 *
 * Recommended mode auto-allows caution-tier work. Safe mode sends caution-tier
 * work to the owner. Danger and privileged operations enter the existing
 * privileged approval flow; unknown tools, capability grants, and incomplete
 * Codex file-change requests remain on the owner path.
 *
 * @param {object} approval   Normalized approval record.
 * @param {object} [options]
 * @param {string} [options.riskMode]      'safe' | 'recommended' (else PASS).
 * @param {string} [options.cwd]
 * @param {string} [options.projectRoot]   Project root for in-project checks.
 * @param {string} [options.home]          $HOME override.
 * @param {object} [options.riskContext]   Frozen admission-time path context.
 * @returns {{decision:string, reason:string, command?:string, risk?:object, sentinel?:object|null, op?:object}}
 */
function decideRiskGateCore(approval, options = {}) {
  const requestedRiskMode = trimString(options.riskMode);
  const riskMode = requestedRiskMode === 'full-auto' ? 'recommended'
    : requestedRiskMode === 'conservative-auto' ? 'safe'
      : requestedRiskMode;
  if (riskMode !== 'safe' && riskMode !== 'recommended') {
    return { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'risk mode off' };
  }
  if (!approval?.approvalId) {
    return { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'not an approval request' };
  }

  const checkpoint = approvalCheckpoint(approval);
  if (checkpoint) {
    const reason = checkpoint === 'permission_expansion' ? 'additional permissions require owner approval' : 'permission gate requires owner approval';
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason, reasonCode: checkpoint,
      risk: { tier: RISK_TIER.DANGER, confidence: 'high', reasons: [{ code: checkpoint, message: reason }], signals: { reasons: [reason] } } };
  }

  if (hasAmbiguousCommandArgv(approval)) {
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: 'command argument boundaries require context review',
      decisionClass: 'review_needed', reasonCode: 'command_arguments_ambiguous' };
  }

  const { toolName, toolInput, command } = readGateToolContext(approval);
  const sentinel = parsePrivilegedSentinel(command);
  if (sentinel?.isSentinel && !sentinel.valid) {
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT,
      reason: `malformed sentinel (${sentinel.malformedReason || 'unparseable'})`, command, sentinel };
  }
  const realCommand = sentinel?.valid ? sentinel.realCommand : command;
  const declaredCategory = sentinel?.valid ? trimString(sentinel.declaredCategory) : '';

  const riskInput = {
    command: realCommand,
    toolName,
    toolInput,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    home: options.home,
    declaredCategory,
    riskContext: options.riskContext,
  };
  const legacyRisk = classifyRisk(riskInput);
  const literalRisk = Array.isArray(options.literalArgv) && !sentinel?.valid
    ? classifyRisk({ ...riskInput, literalArgv: options.literalArgv }) : null;
  // Text analysis remains an additive backstop: argv facts may not downgrade
  // any independently detected danger, privilege need or unresolved effect.
  const rank = { safe: 0, caution: 1, danger: 2 };
  const legacyStricter = !literalRisk || (rank[legacyRisk.tier] ?? 2) > (rank[literalRisk.tier] ?? 2)
    || ((rank[legacyRisk.tier] ?? 2) === (rank[literalRisk.tier] ?? 2)
      && ((legacyRisk.facts?.unknownProgram && !literalRisk.facts?.unknownProgram)
        || (legacyRisk.signals?.complex && !literalRisk.signals?.complex)));
  const selectedRisk = legacyStricter ? legacyRisk : literalRisk;
  const risk = literalRisk ? { ...selectedRisk,
    signals: { ...selectedRisk.signals,
      needsPrivilegedExecution: Boolean(legacyRisk.signals?.needsPrivilegedExecution || literalRisk.signals?.needsPrivilegedExecution),
      autoExecute: selectedRisk.tier !== RISK_TIER.DANGER && selectedRisk.signals?.autoExecute === true } } : legacyRisk;

  const reasonText = `risk ${risk.tier}: ${(risk.signals?.reasons || []).join('; ') || 'no reason'}`;

  // Capability requests require owner review even if their payload resembles
  // an ordinary file tool or file change.
  if (OWNER_PROMPT_GATE_METHODS.has(trimString(approval.providerMethod))) {
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT,
      reason: `${reasonText}; permission gate requires owner approval`, command, risk };
  }

  const claudeToolDecision = decideClaudeToolApproval(approval, { riskMode });
  if (claudeToolDecision) return { ...claudeToolDecision, command, risk: claudeToolDecision.risk };

  if (requiresOwnerPrompt(approval)) {
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT,
      reason: `${reasonText}; permission gate requires owner approval`, command, risk };
  }

  const codexFileChange = classifyCodexFileChangeRisk(approval, options);
  if (codexFileChange) {
    const fileRisk = codexFileChange.risk;
    const fileReason = `risk ${fileRisk.tier}: ${(fileRisk.signals?.reasons || []).join('; ') || 'file change'}`;
    const fileVerdict = decideApprovalFacts([approvalFact({ tier: fileRisk.tier, complete: codexFileChange.complete, reason: fileReason })], { riskMode });
    if (fileVerdict.decision === 'review' || fileRisk.signals?.needsPrivilegedExecution === true) {
      return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: `${fileReason}; Codex file change requires owner review`, command: '', risk: fileRisk,
        ...(!codexFileChange.complete ? { decisionClass: 'review_needed', reasonCode: 'file_change_incomplete' } : {}) };
    }
    return { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: fileReason, command: '', risk: fileRisk };
  }

  // Known file tools have no shell command to route through the privileged
  // executor. Keep ordinary file work automatic; safe mode sends caution-tier
  // writes to the owner. Danger-tier requests always require owner review.
  if (!realCommand) {
    if (isKnownFileGate(approval, toolName)) {
      if (toolName && !trimString(toolInput.file_path || toolInput.path || toolInput.notebook_path)) {
        return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: 'file target requires context review', command: '', risk,
          decisionClass: 'review_needed', reasonCode: 'file_target_unspecified' };
      }
      if (risk.tier === RISK_TIER.DANGER || risk.signals?.needsPrivilegedExecution === true) {
        return {
          decision: PRIVILEGED_GATE_DECISION.PROMPT,
          reason: `${reasonText}; dangerous file gate requires owner approval`,
          command: '',
          risk,
        };
      }
      if (decideApprovalFacts([approvalFact({ tier: risk.tier, reason: reasonText })], { riskMode }).decision === 'review') {
        return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: `${reasonText}; safe mode requires owner approval`, command: '', risk };
      }
      return { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: reasonText, command: '', risk };
    }
    return {
      decision: PRIVILEGED_GATE_DECISION.PROMPT,
      reason: `${reasonText}; unknown non-command gate requires context review`,
      command: '',
      risk, decisionClass: 'review_needed', reasonCode: 'tool_semantics_unknown',
    };
  }

  if (!sentinel?.valid && risk.tier !== RISK_TIER.DANGER && risk.signals?.needsPrivilegedExecution !== true
      && (risk.facts?.unknownProgram === true || risk.signals?.complex === true)) {
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: `${reasonText}; command semantics require context review`, command, risk,
      decisionClass: 'review_needed', reasonCode: 'command_semantics_unknown' };
  }

  const verdict = decideApprovalFacts([approvalFact({ tier: risk.tier, reason: reasonText })], { riskMode });
  if (!sentinel?.valid && risk.tier !== RISK_TIER.DANGER && risk.signals?.needsPrivilegedExecution !== true
      && verdict.decision === 'review') {
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: `${reasonText}; ${risk.tier === RISK_TIER.CAUTION ? 'safe mode requires owner approval' : 'command risk requires context review'}`, command, risk,
      ...(risk.tier === RISK_TIER.CAUTION ? {} : { decisionClass: 'review_needed', reasonCode: 'command_risk_unknown' }) };
  }

  // A declared managed action must never auto-allow its provider shell just
  // because the extracted inner command looks benign. Shell text before or
  // around the separator may have unrelated effects.
  const shouldAccumulate = Boolean(sentinel?.valid) || risk.tier === RISK_TIER.DANGER
    || risk.signals?.needsPrivilegedExecution === true;

  if (!shouldAccumulate) {
    return { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: reasonText, command, risk };
  }

  return {
    decision: PRIVILEGED_GATE_DECISION.ACCUMULATE,
    reason: reasonText,
    command,
    risk,
    sentinel: sentinel || null,
    op: {
      approvalId: approval.approvalId,
      command: realCommand,
      declaredCategory,
      description: sentinel?.description || '',
      cwd: trimString(options.cwd),
      wrapperCommand: sentinel?.valid ? command : '',
      risk,
    },
  };
}

// Preserve the existing gate decision for callers while making uncertainty
// explicit. Context review never converts a hard authorization into a grant.
export function annotateGateDecision(result, stage = 'risk_classification') {
  if (!result || typeof result !== 'object') return result;
  const decisionClass = result.decisionClass || (result.decision === PRIVILEGED_GATE_DECISION.AUTO_ALLOW ? 'allow'
    : result.decision === PRIVILEGED_GATE_DECISION.PASS ? 'ask' : 'ask');
  return { ...result, decisionClass, needsContextReview: decisionClass === 'review_needed',
    reasonCode: result.reasonCode || result.risk?.reasons?.[0]?.code || (decisionClass === 'allow' ? 'ordinary_operation' : 'approval_required'),
    stage: result.stage || stage };
}

// Necessary, not sufficient: callers must separately bind the reviewed input,
// executable/tool identity and all affected targets to independently verified facts.
export function isContextReviewOverrideForbidden(result) {
  return !result || result.decisionClass !== 'review_needed'
    || result.needsContextReview !== true
    || result.risk?.tier === RISK_TIER.DANGER
    || result.risk?.signals?.needsPrivilegedExecution === true
    || result.risk?.signals?.targetScope === 'protected-control';
}

export function decideRiskGate(approval, options = {}) {
  return annotateGateDecision(decideRiskGateCore(approval, options));
}

// Verify literal effects using a caller-validated local Run context. This
// performs filesystem metadata checks and does not authorize a shell command.
export async function verifyPosixPathEffects({ context, cwd, effects } = {}) {
  const root = context?.trustedWorkspaceRoot;
  const within = (target, base) => {
    const relative = path.posix.relative(base, target);
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
  };
  // Default macOS volumes commonly fold case and Unicode spelling. Treat
  // either spelling as protected while keeping workspace admission strict.
  const protectionKey = value => context.platform === 'darwin' ? value.normalize('NFD').toLowerCase() : value;
  const withinProtected = (target, base) => within(protectionKey(target), protectionKey(base));
  const sensitive = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.ragent|\.config|\.netrc|\.npmrc|\.pypirc|id_[a-z0-9_]+|.*(?:credential|secret|password|token).*|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
  let verified = context && ['linux', 'darwin'].includes(context.platform)
    && typeof root === 'string' && path.posix.isAbsolute(root)
    && typeof cwd === 'string' && path.posix.isAbsolute(cwd)
    && Array.isArray(context.protectedRoots) && Array.isArray(effects) && effects.length > 0 && effects.length <= 128;
  let verifiedCwd = '';
  try {
    if (!verified) throw new Error('invalid scope');
    const lexicalRoot = path.posix.resolve(root), lexicalCwd = path.posix.resolve(cwd);
    const canonicalRoot = await realpath(lexicalRoot), canonicalCwd = await realpath(lexicalCwd);
    verifiedCwd = canonicalCwd;
    const readOnly = effects.every(effect => effect.kind === 'read' || effect.kind === 'list');
    if ((!within(lexicalCwd, lexicalRoot) || !within(canonicalCwd, canonicalRoot)) && !readOnly) throw new Error('cwd outside workspace');
    const roots = [...context.protectedRoots, ...systemPathRootsForPlatform('posix'),
      ...(Array.isArray(context.systemPathRoots) ? context.systemPathRoots : [])];
    const protectedRoots = await Promise.all(roots.map(async entry => {
      const value = typeof entry === 'string' ? entry : entry?.path;
      if (typeof value !== 'string' || !path.posix.isAbsolute(value)) throw new Error('invalid protected root');
      const lexical = path.posix.resolve(value); let current = lexical; const suffix = [];
      for (;;) {
        try { return { lexical, canonical: path.posix.resolve(await realpath(current), ...suffix) }; }
        catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          const parent = path.posix.dirname(current);
          if (parent === current) throw error;
          suffix.unshift(path.posix.basename(current)); current = parent;
        }
      }
    }));
    if (protectedRoots.some(item => withinProtected(lexicalCwd, item.lexical) || withinProtected(canonicalCwd, item.canonical))) throw new Error('cwd in protected scope');
    const inputTargets = new Set(effects.filter(effect => ['read', 'list'].includes(effect.kind)).map(effect => protectionKey(path.posix.resolve(lexicalCwd, effect.path))));
    const outputTargets = effects.filter(effect => ['write', 'append'].includes(effect.kind)).map(effect => protectionKey(path.posix.resolve(lexicalCwd, effect.path)));
    if (new Set(outputTargets).size !== outputTargets.length || outputTargets.some(target => inputTargets.has(target))) throw new Error('overlapping file targets');
    for (const effect of effects) {
      const operand = effect.path;
      if (typeof operand !== 'string' || !operand || operand.startsWith('//') || (effect.kind !== 'list' && operand.endsWith('/')) || operand.split('/').includes('..')
          || operand.split('/').filter(Boolean).length > 64) throw new Error('invalid target');
      const target = path.posix.resolve(lexicalCwd, operand);
      const outside = !within(target, lexicalRoot);
      if ((outside && (!readOnly || typeof process.getuid !== 'function')) || target.split('/').some(part => sensitive.test(part.normalize('NFD')))
          || protectedRoots.some(item => withinProtected(target, item.lexical))) throw new Error('protected target');
      let current = '/'; const parts = target.split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i += 1) {
        current = path.posix.join(current, parts[i]);
        let info;
        try { info = await lstat(current); }
        catch (error) {
          if (error?.code === 'ENOENT' && i === parts.length - 1 && ['write', 'append'].includes(effect.kind)) break;
          throw error;
        }
        if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())
            || (i === parts.length - 1 && (effect.kind === 'list' ? !(info.isFile() || info.isDirectory()) || (info.isFile() && info.nlink !== 1) : (!info.isFile() || info.nlink !== 1)))
            || (outside && (i === parts.length - 1 ? info.uid !== process.getuid() : info.uid !== 0 && info.uid !== process.getuid()))) throw new Error('unsafe target');
      }
      const parent = await realpath(path.posix.dirname(target));
      const canonical = path.posix.join(parent, path.posix.basename(target));
      if ((!outside && !within(canonical, canonicalRoot)) || protectedRoots.some(item => withinProtected(canonical, item.canonical))) throw new Error('canonical target outside scope');
    }
  } catch { verified = false; }
  return { verified, cwd: verifiedCwd };
}

// Asynchronous AST path for real runs; the synchronous API stays compatible
// with existing callers. The original hard decision is never weakened.
export async function decideRiskGateWithSyntax(approval, options = {}) {
  const initial = decideRiskGate(approval, options);
  const { command, toolName } = readGateToolContext(approval);
  const params = approval?.params || {};
  const rawCommand = toolName === 'Bash' ? params.input?.command : params.command;
  const rawStringValid = typeof rawCommand !== 'string' || (!rawCommand.includes('\0')
    && !/[^ \t\r\n]/.test(rawCommand.slice(0, rawCommand.length - rawCommand.trimStart().length))
    && !/[^ \t\r\n]/.test(rawCommand.slice(rawCommand.trimEnd().length)));
  // A literal listing of a protected path is still owner-approved, but does
  // not need the privileged executor merely because the path is protected.
  // Any independent danger, capability grant, or unsupported syntax keeps its
  // original decision. This never establishes executable or object identity.
  if (command && rawStringValid && (!toolName || toolName === 'Bash') && initial.decision === PRIVILEGED_GATE_DECISION.ACCUMULATE
      && initial.risk?.signals?.reasons?.length === 1
      && initial.risk.signals.reasons[0] === 'targets Ragent control-plane path'
      && !parsePrivilegedSentinel(command)?.isSentinel
      && !initial.risk.signals.sudo
      && options.riskContext?.schemaVersion === 1
      && typeof options.riskContext.trustedWorkspaceRoot === 'string'
      && options.riskContext.trustedWorkspaceRoot.length > 0
      && Array.isArray(options.riskContext.protectedRoots)
      && ['linux', 'darwin'].includes(options.riskContext?.platform)) {
    const syntax = await assessPosixShellSyntax(typeof rawCommand === 'string' ? rawCommand : command);
    if (syntax.metadataListing) return annotateGateDecision({
      ...initial, decision: PRIVILEGED_GATE_DECISION.PROMPT, decisionClass: 'ask',
      reasonCode: 'protected_metadata_listing',
      reason: 'listing a protected control-plane path requires owner approval in the existing sandbox',
      op: undefined,
      risk: { ...initial.risk,
        reasons: [{ code: 'protected_metadata_listing', message: 'protected control-plane metadata listing requires owner approval' }],
        signals: { ...initial.risk.signals, needsPrivilegedExecution: false,
          reasons: ['protected control-plane metadata listing requires owner approval'] },
        originalScopeReasons: initial.risk.reasons },
      syntaxFacts: { parser: 'mvdan-sh-wasm', complete: syntax.complete, reasonCode: syntax.reasonCode,
        nodeTypes: syntax.nodeTypes || [], commandCount: syntax.commandCount || 0, metadataListing: true },
    }, 'posix_ast');
  }
  const unresolvedComposite = initial.decisionClass === 'ask' && initial.risk?.tier === RISK_TIER.CAUTION
    && initial.risk?.signals?.needsPrivilegedExecution !== true
    && initial.risk?.reasons?.length === 1 && initial.risk.reasons[0].code === 'composite_unanalyzed';
  if (!command || (toolName && toolName !== 'Bash') || initial.reasonCode === 'command_arguments_ambiguous'
      || (initial.decisionClass === 'ask' && !unresolvedComposite)
      || initial.decisionClass === 'deny') return initial;
  if ([params.approvalKind, params.approval_kind].some(kind => kind != null && kind !== 'command')) {
    return annotateGateDecision({ ...initial, decision: PRIVILEGED_GATE_DECISION.PROMPT,
      decisionClass: 'ask', reasonCode: 'approval_kind_requires_review',
      reason: 'approval kind requires owner review', op: undefined }, 'posix_ast');
  }
  if (!rawStringValid || (typeof rawCommand !== 'string' && !Array.isArray(rawCommand))) {
    return annotateGateDecision({ ...initial, decision: PRIVILEGED_GATE_DECISION.PROMPT,
      decisionClass: 'review_needed', reasonCode: 'shell_input_ambiguous',
      reason: 'shell input requires context review', op: undefined }, 'posix_ast');
  }
  const syntax = await assessPosixShellSyntax(typeof rawCommand === 'string' ? rawCommand : command);
  const syntaxFacts = { parser: 'mvdan-sh-wasm', complete: syntax.complete, reasonCode: syntax.reasonCode,
    nodeTypes: syntax.nodeTypes || [], commandCount: syntax.commandCount || 0,
    effectCount: syntax.effects?.length || 0, effectKinds: [...new Set((syntax.effects || []).map(effect => effect.kind))] };
  if (!syntax.complete) return annotateGateDecision({ ...initial, syntaxFacts, decision: PRIVILEGED_GATE_DECISION.PROMPT,
    decisionClass: 'review_needed', reasonCode: syntax.reasonCode,
    reason: 'shell syntax needs context review' }, 'posix_ast');
  const decisions = syntax.commands.map((part, index) => {
    const params = approval.params || {};
    const rewritten = toolName === 'Bash'
      ? { ...approval, params: { ...params, input: { ...params.input, command: part } } }
      : { ...approval, params: { ...params, command: part } };
    return decideRiskGate(rewritten, { ...options, literalArgv: syntax.commandFacts?.[index]?.argv });
  });
  const denied = decisions.find(item => item.decisionClass === 'deny');
  if (denied) return annotateGateDecision({ ...denied, command, syntaxFacts }, 'posix_ast');
  const hard = decisions.find(item => item.decisionClass === 'ask');
  if (hard) return annotateGateDecision({ ...hard, decision: PRIVILEGED_GATE_DECISION.PROMPT,
    reason: 'a shell command requires approval', command, op: undefined }, 'posix_ast');
  // Effects are verified together against the Run's actual cwd and its
  // admission-time workspace. A failed or incomplete proof keeps review.
  if (syntax.commandFacts.length > 1 && syntax.commandFacts.some(fact =>
    ['ls', 'cat', 'head', 'tail'].includes(fact.argv?.[0]) && !fact.boundedRead
      && !fact.stdinOnly)) {
    return annotateGateDecision({ ...initial, command, syntaxFacts, decision: PRIVILEGED_GATE_DECISION.PROMPT,
      decisionClass: 'review_needed', reasonCode: 'shell_effects_incomplete',
      reason: 'shell command effects require context review', op: undefined }, 'posix_ast');
  }
  if ((syntax.pipelines || []).some(pipeline => pipeline.recursiveSearch)
      && (syntax.groups.length !== 1 || syntax.commandFacts.length !== 2 || syntax.effects.length)) {
    return annotateGateDecision({ ...initial, command, syntaxFacts, decision: PRIVILEGED_GATE_DECISION.PROMPT,
      decisionClass: 'review_needed', reasonCode: 'shell_effects_incomplete',
      reason: 'recursive search effects require context review', op: undefined }, 'posix_ast');
  }
  const effects = [...(syntax.effects || []), ...syntax.commandFacts.flatMap(fact => fact.readEffects)];
  let requiredCwdGuard = '';
  const pipelineByCommand = new Map();
  for (const pipeline of syntax.pipelines || []) for (const index of pipeline.indexes) pipelineByCommand.set(index, pipeline);
  // Only bounded reads, stdin filters and literal builtins may share a
  // proof; verified, non-overlapping ordinary output redirects are allowed.
  if (effects.length && syntax.commandFacts.length > 1) {
    const unstable = syntax.commandFacts.some((fact, index) => {
      const builtin = ['echo', 'pwd', 'true', 'false', ':'].includes(fact.argv?.[0]);
      const pipeline = pipelineByCommand.get(index);
      const filter = pipeline?.bounded && pipeline.indexes[0] !== index && fact.stdinOnly;
      return !builtin && !fact.boundedRead && !filter;
    });
    if (unstable) return annotateGateDecision({ ...initial, command, syntaxFacts,
      decision: PRIVILEGED_GATE_DECISION.PROMPT, decisionClass: 'review_needed',
      reasonCode: 'shell_effects_incomplete', reason: 'shell effects require context review', op: undefined }, 'posix_ast');
  }
  if (syntax.effects?.length) {
    const unproved = syntax.commandFacts.some((fact, index) => {
      const builtin = ['echo', 'pwd', 'true', 'false', ':'].includes(fact.argv?.[0]);
      const pipeline = pipelineByCommand.get(index);
      const filter = fact.stdinOnly;
      const pipelineFilter = pipeline?.bounded && pipeline.indexes[0] !== index && filter;
      if (!builtin && !fact.boundedRead && !pipelineFilter && !(filter && fact.effects.some(effect => effect.kind === 'read'))) return true;
      return fact.effects.some(effect => effect.kind === 'read'
        ? !filter || Boolean(pipeline) || fact.boundedRead
        : !builtin && !fact.boundedRead && !pipelineFilter && !filter)
        || fact.effects.some((effect, n) => fact.effects.findIndex(other => (other.kind === 'read') === (effect.kind === 'read')) !== n);
    });
    if (unproved) return annotateGateDecision({ ...initial, command, syntaxFacts, decision: PRIVILEGED_GATE_DECISION.PROMPT,
      decisionClass: 'review_needed', reasonCode: 'shell_effects_incomplete', reason: 'shell effects require context review', op: undefined }, 'posix_ast');
  }
  if (effects.length) {
    const context = options.riskContext;
    const root = context?.trustedWorkspaceRoot;
    const params = approval?.params || {};
    const input = params.input && typeof params.input === 'object' ? params.input : {};
    const foreignEnvironment = options.localExecution !== true
      || [params, input].some(source => ['environmentId', 'environment_id', 'executionEnvironment', 'execution_environment'].some(key => Object.hasOwn(source, key)));
    const unsupportedApprovalKind = [params.approvalKind, params.approval_kind].some(kind => kind != null && kind !== 'command');
    // Codex binds cwd to the command execution approval itself. Claude Bash
    // can persist cwd across invocations, so the Run's initial cwd is not an
    // attestation of the shell's current directory.
    const codexCwd = approval?.providerMethod === 'item/commandExecution/requestApproval'
      && approval?.kind === 'command' && typeof params.command === 'string'
      && ['threadId', 'turnId', 'itemId'].every(key => typeof params[key] === 'string' && params[key].trim())
      && typeof params.cwd === 'string' && path.posix.isAbsolute(params.cwd) ? params.cwd : '';
    const claudeCwd = options.claudeCwdGuardCandidate === true && approval?.providerMethod === 'can_use_tool'
      && approval?.kind === 'command' && toolName === 'Bash'
      && typeof params.tool_use_id === 'string' && params.tool_use_id
      && typeof rawCommand === 'string' && typeof options.cwd === 'string' && path.posix.isAbsolute(options.cwd)
      && Object.keys(input).every(key => ['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'].includes(key))
      && (input.run_in_background === undefined || input.run_in_background === false)
      && (input.dangerouslyDisableSandbox === undefined || input.dangerouslyDisableSandbox === false)
      ? options.cwd : '';
    const cwdOverride = ['cwd', 'working_directory', 'workingDirectory', 'workdir', 'work_dir']
      .some(key => Object.hasOwn(input, key))
      || ['working_directory', 'workingDirectory', 'workdir', 'work_dir']
        .some(key => Object.hasOwn(params, key))
      || (Object.hasOwn(params, 'cwd') && !codexCwd);
    const claudeInputUnbound = approval?.providerMethod === 'can_use_tool' && (!claudeCwd
      || Object.keys(input).some(key => !['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'].includes(key))
      || (input.run_in_background !== undefined && input.run_in_background !== false)
      || (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false));
    const cwd = codexCwd || claudeCwd || root;
    const eligible = context?.schemaVersion === 1 && ['linux', 'darwin'].includes(context.platform)
      && typeof root === 'string' && path.posix.isAbsolute(root)
      && typeof cwd === 'string' && path.posix.isAbsolute(cwd)
      && !foreignEnvironment && !unsupportedApprovalKind && !cwdOverride && !claudeInputUnbound
      && (codexCwd || claudeCwd || effects.every(effect => typeof effect.path === 'string' && path.posix.isAbsolute(effect.path)))
      && Array.isArray(context.protectedRoots) && effects.length <= 128;
    const proof = eligible ? await verifyPosixPathEffects({ context, cwd, effects }) : { verified: false };
    const verified = proof.verified;
    const verifiedCwd = proof.cwd;
    if (!verified) {
      const cwdMissing = !codexCwd && !claudeCwd && effects.some(effect => typeof effect.path === 'string' && !path.posix.isAbsolute(effect.path));
      return annotateGateDecision({ ...initial, command, syntaxFacts,
        decision: PRIVILEGED_GATE_DECISION.PROMPT, decisionClass: 'review_needed',
        reasonCode: cwdMissing ? 'shell_cwd_unverified' : 'shell_effect_scope_unverified',
        reason: cwdMissing ? 'shell working directory requires verification' : 'shell file targets require scope review', op: undefined }, 'posix_ast');
    }
    if (claudeCwd && effects.some(effect => !path.posix.isAbsolute(effect.path))) {
      requiredCwdGuard = verifiedCwd;
    }
  }
  if (!syntax.classifiedLiterals?.every(Boolean)) return annotateGateDecision({ ...initial, command, syntaxFacts,
    decision: PRIVILEGED_GATE_DECISION.PROMPT, decisionClass: 'review_needed',
    reasonCode: 'command_semantics_unknown', reason: 'shell command semantics require context review' }, 'posix_ast');
  const hasWrite = effects.some(effect => ['write', 'append'].includes(effect.kind));
  const aggregate = decideApprovalFacts([...decisions.map(approvalFactFromGate), ...(hasWrite ? [approvalFact({ tier: 'safe', reason: 'in-project file edit' })] : [])], { riskMode: options.riskMode === 'conservative-auto' ? 'safe' : options.riskMode });
  if (aggregate.decision === 'review') return annotateGateDecision({ ...(aggregate.item || initial),
    decision: PRIVILEGED_GATE_DECISION.PROMPT, decisionClass: 'review_needed',
    reasonCode: aggregate.item?.reasonCode || 'command_risk_unknown',
    reason: aggregate.reason || 'shell command risk requires context review', command, syntaxFacts, op: undefined }, 'posix_ast');
  const riskReasons = decisions.flatMap(item => item.risk?.reasons || []);
  if (hasWrite) riskReasons.push({ code: 'file_edit_project', message: 'in-project file edit' });
  const finalRisk = { ...(aggregate.item?.risk || initial.risk), tier: aggregate.tier,
    reasons: riskReasons, signals: { ...(aggregate.item?.risk?.signals || initial.risk?.signals),
      composite: false, reasons: riskReasons.map(reason => reason.message) } };
  return annotateGateDecision({ ...initial, decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW,
    decisionClass: 'allow', reasonCode: 'shell_commands_classified',
    reason: 'all literal shell commands independently classified', command, syntaxFacts,
    requiredCwdGuard: requiredCwdGuard || undefined,
    risk: finalRisk }, 'posix_ast');
}
