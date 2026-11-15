// Select the implementation independently of per-Run filesystem/network policy.
// Unset preserves the upstream default. Never silently fall back to a weaker mode.
export function codexWindowsSandboxConfig({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return [];
  const mode = String(env.RAGENT_CODEX_WINDOWS_SANDBOX || '').trim();
  if (!mode) return [];
  if (!['elevated', 'unelevated'].includes(mode)) {
    throw Object.assign(new Error('Invalid configured Codex Windows sandbox implementation'), {
      code: 'CODEX_WINDOWS_SANDBOX_INVALID',
    });
  }
  return ['[windows]', `sandbox = ${JSON.stringify(mode)}`, ''];
}
