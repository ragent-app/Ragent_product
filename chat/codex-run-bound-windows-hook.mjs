import { evaluateCodexWindowsHook } from '../scripts/agentoc-codex-windows-install-hook.mjs';

// Hook calls cross a process boundary. Never choose a run based on an event's
// claimed ID alone: the caller must supply the active sidecar's binding.
export async function evaluateRunBoundCodexWindowsHook(event, binding) {
  if (!binding?.active || !binding.threadId || !binding.turnId || !binding.env
      || event?.session_id !== binding.threadId || event?.turn_id !== binding.turnId
      || event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash'
      || typeof event?.tool_use_id !== 'string' || !event.tool_use_id
      || event.tool_use_id.length > 1024 || typeof event?.tool_input?.command !== 'string'
      || event.tool_input.command.length > 256 * 1024) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'The Windows operation could not be bound to its active run.' } };
  }
  if (binding.enabled === false) return {};
  return evaluateCodexWindowsHook(event, binding.env);
}
