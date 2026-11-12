import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The caller must authenticate accountId before reserve(). Capabilities travel
// only in Authorization headers and the reader capability is delivered to the
// target over the existing authenticated end-to-end control channel.
export function createAttachmentRelay({ maxTransferBytes = 64 * 1024 * 1024,
  maxReservedBytes = 256 * 1024 * 1024, maxTransfers = 64, maxPerAccount = 4,
  ttlMs = 5 * 60_000, maxFences = 4096, clock = Date.now } = {}) {
  const entries = new Map();
  const fences = new Map();
  const epoch = randomBytes(16).toString('hex');
  let barrierUntil = 0;
  let reservedBytes = 0;
  const digest = value => createHash('sha256').update(value).digest();
  const token = () => randomBytes(32).toString('base64url');
  const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
  function pruneFences() {
    const now = clock();
    for (const [id, fence] of fences) if (fence.deadline <= now) fences.delete(id);
  }
  function fence(id, accountId, writeHash, deadline) {
    if (deadline <= clock()) return;
    pruneFences();
    if (!fences.has(id) && fences.size >= maxFences) {
      // While saturated, fail closed until this request can no longer arrive.
      barrierUntil = Math.max(barrierUntil, deadline);
      return;
    }
    fences.set(id, { accountId, writeHash, deadline });
  }
  const fail = (res, status) => { if (!res.headersSent) res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end(); };
  function remove(entry) {
    if (entries.get(entry.id) !== entry) return;
    if (entry.v2Deadline) fence(entry.id, entry.accountId, entry.writeHash, entry.v2Deadline);
    entries.delete(entry.id);
    reservedBytes -= entry.size;
    clearTimeout(entry.timer);
  }
  function abort(entry, status = 410) {
    remove(entry);
    if (entry.reader && !entry.reader.writableEnded) fail(entry.reader, status);
    if (entry.writerResponse && !entry.writerResponse.writableEnded) fail(entry.writerResponse, status);
    entry.writer?.destroy();
  }
  function reserve(accountId, size) {
    if (typeof accountId !== 'string' || !accountId || !Number.isSafeInteger(size) || size < 1 || size > maxTransferBytes)
      throw new Error('Invalid relay reservation');
    const count = [...entries.values()].filter(e => e.accountId === accountId).length;
    if (entries.size >= maxTransfers || count >= maxPerAccount || reservedBytes + size > maxReservedBytes)
      throw new Error('Relay capacity exhausted');
    const id = randomBytes(16).toString('hex'), writeToken = token(), readToken = token();
    const entry = { id, accountId, size, writeHash: digest(writeToken), readHash: digest(readToken),
      expiresAt: clock() + ttlMs, writer: null, writerResponse: null, reader: null, started: false };
    entry.timer = setTimeout(() => abort(entry), ttlMs);
    entry.timer.unref?.();
    entries.set(id, entry); reservedBytes += size;
    return { id, writeToken, readToken, size, expiresAt: entry.expiresAt };
  }
  function validateV2(accountId, payload, requireRead) {
    if (typeof accountId !== 'string' || !accountId || !payload ||
        payload.epoch !== epoch || !/^[a-f0-9]{32}$/.test(payload.id || '') ||
        !validToken(payload.writeToken) || !Number.isSafeInteger(payload.deadline) ||
        payload.deadline > clock() + ttlMs ||
        (requireRead && (!validToken(payload.readToken) || payload.readToken === payload.writeToken ||
          !Number.isSafeInteger(payload.sizeBytes) || payload.sizeBytes < 1 || payload.sizeBytes > maxTransferBytes))) {
      throw new Error('Invalid v2 relay reservation');
    }
  }
  function reserveV2(accountId, payload) {
    validateV2(accountId, payload, true);
    if (payload.deadline <= clock()) throw new Error('Expired v2 relay reservation');
    pruneFences();
    const writeHash = digest(payload.writeToken), readHash = digest(payload.readToken);
    const priorFence = fences.get(payload.id);
    if (priorFence) throw new Error('V2 relay reservation fenced');
    const prior = entries.get(payload.id);
    if (prior) {
      if (prior.accountId !== accountId || prior.size !== payload.sizeBytes || prior.v2Deadline !== payload.deadline ||
          !timingSafeEqual(prior.writeHash, writeHash) || !timingSafeEqual(prior.readHash, readHash)) {
        throw new Error('V2 relay reservation conflict');
      }
      return { id: prior.id, size: prior.size, deadline: prior.v2Deadline, epoch };
    }
    if (clock() < barrierUntil) throw new Error('Relay capacity exhausted');
    const count = [...entries.values()].filter(e => e.accountId === accountId).length;
    if (entries.size >= maxTransfers || count >= maxPerAccount || reservedBytes + payload.sizeBytes > maxReservedBytes)
      throw new Error('Relay capacity exhausted');
    const entry = { id: payload.id, accountId, size: payload.sizeBytes, writeHash, readHash,
      expiresAt: payload.deadline, v2Deadline: payload.deadline, writer: null, writerResponse: null, reader: null, started: false };
    entry.timer = setTimeout(() => abort(entry), Math.max(1, payload.deadline - clock()));
    entry.timer.unref?.();
    entries.set(entry.id, entry); reservedBytes += entry.size;
    return { id: entry.id, size: entry.size, deadline: entry.v2Deadline, epoch };
  }
  function cancelV2(accountId, payload) {
    validateV2(accountId, payload, false);
    pruneFences();
    const writeHash = digest(payload.writeToken), prior = entries.get(payload.id), priorFence = fences.get(payload.id);
    if (prior && (prior.accountId !== accountId || prior.v2Deadline !== payload.deadline || !timingSafeEqual(prior.writeHash, writeHash))) return false;
    if (priorFence && (priorFence.accountId !== accountId || priorFence.deadline !== payload.deadline ||
        !timingSafeEqual(priorFence.writeHash, writeHash))) return false;
    if (payload.deadline <= clock()) {
      if (prior) abort(prior);
      return true;
    }
    fence(payload.id, accountId, writeHash, payload.deadline);
    if (prior) abort(prior);
    return true;
  }
  function lookup(id, credential, role) {
    const entry = entries.get(id);
    if (!entry || entry.expiresAt <= clock() || typeof credential !== 'string' || credential.length > 128) return null;
    const actual = digest(credential), expected = role === 'writer' ? entry.writeHash : entry.readHash;
    return timingSafeEqual(actual, expected) ? entry : null;
  }
  function start(entry) {
    if (!entry.writer || !entry.reader || entry.started) return;
    entry.started = true;
    if (entry.v2Deadline) {
      // The short request deadline fences retries, not an active transfer.
      // Once both ends attach, retain the same transfer timeout as v1.
      clearTimeout(entry.timer);
      entry.expiresAt = clock() + ttlMs;
      entry.timer = setTimeout(() => abort(entry), ttlMs);
      entry.timer.unref?.();
    }
    let seen = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) {
      seen += chunk.length;
      done(seen > entry.size ? new Error('Relay body exceeds reservation') : null, chunk);
    }, flush(done) { done(seen === entry.size ? null : new Error('Relay body incomplete')); } });
    entry.reader.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': entry.size,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    pipeline(entry.writer, limit, entry.reader).then(() => {
      remove(entry);
      if (!entry.writerResponse.writableEnded) { entry.writerResponse.writeHead(204, { 'Cache-Control': 'no-store' }); entry.writerResponse.end(); }
    }, () => abort(entry, 502));
  }
  function attachWriter(id, credential, req, res, contentLength = req.headers?.['content-length']) {
    const entry = lookup(id, credential, 'writer');
    if (!entry) return fail(res, 404);
    if (entry.writer || entry.started) return fail(res, 409);
    if (contentLength !== undefined && String(entry.size) !== contentLength) return fail(res, 400);
    entry.writer = req; entry.writerResponse = res;
    req.once('aborted', () => abort(entry, 502));
    res.once('close', () => { if (!res.writableEnded) abort(entry, 502); });
    start(entry);
  }
  function attachReader(id, credential, res) {
    const entry = lookup(id, credential, 'reader');
    if (!entry) return fail(res, 404);
    if (entry.reader || entry.started) return fail(res, 409);
    entry.reader = res;
    res.once('close', () => { if (!res.writableEnded) abort(entry, 502); });
    start(entry);
  }
  // Only the writer capability may abandon its own reservation. The same
  // path also aborts an in-flight stream so capacity is promptly reclaimed.
  function cancel(id, credential) {
    const entry = lookup(id, credential, 'writer');
    if (!entry) return false;
    abort(entry);
    return true;
  }
  function close() { for (const entry of [...entries.values()]) abort(entry); }
  return { reserve, reserveV2, cancelV2, capabilities: () => ({ version: 2, epoch, maxLifetimeMs: ttlMs }),
    attachWriter, attachReader, cancel, close };
}
