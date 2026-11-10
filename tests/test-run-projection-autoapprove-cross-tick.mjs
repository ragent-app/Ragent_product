#!/usr/bin/env node
// Auto-approval suppression across observer ticks (2026-08-08 regression):
// the claude-bidi adapter keeps its autoApproved id Set per instance, and the
// delta projection used to create a fresh adapter on every tick. The sidecar
// writes the autoApproved echo ~1-3s before the control_request it answers,
// while the observer ticks every 250ms-1s — so echo and request routinely
// landed in different ticks and the auto-approved request popped a card.
// Regression for: f43b83d8 ran 177 approval_request events in one day while
// every tool was auto-approved (23 responses), flooding cards and popups.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-autoapprove-cross-tick-'));
const previousEnv = {
  HOME: process.env.HOME,
  AGENTOC_INSTANCE_ROOT: process.env.AGENTOC_INSTANCE_ROOT,
  AGENTOC_CONFIG_DIR: process.env.AGENTOC_CONFIG_DIR,
  AGENTOC_MEMORY_DIR: process.env.AGENTOC_MEMORY_DIR,
  AGENTOC_WORK_ROOT_DIR: process.env.AGENTOC_WORK_ROOT_DIR,
  AGENTOC_PROVIDER_HOMES_DIR: process.env.AGENTOC_PROVIDER_HOMES_DIR,
};

process.env.HOME = home;
process.env.AGENTOC_INSTANCE_ROOT = join(home, 'instance');
process.env.AGENTOC_CONFIG_DIR = join(home, 'instance', 'config');
process.env.AGENTOC_MEMORY_DIR = join(home, 'instance', 'memory');
process.env.AGENTOC_WORK_ROOT_DIR = join(home, 'instance', 'workspace');
process.env.AGENTOC_PROVIDER_HOMES_DIR = join(home, 'instance', 'provider-homes');

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

try {
  const { buildRuntimeInvocation } = await import('../chat/process-runner.mjs');
  const { createRunProjectionService } = await import('../chat/run-projection.mjs');
  const {
    appendRunSpoolRecord,
    createRun,
    getRun,
    getRunManifest,
    materializeRunSpoolLine,
    readRunSpoolDelta,
    readRunSpoolRecords,
    updateRun,
  } = await import('../chat/runs.mjs');

  function buildService() {
    return createRunProjectionService({
      buildCodexContextMetricsPayload: () => null,
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
      readLatestCodexSessionMetrics: async () => null,
      readRunSpoolDelta,
      readRunSpoolRecords,
    });
  }

  const run = await createRun({
    status: {
      sessionId: 'session_cross_tick',
      requestId: 'req_cross_tick',
      state: 'accepted',
      tool: 'claude-bidi',
    },
    manifest: {
      sessionId: 'session_cross_tick',
      requestId: 'req_cross_tick',
      folder: '~',
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
      prompt: 'hi',
      options: { runtimeFamily: 'claude-stream-json-bidi' },
    },
  });

  const echo = {
    type: 'agentoc.approval_response',
    approvalId: 'claude:cross-tick-1',
    decision: 'approved',
    status: 'approved',
    providerRequestId: 'cross-tick-1',
    providerMethod: 'can_use_tool',
    autoApproved: true,
  };
  const request = {
    type: 'control_request',
    request_id: 'cross-tick-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'ls -la' },
    },
  };

  const service = buildService();

  // Tick 1: only the autoApproved echo arrives.
  await appendRunSpoolRecord(run.id, {
    ts: '2026-08-08T11:15:07.084Z',
    stream: 'stdout',
    line: JSON.stringify(echo),
    json: echo,
  });
  let projection = await service.collectNormalizedRunEventDelta(run, await getRunManifest(run.id));
  assert.equal(projection.normalizedEvents.filter((e) => e.type === 'approval_request').length, 0,
    'the echo itself must not project an approval');
  await updateRun(run.id, (current) => ({
    ...current,
    normalizedByteOffset: projection.nextOffset,
    normalizedLineCount: (current.normalizedLineCount || 0) + projection.processedLineCount,
  }));

  // Tick 2: the request it answers arrives in a LATER tick — the same service
  // instance must still remember the id and suppress it. (Pre-fix: fresh
  // adapter per tick → 1 approval_request → card + push.)
  await appendRunSpoolRecord(run.id, {
    ts: '2026-08-08T11:15:09.300Z',
    stream: 'stdout',
    line: JSON.stringify(request),
    json: request,
  });
  projection = await service.collectNormalizedRunEventDelta(
    await getRun(run.id),
    await getRunManifest(run.id),
  );
  assert.equal(projection.normalizedEvents.filter((e) => e.type === 'approval_request').length, 0,
    'auto-approved request in a later tick must stay suppressed');
  await updateRun(run.id, (current) => ({
    ...current,
    normalizedByteOffset: projection.nextOffset,
    normalizedLineCount: (current.normalizedLineCount || 0) + projection.processedLineCount,
  }));

  // A genuinely held request (no echo) still surfaces — suppression must not
  // eat real user-facing approvals.
  const held = {
    type: 'control_request',
    request_id: 'cross-tick-held-2',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'rm -rf /tmp/probe' },
    },
  };
  await appendRunSpoolRecord(run.id, {
    ts: '2026-08-08T11:15:20.000Z',
    stream: 'stdout',
    line: JSON.stringify(held),
    json: held,
  });
  projection = await service.collectNormalizedRunEventDelta(
    await getRun(run.id),
    await getRunManifest(run.id),
  );
  assert.equal(projection.normalizedEvents.filter((e) => e.type === 'approval_request').length, 1,
    'held requests without an echo must still project');
  assert.equal(projection.normalizedEvents.find((e) => e.type === 'approval_request')?.approvalId,
    'claude:cross-tick-held-2');

  // Restart mid-run: a BRAND-NEW service instance must seed the suppression set
  // from echoes already in the spool, so a request arriving after the restart
  // is still suppressed.
  const echo2 = { ...echo, approvalId: 'claude:cross-tick-3', providerRequestId: 'cross-tick-3' };
  await appendRunSpoolRecord(run.id, {
    ts: '2026-08-08T11:16:00.000Z',
    stream: 'stdout',
    line: JSON.stringify(echo2),
    json: echo2,
  });
  await updateRun(run.id, (current) => ({
    ...current,
    normalizedByteOffset: projection.nextOffset,
    normalizedLineCount: (current.normalizedLineCount || 0) + projection.processedLineCount,
  }));
  const serviceAfterRestart = buildService(); // fresh cache, like a new process
  projection = await serviceAfterRestart.collectNormalizedRunEventDelta(
    await getRun(run.id),
    await getRunManifest(run.id),
  );
  assert.equal(projection.normalizedEvents.filter((e) => e.type === 'approval_request').length, 0,
    'echo-only tick after restart must stay clean');
  // Persist like the production observer does on every tick; without this the
  // next tick would re-read the echo from the stale offset and double-count.
  await updateRun(run.id, (current) => ({
    ...current,
    normalizedByteOffset: projection.nextOffset,
    normalizedLineCount: (current.normalizedLineCount || 0) + projection.processedLineCount,
  }));
  const request3 = { ...request, request_id: 'cross-tick-3' };
  await appendRunSpoolRecord(run.id, {
    ts: '2026-08-08T11:16:05.000Z',
    stream: 'stdout',
    line: JSON.stringify(request3),
    json: request3,
  });
  projection = await serviceAfterRestart.collectNormalizedRunEventDelta(
    await getRun(run.id),
    await getRunManifest(run.id),
  );
  assert.equal(projection.normalizedEvents.filter((e) => e.type === 'approval_request').length, 0,
    'request after restart must be suppressed via seeded set');
  await updateRun(run.id, (current) => ({
    ...current,
    normalizedByteOffset: projection.nextOffset,
    normalizedLineCount: (current.normalizedLineCount || 0) + projection.processedLineCount,
  }));

  const denialEcho = {
    ...echo,
    approvalId: 'claude:cross-tick-denied-4',
    providerRequestId: 'cross-tick-denied-4',
    decision: 'denied', status: 'denied', autoApproved: false, autoDenied: true,
  };
  await appendRunSpoolRecord(run.id, {
    ts: '2026-08-08T11:16:10.000Z', stream: 'stdout',
    line: JSON.stringify(denialEcho), json: denialEcho,
  });
  projection = await serviceAfterRestart.collectNormalizedRunEventDelta(
    await getRun(run.id), await getRunManifest(run.id),
  );
  assert.equal(projection.normalizedEvents.filter((e) => e.type === 'approval_request').length, 0);
  await updateRun(run.id, (current) => ({
    ...current,
    normalizedByteOffset: projection.nextOffset,
    normalizedLineCount: (current.normalizedLineCount || 0) + projection.processedLineCount,
  }));
  const deniedRequest = { ...request, request_id: 'cross-tick-denied-4' };
  await appendRunSpoolRecord(run.id, {
    ts: '2026-08-08T11:16:11.000Z', stream: 'stdout',
    line: JSON.stringify(deniedRequest), json: deniedRequest,
  });
  projection = await serviceAfterRestart.collectNormalizedRunEventDelta(
    await getRun(run.id), await getRunManifest(run.id),
  );
  assert.equal(projection.normalizedEvents.filter((e) => e.type === 'approval_request').length, 0,
    'automatic denial in a later observer tick must not create an owner card');

  // The same metric contract must work for Codex app-server frames. This
  // fixture uses a safe auto-approved command so provider/tier/reason buckets
  // can be compared directly with Claude's auto-approved request above.
  const codexRun = await createRun({
    status: {
      sessionId: 'session_codex_metrics',
      requestId: 'req_codex_metrics',
      state: 'accepted',
      tool: 'codex',
    },
    manifest: {
      sessionId: 'session_codex_metrics',
      requestId: 'req_codex_metrics',
      folder: '~',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      prompt: 'hi',
      options: { runtimeFamily: 'codex-app-server-json' },
    },
  });
  const codexEcho = {
    type: 'agentoc.approval_response',
    approvalId: 'item/commandExecution/requestApproval:42',
    provider: 'codex',
    decision: 'approved',
    status: 'approved',
    providerRequestId: '42',
    providerMethod: 'item/commandExecution/requestApproval',
    autoApproved: true,
    riskTier: 'safe',
    riskPolicyVersion: 'risk-v3',
    riskReasonCodes: ['ordinary_command'],
  };
  const codexRequest = {
    method: 'item/commandExecution/requestApproval',
    id: 42,
    params: { command: 'ls -la' },
  };
  await appendRunSpoolRecord(codexRun.id, {
    ts: '2026-08-08T11:17:00.000Z',
    stream: 'stdout',
    line: JSON.stringify(codexEcho),
    json: codexEcho,
  });
  await appendRunSpoolRecord(codexRun.id, {
    ts: '2026-08-08T11:17:01.000Z',
    stream: 'stdout',
    line: JSON.stringify(codexRequest),
    json: codexRequest,
  });
  const codexProjection = await service.collectNormalizedRunEventDelta(
    await getRun(codexRun.id),
    await getRunManifest(codexRun.id),
  );
  assert.equal(codexProjection.normalizedEvents.filter((e) => e.type === 'approval_request').length, 0,
    'Codex auto-approved request must stay suppressed');

  // releaseRunRuntimeInvocation is exposed for observer teardown.
  assert.equal(typeof serviceAfterRestart.releaseRunRuntimeInvocation, 'function');
  serviceAfterRestart.releaseRunRuntimeInvocation(run.id);

  // Approval suppression observability: echoes seen, requests seen, and how
  // many of those requests actually projected. With suppression working,
  // suppressed (requestsSeen - projected) covers every auto-approved request.
  // Counters are per service instance, so sum both (the "restart" instance
  // re-seeded from spool and processed the second pair).
  const sum = (fn) => fn(service) + fn(serviceAfterRestart);
  assert.equal(sum((s) => s.getApprovalSuppressionCounters().echoes), 4,
    'Claude and Codex autoApproved echoes must be counted');
  assert.equal(sum((s) => s.getApprovalSuppressionCounters().requestsSeen), 5,
    'all Claude and Codex approval requests must be counted');
  assert.equal(sum((s) => s.getApprovalSuppressionCounters().projected), 1,
    'only the held request may project');
  assert.equal(sum((s) => s.getApprovalSuppressionCounters().suppressed), 4,
    'all three auto-approved requests must count as suppressed');

  const serviceMetrics = service.getApprovalSuppressionCounters();
  const restartMetrics = serviceAfterRestart.getApprovalSuppressionCounters();
  assert.equal(serviceMetrics.byProvider.claude.received, 2,
    'Claude live tick should record both received requests');
  assert.equal(restartMetrics.byProvider.claude.received, 2,
    'Claude restart tick should record the replayed request');
  assert.equal(serviceMetrics.byProvider.codex.received, 1,
    'Codex request should use the same provider bucket');
  assert.equal(serviceMetrics.byProvider.codex.autoAllowed, 1,
    'Codex auto-approval should use the autoAllowed metric');
  assert.equal(restartMetrics.byProvider.claude.autoDenied, 1,
    'unattended denial must be counted separately from owner denial');
  assert.equal(serviceMetrics.byProvider.codex.suppressed, 1,
    'Codex suppressed request should be dimensioned');
  assert.equal(serviceMetrics.byProvider.codex.projected, 0,
    'Codex auto-approved request must not be projected');
  assert.equal(serviceMetrics.byRiskTier.safe.autoAllowed, 1,
    'safe auto-approval should be counted by risk tier');
  assert.equal(serviceMetrics.byReasonCode.ordinary_command.autoAllowed, 1,
    'auto-approval should be counted by reason code');

  const claudeRunMetrics = service.getApprovalSuppressionCounters(run.id);
  const codexRunMetrics = service.getApprovalSuppressionCounters(codexRun.id);
  assert.ok(claudeRunMetrics.byProvider.claude,
    'Claude metrics should be available for their Run');
  assert.equal(claudeRunMetrics.byProvider.codex, undefined,
    'Claude Run metrics must not include another provider Run');
  assert.ok(codexRunMetrics.byProvider.codex,
    'Codex metrics should be available for their Run');
  assert.equal(codexRunMetrics.byProvider.claude, undefined,
    'Codex Run metrics must not include another provider Run');
  assert.equal(codexRunMetrics.byPolicyVersion['risk-v3']?.autoAllowed, 1,
    'Codex Run metrics should retain the policy version that auto-approved it');
  assert.equal(service.getApprovalSuppressionCounters('missing-run').requestsSeen,
    serviceMetrics.requestsSeen,
    'unknown Run ids should fall back to the service-level aggregate');

  console.log('test-run-projection-autoapprove-cross-tick: ok');
} catch (error) {
  console.error('test-run-projection-autoapprove-cross-tick: FAILED');
  console.error(error);
  process.exitCode = 1;
} finally {
  restoreEnv();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}
