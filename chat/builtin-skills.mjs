import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'builtin-skills');
const ITEMS = Object.freeze({ 'ragent:builtin:session-control': Object.freeze({
  file: 'session-control.md', name: 'Ragent session control',
  description: 'Session, collaboration, organization, connector, and artifact API routing and boundaries.',
}),
  ...Object.fromEntries(['root', 'manager', 'worker', 'reviewer', 'calendar', 'swarm'].map((name) => [
    `ragent:builtin:${name}`,
    Object.freeze({ file: `${name}.md`, name: `Ragent ${name}`, description: `Authorized ${name} workflow guidance.` }),
  ])),
});
const error = (code, message) => Object.assign(new Error(message), { code, statusCode: 403 });

async function checkAuthorization(authorize, id) {
  if (typeof authorize !== 'function' || await authorize({ id, operation: 'read_builtin_skill' }) !== true) {
    throw error('BUILTIN_SKILL_FORBIDDEN', 'This run cannot read the requested skill.');
  }
}
async function content(id) {
  const item = ITEMS[id];
  if (!item) throw error('BUILTIN_SKILL_UNKNOWN', 'Unknown skill.');
  const root = await realpath(ROOT);
  const file = await realpath(join(root, item.file));
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw error('BUILTIN_SKILL_PATH_INVALID', 'Skill path is outside the trusted root.');
  const body = await readFile(file, 'utf8');
  if (!body.trim() || body.length > 48000) throw error('BUILTIN_SKILL_INVALID', 'Skill content is unavailable or too large.');
  return { item, body, contentHash: createHash('sha256').update(body, 'utf8').digest('hex') };
}
export async function listBuiltinSkills({ authorize } = {}) {
  const result = [];
  for (const id of Object.keys(ITEMS)) {
    try {
      await checkAuthorization(authorize, id);
      const { item, contentHash } = await content(id);
      result.push({ id, name: item.name, description: item.description, contentHash });
    } catch (error) { if (error?.code !== 'BUILTIN_SKILL_FORBIDDEN') throw error; }
  }
  return result;
}
export async function readBuiltinSkill({ id, expectedHash, authorize } = {}) {
  await checkAuthorization(authorize, id);
  const result = await content(id);
  if (expectedHash && expectedHash !== result.contentHash) throw error('BUILTIN_SKILL_CHANGED', 'Skill content changed; refresh the index.');
  return { id, name: result.item.name, contentHash: result.contentHash, content: result.body };
}
