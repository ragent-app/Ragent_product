#!/usr/bin/env node
// P1c-2b (design §13–§14, Path G): ordinary sessions default the per-session
// `privilegedMode` flag ON, remain patchable via updateSessionRuntimePreferences,
// and drive the gated permission resolution at run-start. This test covers the
// session-flag lifecycle + the end-to-end resolution contract. The resolver
// unit itself is also covered by test-provider-contract.mjs; this test proves
// the session layer wires into it.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-privileged-mode-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');

const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });

const {
  createSession,
  getSession,
  killAll,
  resolveSessionRiskModeForRun,
  updateSessionRuntimePreferences,
} = await import('../chat/session-manager.mjs');
const { resolveProviderPermissionPolicy } = await import('../chat/provider-contract.mjs');

try {
  // --- default-ON: an ordinary fresh session explicitly carries the flag ---
  const created = await createSession(workspace, 'claude-bidi', 'Privileged mode test');
  const fresh = await getSession(created.id);
  assert.equal(fresh.privilegedMode, true, 'an ordinary fresh session must default privilegedMode ON');

  // --- patching privilegedMode ON persists and survives reload ---
  const enabled = await updateSessionRuntimePreferences(created.id, { privilegedMode: true });
  assert.equal(enabled.privilegedMode, true, 'patching privilegedMode=true should persist the flag');
  const reloadedOn = await getSession(created.id);
  assert.equal(reloadedOn.privilegedMode, true, 'privilegedMode=true should survive reload');

  // --- patching privilegedMode OFF clears it (absent, not literal false) ---
  const disabled = await updateSessionRuntimePreferences(created.id, { privilegedMode: false });
  assert.equal(disabled.privilegedMode, undefined, 'patching privilegedMode=false should clear the flag');
  const reloadedOff = await getSession(created.id);
  assert.equal(reloadedOff.privilegedMode, undefined, 'cleared privilegedMode should survive reload');

  // --- defensive: only the literal boolean true enables; any other value clears ---
  await updateSessionRuntimePreferences(created.id, { privilegedMode: true });
  const clearedViaString = await updateSessionRuntimePreferences(created.id, { privilegedMode: 'true' });
  assert.equal(clearedViaString.privilegedMode, undefined, 'a non-boolean value must NOT enable privilegedMode');

  // --- a privilegedMode-only patch is not treated as a no-op ---
  await updateSessionRuntimePreferences(created.id, { privilegedMode: true });
  assert.equal((await getSession(created.id)).privilegedMode, true, 'a privilegedMode-only patch must take effect');
  const onlyOff = await updateSessionRuntimePreferences(created.id, { privilegedMode: false });
  assert.equal(onlyOff.privilegedMode, undefined, 'a privilegedMode-only clear patch must take effect');

  // --- end-to-end resolution contract (explicit OFF vs default ON) ---
  // Explicit OFF still reproduces the normal provider default.
  const offPolicy = resolveProviderPermissionPolicy('claude-stream-json-bidi', {
    privilegedMode: false,
  });
  assert.equal(offPolicy?.claudePermissionMode, 'bypassPermissions',
    'privilegedMode OFF must reproduce the normal provider default');

  // Claude bidi maps the retired `default` gate to Claude Code's supported
  // `default` mode, so a privileged session cannot silently bypass Ragent's
  // danger-operation approval path.
  await updateSessionRuntimePreferences(created.id, { privilegedMode: true });
  const onSession = await getSession(created.id);
  const onPolicy = resolveProviderPermissionPolicy('claude-stream-json-bidi', {
    privilegedMode: onSession.privilegedMode === true,
    permissionMode: 'bypassPermissions',
  });
  assert.equal(onPolicy?.claudePermissionMode, 'default',
    'privilegedMode ON must use Claude Code\'s supported default gate');

  // --- unsupported runtime with flag ON falls through to normal resolution (no-op, not an error) ---
  const unsupported = resolveProviderPermissionPolicy('claude-stream-json', {
    privilegedMode: true,
  });
  assert.equal(unsupported?.claudePermissionMode, 'bypassPermissions',
    'an unsupported runtime must fall through to normal resolution even with privilegedMode ON');

  // ==================== riskMode (统一风险门控计划 phase 3) ====================

  // --- a fresh session defaults to autonomous execution ---
  assert.equal(fresh.riskMode, 'full-auto',
    'a fresh session must default riskMode to "full-auto"');
  const defaultPolicy = resolveProviderPermissionPolicy('claude-stream-json-bidi', {
    riskMode: fresh.riskMode,
  });
  assert.equal(defaultPolicy?.claudePermissionMode, 'bypassPermissions',
    'a fresh Claude Bidi session must resolve to bypassPermissions');
  const defaultCodexPolicy = resolveProviderPermissionPolicy('codex-app-server-json', {
    privilegedMode: fresh.privilegedMode,
    riskMode: fresh.riskMode,
  });
  assert.equal(defaultCodexPolicy?.approvalPolicy, 'never',
    'a fresh session must use Codex App Server never approval');
  assert.equal(defaultCodexPolicy?.sandbox, 'danger-full-access',
    'a fresh session must use the gated Codex full-access sandbox');

  // --- explicit riskMode patch persists and survives reload ---
  const patchedSafe = await updateSessionRuntimePreferences(created.id, { riskMode: 'safe' });
  assert.equal(patchedSafe.riskMode, 'safe', 'patching riskMode=safe should persist');
  assert.equal((await getSession(created.id)).riskMode, 'safe', 'riskMode=safe should survive reload');
  await updateSessionRuntimePreferences(created.id, { riskMode: 'full-auto' });
  assert.equal((await getSession(created.id)).riskMode, 'full-auto',
    'riskMode=full-auto should remain selectable');
  assert.equal(resolveSessionRiskModeForRun(await getSession(created.id)), 'full-auto',
    'an explicitly selected full-auto mode must remain an opt-out');
  assert.equal((await getSession(created.id)).riskModeExplicit, true,
    'an explicit full-auto selection must persist its opt-out marker');

  // --- invalid riskMode values are rejected (ignored, no crash) ---
  await updateSessionRuntimePreferences(created.id, { riskMode: 'banana' });
  assert.equal((await getSession(created.id)).riskMode, 'full-auto',
    'an invalid riskMode value must be ignored');

  // --- clearing riskMode deletes the field (derived default at run-launch) ---
  await updateSessionRuntimePreferences(created.id, { riskMode: '' });
  assert.equal((await getSession(created.id)).riskMode, undefined,
    'clearing riskMode should remove the field so the derived default applies');

  assert.equal(resolveSessionRiskModeForRun({ riskMode: 'full-auto' }), 'recommended',
    'a legacy unmarked full-auto value must migrate to the gated default');

  // --- legacy shim: privilegedMode ON now also sets riskMode 'safe' ---
  const shimmed = await updateSessionRuntimePreferences(created.id, { privilegedMode: true });
  assert.equal(shimmed.riskMode, 'safe',
    'privilegedMode=true must shim riskMode to "safe" under the unified model');
  assert.equal(shimmed.privilegedMode, true, 'the legacy privilegedMode flag itself must persist');

  // --- explicit riskMode in the same patch wins over the shim ---
  const shimOverridden = await updateSessionRuntimePreferences(created.id, { privilegedMode: true, riskMode: 'full-auto' });
  assert.equal(shimOverridden.riskMode, 'full-auto',
    'an explicit riskMode in the same patch must win over the privilegedMode shim');

  // --- end-to-end resolution: Claude bidi is gated for safe/recommended ---
  await updateSessionRuntimePreferences(created.id, { riskMode: 'safe' });
  const riskOnSession = await getSession(created.id);
  const riskOnPolicy = resolveProviderPermissionPolicy('claude-stream-json-bidi', {
    riskMode: riskOnSession.riskMode,
  });
  assert.equal(riskOnPolicy?.claudePermissionMode, 'default',
    'safe/recommended must use Claude Code\'s supported default gate');
  const riskFullPolicy = resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'full-auto' });
  assert.equal(riskFullPolicy?.claudePermissionMode, 'bypassPermissions',
    'riskMode full-auto must remain selectable as the provider bypass mode');
  console.log('test-session-privileged-mode: ok');
} finally {
  await killAll();
  rmSync(home, { recursive: true, force: true });
}
