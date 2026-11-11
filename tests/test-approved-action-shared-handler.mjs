import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { actionTool, agentCreateTool, handleRequest } from '../scripts/agentoc-approved-actions-mcp.mjs';
import { codexApprovedActionTools, handleCodexApprovedActionCall } from '../chat/codex-approved-action-dynamic-tools.mjs';

// Both calls use the same imported handler, but distinct run-bound credentials.
// Responses arrive out of order to detect accidental process-global state.
const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    received.push({ token: req.headers['x-agentoc-approved-action-token'], payload });
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ batchId: `batch-${payload.runId}`, actions: [] }));
    }, payload.runId === 'run-a' ? 50 : 1);
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const endpoint = `http://127.0.0.1:${server.address().port}/propose`;
  const config = name => ({ enabled: true, agentCreateEnabled: true, endpoint, token: `token-${name}`, sessionId: `session-${name}`, runId: `run-${name}`, turnId: `turn-${name}`, cwd: '', projectRoot: '' });
  const request = name => ({ id: name, method: 'tools/call', params: { name: 'agentoc_request_actions', arguments: { actions: [{ command: `operation-${name}` }] } } });
  const [a, b] = await Promise.all([handleRequest(request('a'), config('a')), handleRequest(request('b'), config('b'))]);
  assert.equal(JSON.parse(a.result.content[0].text).batchId, 'batch-run-a');
  assert.equal(JSON.parse(b.result.content[0].text).batchId, 'batch-run-b');
  for (const name of ['a', 'b']) {
    const entry = received.find(item => item.payload.runId === `run-${name}`);
    assert.equal(entry.token, `token-${name}`);
    assert.equal(entry.payload.sessionId, `session-${name}`);
    assert.equal(entry.payload.turnId, `turn-${name}`);
    assert.equal(entry.payload.actions[0].command, `operation-${name}`);
  }
  assert.equal(actionTool().name, 'agentoc_request_actions');
  assert.equal(agentCreateTool().name, 'agentoc_create_agent');
  const denied = await handleRequest(request('a'), { ...config('a'), enabled: false });
  assert.equal(denied.result.isError, true);
  assert.deepEqual(codexApprovedActionTools(config('a')).map(tool => tool.name), ['agentoc_request_actions', 'agentoc_create_agent']);
  const call = { id: 'server-request', method: 'item/tool/call', params: { threadId: 'codex-thread-a', turnId: 'codex-turn-a', callId: 'call-a', tool: 'agentoc_request_actions', arguments: { actions: [{ command: 'operation-a' }] } } };
  const binding = { active: true, threadId: 'codex-thread-a', turnId: 'codex-turn-a', config: config('a') };
  const response = await handleCodexApprovedActionCall(call, binding);
  assert.equal(response.result.success, true);
  assert.equal(JSON.parse(response.result.contentItems[0].text).batchId, 'batch-run-a');
  for (const badBinding of [{ ...binding, threadId: 'other' }, { ...binding, turnId: 'other' }, { ...binding, active: false }]) {
    assert.equal((await handleCodexApprovedActionCall(call, badBinding)).error.code, -32003);
  }
  assert.equal((await handleCodexApprovedActionCall({ ...call, params: { ...call.params, namespace: 'other' } }, binding)).error.code, -32003);
  console.log('test-approved-action-shared-handler: concurrent calls retain run bindings');
} finally {
  await new Promise(resolve => server.close(resolve));
}
