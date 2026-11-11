#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { buildCodexWindowsInstallHookDecision } from '../chat/codex-windows-install-hook.mjs';
import { buildCodexWindowsSafeDeleteHookDecision } from '../chat/codex-windows-safe-delete-hook.mjs';
import { buildCodexWindowsRipgrepHookDecision } from '../chat/windows-ripgrep-bridge.mjs';
import { buildCodexWindowsElevationGuidance } from '../chat/windows-elevation-guidance.mjs';

// A malformed event or unavailable control plane leaves the original command
// to the normal approval path. Never print credentials or diagnostics to stdout.
async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 256 * 1024) return {};
  }
  let event;
  try { event = JSON.parse(raw); } catch { return {}; }
  let safeDeleteContext;
  try { safeDeleteContext = JSON.parse(process.env.AGENTOC_WINDOWS_SAFE_DELETE_CONTEXT || 'null'); } catch { safeDeleteContext = null; }
  if (safeDeleteContext) {
    const decision = await buildCodexWindowsSafeDeleteHookDecision({ event, state: safeDeleteContext.state, runId: safeDeleteContext.runId,
      helperPath: safeDeleteContext.helperPath });
    if (decision.hookSpecificOutput) return decision;
    const ripgrep = await buildCodexWindowsRipgrepHookDecision({ event, state: safeDeleteContext.state, runId: safeDeleteContext.runId });
    if (ripgrep.hookSpecificOutput) return ripgrep;
  }
  const channel = { endpoint: process.env.AGENTOC_APPROVED_ACTIONS_ENDPOINT, token: process.env.AGENTOC_APPROVED_ACTIONS_TOKEN,
    sessionId: process.env.AGENTOC_APPROVED_ACTIONS_SESSION_ID, runId: process.env.AGENTOC_APPROVED_ACTIONS_RUN_ID,
    turnId: process.env.AGENTOC_APPROVED_ACTIONS_TURN_ID };
  try { channel.windowsUserInstallIdentity = JSON.parse(process.env.AGENTOC_WINDOWS_USER_INSTALL_IDENTITY || 'null'); } catch {}
  const install = process.env.AGENTOC_WINDOWS_INSTALL_BRIDGE_DISABLED === '1' ? {} :
    await buildCodexWindowsInstallHookDecision({ event, channel, nodePath: process.execPath,
      scriptPath: fileURLToPath(new URL('./agentoc-windows-install-bridge.mjs', import.meta.url)) });
  if (install.hookSpecificOutput) return install;
  return buildCodexWindowsElevationGuidance({ event, channel });
}
main().then(result => process.stdout.write(JSON.stringify(result)), () => process.stdout.write('{}'));
