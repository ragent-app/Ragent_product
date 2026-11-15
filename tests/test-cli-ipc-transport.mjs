#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  CLI_IPC_BOOTSTRAP_INVALID,
  CLI_IPC_BOOTSTRAP_REQUIRED,
  CLI_IPC_REQUEST_BODY_REFUSED,
  CLI_IPC_UNTRUSTED_PEER_CLAIM,
  cliIpcListenTarget,
  isWindowsCliPipeEndpoint,
  prepareCliIpcTransport,
  validateCliAuthRequest,
} from '../lib/cli-ipc-transport.mjs';

let bootstrapCalls = 0;
const unix = await prepareCliIpcTransport({
  platform: 'linux',
  unixSocketPath: '/tmp/ragent-cli.sock',
  bootstrapInstanceRuntime: async () => { bootstrapCalls += 1; },
});
assert.equal(unix.kind, 'unix-socket');
assert.equal(cliIpcListenTarget(unix), '/tmp/ragent-cli.sock');
assert.equal(bootstrapCalls, 0, 'Unix must not call the Windows instance bootstrap');

const darwin = await prepareCliIpcTransport({
  platform: 'darwin',
  unixSocketPath: '/Users/alice/.config/ragent/ragent-cli.sock',
});
assert.equal(darwin.kind, 'unix-socket');

await assert.rejects(
  prepareCliIpcTransport({ platform: 'win32' }),
  (error) => error.code === CLI_IPC_BOOTSTRAP_REQUIRED,
);

for (const runtime of [
  null,
  {},
  { instanceId: 'inst_a', endpointName: '\\\\server\\pipe\\ragent-owner', release() {} },
  { instanceId: 'inst_a', endpointName: '\\\\.\\pipe\\foreign-owner', release() {} },
  { instanceId: 'inst_a', endpointName: '\\\\.\\pipe\\ragent-owner' },
]) {
  await assert.rejects(
    prepareCliIpcTransport({
      platform: 'win32',
      bootstrapInstanceRuntime: async () => runtime,
    }),
    (error) => error.code === CLI_IPC_BOOTSTRAP_INVALID,
  );
}

let released = 0;
const windows = await prepareCliIpcTransport({
  platform: 'win32',
  unixSocketPath: 'must-not-be-used',
  bootstrapInstanceRuntime: async (request) => {
    assert.deepEqual(request, { purpose: 'local-cli', transport: 'named-pipe' });
    return {
      instanceId: 'inst_a',
      endpointName: '\\\\.\\pipe\\ragent-0123456789abcdef-owner',
      release() { released += 1; },
    };
  },
});
assert.equal(windows.kind, 'windows-named-pipe');
assert.equal(windows.instanceId, 'inst_a');
assert.equal(isWindowsCliPipeEndpoint(windows.endpoint), true);
assert.deepEqual(cliIpcListenTarget(windows), {
  path: '\\\\.\\pipe\\ragent-0123456789abcdef-owner',
  exclusive: true,
  readableAll: false,
  writableAll: false,
});
await windows.release();
assert.equal(released, 1);

assert.equal(validateCliAuthRequest({ headers: {} }).ok, true);
assert.equal(validateCliAuthRequest({ headers: { 'content-length': '0' } }).ok, true);
assert.deepEqual(validateCliAuthRequest({ headers: { 'content-length': '1' } }), {
  ok: false,
  statusCode: 413,
  code: CLI_IPC_REQUEST_BODY_REFUSED,
});
assert.equal(
  validateCliAuthRequest({ headers: { 'transfer-encoding': 'chunked' } }).code,
  CLI_IPC_REQUEST_BODY_REFUSED,
);
for (const header of [
  'x-ragent-instance-id',
  'x-ragent-peer-pid',
  'x-ragent-peer-sid',
  'x-windows-peer-pid',
  'x-windows-peer-sid',
]) {
  assert.equal(
    validateCliAuthRequest({ headers: { [header]: 'forged' } }).code,
    CLI_IPC_UNTRUSTED_PEER_CLAIM,
    `${header} must never become a trusted peer fact`,
  );
}

console.log('test-cli-ipc-transport: ok');
