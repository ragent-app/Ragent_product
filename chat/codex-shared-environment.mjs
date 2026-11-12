// The shared Codex process must not retain the first run's capability tokens.
// Its shell children receive their own run values via thread configuration.
const INTERNAL_KEY = /^AGENTOC_(?:CODEX_BROKER_|NATIVE_OAUTH_LOCK_)/i;

export function buildSharedCodexProcessEnvironment(env = {}, { basePath = '', hookSocket = '' } = {}) {
  const result = Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    value != null && !/^AGENTOC_/i.test(key) && (!basePath || key.toUpperCase() !== 'PATH')));
  if (basePath) result.PATH = basePath;
  if (hookSocket) result.AGENTOC_CODEX_BROKER_SOCKET = hookSocket;
  return result;
}

export function buildCodexRunShellEnvironment(env = {}) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    typeof value === 'string' && value.length > 0 &&
    (key.toUpperCase() === 'PATH' || (/^AGENTOC_/i.test(key) && !INTERNAL_KEY.test(key)))));
}
