import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBrokerTurnActivity } from '../chat/codex-broker-turn-activity.mjs';

test('a disconnected client does not make its in-flight turn idle', () => {
  const activity = createCodexBrokerTurnActivity();
  assert.equal(activity.isIdle(), true);
  activity.startRequest({ id: 1, method: 'turn/start', params: { threadId: 'a' } });
  assert.equal(activity.isIdle(), false);
  activity.upstream({ id: 1, result: {} });
  activity.upstream({ method: 'turn/started', params: { threadId: 'a' } });
  assert.equal(activity.isIdle(), false);
  activity.upstream({ method: 'turn/completed', params: { threadId: 'a' } });
  assert.equal(activity.isIdle(), true);
});

test('a rejected duplicate start cannot erase an active turn', () => {
  const activity = createCodexBrokerTurnActivity();
  activity.upstream({ method: 'turn/started', params: { threadId: 'a' } });
  activity.startRequest({ id: 2, method: 'turn/start', params: { threadId: 'a' } });
  activity.upstream({ id: 2, error: { message: 'already running' } });
  assert.equal(activity.isIdle(), false);
  activity.upstream({ method: 'turn/completed', params: { threadId: 'a' } });
  assert.equal(activity.isIdle(), true);
});

test('unattributed events fail closed and pending starts stay busy', () => {
  const activity = createCodexBrokerTurnActivity();
  activity.startRequest({ id: 3, method: 'turn/start', params: { threadId: 'a' } });
  activity.upstream({ method: 'turn/completed', params: { threadId: 'a' } });
  assert.equal(activity.isIdle(), false);
  activity.upstream({ id: 3, error: {} });
  assert.equal(activity.isIdle(), true);
  activity.upstream({ method: 'turn/started', params: {} });
  assert.equal(activity.isIdle(), false);
});

test('MCP authorization remains busy after its initiating client disconnects', () => {
  const activity = createCodexBrokerTurnActivity();
  activity.startRequest({ id: 5, method: 'mcpServer/oauth/login', params: { name: 'service' } });
  activity.upstream({ id: 5, result: {} });
  assert.equal(activity.isIdle(), false);
  activity.upstream({ method: 'mcpServer/oauthLogin/completed', params: { name: 'service' } });
  assert.equal(activity.isIdle(), true);
});
