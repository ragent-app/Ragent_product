#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

const home = mkdtempSync(join(tmpdir(), 'agentoc-session-runtime-binding-'));
const workspace = join(home, 'workspace');
const configDir = join(home, '.config', 'agentoc');

process.env.HOME = home;
process.env.AGENTOC_INSTANCE_ROOT = home;
process.env.AGENTOC_CONFIG_DIR = configDir;
process.env.AGENTOC_WORK_ROOT_DIR = workspace;
process.env.AGENTOC_MEMORY_DIR = join(home, '.agentoc', 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = join(home, 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = join(home, 'data', 'chat-runs');
process.env.AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = process.platform === 'win32'
  ? `\\\\.\\pipe\\agentoc-test-binding-${randomBytes(12).toString('hex')}` : '';
process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = '';
process.env.AGENTOC_MEMORY_WRITEBACK = 'off';

mkdirSync(workspace, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(process.env.AGENTOC_MEMORY_DIR, { recursive: true });
writeFileSync(join(configDir, 'tools.json'), JSON.stringify([
  {
    id: 'runtime-fake',
    name: 'Fake Runtime',
    command: process.execPath,
    runtimeFamily: 'codex-json',
    models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
    reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
  },
  {
    id: 'custom-claude-classic',
    name: 'Custom Claude Classic',
    command: process.execPath,
    runtimeFamily: 'claude-stream-json',
    models: [{ id: 'classic-claude-model', label: 'Classic Claude model' }],
    reasoning: { kind: 'toggle', label: 'Thinking' },
  },
  {
    id: 'runtime-gated',
    name: 'Fake Gated Runtime',
    command: process.execPath,
    runtimeFamily: 'codex-app-server-json',
    models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
    reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
  },
], null, 2));

const { createApp } = await import('../chat/apps.mjs');
const {
  createSession,
  forkSession,
  forkSessionAt,
  getSession,
  killAll,
  prepareSessionForFork,
  submitHttpMessage,
} = await import('../chat/session-manager.mjs');
const { resolveSessionRuntimeTool } = await import('../chat/session-runtime-binding.mjs');
const { appendEvents } = await import('../chat/history.mjs');
const { flushSessionsMetaNow, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { createRun, getRun, getRunManifest } = await import('../chat/runs.mjs');
const supervisor = process.platform === 'win32'
  ? await (await import('../chat/runner-supervisor-daemon.mjs')).createRunnerSupervisorServer({
    spawnRunner: async () => ({ pid: null }),
  }) : null;

async function markHistoricalAgentTool(sessionId, agentId) {
  await mutateSessionMeta(sessionId, (draft) => {
    draft.tool = agentId;
    return true;
  });
}

try {
  const agent = await createApp({
    name: 'Runtime binding test Agent',
    tool: 'runtime-gated',
  });

  const builtInClaudeBinding = await resolveSessionRuntimeTool(
    { tool: 'claude' },
    { riskMode: 'recommended' },
  );
  assert.equal(builtInClaudeBinding?.tool, 'claude-bidi',
    'risk-gated built-in Claude must upgrade to the bidirectional runtime');
  assert.equal(builtInClaudeBinding?.definition?.runtimeFamily, 'claude-stream-json-bidi',
    'the upgraded built-in Claude binding must expose the bidi runtime family');

  const windowsAutoClaude = await resolveSessionRuntimeTool({ tool: 'claude' }, { riskMode: 'full-auto', platform: 'win32' });
  assert.equal(windowsAutoClaude?.definition?.runtimeFamily, 'claude-stream-json-bidi',
    'Windows full-auto must use the same gated built-in Claude runtime as approval');
  const linuxAutoClaude = await resolveSessionRuntimeTool({ tool: 'claude' }, { riskMode: 'full-auto', platform: 'linux' });
  assert.equal(linuxAutoClaude?.definition?.runtimeFamily, 'claude-stream-json',
    'the Windows change must not change the existing Linux full-auto binding');
  const customAutoClaude = await resolveSessionRuntimeTool({ tool: 'custom-claude-classic' }, { riskMode: 'full-auto', platform: 'win32' });
  assert.equal(customAutoClaude?.tool, 'custom-claude-classic', 'custom runtime definitions must not be silently replaced');

  const classicClaudeBinding = await resolveSessionRuntimeTool(
    { tool: 'custom-claude-classic' },
    { riskMode: 'recommended' },
  );
  assert.equal(classicClaudeBinding?.tool, 'custom-claude-classic',
    'custom classic Claude must not be silently replaced by the built-in bidi tool');
  assert.equal(classicClaudeBinding?.definition?.runtimeFamily, 'claude-stream-json',
    'custom classic Claude must retain its declared runtime family');

  const classicClaudeSession = await createSession(workspace, 'custom-claude-classic', 'Classic Claude gate', {
    riskMode: 'recommended',
  });
  await assert.rejects(
    () => submitHttpMessage(classicClaudeSession.id, 'This runtime cannot answer approvals.', [], {
      requestId: 'classic-claude-gate',
      model: 'classic-claude-model',
      skipDispatch: true, skipRunnerLaunch: true,
    }),
    (error) => error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME'
      && error?.statusCode === 409
      && error?.runtimeFamily === 'claude-stream-json',
    'risk-gated custom classic Claude must fail closed before creating a Run',
  );

  const fakeGatedSession = await createSession(workspace, 'runtime-fake', 'Codex CLI gate', {
    riskMode: 'recommended',
  });
  await assert.rejects(
    () => submitHttpMessage(fakeGatedSession.id, 'This runtime cannot answer approvals.', [], {
      requestId: 'codex-cli-gate',
      model: 'fake-model',
      skipDispatch: true, skipRunnerLaunch: true,
    }),
    (error) => error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME'
      && error?.statusCode === 409
      && error?.runtimeFamily === 'codex-json',
    'risk-gated Codex CLI must fail closed before creating a Run',
  );

  if (process.platform === 'win32') {
    const autoSession = await createSession(workspace, 'runtime-fake', 'Unsupported autonomous runtime', {
      riskMode: 'full-auto',
    });
    await assert.rejects(
      () => submitHttpMessage(autoSession.id, 'This runtime cannot enforce the Windows gate.', [], {
        requestId: 'codex-cli-auto-gate',
        model: 'fake-model',
      }),
      (error) => error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME'
        && error?.statusCode === 409
        && /codex-json/.test(error.message),
      'Windows autonomous mode must reject a runtime that cannot enforce its approval policy',
    );
  }

  const parent = await createSession(workspace, agent.id, 'Historical Agent session', {
    templateId: agent.id,
    templateName: agent.name,
  });
  assert.equal(parent.tool, agent.id, 'fixture should start with the historical Agent id in session.tool');

  const repaired = await getSession(parent.id);
  assert.equal(repaired.tool, 'runtime-gated', 'loading a historical Agent session should repair its Runtime tool');
  await flushSessionsMetaNow();
  const storedAfterRepair = JSON.parse(readFileSync(join(configDir, 'chat-sessions.json'), 'utf8'))
    .find((session) => session.id === parent.id);
  assert.equal(storedAfterRepair?.tool, 'runtime-gated', 'Runtime repair should persist the canonical tool id');

  await appendEvents(parent.id, [
    { type: 'message', role: 'user', content: 'Start the branch.', timestamp: 1 },
    { type: 'message', role: 'assistant', content: 'The branch is ready.', timestamp: 2 },
  ]);

  await markHistoricalAgentTool(parent.id, agent.id);
  const forked = await forkSession(parent.id);
  assert.equal(forked?.tool, 'runtime-gated', 'fork should resolve the Agent id to the executable Runtime tool');
  assert.equal(forked?.templateId, agent.id, 'fork should preserve the Agent template scope');

  await markHistoricalAgentTool(parent.id, agent.id);
  const forkedAt = await forkSessionAt(parent.id, {
    anchorSeq: 2,
    mode: 'assistant-continue',
    idempotencyKey: 'runtime-binding-fork-at',
  });
  assert.equal(forkedAt?.tool, 'runtime-gated', 'fork-at should resolve the Agent id to the executable Runtime tool');
  assert.equal(forkedAt?.templateId, agent.id, 'fork-at should preserve the Agent template scope');

  const sendSession = await createSession(workspace, agent.id, 'Historical send session', {
    templateId: agent.id,
    templateName: agent.name,
  });
  await markHistoricalAgentTool(sendSession.id, agent.id);
  const submitted = await submitHttpMessage(sendSession.id, 'Run through the repaired binding.', [], {
    requestId: 'runtime-binding-submit',
    model: 'fake-model',
    effort: 'low',
    queueIfBusy: false,
  });
  const manifest = await getRunManifest(submitted.run.id);
  assert.equal(manifest?.tool, 'runtime-gated', 'submitted Run manifest should carry the Runtime tool');
  assert.equal(manifest?.runtimeFamily, 'codex-app-server-json', 'submitted Run manifest should carry runtimeFamily');
  assert.equal(manifest?.options?.runtimeFamily, 'codex-app-server-json', 'Run options should carry runtimeFamily');

  const orphanSession = await createSession(workspace, 'missing-tool', 'Orphan Run session');
  const orphanRun = await createRun({
    status: {
      sessionId: orphanSession.id,
      requestId: 'orphan-runtime-binding',
      state: 'accepted',
      tool: 'missing-tool',
    },
    manifest: {
      sessionId: orphanSession.id,
      requestId: 'orphan-runtime-binding',
      tool: 'missing-tool',
      options: {},
    },
  });
  await mutateSessionMeta(orphanSession.id, (draft) => {
    draft.activeRunId = orphanRun.id;
    return true;
  });

  const preparedOrphan = await prepareSessionForFork(orphanSession.id);
  const finalizedOrphan = await getRun(orphanRun.id);
  assert.equal(preparedOrphan?.running, false, 'an unrecoverable orphan Run must not keep the session running');
  assert.equal(finalizedOrphan?.state, 'failed', 'an accepted Run without runtimeFamily or Runner must be terminalized');
  assert.ok(finalizedOrphan?.finalizedAt, 'terminalized orphan Run should be finalized');
  const orphanAfter = await getSession(orphanSession.id);
  assert.equal(orphanAfter?.activeRunId, undefined, 'terminalized orphan Run must clear session.activeRunId');

  const orphanFork = await forkSession(orphanSession.id);
  assert.ok(orphanFork?.id, 'a session blocked by an unrecoverable orphan Run should be forkable after cleanup');

  console.log('test-session-runtime-binding: ok');
} finally {
  killAll();
  await supervisor?.close();
  rmSync(home, { recursive: true, force: true });
}
