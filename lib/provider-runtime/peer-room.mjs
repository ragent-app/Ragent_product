// Derive one private signaling room per pair of account-bound instances.
// The account directory already authenticates their long-lived Ed25519 keys.
// Convert those keys to X25519 for agreement; never publish the room secret.
import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import { createP2PRoomId } from '../p2p-signal-protocol.mjs';
import { createInstancePublicKeyFingerprint } from '../instance-identity.mjs';

const PRIME = (1n << 255n) - 19n;
const X25519_PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function mod(value) { const result = value % PRIME; return result < 0n ? result + PRIME : result; }
function pow(base, exponent) {
  let result = 1n, value = mod(base), power = exponent;
  while (power > 0n) { if (power & 1n) result = mod(result * value); value = mod(value * value); power >>= 1n; }
  return result;
}
function littleEndianInteger(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}
function littleEndianBytes(value) {
  const bytes = Buffer.alloc(32);
  for (let index = 0; index < bytes.length; index++) { bytes[index] = Number(value & 255n); value >>= 8n; }
  return bytes;
}
function edPublicToX25519(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Peer identity must be Ed25519');
  const encoded = Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
  if (encoded.length !== 32) throw new Error('Peer identity key is invalid');
  encoded[31] &= 0x7f;
  const y = littleEndianInteger(encoded);
  if (y >= PRIME || y === 1n) throw new Error('Peer identity key is invalid');
  const u = mod((1n + y) * pow(1n - y, PRIME - 2n));
  return createPublicKey({ key: Buffer.concat([X25519_PUBLIC_PREFIX, littleEndianBytes(u)]), format: 'der', type: 'spki' });
}
function edPrivateToX25519(privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Local identity must be Ed25519');
  const seed = Buffer.from(key.export({ format: 'jwk' }).d, 'base64url');
  if (seed.length !== 32) throw new Error('Local identity key is invalid');
  const scalar = createHash('sha512').update(seed).digest().subarray(0, 32);
  scalar[0] &= 248; scalar[31] &= 127; scalar[31] |= 64;
  return createPrivateKey({ key: Buffer.concat([X25519_PRIVATE_PREFIX, scalar]), format: 'der', type: 'pkcs8' });
}

export function deriveProviderPeerRoom({ identity, peer, accountId }) {
  const localId = String(identity?.instanceId || '').trim(), peerId = String(peer?.instanceId || '').trim();
  const account = String(accountId || '').trim();
  const peerPublicKey = String(peer?.instancePublicKey || '').trim();
  const fingerprint = String(peer?.instanceKeyFingerprint || '').trim();
  if (!localId || !peerId || localId === peerId || !account || !peerPublicKey ||
      createInstancePublicKeyFingerprint(peerPublicKey) !== fingerprint) throw new Error('Invalid bound peer identity');
  const publicFromPrivate = createPublicKey(createPrivateKey(identity.privateKey)).export({ type: 'spki', format: 'pem' }).toString().trim();
  if (publicFromPrivate !== String(identity.publicKey || '').trim()) throw new Error('Local identity keys do not match');
  const shared = diffieHellman({ privateKey: edPrivateToX25519(identity.privateKey), publicKey: edPublicToX25519(peerPublicKey) });
  const ids = [localId, peerId].sort();
  const context = JSON.stringify(['ragent-provider-peer-room-v1', account, ...ids]);
  const secret = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(context), 32)).toString('hex');
  return { roomId: createP2PRoomId(secret), secret, role: localId === ids[0] ? 'host' : 'mobile' };
}
