import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installWindowsRunCliShim } from '../chat/windows-run-cli-shim.mjs';
import { applyPrivilegedShimSpawnEnv } from '../chat/privileged-shim-listener.mjs';

if (process.platform !== 'win32') {
  console.log('Windows Run CLI launcher: skipped on non-Windows');
} else {
  const directory = await mkdtemp(join(tmpdir(), 'agentoc-cli-shim-'));
  try {
    const env = { ...process.env };
    const probe = { PATH: 'C:\\Windows' };
    applyPrivilegedShimSpawnEnv(probe, { binDir: directory, socketPath: join(directory, 'shim.sock') });
    assert.equal(probe.PATH, `${directory};C:\\Windows`);
    await installWindowsRunCliShim(env, { runDirectory: directory, nodePath: process.execPath,
      entryPath: resolve('cli.js') });
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'agentoc trigger --help'], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /agentoc trigger <command>/);
    assert.match(result.stdout, /--session/);
    const alias = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'ragent trigger --help'], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(alias.status, 0, alias.stderr || String(alias.error));
    assert.equal(alias.stdout, result.stdout);
    console.log('Windows Run CLI launcher: native PowerShell resolved and ran the CLI');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
