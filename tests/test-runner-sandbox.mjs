#!/usr/bin/env node
// P2-B: bubblewrap runner sandbox regression tests.
//
// 1. Arg construction: the sandbox argv carries ro-root, private /tmp + /run,
//    fresh /proc + /dev, namespace isolation, workspace + runner-home RW binds,
//    and empty-dir overlays hiding the control-plane paths.
// 2. Availability gate: linux + opt-in flag + bwrap present -> on; otherwise off.
// 3. Real bwrap smoke (skipped when bwrap is unavailable): a command run inside
//    the built sandbox sees a writable workspace + runner home, hidden
//    /var/lib/agentoc/config, and a read-only /usr.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSandboxedSpawn,
  isBwrapPresent,
  TRUSTED_BWRAP_PATH,
  isSandboxAvailable,
  isSandboxRequested,
  requireSandboxAvailability,
} from '../lib/runner-sandbox.mjs';

function haveBwrap() {
  const probe = spawnSync('bwrap', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'agentoc-sandbox-'));
  const emptyDir = join(root, 'empty');
  const ws = join(root, 'workspace');
  const rh = join(root, 'runner-home');
  mkdirSync(emptyDir);
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(rh, 'provider-homes', 'codex'), { recursive: true });
  writeFileSync(join(rh, 'provider-homes', 'codex', 'auth.json'), 'secret\n');
  try {
    // ── 1) arg construction ────────────────────────────────────────────────
    {
      const sb = buildSandboxedSpawn({
        command: '/bin/true',
        args: ['--flag'],
        cwd: ws,
        runnerHome: rh,
        hidePaths: ['/var/lib/agentoc/config', '/etc/agentoc'],
        mkdtemp: () => emptyDir,
      });
      assert.equal(sb.command, TRUSTED_BWRAP_PATH);
      assert.equal(sb.sandboxed, true);
      const a = sb.args;
      assert.ok(a.includes('--ro-bind') && a.includes('/') && a[a.indexOf('--ro-bind') + 1] === '/', 'ro-root');
      assert.ok(a.includes('--tmpfs') && a[a.indexOf('--tmpfs')] === '--tmpfs' && a[a.indexOf('--tmpfs') + 1] === '/tmp', 'private /tmp');
      assert.ok(a.includes('--proc') && a[a.indexOf('--proc') + 1] === '/proc', 'fresh /proc');
      assert.ok(a.includes('--dev') && a[a.indexOf('--dev') + 1] === '/dev', 'fresh /dev');
      assert.ok(a.includes('--unshare-pid') && a.includes('--unshare-ipc') && a.includes('--unshare-uts'), 'namespaces');
      assert.ok(a.includes(ws), 'workspace path bound');
      assert.ok(a.includes(rh), 'runner home bound');
      assert.equal(a[a.indexOf('/var/lib/agentoc/config') - 1], emptyDir, 'config hidden by empty-dir overlay');
      assert.equal(a[a.indexOf('/etc/agentoc') - 1], emptyDir, '/etc/agentoc hidden by empty-dir overlay');
      assert.equal(a[a.indexOf('--') + 1], '/bin/true', 'command follows the -- separator');
      assert.ok(a.includes('--flag'), 'tool args preserved');

      const guiRoot = join(root, 'gui');
      const guiRuntime = join(guiRoot, 'runtime');
      const guiAuth = join(guiRoot, 'Xauthority');
      mkdirSync(guiRuntime, { recursive: true });
      writeFileSync(guiAuth, 'cookie\n');
      const gui = buildSandboxedSpawn({
        command: '/bin/true',
        cwd: ws,
        runnerHome: rh,
        bindReadOnlyPaths: [guiRoot, guiAuth, guiRuntime],
        exposeHostDevices: true,
        mkdtemp: () => emptyDir,
      });
      assert.ok(gui.args.includes('--dev-bind') && gui.args.includes('/dev'), 'GUI sandbox must expose host devices');
      assert.equal(gui.args.includes('--dev'), false, 'GUI sandbox must replace the private /dev');
      for (const path of [guiRoot, guiAuth, guiRuntime]) {
        const index = gui.args.indexOf(path);
        assert.ok(index > 0 && gui.args[index - 1] === '--ro-bind', `GUI path must be read-only bound: ${path}`);
      }
    }

    // ── 2) availability gate ───────────────────────────────────────────────
    {
      // The gate checks bwrap presence too; assert flag parsing via a fake env.
      assert.equal(
        isSandboxAvailable({ platform: 'linux', env: { AGENTOC_RUN_SANDBOX: '1' } }),
        haveBwrap(),
        'linux + flag on => available iff bwrap exists',
      );
      assert.equal(
        isSandboxAvailable({ platform: 'linux', env: { AGENTOC_RUN_SANDBOX: '0' } }),
        false,
        'flag 0 disables sandbox',
      );
      assert.equal(
        isSandboxAvailable({ platform: 'darwin', env: { AGENTOC_RUN_SANDBOX: '1' } }),
        false,
        'non-linux never sandboxes',
      );
      assert.equal(
        isSandboxAvailable({ platform: 'linux', env: {} }),
        false,
        'unset flag means sandbox off by default',
      );
      const safeStat = (name) => ({ uid: 0, mode: 0o755,
        isSymbolicLink: () => false, isDirectory: () => name !== TRUSTED_BWRAP_PATH,
        isFile: () => name === TRUSTED_BWRAP_PATH });
      let probed = '';
      assert.equal(isBwrapPresent({ stat: safeStat, exec: (file) => { probed = file; } }), true);
      assert.equal(probed, TRUSTED_BWRAP_PATH, 'probe must not resolve through a writable PATH');
      assert.equal(isBwrapPresent({ stat: (name) => ({ ...safeStat(name), uid: name === TRUSTED_BWRAP_PATH ? 1000 : 0 }), exec: () => { throw Error('must not execute'); } }), false);
      assert.equal(isBwrapPresent({ stat: (name) => ({ ...safeStat(name), mode: name === '/usr/bin' ? 0o777 : 0o755 }), exec: () => { throw Error('must not execute'); } }), false);
      assert.equal(isBwrapPresent({ stat: (name) => ({ ...safeStat(name), isSymbolicLink: () => name === TRUSTED_BWRAP_PATH }), exec: () => { throw Error('must not execute'); } }), false);
      assert.equal(isSandboxRequested({ env: { AGENTOC_RUN_SANDBOX: 'off' } }), false);
      assert.equal(requireSandboxAvailability({ platform: 'darwin', env: {} }), false);
      assert.throws(() => requireSandboxAvailability({ platform: 'darwin', env: { AGENTOC_RUN_SANDBOX: '1' } }),
        (error) => error.code === 'RUNNER_SANDBOX_UNAVAILABLE');
      assert.throws(() => requireSandboxAvailability({ platform: 'linux', env: { AGENTOC_RUN_SANDBOX: '1' }, bwrapPresent: () => false }),
        (error) => error.code === 'RUNNER_SANDBOX_UNAVAILABLE');
      assert.equal(requireSandboxAvailability({ platform: 'linux', env: { AGENTOC_RUN_SANDBOX: '1' }, bwrapPresent: () => true }), true);
      assert.equal(requireSandboxAvailability({ platform: 'linux', env: {}, required: true, bwrapPresent: () => true }), true);
      assert.throws(() => requireSandboxAvailability({ platform: 'darwin', env: {}, required: true, bwrapPresent: () => true }),
        (error) => error.code === 'RUNNER_SANDBOX_UNAVAILABLE');


    }

    // ── 3) real bwrap smoke ────────────────────────────────────────────────
    if (haveBwrap()) {
      const sb = buildSandboxedSpawn({
        command: '/bin/sh',
        args: ['-c', [
          `test -w '${ws}' && echo ws-rw || echo ws-ro`,
          `test -w '${rh}' && echo rh-rw || echo rh-ro`,
          `test -z "$(ls -A /var/lib/agentoc/config 2>/dev/null)" && echo config-hidden || echo config-visible`,
          `test ! -w /usr && echo usr-ro || echo usr-writable`,
          `cat '${rh}/provider-homes/codex/auth.json'`,
        ].join(';')],
        cwd: ws,
        runnerHome: rh,
        hidePaths: ['/var/lib/agentoc/config', '/etc/agentoc'],
        mkdtemp: () => emptyDir,
      });
      const result = spawnSync(sb.command, sb.args, { encoding: 'utf8' });
      if (result.status !== 0 && /Operation not permitted/u.test(result.stderr || '')) {
        console.log('  bwrap smoke unavailable in the current host sandbox; skipping live mount check');
      } else {
        assert.equal(result.status, 0, `bwrap smoke failed: ${result.stderr}`);
        const out = result.stdout.trim();
        assert.ok(out.includes('ws-rw'), `workspace must be rw inside sandbox (got: ${out})`);
        assert.ok(out.includes('rh-rw'), `runner home must be rw inside sandbox (got: ${out})`);
        assert.ok(out.includes('config-hidden'), `config must be hidden inside sandbox (got: ${out})`);
        assert.ok(out.includes('usr-ro'), `system must be read-only inside sandbox (got: ${out})`);
        assert.ok(out.includes('secret'), `provider home content must be reachable (got: ${out})`);
        console.log('  bwrap smoke: workspace rw / runner-home rw / config hidden / usr ro');
      }
    } else {
      console.log('  bwrap not available; skipping live smoke');
    }

    console.log('test-runner-sandbox: ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
