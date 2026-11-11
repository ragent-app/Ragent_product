import { createClaudeAdapter } from './claude.mjs';
import { approvalRequestEvent, approvalResponseEvent } from '../normalizer.mjs';
import { explanationForApproval } from '../risk-explanation.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { CLAUDE_BIDI_RUNTIME_FAMILY, readClaudeBidiApprovalRequest } from '../claude-bidi-protocol.mjs';

export { CLAUDE_BIDI_RUNTIME_FAMILY };

/**
 * Derive a readable title from a markdown plan body (first ATX heading), so
 * string-shaped ExitPlanMode plans get a real title instead of "ExitPlanMode".
 */
function extractPlanTitleFromMarkdown(markdown) {
  if (typeof markdown !== 'string') return '';
  const match = String(markdown).match(/^\s*#{1,6}\s+(.+?)\s*$/m);
  if (!match || !match[1]) return '';
  const title = match[1].trim();
  return title ? title.slice(0, 120) : '';
}

/**
 * Claude Code bidirectional stream-json adapter.
 *
 * Output frames are identical to the one-shot claude-stream-json format, so we
 * delegate parsing to the existing claude adapter and only re-tag the
 * per-event provider/runtimeFamily so bidi runs are distinguishable from the
 * one-shot path. Capability lookup is overridden to the bidi family.
 */
export function createClaudeBidiAdapter() {
  const base = createClaudeAdapter();
  // Approval ids that the runner sidecar already answered automatically.
  // The sidecar echoes its synthetic agentoc.approval_response
  // into the stream BEFORE the control_request it answers, so a request frame
  // for a known id is never a live user-facing approval. Suppressing it keeps
  // automatically allowed and denied tools out of the
  // approval cards, push notifications, and the replay gate entirely.
  const autoApprovedIds = new Set();

  function parseLine(line) {
    let intermediateResult = false;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'agentoc.approval_response') {
        if ((parsed.autoApproved === true || parsed.autoDenied === true)
          && typeof parsed.approvalId === 'string' && parsed.approvalId) {
          autoApprovedIds.add(parsed.approvalId);
          return [];
        }
        return [approvalResponseEvent({
          approvalId: parsed.approvalId,
          decision: parsed.decision,
          status: parsed.status,
          source: 'claude-bidi',
          providerRequestId: parsed.providerRequestId,
          providerMethod: parsed.providerMethod,
        })].filter(Boolean);
      }
      const approval = readClaudeBidiApprovalRequest(parsed);
      if (approval) {
        if (approval.approvalId && autoApprovedIds.has(approval.approvalId)) {
          return [];
        }
        const params = approval.params || {};
        const isQuestion = approval.kind === 'question';
        const isPlan = approval.kind === 'plan';
        // ExitPlanMode input carries the drafted plan in two real-world shapes:
        // an object { plan: { title, text } } (Agent SDK) or a plain markdown
        // string plan (Claude Code 2.1.x CLI). Handle both.
        const planRaw = isPlan && params.input && typeof params.input === 'object'
          ? params.input.plan
          : null;
        const planObject = planRaw && typeof planRaw === 'object' ? planRaw : null;
        const planText = planObject
          ? (typeof planObject.text === 'string' && planObject.text.trim() ? planObject.text.trim() : '')
          : (typeof planRaw === 'string' && planRaw.trim() ? planRaw.trim() : '');
        const planTitle = planObject && typeof planObject.title === 'string' && planObject.title.trim()
          ? planObject.title.trim()
          : extractPlanTitleFromMarkdown(planText);
        return [approvalRequestEvent({
          approvalId: approval.approvalId,
          providerRequestId: approval.providerRequestIdString,
          providerMethod: approval.providerMethod,
          providerItemId: params.tool_use_id,
          providerToolUseId: params.tool_use_id,
          kind: approval.kind,
          title: planTitle || params.display_name || params.tool_name,
          reason: isPlan
            ? (planText || params.description || '')
            : (params.description || ''),
          command: ['Bash', 'PowerShell'].includes(params.tool_name) ? params.input?.command : '',
          grantRoot: params.blocked_path || '',
          permissions: { suggestions: params.permission_suggestions || [] },
          status: 'pending',
          source: 'claude-bidi',
          ...(params.tool_name === 'Bash' ? { explanation: explanationForApproval({ command: params.input?.command, providerDescription: params.description }) } : {}),
          ...(isQuestion ? { questions: Array.isArray(params.input?.questions) ? params.input.questions : [] } : {}),
        })].filter(Boolean);
      }
      intermediateResult = parsed?.type === 'result' && parsed?.agentoc_intermediate === true;
    } catch {}
    const events = base.parseLine(line);
    if (!Array.isArray(events) || events.length === 0) return events;
    return events
      .filter((event) => !(intermediateResult && event?.type === 'status'))
      .map((event) => ({
        ...event,
        provider: 'claude',
        runtimeFamily: CLAUDE_BIDI_RUNTIME_FAMILY,
      }));
  }

  return {
    capabilities: getProviderCapabilities(CLAUDE_BIDI_RUNTIME_FAMILY),
    parseLine,
    flush: base.flush,
    seedAutoApprovedIds(ids = []) {
      for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id === 'string' && id.trim()) autoApprovedIds.add(id.trim());
      }
    },
  };
}

/**
 * Build the command-line arguments for spawning Claude Code in bidirectional
 * stream-json mode. The prompt is NOT passed on the command line — it is fed
 * on stdin after spawn (see claude-bidi-protocol.mjs).
 *
 * Mirrors buildClaudeArgs() from ./claude.mjs minus the positional prompt.
 */
export function buildClaudeBidiArgs(options = {}) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
  ];

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns));
  }
  if (options.resume) {
    args.push('--resume', options.resume);
  } else if (options.continue) {
    args.push('--continue');
  }
  if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
    args.push('--allowedTools', ...options.allowedTools);
  }
  if (typeof options.mcpConfigPath === 'string' && options.mcpConfigPath.trim()) {
    args.push('--mcp-config', options.mcpConfigPath.trim());
  }
  if (options.forceClaudeCommandGate === true) {
    args.push('--settings', JSON.stringify({ permissions: { ask: ['Bash', 'PowerShell'] } }));
  }
  const permissionMode = typeof options.permissionMode === 'string' ? options.permissionMode.trim() : '';
  if (permissionMode) {
    // Preserve `default`: its stdio permission prompts are the approval gate.
    args.push('--permission-mode', permissionMode === 'skip-permissions' ? 'bypassPermissions' : permissionMode);
  } else if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  const effort = typeof options.effort === 'string' ? options.effort.trim() : '';
  if (effort && effort !== 'none') {
    args.push('--effort', effort);
  } else if (!effort && options.thinking) {
    args.push('--effort', 'high');
  }
  // effort === 'none' → no --effort flag → thinking disabled

  return args;
}
