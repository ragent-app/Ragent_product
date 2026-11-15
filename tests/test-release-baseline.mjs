import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBaseline } from '../scripts/capture-release-baseline.mjs';

const root = mkdtempSync(join(tmpdir(), 'ragent-release-baseline-'));
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git('init');
  writeFileSync(join(root, 'package.json'), '{"name":"baseline-fixture"}\n');
  git('add', 'package.json');
  git('-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const clean = await captureBaseline({ repo: root, artifacts: [join(root, 'package.json')] });
  assert.equal(clean.consistency, 'stable');
  assert.equal(clean.source.dirty, false);
  assert.equal(clean.artifacts[0].sha256, clean.lockedInputs['package.json'].sha256);
  const secret = 'synthetic-secret-must-never-appear-in-captured-evidence';
  writeFileSync(join(root, 'package.json'), `{"fixture":"${secret}"}\n`);
  writeFileSync(join(root, 'untracked-fixture.txt'), secret);
  const dirty = await captureBaseline({ repo: root });
  assert.equal(dirty.source.dirty, true);
  assert.equal(dirty.consistency, 'stable');
  assert.notEqual(dirty.source.patchSha256, clean.source.patchSha256);
  assert.equal(Object.keys(dirty.source.workingFiles).length, 2);
  assert.equal(JSON.stringify(dirty).includes(secret), false);
  assert.notEqual(dirty.source.workingFiles['package.json'].sha256,
    clean.lockedInputs['package.json'].sha256);
  git('rm', '--force', 'package.json');
  const deleted = await captureBaseline({ repo: root });
  assert.equal(deleted.source.workingFiles['package.json'].type, 'deleted');
  assert.equal(readFileSync(join(root, 'untracked-fixture.txt'), 'utf8'), secret);
  console.log('release baseline: clean/dirty/deleted/untracked/artifact/redaction checks passed');
} finally {
  assert.ok(root.startsWith(join(tmpdir(), 'ragent-release-baseline-')));
  rmSync(root, { recursive: true, force: true });
}
