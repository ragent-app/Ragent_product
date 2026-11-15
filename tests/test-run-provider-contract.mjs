#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-run-provider-contract-'));
const previousEnv = {
  RAGENT_INSTANCE_ROOT: process.env.RAGENT_INSTANCE_ROOT,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_WORK_ROOT_DIR: process.env.RAGENT_WORK_ROOT_DIR,
};

process.env.RAGENT_INSTANCE_ROOT = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_WORK_ROOT_DIR = join(home, '.ragent', 'workspace');

try {
  const { buildRuntimeInvocation } = await import('../chat/process-runner.mjs');
  const { createRunProjectionService } = await import('../chat/run-projection.mjs');
  const { buildSessionActivity } = await import('../chat/session-activity.mjs');
  const {
    appendRunSpoolRecord,
    createRun,
    createRunRecord,
    getRun,
    getRunManifest,
    materializeRunSpoolLine,
    readRunSpoolDelta,
    readRunSpoolRecords,
    updateRun,
  } = await import('../chat/runs.mjs');

  const record = createRunRecord({
    sessionId: 'session_record_contract',
    requestId: 'req_record_contract',
    tool: 'codex',
    runtimeFamily: 'codex-app-server-json',
  });
  assert.equal(record.provider, 'codex');
  assert.equal(record.runtimeFamily, 'codex-app-server-json');
  assert.equal(record.providerCapabilities.supportsInterrupt, true);
  assert.equal(record.permissionMode, 'never-danger-full-access');
  assert.equal(record.reasoningEnabled, false);
  assert.equal(record.reasoningVisibility, 'collapsed');

  const xhighReasoningRecord = createRunRecord({
    sessionId: 'session_reasoning_contract',
    requestId: 'req_reasoning_contract',
    tool: 'claude-bidi',
    runtimeFamily: 'claude-stream-json-bidi',
    effort: 'xhigh',
    thinking: false,
  });
  assert.equal(
    xhighReasoningRecord.reasoningEnabled,
    true,
    'explicit effort enables reasoning independently of the legacy thinking toggle',
  );
  assert.equal(xhighReasoningRecord.reasoningVisibility, 'collapsed');

  const run = await createRun({
    status: {
      sessionId: 'session_projection_contract',
      requestId: 'req_projection_contract',
      state: 'accepted',
      tool: 'codex',
    },
    manifest: {
      sessionId: 'session_projection_contract',
      requestId: 'req_projection_contract',
      folder: '~',
      tool: 'codex',
      runtimeFamily: 'codex-json',
      prompt: 'hi',
      options: { runtimeFamily: 'codex-json', interactionMode: 'agent' },
    },
  });

  await appendRunSpoolRecord(run.id, {
    ts: '2026-06-23T00:00:00.000Z',
    stream: 'stdout',
    line: JSON.stringify({ type: 'turn.started' }),
  });

  let sawProjectionContract = false;
  const service = createRunProjectionService({
    buildCodexContextMetricsPayload: () => null,
    clipPreview: (text) => String(text || ''),
    createToolInvocation: async (tool, _prompt, options = {}) => buildRuntimeInvocation(
      options.runtimeFamily,
      '',
      {},
      tool,
    ),
    materializeRunSpoolLine,
    normalizeRunEvents: (projectionRun, events) => {
      sawProjectionContract = true;
      assert.equal(projectionRun.provider, 'codex');
      assert.equal(projectionRun.runtimeFamily, 'codex-json');
      assert.equal(projectionRun.providerCapabilities.supportsFileStats, true);
      assert.equal(projectionRun.providerCapabilities.permissionModel, 'codex-approval-sandbox');
      assert.equal(projectionRun.permissionMode, 'bypass-approvals-and-sandbox');
      assert.equal(projectionRun.interactionMode, 'agent');
      return events.map((event) => ({
        ...event,
        runId: projectionRun.id,
        provider: event.provider || projectionRun.provider,
        runtimeFamily: event.runtimeFamily || projectionRun.runtimeFamily,
      }));
    },
    readLatestCodexSessionMetrics: async () => null,
    readRunSpoolDelta,
    readRunSpoolRecords,
  });

  const projection = await service.collectNormalizedRunEventDelta(run, await getRunManifest(run.id));
  assert.equal(sawProjectionContract, true);
  assert.equal(projection.normalizedEvents.length, 1);
  assert.equal(projection.normalizedEvents[0].type, 'status');
  assert.equal(projection.normalizedEvents[0].provider, 'codex');
  assert.equal(projection.normalizedEvents[0].runtimeFamily, 'codex-json');

  const recentActivityAt = new Date().toISOString();
  const activity = buildSessionActivity(
    { activeRunId: run.id },
    {},
    {
      runState: 'running',
      run: {
        id: run.id,
        state: 'running',
        startedAt: '2026-06-23T00:00:00.000Z',
        provider: 'codex',
        runtimeFamily: 'codex-json',
        providerCapabilities: record.providerCapabilities,
        permissionMode: 'full-access',
        effort: 'xhigh',
        thinking: false,
        reasoningEnabled: true,
        reasoningVisibility: 'collapsed',
        runnerHeartbeatAt: recentActivityAt,
        providerLastByteAt: recentActivityAt,
        providerLastSemanticEventAt: recentActivityAt,
        providerLastReasoningAt: recentActivityAt,
        lastVisibleActivityAt: recentActivityAt,
      },
      queuedCount: 0,
    },
  );
  assert.equal(activity.run.provider, 'codex');
  assert.equal(activity.run.runtimeFamily, 'codex-json');
  assert.equal(activity.run.providerCapabilities.permissionModel, 'codex-approval-sandbox');
  assert.equal(activity.run.permissionMode, 'full-access');
  assert.deepEqual(activity.run.reasoning, {
    enabled: true,
    effort: 'xhigh',
    visibility: 'collapsed',
  });
  assert.equal(activity.run.outputActivity.phase, 'active_reasoning');

  const steerQueueRun = await createRun({
    status: {
      sessionId: 'session_steer_queue_merge',
      requestId: 'req_steer_queue_merge',
      state: 'running',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
    },
    manifest: {
      sessionId: 'session_steer_queue_merge',
      requestId: 'req_steer_queue_merge',
      folder: '~',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      prompt: 'hi',
      options: { runtimeFamily: 'codex-app-server-json' },
    },
  });
  await updateRun(steerQueueRun.id, {
    appServerSteerQueue: [
      {
        id: 'steer-1',
        requestId: 'req-steer-1',
        text: 'steer now',
        state: 'pending',
        createdAt: '2026-06-23T00:00:00.000Z',
      },
    ],
  });
  await updateRun(steerQueueRun.id, {
    appServerSteerQueue: [
      {
        id: 'steer-1',
        requestId: 'req-steer-1',
        text: 'steer now',
        state: 'sent',
        createdAt: '2026-06-23T00:00:00.000Z',
        sentAt: '2026-06-23T00:00:01.000Z',
      },
    ],
  });
  await updateRun(steerQueueRun.id, {
    appServerTurnId: 'turn-stale-write',
    appServerSteerQueue: [
      {
        id: 'steer-1',
        requestId: 'req-steer-1',
        text: 'steer now',
        state: 'pending',
        createdAt: '2026-06-23T00:00:00.000Z',
      },
    ],
  });
  const mergedSteerQueueRun = await getRun(steerQueueRun.id);
  assert.equal(
    mergedSteerQueueRun.appServerSteerQueue?.[0]?.state,
    'sent',
    'stale run updates must not downgrade a sent app-server steer queue entry',
  );
  assert.equal(
    mergedSteerQueueRun.appServerSteerQueue?.[0]?.sentAt,
    '2026-06-23T00:00:01.000Z',
    'stale run updates must preserve app-server steer sentAt',
  );

  await updateRun(steerQueueRun.id, {
    state: 'running',
    approvedActionPending: { batchId: 'aab_contract' },
    actionPause: { kind: 'approved_action', batchId: 'aab_contract', state: 'waiting_user' },
  });
  assert.equal((await getRun(steerQueueRun.id)).state, 'waiting_user');
  await updateRun(steerQueueRun.id, (current) => {
    const next = { ...current, state: 'completed' };
    delete next.approvedActionPending;
    delete next.actionPause;
    return next;
  });
  assert.equal((await getRun(steerQueueRun.id)).state, 'completed');

  const usageRun = await createRun({
    status: {
      sessionId: 'session_usage_projection_contract',
      requestId: 'req_usage_projection_contract',
      state: 'completed',
      tool: 'codex',
      runtimeFamily: 'codex-json',
      codexThreadId: 'thread-metrics',
    },
    manifest: {
      sessionId: 'session_usage_projection_contract',
      requestId: 'req_usage_projection_contract',
      folder: '~',
      tool: 'codex',
      runtimeFamily: 'codex-json',
      prompt: 'hi',
      options: { runtimeFamily: 'codex-json' },
    },
  });
  await appendRunSpoolRecord(usageRun.id, {
    ts: '2026-06-23T00:00:01.000Z',
    stream: 'stdout',
    line: JSON.stringify({ type: 'turn.completed' }),
  });

  let metricsRequested = false;
  const usageService = createRunProjectionService({
    buildCodexContextMetricsPayload: (metrics) => ({
      type: 'ragent.context_metrics',
      contextTokens: metrics.contextTokens,
      contextWindowTokens: metrics.contextWindowTokens,
    }),
    clipPreview: (text) => String(text || ''),
    createToolInvocation: async (tool, _prompt, options = {}) => buildRuntimeInvocation(
      options.runtimeFamily,
      '',
      {},
      tool,
    ),
    materializeRunSpoolLine,
    normalizeRunEvents: (projectionRun, events) => events.map((event) => ({
      ...event,
      runId: projectionRun.id,
      provider: event.provider || projectionRun.provider,
      runtimeFamily: event.runtimeFamily || projectionRun.runtimeFamily,
    })),
    readLatestCodexSessionMetrics: async (threadId) => {
      metricsRequested = true;
      assert.equal(threadId, 'thread-metrics');
      return { contextTokens: 123, contextWindowTokens: 456 };
    },
    readRunSpoolDelta,
    readRunSpoolRecords,
  });
  const usageProjection = await usageService.collectNormalizedRunEvents(usageRun, await getRunManifest(usageRun.id));
  assert.equal(metricsRequested, true);
  assert.equal(usageProjection.normalizedEvents.some((event) =>
    event.type === 'usage'
    && event.contextTokens === 123
    && event.contextWindowTokens === 456
    && event.runtimeFamily === 'codex-json'
  ), true);

  const appServerRun = await createRun({
    status: {
      sessionId: 'session_app_server_projection_contract',
      requestId: 'req_app_server_projection_contract',
      state: 'completed',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      codexThreadId: 'thread-app-server',
    },
    manifest: {
      sessionId: 'session_app_server_projection_contract',
      requestId: 'req_app_server_projection_contract',
      folder: '~',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      prompt: 'hi',
      options: { runtimeFamily: 'codex-app-server-json' },
    },
  });
  await appendRunSpoolRecord(appServerRun.id, {
    ts: '2026-06-23T00:00:02.000Z',
    stream: 'stdout',
    line: JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-app-server',
        turn: { id: 'turn-app-server', status: 'completed' },
      },
    }),
  });
  const appServerService = createRunProjectionService({
    buildCodexContextMetricsPayload: () => {
      throw new Error('app-server should not request external metrics payloads');
    },
    clipPreview: (text) => String(text || ''),
    createToolInvocation: async (tool, _prompt, options = {}) => buildRuntimeInvocation(
      options.runtimeFamily,
      '',
      {},
      tool,
    ),
    materializeRunSpoolLine,
    normalizeRunEvents: (projectionRun, events) => {
      assert.equal(projectionRun.runtimeFamily, 'codex-app-server-json');
      assert.equal(projectionRun.providerCapabilities.supportsExternalUsageProjection, false);
      return events.map((event) => ({
        ...event,
        runId: projectionRun.id,
        provider: event.provider || projectionRun.provider,
        runtimeFamily: event.runtimeFamily || projectionRun.runtimeFamily,
      }));
    },
    readLatestCodexSessionMetrics: async () => {
      throw new Error('app-server should not read Codex CLI session metrics');
    },
    readRunSpoolDelta,
    readRunSpoolRecords,
  });
  const appServerProjection = await appServerService.collectNormalizedRunEvents(
    appServerRun,
    await getRunManifest(appServerRun.id),
  );
  assert.equal(appServerProjection.normalizedEvents.some((event) => event.runtimeFamily === 'codex-app-server-json'), true);

  console.log('test-run-provider-contract: ok');
} finally {
  if (previousEnv.RAGENT_INSTANCE_ROOT === undefined) delete process.env.RAGENT_INSTANCE_ROOT;
  else process.env.RAGENT_INSTANCE_ROOT = previousEnv.RAGENT_INSTANCE_ROOT;
  if (previousEnv.RAGENT_CONFIG_DIR === undefined) delete process.env.RAGENT_CONFIG_DIR;
  else process.env.RAGENT_CONFIG_DIR = previousEnv.RAGENT_CONFIG_DIR;
  if (previousEnv.RAGENT_WORK_ROOT_DIR === undefined) delete process.env.RAGENT_WORK_ROOT_DIR;
  else process.env.RAGENT_WORK_ROOT_DIR = previousEnv.RAGENT_WORK_ROOT_DIR;
  rmSync(home, { recursive: true, force: true });
}
