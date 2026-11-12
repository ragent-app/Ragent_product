// Adapt Ragent's run-bound approved-action tools to Codex dynamic tools.
// The caller owns the binding and must revoke it when the turn ends.
import { actionTool, agentCreateTool, handleRequest } from '../scripts/agentoc-approved-actions-mcp.mjs';

export function codexApprovedActionTools(config) {
  if (config?.enabled !== true) return [];
  return [actionTool(), ...(config.agentCreateEnabled === true ? [agentCreateTool()] : [])]
    .map(tool => ({ type: 'function', ...tool }));
}

export async function handleCodexApprovedActionCall(message, binding) {
  if (message?.method !== 'item/tool/call' || message.id == null) return null;
  const params = message.params || {};
  const allowed = new Set(codexApprovedActionTools(binding?.config).map(tool => tool.name));
  const normalizedTool = typeof params.tool === 'string' ? params.tool.replace(/^agentoc_/, 'ragent_') : '';
  if (!binding?.active || !binding.threadId || !binding.turnId
      || params.threadId !== binding.threadId || params.turnId !== binding.turnId
      || !params.callId || params.namespace != null || !allowed.has(normalizedTool)) {
    return { id: message.id, error: { code: -32003, message: 'Dynamic tool call is not bound to this active run' } };
  }
  const result = await handleRequest({ id: params.callId, method: 'tools/call', params: {
    name: params.tool, arguments: params.arguments,
  } }, binding.config);
  const items = result.result?.content || [];
  return { id: message.id, result: {
    contentItems: items.filter(item => item.type === 'text').map(item => ({ type: 'inputText', text: item.text })),
    success: result.result?.isError !== true && !result.error,
  } };
}
