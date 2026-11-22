import { sanitizeEmailCompletionTargets, dispatchSessionEmailCompletionTargets } from './agent-mail-completion-targets.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR } from './config.mjs';
import { createCalendarEvent, findCalendarEventReceipt, CALENDAR_ACTION_CONTRACTS, createCalendarConnectorAction } from './connector-calendar.mjs';
import { dispatchCalendarToFeed } from './connector-calendar-feed.mjs';
import { GITHUB_ACTION_CONTRACTS, createGitHubConnectorAction } from './connector-github.mjs';
import { GMAIL_ACTION_CONTRACTS, createGmailConnectorAction } from './connector-gmail.mjs';
import { DRIVE_ACTION_CONTRACTS, createDriveConnectorAction } from './connector-drive.mjs';
import { createConnectorActionResult } from './connector-state.mjs';
import { createKeyedTaskQueue } from '../chat/fs-utils.mjs';
import { getRun, updateRun } from '../chat/runs.mjs';

export const CONNECTOR_RISK_LEVELS = Object.freeze([
  'read',
  'reversible_write',
  'irreversible_write',
  'external_broadcast',
]);

export const CONNECTOR_CONFIRMATION_POLICIES = Object.freeze([
  'auto_within_policy',
  'require_approval',
  'hard_deny',
]);

export const CONNECTOR_ACTION_STATES = Object.freeze([
  'pending_approval',
  'denied',
  'conflict',
  'failed_pre_dispatch',
  'sending',
  'delivered',
  'unknown_outcome',
  'compensated',
]);

export const CONNECTOR_CORE_IDS = Object.freeze(['github', 'gmail', 'calendar', 'drive']);

const RISK_LEVEL_RANK = Object.freeze({
  read: 0,
  reversible_write: 1,
  irreversible_write: 2,
  external_broadcast: 3,
});

const AUTOMATED_APPROVER_IDS = new Set([
  'responsibility-policy-auto',
  'auto',
  'planner',
  'model',
  'prompt',
  'llm',
  'system',
  'agent',
  'bot',
]);

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 300_000;

export const CONNECTOR_ACTION_CONTRACTS = Object.freeze({
  ...GITHUB_ACTION_CONTRACTS,
  ...GMAIL_ACTION_CONTRACTS,
  ...CALENDAR_ACTION_CONTRACTS,
  ...DRIVE_ACTION_CONTRACTS,
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso(nowFn = null) {
  return typeof nowFn === 'function' ? new Date(nowFn()).toISOString() : new Date().toISOString();
}

function nowMs(nowFn = null) {
  return typeof nowFn === 'function' ? Number(nowFn()) : Date.now();
}

function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function canonicalDigest(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function createDispatcherError(message, { code = 'CONNECTOR_DISPATCH_ERROR', statusCode = 400, details = null } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (details) err.details = details;
  return err;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scopeHasWildcard(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '*' || trimmed === 'all' || trimmed === 'any';
  }
  if (Array.isArray(value)) return value.some(scopeHasWildcard);
  if (isPlainObject(value)) return Object.values(value).some(scopeHasWildcard);
  return false;
}

function normalizeReceiptVerifier(verifier, riskLevel) {
  if (typeof verifier === 'function') {
    return {
      kind: 'custom_verifier',
      supported: true,
      verify: verifier,
      description: 'Custom receipt verifier function.',
    };
  }
  if (!isPlainObject(verifier)) {
    throw createDispatcherError('Contract receiptVerifier must be an object or function.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  const kind = trimString(verifier.kind);
  if (!kind) {
    throw createDispatcherError('Contract receiptVerifier.kind is required.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  const supported = verifier.supported !== false;
  if (riskLevel !== 'read') {
    if (kind === 'none' || kind === 'none_readonly') {
      throw createDispatcherError(`Write/broadcast action (${riskLevel}) cannot declare a readonly receiptVerifier.`, {
        code: 'CONNECTOR_CONTRACT_INVALID',
        statusCode: 400,
      });
    }
    if (supported && typeof verifier.verify !== 'function') {
      throw createDispatcherError('Supported write/broadcast receiptVerifier must provide a verify() function.', {
        code: 'CONNECTOR_CONTRACT_INVALID',
        statusCode: 400,
      });
    }
    if (!supported && !trimString(verifier.reason)) {
      throw createDispatcherError('Unsupported write/broadcast receiptVerifier must declare a reason.', {
        code: 'CONNECTOR_CONTRACT_INVALID',
        statusCode: 400,
      });
    }
  }
  return {
    ...verifier,
    kind,
    supported,
  };
}

function normalizeCompensation(compensation) {
  if (!isPlainObject(compensation)) {
    throw createDispatcherError('Contract compensation must be an object.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  if (typeof compensation.supported !== 'boolean') {
    throw createDispatcherError('Contract compensation.supported must be a boolean.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  const mode = trimString(compensation.mode);
  const description = trimString(compensation.description);
  if (!mode || !description) {
    throw createDispatcherError('Contract compensation.mode and compensation.description are required.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  return {
    ...compensation,
    mode,
    description,
  };
}

/**
 * Validate a unified connector action contract descriptor. Every action must
 * explicitly declare capability, scope, riskLevel, idempotencyKey,
 * confirmationPolicy, timeoutMs, receiptVerifier, and compensation.
 */
export function validateConnectorActionContract(contract) {
  if (!isPlainObject(contract)) {
    throw createDispatcherError('Connector action contract must be a plain object.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }

  const capability = trimString(contract.capability);
  if (!capability || !/^[a-z0-9][a-z0-9._:-]{1,127}$/i.test(capability)) {
    throw createDispatcherError('Contract capability must be a valid non-empty capability identifier.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }

  if (!isPlainObject(contract.scope) || Object.keys(contract.scope).length === 0) {
    throw createDispatcherError('Contract scope must be a non-empty object.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  const connectorId = trimString(contract.scope.connectorId || contract.connectorId || capability.split('.')[0]).toLowerCase();
  const resource = trimString(contract.scope.resource);
  if (!connectorId || !resource) {
    throw createDispatcherError('Contract scope must declare non-empty connectorId and resource.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }

  const riskLevel = trimString(contract.riskLevel).toLowerCase();
  if (!CONNECTOR_RISK_LEVELS.includes(riskLevel)) {
    throw createDispatcherError(`Invalid contract riskLevel "${contract.riskLevel}".`, {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  if (riskLevel !== 'read' && scopeHasWildcard(contract.scope)) {
    throw createDispatcherError(`Write/broadcast scope for "${capability}" must not contain wildcards.`, {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }

  const idempotencyKey = trimString(contract.idempotencyKey);
  if (!idempotencyKey || idempotencyKey.length > 256 || /[\r\n\0]/.test(idempotencyKey)) {
    throw createDispatcherError('Contract idempotencyKey must be a non-empty string (<= 256 chars, no control characters).', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }

  const confirmationPolicy = trimString(contract.confirmationPolicy).toLowerCase();
  if (!CONNECTOR_CONFIRMATION_POLICIES.includes(confirmationPolicy)) {
    throw createDispatcherError(`Invalid contract confirmationPolicy "${contract.confirmationPolicy}".`, {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  if ((riskLevel === 'irreversible_write' || riskLevel === 'external_broadcast') && confirmationPolicy === 'auto_within_policy') {
    throw createDispatcherError(
      `Contract "${capability}" (${riskLevel}) cannot use confirmationPolicy "auto_within_policy".`,
      { code: 'CONNECTOR_CONTRACT_INVALID', statusCode: 400 },
    );
  }

  const timeoutMs = contract.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw createDispatcherError(`Contract timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`, {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }

  const receiptVerifier = normalizeReceiptVerifier(contract.receiptVerifier, riskLevel);
  const compensation = normalizeCompensation(contract.compensation);

  return {
    capability,
    connectorId,
    actionClass: trimString(contract.actionClass) || (riskLevel === 'read' ? 'read' : (riskLevel === 'reversible_write' ? 'write' : 'broadcast')),
    privilegeGroup: trimString(contract.privilegeGroup),
    scope: { ...contract.scope, connectorId, resource },
    riskLevel,
    idempotencyKey,
    confirmationPolicy,
    timeoutMs,
    receiptVerifier,
    compensation,
  };
}

export function buildConnectorActionContract(template, overrides = {}) {
  const merged = {
    ...(isPlainObject(template) ? template : {}),
    ...(isPlainObject(overrides) ? overrides : {}),
    scope: {
      ...(isPlainObject(template?.scope) ? template.scope : {}),
      ...(isPlainObject(overrides?.scope) ? overrides.scope : {}),
    },
  };
  return validateConnectorActionContract(merged);
}

export function getConnectorActionCatalog() {
  return Object.freeze(Object.values(CONNECTOR_ACTION_CONTRACTS));
}

export function getConnectorActionDefinition(capability) {
  return CONNECTOR_ACTION_CONTRACTS[trimString(capability)] || null;
}

export function createConnectorAction(capability, params = {}, options = {}) {
  const cap = trimString(capability);
  if (cap.startsWith('github.')) return createGitHubConnectorAction(cap, params, options);
  if (cap.startsWith('gmail.')) return createGmailConnectorAction(cap, params, options);
  if (cap.startsWith('calendar.')) return createCalendarConnectorAction(cap, params, options);
  if (cap.startsWith('drive.')) return createDriveConnectorAction(cap, params, options);
  throw createDispatcherError(`Unsupported connector capability: ${capability}`, {
    code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
    statusCode: 400,
  });
}

function sanitizeLedgerReceipt(receipt) {
  if (!isPlainObject(receipt)) return receipt ?? null;
  const copy = { ...receipt };
  delete copy.verify;
  return copy;
}

function extractConnectorScopedPolicy(rawScopes, connectorId) {
  if (!isPlainObject(rawScopes)) return {};
  if (Object.hasOwn(rawScopes, connectorId)) {
    return isPlainObject(rawScopes[connectorId]) ? rawScopes[connectorId] : {};
  }
  if (CONNECTOR_CORE_IDS.some((id) => Object.hasOwn(rawScopes, id))) {
    return {};
  }
  return rawScopes;
}

function validateScopeAgainstPolicy(contract, policy) {
  if (!policy) return null;
  const connectorScopes = policy.connectorScopes || policy.allowedScopes || {};
  const scope = contract.scope || {};
  const connectorId = contract.connectorId;
  const scopedPolicy = extractConnectorScopedPolicy(connectorScopes, connectorId);

  if (connectorId === 'github') {
    const allowedRepos = Array.isArray(scopedPolicy?.allowedRepositories) ? scopedPolicy.allowedRepositories.map((r) => trimString(r).toLowerCase()).filter(Boolean) : null;
    if (allowedRepos && contract.capability !== 'github.repo.list') {
      const repoName = trimString(scope.repository) || (scope.owner && scope.repo ? `${trimString(scope.owner)}/${trimString(scope.repo)}` : '');
      if (!repoName) {
        return `GitHub action "${contract.capability}" requires scope.repository when policy restricts allowedRepositories.`;
      }
      if (!allowedRepos.includes(repoName.toLowerCase())) {
        return `GitHub repository "${repoName}" is outside policy allowedRepositories.`;
      }
    }
    const allowedBranches = Array.isArray(scopedPolicy?.allowedBaseBranches) ? scopedPolicy.allowedBaseBranches.map(trimString).filter(Boolean) : null;
    if (allowedBranches) {
      if (contract.capability === 'github.pr.create' && !trimString(scope.base)) {
        return 'GitHub PR create requires scope.base when policy restricts allowedBaseBranches.';
      }
      if (trimString(scope.base) && !allowedBranches.includes(trimString(scope.base))) {
        return `GitHub base branch "${scope.base}" is outside policy allowedBaseBranches.`;
      }
    }
  }

  if (connectorId === 'gmail') {
    if (scopedPolicy?.allowDraftOnly === true && contract.capability === 'gmail.message.send') {
      return 'Policy limits Gmail connector to draft-only operations.';
    }
    const allowedRecipients = Array.isArray(scopedPolicy?.allowedRecipients) ? scopedPolicy.allowedRecipients.map((r) => trimString(r).toLowerCase()).filter(Boolean) : null;
    const allowedDomains = Array.isArray(scopedPolicy?.allowedRecipientDomains) ? scopedPolicy.allowedRecipientDomains.map((d) => trimString(d).toLowerCase()).filter(Boolean) : null;
    const recipients = Array.isArray(scope.recipients) ? scope.recipients.filter((r) => trimString(r)) : [];
    if ((allowedRecipients || allowedDomains) && (contract.capability === 'gmail.draft.create' || contract.capability === 'gmail.message.send') && recipients.length === 0) {
      return `Gmail action "${contract.capability}" requires non-empty scope.recipients when policy restricts recipients or domains.`;
    }
    for (const rawRecipient of recipients) {
      const addr = trimString(rawRecipient.replace(/^.*<([^>]+)>$/, '$1')).toLowerCase();
      if (allowedRecipients && !allowedRecipients.includes(addr)) {
        return `Gmail recipient "${addr}" is outside policy allowedRecipients.`;
      }
      if (allowedDomains) {
        const domain = addr.split('@')[1] || '';
        if (!domain || !allowedDomains.includes(domain)) {
          return `Gmail recipient domain "${domain || addr}" is outside policy allowedRecipientDomains.`;
        }
      }
    }
  }

  if (connectorId === 'calendar') {
    const allowedCalendars = Array.isArray(scopedPolicy?.allowedCalendarIds) ? scopedPolicy.allowedCalendarIds.map(trimString).filter(Boolean) : null;
    if (allowedCalendars) {
      if (!trimString(scope.calendarId)) {
        return `Calendar action "${contract.capability}" requires scope.calendarId when policy restricts allowedCalendarIds.`;
      }
      if (!allowedCalendars.includes(trimString(scope.calendarId))) {
        return `Calendar "${scope.calendarId}" is outside policy allowedCalendarIds.`;
      }
    }
  }

  if (connectorId === 'drive') {
    const allowedFolders = Array.isArray(scopedPolicy?.allowedFolderIds) ? scopedPolicy.allowedFolderIds.map(trimString).filter(Boolean) : null;
    if (allowedFolders) {
      if (contract.capability === 'drive.file.list') {
        if (!scope.folderId || !allowedFolders.includes(trimString(scope.folderId))) {
          return `Drive folder "${scope.folderId || '(root)'}" is outside policy allowedFolderIds.`;
        }
      } else if (contract.capability === 'drive.folder.create' || contract.capability === 'drive.file.create') {
        if (!scope.parentId || !allowedFolders.includes(trimString(scope.parentId))) {
          return `Drive parent folder "${scope.parentId || '(root)'}" is outside policy allowedFolderIds.`;
        }
      } else if (Array.isArray(scope.allowedFolderIds)) {
        if (!scope.allowedFolderIds.length || scope.allowedFolderIds.some((id) => !allowedFolders.includes(trimString(id)))) {
          return 'Drive action allowedFolderIds exceeds policy allowedFolderIds.';
        }
      } else {
        return 'Drive file access requires explicit allowedFolderIds intersection when policy restricts folders.';
      }
    }
    if (contract.capability === 'drive.file.share') {
      if (scope.publicExposure === true && scopedPolicy?.allowPublicExposure !== true && policy.allowPublicExposure !== true) {
        return 'Public Drive sharing ("anyone") is denied by policy.';
      }
      const allowedEmails = Array.isArray(scopedPolicy?.allowedShareEmails) ? scopedPolicy.allowedShareEmails.map((e) => trimString(e).toLowerCase()).filter(Boolean) : null;
      const allowedDomains = Array.isArray(scopedPolicy?.allowedShareDomains) ? scopedPolicy.allowedShareDomains.map((d) => trimString(d).toLowerCase()).filter(Boolean) : null;
      const shareType = trimString(scope.shareType).toLowerCase();
      if ((allowedEmails || allowedDomains) && !shareType) {
        return 'Drive share requires explicit scope.shareType when policy restricts sharing targets.';
      }
      if (allowedEmails) {
        if (shareType === 'user' || shareType === 'group') {
          if (!scope.emailAddress || !allowedEmails.includes(trimString(scope.emailAddress).toLowerCase())) {
            return `Drive share email "${scope.emailAddress || ''}" is outside policy allowedShareEmails.`;
          }
        } else if (!allowedDomains) {
          return `Drive share type "${shareType}" is not permitted when policy restricts allowedShareEmails.`;
        }
      }
      if (allowedDomains) {
        const domain = shareType === 'domain'
          ? trimString(scope.domain).toLowerCase()
          : (trimString(scope.emailAddress).toLowerCase().split('@')[1] || '');
        if (!domain || !allowedDomains.includes(domain)) {
          return `Drive share domain "${domain || ''}" is outside policy allowedShareDomains.`;
        }
      }
    }
  }

  return null;
}

function validateHumanApproval(approval, { contract, requestDigest, actor, currentMs }) {
  if (!isPlainObject(approval) || approval.confirmed !== true) {
    return { ok: false, code: 'CONNECTOR_APPROVAL_REQUIRED', reason: 'Explicit human confirmation (approval.confirmed=true) is required.' };
  }
  const approvedBy = trimString(approval.approvedBy || approval.actorId);
  if (!approvedBy || AUTOMATED_APPROVER_IDS.has(approvedBy.toLowerCase())) {
    return { ok: false, code: 'CONNECTOR_APPROVAL_INVALID', reason: 'Automated or model principal cannot satisfy human approval.' };
  }
  const actorKind = trimString(approval.actorKind).toLowerCase();
  if (actorKind && actorKind !== 'user') {
    return { ok: false, code: 'CONNECTOR_APPROVAL_INVALID', reason: `Approval actorKind "${actorKind}" is not a human user.` };
  }
  if (actor && actor.kind && actor.kind !== 'user') {
    if (!actorKind || (trimString(actor.principalId) && approvedBy === trimString(actor.principalId))) {
      return { ok: false, code: 'CONNECTOR_APPROVAL_INVALID', reason: 'Non-user actor cannot self-approve connector action without explicit human approval.' };
    }
  }
  if (actor && actor.kind === 'user' && actor.role && actor.role !== 'owner') {
    return { ok: false, code: 'CONNECTOR_FORBIDDEN', reason: 'Owner role is required to approve external connector mutations.' };
  }
  if (approval.idempotencyKey !== undefined && trimString(approval.idempotencyKey) !== contract.idempotencyKey) {
    return { ok: false, code: 'CONNECTOR_APPROVAL_MISMATCH', reason: 'Approval idempotencyKey does not match the action.' };
  }
  if (approval.capability !== undefined && trimString(approval.capability) !== contract.capability) {
    return { ok: false, code: 'CONNECTOR_APPROVAL_MISMATCH', reason: 'Approval capability does not match the action.' };
  }
  if (approval.actionDigest !== undefined && trimString(approval.actionDigest) !== requestDigest) {
    return { ok: false, code: 'CONNECTOR_APPROVAL_MISMATCH', reason: 'Approval actionDigest does not match the action payload.' };
  }
  const scopeDigest = canonicalDigest(contract.scope);
  if (approval.scopeDigest !== undefined && trimString(approval.scopeDigest) !== scopeDigest) {
    return { ok: false, code: 'CONNECTOR_APPROVAL_MISMATCH', reason: 'Approval scopeDigest does not match the action scope.' };
  }
  if (approval.expiresAt !== undefined) {
    const expMs = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= currentMs) {
      return { ok: false, code: 'CONNECTOR_APPROVAL_EXPIRED', reason: 'Approval has expired.' };
    }
  }
  return {
    ok: true,
    approvalId: trimString(approval.approvalId),
    approvedBy,
  };
}

/**
 * Deterministic pre-dispatch risk, capability, scope, and confirmation gate.
 * Irreversible writes and external broadcasts can never be auto-approved via
 * policy or prompt flags.
 */
export function evaluateConnectorActionPolicy({
  contract,
  payload = null,
  policy = null,
  approval = null,
  actor = null,
  nowMs: overrideNowMs = null,
} = {}) {
  const validated = validateConnectorActionContract(contract);
  const requestDigest = canonicalDigest({
    capability: validated.capability,
    scope: validated.scope,
    riskLevel: validated.riskLevel,
    confirmationPolicy: validated.confirmationPolicy,
    payload: payload ?? null,
  });

  if (validated.confirmationPolicy === 'hard_deny') {
    return {
      allowed: false,
      state: 'denied',
      code: 'CONNECTOR_ACTION_HARD_DENIED',
      reason: `Action "${validated.capability}" is blocked by confirmationPolicy "hard_deny".`,
      requestDigest,
    };
  }

  if (policy && isPlainObject(policy)) {
    const deniedList = Array.isArray(policy.deniedCapabilities) ? policy.deniedCapabilities.map(trimString) : [];
    if (deniedList.includes(validated.capability)) {
      return {
        allowed: false,
        state: 'denied',
        code: 'CONNECTOR_CAPABILITY_DENIED',
        reason: `Capability "${validated.capability}" is explicitly denied by policy.`,
        requestDigest,
      };
    }

    if (Array.isArray(policy.allowedCapabilities)) {
      const allowedSet = new Set(policy.allowedCapabilities.map(trimString).filter(Boolean));
      if (!allowedSet.has(validated.capability)) {
        return {
          allowed: false,
          state: 'denied',
          code: 'CONNECTOR_CAPABILITY_NOT_OPTED_IN',
          reason: `Capability "${validated.capability}" is not opted into policy.allowedCapabilities.`,
          requestDigest,
        };
      }
    }

    if (isPlainObject(policy.capabilityGates)) {
      const gates = policy.capabilityGates;
      if (validated.riskLevel === 'read' && gates.allowConnectorRead !== true) {
        return {
          allowed: false,
          state: 'denied',
          code: 'CONNECTOR_GATE_DISABLED',
          reason: 'Connector read actions require policy.capabilityGates.allowConnectorRead=true.',
          requestDigest,
        };
      }
      if (validated.riskLevel === 'reversible_write' && gates.allowConnectorWrite !== true) {
        return {
          allowed: false,
          state: 'denied',
          code: 'CONNECTOR_GATE_DISABLED',
          reason: 'Connector write actions require policy.capabilityGates.allowConnectorWrite=true.',
          requestDigest,
        };
      }
      if ((validated.riskLevel === 'irreversible_write' || validated.riskLevel === 'external_broadcast') && gates.allowConnectorBroadcast !== true) {
        return {
          allowed: false,
          state: 'denied',
          code: 'CONNECTOR_GATE_DISABLED',
          reason: `Connector ${validated.riskLevel} actions require policy.capabilityGates.allowConnectorBroadcast=true.`,
          requestDigest,
        };
      }
    }

    if (policy.maxRiskLevel) {
      const maxLevel = trimString(policy.maxRiskLevel).toLowerCase();
      if (!CONNECTOR_RISK_LEVELS.includes(maxLevel) || RISK_LEVEL_RANK[validated.riskLevel] > RISK_LEVEL_RANK[maxLevel]) {
        return {
          allowed: false,
          state: 'denied',
          code: 'CONNECTOR_RISK_EXCEEDED',
          reason: `Action risk "${validated.riskLevel}" exceeds policy maxRiskLevel "${policy.maxRiskLevel}".`,
          requestDigest,
        };
      }
    }

    const scopeViolation = validateScopeAgainstPolicy(validated, policy);
    if (scopeViolation) {
      return {
        allowed: false,
        state: 'denied',
        code: 'CONNECTOR_SCOPE_VIOLATION',
        reason: scopeViolation,
        requestDigest,
      };
    }
  }

  // Irreversible writes & external broadcasts ALWAYS require explicit human confirmation.
  const mandatoryApproval = validated.riskLevel === 'irreversible_write'
    || validated.riskLevel === 'external_broadcast'
    || validated.confirmationPolicy === 'require_approval';

  const autoReversiblePermitted = validated.riskLevel === 'reversible_write'
    && validated.confirmationPolicy === 'auto_within_policy'
    && policy?.withinPolicy === true
    && policy?.allowAutoWithinPolicyReversible === true;

  const autoReadPermitted = validated.riskLevel === 'read'
    && validated.confirmationPolicy === 'auto_within_policy'
    && policy?.requireApprovalForReads !== true;

  const requiresApproval = mandatoryApproval || !(autoReadPermitted || autoReversiblePermitted);
  if (requiresApproval) {
    const currentMs = nowMs(overrideNowMs ? () => overrideNowMs : null);
    const approvalCheck = validateHumanApproval(approval, {
      contract: validated,
      requestDigest,
      actor,
      currentMs,
    });
    if (!approvalCheck.ok) {
      return {
        allowed: false,
        needsApproval: approvalCheck.code === 'CONNECTOR_APPROVAL_REQUIRED',
        state: approvalCheck.code === 'CONNECTOR_APPROVAL_REQUIRED' ? 'pending_approval' : 'denied',
        code: approvalCheck.code,
        reason: approvalCheck.reason,
        requestDigest,
        approvalChallenge: {
          capability: validated.capability,
          connectorId: validated.connectorId,
          riskLevel: validated.riskLevel,
          scope: validated.scope,
          idempotencyKey: validated.idempotencyKey,
          actionDigest: requestDigest,
          scopeDigest: canonicalDigest(validated.scope),
        },
      };
    }
    return {
      allowed: true,
      requiresApproval: true,
      approvedBy: approvalCheck.approvedBy,
      approvalId: approvalCheck.approvalId,
      requestDigest,
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
    approvedBy: '',
    approvalId: '',
    requestDigest,
  };
}

function ensureLedgerSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS connector_action_ledger (
      idempotency_key TEXT PRIMARY KEY,
      capability TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      confirmation_policy TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      wire_crossed INTEGER NOT NULL DEFAULT 0,
      safe_to_retry INTEGER NOT NULL DEFAULT 0,
      approval_id TEXT,
      approved_by TEXT,
      approval_json TEXT,
      external_id TEXT,
      receipt_json TEXT,
      compensation_json TEXT,
      error_code TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS connector_action_ledger_state_idx
      ON connector_action_ledger(state, updated_at);
    CREATE INDEX IF NOT EXISTS connector_action_ledger_approval_idx
      ON connector_action_ledger(approval_id) WHERE approval_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS connector_action_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      state TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS connector_action_events_key_idx
      ON connector_action_events(idempotency_key, sequence);
  `);
}

function mapLedgerRow(row) {
  if (!row) return null;
  return {
    idempotencyKey: row.idempotency_key,
    capability: row.capability,
    connectorId: row.connector_id,
    riskLevel: row.risk_level,
    confirmationPolicy: row.confirmation_policy,
    scope: parseJsonSafe(row.scope_json, {}),
    requestDigest: row.request_digest,
    state: row.state,
    deliveryState: row.delivery_state,
    wireCrossed: row.wire_crossed === 1,
    safeToRetry: row.safe_to_retry === 1,
    approvalId: row.approval_id || '',
    approvedBy: row.approved_by || '',
    externalId: row.external_id || '',
    receipt: parseJsonSafe(row.receipt_json, null),
    compensation: parseJsonSafe(row.compensation_json, null),
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    attempts: row.attempts || 0,
    startedAt: row.started_at || '',
    completedAt: row.completed_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function appendLedgerEvent(db, idempotencyKey, eventType, state, details, timestamp) {
  db.prepare(
    'INSERT INTO connector_action_events(idempotency_key, event_type, state, details_json, created_at) VALUES(?,?,?,?,?)',
  ).run(idempotencyKey, eventType, state, JSON.stringify(details || {}), timestamp);
}

function extractAuthoritativeExternalId(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string' || typeof result === 'number') return String(result).trim();
  if (!isPlainObject(result)) return '';
  const candidate = result.externalId
    ?? result.messageId
    ?? result.draftId
    ?? result.id
    ?? result.number
    ?? result.sha
    ?? result.permission?.id
    ?? result.file?.id
    ?? result.event?.id;
  return candidate !== undefined && candidate !== null ? String(candidate).trim() : '';
}

async function runWithTimeout(task, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Connector action timed out after ${timeoutMs}ms`));
          reject(createDispatcherError(`Connector action timed out after ${timeoutMs}ms.`, {
            code: 'CONNECTOR_TIMEOUT',
            statusCode: 504,
          }));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (timedOut && err?.code !== 'CONNECTOR_TIMEOUT') {
      throw createDispatcherError(`Connector action timed out after ${timeoutMs}ms.`, {
        code: 'CONNECTOR_TIMEOUT',
        statusCode: 504,
      });
    }
    throw err;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function resolveDrivePolicyScope(params = {}, context = {}) {
  const policyDrive = context.policy?.connectorScopes?.drive || context.policy?.allowedScopes?.drive || null;
  const policyFolders = Array.isArray(policyDrive?.allowedFolderIds)
    ? policyDrive.allowedFolderIds.map(trimString).filter(Boolean)
    : null;
  const explicitFolders = Array.isArray(params.allowedFolderIds)
    ? params.allowedFolderIds.map(trimString).filter(Boolean)
    : (Array.isArray(context.allowedFolderIds) ? context.allowedFolderIds.map(trimString).filter(Boolean) : null);

  let effectiveFolders = explicitFolders ?? policyFolders;
  if (explicitFolders && policyFolders) {
    // Preserve explicit folders so policy scope gate rejects out-of-policy requests deterministically.
    effectiveFolders = explicitFolders;
  }

  return {
    allowedFolderIds: effectiveFolders,
    allowedShareEmails: params.allowedShareEmails ?? context.allowedShareEmails ?? policyDrive?.allowedShareEmails,
    allowedShareDomains: params.allowedShareDomains ?? context.allowedShareDomains ?? policyDrive?.allowedShareDomains,
  };
}

function resolveActionEnvelope(actionOrCapability, paramsOrContext = {}, maybeContext = undefined) {
  if (typeof actionOrCapability === 'string') {
    const params = isPlainObject(paramsOrContext) ? paramsOrContext : {};
    const context = isPlainObject(maybeContext) ? maybeContext : {};
    const driveScope = actionOrCapability.startsWith('drive.') ? resolveDrivePolicyScope(params, context) : {};
    return {
      action: createConnectorAction(actionOrCapability, params, {
        idempotencyKey: context.idempotencyKey || params.idempotencyKey,
        timeoutMs: context.timeoutMs,
        confirmationPolicy: context.confirmationPolicy,
        fetchImpl: context.fetchImpl,
        token: context.token,
        bindingId: context.bindingId,
        credentialsPath: context.credentialsPath,
        gmailClient: context.gmailClient,
        calendarClient: context.calendarClient,
        driveClient: context.driveClient,
        ...driveScope,
      }),
      context,
    };
  }
  if (!isPlainObject(actionOrCapability)) {
    throw createDispatcherError('Action descriptor or capability name is required.', {
      code: 'CONNECTOR_CONTRACT_INVALID',
      statusCode: 400,
    });
  }
  const context = isPlainObject(paramsOrContext) ? paramsOrContext : {};
  if (isPlainObject(actionOrCapability.contract)) {
    return { action: actionOrCapability, context };
  }
  if (actionOrCapability.capability && !actionOrCapability.execute) {
    const capParams = actionOrCapability.params || actionOrCapability.payload || {};
    const driveScope = String(actionOrCapability.capability).startsWith('drive.') ? resolveDrivePolicyScope(capParams, context) : {};
    const created = createConnectorAction(
      actionOrCapability.capability,
      capParams,
      {
        idempotencyKey: actionOrCapability.idempotencyKey || context.idempotencyKey,
        timeoutMs: actionOrCapability.timeoutMs ?? context.timeoutMs,
        confirmationPolicy: actionOrCapability.confirmationPolicy ?? context.confirmationPolicy,
        fetchImpl: context.fetchImpl,
        token: context.token,
        bindingId: context.bindingId,
        credentialsPath: context.credentialsPath,
        gmailClient: context.gmailClient,
        calendarClient: context.calendarClient,
        driveClient: context.driveClient,
        ...driveScope,
      },
    );
    return { action: created, context };
  }
  const { execute, precheck, payload, ...contractFields } = actionOrCapability;
  return {
    action: {
      contract: contractFields,
      payload: payload ?? null,
      precheck,
      execute,
    },
    context,
  };
}

export function createConnectorActionDispatcher({
  ledgerPath = join(CONFIG_DIR, 'connector-action-ledger.sqlite'),
  defaultPolicy = null,
  now = null,
} = {}) {
  const queue = createKeyedTaskQueue();
  let dbInstance = null;

  function getDb() {
    if (!dbInstance) {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      dbInstance = new DatabaseSync(ledgerPath, { timeout: 10_000 });
      ensureLedgerSchema(dbInstance);
    }
    return dbInstance;
  }

  function withDbTransaction(fn) {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function upsertLedgerRow(db, fields) {
    const ts = nowIso(now);
    const existing = db.prepare('SELECT idempotency_key, attempts, created_at FROM connector_action_ledger WHERE idempotency_key=?')
      .get(fields.idempotencyKey);
    const createdAt = existing?.created_at || ts;
    const attempts = fields.incrementAttempt ? (existing?.attempts || 0) + 1 : (existing?.attempts || 0);
    db.prepare(`
      INSERT INTO connector_action_ledger (
        idempotency_key, capability, connector_id, risk_level, confirmation_policy,
        scope_json, request_digest, state, delivery_state, wire_crossed, safe_to_retry,
        approval_id, approved_by, approval_json, external_id, receipt_json,
        compensation_json, error_code, error_message, attempts, started_at, completed_at,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        state = excluded.state,
        delivery_state = excluded.delivery_state,
        wire_crossed = ${fields.allowResetPreWire === true ? 'excluded.wire_crossed' : 'MAX(connector_action_ledger.wire_crossed, excluded.wire_crossed)'},
        safe_to_retry = excluded.safe_to_retry,
        approval_id = COALESCE(excluded.approval_id, connector_action_ledger.approval_id),
        approved_by = COALESCE(excluded.approved_by, connector_action_ledger.approved_by),
        approval_json = COALESCE(excluded.approval_json, connector_action_ledger.approval_json),
        external_id = COALESCE(excluded.external_id, connector_action_ledger.external_id),
        receipt_json = COALESCE(excluded.receipt_json, connector_action_ledger.receipt_json),
        compensation_json = excluded.compensation_json,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        attempts = excluded.attempts,
        started_at = COALESCE(excluded.started_at, connector_action_ledger.started_at),
        completed_at = COALESCE(excluded.completed_at, connector_action_ledger.completed_at),
        updated_at = excluded.updated_at
    `).run(
      fields.idempotencyKey,
      fields.capability,
      fields.connectorId,
      fields.riskLevel,
      fields.confirmationPolicy,
      JSON.stringify(fields.scope || {}),
      fields.requestDigest,
      fields.state,
      fields.deliveryState,
      fields.wireCrossed ? 1 : 0,
      fields.safeToRetry ? 1 : 0,
      fields.approvalId || null,
      fields.approvedBy || null,
      fields.approvalJson ? JSON.stringify(fields.approvalJson) : null,
      fields.externalId || null,
      fields.receipt !== undefined && fields.receipt !== null ? JSON.stringify(fields.receipt) : null,
      JSON.stringify(fields.compensation || {}),
      fields.errorCode || null,
      fields.errorMessage || null,
      attempts,
      fields.startedAt || null,
      fields.completedAt || null,
      createdAt,
      ts,
    );
  }

  async function dispatch(actionOrCapability, paramsOrContext = {}, maybeContext = undefined) {
    const { action, context } = resolveActionEnvelope(actionOrCapability, paramsOrContext, maybeContext);
    const contract = validateConnectorActionContract(action.contract);
    if (typeof action.execute !== 'function') {
      throw createDispatcherError(`Action "${contract.capability}" must provide an execute() handler.`, {
        code: 'CONNECTOR_CONTRACT_INVALID',
        statusCode: 400,
      });
    }
    const effectivePolicy = context.policy !== undefined ? context.policy : defaultPolicy;
    const payload = action.payload ?? null;
    const requestDigest = canonicalDigest({
      capability: contract.capability,
      scope: contract.scope,
      riskLevel: contract.riskLevel,
      confirmationPolicy: contract.confirmationPolicy,
      payload,
    });

    return await queue(contract.idempotencyKey, async () => {
      // 1. Check durable idempotency ledger before any policy/wire side effect.
      const existingCheck = withDbTransaction((db) => {
        const row = db.prepare('SELECT * FROM connector_action_ledger WHERE idempotency_key=?')
          .get(contract.idempotencyKey);
        if (!row) {
          const approvalId = trimString(context.approval?.approvalId);
          if (approvalId) {
            const reused = db.prepare('SELECT idempotency_key FROM connector_action_ledger WHERE approval_id=? AND idempotency_key<>?')
              .get(approvalId, contract.idempotencyKey);
            if (reused) {
              return { kind: 'approval_replayed', reusedKey: reused.idempotency_key };
            }
          }
          return { kind: 'new' };
        }
        if (row.request_digest !== requestDigest) {
          return { kind: 'idempotency_conflict', row: mapLedgerRow(row) };
        }
        if (row.state === 'delivered') {
          return { kind: 'already_delivered', row: mapLedgerRow(row) };
        }
        if (row.state === 'compensated') {
          return { kind: 'already_compensated', row: mapLedgerRow(row) };
        }
        if (row.wire_crossed === 1 || row.state === 'sending' || row.state === 'unknown_outcome') {
          if (row.state === 'sending') {
            db.prepare("UPDATE connector_action_ledger SET state='unknown_outcome', delivery_state='unknown_outcome', safe_to_retry=0, error_code='CONNECTOR_INFLIGHT_INTERRUPTED', error_message=?, updated_at=? WHERE idempotency_key=?")
              .run('Prior dispatch crossed the external boundary without a confirmed receipt.', nowIso(now), contract.idempotencyKey);
            appendLedgerEvent(db, contract.idempotencyKey, 'replay_blocked_unknown', 'unknown_outcome', {}, nowIso(now));
          }
          const latest = db.prepare('SELECT * FROM connector_action_ledger WHERE idempotency_key=?').get(contract.idempotencyKey);
          return { kind: 'unknown_outcome_blocked', row: mapLedgerRow(latest) };
        }
        const approvalId = trimString(context.approval?.approvalId);
        if (approvalId) {
          const reused = db.prepare('SELECT idempotency_key FROM connector_action_ledger WHERE approval_id=? AND idempotency_key<>?')
            .get(approvalId, contract.idempotencyKey);
          if (reused) {
            return { kind: 'approval_replayed', reusedKey: reused.idempotency_key };
          }
        }
        return { kind: 'retry_prewire', row: mapLedgerRow(row) };
      });

      if (existingCheck.kind === 'idempotency_conflict') {
        return {
          ok: false,
          state: 'conflict',
          deliveryState: 'delivery_failed',
          code: 'CONNECTOR_IDEMPOTENCY_CONFLICT',
          error: `Idempotency key "${contract.idempotencyKey}" was already used with a different action or payload.`,
          idempotencyKey: contract.idempotencyKey,
          capability: contract.capability,
          wireCrossed: existingCheck.row.wireCrossed,
          retryable: false,
          safeToRetry: false,
        };
      }

      if (existingCheck.kind === 'approval_replayed') {
        return {
          ok: false,
          state: 'denied',
          deliveryState: 'drafted',
          code: 'CONNECTOR_APPROVAL_REPLAYED',
          error: `Approval "${context.approval.approvalId}" was already consumed by another action.`,
          idempotencyKey: contract.idempotencyKey,
          capability: contract.capability,
          wireCrossed: false,
          retryable: false,
          safeToRetry: false,
        };
      }

      if (existingCheck.kind === 'already_delivered') {
        const prev = existingCheck.row;
        return {
          ok: true,
          state: 'delivered',
          deliveryState: 'delivered',
          deduplicated: true,
          replayed: true,
          idempotencyKey: prev.idempotencyKey,
          capability: prev.capability,
          connectorId: prev.connectorId,
          riskLevel: prev.riskLevel,
          externalId: prev.externalId,
          receipt: prev.receipt,
          compensation: prev.compensation,
          wireCrossed: prev.wireCrossed,
        };
      }

      if (existingCheck.kind === 'already_compensated') {
        const prev = existingCheck.row;
        return {
          ok: true,
          state: 'compensated',
          deliveryState: 'cancelled',
          deduplicated: true,
          replayed: true,
          idempotencyKey: prev.idempotencyKey,
          capability: prev.capability,
          connectorId: prev.connectorId,
          externalId: prev.externalId,
          receipt: prev.receipt,
          wireCrossed: prev.wireCrossed,
        };
      }

      if (existingCheck.kind === 'unknown_outcome_blocked') {
        const prev = existingCheck.row;
        return {
          ok: false,
          state: 'unknown_outcome',
          deliveryState: 'unknown_outcome',
          blockedReplay: true,
          requiresVerification: true,
          idempotencyKey: prev.idempotencyKey,
          capability: prev.capability,
          connectorId: prev.connectorId,
          riskLevel: prev.riskLevel,
          code: prev.errorCode || 'CONNECTOR_UNKNOWN_OUTCOME',
          error: prev.errorMessage || 'External outcome is unconfirmed; reconcile receipt instead of replaying.',
          wireCrossed: true,
          retryable: false,
          safeToRetry: false,
          compensation: prev.compensation,
        };
      }

      // 2. Deterministic risk, scope, policy & human approval gate.
      const gate = evaluateConnectorActionPolicy({
        contract,
        payload,
        policy: effectivePolicy,
        approval: context.approval,
        actor: context.actor,
        nowMs: nowMs(now),
      });

      if (!gate.allowed) {
        withDbTransaction((db) => {
          upsertLedgerRow(db, {
            idempotencyKey: contract.idempotencyKey,
            capability: contract.capability,
            connectorId: contract.connectorId,
            riskLevel: contract.riskLevel,
            confirmationPolicy: contract.confirmationPolicy,
            scope: contract.scope,
            requestDigest,
            state: gate.state,
            deliveryState: 'drafted',
            wireCrossed: false,
            safeToRetry: gate.state === 'pending_approval',
            compensation: contract.compensation,
            errorCode: gate.code,
            errorMessage: gate.reason,
          });
          appendLedgerEvent(db, contract.idempotencyKey, gate.state, gate.state, { code: gate.code, reason: gate.reason }, nowIso(now));
        });
        return {
          ok: false,
          state: gate.state,
          deliveryState: 'drafted',
          requiresApproval: gate.needsApproval === true,
          approvalChallenge: gate.approvalChallenge || null,
          code: gate.code,
          error: gate.reason,
          idempotencyKey: contract.idempotencyKey,
          capability: contract.capability,
          connectorId: contract.connectorId,
          riskLevel: contract.riskLevel,
          wireCrossed: false,
          retryable: false,
          safeToRetry: gate.state === 'pending_approval',
        };
      }

      // 3. Pre-wire precondition / conflict check (ETag, sequence, head SHA, scope).
      if (typeof action.precheck === 'function') {
        try {
          await runWithTimeout((signal) => action.precheck({ ...context, signal, contract, payload }), contract.timeoutMs);
        } catch (err) {
          const isConflict = err?.code === 'CONNECTOR_CONFLICT' || err?.statusCode === 409;
          const isScope = err?.code === 'CONNECTOR_SCOPE_VIOLATION' || err?.code === 'CONNECTOR_PUBLIC_SHARE_FORBIDDEN' || err?.statusCode === 403;
          const preState = isConflict ? 'conflict' : (isScope ? 'denied' : 'failed_pre_dispatch');
          const safeToRetry = !isConflict && !isScope;
          withDbTransaction((db) => {
            upsertLedgerRow(db, {
              idempotencyKey: contract.idempotencyKey,
              capability: contract.capability,
              connectorId: contract.connectorId,
              riskLevel: contract.riskLevel,
              confirmationPolicy: contract.confirmationPolicy,
              scope: contract.scope,
              requestDigest,
              state: preState,
              deliveryState: 'drafted',
              wireCrossed: false,
              safeToRetry,
              approvalId: gate.approvalId,
              approvedBy: gate.approvedBy,
              compensation: contract.compensation,
              errorCode: err?.code || 'CONNECTOR_PRECHECK_FAILED',
              errorMessage: err?.message || 'Pre-dispatch check failed.',
            });
            appendLedgerEvent(db, contract.idempotencyKey, 'precheck_failed', preState, { code: err?.code, message: err?.message }, nowIso(now));
          });
          return {
            ok: false,
            state: preState,
            deliveryState: 'drafted',
            code: err?.code || 'CONNECTOR_PRECHECK_FAILED',
            error: err?.message || 'Pre-dispatch check failed.',
            idempotencyKey: contract.idempotencyKey,
            capability: contract.capability,
            connectorId: contract.connectorId,
            riskLevel: contract.riskLevel,
            wireCrossed: false,
            retryable: safeToRetry,
            safeToRetry,
          };
        }
      }

      // 4. Persist wire boundary BEFORE invoking external side-effecting call.
      const isReadOnly = contract.riskLevel === 'read';
      const startedAt = nowIso(now);
      withDbTransaction((db) => {
        upsertLedgerRow(db, {
          idempotencyKey: contract.idempotencyKey,
          capability: contract.capability,
          connectorId: contract.connectorId,
          riskLevel: contract.riskLevel,
          confirmationPolicy: contract.confirmationPolicy,
          scope: contract.scope,
          requestDigest,
          state: 'sending',
          deliveryState: 'sending',
          wireCrossed: !isReadOnly,
          safeToRetry: isReadOnly,
          approvalId: gate.approvalId,
          approvedBy: gate.approvedBy,
          approvalJson: gate.requiresApproval ? { approvedBy: gate.approvedBy, approvalId: gate.approvalId } : null,
          compensation: contract.compensation,
          incrementAttempt: true,
          startedAt,
        });
        appendLedgerEvent(db, contract.idempotencyKey, 'wire_dispatch_started', 'sending', { isReadOnly }, startedAt);
      });

      // 5. Execute within bounded timeout + verify receipt.
      let result;
      let beforeWireCalled = false;
      try {
        result = await runWithTimeout(
          (signal) => action.execute({
            ...context,
            signal,
            contract,
            payload,
            onBeforeWire: async () => { beforeWireCalled = true; },
          }),
          contract.timeoutMs,
        );
      } catch (err) {
        if (isReadOnly) {
          const isDenied = err?.code === 'CONNECTOR_SCOPE_VIOLATION' || err?.statusCode === 403;
          const readFailState = isDenied ? 'denied' : 'failed_pre_dispatch';
          const readDeliveryState = isDenied ? 'drafted' : 'delivery_failed';
          withDbTransaction((db) => {
            upsertLedgerRow(db, {
              idempotencyKey: contract.idempotencyKey,
              capability: contract.capability,
              connectorId: contract.connectorId,
              riskLevel: contract.riskLevel,
              confirmationPolicy: contract.confirmationPolicy,
              scope: contract.scope,
              requestDigest,
              state: readFailState,
              deliveryState: readDeliveryState,
              wireCrossed: false,
              safeToRetry: !isDenied,
              compensation: contract.compensation,
              errorCode: err?.code || 'CONNECTOR_READ_FAILED',
              errorMessage: err?.message || 'Read action failed.',
            });
            appendLedgerEvent(db, contract.idempotencyKey, isDenied ? 'scope_denied' : 'read_failed', readFailState, { code: err?.code, message: err?.message }, nowIso(now));
          });
          return {
            ok: false,
            state: readFailState,
            deliveryState: readDeliveryState,
            code: err?.code || 'CONNECTOR_READ_FAILED',
            error: err?.message || 'Read action failed.',
            idempotencyKey: contract.idempotencyKey,
            capability: contract.capability,
            connectorId: contract.connectorId,
            riskLevel: contract.riskLevel,
            wireCrossed: false,
            retryable: !isDenied,
            safeToRetry: !isDenied,
          };
        }

        // Write/broadcast crossed the wire and failed or timed out without confirmed receipt -> unknown_outcome.
        const errCode = err?.code || 'CONNECTOR_UNKNOWN_OUTCOME';
        const errMessage = err?.message || 'External write outcome could not be confirmed.';
        withDbTransaction((db) => {
          upsertLedgerRow(db, {
            idempotencyKey: contract.idempotencyKey,
            capability: contract.capability,
            connectorId: contract.connectorId,
            riskLevel: contract.riskLevel,
            confirmationPolicy: contract.confirmationPolicy,
            scope: contract.scope,
            requestDigest,
            state: 'unknown_outcome',
            deliveryState: 'unknown_outcome',
            wireCrossed: true,
            safeToRetry: false,
            approvalId: gate.approvalId,
            approvedBy: gate.approvedBy,
            compensation: contract.compensation,
            errorCode: errCode,
            errorMessage: errMessage,
          });
          appendLedgerEvent(db, contract.idempotencyKey, 'unknown_outcome', 'unknown_outcome', { code: errCode, message: errMessage }, nowIso(now));
        });
        return {
          ok: false,
          state: 'unknown_outcome',
          deliveryState: 'unknown_outcome',
          requiresVerification: true,
          code: errCode,
          error: errMessage,
          idempotencyKey: contract.idempotencyKey,
          capability: contract.capability,
          connectorId: contract.connectorId,
          riskLevel: contract.riskLevel,
          wireCrossed: true,
          retryable: false,
          safeToRetry: false,
          compensation: contract.compensation,
        };
      }

      // Check if legacy-style result reported an inline binding/drafted error
      if (isPlainObject(result) && result.error && result.deliveryState === undefined) {
        const inlineErrMsg = typeof result.error === 'string' ? result.error : result.error.message || 'Connector action failed';
        const preState = isReadOnly ? 'failed_pre_dispatch' : 'unknown_outcome';
        withDbTransaction((db) => {
          upsertLedgerRow(db, {
            idempotencyKey: contract.idempotencyKey,
            capability: contract.capability,
            connectorId: contract.connectorId,
            riskLevel: contract.riskLevel,
            confirmationPolicy: contract.confirmationPolicy,
            scope: contract.scope,
            requestDigest,
            state: preState,
            deliveryState: isReadOnly ? 'delivery_failed' : 'unknown_outcome',
            wireCrossed: !isReadOnly,
            safeToRetry: isReadOnly,
            compensation: contract.compensation,
            errorCode: 'CONNECTOR_ERROR',
            errorMessage: inlineErrMsg,
          });
        });
        return {
          ok: false,
          state: preState,
          deliveryState: isReadOnly ? 'delivery_failed' : 'unknown_outcome',
          code: 'CONNECTOR_ERROR',
          error: inlineErrMsg,
          idempotencyKey: contract.idempotencyKey,
          capability: contract.capability,
          connectorId: contract.connectorId,
          riskLevel: contract.riskLevel,
          wireCrossed: !isReadOnly,
          retryable: isReadOnly,
          safeToRetry: isReadOnly,
        };
      }

      if (isPlainObject(result) && result.capabilityState && result.capabilityState !== 'ready') {
        const preWireSafe = !beforeWireCalled;
        withDbTransaction((db) => {
          upsertLedgerRow(db, {
            idempotencyKey: contract.idempotencyKey,
            capability: contract.capability,
            connectorId: contract.connectorId,
            riskLevel: contract.riskLevel,
            confirmationPolicy: contract.confirmationPolicy,
            scope: contract.scope,
            requestDigest,
            state: preWireSafe ? 'failed_pre_dispatch' : 'unknown_outcome',
            deliveryState: preWireSafe ? 'drafted' : 'unknown_outcome',
            wireCrossed: !preWireSafe,
            allowResetPreWire: preWireSafe,
            safeToRetry: preWireSafe,
            compensation: contract.compensation,
            errorCode: result.capabilityState.toUpperCase(),
            errorMessage: result.message || `Connector capability state is ${result.capabilityState}.`,
          });
          appendLedgerEvent(
            db,
            contract.idempotencyKey,
            preWireSafe ? 'capability_prewire_blocked' : 'capability_postwire_unknown',
            preWireSafe ? 'failed_pre_dispatch' : 'unknown_outcome',
            { capabilityState: result.capabilityState },
            nowIso(now),
          );
        });
        return {
          ok: false,
          state: preWireSafe ? 'failed_pre_dispatch' : 'unknown_outcome',
          deliveryState: preWireSafe ? 'drafted' : 'unknown_outcome',
          code: result.capabilityState.toUpperCase(),
          error: result.message || `Connector capability state is ${result.capabilityState}.`,
          idempotencyKey: contract.idempotencyKey,
          capability: contract.capability,
          connectorId: contract.connectorId,
          riskLevel: contract.riskLevel,
          wireCrossed: !preWireSafe,
          retryable: preWireSafe,
          safeToRetry: preWireSafe,
          result,
        };
      }

      // 6. Receipt verification for writes/broadcasts
      let externalId = extractAuthoritativeExternalId(result);
      let receiptPayload = sanitizeLedgerReceipt(result);
      if (!isReadOnly) {
        let receiptMissing = !externalId;
        if (!receiptMissing && context.verifyReceiptAfterExecute === true && typeof contract.receiptVerifier?.verify === 'function') {
          const verified = await contract.receiptVerifier.verify({
            ...context,
            contract,
            payload,
            result,
            externalId,
          }).catch(() => null);
          if (!verified || verified.verified !== true) {
            receiptMissing = true;
          } else {
            externalId = trimString(verified.externalId) || externalId;
            receiptPayload = sanitizeLedgerReceipt(verified.receipt || result);
          }
        }
        if (receiptMissing) {
          withDbTransaction((db) => {
            upsertLedgerRow(db, {
              idempotencyKey: contract.idempotencyKey,
              capability: contract.capability,
              connectorId: contract.connectorId,
              riskLevel: contract.riskLevel,
              confirmationPolicy: contract.confirmationPolicy,
              scope: contract.scope,
              requestDigest,
              state: 'unknown_outcome',
              deliveryState: 'unknown_outcome',
              wireCrossed: true,
              safeToRetry: false,
              approvalId: gate.approvalId,
              approvedBy: gate.approvedBy,
              compensation: contract.compensation,
              errorCode: 'CONNECTOR_RECEIPT_MISSING',
              errorMessage: 'External write returned without an authoritative receipt.',
            });
            appendLedgerEvent(db, contract.idempotencyKey, 'receipt_missing', 'unknown_outcome', {}, nowIso(now));
          });
          return {
            ok: false,
            state: 'unknown_outcome',
            deliveryState: 'unknown_outcome',
            requiresVerification: true,
            code: 'CONNECTOR_RECEIPT_MISSING',
            error: 'External write returned without an authoritative receipt.',
            idempotencyKey: contract.idempotencyKey,
            capability: contract.capability,
            connectorId: contract.connectorId,
            riskLevel: contract.riskLevel,
            wireCrossed: true,
            retryable: false,
            safeToRetry: false,
            compensation: contract.compensation,
          };
        }
      }

      const completedAt = nowIso(now);
      withDbTransaction((db) => {
        upsertLedgerRow(db, {
          idempotencyKey: contract.idempotencyKey,
          capability: contract.capability,
          connectorId: contract.connectorId,
          riskLevel: contract.riskLevel,
          confirmationPolicy: contract.confirmationPolicy,
          scope: contract.scope,
          requestDigest,
          state: 'delivered',
          deliveryState: 'delivered',
          wireCrossed: !isReadOnly,
          safeToRetry: false,
          approvalId: gate.approvalId,
          approvedBy: gate.approvedBy,
          externalId,
          receipt: receiptPayload,
          compensation: contract.compensation,
          completedAt,
        });
        appendLedgerEvent(db, contract.idempotencyKey, 'delivered', 'delivered', { externalId }, completedAt);
      });

      return {
        ok: true,
        state: 'delivered',
        deliveryState: 'delivered',
        deduplicated: false,
        replayed: false,
        idempotencyKey: contract.idempotencyKey,
        capability: contract.capability,
        connectorId: contract.connectorId,
        riskLevel: contract.riskLevel,
        externalId,
        receipt: receiptPayload,
        result,
        compensation: contract.compensation,
        wireCrossed: !isReadOnly,
      };
    });
  }

  async function reconcile(idempotencyKeyOrAction, context = {}) {
    const idempotencyKey = typeof idempotencyKeyOrAction === 'string'
      ? trimString(idempotencyKeyOrAction)
      : trimString(idempotencyKeyOrAction?.contract?.idempotencyKey || idempotencyKeyOrAction?.idempotencyKey);
    if (!idempotencyKey) {
      throw createDispatcherError('idempotencyKey is required for reconciliation.', {
        code: 'CONNECTOR_INVALID_INPUT',
        statusCode: 400,
      });
    }

    return await queue(idempotencyKey, async () => {
      const entry = withDbTransaction((db) => {
        const row = db.prepare('SELECT * FROM connector_action_ledger WHERE idempotency_key=?').get(idempotencyKey);
        return mapLedgerRow(row);
      });
      if (!entry) {
        return { ok: false, state: 'not_found', code: 'CONNECTOR_ACTION_NOT_FOUND', idempotencyKey };
      }
      if (entry.state === 'delivered') {
        return {
          ok: true,
          state: 'delivered',
          deliveryState: 'delivered',
          reconciled: false,
          alreadyDelivered: true,
          idempotencyKey,
          externalId: entry.externalId,
          receipt: entry.receipt,
        };
      }
      if (!['sending', 'unknown_outcome'].includes(entry.state)) {
        return {
          ok: false,
          state: entry.state,
          deliveryState: entry.deliveryState,
          reconciled: false,
          idempotencyKey,
        };
      }

      const verifierFn = typeof context.receiptVerifier === 'function'
        ? context.receiptVerifier
        : (typeof context.receiptVerifier?.verify === 'function'
            ? context.receiptVerifier.verify
            : (typeof idempotencyKeyOrAction?.contract?.receiptVerifier?.verify === 'function'
                ? idempotencyKeyOrAction.contract.receiptVerifier.verify
                : null));

      if (!verifierFn) {
        return {
          ok: false,
          state: 'unknown_outcome',
          deliveryState: 'unknown_outcome',
          reconciled: false,
          idempotencyKey,
          reason: 'No callable receiptVerifier provided; external outcome remains unknown_outcome.',
        };
      }

      const verified = await verifierFn({ ...context, idempotencyKey, entry }).catch(() => null);
      if (verified && verified.verified === true) {
        const externalId = trimString(verified.externalId) || entry.externalId || '';
        const receipt = sanitizeLedgerReceipt(verified.receipt || verified);
        const completedAt = nowIso(now);
        withDbTransaction((db) => {
          db.prepare(`
            UPDATE connector_action_ledger
            SET state='delivered', delivery_state='delivered', external_id=?, receipt_json=?,
                error_code=NULL, error_message=NULL, completed_at=?, updated_at=?
            WHERE idempotency_key=?
          `).run(externalId || null, JSON.stringify(receipt), completedAt, completedAt, idempotencyKey);
          appendLedgerEvent(db, idempotencyKey, 'receipt_reconciled', 'delivered', { externalId }, completedAt);
        });
        return {
          ok: true,
          state: 'delivered',
          deliveryState: 'delivered',
          reconciled: true,
          idempotencyKey,
          externalId,
          receipt,
        };
      }

      // Absence or error during verification MUST keep unknown_outcome (never replay or pretend absent).
      const ts = nowIso(now);
      withDbTransaction((db) => {
        db.prepare("UPDATE connector_action_ledger SET state='unknown_outcome', delivery_state='unknown_outcome', updated_at=? WHERE idempotency_key=?")
          .run(ts, idempotencyKey);
        appendLedgerEvent(db, idempotencyKey, 'receipt_inconclusive', 'unknown_outcome', {}, ts);
      });
      return {
        ok: false,
        state: 'unknown_outcome',
        deliveryState: 'unknown_outcome',
        reconciled: false,
        idempotencyKey,
        reason: 'Receipt query did not confirm external execution; preserving unknown_outcome.',
      };
    });
  }

  async function compensate(idempotencyKey, context = {}) {
    const key = trimString(idempotencyKey);
    if (!key) {
      throw createDispatcherError('idempotencyKey is required for compensation.', {
        code: 'CONNECTOR_INVALID_INPUT',
        statusCode: 400,
      });
    }
    const entry = withDbTransaction((db) => {
      const row = db.prepare('SELECT * FROM connector_action_ledger WHERE idempotency_key=?').get(key);
      return mapLedgerRow(row);
    });
    if (!entry) {
      return { ok: false, state: 'not_found', code: 'CONNECTOR_ACTION_NOT_FOUND', idempotencyKey: key };
    }
    if (entry.state !== 'delivered') {
      return {
        ok: false,
        state: entry.state,
        code: 'CONNECTOR_COMPENSATION_NOT_DELIVERED',
        error: `Only delivered actions can be compensated (current state: ${entry.state}).`,
      };
    }
    if (entry.compensation?.supported !== true) {
      return {
        ok: false,
        state: entry.state,
        code: 'CONNECTOR_COMPENSATION_UNSUPPORTED',
        error: entry.compensation?.description || 'Action compensation is not supported.',
      };
    }
    if (typeof context.executeCompensation !== 'function' && !context.compensatingAction) {
      return {
        ok: false,
        state: entry.state,
        code: 'CONNECTOR_COMPENSATION_HANDLER_REQUIRED',
        error: 'Compensation requires compensatingAction or executeCompensation.',
      };
    }
    const compKey = trimString(context.compensationIdempotencyKey) || `compensate:${key}`;
    const compAction = context.compensatingAction || {
      contract: {
        capability: entry.compensation.compensatingCapability || `${entry.capability}.compensate`,
        scope: entry.scope,
        riskLevel: 'reversible_write',
        idempotencyKey: compKey,
        confirmationPolicy: 'require_approval',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        receiptVerifier: {
          kind: 'custom_verifier',
          supported: true,
          verify: async () => ({ verified: true, externalId: entry.externalId }),
        },
        compensation: {
          supported: false,
          mode: 'manual_only',
          description: 'Compensation action cannot be automatically nested.',
        },
      },
      payload: { originalIdempotencyKey: key, originalExternalId: entry.externalId },
      execute: (ctx) => context.executeCompensation({ ...ctx, entry }),
    };

    const compResult = await dispatch(compAction, {
      ...context,
      policy: context.policy !== undefined ? context.policy : defaultPolicy,
    });
    if (compResult.ok) {
      const ts = nowIso(now);
      withDbTransaction((db) => {
        db.prepare("UPDATE connector_action_ledger SET state='compensated', updated_at=? WHERE idempotency_key=?")
          .run(ts, key);
        appendLedgerEvent(db, key, 'compensated', 'compensated', { compensationIdempotencyKey: compKey }, ts);
      });
    }
    return {
      ...compResult,
      originalIdempotencyKey: key,
      compensationIdempotencyKey: compKey,
    };
  }

  async function recordOutcomeReview({ idempotencyKey, observation, evidence }, actor) {
    if (actor?.kind !== 'user' || actor?.role !== 'owner' || !trimString(actor.principalId)) {
      throw createDispatcherError('Owner access required', { code: 'CONNECTOR_FORBIDDEN', statusCode: 403 });
    }
    const key = trimString(idempotencyKey);
    if (!key || !['observed_present', 'observed_absent', 'inconclusive'].includes(observation)
        || !trimString(evidence) || evidence.length > 2000) {
      throw createDispatcherError('Invalid connector outcome review', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
    }
    return withDbTransaction((db) => {
      const row = db.prepare('SELECT * FROM connector_action_ledger WHERE idempotency_key=?').get(key);
      if (!row) throw createDispatcherError('Action not found', { code: 'CONNECTOR_ACTION_NOT_FOUND', statusCode: 404 });
      if (row.state !== 'unknown_outcome') {
        throw createDispatcherError('Action outcome is not unknown_outcome', { code: 'CONNECTOR_CONFLICT', statusCode: 409 });
      }
      const review = {
        observation,
        evidence: evidence.trim(),
        actorId: actor.principalId,
        reviewedAt: nowIso(now),
        source: 'human',
      };
      appendLedgerEvent(db, key, 'manual_review', 'unknown_outcome', review, review.reviewedAt);
      return { idempotencyKey: key, state: 'unknown_outcome', review };
    });
  }

  function getEntry(idempotencyKey) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM connector_action_ledger WHERE idempotency_key=?').get(trimString(idempotencyKey));
    return mapLedgerRow(row);
  }

  function listEntries({ state = '', connectorId = '', limit = 100 } = {}) {
    const db = getDb();
    const clauses = [];
    const params = [];
    if (trimString(state)) {
      clauses.push('state = ?');
      params.push(trimString(state));
    }
    if (trimString(connectorId)) {
      clauses.push('connector_id = ?');
      params.push(trimString(connectorId).toLowerCase());
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const maxRows = Math.min(Math.max(1, Number(limit) || 100), 500);
    const rows = db.prepare(`SELECT * FROM connector_action_ledger ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, maxRows);
    return rows.map(mapLedgerRow);
  }

  function close() {
    if (dbInstance) {
      try { dbInstance.close(); } catch {}
      dbInstance = null;
    }
  }

  return {
    dispatch,
    reconcile,
    compensate,
    recordOutcomeReview,
    getEntry,
    listEntries,
    close,
  };
}

let defaultDispatcher = null;
let defaultDispatcherConfigDir = '';

function getDefaultDispatcher() {
  if (!defaultDispatcher || defaultDispatcherConfigDir !== CONFIG_DIR) {
    if (defaultDispatcher) defaultDispatcher.close();
    defaultDispatcher = createConnectorActionDispatcher({
      ledgerPath: join(CONFIG_DIR, 'connector-action-ledger.sqlite'),
    });
    defaultDispatcherConfigDir = CONFIG_DIR;
  }
  return defaultDispatcher;
}

export async function dispatchConnectorAction(actionOrCapability, paramsOrContext = {}, maybeContext = undefined) {
  return await getDefaultDispatcher().dispatch(actionOrCapability, paramsOrContext, maybeContext);
}

export async function reconcileConnectorAction(idempotencyKeyOrAction, context = {}) {
  return await getDefaultDispatcher().reconcile(idempotencyKeyOrAction, context);
}

export async function compensateConnectorAction(idempotencyKey, context = {}) {
  return await getDefaultDispatcher().compensate(idempotencyKey, context);
}

export async function recordConnectorOutcomeReview(input, actor) {
  return await getDefaultDispatcher().recordOutcomeReview(input, actor);
}

export function getConnectorActionLedgerEntry(idempotencyKey) {
  return getDefaultDispatcher().getEntry(idempotencyKey);
}

export function listConnectorActionLedger(filters = {}) {
  return getDefaultDispatcher().listEntries(filters);
}

function normalizeTargetType(target) {
  return trimString(target?.type || target?.kind).toLowerCase() || 'email';
}

function sanitizeCalendarTarget(target, index) {
  const title = trimString(target?.title || target?.summary);
  if (!title) return null;
  const id = trimString(target?.id) || `calendar_target_${index + 1}`;
  return {
    id,
    type: 'calendar',
    enabled: target?.enabled !== false,
    requestId: trimString(target?.requestId),
    bindingId: trimString(target?.bindingId),
    title,
    startTime: trimString(target?.startTime || target?.start),
    endTime: trimString(target?.endTime || target?.end),
    location: trimString(target?.location),
    description: trimString(target?.description),
    calendarId: trimString(target?.calendarId),
    timezone: trimString(target?.timezone),
    credentialsPath: trimString(target?.credentialsPath),
    reminders: target?.reminders,
    reminderMinutesBefore: target?.reminderMinutesBefore,
  };
}

export function sanitizeCompletionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target, index) => {
      const type = normalizeTargetType(target);
      if (type === 'email') return null;
      if (type === 'calendar') return sanitizeCalendarTarget(target, index);
      return null;
    })
    .filter(Boolean);
}

export function sanitizeAllCompletionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  const emailTargets = sanitizeEmailCompletionTargets(targets);
  const otherTargets = sanitizeCompletionTargets(targets);
  return [...emailTargets, ...otherTargets];
}

function groupTargetsByType(targets) {
  const groups = new Map();
  for (const target of targets) {
    const type = normalizeTargetType(target);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(target);
  }
  return groups;
}

async function dispatchCalendarTarget(target, { sessionId, runId, baseUrl } = {}) {
  const actionDigest = createHash('sha256').update(JSON.stringify({ sessionId, runId, target })).digest('hex');
  const eventId = createHash('sha256').update(JSON.stringify([sessionId, runId, target.id])).digest('hex');
  let providerInvoked = false;
  try {
    const result = target.bindingId && target.credentialsPath
      ? await createCalendarEvent({
          bindingId: target.bindingId,
          credentialsPath: target.credentialsPath,
          title: target.title,
          startTime: target.startTime,
          endTime: target.endTime,
          description: target.description,
          location: target.location,
          calendarId: target.calendarId,
          timezone: target.timezone,
          reminderMinutesBefore: target.reminderMinutesBefore,
          eventId,
          actionDigest,
          onBeforeWire: () => { providerInvoked = true; },
        })
      : await dispatchCalendarToFeed(target, { sessionId, runId, baseUrl });
    return {
      id: target.id,
      connectorId: 'calendar',
      state: result.deliveryState === 'delivered' ? 'sent' : 'failed',
      result,
    };
  } catch (error) {
    if (providerInvoked && target.bindingId && target.credentialsPath) {
      const receipt = await findCalendarEventReceipt({
        bindingId: target.bindingId,
        credentialsPath: target.credentialsPath,
        calendarId: target.calendarId,
        eventId,
        actionDigest,
      }).catch(() => null);
      if (receipt) return { id: target.id, connectorId: 'calendar', state: 'sent', result: receipt };
    }
    if (!providerInvoked) {
      return {
        id: target.id,
        connectorId: 'calendar',
        state: 'failed',
        error: error.message,
        result: createConnectorActionResult({
          actionId: target.id,
          connectorId: 'calendar',
          bindingId: target.bindingId,
          capabilityState: target.bindingId ? 'ready' : 'connector_unavailable',
          deliveryState: 'delivery_failed',
          retryable: true,
          message: `${target.bindingId && target.credentialsPath ? 'Bound calendar' : 'Calendar feed'} delivery failed: ${error.message}`,
        }),
      };
    }
    return {
      id: target.id,
      connectorId: 'calendar',
      state: 'unknown_outcome',
      error: error.message,
      result: createConnectorActionResult({
        actionId: target.id,
        connectorId: 'calendar',
        bindingId: target.bindingId,
        capabilityState: target.bindingId ? 'ready' : 'connector_unavailable',
        deliveryState: 'unknown_outcome',
        retryable: false,
        message: `Calendar delivery could not be confirmed: ${error.message}`,
      }),
    };
  }
}

export async function dispatchSessionConnectorActions(session, run, options = {}) {
  const allTargets = sanitizeAllCompletionTargets(session?.completionTargets || []);
  if (!session?.id || !run?.id || allTargets.length === 0) {
    return [];
  }

  const grouped = groupTargetsByType(allTargets);
  const results = [];

  const emailTargets = grouped.get('email') || [];
  if (emailTargets.length > 0) {
    const emailSession = {
      ...session,
      completionTargets: emailTargets,
    };
    const emailResults = await dispatchSessionEmailCompletionTargets(emailSession, run, options);
    results.push(...emailResults.map((result) => ({
      ...result,
      connectorId: 'email',
    })));
  }

  const calendarTargets = grouped.get('calendar') || [];
  const hasPersistedRun = calendarTargets.length > 0 ? Boolean(await getRun(run.id)) : false;
  for (const target of calendarTargets) {
    if (!target.enabled) continue;
    if (!hasPersistedRun) {
      const calResult = await dispatchCalendarTarget(target, {
        sessionId: session.id,
        runId: run.id,
        baseUrl: trimString(options?.baseUrl),
      });
      results.push(calResult);
      continue;
    }

    let claimed = false;
    await updateRun(run.id, (existing) => {
      const previous = existing.completionTargets?.[target.id];
      if (['sending', 'sent', 'unknown_outcome'].includes(previous?.state)
          || (previous?.state === 'failed' && previous.safeToRetry !== true)) return existing;
      claimed = true;
      return { ...existing, completionTargets: { ...(existing.completionTargets || {}),
        [target.id]: { ...previous, state: 'sending', startedAt: new Date().toISOString() } } };
    });
    if (!claimed) {
      const latest = await getRun(run.id);
      const previous = latest?.completionTargets?.[target.id];
      if (previous?.state === 'failed' && previous.safeToRetry !== true) {
        await updateRun(run.id, (existing) => {
          const current = existing.completionTargets?.[target.id];
          if (current?.state !== 'failed' || current.safeToRetry === true) return existing;
          return { ...existing, completionTargets: { ...existing.completionTargets,
            [target.id]: { ...current, state: 'unknown_outcome', lastError: 'Earlier calendar failure did not establish the external outcome.' } } };
        });
        continue;
      }
      if (['sending', 'unknown_outcome'].includes(previous?.state) && target.bindingId && target.credentialsPath) {
        const actionDigest = createHash('sha256').update(JSON.stringify({ sessionId: session.id, runId: run.id, target })).digest('hex');
        const eventId = createHash('sha256').update(JSON.stringify([session.id, run.id, target.id])).digest('hex');
        const receipt = await findCalendarEventReceipt({ bindingId: target.bindingId, credentialsPath: target.credentialsPath,
          calendarId: target.calendarId, eventId, actionDigest }).catch(() => null);
        if (receipt) {
          await updateRun(run.id, (existing) => {
            const current = existing.completionTargets?.[target.id];
            if (!['sending', 'unknown_outcome'].includes(current?.state) || current.startedAt !== previous.startedAt) return existing;
            return { ...existing, completionTargets: { ...existing.completionTargets,
              [target.id]: { ...current, state: 'sent', delivery: receipt, lastError: null } } };
          });
          results.push({ id: target.id, connectorId: 'calendar', state: 'sent', result: receipt });
          continue;
        }
      }
      if (previous?.state === 'sending' && Date.now() - Date.parse(previous.startedAt || '') > 60000) {
        await updateRun(run.id, (existing) => {
          const current = existing.completionTargets?.[target.id];
          if (current?.state !== 'sending' || current.startedAt !== previous.startedAt) return existing;
          return { ...existing, completionTargets: { ...existing.completionTargets,
            [target.id]: { ...current, state: 'unknown_outcome', lastError: 'Calendar result requires verification before retry.' } } };
        });
      }
      continue;
    }
    const calResult = await dispatchCalendarTarget(target, {
      sessionId: session.id,
      runId: run.id,
      baseUrl: trimString(options?.baseUrl),
    });
    await updateRun(run.id, (existing) => ({ ...existing, completionTargets: {
      ...existing.completionTargets, [target.id]: { ...existing.completionTargets?.[target.id],
        state: calResult.state, safeToRetry: calResult.state === 'failed', delivery: calResult.result, lastError: calResult.error || null },
    } }));
    results.push(calResult);
  }

  return results;
}
