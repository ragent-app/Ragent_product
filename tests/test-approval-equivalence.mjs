import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approvalEquivalenceKey, equivalentPendingApprovals } from '../chat/approval-equivalence.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-approval-group-'));
const instance = path.join(root, 'instance'); const workspace = path.join(instance, 'workspace');
await mkdir(workspace, { recursive: true });
process.env.AGENTOC_INSTANCE_ROOT = instance;
process.env.AGENTOC_CONFIG_DIR = path.join(instance, 'config');
process.env.AGENTOC_WORK_ROOT_DIR = workspace;
process.env.AGENTOC_MEMORY_DIR = path.join(instance, 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = path.join(instance, 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(instance, 'data', 'chat-runs');
const { createCodexAppServerAdapter } = await import('../chat/adapters/codex-app-server.mjs');
const { createRunProjectionService } = await import('../chat/run-projection.mjs');

const method = 'item/commandExecution/requestApproval';
const record = (id, overrides = {}) => ({ approvalId: `${method}:${id}`, providerMethod: method,
  providerRequestId: id, kind: 'command', state: 'pending', riskTier: 'unknown',
  params: { threadId: 'thread', turnId: 'turn', itemId: `item-${id}`, cwd: 'C:\\workspace', command: 'dangerous command', ...overrides } });
const a = record(1); const b = record(2); const c = record(3, { cwd: 'C:\\other' });
assert.ok(approvalEquivalenceKey(a));
assert.equal(approvalEquivalenceKey(a), approvalEquivalenceKey(b));
assert.notEqual(approvalEquivalenceKey(a), approvalEquivalenceKey(c));
assert.notEqual(approvalEquivalenceKey(a), approvalEquivalenceKey(record(4, { turnId: 'other' })));
assert.equal(approvalEquivalenceKey(record(5, { additionalPermissions: { network: true } })), '');
assert.equal(approvalEquivalenceKey(record(5, { grantRoot: 'C:\\workspace' })), '');
assert.equal(approvalEquivalenceKey(record(5, { proposedExecpolicyAmendment: ['git'] })), '');
assert.notEqual(approvalEquivalenceKey(a), approvalEquivalenceKey({ ...b, riskPolicyVersion: 'different' }));
assert.equal(approvalEquivalenceKey({ ...a, state: 'responded' }), '');
assert.equal(approvalEquivalenceKey({ ...a, riskTier: 'safe' }), '');
assert.equal(approvalEquivalenceKey({ ...a, params: { ...a.params, cwd: '.' } }), '');
assert.deepEqual(equivalentPendingApprovals({ appServerPendingApprovals: [a, b, c] }, a.approvalId).map(x => x.approvalId), [a.approvalId, b.approvalId]);
assert.deepEqual(equivalentPendingApprovals({ appServerPendingApprovals: [a, b], appServerApprovalResponseQueue: [{ approvalId: a.approvalId }] }, b.approvalId).map(x => x.approvalId), [b.approvalId]);

let frames = [a, b, c].map(entry => ({ id: entry.providerRequestId, method, params: entry.params }));
const service = createRunProjectionService({
  buildCodexContextMetricsPayload: () => null, clipPreview: value => String(value || ''),
  createToolInvocation: async () => ({ provider: 'codex', runtimeFamily: 'codex-app-server-json', capabilities: [], adapter: createCodexAppServerAdapter() }),
  materializeRunSpoolLine: async (_id, value) => JSON.stringify(value.json),
  normalizeRunEvents: (_run, events) => events, readLatestCodexSessionMetrics: async () => null,
  readRunSpoolRecords: async () => frames.map(json => ({ stream: 'stdout', json })),
  readRunSpoolDelta: async () => ({ records: frames.map(json => ({ stream: 'stdout', json })), nextOffset: frames.length, processedLineCount: frames.length, skippedLineCount: 0 }),
});
const projected = await service.collectNormalizedRunEventDelta({ id: 'group-fixture', sessionId: 's', runtimeFamily: 'codex-app-server-json',
  approvalSuppressionSeeded: true, appServerPendingApprovals: [a, b, c] }, { tool: 'codex', options: { runtimeFamily: 'codex-app-server-json' } });
assert.deepEqual(projected.normalizedEvents.filter(event => event.type === 'approval_request').map(event => event.approvalId), [a.approvalId, c.approvalId]);
assert.equal(projected.normalizedEventCount, 3, 'suppressed cards must retain their terminal replay cursor position');
const terminal = await service.collectNormalizedRunEvents({ id: 'group-fixture', sessionId: 's', state: 'completed', runtimeFamily: 'codex-app-server-json',
  appServerPendingApprovals: [a, b, c].map(item => ({ ...item, state: 'responded' })) },
  { tool: 'codex', options: { runtimeFamily: 'codex-app-server-json' } }, { skipNormalizedEvents: 3 });
assert.equal(terminal.normalizedEventCount, 3);
assert.equal(terminal.normalizedEvents.length, 0, 'terminal replay must skip the same number of original events');
frames = [{ id: b.providerRequestId, method, params: b.params }];
const missingLeader = await service.collectNormalizedRunEventDelta({ id: 'group-missing-leader', sessionId: 's', runtimeFamily: 'codex-app-server-json',
  approvalSuppressionSeeded: true, appServerPendingApprovals: [a, b] }, { tool: 'codex', options: { runtimeFamily: 'codex-app-server-json' } });
assert.deepEqual(missingLeader.normalizedEvents.filter(event => event.type === 'approval_request').map(event => event.approvalId), [b.approvalId],
  'a stale or unseen leader must never hide the only visible request');
const previouslyPresented = await service.collectNormalizedRunEventDelta({ id: 'group-separate-tick', sessionId: 's', runtimeFamily: 'codex-app-server-json',
  approvalSuppressionSeeded: true, appServerPendingApprovals: [{ ...a, approvalPresented: true }, b] },
  { tool: 'codex', options: { runtimeFamily: 'codex-app-server-json' } });
assert.equal(previouslyPresented.normalizedEvents.filter(event => event.type === 'approval_request').length, 0,
  'a matching request can reuse a leader already persisted in history');
assert.equal(previouslyPresented.normalizedEventCount, 1, 'cross-tick suppression must retain the original cursor position');

const { appendRunSpoolRecord, createRun, getRun, updateRun } = await import('../chat/runs.mjs');
const { createSession, getHistory, submitRuntimeApproval } = await import('../chat/session-manager.mjs');
const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const run = await createRun({ status: { sessionId: 'group-fixture', requestId: 'group-turn', state: 'running', tool: 'codex', runtimeFamily: 'codex-app-server-json' },
  manifest: { sessionId: 'group-fixture', requestId: 'group-turn', folder: workspace, tool: 'codex', runtimeFamily: 'codex-app-server-json', prompt: 'fixture', options: {} } });
await updateRun(run.id, current => ({ ...current, appServerPendingApprovals: [a, b, c] }));
await submitRuntimeApproval(run.id, a.approvalId, { decision: 'deny', requestId: 'owner-decision' });
let saved = await getRun(run.id);
assert.deepEqual(saved.appServerApprovalResponseQueue.map(entry => [entry.approvalId, entry.decision]), [[a.approvalId, 'deny'], [b.approvalId, 'deny']]);
const { buildCodexAppServerApprovalResponseMessage } = await import('../chat/codex-app-server-protocol.mjs');
assert.deepEqual(saved.appServerApprovalResponseQueue.map(entry => {
  const original = saved.appServerPendingApprovals.find(item => item.approvalId === entry.approvalId);
  return buildCodexAppServerApprovalResponseMessage(original, entry.decision);
}), [{ id: 1, result: { decision: 'decline' } }, { id: 2, result: { decision: 'decline' } }]);
await updateRun(run.id, current => ({ ...current, appServerPendingApprovals: [...current.appServerPendingApprovals, record(6)] }));
await submitRuntimeApproval(run.id, record(6).approvalId, { decision: 'approve', requestId: 'later-decision' });
saved = await getRun(run.id);
assert.equal(saved.appServerApprovalResponseQueue.length, 3);
assert.equal(saved.appServerApprovalResponseQueue[2].approvalId, record(6).approvalId);
assert.equal(saved.appServerApprovalResponseQueue[2].decision, 'approve');
const racing = await createRun({ status: { sessionId: 'group-race', requestId: 'group-race-turn', state: 'running', tool: 'codex', runtimeFamily: 'codex-app-server-json' },
  manifest: { sessionId: 'group-race', requestId: 'group-race-turn', folder: workspace, tool: 'codex', runtimeFamily: 'codex-app-server-json', prompt: 'fixture', options: {} } });
await updateRun(racing.id, current => ({ ...current, appServerPendingApprovals: [a, b] }));
await Promise.all([submitRuntimeApproval(racing.id, a.approvalId, { decision: 'deny' }),
  submitRuntimeApproval(racing.id, b.approvalId, { decision: 'approve' })]);
const raced = (await getRun(racing.id)).appServerApprovalResponseQueue;
assert.equal(raced.length, 2, 'each provider request receives at most one decision');
assert.equal(new Set(raced.map(entry => entry.approvalId)).size, 2);
assert.equal(new Set(raced.map(entry => entry.decision)).size, 1, 'one atomic group decision wins');
const liveSession = await createSession(workspace, 'codex', 'approval-group-live');
const liveRun = await createRun({ status: { sessionId: liveSession.id, requestId: 'live-turn', state: 'running', tool: 'codex', runtimeFamily: 'codex-app-server-json' },
  manifest: { sessionId: liveSession.id, requestId: 'live-turn', folder: workspace, tool: 'codex', runtimeFamily: 'codex-app-server-json', prompt: 'fixture', options: {} } });
await mutateSessionMeta(liveSession.id, draft => { draft.activeRunId = liveRun.id; return true; });
await updateRun(liveRun.id, current => ({ ...current, appServerPendingApprovals: [a] }));
await appendRunSpoolRecord(liveRun.id, { stream: 'stdout', json: { id: 1, method, params: a.params } });
let history = await getHistory(liveSession.id);
assert.equal(history.filter(event => event.type === 'approval_request').length, 1);
assert.equal((await getRun(liveRun.id)).appServerPendingApprovals[0].approvalPresented, true,
  'only a request persisted to session history can lead a cross-tick group');
await updateRun(liveRun.id, current => ({ ...current, appServerPendingApprovals: [...current.appServerPendingApprovals, b] }));
await appendRunSpoolRecord(liveRun.id, { stream: 'stdout', json: { id: 2, method, params: b.params } });
history = await getHistory(liveSession.id);
assert.equal(history.filter(event => event.type === 'approval_request').length, 1,
  'a later identical request reuses the already persisted card');
assert.equal((await getRun(liveRun.id)).normalizedEventCount, 2,
  'the durable cursor still counts the suppressed event');
await submitRuntimeApproval(liveRun.id, a.approvalId, { decision: 'deny' });
assert.equal((await getRun(liveRun.id)).appServerApprovalResponseQueue.length, 2);
await updateRun(liveRun.id, current => ({ ...current, state: 'completed',
  appServerPendingApprovals: current.appServerPendingApprovals.map(item => ({ ...item, state: 'responded' })) }));
history = await getHistory(liveSession.id);
assert.equal(history.filter(event => event.type === 'approval_request').length, 1,
  'terminal replay must not resurrect the grouped card');
await updateRun(run.id, current => ({ ...current, state: 'completed' }));
await updateRun(racing.id, current => ({ ...current, state: 'completed' }));
// Let the real run observer notice the terminal state before its fixture is removed.
await new Promise(resolve => setTimeout(resolve, 1000));
const actualRoot = await realpath(root); const actualTemp = await realpath(os.tmpdir());
assert.equal(path.dirname(actualRoot).toLowerCase(), actualTemp.toLowerCase());
assert.ok(path.basename(actualRoot).startsWith('agentoc-approval-group-'));
await rm(actualRoot, { recursive: true, force: true });
console.log('approval-equivalence: scoped projection and per-request decision queues passed');
