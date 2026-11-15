import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { isManagedLearningProfileWrite } from '../chat/managed-memory-gate.mjs';

const root = mkdtempSync(join(tmpdir(), 'ragent-memory-gate-'));
try {
  const dir = join(root, 'model-context');
  mkdirSync(dir);
  const profile = join(dir, 'user-learning-profile.md');
  const approval = (path, tool = 'Write') => ({
    approvalId: 'claude:test', providerMethod: 'can_use_tool',
    params: { tool_name: tool, input: { file_path: path } },
  });
  assert.equal(isManagedLearningProfileWrite(approval(profile), dir), true);
  writeFileSync(profile, 'profile');
  assert.equal(isManagedLearningProfileWrite(approval(profile, 'Edit'), dir), true);
  assert.equal(isManagedLearningProfileWrite(approval(join(dir, 'preferences.md')), dir), false);
  assert.equal(isManagedLearningProfileWrite(approval(profile, 'Bash'), dir), false);
  assert.equal(isManagedLearningProfileWrite(approval(`${dir}${sep}nested${sep}..${sep}user-learning-profile.md`), dir), false);
  rmSync(profile);
  try {
    symlinkSync(join(root, 'elsewhere'), profile, 'file');
    assert.equal(isManagedLearningProfileWrite(approval(profile), dir), false);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  console.log('managed memory gate checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
