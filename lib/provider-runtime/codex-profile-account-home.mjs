import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireNativeOAuthLock } from './oauth-lock.mjs';
import { codexRolloutAccountId } from '../../chat/codex-managed-rollout.mjs';

// Keep a profile's original home bound to the first account that used it.
// A later login to a different account gets its own home and broker.
export async function resolveCodexProfileAccountHome({ configDir, providerHomeRoot, providerProfileId, accountId, initialize = false }) {
  if (typeof accountId !== 'string' || !accountId.trim()) return providerHomeRoot;
  const digest = (id) => createHash('sha256').update(`ragent-codex-account:${id}`).digest('hex');
  const profileKey = createHash('sha256').update(`codex:${providerProfileId}`).digest('hex').slice(0, 32);
  const directory = join(configDir, 'native-provider-runtime', 'codex-account-homes');
  const marker = join(directory, `${profileKey}.json`);
  const readPrimary = async () => {
    try {
      const primary = JSON.parse(await readFile(marker, 'utf8'))?.primary;
      if (!/^[a-f0-9]{64}$/.test(primary || '')) throw new Error('Invalid Codex account home marker');
      return primary;
    } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
  };
  let primary = await readPrimary();
  if (!primary && initialize) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const lock = await acquireNativeOAuthLock(`${marker}.lock`, { waitMs: 15000 });
    try {
      primary = await readPrimary();
      if (!primary) {
        let previous = '';
        try {
          previous = codexRolloutAccountId(JSON.parse(await readFile(join(providerHomeRoot, 'codex', 'auth.json'), 'utf8')));
          if (!previous) throw new Error('The existing Codex home has no verifiable account identity');
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        primary = digest(previous || accountId.trim());
        await writeFile(marker, `${JSON.stringify({ primary })}\n`, { mode: 0o644, flag: 'wx' });
      }
    } finally { await lock.release(); }
  }
  const current = digest(accountId.trim());
  return !primary || primary === current ? providerHomeRoot : join(providerHomeRoot, 'by-account', current.slice(0, 32));
}
