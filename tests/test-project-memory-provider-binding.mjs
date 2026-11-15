#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareControlSideNativeProvider } from '../chat/control-side-provider.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-memory-binding-'));
try {
  const calls = [];
  const prepareProviderHome = async (operationId, manifest, options) => {
    const homeDir = join(options.providerHomesRoot, operationId);
    await mkdir(homeDir, { recursive: true });
    calls.push({ manifest, options });
    return {
      ok: true, providerId: manifest.options.providerProfile || 'default-native', homeDir,
      ...(manifest.tool === 'codex' ? { codexHomeDir: join(homeDir, 'codex') } : { claudeHomeDir: join(homeDir, 'claude') }),
      snapshot: { model: 'provider-default-model' },
    };
  };
  const codex = await prepareControlSideNativeProvider({
    tool: 'codex', providerProfile: 'source-provider', resolveProviderBinding: true,
    configDir: root, prepareProviderHome,
  });
  assert.equal(calls[0].manifest.options.providerProfile, 'source-provider');
  assert.equal(calls[0].options.forceRunScopedHome, true);
  assert.equal(codex.model, 'provider-default-model');
  assert.match(codex.codexHomeDir, /control-codex/);
  await codex.cleanup();

  const implicit = await prepareControlSideNativeProvider({
    tool: 'codex', resolveProviderBinding: true, configDir: root, prepareProviderHome,
  });
  assert.equal(calls[1].manifest.options.providerProfile, '');
  assert.equal(implicit.providerId, 'default-native');
  await implicit.cleanup();
  await assert.rejects(() => prepareControlSideNativeProvider({
    tool: 'codex', resolveProviderBinding: true, configDir: root,
    prepareProviderHome: async () => ({ ok: false, reason: 'no-native-profile' }),
  }), /provider preparation failed/, 'Codex must not fall back to a second legacy OAuth owner');
  await assert.rejects(() => prepareControlSideNativeProvider({
    tool: 'codex', providerProfile: 'source-provider', configDir: root,
    prepareProviderHome: async () => ({ ok: false, reason: 'bad-profile' }),
  }), /provider preparation failed/, 'an explicit binding must fail closed');

  const claude = await prepareControlSideNativeProvider({
    tool: 'claude', providerProfile: 'claude-source', configDir: root, prepareProviderHome,
  });
  assert.equal(calls[2].manifest.options.providerProfile, 'claude-source');
  assert.match(claude.claudeHomeDir, /control-claude/);
  await claude.cleanup();
  const defaultCodex = await prepareControlSideNativeProvider({ tool: 'codex', configDir: root, prepareProviderHome });
  assert.equal(defaultCodex.providerId, 'default-native');
  await defaultCodex.cleanup();
  console.log('test-project-memory-provider-binding: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
