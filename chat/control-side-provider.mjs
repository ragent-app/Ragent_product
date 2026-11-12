// Provider binding for control-side background calls. Static credentials get
// isolated homes; rotating Codex OAuth borrows the canonical owner over IPC.
//
// Session labels, task cards, and pre-compaction extractors run in the chat
// service rather than a detached runner.  They must still use the parent
// session's provider snapshot; using CLAUDE_MANAGED_HOME_DIR here caused a
// background title request to inherit whichever account happened to be global.

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { CONFIG_DIR, CODEX_MANAGED_HOME_DIR } from '../lib/config.mjs';
import { prepareNativeRunProviderHome } from '../lib/provider-runtime/run-provider-prepare.mjs';

function text(value, maxLength = 256) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function scopedProviderId(model) {
  const raw = text(model);
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return '';
  const candidate = raw.slice(at + 1);
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : '';
}

export function isClaudeControlRuntime(tool, runtimeFamily = '') {
  const normalizedTool = text(tool);
  const normalizedRuntime = text(runtimeFamily);
  return normalizedTool === 'claude' || normalizedTool === 'claude-bidi'
    || normalizedRuntime.startsWith('claude-');
}

// Returns null for legacy/non-native Claude calls without a selected provider.
// New native rows always have an explicit provider id (from session metadata or
// the model@provider catalog key), so they cannot silently fall back to a
// shared account.
export async function prepareControlSideNativeProvider({
  tool,
  runtimeFamily = '',
  model = '',
  providerProfile = '',
  claudeModelContract = null,
  resolveProviderBinding = false,
  configDir = CONFIG_DIR,
  providerHomesRoot = configDir === CONFIG_DIR ? dirname(CODEX_MANAGED_HOME_DIR) : join(configDir, 'provider-runtime-homes'),
  prepareProviderHome = prepareNativeRunProviderHome,
} = {}) {
  const isClaude = isClaudeControlRuntime(tool, runtimeFamily);
  const isCodex = text(tool) === 'codex' || text(runtimeFamily).startsWith('codex-');
  if (!isClaude && !isCodex) return null;
  const selectedProvider = text(providerProfile) || scopedProviderId(model);
  if (!selectedProvider && !resolveProviderBinding && !isCodex) return null;

  const controlRoot = join(configDir, 'provider-runtime-homes', isClaude ? 'control-claude' : 'control-codex');
  const operationId = `control-${randomBytes(16).toString('hex')}`;
  const manifest = {
    tool: text(tool) || (isClaude ? 'claude' : 'codex'),
    runtimeFamily: text(runtimeFamily),
    options: {
      runtimeFamily: text(runtimeFamily),
      model: text(model),
      providerProfile: selectedProvider,
      ...(claudeModelContract ? { claudeModelContract } : {}),
    },
  };
  const prepared = await prepareProviderHome(operationId, manifest, {
    configDir,
    providerHomesRoot: controlRoot,
    externalOAuthOwnership: false,
    forceRunScopedHome: true,
    ...(isCodex ? { codexOAuthProviderHomesRoot: providerHomesRoot } : {}),
  });
  if (!prepared?.ok || !(isClaude ? prepared.claudeHomeDir : prepared.codexHomeDir)) {
    if (!isCodex && !selectedProvider && resolveProviderBinding) return null;
    throw new Error(`Control-side ${isClaude ? 'Claude' : 'Codex'} provider preparation failed: ${prepared?.error || prepared?.reason || 'unknown error'}`);
  }

  const safeRoot = resolve(controlRoot);
  const safeHome = resolve(prepared.homeDir);
  const sharedCodexOAuth = isCodex && prepared.oauthOwner === 'agentoc';
  const insideControlRoot = safeHome !== safeRoot && !relative(safeRoot, safeHome).startsWith('..');
  return {
    providerId: prepared.providerId,
    model: prepared.snapshot?.model || '',
    codexHomeDir: prepared.codexHomeDir || '',
    codexBroker: sharedCodexOAuth,
    codexAccountId: sharedCodexOAuth ? (prepared.oauthAccountId || '') : '',
    claudeHomeDir: prepared.claudeHomeDir,
    claudeHomeBridgeDir: prepared.claudeHomeDir,
    claudeModelContract: prepared.snapshot?.claudeModelContract || claudeModelContract || null,
    async cleanup() {
      if (sharedCodexOAuth) return;
      if (!insideControlRoot) return;
      await rm(safeHome, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    },
  };
}

// Compatibility for existing Claude label/compaction callers.
export async function prepareControlSideClaudeProvider(options = {}) {
  if (!isClaudeControlRuntime(options.tool, options.runtimeFamily)) return null;
  return prepareControlSideNativeProvider(options);
}
