import { join } from 'node:path';
import { TemporaryPairingRegistry } from './temporary-pairing-registry.mjs';
import { TemporaryPairingHost } from './temporary-pairing-host.mjs';
import { createTemporaryPairingClient } from '../lib/temporary-pairing-client.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { TemporaryConnectionService } from './temporary-connection-service.mjs';

let hostPromise;
export async function getTemporaryPairingHost() {
  if (process.env.RAGENT_TEMPORARY_PAIRING_ENABLED !== '1') throw temporaryPairingError('temporary_host_disabled', 503);
  if (!hostPromise) {
    hostPromise = (async () => {
      const { CONFIG_DIR, ACCOUNTS_URL, TURN_BROKER_URL, P2P_SIGNALING_URL } = await import('../lib/config.mjs');
      const { getOwnerAccountBinding } = await import('../lib/owner-account-auth.mjs');
      const identity = await loadOrCreateInstanceIdentity();
      const registry = new TemporaryPairingRegistry({ filePath: join(CONFIG_DIR, 'temporary-pairing.json'), identity });
      const client = createTemporaryPairingClient({ baseUrl: ACCOUNTS_URL, identity });
      const host = new TemporaryPairingHost({ registry, client, binding: getOwnerAccountBinding });
      const { TemporarySessionService } = await import('./temporary-session-service.mjs');
      host.sessions = new TemporarySessionService({ host });
      const { TemporaryMessageService } = await import('./temporary-message-service.mjs');
      host.messages = new TemporaryMessageService({ host });
      const { TemporaryFileService } = await import('./temporary-file-service.mjs');
      host.files = new TemporaryFileService({ host });
      const { TemporaryResultService } = await import('./temporary-result-service.mjs');
      host.results = new TemporaryResultService({ host });
      if (TURN_BROKER_URL && P2P_SIGNALING_URL) host.connectionService = new TemporaryConnectionService({
        host, brokerUrl: TURN_BROKER_URL, signalingEndpoint: P2P_SIGNALING_URL,
        startCarrier: async (options) => (await import('../lib/p2p-host-agent.mjs')).runP2PHostAgent(options) });
      return host;
    })().catch((error) => { hostPromise = null; throw error; });
  }
  return hostPromise;
}

/** Starts only after the main server owns its runtime/listener. One awaited tick per timer. */
export async function startTemporaryPairingPoller({ getHost = getTemporaryPairingHost, intervalMs = 4_000, onError = () => {} } = {}) {
  let host;
  try { host = await getHost(); }
  catch (error) { if (error?.code === 'temporary_host_disabled') return () => {}; throw error; }
  let stopped = false; let timer;
  const controller = new AbortController();
  const run = async () => {
    try { await host.tick({ signal: controller.signal }); }
    catch (error) { if (!stopped) onError(/^temporary_[a-z0-9_]{1,65}$/.test(error?.code || '') ? error.code : 'temporary_host_unavailable'); }
    finally {
      if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); }
    }
  };
  timer = setTimeout(run, 0); timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); controller.abort(); host.close?.(); };
}
