import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxRunUnitName, matchesLinuxRunUnitState, captureLinuxRunUnitIdentity, isLinuxRunUnitLive } from '../scripts/linux-run-unit-liveness.mjs';

const expected = { runId: 'run_test12345678', launchAttempt: 2, invocationId: 'a'.repeat(32) };
const unit = linuxRunUnitName(expected.runId, expected.launchAttempt);
const state = `MainPID=123\nControlGroup=/agentoc.slice/agentoc-runners.slice/${unit}\nId=${unit}\nLoadState=loaded\nActiveState=active\nSubState=running\nInvocationID=${expected.invocationId}\n`;
test('a unit must match the recorded launch generation and systemd invocation', () => {
  assert.equal(matchesLinuxRunUnitState(state, expected), true);
  assert.equal(matchesLinuxRunUnitState(state, { ...expected, launchAttempt: 3 }), false);
  assert.equal(matchesLinuxRunUnitState(state, { ...expected, invocationId: 'b'.repeat(32) }), false);
  assert.equal(matchesLinuxRunUnitState(state.replace('ActiveState=active', 'ActiveState=inactive'), expected), false);
  assert.equal(matchesLinuxRunUnitState(state.replace('MainPID=123', 'MainPID=0'), expected), false);
  assert.equal(matchesLinuxRunUnitState(state.replace('agentoc-runners.slice/', 'system.slice/'), expected), false);
  assert.equal(matchesLinuxRunUnitState(`${state}MainPID=123\n`, expected), false);
  assert.equal(matchesLinuxRunUnitState(state, { ...expected, runId: '../../etc' }), false);
});
test('real systemd fixture is active only for the recorded invocation', { skip: !process.env.AGENTOC_TEST_SYSTEMD_INVOCATION }, async () => {
  const identity = { runId: 'run_test12345678', launchAttempt: 2, invocationId: process.env.AGENTOC_TEST_SYSTEMD_INVOCATION };
  assert.deepEqual(await captureLinuxRunUnitIdentity(identity), identity);
  assert.equal(await isLinuxRunUnitLive(identity), true);
  assert.equal(await isLinuxRunUnitLive({ ...identity, invocationId: 'b'.repeat(32) }), false);
});
