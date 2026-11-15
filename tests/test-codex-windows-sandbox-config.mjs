import assert from 'node:assert/strict';
import { codexWindowsSandboxConfig } from '../lib/provider-runtime/codex-windows-sandbox.mjs';
for (const mode of ['elevated', 'unelevated']) {
  assert.deepEqual(codexWindowsSandboxConfig({ platform: 'win32', env: { RAGENT_CODEX_WINDOWS_SANDBOX: mode } }),
    ['[windows]', `sandbox = "${mode}"`, '']);
}
assert.deepEqual(codexWindowsSandboxConfig({ platform: 'win32', env: {} }), []);
assert.deepEqual(codexWindowsSandboxConfig({ platform: 'linux', env: { RAGENT_CODEX_WINDOWS_SANDBOX: 'none' } }), []);
for (const mode of ['none', 'disabled', 'elevated"\nnetwork=true']) {
  assert.throws(() => codexWindowsSandboxConfig({ platform: 'win32', env: { RAGENT_CODEX_WINDOWS_SANDBOX: mode } }),
    { code: 'CODEX_WINDOWS_SANDBOX_INVALID' });
}
console.log('test-codex-windows-sandbox-config: ok');
