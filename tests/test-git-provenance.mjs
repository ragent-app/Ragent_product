#!/usr/bin/env node
// Git provenance capture (design 6.3): read-only git, hooks/external-diff/
// textconv disabled, streaming diff hash (never materialized), bounded
// timeout/output -> partial (never fakes clean), untracked v1 manifest hash,
// detached HEAD, non-git workspace, and injectable spawn for timeout/failure.
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, win32 } from 'path';
import { spawn as realSpawn } from 'child_process';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-git-prov-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const {
  collectGitProvenance,
  hashUntrackedManifest,
  setGitProvenanceSpawn,
  resetGitProvenanceSpawn,
  GIT_PROVENANCE_DEFAULT_TIMEOUT_MS,
} = await import('../chat/git-provenance.mjs');

const createdDirs = [];
function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function initRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@ragent.local']);
  git(dir, ['config', 'user.name', 'Ragent Test']);
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=test@ragent.local', '-c', 'user.name=Ragent Test', 'commit', '-q', '-m', message]);
}

function makeFakeChild({ stdoutText = '', stderrText = '', exitCode = 0, error = null, hang = false }) {
  const child = new EventEmitter();
  child.stdout = { on: (event, cb) => { if (event === 'data' && stdoutText) cb(Buffer.from(stdoutText)); } };
  child.stderr = { on: (event, cb) => { if (event === 'data' && stderrText) cb(Buffer.from(stderrText)); } };
  child.kill = (signal) => {
    child.killedSignal = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  if (hang) return child;
  queueMicrotask(() => {
    if (error) child.emit('error', error);
    else child.emit('close', exitCode);
  });
  return child;
}

try {
  assert.equal(GIT_PROVENANCE_DEFAULT_TIMEOUT_MS, 5000, 'default timeout should be 5000ms');

  // ── hashUntrackedManifest: pure manifest over porcelain text ─────────────
  const emptyManifest = hashUntrackedManifest('');
  assert.ok(emptyManifest.startsWith('sha256:'), 'untracked manifest should be sha256-prefixed');
  assert.equal(hashUntrackedManifest(''), emptyManifest, 'empty porcelain should hash the empty manifest');
  assert.equal(
    hashUntrackedManifest('?? b.txt\n?? a.txt\n'),
    hashUntrackedManifest('?? a.txt\n?? b.txt\n'),
    'untracked manifest should be order-independent',
  );
  assert.notEqual(
    hashUntrackedManifest('?? a.txt\n'),
    hashUntrackedManifest('?? a.txt\n?? b.txt\n'),
    'different untracked sets should produce different manifests',
  );
  assert.equal(
    hashUntrackedManifest(' M tracked.txt\n?? a.txt\n'),
    hashUntrackedManifest('?? a.txt\n'),
    'tracked-only porcelain lines should not enter the untracked manifest',
  );

  // ── real repo: clean / dirty / untracked / detached HEAD ─────────────────
  const repo = makeDir('ragent-git-prov-repo-');
  initRepo(repo);
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  commitAll(repo, 'init');

  const clean = await collectGitProvenance(repo);
  assert.equal(clean.state, 'available');
  assert.equal(clean.dirty, false, 'a clean tree must not be dirty');
  assert.equal(clean.partial, false);
  assert.ok(clean.repositoryRoot, 'repositoryRoot should be reported');
  assert.ok(clean.branch && clean.branch !== 'HEAD', 'a named branch should be reported');
  assert.match(clean.headCommit, /^[0-9a-f]{40}$/, 'headCommit should be a full sha');
  assert.equal(clean.baseCommit, clean.headCommit, 'v1 baseCommit equals headCommit (diff base is HEAD)');

  if (process.platform === 'win32') {
    // CreateProcess resolves a bare git name from the cwd before PATH. A copy
    // of Node is a harmless executable that demonstrates this shadowing.
    const shadow = join(repo, 'git.exe');
    copyFileSync(process.execPath, shadow);
    try {
      assert.equal(git(repo, ['--version']).trim(), process.version, 'fixture must shadow the bare Git executable');
      const capture = await collectGitProvenance(repo);
      assert.equal(capture.state, 'available', 'background capture must use Git outside the workspace');
      assert.equal(capture.headCommit, clean.headCommit);
      const pathName = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
      assert.ok(pathName, 'Windows PATH must be available for the fixture');
      const withWorkspacePath = await collectGitProvenance(repo, { env: { PATH: `${repo};${process.env[pathName]}` } });
      assert.equal(withWorkspacePath.state, 'available', 'workspace PATH entry must not select the shadow executable');
      assert.equal(withWorkspacePath.headCommit, clean.headCommit);
    } finally { unlinkSync(shadow); }
  }
  assert.ok(clean.trackedDiffHash.startsWith('sha256:'), 'trackedDiffHash should be present even when clean');

  const cleanAgain = await collectGitProvenance(repo);
  assert.equal(cleanAgain.trackedDiffHash, clean.trackedDiffHash, 'same state twice should hash identically');
  assert.equal(cleanAgain.untrackedManifestHash, clean.untrackedManifestHash, 'same untracked state twice should hash identically');

  // dirty tracked tree
  writeFileSync(join(repo, 'a.txt'), 'hello\nworld\n');
  const dirty = await collectGitProvenance(repo);
  assert.equal(dirty.state, 'available');
  assert.equal(dirty.dirty, true, 'a modified tracked file must mark the tree dirty');
  assert.notEqual(dirty.trackedDiffHash, clean.trackedDiffHash, 'a different diff must produce a different hash');

  // untracked file only (restore tracked file first)
  git(repo, ['checkout', '--', 'a.txt']);
  writeFileSync(join(repo, 'u.txt'), 'untracked\n');
  const untracked = await collectGitProvenance(repo);
  assert.equal(untracked.state, 'available');
  assert.equal(untracked.dirty, true, 'an untracked file must mark the tree dirty');
  assert.equal(untracked.trackedDiffHash, clean.trackedDiffHash, 'clean tracked diff should keep the empty-diff hash');
  assert.notEqual(untracked.untrackedManifestHash, clean.untrackedManifestHash, 'untracked manifest should change');

  writeFileSync(join(repo, 'u2.txt'), 'untracked2\n');
  const untracked2 = await collectGitProvenance(repo);
  assert.notEqual(untracked2.untrackedManifestHash, untracked.untrackedManifestHash, 'adding another untracked file must change the manifest hash');

  // detached HEAD
  git(repo, ['checkout', '-q', '--detach']);
  const detached = await collectGitProvenance(repo);
  assert.equal(detached.state, 'available');
  assert.equal(detached.branch, null, 'detached HEAD should report branch=null');
  assert.ok(detached.headCommit, 'detached HEAD should still report headCommit');

  // ── non-git directory / unborn HEAD ──────────────────────────────────────
  const plain = makeDir('ragent-git-prov-plain-');
  const notGit = await collectGitProvenance(plain);
  assert.equal(notGit.state, 'not_git', 'a directory without .git should be not_git');
  assert.equal(notGit.partial, false);

  const unborn = makeDir('ragent-git-prov-unborn-');
  git(unborn, ['init', '-q']);
  const unbornResult = await collectGitProvenance(unborn);
  assert.equal(unbornResult.state, 'partial', 'a repo with no commits cannot produce provenance');
  assert.equal(unbornResult.partial, true);
  assert.equal(unbornResult.reason, 'unborn-head');

  // ── hooks must never run; read-only flags must be present ────────────────
  const hooksDir = join(repo, 'hooks');
  mkdirSync(hooksDir);
  const hookMarker = join(repo, 'hook-ran.txt');
  const hookScript = join(hooksDir, 'pre-commit');
  writeFileSync(hookScript, '#!/bin/sh\ntouch hook-ran.txt\n');
  chmodSync(hookScript, 0o755);
  git(repo, ['config', 'core.hooksPath', hooksDir]);
  // Git's fsmonitor is a separate executable hook, not covered by hooksPath.
  // First prove this actual Git invokes our harmless fixture on status, then
  // ensure Ragent's background read-only capture does not invoke it.
  const fsmonitorMarker = join(repo, 'fsmonitor-ran.txt');
  const fsmonitorScript = join(repo, '.git', 'fsmonitor-fixture');
  writeFileSync(fsmonitorScript, '#!/bin/sh\necho invoked > fsmonitor-ran.txt\nexit 0\n');
  chmodSync(fsmonitorScript, 0o755);
  git(repo, ['config', 'core.fsmonitor', '.git/fsmonitor-fixture']);
  git(repo, ['status', '--porcelain']);
  assert.equal(existsSync(fsmonitorMarker), true, 'fixture must demonstrate fsmonitor execution');
  unlinkSync(fsmonitorMarker);

  const seenSpawns = [];
  const wrappingSpawn = (command, args, options) => {
    seenSpawns.push({ command, args, env: options?.env || {} });
    return realSpawn(command, args, options);
  };
  setGitProvenanceSpawn(wrappingSpawn);
  await collectGitProvenance(repo);
  resetGitProvenanceSpawn();
  assert.ok(seenSpawns.length >= 3, 'provenance should spawn several git commands');
  for (const entry of seenSpawns) {
    if (process.platform === 'win32') {
      assert.ok(win32.isAbsolute(entry.command), 'Windows capture must spawn an absolute Git path');
      assert.equal(win32.basename(entry.command).toLowerCase(), 'git.exe');
      assert.notEqual(entry.command.toLowerCase(), join(repo, 'git.exe').toLowerCase());
    } else assert.equal(entry.command, 'git');
    assert.ok(entry.args.includes('core.hooksPath=/dev/null'), 'every git call must disable hooks');
    assert.ok(entry.args.includes('core.fsmonitor=false'), 'every git call must disable fsmonitor');
    assert.ok(entry.args.includes('--no-optional-locks'), 'every git call must disable optional locks');
    assert.equal(entry.env.GIT_OPTIONAL_LOCKS, '0', 'every git call must set GIT_OPTIONAL_LOCKS=0');
  }
  const diffSpawns = seenSpawns.filter((entry) => entry.args.includes('diff'));
  assert.ok(diffSpawns.length >= 1, 'provenance should run at least one git diff');
  for (const entry of diffSpawns) {
    assert.ok(entry.args.includes('--no-ext-diff'), 'git diff must disable external diff drivers');
    assert.ok(entry.args.includes('--no-textconv'), 'git diff must disable textconv');
  }
  assert.equal(existsSync(hookMarker), false, 'no hook should have run during provenance');
  assert.equal(existsSync(fsmonitorMarker), false, 'no fsmonitor should run during provenance');

  // ── injectable timeout → partial, never clean ────────────────────────────
  const hangOnDiff = (command, args, options) => {
    if (args.includes('diff')) return makeFakeChild({ hang: true });
    return realSpawn(command, args, options);
  };
  setGitProvenanceSpawn(hangOnDiff);
  const timedOut = await collectGitProvenance(repo, { timeoutMs: 120 });
  resetGitProvenanceSpawn();
  assert.equal(timedOut.state, 'partial', 'a timed-out diff must yield partial');
  assert.equal(timedOut.partial, true);
  assert.equal(timedOut.reason, 'timeout');
  assert.equal(timedOut.timeoutMs, 120);
  assert.equal(timedOut.dirty, false, 'partial must not fake a clean tree (partial flags uncertainty)');

  // ── injectable failure → partial with reason ─────────────────────────────
  const failProbe = () => makeFakeChild({ stderrText: 'fatal: unable to read config\n', exitCode: 2 });
  setGitProvenanceSpawn(failProbe);
  const failed = await collectGitProvenance(repo);
  resetGitProvenanceSpawn();
  assert.equal(failed.state, 'partial');
  assert.equal(failed.partial, true);
  assert.match(failed.reason, /^git-probe-failed:/, 'probe failure should carry a reason');

  // ── spawn error (git binary missing) → not_git, run stays executable ─────
  setGitProvenanceSpawn(() => makeFakeChild({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }));
  const noGit = await collectGitProvenance(repo);
  resetGitProvenanceSpawn();
  assert.equal(noGit.state, 'not_git', 'missing git binary should degrade to not_git');
  assert.equal(noGit.reason, 'git-not-found');

  console.log('test-git-provenance: ok');
} finally {
  resetGitProvenanceSpawn();
  rmSync(configDir, { recursive: true, force: true });
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}
