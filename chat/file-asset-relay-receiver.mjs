import { Readable } from 'node:stream';
import { decryptRelayStream, relayWireBytes } from './file-asset-relay-crypto.mjs';

// The URL is constructed only from the instance's configured Accounts URL;
// callers must never substitute a URL received from the mobile device.
export async function openRelayAsset({ accountsBaseUrl, relayId, readToken, key, transferId, totalBytes,
  fetchImpl = globalThis.fetch, signal }) {
  const base = new URL(accountsBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
      !/^[a-f0-9]{32}$/.test(relayId) || !/^[A-Za-z0-9_-]{43}$/.test(readToken) ||
      !Buffer.isBuffer(key) || key.length !== 32 || !/^[a-f0-9]{32}$/.test(transferId)) {
    throw new Error('Invalid relay destination or credentials');
  }
  const expectedSize = relayWireBytes(totalBytes);
  if (expectedSize > 64 * 1024 * 1024) throw new Error('Relay transfer exceeds size limit');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/v1/owner-auth/account/attachment-relay/${relayId}/content`;
  const response = await fetchImpl(base, { method: 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${readToken}`, Accept: 'application/octet-stream' }, signal });
  if (!response.ok || !response.body || response.headers.get('content-type') !== 'application/octet-stream' ||
      response.headers.get('content-length') !== String(expectedSize)) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error('Relay response is invalid');
  }
  return Readable.from(decryptRelayStream(response.body, { key, transferId, totalBytes }));
}
