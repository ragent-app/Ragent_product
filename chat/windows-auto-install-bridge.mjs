import { createHash } from 'node:crypto';
import path from 'node:path';
import { mapPowerShellFactsToCandidates, parsePowerShellCommandFacts } from './semantic-parsers/powershell-command.mjs';
import { parsePrivilegedSentinel } from './privileged-sentinel.mjs';

// Replace the entire sentinel invocation; never execute its shell text. Accept
// only the documented, literal wrapper grammar so no surrounding shell action
// or unknown option disappears during the replacement.
function unwrapInstallSentinel(command) {
  const sentinel = parsePrivilegedSentinel(command);
  if (!sentinel) return command;
  if (!sentinel.valid || (sentinel.declaredCategory && sentinel.declaredCategory !== 'install')) return '';
  const wrapper = command.trim().slice(0, command.trim().length - sentinel.realCommand.length);
  if (!/^(?:agentoc|ragent)-privileged\s+(?:(?:--description|--desc|--category)\s+(?:"[^"\\\r\n$`]*"|'[^'\\\r\n]*'|[A-Za-z0-9._-]+)\s+)*--\s+$/i.test(wrapper)) return '';
  return sentinel.realCommand;
}

// Only Claude supports replacing a tool's input in its approval response.
// The replacement contains no command text, credentials, or shell fragments:
// the original is JSON/base64url data rechecked by the control plane.
export function buildClaudeWindowsInstallBridge({ approval, state, runId, nodePath, scriptPath } = {}) {
  if (!state?.windowsManagedActionChannel || !['recommended', 'full-auto'].includes(state.riskMode) || state.riskContextValid === false ||
      approval?.providerMethod !== 'can_use_tool' || !['PowerShell', 'Bash'].includes(approval?.params?.tool_name) ||
      approval?.params?.additionalPermissions || approval?.params?.additional_permissions || approval?.params?.networkApprovalContext || approval?.params?.network_approval_context ||
      !path.win32.isAbsolute(nodePath || '') || !path.win32.isAbsolute(scriptPath || '')) return null;
  const originalCommand = approval.params?.input?.command;
  if (typeof originalCommand !== 'string' || originalCommand.length > 8192) return null;
  const command = unwrapInstallSentinel(originalCommand);
  if (!/^\s*(?:winget(?:\.exe)?\s+(?:install|add)|msiexec(?:\.exe)?\s+\/i)(?:\s|$)/i.test(command)) return null;
  const parsed = mapPowerShellFactsToCandidates(parsePowerShellCommandFacts(command), { cwd: 'C:\\' });
  if (parsed.candidates.length !== 1 || parsed.candidates[0].primaryAction !== 'package.install' || parsed.unknowns.length) return null;
  const id = String(approval.approvalId || '');
  if (!id || typeof runId !== 'string' || !runId) return null;
  const requestKey = `gate:${createHash('sha256').update(JSON.stringify([runId, id])).digest('hex')}`;
  const pinned = state.windowsManagedActionBinding?.windowsUserInstallIdentity;
  const validPinned = pinned && typeof pinned.kid === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(pinned.kid)
    && typeof pinned.publicKey === 'string' && pinned.publicKey.length <= 1024
    && /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(pinned.publicKey);
  const encoded = Buffer.from(JSON.stringify({ command, requestKey,
    ...(validPinned ? { windowsUserInstallIdentity: { kid: pinned.kid, publicKey: pinned.publicKey } } : {}) }), 'utf8').toString('base64url');
  const shell = approval.params.tool_name;
  const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
  const bashQuote = (value) => `'${value.replace(/\\/g, '/').replace(/'/g, `'"'"'`)}'`;
  const quote = shell === 'PowerShell' ? psQuote : bashQuote;
  const updatedCommand = `${shell === 'PowerShell' ? '& ' : ''}${quote(nodePath)} ${quote(scriptPath)} ${quote(encoded)}`;
  return { updatedCommand, requestKey, installCommand: command };
}

// This is a read-only, run-bound eligibility check. The control plane repeats
// all checks at submission; readiness is never an authorization to install.
export async function checkWindowsInstallBridgeReadiness({ channel, command, requestKey, fetchImpl = fetch } = {}) {
  try {
    const endpoint = new URL(channel?.endpoint || '');
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/api/internal/approved-actions/propose' ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !channel.token || !channel.sessionId || !channel.runId || !channel.turnId ||
        typeof command !== 'string' || !/^gate:[a-f0-9]{64}$/.test(requestKey || '')) return false;
    const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', 'x-agentoc-approved-action-token': channel.token },
      body: JSON.stringify({ autoInstallPreflight: true, requestKey, sessionId: channel.sessionId, runId: channel.runId,
        turnId: channel.turnId, actions: [{ command }] }) });
    if (!response.ok) return false;
    const result = await response.json();
    return result?.kind === 'automatic_install_preflight' && result.ready === true;
  } catch { return false; }
}
