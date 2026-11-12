import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCodexSkillPreferences, renderCodexSkillPreferences, saveCodexSkillPreference } from '../lib/provider-runtime/codex-skill-preferences.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-skill-pref-'));
const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
const pathA = join(root, 'skills', 'a', 'SKILL.md');
const pathB = join(root, 'skills', 'b', 'SKILL.md');
try {
  assert.deepEqual(await listCodexSkillPreferences(root, 'profile', first), []);
  await Promise.all([
    saveCodexSkillPreference(root, 'profile', first, pathA, false),
    saveCodexSkillPreference(root, 'other-profile', first, pathB, true),
  ]);
  let choices = await listCodexSkillPreferences(root, 'profile', first);
  assert.equal(choices.length, 2, 'concurrent writes must preserve both choices');
  assert.deepEqual(await listCodexSkillPreferences(root, 'profile', second), [], 'account changes must not inherit choices');
  assert.equal((await listCodexSkillPreferences(root, 'other-profile', first)).length, 2, 'profiles for the same account share Skill choices');
  await saveCodexSkillPreference(root, 'profile', first, pathA, true);
  choices = await listCodexSkillPreferences(root, 'profile', first);
  assert.equal(choices.find((item) => item.path === pathA).enabled, true);
  const rendered = renderCodexSkillPreferences(choices);
  assert.equal((rendered.match(/\[\[skills\.config\]\]/g) || []).length, 2);
  await assert.rejects(saveCodexSkillPreference(root, 'profile', first, 'relative/SKILL.md', false));
  await assert.rejects(saveCodexSkillPreference(root, 'profile', '', pathA, false));
  console.log('Codex Skill preference isolation tests passed');
} finally { await rm(root, { recursive: true, force: true }); }
