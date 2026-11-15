#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGY_AUTH_RELATIVE_PATH } from '../lib/agy-runtime.mjs';
import { agyTokenFingerprint, reconcileAgyRunCredential, resolveAgyRunHome } from '../lib/provider-runtime/agy-credential-sync.mjs';
import { createCredentialMutationLedger } from '../lib/provider-runtime/credential-mutation.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-refresh-conflict-'));
const configDir = join(root, 'config');
const providerHomesRoot = join(root, 'provider-homes');
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });
const credentialLedger = createCredentialMutationLedger({ configDir });

async function writeRunHome(runId, tokenFile, sourceToken = 'initial-token') {
  const home = resolveAgyRunHome(providerHomesRoot, 'agy-account', runId);
  const authFile = join(home, AGY_AUTH_RELATIVE_PATH);
  await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  await writeFile(authFile, tokenFile, 'utf8');
  await writeFile(join(home, '.ragent-provider-id'), 'agy-account\n', 'utf8');
  await writeFile(join(home, '.ragent-oauth-state.json'), JSON.stringify({
    version: 1,
    storageRef: 'agy-account-secret',
    sourceFingerprint: agyTokenFingerprint(sourceToken),
  }) + '\n', 'utf8');
}

try {
  await secretStore.writeSecret('agy-account-secret', {
    authType: 'oauth',
    tokens: { tokenFile: 'initial-token' },
  });
  await registry.upsertAuthProfile({
    id: 'agy-account-auth',
    agentType: 'agy',
    authType: 'oauth',
    displayName: 'AgY account',
    storageType: 'secret-store',
    storageRef: 'agy-account-secret',
  });
  await registry.upsertProviderProfile({
    id: 'agy-account',
    agentType: 'agy',
    protocol: 'agy',
    displayName: 'AgY account',
    baseUrl: '',
    authProfileId: 'agy-account-auth',
  });

  await writeRunHome('run-one', 'refreshed-token');
  const first = await reconcileAgyRunCredential({
    run: { id: 'run-one', tool: 'agy', agyProviderProfileId: 'agy-account' },
    configDir,
    providerHomesRoot,
    registry,
    secretStore,
    credentialLedger,
    sourceInstanceId: 'instance-test',
  });
  assert.equal(first.status, 'synced');
  assert.equal(first.credentialVersion, 1);
  assert.equal((await secretStore.resolveSecret('agy-account-secret')).tokens.tokenFile, 'refreshed-token');
  assert.equal((await credentialLedger.getRecord('provider:agy:agy-account')).credentialVersion, 1);
  assert.equal((await registry.getAuthProfile('agy-account-auth')).accountMetadata.credentialVersion, 1);

  await writeRunHome('run-two', 'stale-second-refresh');
  const second = await reconcileAgyRunCredential({
    run: { id: 'run-two', tool: 'agy', agyProviderProfileId: 'agy-account' },
    configDir,
    providerHomesRoot,
    registry,
    secretStore,
    credentialLedger,
    sourceInstanceId: 'instance-test',
  });
  assert.equal(second.status, 'conflict');
  assert.equal(second.reason, 'agy-refresh-conflict');
  assert.equal((await secretStore.resolveSecret('agy-account-secret')).tokens.tokenFile, 'refreshed-token');

  await secretStore.writeSecret('agy-account-secret', {
    authType: 'oauth',
    tokens: { tokenFile: 'initial-token' },
  });
  const [left, right] = await Promise.all([
    writeRunHome('run-three', 'parallel-left').then(() => reconcileAgyRunCredential({
      run: { id: 'run-three', tool: 'agy', agyProviderProfileId: 'agy-account' },
      configDir,
      providerHomesRoot,
      registry,
      secretStore,
      credentialLedger,
      sourceInstanceId: 'instance-test',
    })),
    writeRunHome('run-four', 'parallel-right').then(() => reconcileAgyRunCredential({
      run: { id: 'run-four', tool: 'agy', agyProviderProfileId: 'agy-account' },
      configDir,
      providerHomesRoot,
      registry,
      secretStore,
      credentialLedger,
      sourceInstanceId: 'instance-test',
    })),
  ]);
  assert.deepEqual([left.status, right.status].sort(), ['conflict', 'synced']);
  assert.equal([left, right].find((entry) => entry.status === 'synced').credentialVersion, 2);
  assert.match(
    (await readFile(join(configDir, 'native-provider-runtime', 'secrets', 'agy-account-secret.json'), 'utf8')),
    /parallel-(left|right)/,
  );
  assert.equal((await credentialLedger.getRecord('provider:agy:agy-account')).credentialVersion, 2);
  assert.equal((await registry.getAuthProfile('agy-account-auth')).accountMetadata.credentialVersion, 2);

  console.log('test-agy-refresh-conflict: token refresh uses account lock and compare-and-swap');
} finally {
  await rm(root, { recursive: true, force: true });
}
