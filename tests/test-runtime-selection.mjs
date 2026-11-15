#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-runtime-selection-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

try {
  const {
    loadUiRuntimeSelection,
    saveUiRuntimeSelection,
  } = await import(pathToFileURL(join(repoRoot, 'lib', 'runtime-selection.mjs')).href);

  assert.equal(await loadUiRuntimeSelection(), null);

  const first = await saveUiRuntimeSelection({
    selectedTool: 'claude',
    selectedModel: 'claude-sonnet-4-5',
    thinkingEnabled: true,
    reasoningKind: 'toggle',
  });
  assert.equal(first.selectedTool, 'claude');
  assert.equal(first.selectedModel, 'claude-sonnet-4-5');
  assert.equal(first.selectedEffort, '');
  assert.equal(first.thinkingEnabled, true);
  assert.equal(first.reasoningKind, 'toggle');

  const loadedFirst = await loadUiRuntimeSelection();
  assert.equal(loadedFirst?.selectedTool, 'claude');
  assert.equal(loadedFirst?.selectedModel, 'claude-sonnet-4-5');
  assert.equal(loadedFirst?.selectedEffort, '');
  assert.equal(loadedFirst?.thinkingEnabled, true);
  assert.equal(loadedFirst?.reasoningKind, 'toggle');

  const second = await saveUiRuntimeSelection({
    selectedTool: 'codex',
    selectedModel: 'gpt-5-codex',
    selectedEffort: 'high',
    selectedProviderProfile: 'provider-a',
    permissionMode: 'full-access',
    reasoningKind: 'enum',
    thinkingEnabled: true,
    interactionMode: 'plan',
  });
  assert.equal(second.selectedTool, 'codex');
  assert.equal(second.selectedModel, 'gpt-5-codex');
  assert.equal(second.selectedEffort, 'high');
  assert.equal(second.permissionMode, undefined, 'global runtime selection should not retain a session-scoped permission mode');
  assert.equal(second.thinkingEnabled, true);
  assert.equal(second.reasoningKind, 'enum');
  assert.equal(second.interactionMode, undefined, 'global runtime selection should not retain a session-scoped interaction mode');

  const loadedSecond = await loadUiRuntimeSelection();
  assert.equal(loadedSecond?.selectedTool, 'codex');
  assert.equal(loadedSecond?.selectedModel, 'gpt-5-codex');
  assert.equal(loadedSecond?.selectedEffort, 'high');
  assert.equal(loadedSecond?.selectedProviderProfile, 'provider-a');
  assert.equal(loadedSecond?.permissionMode, undefined, 'stored runtime selection should not leak permissions into other sessions');
  assert.equal(loadedSecond?.thinkingEnabled, true);
  assert.equal(loadedSecond?.reasoningKind, 'enum');
  assert.equal(loadedSecond?.interactionMode, undefined, 'stored runtime selection should not leak plan mode into other sessions');

  await assert.rejects(() => saveUiRuntimeSelection({ reasoningKind: 'toggle' }), /selectedTool is required/);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('runtime selection tests passed');
