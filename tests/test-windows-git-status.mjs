import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileWindowsGitStatus } from '../chat/windows-git-status.mjs';
import { resolveWin32ExecutablePathAsync } from '../lib/executable-resolution.mjs';

if (process.platform !== 'win32') {
  console.log('windows-git-status: skipped (requires Windows PowerShell)');
  process.exit(0);
}
const root = mkdtempSync(path.join(tmpdir(), 'ragent-git-status-'));
try {
  assert.equal(await compileWindowsGitStatus('git status', { parse: async () => ({ commands: [] }) }), null);
  assert.equal(await compileWindowsGitStatus('git status', { parse: async () => { throw new Error('parser unavailable'); } }), null);
  const git = await resolveWin32ExecutablePathAsync('git');
  assert.ok(git && path.win32.isAbsolute(git), 'real Git executable required');
  execFileSync(git, ['init', '-q'], { cwd: root, windowsHide: true });
  writeFileSync(path.join(root, '普通 file.txt'), 'fixture');
  for (const shell of [undefined, process.env.RAGENT_TEST_PWSH].filter((value, index) => value || index === 0)) {
    for (const [source, args] of [
      ['git status', ['status']], ['git status --short', ['status', '--short']],
      ['git.exe status -sb', ['status', '-sb']], ['git status --porcelain=v1 -uno', ['status', '--porcelain=v1', '-uno']],
      ['git status --untracked-files=all --branch', ['status', '--untracked-files=all', '--branch']],
    ]) {
      const compiled = await compileWindowsGitStatus(source, { executable: shell });
      assert.deepEqual(compiled, { kind: 'git-status', args }, source);
      const safeArgs = ['-c', 'core.fsmonitor=false', '--no-optional-locks'];
      const original = execFileSync(git, [...safeArgs, ...args], { cwd: root, windowsHide: true });
      const reconstructed = execFileSync(git, [...safeArgs, ...compiled.args], { cwd: root, windowsHide: true });
      assert.deepEqual(reconstructed, original, source);
    }
    for (const source of [
      'git -c core.fsmonitor=evil status', 'git --exec-path=evil status', 'git -C other status',
      'git status --help', 'git status -- .', 'git status file.txt', 'git status --porcelain=$(whoami)',
      'git status; Write-Output evil', 'git status | Write-Output', 'git status > output.txt',
      'git status --untracked-files=invalid', 'git status --ignored=invalid', 'git log --short',
      "& 'git.exe' status", 'git status -s; Remove-Item file.txt',
    ]) assert.equal(await compileWindowsGitStatus(source, { executable: shell }), null, source);
  }
  // A status operation may query submodules. Verify that the safe setting
  // propagates to the real Git child process, rather than assuming it does.
  const subSource = path.join(root, 'sub-source');
  const parent = path.join(root, 'parent');
  mkdirSync(subSource); mkdirSync(parent);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-global-config') };
  const run = (cwd, args) => execFileSync(git, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const init = cwd => {
    run(cwd, ['init', '-q']); run(cwd, ['config', 'user.name', 'Ragent Fixture']);
    run(cwd, ['config', 'user.email', 'fixture@agentoc.local']);
  };
  init(subSource);
  writeFileSync(path.join(subSource, 'tracked.txt'), 'fixture');
  run(subSource, ['add', 'tracked.txt']); run(subSource, ['commit', '-q', '-m', 'fixture']);
  init(parent);
  run(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub']);
  run(parent, ['commit', '-q', '-am', 'fixture']);
  const sub = path.join(parent, 'sub');
  const marker = path.join(root, 'sub-fsmonitor-ran');
  const markerBash = marker.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/').replaceAll("'", "'\\''");
  const hook = path.join(sub, 'fixture-monitor.sh');
  writeFileSync(hook, `#!/bin/sh\nprintf invoked > '${markerBash}'\nexit 0\n`); chmodSync(hook, 0o755);
  run(sub, ['config', 'core.fsmonitor', './fixture-monitor.sh']);
  run(parent, ['status', '--short']);
  assert.ok(existsSync(marker), 'fixture must demonstrate submodule fsmonitor execution');
  unlinkSync(marker);
  run(parent, ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--short']);
  assert.equal(existsSync(marker), false, 'safe status must suppress submodule fsmonitor');
  // Disabling fsmonitor is not enough to make arbitrary repositories safe:
  // a configured clean filter can run while Git checks a modified file.
  const filterRepo = path.join(root, 'filter-repo');
  mkdirSync(filterRepo); init(filterRepo);
  const filterMarker = path.join(filterRepo, 'filter-ran');
  writeFileSync(path.join(filterRepo, 'filter.sh'), '#!/bin/sh\nprintf invoked > filter-ran\ncat\n');
  writeFileSync(path.join(filterRepo, '.gitattributes'), 'tracked.txt filter=fixture\n');
  writeFileSync(path.join(filterRepo, 'tracked.txt'), 'before\n');
  run(filterRepo, ['config', 'filter.fixture.clean', 'sh ./filter.sh']);
  run(filterRepo, ['add', '.gitattributes', 'tracked.txt']);
  run(filterRepo, ['commit', '-q', '-m', 'filter fixture']);
  assert.ok(existsSync(filterMarker), 'fixture clean filter must execute during add');
  unlinkSync(filterMarker);
  writeFileSync(path.join(filterRepo, 'tracked.txt'), 'after!\n');
  utimesSync(path.join(filterRepo, 'tracked.txt'), new Date(946684800000), new Date(946684800000));
  run(filterRepo, ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--short']);
  assert.ok(existsSync(filterMarker), 'status may execute a configured clean filter even with fsmonitor disabled');
  console.log('windows-git-status: native AST and real Git output checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
