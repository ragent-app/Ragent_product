import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createReplayStore, verifySignalJoinToken } from '../lib/browser-connection-grant.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { createP2PSignalingServer } from './signaling-server.mjs';

export function createStandaloneBrowserAuthorizer(config) {
  if (!config || typeof config.issuer !== 'string' || !config.issuer.trim()
    || typeof config.keyId !== 'string' || !config.keyId.trim() || typeof config.publicKey !== 'string'
    || createInstancePublicKeyFingerprint(config.publicKey) !== config.keyId) {
    throw new TypeError('A verified public signaling trust key is required');
  }
  const trustedKeys = new Map([[config.keyId, config.publicKey]]);
  const replayStore = createReplayStore();
  return ({ token, roomId, instanceId, clientId, connectionId }) => verifySignalJoinToken(token, {
    trustedKeys, replayStore, expectedIssuer: config.issuer, expectedRoomId: roomId,
    expectedInstanceId: instanceId, expectedClientId: clientId, expectedConnectionId: connectionId,
  }).valid;
}

export async function startStandaloneSignaling({ trustFile, host = '127.0.0.1', port = 7791 } = {}) {
  if (!trustFile) throw new TypeError('A signaling trust configuration is required');
  const trust = JSON.parse(await readFile(trustFile, 'utf8'));
  const signal = createP2PSignalingServer({ host, port, authorizeJoin: createStandaloneBrowserAuthorizer(trust) });
  await signal.listen();
  return signal;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.RAGENT_P2P_SIGNAL_PORT || '7791');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid signaling port');
  const signal = await startStandaloneSignaling({ trustFile: process.env.RAGENT_SIGNAL_TRUST_PATH, port });
  console.log(JSON.stringify({ event: 'signaling_ready', host: '127.0.0.1', port }));
  const stop = async () => { await signal.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
