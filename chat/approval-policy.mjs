// Shared policy over established facts. Unknown or incomplete facts never grant access.
export function permissionExpansion(approval) {
  return approvalCheckpoint(approval) === 'permission_expansion';
}

// Facts carry established policy inputs, never an inferred grant. Preserve the
// caller's evidence for the eventual explanation and hard-decision routing.
export function approvalFact({ tier, complete = true, reason = '', ...evidence } = {}) {
  return { tier, complete, reason, ...evidence };
}

export function approvalFactFromGate(result) {
  return approvalFact({
    tier: result?.decisionClass === 'deny' || result?.decisionClass === 'ask' ? 'danger'
      : result?.needsContextReview ? 'unknown' : result?.risk?.tier,
    reason: result?.reason || '', item: result,
  });
}

export function approvalCheckpoint(approval) {
  const params = approval?.params || {};
  const method = approval?.providerMethod || '';
  const tool = params.tool_name || '';
  const legacyTool = !approval?.requestClass && (!method || method === 'can_use_tool') && !!tool;
  if (params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions
      || params.grantRoot || params.grant_root || params.dangerouslyDisableSandbox === true
      || params.dangerously_disable_sandbox === true || params.input?.dangerouslyDisableSandbox === true
      || params.input?.dangerously_disable_sandbox === true) return 'permission_expansion';
  if (method === 'item/permissions/requestApproval' || method === 'mcpServer/elicitation/request'
      || ['question', 'plan'].includes(approval?.kind) || ['AskUserQuestion', 'ExitPlanMode'].includes(tool)
      || (approval?.kind === 'permissions' && approval?.requestClass !== 'tool_invocation' && !legacyTool)) return 'owner_checkpoint';
  return null;
}

// Order is deliberately independent of input order: a caution cannot hide a
// dangerous or unverified effect later in the same operation.
export function decideApprovalFacts(facts, { riskMode = '', safeOnly = false } = {}) {
  const rank = { safe: 0, caution: 1, unknown: 2, danger: 3 };
  if (!Array.isArray(facts) || !facts.length) return { decision: 'review', tier: 'unknown', reason: 'operation facts are incomplete' };
  let worst = null;
  for (const fact of facts) {
    const tier = fact?.tier === 'danger' ? 'danger' : Object.hasOwn(rank, fact?.tier) && fact.complete !== false ? fact.tier : 'unknown';
    if (!worst || rank[tier] > rank[worst.tier]) worst = { ...fact, tier };
  }
  const restricted = safeOnly || !['recommended', 'full-auto'].includes(riskMode);
  return { ...worst, decision: worst.tier === 'danger' || worst.tier === 'unknown' || (worst.tier === 'caution' && restricted) ? 'review' : 'allow' };
}
