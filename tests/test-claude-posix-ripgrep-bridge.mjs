import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') { console.log('claude-posix-ripgrep: skipped on Windows'); process.exit(0); }
if (spawnSync('rg', ['--version'], { stdio: 'ignore' }).status !== 0) { console.log('claude-posix-ripgrep: skipped (ripgrep unavailable)'); process.exit(0); }
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-posix-rg-'));
const workspace = path.join(root, 'workspace'); const outside = path.join(root, 'outside'); const protectedRoot = path.join(root, 'protected');
await mkdir(workspace); await mkdir(outside); await mkdir(protectedRoot);
await writeFile(path.join(outside, 'readme.txt'), 'SEARCH_TOKEN=public\n');
await writeFile(path.join(outside, '.env'), 'SEARCH_TOKEN=private\n');
await writeFile(path.join(outside, '.ignore'), '!.env\n');
await writeFile(path.join(root, 'rg-config'), '--hidden\n');
process.env.AGENTOC_INSTANCE_ROOT = path.join(root, 'instance');
process.env.AGENTOC_CONFIG_DIR = path.join(root, 'instance', 'config');
process.env.AGENTOC_WORK_ROOT_DIR = workspace;
process.env.AGENTOC_MEMORY_DIR = path.join(root, 'instance', 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = path.join(root, 'instance', 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(root, 'instance', 'data', 'chat-runs');
const { buildClaudePosixRipgrepBridge } = await import('../chat/windows-claude-relative-operation-bridge.mjs');
const { createRun, getRun } = await import('../chat/runs.mjs');
const { trackClaudeBidiApprovalRequest } = await import('../chat/runner-sidecar.mjs');
try {
  for (const riskMode of ['recommended', 'full-auto']) {
    const state = { riskMode, cwd: workspace, turnActive: true, riskContextValid: true,
      riskContext: { platform: 'linux', trustedWorkspaceRoot: workspace, protectedRoots: [protectedRoot] },
      pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set() };
    const approval = command => ({ approvalId: 'claude:fixture', providerMethod: 'can_use_tool', kind: 'command', params: { tool_name: 'Bash', input: { command } } });
    for (const command of ['rg -n SEARCH_TOKEN ../outside', "rg -g '*' -n SEARCH_TOKEN ../outside", 'rg -n -- SEARCH_TOKEN ../outside']) {
      const bridge = await buildClaudePosixRipgrepBridge({ approval: approval(command), state });
      assert.ok(bridge && !bridge.review, `${riskMode}: ${command}`);
      const env = { ...process.env, RIPGREP_CONFIG_PATH: path.join(root, 'rg-config') };
      const output = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', bridge.updatedInput.command], { cwd: workspace, env, encoding: 'utf8' });
      assert.match(output, /SEARCH_TOKEN=public/);
      assert.doesNotMatch(output, /SEARCH_TOKEN=private|\.env/);
      assert.notEqual(spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', bridge.updatedInput.command], { cwd: outside, env }).status, 0);
    }
    for (const command of ['rg SEARCH_TOKEN ../outside/.env', 'rg SEARCH_TOKEN ../protected', 'rg --hidden SEARCH_TOKEN ../outside',
      'rg --follow SEARCH_TOKEN ../outside', 'rg -uu SEARCH_TOKEN ../outside', 'rg --pre=cat SEARCH_TOKEN ../outside']) {
      assert.equal((await buildClaudePosixRipgrepBridge({ approval: approval(command), state }))?.review, true, command);
    }
    const list = await buildClaudePosixRipgrepBridge({ approval: approval('rg --files ../outside'), state });
    const names = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', list.updatedInput.command], { cwd: workspace, encoding: 'utf8' });
    assert.match(names, /readme\.txt/);
    assert.doesNotMatch(names, /\.env/i);
    const absolute = await buildClaudePosixRipgrepBridge({ approval: approval(`rg SEARCH_TOKEN '${outside}'`), state });
    assert.ok(absolute && !absolute.review);
    const absoluteOutput = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', absolute.updatedInput.command], { cwd: root, encoding: 'utf8' });
    assert.match(absoluteOutput, /SEARCH_TOKEN=public/);
    assert.doesNotMatch(absoluteOutput, /SEARCH_TOKEN=private/);
    const missing = await buildClaudePosixRipgrepBridge({ approval: approval('rg SEARCH_TOKEN ../outside/missing.txt'), state });
    assert.ok(missing && !missing.review, 'a missing ordinary file should fail normally without user approval');
    assert.equal((await buildClaudePosixRipgrepBridge({ approval: approval('rg SEARCH_TOKEN ../outside'), state: { ...state, riskContext: { ...state.riskContext, protectedRoots: 'invalid' } } }))?.review, true);
    const run = await createRun({ status: { sessionId: `posix-${riskMode}`, state: 'accepted', tool: 'claude' },
      manifest: { folder: workspace, tool: 'claude', runtimeFamily: 'claude-stream-json-bidi', prompt: 'fixture', options: {} } });
    const sent = []; const proc = { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } };
    const request = (id, command) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command } } });
    await trackClaudeBidiApprovalRequest(run.id, state, request('safe-rg', 'rg -n SEARCH_TOKEN ../outside'), proc);
    assert.equal(sent[0]?.response?.response?.behavior, 'allow');
    assert.match(sent[0]?.response?.response?.updatedInput?.command || '', /--iglob/);
    await trackClaudeBidiApprovalRequest(run.id, state, request('private-rg', 'rg SEARCH_TOKEN ../outside/.env'), proc);
    if (riskMode === 'recommended') assert.ok((await getRun(run.id)).appServerPendingApprovals.some(entry => entry.approvalId === 'claude:private-rg'));
    else assert.equal(sent[1]?.response?.response?.behavior, 'deny');
    const beforeHidden = sent.length;
    await trackClaudeBidiApprovalRequest(run.id, state, request('hidden-rg', 'rg --hidden SEARCH_TOKEN ../outside'), proc);
    if (riskMode === 'recommended') assert.ok((await getRun(run.id)).appServerPendingApprovals.some(entry => entry.approvalId === 'claude:hidden-rg'));
    else assert.equal(sent[beforeHidden]?.response?.response?.behavior, 'deny');
  }
  assert.equal(await readFile(path.join(outside, '.env'), 'utf8'), 'SEARCH_TOKEN=private\n');
  console.log('claude-posix-ripgrep: real Linux shell and approval routes passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
