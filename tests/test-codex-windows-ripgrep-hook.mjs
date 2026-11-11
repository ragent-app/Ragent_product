import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexWindowsRipgrepHookDecision } from '../chat/windows-ripgrep-bridge.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

if (process.platform !== 'win32') {
  console.log('codex-windows-ripgrep-hook: skipped (requires Windows)');
  process.exit(0);
}
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-rg-hook-'));
try {
  await writeFile(path.join(root, 'ordinary.txt'), 'fixture');
  await writeFile(path.join(root, '.env'), 'fake-secret');
  const config = path.join(root, 'ripgrep-config');
  await writeFile(config, '--hidden\n');
  const quoted = `'${root.replaceAll("'", "''")}'`;
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'fixture-item', cwd: root,
    tool_input: { command: `rg --files ${quoted}`, yield_time_ms: 1000 } };
  for (const riskMode of ['recommended', 'full-auto']) {
    const state = { riskMode, riskContextValid: true, riskContext: { platform: 'win32', trustedWorkspaceRoot: root, protectedRoots: [] } };
    const result = await buildCodexWindowsRipgrepHookDecision({ event, state, runId: 'fixture-run' });
    const output = result.hookSpecificOutput;
    assert.equal(output?.permissionDecision, 'allow');
    assert.match(output.updatedInput.command, /^rg --no-config /);
    assert.equal(output.updatedInput.yield_time_ms, 1000);
    const actual = execFileSync(resolveWindowsSystemPaths().powershell,
      ['-NoProfile', '-NonInteractive', '-Command', output.updatedInput.command],
      { cwd: root, windowsHide: true, encoding: 'utf8', env: { ...process.env, RIPGREP_CONFIG_PATH: config } });
    assert.match(actual, /ordinary\.txt/);
    assert.doesNotMatch(actual, /\.env/, 'real PowerShell search must ignore the config requesting hidden files');
    for (const changed of [
      { ...event, tool_input: { command: `rg --files -g '*' ${quoted}` } },
      { ...event, tool_input: { command: `rg --files ${quoted}`, sandbox_permissions: 'require_escalated' } },
      { ...event, tool_input: { command: 'rg --files .' } },
      { ...event, permission_mode: 'plan' },
      { ...event, additionalPermissions: { network: true } },
    ]) assert.deepEqual(await buildCodexWindowsRipgrepHookDecision({ event: changed, state, runId: 'fixture-run' }), {});
  }
  console.log('codex-windows-ripgrep-hook: run-bound verified searches ignore implicit config');
} finally {
  await rm(root, { recursive: true, force: true });
}
