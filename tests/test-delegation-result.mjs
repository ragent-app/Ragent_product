#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildDelegationResultFromRun,
  extractDelegationResult,
  projectDelegationResults,
  resultPacketPrompt,
} from '../chat/delegation-result.mjs';

const tagged = '<ragent-result-packet>{"state":"completed","summary":"implemented bounded handoff","changedFiles":["chat/example.mjs"],"tests":[{"name":"unit","status":"passed","evidence":"node test.mjs"}],"acceptanceNotes":["criterion met"]}</ragent-result-packet>';
assert.equal(extractDelegationResult(tagged).summary, 'implemented bounded handoff');

const packet = buildDelegationResultFromRun({
  session: { id: 'child-1' },
  run: { id: 'run-1', state: 'completed' },
  result: { exitCode: 0 },
  history: [{ type: 'message', role: 'assistant', runId: 'run-1', content: tagged }],
});
assert.equal(packet.schemaVersion, 1);
assert.equal(packet.state, 'completed');
assert.equal(packet.childSessionId, 'child-1');
assert.equal(packet.runId, 'run-1');
assert.deepEqual(packet.changedFiles, ['chat/example.mjs']);

const projection = projectDelegationResults([
  { type: 'context_operation', operation: 'delegation_result', childSessionId: 'child-1', runId: 'run-1', resultPacket: packet },
  { type: 'context_operation', operation: 'delegation_result', childSessionId: 'child-1', runId: 'run-1', resultPacket: { ...packet, summary: 'duplicate' } },
], 2);
assert.equal(projection.total, 2);
assert.equal(projection.active, 1);
assert.equal(projection.completed, 1);
assert.equal(projection.results.length, 1);
assert.match(resultPacketPrompt({ role: 'reviewer' }), /ragent-result-packet/);
assert.match(resultPacketPrompt({ role: 'reviewer' }), /role is reviewer/);

console.log('test-delegation-result: ok');
