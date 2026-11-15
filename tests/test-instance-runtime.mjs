#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bootstrapInstanceRuntime,
  INSTANCE_RUNTIME_IDENTITY_INVALID,
  resolveCliIpcEndpoint,
} from '../lib/instance-runtime.mjs';
import { loadInstanceIdentity, loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';

const instanceRoot = 'C:\\Users\\Alice\\AppData\\Local\\Ragent\\instances\\owner';
const identityFile = `${instanceRoot}\\config\\instance-identity.json`;
const ownershipFile = `${instanceRoot}\\runtime\\instance-ownership.json`;
const identity = { instanceId: 'inst_abc123' };
const ownerCalls = [];

const runtime = await bootstrapInstanceRuntime({
  platform: 'win32',
  instanceRoot,
  identityFile,
  ownershipFile,
  loadIdentityImpl: async (options) => {
    assert.equal(options.filePath, identityFile);
    return identity;
  },
  acquireOwnershipImpl: async (options) => {
    ownerCalls.push(options);
    return {
      ...options,
      release: async () => ({ ok: true, released: true }),
    };
  },
  pid: 4242,
});

assert.equal(runtime.platform, 'win32');
assert.equal(runtime.instanceId, identity.instanceId);
assert.match(runtime.endpointName, /^\\\\\.\\pipe\\ragent-[0-9a-f-]+$/);
assert.equal(ownerCalls.length, 1);
assert.equal(ownerCalls[0].filePath, ownershipFile);
assert.equal(ownerCalls[0].instanceId, identity.instanceId);
assert.equal(ownerCalls[0].pid, 4242);
assert.equal(ownerCalls[0].endpointName, runtime.endpointName);
assert.deepEqual(await runtime.release(), { ok: true, released: true });

const serviceNonce='svc_'+'1'.repeat(32);
await bootstrapInstanceRuntime({platform:'win32',instanceRoot,identityFile,ownershipFile,
  serviceOwnershipToken:serviceNonce,loadIdentityImpl:async()=>identity,
  acquireOwnershipImpl:async options=>{assert.equal(options.token,serviceNonce);return {release:async()=>({ok:true})};}});
await assert.rejects(bootstrapInstanceRuntime({platform:'win32',instanceRoot,identityFile,ownershipFile,
  serviceOwnershipToken:'foreign-token',loadIdentityImpl:async()=>identity,
  acquireOwnershipImpl:async()=>{assert.fail('Malformed nonce reached marker creation');}}),
  error=>error.code===INSTANCE_RUNTIME_IDENTITY_INVALID);

const endpoint = await resolveCliIpcEndpoint({
  platform: 'win32',
  instanceRoot,
  identityFile,
  loadIdentityImpl: async () => identity,
});
assert.equal(endpoint, runtime.endpointName);

const unix = await bootstrapInstanceRuntime({
  platform: 'linux',
  cliSocketPath: '/tmp/ragent-cli.sock',
});
assert.equal(unix.endpointName, '/tmp/ragent-cli.sock');
assert.deepEqual(await unix.release(), { ok: true, skipped: true });

const readOnlyRoot = await mkdtemp(join(tmpdir(), 'ragent-instance-identity-readonly-'));
try {
  const readOnlyFile = join(readOnlyRoot, 'identity.json');
  assert.equal(await loadInstanceIdentity({ filePath: readOnlyFile }), null);
  await assert.rejects(access(readOnlyFile), /ENOENT/);
  const createdIdentity = await loadOrCreateInstanceIdentity({ filePath: readOnlyFile });
  const loadedIdentity = await loadInstanceIdentity({ filePath: readOnlyFile });
  assert.equal(loadedIdentity.instanceId, createdIdentity.instanceId);

  const missingEndpointFile = join(readOnlyRoot, 'missing-endpoint-identity.json');
  await assert.rejects(
    resolveCliIpcEndpoint({ platform: 'win32', instanceRoot, identityFile: missingEndpointFile }),
    (error) => error.code === INSTANCE_RUNTIME_IDENTITY_INVALID,
  );
  await assert.rejects(access(missingEndpointFile), /ENOENT/);
} finally {
  await rm(readOnlyRoot, { recursive: true, force: true });
}

await assert.rejects(
  bootstrapInstanceRuntime({
    platform: 'win32',
    instanceRoot,
    loadIdentityImpl: async () => ({}),
  }),
  (error) => error.code === INSTANCE_RUNTIME_IDENTITY_INVALID,
);

console.log('test-instance-runtime: ok');
