// Account-scoped MCP definitions are authored by `codex mcp` in an isolated
// configuration home. The runtime consumes only its MCP tables, never the
// user's general Codex configuration or OAuth credentials.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { acquireNativeOAuthLock } from './oauth-lock.mjs';

export function managedCodexMcpHome(configDir, providerId, binding) {
  if (!configDir || typeof providerId !== 'string' || !providerId.trim() || !/^[a-f0-9]{64}$/.test(binding || '')) {
    throw new Error('Verified provider and account are required');
  }
  // Profiles for the same account share one native broker; configuration must
  // converge for that account instead of changing as profiles take turns.
  return join(configDir, 'native-provider-runtime', 'codex-mcp', 'by-account', binding);
}

// Opaque binding prevents a provider profile that was re-used for another
// account from silently inheriting the previous account's MCP configuration.
export function managedCodexMcpAccountBinding(secret) {
  let identity = '';
  if (secret?.authType === 'oauth') {
    // A user id alone does not establish which ChatGPT account/workspace owns
    // the authorization; fail closed rather than merge workspace state.
    for (const key of ['account_id', 'accountId', 'account_uuid', 'accountUuid']) {
      if (typeof secret.tokens?.[key] === 'string' && secret.tokens[key].trim()) { identity = secret.tokens[key].trim(); break; }
    }
  } else if (secret?.authType === 'api-key' && typeof secret.apiKey === 'string') identity = secret.apiKey;
  if (!identity) return '';
  return createHash('sha256').update(`ragent-codex-mcp:${secret.authType}:${identity}`).digest('hex');
}

export async function ensureManagedCodexMcpBinding(home, binding, { initialize = false } = {}) {
  if (!binding) return false;
  const path = join(home, '.agentoc-account-binding');
  let existing;
  try { existing = (await readFile(path, 'utf8')).trim(); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (existing) return existing === binding;
  if (!initialize) return false;
  // Never claim an already-populated config whose account is unknown.
  const config = await readFile(join(home, 'config.toml'), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return ''; throw error;
  });
  if (config.trim()) return false;
  await writeFile(path, `${binding}\n`, { mode: 0o600, flag: 'wx' });
  return true;
}

export async function withManagedCodexMcpLock(configDir, providerId, binding, action, { create = false } = {}) {
  const home = managedCodexMcpHome(configDir, providerId, binding);
  if (create) await mkdir(home, { recursive: true, mode: 0o700 });
  else {
    try { await stat(join(home, 'config.toml')); }
    catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
  }
  const lock = await acquireNativeOAuthLock(join(home, '.agentoc-mcp-config.lock'), { waitMs: 15_000 });
  try { return await action(home); } finally { await lock.release(); }
}

export async function readManagedCodexMcpConfig(configDir, providerId, binding) {
  if (!binding) return '';
  return withManagedCodexMcpLock(configDir, providerId, binding, async (home) => {
    if (!await ensureManagedCodexMcpBinding(home, binding)) return '';
    const content = await readFile(join(home, 'config.toml'), 'utf8');
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) throw new Error('Codex MCP configuration is too large');
    let inMcpTable = false;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[')) {
        if (!/^\[mcp_servers\.[^\]\r\n]+\]\s*(?:#.*)?$/.test(trimmed)) {
          throw new Error('Unexpected table in managed Codex MCP configuration');
        }
        inMcpTable = true;
      } else if (!inMcpTable) {
        throw new Error('Unexpected top-level managed Codex MCP configuration');
      }
    }
    return content.trim();
  });
}
