import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// One fresh key is used for one transfer. Each independently authenticated
// record can be retried without ever exposing plaintext to the relay.
export const RELAY_RECORD_BYTES = 256 * 1024;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const HEADER_BYTES = 8 + NONCE_BYTES;
const DOMAIN = Buffer.from('agentoc-asset-relay-v1\0', 'ascii');

function recordParameters(key, transferId, totalBytes, index) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid relay key');
  if (typeof transferId !== 'string' || !/^[a-f0-9]{32}$/.test(transferId)) throw new Error('Invalid relay transfer identity');
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error('Invalid relay transfer size');
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) throw new Error('Invalid relay record index');
  const offset = index * RELAY_RECORD_BYTES;
  if (offset >= totalBytes) throw new Error('Relay record exceeds transfer size');
  const size = Math.min(RELAY_RECORD_BYTES, totalBytes - offset);
  const aadFields = Buffer.alloc(16);
  aadFields.writeUInt32BE(index, 0);
  aadFields.writeBigUInt64BE(BigInt(totalBytes), 4);
  aadFields.writeUInt32BE(size, 12);
  return { size, aad: Buffer.concat([DOMAIN, Buffer.from(transferId, 'hex'), aadFields]) };
}

export function encryptRelayRecord({ key, transferId, totalBytes, index, plaintext, nonce = randomBytes(NONCE_BYTES) }) {
  const { size, aad } = recordParameters(key, transferId, totalBytes, index);
  if (!Buffer.isBuffer(plaintext) || plaintext.length !== size) throw new Error('Invalid relay plaintext size');
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) throw new Error('Invalid relay nonce');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(index, 0);
  header.writeUInt32BE(size, 4);
  nonce.copy(header, 8);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function decryptRelayRecord({ key, transferId, totalBytes, index, frame }) {
  const { size, aad } = recordParameters(key, transferId, totalBytes, index);
  if (!Buffer.isBuffer(frame) || frame.length !== HEADER_BYTES + size + TAG_BYTES ||
      frame.readUInt32BE(0) !== index || frame.readUInt32BE(4) !== size) {
    throw new Error('Invalid relay record');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, frame.subarray(8, HEADER_BYTES));
  decipher.setAAD(aad);
  decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
  // Do not return any plaintext until authentication of the complete record.
  return Buffer.concat([decipher.update(frame.subarray(HEADER_BYTES, frame.length - TAG_BYTES)), decipher.final()]);
}

export function relayWireBytes(totalBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error('Invalid relay transfer size');
  const count = Math.ceil(totalBytes / RELAY_RECORD_BYTES);
  const size = totalBytes + count * (HEADER_BYTES + TAG_BYTES);
  if (!Number.isSafeInteger(size) || count > 0x80000000) throw new Error('Relay transfer is too large');
  return size;
}

// HTTP chunks do not preserve record boundaries. Buffer at most one record,
// authenticate it fully and only then yield plaintext to the target's normal
// size/hash-checked staging pipeline. Async iteration preserves backpressure.
export async function* decryptRelayStream(source, { key, transferId, totalBytes }) {
  relayWireBytes(totalBytes);
  let index = 0, filled = 0, frame = null;
  for await (const raw of source) {
    if (!(raw instanceof Uint8Array)) throw new Error('Invalid relay stream');
    let offset = 0;
    while (offset < raw.length) {
      if (index * RELAY_RECORD_BYTES >= totalBytes) throw new Error('Relay stream has trailing bytes');
      if (!frame) {
        const { size } = recordParameters(key, transferId, totalBytes, index);
        frame = Buffer.alloc(HEADER_BYTES + size + TAG_BYTES);
      }
      const amount = Math.min(frame.length - filled, raw.length - offset);
      frame.set(raw.subarray(offset, offset + amount), filled);
      offset += amount; filled += amount;
      if (filled === frame.length) {
        const plaintext = decryptRelayRecord({ key, transferId, totalBytes, index, frame });
        index++; filled = 0; frame = null;
        yield plaintext;
      }
    }
  }
  if (frame || index !== Math.ceil(totalBytes / RELAY_RECORD_BYTES)) throw new Error('Relay stream is incomplete');
}
