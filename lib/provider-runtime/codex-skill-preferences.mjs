// Ragent-owned Skill choices are separate from the generated Codex config.
// Callers must verify a skill against the native catalog before writing it.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { acquireNativeOAuthLock } from './oauth-lock.mjs';

export function codexSkillId(skillPath) {
  return `codex:skill:${createHash('sha256').update(String(skillPath)).digest('hex').slice(0, 20)}`;
}

function preferenceHome(configDir, providerId, binding) {
  if (!configDir || typeof providerId !== 'string' || !providerId.trim() || !/^[a-f0-9]{64}$/.test(binding || '')) {
    throw new Error('Verified provider and account are required');
  }
  // Multiple provider profiles may represent the same OAuth account and share
  // its broker. Their Skill settings must converge on the same account state.
  return join(configDir, 'native-provider-runtime', 'codex-skills', 'by-account', binding);
}

async function withPreferences(configDir, providerId, binding, action, create = false) {
  const home = preferenceHome(configDir, providerId, binding);
  if (create) await mkdir(home, { recursive: true, mode: 0o700 });
  else {
    try { await readFile(join(home, 'choices.json'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  const lock = await acquireNativeOAuthLock(join(home, '.lock'), { waitMs: 15_000 });
  try {
    let saved = { version: 1, choices: [] };
    try { saved = JSON.parse(await readFile(join(home, 'choices.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved?.version !== 1 || !Array.isArray(saved.choices) || saved.choices.length > 500
      || saved.choices.some((item) => typeof item?.path !== 'string' || !isAbsolute(item.path)
        || item.path.length > 4096 || typeof item.enabled !== 'boolean')) throw new Error('Invalid Codex Skill preferences');
    return await action(home, saved.choices);
  } finally { await lock.release(); }
}

export async function listCodexSkillPreferences(configDir, providerId, binding) {
  if (!binding) return [];
  return withPreferences(configDir, providerId, binding, async (_home, choices) => choices);
}

export async function saveCodexSkillPreference(configDir, providerId, binding, skillPath, enabled) {
  if (typeof skillPath !== 'string' || !isAbsolute(skillPath) || skillPath.length > 4096 || typeof enabled !== 'boolean') {
    throw new Error('Invalid Codex Skill preference');
  }
  return withPreferences(configDir, providerId, binding, async (home, choices) => {
    const next = choices.filter((item) => item.path !== skillPath);
    next.push({ path: skillPath, enabled });
    if (next.length > 500) throw new Error('Too many Codex Skill preferences');
    const file = join(home, 'choices.json');
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, choices: next })}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
    return { id: codexSkillId(skillPath), enabled };
  }, true);
}

export function renderCodexSkillPreferences(choices) {
  return choices.flatMap(({ path, enabled }) => ['[[skills.config]]', `path = ${JSON.stringify(path)}`, `enabled = ${enabled}`, '']).join('\n');
}
