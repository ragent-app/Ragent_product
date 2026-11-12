import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { findManagedCodexRollout } from '../chat/codex-managed-rollout.mjs';

const root = await mkdtemp(join(tmpdir(), 'agentoc-rollout-test-'));
const id = '01a1cd82-5bcf-7e81-829a-336311e43ce4';
const name = `rollout-2026-11-12T10-00-00-${id}.jsonl`;
const sessions = join(root, 'sessions', '2026', '11', '12');
const archived = join(root, 'archived_sessions');
try {
  await mkdir(sessions, { recursive: true });
  await mkdir(archived);
  const file = join(sessions, name);
  await writeFile(file, JSON.stringify({type:'session_meta',payload:{id,base_instructions:'x'.repeat(200_000)}})+'\n');
  assert.equal((await findManagedCodexRollout(root, id)).toLowerCase(), file.toLowerCase());
  const decoy = join(root, 'decoy.jsonl');
  await writeFile(decoy, JSON.stringify({type:'session_meta',payload:{id}})+'\n');
  try { await symlink(decoy, join(archived, `link-${id}.jsonl`)); }
  catch (error) { if (!['EPERM','EACCES'].includes(error?.code)) throw error; }
  assert.equal((await findManagedCodexRollout(root, id)).toLowerCase(), file.toLowerCase());
  assert.equal(await findManagedCodexRollout(root, '../unsafe'), null);
  assert.equal(await findManagedCodexRollout('relative', id), null);
  await writeFile(join(archived, name), JSON.stringify({type:'session_meta',payload:{id:'different'}})+'\n');
  assert.equal((await findManagedCodexRollout(root, id)).toLowerCase(), file.toLowerCase());
  await writeFile(join(archived, name), JSON.stringify({type:'session_meta',payload:{id}})+'\n');
  await assert.rejects(findManagedCodexRollout(root, id), { code: 'CODEX_ROLLOUT_AMBIGUOUS' });
  console.log('test-codex-managed-rollout: ok');
} finally {
  const suffix = relative(tmpdir(), root);
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw Error('Unsafe fixture root');
  await rm(root, { recursive:true, force:true });
}
