import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { revokeLinuxRunContext } from '../scripts/linux-run-context-store.mjs';

test('revocation waits for an inherited helper lock even if its parent dies',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0, timeout: 15000 }, async () => {
    const directory = await mkdtemp('/srv/agentoc-operation-lock-');
    const runId = 'run_lockfixture1', launchAttempt = 2;
    const moduleUrl = new URL('../scripts/linux-run-operation-lock.mjs', import.meta.url).href;
    const script = `import {withLinuxRunOperationLock} from ${JSON.stringify(moduleUrl)};
import {spawn} from 'node:child_process';
await withLinuxRunOperationLock(JSON.parse(process.argv[1]), async fd => {
  const child = spawn('/usr/bin/sleep', ['30'], {stdio:['ignore','ignore','ignore',fd]});
  process.stdout.write(child.pid + '\\n');
  await new Promise(() => {});
});`;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ directory, runId, launchAttempt })],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let descendantPid = 0;
    try {
      const [chunk] = await once(parent.stdout, 'data');
      descendantPid = Number(String(chunk).trim());
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 1);
      let completed = false;
      const revoke = revokeLinuxRunContext({ directory, runId, launchAttempt }).then(() => { completed = true; });
      const marker = `${directory}/${createHash('sha256').update(runId).digest('hex')}-2.revoked`;
      for (let i = 0; i < 100; i++) {
        try { await lstat(marker); break; } catch (error) { if (error.code !== 'ENOENT' || i === 99) throw error; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      parent.kill('SIGKILL');
      await once(parent, 'close');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(completed, false);
      process.kill(descendantPid, 'SIGKILL'); descendantPid = 0;
      await revoke;
      assert.equal(completed, true);
    } finally {
      parent.kill('SIGKILL');
      if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
      await rm(directory, { recursive: true, force: true });
    }
  });
