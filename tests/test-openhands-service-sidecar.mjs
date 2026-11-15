#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runOpenHandsServiceSidecar,
  spawnOpenHandsServiceProcess,
} from '../chat/openhands-service-sidecar.mjs';

const spawnCalls = [];
const injectedChild = { pid: 42 };
const spawned = await spawnOpenHandsServiceProcess({
  command: 'agent-canvas',
  args: ['--backend-only', '--port', '41234'],
  cwd: '/tmp/work',
  env: { RAGENT_TEST: '1' },
  resolveCommandPathImpl: async (command) => {
    assert.equal(command, 'agent-canvas');
    return '/opt/ragent/harnesses/agent-canvas';
  },
  spawnManagedImpl: async (spec, options) => {
    spawnCalls.push({ spec, options });
    return injectedChild;
  },
});
assert.equal(spawned, injectedChild);
assert.deepEqual(spawnCalls, [{
  spec: {
    ...(process.platform === 'win32' ? { kind: 'unknown' } : {}),
    file: '/opt/ragent/harnesses/agent-canvas',
    args: ['--backend-only', '--port', '41234'],
    cwd: '/tmp/work',
    env: { RAGENT_TEST: '1' },
    shell: false,
  },
  options: {
    stdio: ['ignore', 'ignore', 'ignore'],
    preserveOnControllerExit: false,
  },
}]);

const customSpawnCalls = [];
await spawnOpenHandsServiceProcess({
  command: 'agent-canvas',
  resolveCommandPathImpl: async () => '/opt/ragent/harnesses/agent-canvas',
  spawnImpl: (file, args, options) => {
    customSpawnCalls.push({ file, args, options });
    return injectedChild;
  },
});
assert.deepEqual(customSpawnCalls[0], {
  file: '/opt/ragent/harnesses/agent-canvas',
  args: [],
  options: {
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  },
});
await assert.rejects(
  spawnOpenHandsServiceProcess({
    command: 'missing-agent-canvas',
    resolveCommandPathImpl: async () => null,
  }),
  (error) => error?.code === 'OPENHANDS_SERVICE_COMMAND_NOT_FOUND',
);

const records = [];
const updates = [];
let socketClosed = false;
const client = {
  async request(path) {
    assert.equal(path, '/server_info');
    return { version: '1.42.1' };
  },
  async createConversation(payload) {
    assert.equal(payload.agent.kind, 'Agent');
    assert.equal(payload.workspace.working_dir, '/tmp');
    assert.equal(payload.initial_message.content[0].text, 'do it');
    return { id: 'conv-1' };
  },
  connectEvents(id, { onEvent }) {
    assert.equal(id, 'conv-1');
    queueMicrotask(() => onEvent({ kind: 'FinishEvent', success: true, id: 'finish-1' }));
    return { close() { socketClosed = true; } };
  },
  async runConversation(id) { assert.equal(id, 'conv-1'); },
  async respondToConfirmation() {},
};

const result = await runOpenHandsServiceSidecar({
  runId: 'run-test',
  manifest: { options: { openhandsService: { host: 'http://openhands.test', model: 'test-model' } } },
  prompt: 'do it',
  cwd: '/tmp',
  append: async (record) => records.push(record),
  readRun: async () => ({ cancelRequested: false }),
  updateRun: async (updater) => updates.push(updater({})),
  clientFactory: () => client,
});

assert.equal(result.conversationId, 'conv-1');
assert.equal(records.some((record) => record.type === 'openhands.event'), true);
assert.equal(records.some((record) => record.type === 'run.completed'), true);
assert.equal(updates[0].openHandsConversationId, 'conv-1');
assert.equal(socketClosed, true);

const idleClient = {
  async request(path) { assert.equal(path, '/server_info'); return { version: '1.42.1' }; },
  async createConversation() { return { id: 'conv-idle' }; },
  connectEvents() { return { close() {} }; },
  async runConversation() {},
  async interruptConversation() {},
};
const idleResult = await runOpenHandsServiceSidecar({
  runId: 'run-idle',
  manifest: {
    options: {
      openhandsService: {
        host: 'http://openhands.test',
        model: 'test-model',
        streamStartTimeoutMs: 20_000,
        idleTimeoutMs: 25,
      },
    },
  },
  prompt: 'wait forever',
  cwd: '/tmp',
  append: async () => {},
  readRun: async () => ({ cancelRequested: false }),
  updateRun: async () => {},
  clientFactory: () => idleClient,
});
assert.match(idleResult.event?.content || '', /idle timeout/);

const providerHomes = await mkdtemp(join(tmpdir(), 'ragent-openhands-provider-'));
await mkdir(join(providerHomes, 'openhands'), { recursive: true });
await writeFile(join(providerHomes, 'openhands', '.ragent-provider.env'), 'RAGENT_PROVIDER_MODEL="bridge-model"\nRAGENT_PROVIDER_BASE_URL="https://provider.test/v1"\nRAGENT_PROVIDER_API_KEY="bridge-key"\n');
await writeFile(join(providerHomes, 'openhands', '.ragent-openhands.env'), 'LLM_MODEL="bridge-model"\nLLM_BASE_URL="https://provider.test/v1"\nLLM_API_KEY="bridge-key"\n');
let bridgedAgent;
const bridgedClient = {
  async request(path) { assert.equal(path, '/server_info'); return { version: '1.42.1' }; },
  async createConversation(payload) { bridgedAgent = payload.agent; return { id: 'conv-bridge' }; },
  connectEvents() {
    queueMicrotask(() => {});
    return { close() {} };
  },
  async runConversation() {},
};
const bridgedRun = runOpenHandsServiceSidecar({
  runId: 'run-bridge',
  manifest: { options: { runtimeFamily: 'openhands-agent-server', openhandsService: { host: 'http://openhands.test' } } },
  prompt: 'bridge it',
  cwd: '/tmp',
  environment: { RAGENT_PROVIDER_HOMES_DIR: providerHomes },
  append: async (record) => { if (record.type === 'openhands.conversation.created') throw new Error('stop after payload'); },
  readRun: async () => ({ cancelRequested: false }),
  updateRun: async () => {},
  clientFactory: () => bridgedClient,
});
await assert.rejects(bridgedRun, /stop after payload/);
assert.deepEqual(bridgedAgent.llm, {
  model: 'bridge-model', api_key: 'bridge-key', base_url: 'https://provider.test/v1',
});
await rm(providerHomes, { recursive: true, force: true });
console.log('OpenHands service sidecar tests passed');
