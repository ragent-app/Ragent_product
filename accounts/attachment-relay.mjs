import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The caller must authenticate accountId before reserve(). Capabilities travel
// only in Authorization headers and the reader capability is delivered to the
// target over the existing authenticated end-to-end control channel.
export function createAttachmentRelay({ maxTransferBytes = 64 * 1024 * 1024,
  maxReservedBytes = 256 * 1024 * 1024, maxTransfers = 64, maxPerAccount = 4,
  ttlMs = 5 * 60_000, clock = Date.now } = {}) {
  const entries = new Map();
  let reservedBytes = 0;
  const digest = value => createHash('sha256').update(value).digest();
  const token = () => randomBytes(32).toString('base64url');
  const fail = (res, status) => { if (!res.headersSent) res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end(); };
  function remove(entry) {
    if (entries.get(entry.id) !== entry) return;
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
  function lookup(id, credential, role) {
    const entry = entries.get(id);
    if (!entry || entry.expiresAt <= clock() || typeof credential !== 'string' || credential.length > 128) return null;
    const actual = digest(credential), expected = role === 'writer' ? entry.writeHash : entry.readHash;
    return timingSafeEqual(actual, expected) ? entry : null;
  }
  function start(entry) {
    if (!entry.writer || !entry.reader || entry.started) return;
    entry.started = true;
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
  function close() { for (const entry of [...entries.values()]) abort(entry); }
  return { reserve, attachWriter, attachReader, close };
}
