import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-utils.mjs';

export const UPLOAD_CHUNK_BYTES = 256 * 1024;
export const MAX_STABLE_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_CHUNK_REQUEST_TIMEOUT_MS = 150_000;
export const UPLOAD_CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const UPLOAD_CHECKPOINT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const LEGACY_UPLOAD_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
export const RESUMABLE_UPLOAD_CONTRACT = Object.freeze({ version: 1,
  chunkBytes: UPLOAD_CHUNK_BYTES, checkpointTtlMs: UPLOAD_CHECKPOINT_TTL_MS,
  checksum: 'sha256', fixedChunks: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, status = 409) => {
  const error = new Error('Attachment upload checkpoint is unavailable or conflicts with this request');
  error.code = code; error.statusCode = status; throw error;
};

/** Called only under the asset's upload queue. fence() rechecks scope/authority at publication.
 * Bytes are synced before the atomic manifest. Uncommitted tails are discarded on recovery.
 * This guarantees process-crash recovery, not directory-entry durability after power loss.
 */
export class FileAssetUploadCheckpoints {
  constructor(directory, clock = Date.now) { this.directory = directory; this.clock = clock; }

  paths(record) {
    if (!/^fasset_[a-f0-9]{24}$/.test(record?.id || '') || !record.uploadRequest
      || record.storage?.provider !== 'local') fail('FILE_ASSET_UPLOAD_UNSUPPORTED');
    return { manifest: join(this.directory, `${record.id}.json`), body: join(this.directory, `${record.id}.part`) };
  }

  async exists(record) {
    const { manifest } = this.paths(record);
    try { await lstat(manifest); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  initial(record) {
    const created = Date.parse(record.createdAt);
    if (!Number.isFinite(created) || !/^[a-f0-9]{64}$/.test(record.uploadRequest.fingerprint || '')
      || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1
      || record.sizeBytes > MAX_STABLE_UPLOAD_BYTES || !/^[a-f0-9]{64}$/.test(record.sha256 || ''))
      fail('FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
    const hardExpiresAt = created + UPLOAD_CHECKPOINT_MAX_LIFETIME_MS;
    return { version: 2, assetId: record.id, fingerprint: record.uploadRequest.fingerprint,
      totalBytes: record.sizeBytes, sha256: record.sha256, offset: 0, cancelled: false,
      hardExpiresAt, expiresAt: Math.min(created + UPLOAD_CHECKPOINT_TTL_MS, hardExpiresAt) };
  }

  async load(record) {
    const expected = this.initial(record), { manifest } = this.paths(record);
    try {
      const info = await lstat(manifest);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) fail('FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
      let value = JSON.parse(await readFile(manifest, 'utf8'));
      if (value.version === 1 && value.assetId === expected.assetId
        && value.fingerprint === expected.fingerprint && value.totalBytes === expected.totalBytes
        && value.sha256 === expected.sha256
        && value.expiresAt === Date.parse(record.createdAt) + LEGACY_UPLOAD_CHECKPOINT_TTL_MS) {
        // Preserve valid v1 checkpoints from the one-day lease before writing
        // the sliding-lease v2 format on the next accepted chunk.
        value = { ...value, version: 2, hardExpiresAt: expected.hardExpiresAt };
      }
      if (Object.keys(expected).some(key => !['offset', 'cancelled', 'expiresAt'].includes(key) && value[key] !== expected[key])
        || typeof value.cancelled !== 'boolean' || !Number.isSafeInteger(value.offset)
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < Date.parse(record.createdAt)
        || value.expiresAt > expected.hardExpiresAt
        || value.offset < 0 || value.offset > record.sizeBytes
        || (value.offset !== record.sizeBytes && value.offset % UPLOAD_CHUNK_BYTES !== 0))
        fail('FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return expected;
      if (error.code === 'FILE_ASSET_RECEIPT_UNAVAILABLE') throw error;
      fail('FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
    }
  }

  async openBody(record, offset) {
    const { body } = this.paths(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      const info = await lstat(body);
      if (!info.isFile() || info.isSymbolicLink()) fail('FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
      handle = await open(body, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (offset !== 0) fail('FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
      handle = await open(body, 'wx+', 0o600);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < offset) fail('FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
      if (info.size > offset) { await handle.truncate(offset); await handle.sync(); }
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async admit(record, value, fence) {
    if (value.cancelled) fail('FILE_ASSET_UPLOAD_CANCELLED', 410);
    if (this.clock() >= value.expiresAt) {
      await fence(async () => {
        await rm(this.paths(record).body, { force: true });
        await rm(this.paths(record).manifest, { force: true });
      });
      fail('FILE_ASSET_UPLOAD_EXPIRED', 410);
    }
  }

  project(value) {
    return { uploadCheckpointVersion: 1, assetId: value.assetId, offset: value.offset,
      totalBytes: value.totalBytes, sha256: value.sha256, chunkBytes: UPLOAD_CHUNK_BYTES,
      expiresAt: value.expiresAt,
      status: value.cancelled ? 'cancelled' : value.offset === value.totalBytes ? 'uploaded' : 'uploading' };
  }

  async state(record, fence) {
    const value = await this.load(record);
    await this.admit(record, value, fence);
    // Repair a process-crash tail only after renewed authority, without inventing a manifest.
    if (await this.exists(record)) {
      const handle = await fence(() => this.openBody(record, value.offset));
      await handle.close();
    }
    return fence(() => this.project(value));
  }

  async append(record, { offset, length, sha256 }, stream, fence, signal) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % UPLOAD_CHUNK_BYTES !== 0
      || offset >= record.sizeBytes || length !== Math.min(UPLOAD_CHUNK_BYTES, record.sizeBytes - offset)
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) fail('INVALID_ARGUMENT', 400);
    signal?.throwIfAborted();
    const value = await this.load(record);
    await this.admit(record, value, fence);
    if (offset > value.offset) fail('FILE_ASSET_UPLOAD_OFFSET_CONFLICT');
    // Read only one bounded chunk; no network IO is held inside the Session scope lock.
    const parts = []; let size = 0;
    for await (const part of stream) {
      signal?.throwIfAborted();
      size += part.length;
      if (size > length) fail('FILE_ASSET_SIZE_MISMATCH');
      parts.push(Buffer.from(part));
    }
    signal?.throwIfAborted();
    const bytes = Buffer.concat(parts);
    if (size !== length) fail('FILE_ASSET_SIZE_MISMATCH');
    if (digest(bytes) !== sha256) fail('FILE_ASSET_HASH_MISMATCH');
    const handle = await fence(() => this.openBody(record, value.offset));
    try {
      if (offset < value.offset) {
        const previous = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const result = await handle.read(previous, read, length - read, offset + read);
          if (!result.bytesRead) fail('FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
          read += result.bytesRead;
        }
        if (!previous.equals(bytes)) fail('FILE_ASSET_UPLOAD_OFFSET_CONFLICT');
        return fence(() => this.project(value));
      }
      let written = 0;
      while (written < bytes.length) {
        signal?.throwIfAborted();
        const result = await handle.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) fail('FILE_ASSET_UPLOAD_FAILED', 502);
        written += result.bytesWritten;
      }
      await handle.sync();
      const next = { ...value, offset: offset + length,
        expiresAt: Math.min(this.clock() + UPLOAD_CHECKPOINT_TTL_MS, value.hardExpiresAt) };
      return await fence(async () => {
        signal?.throwIfAborted();
        if (this.clock() >= next.expiresAt) fail('FILE_ASSET_UPLOAD_EXPIRED', 410);
        await writeJsonAtomic(this.paths(record).manifest, next, { mode: 0o600, durable: true });
        return this.project(next);
      });
    } finally { await handle.close(); }
  }

  async cancel(record, fence) {
    const value = await this.load(record);
    return fence(async () => {
      await writeJsonAtomic(this.paths(record).manifest, { ...value, cancelled: true }, { mode: 0o600, durable: true });
      await rm(this.paths(record).body, { force: true });
      return this.project({ ...value, cancelled: true });
    });
  }

  async clear(record) {
    const paths = this.paths(record);
    await rm(paths.body, { force: true });
    await rm(paths.manifest, { force: true });
  }
}

export function uploadChunkHeaders(headers) {
  const number = name => {
    const value = headers[name];
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) fail('INVALID_ARGUMENT', 400);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) fail('INVALID_ARGUMENT', 400);
    return parsed;
  };
  if (headers['content-type'] !== 'application/octet-stream') fail('INVALID_ARGUMENT', 415);
  return { offset: number('x-agentoc-upload-offset'), length: number('x-agentoc-upload-length'),
    sha256: headers['x-agentoc-upload-sha256'] };
}
