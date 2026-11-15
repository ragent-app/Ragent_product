#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  HARNESS_ADAPTER_SUPPORTED_VERSIONS,
  HARNESS_ADAPTER_CONTRACT_VERSION,
  acceptHarnessEvent,
  createHarnessEventLedger,
  normalizeHarnessAdapterDescriptor,
  validateHarnessEvent,
} from '../chat/harness-contract.mjs';
import {
  descriptorFor,
  getHarnessVerificationTargets,
  probeHarnessVersion,
  verifyFixture,
  verifyHarnessLifecycleMatrix,
} from '../chat/harness-verification.mjs';

assert.equal(HARNESS_ADAPTER_CONTRACT_VERSION, '1.2');
assert.deepEqual(HARNESS_ADAPTER_SUPPORTED_VERSIONS, ['1.0', '1.1', '1.2']);

const legacy = normalizeHarnessAdapterDescriptor({
  contractVersion: '1.0',
  id: 'legacy',
  provider: 'legacy',
  transport: 'process-jsonl',
  operations: ['start', 'sendTurn', 'cancel', 'terminate'],
  capabilities: {
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
  },
  events: ['run.started', 'assistant.message', 'run.completed', 'run.failed', 'run.cancelled'],
});
assert.equal(legacy.contractVersion, '1.2');
assert.equal(legacy.capabilities.supportsBidirectionalApproval, false);

const ledger = createHarnessEventLedger({ runId: 'run-1', turnId: 'turn-1' });
const event = {
  type: 'run.started',
  eventId: 'event-1',
  seq: 1,
  runId: 'run-1',
  turnId: 'turn-1',
};
assert.equal(validateHarnessEvent(event).valid, true);
assert.equal(acceptHarnessEvent(event, ledger).accepted, true);
assert.equal(acceptHarnessEvent(event, ledger).duplicate, true);
assert.equal(acceptHarnessEvent({ ...event, content: 'tampered' }, ledger).conflict, true);
assert.equal(acceptHarnessEvent({ ...event, eventId: 'event-0', seq: 1 }, ledger).reason, 'out_of_order');
assert.equal(acceptHarnessEvent({ ...event, eventId: 'event-other-run', seq: 2, runId: 'run-2' }, ledger).reason, 'invalid');
assert.equal(validateHarnessEvent({ type: 'run.started' }).valid, false);

const codex = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  runtimeFamily: 'codex-app-server-json',
  integration: 'native',
  available: true,
  path: '/bin/codex',
  adapterCompatibility: {
    harness: '@openai/codex',
    adapterVersion: '1.1',
    compatibleVersions: ['0.150.x', '0.151.x', '0.152.x', '0.153.x'],
  },
};
const descriptor = descriptorFor(codex);
assert.equal(descriptor.contractVersion, '1.2');
assert.equal(descriptor.capabilities.supportsBidirectionalApproval, true);
assert.ok(descriptor.operations.includes('getResumeAnchor'));
const fixture = verifyFixture(descriptor);
assert.equal(fixture.descriptorValid, true);
assert.equal(fixture.stream.status, 'verified');
assert.equal(fixture.approvalFixture.status, 'verified');

const matrix = await verifyHarnessLifecycleMatrix({
  includeBuiltins: false,
  harnesses: [codex, {
    id: 'missing', name: 'Missing', command: '__missing_harness__', runtimeFamily: '',
    integration: 'unavailable', available: false, path: null,
    adapterCompatibility: { harness: 'missing', adapterVersion: '1.0', compatibleVersions: ['latest'] },
  }],
  execFileImpl: async () => ({ stdout: '0.153.4\n', stderr: '' }),
});
assert.deepEqual(matrix.harnesses.map((item) => item.id), ['codex', 'missing']);
assert.equal(matrix.harnesses[0].version.status, 'verified');
assert.equal(matrix.harnesses[0].approval.status, 'not-run');
assert.equal(matrix.harnesses[0].cancel.status, 'not-run');
assert.equal(matrix.harnesses[1].approval.status, 'unsupported');
assert.equal(matrix.harnesses[1].version.status, 'unavailable');

const versionCalls = [];
const wrapperPath = process.platform === 'win32'
  ? 'C:\\ProgramData\\Ragent\\harnesses\\codex\\node_modules\\.bin\\codex.cmd'
  : '/tmp/codex';
const wrapperVersion = await probeHarnessVersion({ ...codex, path: wrapperPath }, {
  execFileImpl: async (file, args, options) => {
    versionCalls.push({ file, args, options });
    return { stdout: 'codex-cli 0.153.4\n', stderr: '' };
  },
});
assert.equal(wrapperVersion.status, 'verified');
assert.equal(versionCalls.length, 1);
if (process.platform === 'win32') {
  assert.match(versionCalls[0].file, /cmd\.exe$/i);
  assert.deepEqual(versionCalls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(versionCalls[0].options.windowsVerbatimArguments, true);
  assert.match(versionCalls[0].args[3], /--version/);
} else {
  assert.equal(versionCalls[0].file, wrapperPath);
  assert.deepEqual(versionCalls[0].args, ['--version']);
}

const allTargets = await getHarnessVerificationTargets({ includeBuiltins: true });
assert.deepEqual(allTargets.map((target) => target.id), [
  'codex', 'claude', 'agy', 'pi', 'deepseek-harness', 'qwen-code',
  'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes',
  'cline', 'kilo', 'claude-compatibility', 'claude-bidi',
]);
for (const target of allTargets) {
  const targetFixture = verifyFixture(descriptorFor(target));
  assert.equal(targetFixture.descriptorValid, true, `${target.id} descriptor must satisfy the contract`);
  assert.equal(targetFixture.stream.status, 'verified', `${target.id} event replay must be verified`);
}

console.log('harness verification tests passed');
