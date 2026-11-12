import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { retryManagedCodexRolloutResume } from '../chat/runner-sidecar.mjs';

test('missing index resumes the verified rollout before creating a fresh thread', async (t) => {
  const parent = resolve(tmpdir());
  const home = await mkdtemp(join(parent, 'ragent-rollout-resume-'));
  t.after(async () => {
    const suffix = relative(parent, home);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(home, { recursive: true, force: true });
  });
  const id = '12345678-1234-1234-1234-123456789abc';
  const folder = join(home, 'sessions', '2026', '11', '12');
  await mkdir(folder, { recursive: true });
  const rollout = join(folder, `rollout-2026-11-12T00-00-00-${id}.jsonl`);
  await writeFile(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
  const sent = [];
  const proc = { stdin: { writable: true, write: (data) => sent.push(JSON.parse(data)) } };
  const state = { useResume: true, threadId: id, nextControlRequestId: 50, threadRequestSent: true, cwd: home,
    model: 'fixture', permissionMode: 'never-read-only' };
  assert.equal(await retryManagedCodexRolloutResume(proc, state, home), true);
  assert.equal(sent[0].method, 'thread/resume');
  assert.equal(sent[0].params.threadId, id);
  assert.equal(sent[0].params.path.toLowerCase(), rollout.toLowerCase());
  assert.equal(await retryManagedCodexRolloutResume(proc, state, home), false);
  assert.equal(sent.length, 1);
});

test('ambiguous rollout matches fail closed without starting another thread', async () => {
  const sent = [];
  const proc = { stdin: { writable: true, write: (data) => sent.push(data) } };
  const state = { useResume: true, threadId: 'fixture', nextControlRequestId: 50, threadRequestSent: true };
  await assert.rejects(retryManagedCodexRolloutResume(proc, state, tmpdir(), async () => {
    throw Object.assign(new Error('ambiguous'), { code: 'CODEX_ROLLOUT_AMBIGUOUS' });
  }), { code: 'CODEX_ROLLOUT_AMBIGUOUS' });
  assert.equal(sent.length, 0);
});

test('a verified source home restores the original thread after account migration', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-rollout-sources-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const canonical = join(root, 'canonical', 'codex');
  const oldRoot = join(root, 'old');
  const oldHome = join(oldRoot, 'codex');
  const folder = join(oldHome, 'sessions', '2026', '11', '12');
  await mkdir(canonical, { recursive: true });
  await mkdir(folder, { recursive: true });
  for (const home of [canonical, oldHome]) await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a' } }));
  const id = '12345678-1234-1234-1234-123456789abc';
  const rollout = join(folder, `rollout-${id}.jsonl`);
  await writeFile(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
  const sent = [];
  const proc = { stdin: { writable: true, write: (data) => sent.push(JSON.parse(data)) } };
  const state = { useResume: true, threadId: id, nextControlRequestId: 50, threadRequestSent: true, cwd: root, model: 'fixture' };
  assert.equal(await retryManagedCodexRolloutResume(proc, state, canonical, undefined, [oldRoot]), true);
  assert.equal(sent[0].params.path.toLowerCase(), rollout.toLowerCase());
});
