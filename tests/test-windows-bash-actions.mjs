import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, link, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeWindowsBash, parseLiteralBashWords } from '../chat/windows-bash-actions.mjs';
import { decideWindowsPowerShellActions, ripgrepSafePrefix } from '../chat/windows-powershell-actions.mjs';
import { decideWindowsApproval } from '../chat/windows-approval-gate.mjs';

assert.deepEqual(parseLiteralBashWords("cat '中文 文件.md'"), ['cat', '中文 文件.md']);
for (const command of ['cat x; rm -rf /', 'cat "$(rm x)"', 'cat $HOME/a', 'cat x > out', 'cat *.txt', 'cat x # comment', 'cat `whoami`']) {
  assert.equal(parseLiteralBashWords(command), null, command);
}
if (process.platform === 'win32') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-bash-policy-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, 'secret', '.ssh'), { recursive: true });
  await mkdir(path.join(workspace, 'ordinary'), { recursive: true });
  await mkdir(path.join(workspace, 'linked-dest'), { recursive: true });
  await mkdir(path.join(workspace, 'existing-dest', 'ordinary', '.ssh'), { recursive: true });
  await writeFile(path.join(workspace, '中文 文件.md'), 'fixture');
  await writeFile(path.join(root, 'outside.txt'), 'fixture');
  await writeFile(path.join(workspace, 'secret', '.ssh', 'fixture-key'), 'fixture');
  await link(path.join(workspace, 'secret', '.ssh', 'fixture-key'), path.join(workspace, 'ordinary-link'));
  await link(path.join(workspace, 'secret', '.ssh', 'fixture-key'), path.join(workspace, 'linked-dest', '中文 文件.md'));
  const context = { cwd: workspace, trustedWorkspaceRoot: workspace };
  const inspect = async (command, conservative = false) => decideWindowsPowerShellActions(await analyzeWindowsBash(command, context), { conservative });
  assert.equal((await inspect("cat '中文 文件.md'")).decision, 'allow');
  for (const command of ["cat -n '中文 文件.md'", "cat --number '中文 文件.md'", 'ls -lah ordinary', 'ls -1 ordinary', 'ls -r secret', 'ls --reverse secret']) {
    assert.equal((await inspect(command)).decision, 'allow', command);
  }
  assert.equal((await inspect('ls -R secret')).decision, 'review');
  assert.equal((await inspect('ls -L secret')).decision, 'review');
  assert.equal((await inspect('cat --number secret/.ssh/fixture-key')).decision, 'review');
  for (const command of ["head -n 2 '中文 文件.md'", "tail -c10 '中文 文件.md'", "wc -lw '中文 文件.md'",
    "grep -in hello '中文 文件.md'", "grep -e hello -- '中文 文件.md'", "grep hello '中文 文件.md' > output.md", 'head ../outside.txt',
    "sed -n '1,100p' '中文 文件.md'", "sed --quiet 1p -- '中文 文件.md'"]) {
    assert.equal((await inspect(command)).decision, 'allow', command);
  }
  assert.equal((await inspect('head ../outside.txt', true)).decision, 'review');
  for (const command of ['tail -f ordinary', 'head -n $(whoami) ordinary', 'grep -f secret/.ssh/fixture-key ordinary',
    'grep hello secret/.ssh/fixture-key', 'wc -l secret/.ssh/fixture-key', 'grep hello ordinary > secret/.ssh/key',
    'grep --exclude-from secret/.ssh/fixture-key hello ordinary', 'grep hello',
    "sed -n '1,100p' secret/.ssh/fixture-key", "sed -n '1,100p;1e touch owned' '中文 文件.md'",
    "sed -i '1p' '中文 文件.md'", "sed -n '1r secret/.ssh/fixture-key' '中文 文件.md'"]) {
    assert.equal((await inspect(command)).decision, 'review', command);
  }
  assert.equal((await inspect('ls -la')).decision, 'allow');
  if (process.env.AGENTOC_TEST_BASH_BINARY) {
    await mkdir(path.join(workspace, 'transient'));
    await writeFile(path.join(workspace, 'transient', 'readme.txt'), 'fixture');
    const transition = await analyzeWindowsBash('cd transient && cat readme.txt || echo changed > marker.txt', { ...context, allowCwdRewrite: true });
    assert.equal(decideWindowsPowerShellActions(transition).decision, 'allow');
    await rename(path.join(workspace, 'transient'), path.join(workspace, 'moved-transient'));
    const result = spawnSync(process.env.AGENTOC_TEST_BASH_BINARY, ['--noprofile', '--norc', '-c', transition.rewrittenCommand], { cwd: workspace, windowsHide: true });
    assert.notEqual(result.status, 0);
    await assert.rejects(access(path.join(workspace, 'marker.txt')), { code: 'ENOENT' });
  }
  for (const command of [`rg ${ripgrepSafePrefix()} --files .`, `rg ${ripgrepSafePrefix()} --files -g '!*.txt' .`, `rg ${ripgrepSafePrefix()} --hidden --no-ignore --files .`, `rg ${ripgrepSafePrefix()} -uu --files .`, "rg --no-config -S --max-count 2 -e fixture '中文 文件.md'"]) {
    assert.equal((await inspect(command)).decision, 'allow', `safe ripgrep request: ${command}`);
  }
  for (const command of ["rg --files .", "rg --no-config --files .", "rg --no-config --files -g '*' .", "rg --no-config --files --glob='*.js' .", 'rg --no-config --files -t js .', 'rg --no-config --files --type=js .', 'rg --no-config --files --hidden .', 'rg --no-config --files --follow .']) {
    assert.equal((await inspect(command)).decision, 'review', `ripgrep must not traverse hidden sensitive paths: ${command}`);
  }
  assert.equal((await inspect('rg --no-config --files ordinary')).decision, 'review', 'a clean directory still needs execution-time exclusions');
  assert.equal((await inspect(`rg ${ripgrepSafePrefix()} --files -g '*' .`)).decision, 'review', 'a later positive glob may override earlier exclusions');
  assert.equal((await inspect(`rg --no-config --files -g '*' ${ripgrepSafePrefix()} .`)).decision, 'allow', 'all exclusions following the selector keep the selected search bounded');
  for (const command of [
    "cat '中文 文件.md' | head -n 1",
    "cat '中文 文件.md' | grep -i fixture | wc -l",
    "cat '中文 文件.md' | sed -n '1,100p'",
    'git status --short && git branch --show-current',
    'git status --short; git branch --show-current',
    "grep missing '中文 文件.md' || true",
    "cat '中文 文件.md' || false",
    "cat '中文 文件.md' | grep fixture || :",
    "grep missing '中文 文件.md' 2>/dev/null || true",
    "cat '中文 文件.md' 2> /dev/null",
  ]) assert.equal((await inspect(command)).decision, 'allow', `ordinary compound read: ${command}`);
  for (const command of [
    "cat '中文 文件.md' | bash -c 'rm -rf ordinary'",
    "cat '中文 文件.md' | grep -f secret/.ssh/fixture-key",
    "cat '中文 文件.md' | head secret/.ssh/fixture-key",
    "cat '中文 文件.md' | head -n $(whoami)",
    "cat '中文 文件.md' || rm -rf ordinary",
    "false || cat secret/.ssh/fixture-key",
    "cat '中文 文件.md' 2> secret/.ssh/key || true",
    "cat '中文 文件.md' 2>/dev/nullx || true",
    "cat '中文 文件.md' && rm -rf secret",
    "echo fixture > ordinary-link | head",
    "cat '中文 文件.md' | head > secret/.ssh/key",
  ]) assert.equal((await inspect(command)).decision, 'review', `unsafe compound request: ${command}`);
  assert.equal((await inspect('mkdir -p output')).decision, 'allow');
  assert.equal((await inspect('rm -rf ordinary')).decision, 'review');
  assert.equal((await inspect('rm --recursive --force ordinary')).decision, 'review');
  assert.equal((await inspect('rm -rf secret')).decision, 'review');
  assert.equal((await inspect('rm -rf /c/Windows')).decision, 'review');
  assert.equal((await inspect('cat /tmp/file')).decision, 'review');
  assert.equal((await inspect('rm -rf .')).decision, 'review');
  assert.equal((await inspect('bash -c "echo hello"')).decision, 'review');
  assert.equal((await inspect('cp -r ordinary output')).decision, 'allow');
  assert.equal((await inspect("cp '中文 文件.md' linked-dest")).decision, 'review');
  assert.equal((await inspect("mv '中文 文件.md' linked-dest")).decision, 'review');
  assert.equal((await inspect('cp -r secret output')).decision, 'review');
  assert.equal((await inspect('cp -r ordinary secret')).decision, 'allow');
  assert.equal((await inspect('cp -r ordinary existing-dest')).decision, 'review');
  assert.equal((await inspect('ls -R ordinary')).decision, 'allow');
  assert.equal((await inspect('ls --recursive secret')).decision, 'review');
  assert.equal((await inspect("echo 'hello > world' > '输出 文件.md'")).decision, 'allow');
  assert.equal((await inspect("cat '中文 文件.md' >> output.md")).decision, 'allow');
  assert.equal((await inspect('echo hello > secret/.ssh/key')).decision, 'review');
  assert.equal((await inspect('echo hello > ordinary-link')).decision, 'review');
  assert.equal((await inspect('echo hello 2> output.md')).decision, 'review');
  assert.equal((await inspect('echo hello > $HOME/file')).decision, 'review');
  assert.equal((await inspect('echo hello > one > two')).decision, 'review');
  assert.equal((await inspect("echo hello > ''")).decision, 'review');
  assert.equal((await inspect('echo hello > output.md; rm -rf /')).decision, 'review');
  const bashPath = value => value.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
  const file = bashPath(path.join(workspace, '中文 文件.md'));
  const secret = bashPath(path.join(workspace, 'secret'));
  const request = command => ({ kind: 'command', providerMethod: 'can_use_tool', params: { tool_name: 'Bash', input: { command } } });
  for (const command of ['git status --short', 'git status -sb --ignored=matching', 'git diff --stat', 'git branch --show-current', 'git log -n 5 --oneline', "git log -1 --format='%h %s'"]) {
    assert.equal((await inspect(command)).decision, 'allow', `${command} is a read-only Git query`);
  }
  for (const command of ['git diff', 'git add .', 'git commit -m test']) assert.equal((await inspect(command)).decision, 'allow');
  for (const command of ['python --version', 'node --version', 'go version', 'java -version']) assert.equal((await inspect(command)).decision, 'allow');
  for (const command of ['git status --ignored=bogus']) {
    assert.equal((await inspect(command)).decision, 'review', `${command} is not on the read-only Git allowlist`);
  }
  for (const riskMode of ['recommended', 'full-auto']) {
    const state = { riskMode, cwd: workspace, riskContext: context };
    assert.equal((await decideWindowsApproval(request('git status --short'), state)).decision, 'auto-allow');
    assert.equal((await decideWindowsApproval(request("git log -1 --format='%h %s'"), state)).decision, 'auto-allow');
    assert.equal((await decideWindowsApproval(request(`cat -n '${file}'`), state)).decision, 'auto-allow');
    assert.equal((await decideWindowsApproval(request(`ls -lah '${secret}'`), state)).decision, 'auto-allow');
    assert.equal((await decideWindowsApproval(request(`ls -R '${secret}'`), state)).decision, 'prompt');
    assert.equal((await decideWindowsApproval(request(`cat '${file}' | head -n 1`), state)).decision, 'auto-allow');
    assert.equal((await decideWindowsApproval(request(`sed -n '1,100p' '${file}'`), state)).decision, 'auto-allow');
    assert.equal((await decideWindowsApproval(request(`cat '${file}' | sed -n '1,100p'`), state)).decision, 'auto-allow');
    assert.equal((await decideWindowsApproval(request(`cat '${file}' | sed -n '1w owned'`), state)).decision, 'prompt');
    assert.equal((await decideWindowsApproval(request(`cat '${file}' | bash -c 'rm -rf /'`), state)).decision, 'prompt');
  }
  if (process.env.AGENTOC_TEST_BASH_BINARY) {
    const bash = process.env.AGENTOC_TEST_BASH_BINARY;
    const numbered = execFileSync(bash, ['--noprofile', '--norc', '-c', `cat -n '${file}'`], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.match(numbered, /\b1\s+fixture/);
    const listing = execFileSync(bash, ['--noprofile', '--norc', '-c', `ls -1 '${bashPath(workspace)}'`], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.ok(listing.includes('中文 文件.md'));
    const pipeline = execFileSync(bash, ['--noprofile', '--norc', '-c', `cat '${file}' | grep -i fixture | head -n 1`], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.equal(pipeline.trim(), 'fixture');
    const sed = execFileSync(bash, ['--noprofile', '--norc', '-c', `sed -n '1,100p' '${file}'`], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.equal(sed.trim(), 'fixture');
  }
  await rm(root, { recursive: true, force: true });
}
console.log('windows-bash-actions: literal command and path policy checks passed');
