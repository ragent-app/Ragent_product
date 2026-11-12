#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Catalog tests must never install packages into the operator's managed
// runtime. Availability depends on the host; installation has separate fixtures.
const registryFixture = mkdtempSync(join(tmpdir(), 'agentoc-harness-registry-'));
process.env.AGENTOC_CONFIG_DIR = join(registryFixture, 'config');
process.env.AGENTOC_HARNESS_ROOT = join(registryFixture, 'harnesses');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.AGENTOC_INSTANCE_ROOT;

const {
  getHarnessDefinition,
  installHarness,
  listHarnesses,
  resolveHarnessTargetVersion,
  upgradeHarness,
  assertHarnessInstallationVerified,
} = await import('../lib/harness-registry.mjs');
import { isAdapterCompatible } from '../chat/harness-compatibility.mjs';

const harnesses = await listHarnesses();
assert.deepEqual(harnesses.map((harness) => harness.id), [
  'codex', 'claude', 'agy', 'pi', 'deepseek-harness', 'qwen-code',
  'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes',
  'cline', 'kilo',
]);
assert.equal(harnesses.find((harness) => harness.id === 'codex').integration, 'native');
assert.equal(harnesses.find((harness) => harness.id === 'codex').package, '@openai/codex');
assert.equal(harnesses.find((harness) => harness.id === 'agy').installable, true);
assert.equal(harnesses.find((harness) => harness.id === 'agy').installUrls.unix, 'https://antigravity.google/cli/install.sh');
assert.equal(harnesses.find((harness) => harness.id === 'goose').installable, true);
assert.equal(harnesses.find((harness) => harness.id === 'openhands').package, '@openhands/agent-canvas');
assert.equal(harnesses.find((harness) => harness.id === 'openhands').command, 'agent-canvas');
assert.equal(harnesses.find((harness) => harness.id === 'openhands').integration, 'service-required');
assert.equal(harnesses.find((harness) => harness.id === 'openhands').serviceRuntimeFamily, 'openhands-agent-server');
assert.equal(harnesses.find((harness) => harness.id === 'openhands').serviceRuntimeVersion, '1.58.2');
assert.equal(harnesses.find((harness) => harness.id === 'copilot').runtimeFamily, 'copilot-json');
assert.equal(harnesses.find((harness) => harness.id === 'copilot').harnessVersion, '1.0.103');
assert.equal(harnesses.find((harness) => harness.id === 'hermes').runtimeFamily, 'hermes-acp');
assert.equal(harnesses.find((harness) => harness.id === 'hermes').harnessVersion, '0.22.5');
assert.equal(harnesses.find((harness) => harness.id === 'cline').runtimeFamily, 'cline-json');
assert.equal(harnesses.find((harness) => harness.id === 'cline').harnessVersion, '3.0.74');
assert.equal(harnesses.find((harness) => harness.id === 'cline').integration, 'headless-adapter');
assert.equal(harnesses.find((harness) => harness.id === 'kilo').runtimeFamily, 'kilo-json');
assert.equal(harnesses.find((harness) => harness.id === 'kilo').harnessVersion, '7.8.18');
assert.equal(harnesses.find((harness) => harness.id === 'kilo').integration, 'headless-adapter');
assert.deepEqual(harnesses.find((harness) => harness.id === 'hermes').installArgsUnix.slice(0, 2), [
  '--commit', 'bf0203a794a07aac3ff764972ab9087baa4e4f4e',
]);
assert.equal(harnesses.find((harness) => harness.id === 'pi').package, '@earendil-works/pi-coding-agent');
assert.equal(harnesses.find((harness) => harness.id === 'deepseek-harness').runtimeFamily, 'deepseek-harness-acp');
assert.equal(harnesses.find((harness) => harness.id === 'deepseek-harness').status, 'ready');
assert.equal(harnesses.find((harness) => harness.id === 'codex').harnessVersion, '0.167.2');
assert.equal(harnesses.find((harness) => harness.id === 'codex').adapterCompatibility.adapterVersion, '1.3');
assert.deepEqual(harnesses.find((harness) => harness.id === 'codex').adapterCompatibility.compatibleVersions, [
  '0.150.x', '0.151.x', '0.152.x', '0.153.x', '0.164.0', '0.167.2',
]);
assert.equal(harnesses.find((harness) => harness.id === 'claude').harnessVersion, '2.1.310');
assert.equal(isAdapterCompatible('agy', '1.1.22'), true, 'agy latest-channel policy must accept a parsed release version');
assert.equal(isAdapterCompatible('agy', 'not-a-version'), false, 'agy latest-channel policy must still reject an unparseable version');
assert.equal(isAdapterCompatible('claude', '2.1.145'), false, 'Claude Code 2.1.145 must be flagged as incompatible');
assert.equal(isAdapterCompatible('claude', '2.1.246'), false, 'Claude versions before 2.1.247 must be rejected');
assert.equal(isAdapterCompatible('claude', '2.1.247'), true, 'Claude 2.1.247 is the first default-mode-compatible release');
assert.equal(isAdapterCompatible('claude', '2.1.247'), true, 'current managed Claude version must be accepted');
assert.equal(isAdapterCompatible('codex', '0.150.1'), true, 'oldest validated Codex release must remain accepted');
assert.equal(isAdapterCompatible('codex', '0.151.0'), true, 'validated Codex 0.151 releases must be accepted');
assert.equal(isAdapterCompatible('codex', '0.152.9'), true, 'validated Codex 0.152 releases must be accepted');
assert.equal(isAdapterCompatible('codex', '0.153.4'), true, 'current stable Codex release must be accepted');
assert.equal(isAdapterCompatible('codex', '0.154.0'), false, 'unvalidated Codex releases must fail closed');
assert.equal(isAdapterCompatible('codex', '0.164.0'), true);
assert.equal(isAdapterCompatible('codex', '0.167.2'), true);
assert.equal(isAdapterCompatible('codex', '0.167.3'), false);
assert.equal(isAdapterCompatible('codex', '0.165.0'), false);
assert.equal(isAdapterCompatible('codex', '0.165.0-alpha.1'), false);
assert.equal(isAdapterCompatible('codex', '0.165.0', { compatibleVersions: ['*'] }), false,
  'a central policy must not widen the local adapter ceiling');
assert.equal(isAdapterCompatible('claude', '2.1.200', { minimumVersion: '2.1.200' }), false,
  'a central minimum must not lower the local permission-mode requirement');
assert.equal(isAdapterCompatible('claude', '2.1.311'), false);
assert.equal(isAdapterCompatible('agy', '1.4.8'), false);
assert.equal(isAdapterCompatible('kimi-code', '0.38.0'), false,
  'Kimi 0.x cannot consume the 2.x provider config; require managed upgrade');
for (const [id, version] of Object.entries({ pi: '1.4.0', 'deepseek-harness': '0.2.1-rc.2',
  'qwen-code': '0.26.1', opencode: '1.19.4', 'kimi-code': '2.3.2', goose: '1.56.0',
  openhands: '1.33.0', hermes: '0.22.5', cline: '3.0.74', kilo: '7.8.18' })) {
  assert.equal(harnesses.find((harness) => harness.id === id).harnessVersion, version);
  assert.equal(isAdapterCompatible(id, version), true, `${id} latest target must be admitted`);
}
assert.equal(harnesses.find((harness) => harness.id === 'hermes').installArgsUnix.includes('--no-skills'), false,
  'Hermes 0.22 removed --no-skills');
assert.equal(resolveHarnessTargetVersion(
  { id: 'codex', harnessVersion: '0.153.4' },
  { minimumVersion: '0.150.1', targetVersion: '0.154.0' },
), '0.153.4', 'central policy cannot advance beyond the validated Codex adapter range');
for (const id of ['codex', 'claude', 'pi', 'deepseek-harness', 'qwen-code', 'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes', 'cline', 'kilo']) {
  assert.ok(harnesses.find((harness) => harness.id === id).adapterCompatibility.minimumVersion,
    `${id} must declare a minimum harness version`);
}
assert.deepEqual(harnesses.find((harness) => harness.id === 'codex').providerProtocols, ['openai-responses', 'openai-chat']);
assert.deepEqual(harnesses.find((harness) => harness.id === 'claude').providerProtocols, ['anthropic-messages']);
assert.deepEqual(harnesses.find((harness) => harness.id === 'agy').providerProtocols, ['agy']);
assert.equal(harnesses.find((harness) => harness.id === 'deepseek-harness').installable, true);
assert.equal(harnesses.find((harness) => harness.id === 'qwen-code').runtimeFamily, 'qwen-code-acp');
assert.equal(harnesses.find((harness) => harness.id === 'opencode').runtimeFamily, 'opencode-json');
assert.equal(harnesses.find((harness) => harness.id === 'kimi-code').package, '@moonshot-ai/kimi-code');
assert.equal(await getHarnessDefinition('does-not-exist'), null);
assert.equal((await getHarnessDefinition('kilo-code')).id, 'kilo');
assert.equal(harnesses.find((harness) => harness.id === 'goose').integration, 'adapter-planned');
assert.throws(() => assertHarnessInstallationVerified({ name: 'AgY', detectedVersion: '1.4.8',
  compatibilityStatus: 'incompatible' }, 'latest'), { code: 'HARNESS_INSTALLED_VERSION_UNVERIFIED' },
  'a floating installer must not convert an unreviewed payload into an admitted runtime');
assert.throws(() => assertHarnessInstallationVerified({ name: 'Codex', detectedVersion: '0.153.4',
  compatibilityStatus: 'compatible' }, '0.164.0'), { code: 'HARNESS_INSTALLED_VERSION_UNVERIFIED' },
  'a successful installer command must still publish the requested version');

await assert.rejects(() => installHarness('does-not-exist'), /Unknown harness/);
assert.equal((await getHarnessDefinition('deepseek-harness')).installable, true);
await assert.rejects(() => upgradeHarness('codex', '0.154.0'), /not compatible/);
await assert.rejects(() => installHarness('codex', { version: '0.165.0' }), /not compatible/);
await assert.rejects(() => installHarness('hermes', { version: '0.20.6' }), /pinned source commit/);
assert.equal(harnesses.find((harness) => harness.id === 'kimi-code').installable, true);

console.log('harness registry tests passed');
