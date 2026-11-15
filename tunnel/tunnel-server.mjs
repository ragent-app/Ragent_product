#!/usr/bin/env node
// tunnel-server.mjs — Ragent reverse tunnel entry (runs on the public host).
//
// Listens on 127.0.0.1:PORT and exposes two roles:
//   POST /tunnel       — the single control connection initiated by the
//                        remote client (frame protocol, token-authenticated).
//   everything else    — browser traffic: the request is serialized and
//                        forwarded byte-for-byte over the tunnel as a stream
//                        toward the remote Ragent (127.0.0.1:7690).
//
// The forward target is fixed by --target; OPEN frames never carry an
// address, so a compromised tunnel peer cannot pivot to other ports.
//
// Usage:
//   node tunnel-server.mjs --port 17890 --target 127.0.0.1:7690 --token-file /etc/ragent/tunnel-token

import http from 'http';
import { timingSafeEqual } from 'crypto';
import {
  TYPE_AUTH, TYPE_OPEN, TYPE_DATA, TYPE_CLOSE, TYPE_END, TYPE_HEAD,
  TYPE_PING, TYPE_PONG, HEARTBEAT_TIMEOUT_MS, STREAM_QUEUE_LIMIT_BYTES,
  FrameDecoder, encodeFrame, nowStamp, log, parseTarget, loadToken, parseArgv,
} from './tunnel-common.mjs';

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'te', 'trailer', 'proxy-authenticate', 'proxy-authorization',
]);
const UPGRADE_REQUEST = 'upgrade';
const MAX_STREAM_ID = 0xffff;

function argError(message) {
  process.stderr.write(`tunnel-server: ${message}\n`);
  process.stderr.write('Usage: node tunnel-server.mjs --port <port> --target <host:port> --token-file <path>\n');
  process.exit(2);
}

function serializeRequestHead(req, includeUpgrade) {
  const lines = [`${req.method} ${req.url} HTTP/1.1\r\n`];
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'host') continue; // Host is rewritten below
    // tunnel-client re-marks the forward itself; never relay a far-end copy.
    if (lower === 'x-ragent-tunnel') continue;
    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
  }
  lines.push(`Host: ${req.headers.host || '127.0.0.1:7690'}\r\n`);
  if (includeUpgrade) {
    lines.push('Connection: Upgrade\r\n');
    lines.push(`Upgrade: ${req.headers.upgrade || 'websocket'}\r\n`);
  }
  lines.push('\r\n');
  return Buffer.from(lines.join(''), 'latin1');
}

class TunnelServer {
  constructor({ port, target, token }) {
    this.port = port;
    this.target = target;
    this.token = token;
    this.control = null; // { res, decoder, lastFrameAt, streamSockets }
    this.nextStreamId = 1;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
    this.server.on('clientError', (err, socket) => {
      log('server', 'client error', `${err.message} bytesParsed=${err?.bytesParsed} code=${err?.code} syscall=${err?.syscall} local=${socket?.localAddress}:${socket?.localPort} remote=${socket?.remoteAddress}:${socket?.remotePort}`);
      try {
        const leftover = socket.read(128);
        if (leftover && leftover.length > 0) {
          log('server', 'leftover bytes', leftover.toString('hex').slice(0, 128));
        }
      } catch {}
      socket.destroy();
    });
  }

  handleRequest(req, res) {
    log('server', `new request: ${req.method} ${req.url} from ${req.socket?.remoteAddress}:${req.socket?.remotePort}`);
    let url;
    try {
      url = new URL(req.url, 'http://tunnel.local');
    } catch {
      // Malformed request targets (e.g. "//") must never crash the process:
      // this server sits on the public internet, so anyone can send one.
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request\n');
      return;
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'tunnel-server', target: `${this.target.host}:${this.target.port}` }));
      return;
    }
    if (url.pathname === '/tunnel' && req.method === 'POST') {
      return this.acceptControl(req, res);
    }
    if (url.pathname === '/tunnel') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('tunnel endpoint expects POST\n');
      return;
    }
    if (!this.control) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('tunnel control connection not established\n');
      return;
    }
    this.routeRequest(req, res);
  }

  acceptControl(req, res) {
    const decoder = new FrameDecoder();
    let authenticated = false;
    const control = { req, res, decoder, lastFrameAt: Date.now() };

    // Defer sending the response head until the first write/end: AUTH can
    // still fail, and once headers are flushed the status can no longer be
    // changed (ERR_HTTP_HEADERS_SENT).
    res.statusCode = 200;
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');

    const processChunk = (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        log('server', 'protocol error, closing control', err.message);
        if (this.control === control) this.control = null;
        res.end();
        return;
      }
      for (const frame of frames) {
        control.lastFrameAt = Date.now();
        if (!authenticated) {
          if (frame.type !== TYPE_AUTH) {
            log('server', 'first frame is not AUTH, closing');
            if (this.control === control) this.control = null;
            res.end();
            return;
          }
          const expected = Buffer.from(this.token);
          const actual = frame.payload;
          const ok = actual.length === expected.length
            && timingSafeEqual(actual, expected);
          if (!ok) {
            // Never touch this.control on a failed AUTH: anyone on the
            // public internet can open a control connection, and replacing
            // (or clearing) the live tunnel here would be a trivial DoS.
            log('server', 'AUTH rejected');
            res.writeHead(403);
            res.end();
            return;
          }
          authenticated = true;
          if (this.control && this.control !== control) {
            log('server', 'replacing stale control connection');
            // Tear down the whole underlying connection: the old request
            // body is still streaming, so ending only the response would
            // leave a half-open HTTP/1.1 connection that a reverse proxy
            // would happily reuse for the next POST /tunnel, corrupting
            // the protocol.
            try { this.control.req.socket.destroy(); } catch {}
            try { this.control.res.end(); } catch {}
          }
          this.control = control;
          log('server', 'control authenticated, tunnel up');
          continue;
        }
        this.handleControlFrame(frame, control);
      }
    };

    req.on('data', processChunk);
    req.on('end', () => {
      log('server', 'control connection ended');
      if (this.control === control) this.control = null;
      this.closeAllStreams(control);
      // Never leave the socket reusable for a proxy's keep-alive pool.
      try { req.socket.destroy(); } catch {}
    });
    req.on('error', (err) => {
      log('server', 'control read error', err.message);
      if (this.control === control) this.control = null;
      this.closeAllStreams(control);
    });
    res.on('close', () => {
      if (this.control === control) this.control = null;
      this.closeAllStreams(control);
      try { req.socket.destroy(); } catch {}
    });

    // Idle watchdog: no frame for HEARTBEAT_TIMEOUT_MS means the peer is gone.
    const watchdog = setInterval(() => {
      if (Date.now() - control.lastFrameAt > HEARTBEAT_TIMEOUT_MS) {
        log('server', 'control idle timeout, closing');
        clearInterval(watchdog);
        if (this.control === control) this.control = null;
        this.closeAllStreams(control);
        try { res.end(); } catch {}
      }
    }, 15_000);
    watchdog.unref?.();
  }

  handleControlFrame(frame, control) {
    switch (frame.type) {
      case TYPE_PING:
        try { control.res.write(encodeFrame(TYPE_PONG, 0)); } catch {}
        break;
      case TYPE_DATA: {
        const stream = control.streamSockets?.get(frame.streamId);
        if (!stream) break;
        stream.receive(frame.payload);
        break;
      }
      case TYPE_HEAD: {
        const stream = control.streamSockets?.get(frame.streamId);
        if (!stream) break;
        let head;
        try {
          head = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          log('server', `stream ${frame.streamId} bad HEAD frame`);
          stream.abort();
          break;
        }
        log('server', `stream ${frame.streamId} HEAD status=${head?.status}`);
        stream.applyHead(head);
        break;
      }
      case TYPE_CLOSE: {
        const stream = control.streamSockets?.get(frame.streamId);
        if (!stream) break;
        stream.closeFromPeer();
        break;
      }
      default:
        log('server', `unexpected control frame type ${frame.type}`);
    }
  }

  allocateStreamId(control) {
    const streams = control.streamSockets ||= new Map();
    // Frame stream IDs are 16-bit. Keep the map key identical to the
    // encoded ID and reserve 0 for control frames (PING/PONG).
    for (let attempt = 0; attempt < MAX_STREAM_ID; attempt += 1) {
      const streamId = this.nextStreamId;
      this.nextStreamId = streamId >= MAX_STREAM_ID ? 1 : streamId + 1;
      if (!streams.has(streamId)) return streamId;
    }
    return null;
  }

  routeRequest(req, res) {
    const control = this.control;
    const streamId = this.allocateStreamId(control);
    if (streamId === null) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('tunnel stream capacity exhausted\n');
      return;
    }

    const stream = {
      id: streamId,
      response: res,
      headApplied: false,
      downQueue: [],
      downFlushing: false,
      upQueue: [],
      upFlushing: false,
      closed: false,
      receive(payload) {
        if (this.closed) return;
        if (this.upQueue.length === 0) {
          this.writeUp(payload);
        } else {
          this.upQueue.push(payload);
          this.flushUp();
        }
      },
      applyHead(head) {
        if (this.closed || this.headApplied) return;
        this.headApplied = true;
        const status = Number(head?.status) || 502;
        const headers = head?.headers && typeof head.headers === 'object' ? head.headers : {};
        try {
          this.response.writeHead(status, headers);
        } catch (err) {
          log('server', `stream ${this.id} writeHead failed: ${err.message}`);
          this.abort();
        }
      },
      writeUp(payload) {
        if (this.closed) return;
        if (this.upQueue.length >= STREAM_QUEUE_LIMIT_BYTES) {
          log('server', `stream ${this.id} up-queue overflow, aborting`);
          this.abort();
          return;
        }
        this.upQueue.push(payload);
        this.flushUp();
      },
      flushUp() {
        if (this.upFlushing) return;
        this.upFlushing = true;
        const flush = () => {
          while (this.upQueue.length > 0) {
            // write() returning false only signals backpressure; the bytes
            // are already buffered, so shift before writing to avoid
            // duplicating data.
            const chunk = this.upQueue.shift();
            if (!this.response.write(chunk)) {
              this.response.once('drain', flush);
              return;
            }
          }
          this.upFlushing = false;
          if (this.finishClosePending) this.finishClose();
        };
        flush();
      },
      writeDown(payload) {
        if (this.closed) return;
        if (this.downQueue.length >= STREAM_QUEUE_LIMIT_BYTES) {
          log('server', `stream ${this.id} down-queue overflow, aborting`);
          this.abort();
          return;
        }
        this.downQueue.push(payload);
        this.flushDown();
      },
      flushDown() {
        if (this.downFlushing || this.closed) return;
        this.downFlushing = true;
        const flush = () => {
          while (this.downQueue.length > 0 && !this.closed) {
            // write() returning false only signals backpressure; the bytes
            // are already buffered, so shift before writing to avoid
            // duplicating frames.
            const chunk = this.downQueue.shift();
            if (!control.res.write(encodeFrame(TYPE_DATA, this.id, chunk))) {
              control.res.once('drain', flush);
              return;
            }
          }
          this.downFlushing = false;
        };
        flush();
      },
      closeFromPeer() {
        if (this.closed) return;
        log('server', `stream ${this.id} closeFromPeer (peer CLOSE frame, upQueue=${this.upQueue.length})`);
        this.closed = true;
        control.streamSockets.delete(this.id);
        if (this.upQueue.length > 0) {
          // Queued response bytes must be flushed before finishing, or the
          // browser gets a truncated body.
          this.finishClosePending = true;
          this.flushUp();
          return;
        }
        this.finishClose();
      },
      finishClose() {
        this.finishClosePending = false;
        if (this.isUpgrade && this.rawSocket) {
          try { this.rawSocket.end(); } catch {}
        } else {
          try { this.response.end(); } catch {}
        }
      },
      abort() {
        if (this.closed) return;
        log('server', `stream ${this.id} abort`);
        this.closed = true;
        control.streamSockets.delete(this.id);
        try { control.res.write(encodeFrame(TYPE_CLOSE, this.id)); } catch {}
        if (this.isUpgrade && this.rawSocket) {
          try { this.rawSocket.destroy(); } catch {}
        } else {
          try { this.response.destroy(); } catch {}
        }
      },
    };
    control.streamSockets.set(streamId, stream);

    // Announce the stream, then ship the serialized request head.
    try {
      control.res.write(encodeFrame(TYPE_OPEN, streamId));
      stream.writeDown(serializeRequestHead(req, false));
    } catch (err) {
      log('server', 'control write failed', err.message);
      stream.abort();
      return;
    }

    // Upgrade requests never reach this handler (Node routes them to the
    // 'upgrade' event); here we stream the request body and wait for the
    // response bytes that arrive back through the tunnel as DATA frames.
    req.on('data', (chunk) => stream.writeDown(chunk));
    req.on('end', () => {
      // Browser request body finished: tell the peer to end its outbound
      // request body. The response still flows back on this stream.
      if (!stream.closed) {
        try { control.res.write(encodeFrame(TYPE_END, stream.id)); } catch {}
      }
    });
    req.on('aborted', () => stream.abort());
    res.on('close', () => {
      if (!stream.closed) stream.abort();
    });
  }

  handleUpgrade(req, socket) {
    log("server", `upgrade event: ${req.method} ${req.url}`);
    let url;
    try {
      url = new URL(req.url, 'http://tunnel.local');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname === '/tunnel' || !this.control) {
      socket.destroy();
      return;
    }
    const control = this.control;
    const streamId = this.allocateStreamId(control);
    if (streamId === null) {
      socket.destroy();
      return;
    }
    const stream = {
      id: streamId,
      isUpgrade: true,
      response: null,
      rawSocket: socket,
      headApplied: false,
      downQueue: [],
      downFlushing: false,
      upQueue: [],
      upFlushing: false,
      closed: false,
      receive(payload) {
        if (this.closed) return;
        if (!this.headApplied) return; // DATA before HEAD is a protocol violation
        this.writeUp(payload);
      },
      applyHead(head) {
        if (this.closed || this.headApplied) return;
        this.headApplied = true;
        const status = Number(head?.status) || 502;
        const statusText = http.STATUS_CODES[status] || 'Unknown';
        const headers = head?.headers && typeof head.headers === 'object' ? head.headers : {};
        log('server', `stream ${this.id} applyHead status=${status}`);
        // The upstream may refuse the upgrade (401/404/...); the status line
        // must then carry the real status or the browser will misread it as
        // a successful 101 upgrade with no headers.
        const lines = [`HTTP/1.1 ${status} ${statusText}\r\n`];
        for (const [name, value] of Object.entries(headers)) {
          if (!value) continue;
          lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
        }
        lines.push('\r\n');
        try {
          this.rawSocket.write(lines.join(''));
        } catch (err) {
          this.abort();
        }
      },
      writeUp(payload) {
        if (this.closed) return;
        if (this.upQueue.length >= STREAM_QUEUE_LIMIT_BYTES) {
          log('server', `stream ${this.id} up-queue overflow, aborting`);
          this.abort();
          return;
        }
        this.upQueue.push(payload);
        this.flushUp();
      },
      flushUp() {
        if (this.upFlushing) return;
        this.upFlushing = true;
        const flush = () => {
          while (this.upQueue.length > 0) {
            // write() returning false only signals backpressure; the bytes
            // are already buffered, so shift before writing to avoid
            // duplicating data.
            const chunk = this.upQueue.shift();
            if (!this.rawSocket.write(chunk)) {
              this.rawSocket.once('drain', flush);
              return;
            }
          }
          this.upFlushing = false;
          if (this.finishClosePending) this.finishClose();
        };
        flush();
      },
      writeDown(payload) {
        if (this.closed) return;
        if (this.downQueue.length >= STREAM_QUEUE_LIMIT_BYTES) {
          this.abort();
          return;
        }
        this.downQueue.push(payload);
        this.flushDown();
      },
      flushDown() {
        if (this.downFlushing || this.closed) return;
        this.downFlushing = true;
        const flush = () => {
          while (this.downQueue.length > 0 && !this.closed) {
            // write() returning false only signals backpressure; the bytes
            // are already buffered, so shift before writing to avoid
            // duplicating frames.
            const chunk = this.downQueue.shift();
            if (!control.res.write(encodeFrame(TYPE_DATA, this.id, chunk))) {
              control.res.once('drain', flush);
              return;
            }
          }
          this.downFlushing = false;
        };
        flush();
      },
      closeFromPeer() {
        if (this.closed) return;
        log('server', `stream ${this.id} closeFromPeer (peer CLOSE frame, upQueue=${this.upQueue.length})`);
        this.closed = true;
        control.streamSockets.delete(this.id);
        if (this.upQueue.length > 0) {
          // Queued bytes must reach the browser before the upgrade socket
          // is closed, or the tail of the stream is lost.
          this.finishClosePending = true;
          this.flushUp();
          return;
        }
        this.finishClose();
      },
      finishClose() {
        this.finishClosePending = false;
        try { this.rawSocket.end(); } catch {}
      },
      abort() {
        if (this.closed) return;
        this.closed = true;
        control.streamSockets.delete(this.id);
        try { control.res.write(encodeFrame(TYPE_CLOSE, this.id)); } catch {}
        try { this.rawSocket.destroy(); } catch {}
      },
    };
    control.streamSockets.set(streamId, stream);

    try {
      control.res.write(encodeFrame(TYPE_OPEN, streamId));
      control.res.write(encodeFrame(TYPE_DATA, streamId, serializeRequestHead(req, true)));
      control.res.write(encodeFrame(TYPE_END, streamId));
    } catch (err) {
      stream.abort();
      return;
    }

    socket.on('data', (chunk) => stream.writeDown(chunk));
    socket.on('end', () => {
      if (!stream.closed) stream.closeFromPeer();
    });
    socket.on('error', () => {
      if (!stream.closed) stream.abort();
    });
    socket.on('close', () => {
      if (!stream.closed) stream.abort();
    });
  }

  closeAllStreams(control) {
    const streams = control.streamSockets || new Map();
    for (const stream of streams.values()) {
      stream.closed = true;
      if (stream.rawSocket) {
        try { stream.rawSocket.destroy(); } catch {}
      } else {
        try { stream.response.destroy(); } catch {}
      }
    }
    streams.clear();
  }

  start() {
    this.server.listen(this.port, '127.0.0.1', () => {
      log('server', `listening on 127.0.0.1:${this.port}, forward target ${this.target.host}:${this.target.port}`);
    });
  }
}

const options = parseArgv(process.argv.slice(2));
const port = options.port !== undefined ? Number(options.port) : 17890;
if (!Number.isInteger(port) || port <= 0 || port > 65535) argError(`invalid --port "${options.port}"`);
const target = parseTarget(options.target, 7690);
loadToken(process.argv.slice(2))
  .then((token) => new TunnelServer({ port, target, token }).start())
  .catch((err) => argError(err.message));
