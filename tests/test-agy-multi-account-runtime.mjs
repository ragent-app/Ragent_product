#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import {
  prepareNativeRunProviderHome,
  resolveNativeSelectionFromManifest,
} from '../lib/provider-runtime/run-provider-prepare.mjs';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-multi-account-runtime-'));
const configDir = join(root, 'config');
const providerHomesRoot = join(root, 'provider-homes');
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });

async function addAccount(id, tokenFile) {
  const authId = `${id}-auth`;
  const secretRef = `${id}-secret`;
  assert.equal((await secretStore.writeSecret(secretRef, {
    authType: 'oauth',
    tokens: { tokenFile },
  })).ok, true);
  assert.equal((await registry.upsertAuthProfile({
    id: authId,
    agentType: 'agy',
    authType: 'oauth',
    displayName: id,
    storageType: 'secret-store',
    storageRef: secretRef,
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id,
    agentType: 'agy',
    protocol: 'agy',
    displayName: id,
    baseUrl: '',
    authProfileId: authId,
    quotaPolicy: { mode: 'official_subscription', adapter: 'agy' },
  })).ok, true);
}

try {
  await addAccount('agy-work', 'work-token');
  await addAccount('agy-personal', 'personal-token');

  const scoped = resolveNativeSelectionFromManifest({
    tool: 'agy',
    options: { model: 'gemini-3.7-flash@agy-personal' },
  });
  assert.equal(scoped.providerProfileId, 'agy-personal');

  const [workRun, personalRun] = await Promise.all([
    prepareNativeRunProviderHome('run-work', {
      tool: 'agy',
      options: { model: 'gemini-3.7-flash@agy-work' },
    }, { configDir, providerHomesRoot, externalOAuthOwnership: false }),
    prepareNativeRunProviderHome('run-personal', {
      tool: 'agy',
      options: { model: 'gemini-3.7-flash@agy-personal' },
    }, { configDir, providerHomesRoot, externalOAuthOwnership: false }),
  ]);
  assert.equal(workRun.ok, true, workRun.error || workRun.reason);
  assert.equal(personalRun.ok, true, personalRun.error || personalRun.reason);
  assert.notEqual(workRun.agyHomeDir, personalRun.agyHomeDir);
  assert.equal(workRun.providerId, 'agy-work');
  assert.equal(personalRun.providerId, 'agy-personal');
  assert.equal(
    (await readFile(join(workRun.agyHomeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).trim(),
    'work-token',
  );
  assert.equal(
    (await readFile(join(personalRun.agyHomeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).trim(),
    'personal-token',
  );
  assert.equal(
    (await readFile(join(workRun.agyHomeDir, '.ragent-provider-id'), 'utf8')).trim(),
    'agy-work',
  );
  assert.equal(
    (await readFile(join(personalRun.agyHomeDir, '.ragent-provider-id'), 'utf8')).trim(),
    'agy-personal',
  );

  const firstTurn = buildRuntimeInvocation('agy-json', 'hello', {
    model: 'gemini-3.7-flash@agy-work',
  }, 'agy');
  assert.ok(firstTurn.args.includes('--model') && firstTurn.args.includes('gemini-3.7-flash'));
  assert.equal(firstTurn.args.includes('gemini-3.7-flash@agy-work'), false);
  assert.equal(firstTurn.args.includes('--continue'), false);
  assert.equal(firstTurn.args.includes('--conversation'), false);

  const resumed = buildRuntimeInvocation('agy-json', 'again', {
    model: 'gemini-3.7-flash@agy-work',
    agyConversationId: 'conversation-work-1',
    useResume: true,
  }, 'agy');
  assert.deepEqual(
    resumed.args.slice(resumed.args.indexOf('--conversation'), resumed.args.indexOf('--conversation') + 2),
    ['--conversation', 'conversation-work-1'],
  );
  assert.equal(resumed.args.includes('--continue'), false);

  console.log('test-agy-multi-account-runtime: scoped model selection, isolated Run homes, and resume args OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
