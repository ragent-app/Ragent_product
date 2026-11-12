import { createHash } from 'node:crypto';
import path from 'node:path';

// Only currently pending command requests with an explicit, identical
// execution context can share a decision. Keep questions, capability grants,
// file changes, unknown protocol shapes and persistent grants independent.
export function approvalEquivalenceKey(approval) {
  if (approval?.state !== 'pending' || approval?.kind !== 'command'
      || !['item/commandExecution/requestApproval', 'can_use_tool'].includes(approval?.providerMethod)
      || !['danger', 'unknown'].includes(approval?.riskTier)) return '';
  const params = approval.params;
  if (!params || typeof params !== 'object' || Array.isArray(params) || approval.privileged === true) return '';
  const claude = approval.providerMethod === 'can_use_tool';
  if (claude) {
    const scope = approval.approvalGroupScope;
    if (!scope || typeof scope.turnId !== 'string' || !scope.turnId.trim()
        || typeof scope.processId !== 'string' || !scope.processId.trim()
        || !Number.isSafeInteger(scope.turnSequence) || scope.turnSequence < 1
        || typeof scope.cwd !== 'string' || !(path.win32.isAbsolute(scope.cwd) || path.posix.isAbsolute(scope.cwd))
        || params.subtype !== 'can_use_tool' || !['Bash', 'PowerShell'].includes(params.tool_name)
        || typeof params.tool_use_id !== 'string' || !params.tool_use_id.trim()
        || !params.input || typeof params.input !== 'object' || Array.isArray(params.input)
        || typeof params.input.command !== 'string' || !params.input.command.trim()
        || (params.permission_suggestions != null && (!Array.isArray(params.permission_suggestions) || params.permission_suggestions.length))
        || params.additionalPermissions || params.additional_permissions || params.networkApprovalContext || params.network_approval_context) return '';
  } else if (typeof params.threadId !== 'string' || !params.threadId.trim()
      || typeof params.turnId !== 'string' || !params.turnId.trim()
      || typeof params.itemId !== 'string' || !params.itemId.trim()
      || typeof params.cwd !== 'string' || !(path.win32.isAbsolute(params.cwd) || path.posix.isAbsolute(params.cwd))
      || !(typeof params.command === 'string' && params.command.trim())
      || params.networkApprovalContext || params.network_approval_context
      || params.additionalPermissions || params.additional_permissions
      || params.grantRoot || params.grant_root || params.proposedExecpolicyAmendment
      || params.proposed_execpolicy_amendment) return '';
  // All fields except the individual item identity are compared, including
  // future fields. Canonical keys avoid differences caused by object order.
  let size = 0;
  function canonical(value, depth = 0) {
    if (depth > 16) throw new Error('approval payload too deep');
    size += typeof value === 'string' ? value.length : 1;
    if (size > 128 * 1024) throw new Error('approval payload too large');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 4096) throw new Error('approval array too large');
      return value.map(item => canonical(item, depth + 1));
    }
    if (typeof value !== 'object') throw new Error('non-JSON approval payload');
    const keys = Object.keys(value);
    if (keys.length > 512) throw new Error('approval object too large');
    size += keys.reduce((total, key) => total + key.length, 0);
    if (size > 128 * 1024) throw new Error('approval payload too large');
    return Object.fromEntries(keys.sort().map(key => [key, canonical(value[key], depth + 1)]));
  }
  try {
    const shared = { ...params };
    if (claude) delete shared.tool_use_id; else delete shared.itemId;
    const payload = JSON.stringify(canonical({ providerMethod: approval.providerMethod, scope: claude ? approval.approvalGroupScope : null,
      params: shared, riskTier: approval.riskTier,
      riskPolicyVersion: approval.riskPolicyVersion || '', riskReasonCodes: approval.riskReasonCodes || [],
      riskTargetScope: approval.riskTargetScope || '', riskPlatform: approval.riskPlatform || '',
      riskConfidence: approval.riskConfidence || '', riskNeedsPrivilegedExecution: approval.riskNeedsPrivilegedExecution ?? null }));
    if (payload.length > 128 * 1024) return '';
    return createHash('sha256').update(payload).digest('hex');
  } catch { return ''; }
}

export function equivalentPendingApprovals(run, approvalId) {
  const pending = Array.isArray(run?.appServerPendingApprovals) ? run.appServerPendingApprovals : [];
  const queued = new Set((Array.isArray(run?.appServerApprovalResponseQueue) ? run.appServerApprovalResponseQueue : [])
    .map(entry => entry?.approvalId).filter(Boolean));
  const current = pending.find(entry => entry?.approvalId === approvalId);
  const key = approvalEquivalenceKey(current);
  if (!key || queued.has(approvalId)) return [];
  return pending.filter(entry => !queued.has(entry.approvalId) && approvalEquivalenceKey(entry) === key);
}
