import assert from 'node:assert/strict';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';
import { createRunProjectionService } from '../chat/run-projection.mjs';

const request = id => ({ type: 'control_request', request_id: id,
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'unrecognized fixture' } } });
const frames = [request('held'), request('different')];
const service = createRunProjectionService({
  buildCodexContextMetricsPayload: () => null,
  clipPreview: value => String(value || ''),
  createToolInvocation: async (tool, _prompt, options) => buildRuntimeInvocation(options.runtimeFamily, '', {}, tool),
  materializeRunSpoolLine: async (_runId, record) => record.line,
  normalizeRunEvents: (_run, events) => events,
  readLatestCodexSessionMetrics: async () => null,
  readRunSpoolRecords: async () => [],
  readRunSpoolDelta: async () => ({ records: frames.map(json => ({ stream: 'stdout', json, line: JSON.stringify(json) })), nextOffset: 1, processedLineCount: frames.length, skippedLineCount: 0 }),
});
const run = { id: 'fixture-reasons', sessionId: 'fixture-session', provider: 'claude', runtimeFamily: 'claude-stream-json-bidi',
  approvalSuppressionSeeded: true, appServerPendingApprovals: [{ approvalId: 'claude:held', riskTier: 'unknown',
    riskPolicyVersion: 'windows-approval/v3', riskReasonCodes: ['windows_syntax_unsupported'] }] };
const manifest = { tool: 'claude-bidi', runtimeFamily: 'claude-stream-json-bidi', options: {} };
const projection = await service.collectNormalizedRunEventDelta(run, manifest);
assert.equal(projection.normalizedEvents.filter(event => event.type === 'approval_request').length, 2);
const counters = service.getApprovalSuppressionCounters(run.id);
assert.equal(counters.presentedToOwner, 2);
assert.equal(counters.byReasonCode.windows_syntax_unsupported.presentedToOwner, 1,
  'held requests must use the actual run-bound gate reason, not a generic reclassification');
assert.equal(counters.byRiskTier.unknown.presentedToOwner, 1);
assert.equal(counters.byPolicyVersion['windows-approval/v3'].presentedToOwner, 1);
console.log('run-projection-windows-approval-reasons: exact request risk and per-run metrics passed');
