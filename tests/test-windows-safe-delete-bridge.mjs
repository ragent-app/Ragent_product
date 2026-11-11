import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const helperPath = process.env.AGENTOC_TEST_SAFE_DELETE_BINARY;
if (process.platform !== 'win32' || !helperPath) { console.log('windows-safe-delete-bridge: skipped (opt-in Windows fixture)'); process.exit(0); }
assert.ok(path.isAbsolute(helperPath));
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-delete-bridge-'));
process.env.AGENTOC_INSTANCE_ROOT = path.join(root, 'instance');
process.env.AGENTOC_CONFIG_DIR = path.join(root, 'instance', 'config');
process.env.AGENTOC_WORK_ROOT_DIR = path.join(root, 'instance', 'workspace');
process.env.AGENTOC_MEMORY_DIR = path.join(root, 'instance', 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = path.join(root, 'instance', 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(root, 'instance', 'data', 'chat-runs');
const { createRun, getRun } = await import('../chat/runs.mjs');
const { trackClaudeBidiApprovalRequest } = await import('../chat/runner-sidecar.mjs');
const { buildWindowsSafeDeleteBridge } = await import('../chat/windows-safe-delete-bridge.mjs');
const { planWindowsSafeDeleteList } = await import('../chat/windows-safe-delete-plan.mjs');
const exec = promisify(execFile);
try {
for (const mode of ['recommended', 'full-auto', 'conservative-auto']) {
  const workspace = path.join(root, mode);
  await mkdir(path.join(workspace, 'build'), { recursive: true });
  await writeFile(path.join(workspace, 'build', 'fixture.txt'), 'fixture');
  const run = await createRun({ status: { sessionId: `session-${mode}`, requestId: `request-${mode}`, state: 'accepted', tool: 'claude' },
    manifest: { sessionId: `session-${mode}`, requestId: `request-${mode}`, folder: workspace, tool: 'claude', runtimeFamily: 'claude-stream-json-bidi', prompt: 'fixture', options: {} } });
  const sent = [];
  const proc = { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } };
  const state = { riskMode: mode, turnActive: true, cwd: workspace, riskContextValid: true,
    riskContext: { trustedWorkspaceRoot: workspace, protectedRoots: [] }, pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set() };
  const target = path.join(workspace, 'build').replace(/'/g, "''");
  const message = { type: 'control_request', request_id: 'delete-fixture', request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: `Remove-Item -LiteralPath '${target}' -Recurse -Force` } } };
  const approval = { approvalId: 'claude:delete-fixture', providerMethod: 'can_use_tool', params: message.request };
  for (const changed of [
    { state: { ...state, interactionMode: 'plan' } }, { state: { ...state, riskContextValid: false } },
    { approval: { ...approval, params: { ...approval.params, additionalPermissions: { network: true } } } },
    { approval: { ...approval, params: { ...approval.params, input: { ...approval.params.input, cwd: workspace } } } },
    { helperPath: path.join(workspace, 'nonexistent.exe') },
  ]) assert.equal(await buildWindowsSafeDeleteBridge({ approval, state, runId: run.id, helperPath, ...changed }), null);
  const relative = { type: 'control_request', request_id: 'relative-fixture', request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'Remove-Item -LiteralPath build -Recurse -Force' } } };
  await trackClaudeBidiApprovalRequest(run.id, state, relative, proc, { safeDeleteHelperPath: helperPath });
  if (mode === 'conservative-auto') {
    assert.equal(sent[0]?.response?.response?.behavior, 'deny');
  } else {
    assert.equal(sent[0]?.response?.response?.behavior, 'allow');
    const encodedRelative = /--request '([A-Za-z0-9_-]+)'$/.exec(sent[0].response.response.updatedInput.command)?.[1];
    assert.ok(encodedRelative);
    const relativeRequest = JSON.parse(Buffer.from(encodedRelative, 'base64url').toString('utf8'));
    assert.equal(relativeRequest.expectedCwd, workspace);
    assert.equal(relativeRequest.targetFromCwd, true);
    await assert.rejects(exec(helperPath, ['--request', encodedRelative], { cwd: root, windowsHide: true }));
    assert.equal(await readFile(path.join(workspace, 'build', 'fixture.txt'), 'utf8'), 'fixture');
    const relativeResult = await exec(helperPath, ['--request', encodedRelative], { cwd: workspace, windowsHide: true });
    assert.deepEqual(JSON.parse(relativeResult.stdout), { ok: true, deleted: 2 });
    await mkdir(path.join(workspace, 'build'));
    await writeFile(path.join(workspace, 'build', 'fixture.txt'), 'fixture');
  }
  await trackClaudeBidiApprovalRequest(run.id, state, message, proc, { safeDeleteHelperPath: helperPath });
  if (mode === 'conservative-auto') {
    assert.equal(sent[1]?.response?.response?.behavior, 'deny');
    assert.equal(await readFile(path.join(workspace, 'build', 'fixture.txt'), 'utf8'), 'fixture');
    continue;
  }
  assert.equal(sent[1]?.response?.response?.behavior, 'allow');
  const replacement = sent[1].response.response.updatedInput.command;
  const encoded = /--request '([A-Za-z0-9_-]+)'$/.exec(replacement)?.[1];
  assert.ok(encoded);
  const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(request.workspace, workspace);
  assert.equal(request.relative, 'build');
  assert.equal(request.originalCommand, message.request.input.command);
  assert.match(request.requestKey, /^gate:[a-f0-9]{64}$/);
  const { stdout } = await exec(helperPath, ['--request', encoded], { windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), { ok: true, deleted: 2 });
  await assert.rejects(readFile(path.join(workspace, 'build', 'fixture.txt')), { code: 'ENOENT' });
  assert.equal((await getRun(run.id)).appServerPendingApprovals?.length || 0, 0);
  const bash = process.env.AGENTOC_TEST_BASH_BINARY;
  if (bash) {
    assert.ok(path.isAbsolute(bash));
    const bashDir = path.join(workspace, 'bash-build');
    await mkdir(bashDir); await writeFile(path.join(bashDir, 'fixture.txt'), 'fixture');
    const bashTarget = `/${bashDir[0].toLowerCase()}${bashDir.slice(2).replaceAll('\\', '/')}`;
    const makeBash = (id, command) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command } } });
    await trackClaudeBidiApprovalRequest(run.id, state, makeBash('bash-relative', 'rm -rf bash-build'), proc, { safeDeleteHelperPath: helperPath });
    assert.equal(sent.at(-1)?.response?.response?.behavior, 'allow');
    const bashEnv = { ...process.env }; delete bashEnv.BASH_ENV; delete bashEnv.ENV; delete bashEnv.SHELLOPTS;
    const relativeRun = await exec(bash, ['--noprofile', '--norc', '-c', sent.at(-1).response.response.updatedInput.command], { cwd: workspace, env: bashEnv, windowsHide: true });
    assert.deepEqual(JSON.parse(relativeRun.stdout), { ok: true, deleted: 2 });
    await mkdir(bashDir); await writeFile(path.join(bashDir, 'fixture.txt'), 'fixture');
    await trackClaudeBidiApprovalRequest(run.id, state, makeBash('bash-absolute', `rm -rf '${bashTarget}'`), proc, { safeDeleteHelperPath: helperPath });
    assert.equal(sent.at(-1)?.response?.response?.behavior, 'allow');
    const executed = await exec(bash, ['--noprofile', '--norc', '-c', sent.at(-1).response.response.updatedInput.command], { cwd: workspace, env: bashEnv, windowsHide: true });
    assert.deepEqual(JSON.parse(executed.stdout), { ok: true, deleted: 2 });
    await assert.rejects(readFile(path.join(bashDir, 'fixture.txt')), { code: 'ENOENT' });
  }
}
for (const mode of ['recommended', 'full-auto']) {
  const workspace = path.join(root, `list-${mode}`);
  await mkdir(path.join(workspace, 'build'), { recursive: true });
  await writeFile(path.join(workspace, 'build', 'fixture.txt'), 'fixture');
  await writeFile(path.join(workspace, 'one.txt'), 'fixture');
  const run = await createRun({ status: { sessionId: `list-${mode}`, state: 'accepted', tool: 'claude' },
    manifest: { folder: workspace, tool: 'claude', runtimeFamily: 'claude-stream-json-bidi', prompt: 'fixture', options: {} } });
  const sent = [];
  const proc = { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } };
  const state = { riskMode: mode, turnActive: true, cwd: workspace, riskContextValid: true,
    riskContext: { trustedWorkspaceRoot: workspace, protectedRoots: [] }, pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set() };
  await mkdir(path.join(workspace, 'danger', '.ssh'), { recursive: true });
  for (const command of ['Remove-Item -LiteralPath one.txt,danger -Recurse -Force',
    'Remove-Item -LiteralPath one.txt,..\\outside -Recurse -Force',
    'Remove-Item -LiteralPath one.txt,$env:TEMP -Recurse -Force',
    'Remove-Item -LiteralPath one.txt,build -Recurse -WhatIf',
    'Remove-Item one.txt -Recurse -Force; Remove-Item build -Recurse',
    'Remove-Item one.txt -Recurse -Force; Write-Output unsafe',
    'Remove-Item one.txt -Force; Remove-Item build -Force',
    'Remove-Item one.txt -Recurse -Force; Remove-Item danger -Recurse -Force']) {
    assert.equal(await planWindowsSafeDeleteList({ command, state }), null, command);
  }
  const request = { type: 'control_request', request_id: 'list', request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'Remove-Item -LiteralPath one.txt,build -Recurse -Force' } } };
  await trackClaudeBidiApprovalRequest(run.id, state, request, proc, { safeDeleteHelperPath: helperPath });
  assert.equal(sent[0]?.response?.response?.behavior, 'allow');
  const encoded = /--request '([A-Za-z0-9_-]+)'$/.exec(sent[0].response.response.updatedInput.command)?.[1];
  assert.ok(encoded);
  await assert.rejects(exec(helperPath, ['--request', encoded], { cwd: root, windowsHide: true }));
  assert.equal(await readFile(path.join(workspace, 'one.txt'), 'utf8'), 'fixture');
  const result = await exec(helperPath, ['--request', encoded], { cwd: workspace, windowsHide: true });
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, deleted: 3 });
  await mkdir(path.join(workspace, 'build'));
  await writeFile(path.join(workspace, 'build', 'fixture.txt'), 'fixture');
  await writeFile(path.join(workspace, 'one.txt'), 'fixture');
  const steps = { ...request, request_id: 'steps', request: { ...request.request, input: { command: 'Remove-Item one.txt -Force; Remove-Item build -Recurse -Force' } } };
  await trackClaudeBidiApprovalRequest(run.id, state, steps, proc, { safeDeleteHelperPath: helperPath });
  assert.equal(sent[1]?.response?.response?.behavior, 'allow');
  const stepRequest = /--request '([A-Za-z0-9_-]+)'$/.exec(sent[1].response.response.updatedInput.command)?.[1];
  assert.ok(stepRequest);
  assert.deepEqual(JSON.parse(Buffer.from(stepRequest, 'base64url').toString('utf8')).filesOnly, [true, false]);
  const stepResult = await exec(helperPath, ['--request', stepRequest], { cwd: workspace, windowsHide: true });
  assert.deepEqual(JSON.parse(stepResult.stdout), { ok: true, deleted: 3 });
}
for (const mode of ['recommended', 'full-auto']) {
  for (const shell of ['PowerShell', 'Bash']) {
    const workspace = path.join(root, `sensitive-${mode}-${shell}`);
    const target = path.join(workspace, '.ssh');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'fixture.txt'), 'fixture');
    const run = await createRun({ status: { sessionId: `sensitive-${mode}-${shell}`, state: 'accepted', tool: 'claude' },
      manifest: { folder: workspace, tool: 'claude', runtimeFamily: 'claude-stream-json-bidi', prompt: 'fixture', options: {} } });
    const sent = [];
    const proc = { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } };
    const state = { riskMode: mode, turnActive: true, cwd: workspace, riskContextValid: true,
      riskContext: { trustedWorkspaceRoot: workspace, protectedRoots: [] }, pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set() };
    const makeRequest = (id, command) => ({ type: 'control_request', request_id: id,
      request: { subtype: 'can_use_tool', tool_name: shell, input: { command } } });
    const relative = shell === 'PowerShell' ? "Remove-Item -LiteralPath '.ssh' -Recurse -Force" : "rm -rf '.ssh'";
    await trackClaudeBidiApprovalRequest(run.id, state, makeRequest('relative-sensitive', relative), proc, { safeDeleteHelperPath: helperPath });
    if (mode === 'recommended') {
      assert.equal(sent.length, 0);
      assert.ok((await getRun(run.id)).appServerPendingApprovals?.some((entry) => entry.approvalId === 'claude:relative-sensitive'));
    } else assert.equal(sent.at(-1)?.response?.response?.behavior, 'deny');
    const bashTarget = `/${target[0].toLowerCase()}${target.slice(2).replaceAll('\\', '/')}`;
    const absolute = shell === 'PowerShell'
      ? `Remove-Item -LiteralPath '${target.replace(/'/g, "''")}' -Recurse -Force`
      : `rm -rf '${bashTarget}'`;
    const before = sent.length;
    await trackClaudeBidiApprovalRequest(run.id, state, makeRequest('absolute-sensitive', absolute), proc, { safeDeleteHelperPath: helperPath });
    if (mode === 'recommended') {
      assert.equal(sent.length, before, 'sensitive target must wait for owner review');
      assert.ok((await getRun(run.id)).appServerPendingApprovals?.some((entry) => entry.approvalId === 'claude:absolute-sensitive'));
    } else {
      assert.equal(sent.at(-1)?.response?.response?.behavior, 'deny', 'unattended sensitive target must be denied');
      assert.equal((await getRun(run.id)).appServerPendingApprovals?.length || 0, 0);
    }
    assert.equal(await readFile(path.join(target, 'fixture.txt'), 'utf8'), 'fixture');
  }
}
console.log('windows-safe-delete-bridge: Claude responses and native helper passed');
} finally {
  const actualRoot = await realpath(root);
  const actualParent = await realpath(os.tmpdir());
  assert.equal(path.dirname(actualRoot).toLowerCase(), actualParent.toLowerCase());
  assert.ok(path.basename(actualRoot).startsWith('agentoc-delete-bridge-'));
  await rm(actualRoot, { recursive: true, force: true });
}
