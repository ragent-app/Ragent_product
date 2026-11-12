// Native Plugin loading is distinct from the unsupported Plugin management RPC.
// Store only an explicit account-scoped preference, never credentials.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireNativeOAuthLock } from './oauth-lock.mjs';

function preferenceDir(configDir, binding) {
  if (!configDir || !/^[a-f0-9]{64}$/.test(binding || '')) throw new Error('Verified Codex account required');
  return join(configDir, 'native-provider-runtime', 'codex-plugin-settings', 'by-account', binding);
}

export async function readCodexPluginPreferenceState(configDir, binding) {
  if (!binding) return { enabled: false, revision: '' };
  const path = join(preferenceDir(configDir, binding), 'settings.json');
  let settings;
  try { settings = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return { enabled: false, revision: '' }; throw error; }
  if (settings?.version !== 1 || typeof settings.enabled !== 'boolean'
    || (settings.revision !== undefined && !/^[a-f0-9-]{36}$/.test(settings.revision))) throw new Error('Invalid Codex Plugin preference');
  return { enabled: settings.enabled, revision: settings.revision || '' };
}

export async function readCodexPluginPreference(configDir, binding) {
  return (await readCodexPluginPreferenceState(configDir, binding)).enabled;
}

export async function writeCodexPluginPreference(configDir, binding, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid Codex Plugin preference');
  const dir = preferenceDir(configDir, binding);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = await acquireNativeOAuthLock(join(dir, '.lock'), { waitMs: 15_000 });
  const file = join(dir, 'settings.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const current = await readCodexPluginPreferenceState(configDir, binding);
    const revision = current.enabled === enabled && current.revision ? current.revision : randomUUID();
    await writeFile(temporary, `${JSON.stringify({ version: 1, enabled, revision })}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    try { await unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; }); }
    finally { await lock.release(); }
  }
  return enabled;
}
