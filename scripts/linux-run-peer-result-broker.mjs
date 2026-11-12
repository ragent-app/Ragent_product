#!/usr/bin/env node
// Opt-in systemd socket-activated root result broker. Nothing enables this
// unit until the per-Run launcher and control-plane adoption path are ready.
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inheritedSocketFd } from '../lib/systemd-socket-activation.mjs';
import { createLinuxRunPeerResultServer } from './linux-run-peer-result-server.mjs';

const execFile = promisify(execFileCallback);
const socketPath = '/run/agentoc-peer-result/result.sock';
const resultDirectory = '/var/lib/agentoc-peer-results';
const socketName = 'agentoc-peer-result';

export async function startProtectedResultBroker({ env = process.env, pid = process.pid,
  readUser = () => readFile('/etc/agentoc/service-user', 'utf8'), exec = execFile,
  createServer = createLinuxRunPeerResultServer } = {}) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0) throw new Error('Protected result broker requires root');
  const inherited = inheritedSocketFd({ env, pid, expectedName: socketName });
  if (!inherited || inherited.count !== 1 || env.LISTEN_FDNAMES !== socketName) throw new Error('Protected result socket activation is required');
  const directory = String(env.AGENTOC_LINUX_RUN_CONTEXT_DIR || '').trim();
  const pinDirectory = String(env.AGENTOC_LINUX_SERVICE_PIN_DIR || '').trim();
  if (!directory || !pinDirectory) throw new Error('Protected Run context and key pin are required');
  const user = String(await readUser()).split(/\r?\n/, 1)[0].trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(user)) throw new Error('Invalid control user');
  const { stdout } = await exec('/usr/bin/id', ['-u', '--', user], { timeout: 2000, maxBuffer: 1024 });
  const rawUid = String(stdout).trim();
  if (!/^[1-9][0-9]{0,9}$/.test(rawUid)) throw new Error('Invalid control UID');
  const controlUid = Number(rawUid);
  if (!Number.isSafeInteger(controlUid) || controlUid > 0xfffffffe) throw new Error('Invalid control UID');
  return createServer({ socketPath, directory, pinDirectory, resultDirectory, controlUid, inheritFd: inherited.fd });
}

async function main() {
  const server = await startProtectedResultBroker();
  const shutdown = async () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log('[peer-result] socket-activated broker ready');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(`[peer-result] ${error.message}`); process.exitCode = 1; });
}
