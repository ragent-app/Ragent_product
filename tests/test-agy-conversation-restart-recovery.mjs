#!/usr/bin/env node
// Verify the durable identity contract used when a Run is recreated after a
// process/service restart: provider binding and conversation resume are both
// deterministic, while a different account cannot reuse the old conversation.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRuntimeInvocation } from '../chat/process-runner.mjs';
import { AGY_AUTH_RELATIVE_PATH } from '../lib/agy-runtime.mjs';
import { prepareNativeRunProviderHome } from '../lib/provider-runtime/run-provider-prepare.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-conversation-restart-'));
const configDir = join(root, 'config');
const providerHomesRoot = join(root, 'provider-homes');
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });

try {
  await secretStore.writeSecret('agy-a-secret', {
    authType: 'oauth',
    tokens: { tokenFile: 'opaque-fixture-a' },
  });
  await registry.upsertAuthProfile({
    id: 'agy-a-auth', agentType: 'agy', authType: 'oauth',
    displayName: 'fixture-a', storageType: 'secret-store', storageRef: 'agy-a-secret',
  });
  await registry.upsertProviderProfile({
    id: 'agy-a', agentType: 'agy', protocol: 'agy', displayName: 'fixture-a',
    baseUrl: '', authProfileId: 'agy-a-auth',
  });

  const manifest = {
    tool: 'agy',
    options: { model: 'gemini-3.7-flash@agy-a', providerProfile: 'agy-a' },
  };
  const first = await prepareNativeRunProviderHome('same-run-id', manifest, {
    configDir, providerHomesRoot, externalOAuthOwnership: false,
  });
  const afterRestart = await prepareNativeRunProviderHome('same-run-id', manifest, {
    configDir, providerHomesRoot, externalOAuthOwnership: false,
  });
  assert.equal(first.ok, true, first.error || first.reason);
  assert.equal(afterRestart.ok, true, afterRestart.error || afterRestart.reason);
  assert.equal(afterRestart.providerId, 'agy-a');
  assert.equal(afterRestart.agyHomeDir, first.agyHomeDir);
  assert.equal(
    (await readFile(join(afterRestart.agyHomeDir, AGY_AUTH_RELATIVE_PATH), 'utf8')).trim(),
    'opaque-fixture-a',
  );

  const resumed = buildRuntimeInvocation('agy-stream-json', 'after restart', {
    model: 'gemini-3.7-flash@agy-a',
    providerProfile: 'agy-a',
    agyConversationId: 'conversation-a-1',
    agyResume: true,
  }, 'agy');
  const conversationIndex = resumed.args.indexOf('--conversation');
  assert.deepEqual(resumed.args.slice(conversationIndex, conversationIndex + 2), [
    '--conversation', 'conversation-a-1',
  ]);

  const freshAccount = buildRuntimeInvocation('agy-stream-json', 'new account', {
    model: 'gemini-3.7-flash@agy-b',
    providerProfile: 'agy-b',
    agyResume: false,
  }, 'agy');
  assert.equal(freshAccount.args.includes('--conversation'), false);
  assert.equal(freshAccount.args.includes('--continue'), false);
  console.log('test-agy-conversation-restart-recovery: provider binding and resume survive Run recreation');
} finally {
  await rm(root, { recursive: true, force: true });
}
