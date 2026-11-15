#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ragent-provider-guidance-'));
const previous = {
  RAGENT_INSTANCE_ROOT: process.env.RAGENT_INSTANCE_ROOT,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_WORK_ROOT_DIR: process.env.RAGENT_WORK_ROOT_DIR,
};
process.env.RAGENT_INSTANCE_ROOT = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_WORK_ROOT_DIR = join(home, '.ragent', 'workspace');

try {
  const { createProviderPreparationError } = await import('../chat/run-launcher.mjs');

  const unconfigured = createProviderPreparationError('generic failure', {
    app: 'codex',
    providerId: '',
    causeCode: 'native-provider-not-selected',
    sourceError: new Error('private config path and credential must never be shown'),
  });
  assert.equal(unconfigured.providerPreparation.causeCode, 'native-provider-not-selected');
  assert.match(unconfigured.message, /No Codex provider is configured on this computer/);
  assert.match(unconfigured.message, /Ragent Settings > Providers/);
  assert.doesNotMatch(unconfigured.message, /private config path|credential must never be shown/i);
  assert.equal(unconfigured.code, 'PROVIDER_HOME_PREPARE_FAILED');

  const missingCredential = createProviderPreparationError('generic failure', {
    app: 'claude',
    providerId: 'claude-profile',
    causeCode: 'credential-missing',
  });
  assert.match(missingCredential.message, /no usable credential on this computer/);
  assert.match(missingCredential.message, /Reconnect or replace its credential/);

  const unknown = createProviderPreparationError('Safe generic message', {
    app: 'codex',
    causeCode: 'future-private-reason',
    sourceError: new Error('do not expose this provider detail'),
  });
  assert.equal(unknown.message, 'Safe generic message');
  assert.doesNotMatch(unknown.message, /future-private-reason|provider detail/);
  assert.equal(unknown.providerPreparation.causeCode, 'future-private-reason');

  console.log('provider preparation guidance tests passed');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
