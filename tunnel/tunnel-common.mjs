// tunnel-common.mjs — Ragent reverse tunnel shared frame protocol.
//
// The tunnel carries many logical streams over one long-lived HTTPS POST
// (request body + response body run duplex over HTTP/1.1 chunked). Every
// payload is a framed sequence:
//
//   [magic 1B 0xA5][type 1B][streamId 2B BE][length 4B BE][payload length bytes]
//
// Types:
//   0x01 AUTH  — first frame of the control connection, payload = token
//   0x02 OPEN  — server asks client to open a stream (payload empty)
//   0x03 DATA  — payload is application bytes for streamId
//   0x04 CLOSE — stream finished (payload empty)
//   0x05 PING  — keepalive probe (payload empty)
//   0x06 PONG  — keepalive reply (payload empty)
//   0x07 END   — request direction finished (client must end the outbound
//                request body; server sends it after the browser request
//                body ends, or immediately for upgrade requests)
//   0x08 HEAD  — client → server: first frame of a stream carrying the
//                upstream response head as JSON {status, headers}
//
// The OPEN frame carries no target address: the client side is configured
// with the only allowed local target, so a compromised client cannot pivot
// to other ports. Frames never contain session content beyond the streamed
// bytes themselves; nothing is logged.

export const MAGIC = 0xa5;
export const TYPE_AUTH = 0x01;
export const TYPE_OPEN = 0x02;
export const TYPE_DATA = 0x03;
export const TYPE_CLOSE = 0x04;
export const TYPE_PING = 0x05;
export const TYPE_PONG = 0x06;
export const TYPE_END = 0x07;
export const TYPE_HEAD = 0x08;

export const HEADER_SIZE = 8;
export const MAX_FRAME_SIZE = 1 << 20; // 1 MiB per frame, larger payloads are chunked
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const STREAM_QUEUE_LIMIT_BYTES = 16 * 1024 * 1024; // per-stream pending cap

export function encodeFrameHeader(type, streamId, length) {
  const header = Buffer.alloc(HEADER_SIZE);
  header[0] = MAGIC;
  header[1] = type;
  header.writeUInt16BE(streamId & 0xffff, 2);
  header.writeUInt32BE(length >>> 0, 4);
  return header;
}

export function encodeFrame(type, streamId, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_SIZE) {
    throw new Error(`frame too large: ${body.length}`);
  }
  return Buffer.concat([encodeFrameHeader(type, streamId, body.length), body]);
}

// Incremental frame parser. push() returns any complete frames.
export class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (;;) {
      if (this.buffer.length < HEADER_SIZE) break;
      const magic = this.buffer[0];
      if (magic !== MAGIC) throw new Error(`bad frame magic 0x${magic.toString(16)}`);
      const type = this.buffer[1];
      const streamId = this.buffer.readUInt16BE(2);
      const length = this.buffer.readUInt32BE(4);
      if (length > MAX_FRAME_SIZE) throw new Error(`oversized frame ${length}`);
      if (this.buffer.length < HEADER_SIZE + length) break;
      const payload = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length);
      frames.push({ type, streamId, payload: Buffer.from(payload) });
      this.buffer = this.buffer.subarray(HEADER_SIZE + length);
      if (this.buffer.length === 0) this.buffer = Buffer.alloc(0);
    }
    return frames;
  }
}

export function nowStamp() {
  return new Date().toISOString();
}

export function log(role, message, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  process.stdout.write(`${nowStamp()} [${role}] ${message}${suffix}\n`);
}

export function parseTarget(value, fallbackPort) {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error('missing --target host:port');
  const colon = trimmed.lastIndexOf(':');
  if (colon <= 0 || colon === trimmed.length - 1) {
    throw new Error(`invalid --target "${trimmed}" (expect host:port)`);
  }
  const host = trimmed.slice(0, colon);
  const port = Number(trimmed.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --target port in "${trimmed}"`);
  }
  return { host, port };
}

// Load a token from --token or --token-file. File wins when both are given.
export async function loadToken(argv) {
  const inline = argv.includes('--token')
    ? argv[argv.indexOf('--token') + 1] || ''
    : '';
  if (inline) return inline;
  const fileIndex = argv.indexOf('--token-file');
  if (fileIndex === -1) throw new Error('need --token <raw> or --token-file <path>');
  const filePath = argv[fileIndex + 1];
  if (!filePath) throw new Error('--token-file requires a path');
  const { readFile } = await import('fs/promises');
  const value = (await readFile(filePath, 'utf8')).trim();
  if (!value) throw new Error(`token file ${filePath} is empty`);
  return value;
}

export function parseArgv(argv, aliases = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = aliases[token] || token.slice(2);
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      options[key] = value;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}
