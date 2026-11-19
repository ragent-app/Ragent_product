#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-tools-agy-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const harnessRoot = join(tempRoot, 'harnesses');
const agyHarnessBin = join(harnessRoot, 'agy', 'bin');
const fakeBin = join(tempRoot, 'bin');
mkdirSync(configDir, { recursive: true });
mkdirSync(agyHarnessBin, { recursive: true });
mkdirSync(fakeBin, { recursive: true });

for (const [dir, cmd, ver] of [
  [agyHarnessBin, 'agy', '1.5.12'],
  [fakeBin, 'custom-agy-acp', '1.0.0'],
]) {
  const posixPath = join(dir, cmd);
  writeFileSync(posixPath, `#!/bin/sh\necho "${ver}"\n`, 'utf8');
  try {
    chmodSync(posixPath, 0o755);
  } catch {}
  if (process.platform === 'win32') {
    writeFileSync(join(dir, `${cmd}.cmd`), `@echo off\r\necho ${ver}\r\n`, 'utf8');
  }
}

const originalEnv = { ...process.env };
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_HARNESS_ROOT = harnessRoot;
process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.LOCALAPPDATA = join(tempRoot, 'local-appdata');
process.env.APPDATA = join(tempRoot, 'roaming-appdata');
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH || ''}`;
delete process.env.RAGENT_AGY_RUNTIME_FAMILY;

try {
  const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
  const tools = await import(pathToFileURL(join(repoRoot, 'lib', 'tools.mjs')).href);
  const {
    AGY_COMPAT_RUNTIME_FAMILY,
    AGY_DEFAULT_RUNTIME_FAMILY,
    getAvailableTools,
    getPublicAvailableToolsAsync,
    getToolDefinitionAsync,
    invalidateAvailableToolsCache,
    isToolValid,
    resolveAgyBuiltinRuntimeFamily,
    saveSimpleToolAsync,
  } = tools;

  assert.equal(AGY_DEFAULT_RUNTIME_FAMILY, 'agy-acp');
  assert.equal(AGY_COMPAT_RUNTIME_FAMILY, 'agy-stream-json');

  assert.equal(resolveAgyBuiltinRuntimeFamily(), 'agy-acp');
  assert.equal(resolveAgyBuiltinRuntimeFamily({ fallback: true }), 'agy-stream-json');
  assert.equal(resolveAgyBuiltinRuntimeFamily({ runtimeFamily: 'agy-stream-json' }), 'agy-stream-json');
  assert.equal(resolveAgyBuiltinRuntimeFamily({ runtimeFamily: 'agy-json' }), 'agy-json');
  assert.equal(resolveAgyBuiltinRuntimeFamily({
    environment: { RAGENT_AGY_RUNTIME_FAMILY: 'agy-stream-json' },
  }), 'agy-stream-json');
  assert.equal(resolveAgyBuiltinRuntimeFamily({
    fallback: true,
    environment: { RAGENT_AGY_RUNTIME_FAMILY: 'agy-acp' },
  }), 'agy-acp');
  assert.equal(resolveAgyBuiltinRuntimeFamily({
    fallback: false,
    environment: { RAGENT_AGY_RUNTIME_FAMILY: 'unexpected-family' },
  }), 'agy-acp');

  invalidateAvailableToolsCache();
  const available = await getAvailableTools();
  const agy = available.find((tool) => tool.id === 'agy');
  assert.ok(agy, 'agy built-in tool must be present');
  assert.equal(agy.available, true);
  assert.equal(agy.command, 'agy');
  assert.equal(agy.provider, 'agy');
  assert.equal(agy.runtimeFamily, 'agy-acp');

  const agyCompat = available.find((tool) => tool.id === 'agy-stream-json');
  assert.ok(agyCompat, 'agy-stream-json compatibility fallback must be present');
  assert.equal(agyCompat.available, true);
  assert.equal(agyCompat.command, 'agy');
  assert.equal(agyCompat.runtimeFamily, 'agy-stream-json');
  assert.equal(agyCompat.internalFallback, true);

  const publicTools = await getPublicAvailableToolsAsync();
  assert.equal(publicTools.some((tool) => tool.id === 'agy'), true, 'public catalog must include primary agy tool');
  assert.equal(publicTools.some((tool) => tool.id === 'agy-stream-json'), false, 'public catalog must hide internal agy-stream-json fallback');

  const resolvedAgy = await getToolDefinitionAsync('agy');
  assert.equal(resolvedAgy?.runtimeFamily, 'agy-acp');
  const resolvedAlias = await getToolDefinitionAsync('antigravity');
  assert.equal(resolvedAlias?.id, 'agy');
  assert.equal(resolvedAlias?.runtimeFamily, 'agy-acp');
  const resolvedCompat = await getToolDefinitionAsync('agy-stream-json');
  assert.equal(resolvedCompat?.id, 'agy-stream-json');
  assert.equal(resolvedCompat?.runtimeFamily, 'agy-stream-json');
  assert.equal(resolvedCompat?.internalFallback, true);

  assert.equal(await isToolValid('agy'), true);
  assert.equal(await isToolValid('antigravity'), true);
  assert.equal(await isToolValid('agy-stream-json'), true);

  process.env.RAGENT_AGY_RUNTIME_FAMILY = 'agy-stream-json';
  invalidateAvailableToolsCache();
  const compatDefaultTools = await getAvailableTools();
  assert.equal(
    compatDefaultTools.find((tool) => tool.id === 'agy')?.runtimeFamily,
    'agy-stream-json',
    'RAGENT_AGY_RUNTIME_FAMILY=agy-stream-json must switch default agy tool to compat runtime',
  );
  delete process.env.RAGENT_AGY_RUNTIME_FAMILY;
  invalidateAvailableToolsCache();
  assert.equal(
    (await getAvailableTools()).find((tool) => tool.id === 'agy')?.runtimeFamily,
    'agy-acp',
  );

  const customSaved = await saveSimpleToolAsync({
    name: 'Custom AgY ACP',
    command: 'custom-agy-acp',
    runtimeFamily: 'agy-acp',
    models: ['gemini-4-neon'],
  });
  assert.equal(customSaved.runtimeFamily, 'agy-acp');
  assert.equal(customSaved.available, true);
  const customLoaded = await getToolDefinitionAsync(customSaved.id);
  assert.equal(customLoaded?.runtimeFamily, 'agy-acp');
  assert.equal(customLoaded?.command, 'custom-agy-acp');

  console.log('test-tools-agy-runtime: ok');
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  rmSync(tempRoot, { recursive: true, force: true });
}
