import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listProviderRuntimeProcesses, verifyProviderRuntime } from '../scripts/restart-provider-runtime.mjs';

const root = join(tmpdir(), `ragent-provider-restart-${process.pid}`);
await mkdir(root, { recursive: true });
try {
  const commandPath = '/opt/ragent/vendor/cc-switch/cc-switch';
  const writeProc = async (pid, argv) => {
    const procDir = join(root, String(pid));
    await mkdir(procDir, { recursive: true });
    await writeFile(join(procDir, 'cmdline'), `${argv.join('\0')}\0`);
  };

  await writeProc(1001, [commandPath, 'daemon', 'start', '--detach']);
  await writeProc(1002, [commandPath, 'proxy', 'serve', '--listen-port', '15722']);
  await writeProc(1003, ['/usr/bin/other', 'daemon', 'start']);
  const processes = await listProviderRuntimeProcesses({ procRoot: root, commandPath });
  assert.deepEqual(processes.map((item) => item.pid), [1001, 1002]);

  const unhealthy = await verifyProviderRuntime({
    procRoot: root,
    environment: { RAGENT_CC_SWITCH_COMMAND: commandPath },
  });
  assert.equal(unhealthy.ok, false);
  await rm(join(root, '1001'), { recursive: true, force: true });
  await rm(join(root, '1002'), { recursive: true, force: true });
  const healthy = await verifyProviderRuntime({
    procRoot: root,
    environment: { RAGENT_CC_SWITCH_COMMAND: commandPath },
  });
  assert.equal(healthy.ok, true);
  console.log('test-restart-provider-runtime: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
