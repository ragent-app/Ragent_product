// Lazy runtime owner for the v2 full-workbench temporary-control registry.
// It is separate from temporary-pairing-runtime so no v1 sharing record or
// network credential can ever be reinterpreted as a control grant.
import { join } from 'node:path';
import { TemporaryControlRegistry } from './temporary-control-registry.mjs';
import { TemporaryControlHost } from './temporary-control-host.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { temporaryControlAccessExpiryHint } from '../lib/temporary-control-access.mjs';
import { createTemporaryControlCarrierIngress } from './temporary-control-carrier-ingress.mjs';
import { createTemporaryControlClient } from '../lib/temporary-control-client.mjs';
import { TemporaryControlService } from './temporary-control-service.mjs';

let registryPromise;
let hostPromise;
let servicePromise;

export async function getTemporaryControlRegistry() {
  // Enable explicitly for private QA. Public availability requires the
  // separately recorded task/expiry/revoke/file acceptance gates.
  if (process.env.RAGENT_TEMPORARY_PAIRING_ENABLED !== '1') {
    throw temporaryPairingError('temporary_host_disabled', 503);
  }
  if (!registryPromise) {
    registryPromise = (async () => {
      const { CONFIG_DIR } = await import('../lib/config.mjs');
      const identity = await loadOrCreateInstanceIdentity();
      return new TemporaryControlRegistry({
        filePath: join(CONFIG_DIR, 'temporary-control.json'),
        identity,
      });
    })().catch((error) => {
      registryPromise = null;
      throw error;
    });
  }
  return registryPromise;
}

export async function getTemporaryControlHost() {
  if (!hostPromise) {
    hostPromise = getTemporaryControlRegistry().then((registry) => new TemporaryControlHost({ registry }))
      .catch((error) => { hostPromise = null; throw error; });
  }
  return hostPromise;
}

/** Owner-side lifecycle: QR registration, claim pickup, explicit confirmation and revocation. */
export async function getTemporaryControlService() {
  if (!servicePromise) {
    servicePromise = (async () => {
      const registry = await getTemporaryControlRegistry();
      const host = await getTemporaryControlHost();
      const { ACCOUNTS_URL, TURN_BROKER_URL, P2P_SIGNALING_URL } = await import('../lib/config.mjs');
      const client = createTemporaryControlClient({ baseUrl: ACCOUNTS_URL, identity: registry.identity,
        allowInsecure: process.env.RAGENT_ALLOW_INSECURE_ACCOUNTS_URL === '1' });
      let connectionService = null;
      if (TURN_BROKER_URL && P2P_SIGNALING_URL) {
        const { TemporaryControlConnectionService } = await import('./temporary-control-connection-service.mjs');
        const { getOwnerAccountBinding } = await import('../lib/owner-account-auth.mjs');
        connectionService = new TemporaryControlConnectionService({ registry, host, client, binding: getOwnerAccountBinding,
          brokerUrl: TURN_BROKER_URL, signalingEndpoint: P2P_SIGNALING_URL,
          ingress: getTemporaryControlCarrierIngress,
          startCarrier: async (options) => (await import('../lib/p2p-host-agent.mjs')).runP2PHostAgent(options) });
      }
      return new TemporaryControlService({ registry, host, client, connectionService });
    })().catch((error) => { servicePromise = null; throw error; });
  }
  return servicePromise;
}

/** Continue claim and carrier exchange even when the desktop pairing panel is closed. */
export async function startTemporaryControlPoller({ getService = getTemporaryControlService, intervalMs = 2000, onError = () => {} } = {}) {
  let service;
  try { service = await getService(); }
  catch (error) { if (error?.code === 'temporary_host_disabled') return () => {}; throw error; }
  let stopped = false; let timer;
  const run = async () => {
    try { await service.list(); } catch (error) {
      if (!stopped) onError(/^temporary_[a-z0-9_]{1,65}$/.test(error?.code || '') ? error.code : 'temporary_control_unavailable');
    } finally { if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); } }
  };
  timer = setTimeout(run, 0); timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); service.close(); };
}

/** P2P host code calls this function only after it owns the encrypted carrier. */
export async function getTemporaryControlCarrierIngress(carrierDevice) {
  if (!carrierDevice?.instanceId || !carrierDevice?.grantId || !carrierDevice?.deviceId
    || !Number.isSafeInteger(carrierDevice.accessExpiresAt)) throw new TypeError('Temporary control carrier identity is required');
  const host = await getTemporaryControlHost();
  return createTemporaryControlCarrierIngress({
      carrierDevice: Object.freeze({ ...carrierDevice }),
      authenticate: async ({ req, route }) => {
        if (req.headers.cookie || req.headers['x-ragent-browser-principal'] || req.headers['x-ragent-target-grant']) {
          throw temporaryPairingError('temporary_control_credential_mixed', 401);
        }
        const match = /^DPoP ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ''));
        if (!match || typeof req.headers.dpop !== 'string' || req.headers.dpop.length > 8192) {
          throw temporaryPairingError('temporary_control_access_required', 401);
        }
        const credential = { token_type: 'DPoP', access_token: match[1],
          expires_at: temporaryControlAccessExpiryHint(match[1]) };
        const principal = await host.authenticateRequest({ credential, proof: req.headers.dpop,
          method: req.method, targetUri: route.targetUri });
        if (principal.instanceId !== route.instanceId) throw temporaryPairingError('temporary_control_instance_mismatch', 403);
        return principal;
      },
      revalidate: (principal) => host.revalidatePrincipal(principal),
    });
}
