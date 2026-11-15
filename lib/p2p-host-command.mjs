import { readFile } from 'fs/promises';

import { runP2PHostAgent } from './p2p-host-agent.mjs';

function optionValue(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '').trim() : String(fallback || '').trim();
}

function printHelp(stdout) {
  stdout.write(`Usage:\n  ragent p2p-host --signaling-url <url> --room-id <id> [options]\n\nOptions:\n  --secret-file <path>   Read the room secret from a local file\n  --expires-at <iso>     Stop accepting signaling after this time\n  --local-base-url <url> Local Ragent endpoint (default: http://127.0.0.1:7690)\n  --binary <path>        Override the Pion sidecar binary\n  --help                 Show this help\n\nThe secret may also be supplied through RAGENT_P2P_ROOM_SECRET.\n`);
}

export async function runP2PHostCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(stdout);
    return 0;
  }
  const signalingUrl = optionValue(argv, '--signaling-url', process.env.RAGENT_P2P_SIGNALING_URL);
  const roomId = optionValue(argv, '--room-id', process.env.RAGENT_P2P_ROOM_ID);
  const secretFile = optionValue(argv, '--secret-file');
  const secret = secretFile
    ? String(await (io.readFile || readFile)(secretFile, 'utf8')).trim()
    : String(process.env.RAGENT_P2P_ROOM_SECRET || '').trim();
  const expiresAt = optionValue(argv, '--expires-at', process.env.RAGENT_P2P_EXPIRES_AT || new Date(Date.now() + 120_000).toISOString());
  const localBaseUrl = optionValue(argv, '--local-base-url', process.env.RAGENT_P2P_LOCAL_BASE_URL || 'http://127.0.0.1:7690');
  const binaryPath = optionValue(argv, '--binary', process.env.RAGENT_P2P_HOST_BINARY);
  if (!signalingUrl) throw new Error('--signaling-url is required');
  if (!/^[a-f0-9]{40}$/.test(roomId)) throw new Error('--room-id must be a 40-character lowercase hex value');
  if (!secret) throw new Error('--secret-file or RAGENT_P2P_ROOM_SECRET is required');
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error('--expires-at must be a future ISO timestamp');

  const agent = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret,
    expiresAt,
    localBaseUrl,
    ...(binaryPath ? { binaryPath } : {}),
  });
  await Promise.race([agent.ready, agent.done]);
  stdout.write(`Ragent P2P host joined room ${roomId}\n`);
  const stop = () => agent.stop();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const result = await agent.done;
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
  return result.code || 0;
}
