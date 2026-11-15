#!/usr/bin/env node
// tunnel-client.mjs — Ragent reverse tunnel peer (runs on the remote host
// that only has outbound connectivity).
//
// Keeps one long-lived HTTPS POST open to the public entry (through Caddy,
// TLS terminates there), authenticates with the shared token, and for every
// OPEN frame it receives acts as an HTTP forwarder toward the fixed local
// target (the Ragent on 127.0.0.1:7690): it parses the serialized request
// head, issues a real outbound HTTP request, and streams the (de-encoded)
// response body back as DATA frames. WebSocket/upgrade requests are bridged
// as raw byte streams after the 101 handshake. The client never listens.
//
// Usage:
//   node tunnel-client.mjs --url https://tunnel.example.com/tunnel \
//     --target 127.0.0.1:7690 --token-file /etc/ragent/tunnel-token

import http from 'http';
import http2 from 'http2';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  TYPE_AUTH, TYPE_OPEN, TYPE_DATA, TYPE_CLOSE, TYPE_END, TYPE_HEAD,
  TYPE_PING, TYPE_PONG,
  HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS,
  RECONNECT_BASE_MS, RECONNECT_MAX_MS, STREAM_QUEUE_LIMIT_BYTES,
  FrameDecoder, encodeFrame, log, parseTarget, loadToken, parseArgv,
} from './tunnel-common.mjs';

function argError(message) {
  process.stderr.write(`tunnel-client: ${message}\n`);
  process.stderr.write('Usage: node tunnel-client.mjs --url <https://host/tunnel> --target <host:port> --token-file <path>\n');
  process.exit(2);
}

const RESPONSE_HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'upgrade', 'te', 'trailer',
]);

function parseRequestHead(bytes) {
  const text = bytes.toString('latin1');
  const headEnd = text.indexOf('\r\n\r\n');
  if (headEnd === -1) return null;
  const lines = text.slice(0, headEnd).split('\r\n');
  const [method, url] = lines[0].split(' ');
  const headers = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!name) continue;
    headers[name.toLowerCase()] = value;
  }
  return { method, url, headers };
}

class TunnelClient {
  constructor({ url, target, token }) {
    this.url = url;
    this.target = target;
    this.token = token;
    this.req = null;
    this.res = null;
    this.decoder = new FrameDecoder();
    this.streams = new Map();
    this.lastFrameAt = 0;
    this.connected = false;
    this.stopping = false;
    this.retryDelay = RECONNECT_BASE_MS;
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
    this.h2client = null;
    // Node may emit delayed close/error events after a replacement control
    // connection is already up. Keep every callback scoped to the control
    // connection that installed it, so an old event cannot tear down the
    // new connection and start a reconnect loop.
    this.connectionSequence = 0;
    this.activeConnectionId = 0;
    this.pendingReconnect = false;
    this.reconnectTimer = null;
    this.reconnectSequence = 0;
  }

  async connect() {
    if (this.stopping || this.activeConnectionId) return;
    const connectionId = ++this.connectionSequence;
    this.activeConnectionId = connectionId;
    const isCurrent = () => !this.stopping && this.activeConnectionId === connectionId;
    const reconnect = (reason) => {
      if (isCurrent()) this.scheduleReconnect(reason, connectionId);
    };
    const parsed = new URL(this.url);
    // The control connection must run over HTTP/2: Caddy's
    // reverse_proxy does not deliver a streaming response to an
    // HTTP/1.1 client until the request body is complete, which
    // would deadlock this full-duplex POST. Over h2 the response
    // frames flow while the request body stays open.
    const client = http2.connect(parsed.origin);
    this.h2client = client;
    client.on('error', (err) => {
      reconnect(`connect error: ${err.message}`);
    });
    client.on('close', () => {
      if (isCurrent() && this.connected) reconnect('tunnel connection closed');
    });
    const req = client.request({
      ':method': 'POST',
      ':path': parsed.pathname + parsed.search,
      'content-type': 'application/octet-stream',
    });
    req.on('response', (headers) => {
      if (!isCurrent()) return;
      if (headers[':status'] !== 200) {
        log('client', `tunnel endpoint returned ${headers[':status']}, retrying`);
        req.close();
        reconnect();
        return;
      }
      this.res = req;
    });
    req.on('data', (chunk) => {
      if (isCurrent()) this.handleChunk(chunk);
    });
    req.on('end', () => reconnect('tunnel closed by server'));
    req.on('aborted', () => reconnect('tunnel aborted by server'));
    req.on('error', (err) => reconnect(`tunnel read error: ${err.message}`));
    req.on('close', () => {
      if (isCurrent() && this.connected) reconnect('tunnel stream closed');
    });
    this.req = req;
    try {
      req.write(encodeFrame(TYPE_AUTH, 0, Buffer.from(this.token)));
    } catch (err) {
      reconnect(`auth write error: ${err.message}`);
      return;
    }
    this.connected = true;
    this.retryDelay = RECONNECT_BASE_MS;
    this.lastFrameAt = Date.now();
    this.startTimers(connectionId);
    log('client', `tunnel connected to ${this.url} (target ${this.target.host}:${this.target.port})`);
  }

  startTimers(connectionId) {
    this.stopTimers();
    this.heartbeatTimer = setInterval(() => {
      if (this.activeConnectionId === connectionId && this.connected && this.req) {
        try { this.req.write(encodeFrame(TYPE_PING, 0)); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    this.watchdogTimer = setInterval(() => {
      if (this.activeConnectionId === connectionId && this.connected && Date.now() - this.lastFrameAt > HEARTBEAT_TIMEOUT_MS) {
        log('client', 'heartbeat timeout, reconnecting');
        this.scheduleReconnect('heartbeat timeout', connectionId);
      }
    }, 15_000);
    this.watchdogTimer.unref?.();
  }

  stopTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
  }

  teardown(connectionId = null) {
    if (connectionId !== null && connectionId !== this.activeConnectionId) return false;
    this.activeConnectionId = 0;
    this.connected = false;
    this.stopTimers();
    try { this.h2client?.destroy(); } catch {}
    try { this.req?.destroy(); } catch {}
    try { this.res?.destroy(); } catch {}
    this.h2client = null;
    this.req = null;
    this.res = null;
    for (const stream of this.streams.values()) {
      stream.closed = true;
      try { stream.upReq?.destroy(); } catch {}
      try { stream.rawSocket?.destroy(); } catch {}
    }
    this.streams.clear();
    this.decoder = new FrameDecoder();
    return true;
  }

  scheduleReconnect(reason, connectionId = this.activeConnectionId) {
    if (this.stopping || this.pendingReconnect || connectionId !== this.activeConnectionId) return;
    if (this.connected) {
      log('client', `disconnected (${reason || 'unknown'})`);
    }
    this.teardown(connectionId);
    this.pendingReconnect = true;
    const reconnectId = ++this.reconnectSequence;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(RECONNECT_MAX_MS, this.retryDelay * 2);
    log('client', `reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping || reconnectId !== this.reconnectSequence) return;
      this.pendingReconnect = false;
      // A new control connection won the race while this retry was waiting.
      // Leave it alone instead of creating a second client session.
      if (this.activeConnectionId) return;
      this.connect().catch(() => {});
    }, delay);
  }

  handleChunk(chunk) {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.scheduleReconnect(`protocol error: ${err.message}`);
      return;
    }
    for (const frame of frames) {
      this.lastFrameAt = Date.now();
      const stream = this.streams.get(frame.streamId);
      switch (frame.type) {
        case TYPE_PONG:
          break;
        case TYPE_OPEN:
          this.openStream(frame.streamId);
          break;
        case TYPE_DATA:
          if (stream) stream.receive(frame.payload);
          break;
        case TYPE_END:
          if (stream) stream.requestEnded();
          break;
        case TYPE_CLOSE:
          if (stream) stream.closeFromPeer();
          break;
        default:
          log('client', `unexpected frame type ${frame.type}`);
      }
    }
  }

  openStream(streamId) {
    if (this.streams.has(streamId)) return;
    const client = this;
    const stream = {
      id: streamId,
      headBuffer: Buffer.alloc(0),
      headDone: false,
      upReq: null,
      rawSocket: null,
      upQueue: [],
      upFlushing: false,
      downQueue: [],
      downFlushing: false,
      closed: false,
      receive: (payload) => {
        if (stream.closed) return;
        if (!stream.headDone) {
          stream.headBuffer = stream.headBuffer.length === 0
            ? payload
            : Buffer.concat([stream.headBuffer, payload]);
          const head = parseRequestHead(stream.headBuffer);
          if (!head) return;
          stream.headDone = true;
          stream.headBuffer = Buffer.alloc(0);
          stream.startRequest(head);
          return;
        }
        if (stream.rawSocket) {
          if (stream.downQueue.length === 0) {
            stream.writeDown(payload);
          } else {
            stream.downQueue.push(payload);
            stream.flushDown();
          }
          return;
        }
        if (stream.upReq) stream.upReq.write(payload);
      },
      startRequest: (head) => {
        const isUpgrade = String(head.headers.upgrade || '').toLowerCase() !== '';
        // The TCP peer at the target is always this local process, so the chat
        // server cannot tell remote browsers from a direct loopback one. Mark
        // every forward as tunnel-borne; inbound copies are overwritten, never
        // trusted, so the far end cannot fake "direct local access".
        const headers = { ...head.headers };
        delete headers['x-ragent-tunnel'];
        headers['x-ragent-tunnel'] = '1';
        const options = {
          method: head.method,
          host: client.target.host,
          port: client.target.port,
          path: head.url,
          headers,
        };
        if (isUpgrade) {
          options.headers.connection = 'Upgrade';
          options.headers.upgrade = head.headers.upgrade || 'websocket';
        }
        const upReq = http.request(options);
        stream.upReq = upReq;
        upReq.on('response', (upRes) => {
          if (stream.closed) return;
          stream.sendHead(upRes.statusCode || 200, upRes.headers);
          stream._upBytes = 0;
          upRes.on('data', (chunk) => {
            stream._upBytes += chunk.length;
            stream.writeUp(chunk);
          });
          upRes.on('end', () => {
            log('client', `stream ${stream.id} upstream response ended, bytes=${stream._upBytes}`);
            stream.closeFromPeer();
          });
          upRes.on('error', () => {
            log('client', `stream ${stream.id} upstream response error`);
            stream.closeFromPeer();
          });
        });
        upReq.on('upgrade', (upRes, socket) => {
          log('client', `stream ${stream.id} upstream 101 upgrade`);
          if (stream.closed) {
            socket.destroy();
            return;
          }
          stream.rawSocket = socket;
          // Pass the full upstream 101 head (sec-websocket-accept included);
          // sendHead keeps hop-by-hop headers for 101 responses.
          stream.sendHead(101, upRes.headers);
          socket.on('data', (chunk) => stream.writeUp(chunk));
          socket.on('end', () => stream.closeFromPeer());
          socket.on('error', () => stream.closeFromPeer());
          socket.on('close', () => {
            if (!stream.closed) stream.closeFromPeer();
          });
        });
        upReq.on('error', (err) => {
          log('client', `stream ${stream.id} upstream error: ${err.message}`);
          stream.closeFromPeer();
        });
      },
      sendHead: (status, headers) => {
        log('client', `stream ${stream.id} sendHead status=${status}`);
        const head = { status, headers: {} };
        for (const [name, value] of Object.entries(headers)) {
          if (!value) continue;
          // 101 must keep Upgrade/Connection headers or the browser-side
          // client will not treat the response as an upgrade.
          if (status !== 101 && RESPONSE_HOP_BY_HOP.has(name.toLowerCase())) continue;
          head.headers[name] = value;
        }
        try {
          if (client.req) {
            client.req.write(encodeFrame(TYPE_HEAD, stream.id, Buffer.from(JSON.stringify(head))));
          }
        } catch {}
      },
      requestEnded: () => {
        if (stream.closed) return;
        if (stream.upReq) {
          try { stream.upReq.end(); } catch {}
        }
      },
      writeDown: (payload) => {
        if (stream.closed || !stream.rawSocket) return;
        if (stream.downQueue.length >= STREAM_QUEUE_LIMIT_BYTES) {
          log('client', `stream ${stream.id} down-queue overflow, aborting`);
          stream.abort();
          return;
        }
        stream.downQueue.push(payload);
        stream.flushDown();
      },
      flushDown: () => {
        if (stream.downFlushing || stream.closed) return;
        stream.downFlushing = true;
        const flush = () => {
          while (stream.downQueue.length > 0 && !stream.closed) {
            // write() returning false only signals backpressure; the bytes
            // are already buffered, so shift before writing to avoid
            // duplicating data.
            const chunk = stream.downQueue.shift();
            if (!stream.rawSocket.write(chunk)) {
              stream.rawSocket.once('drain', flush);
              return;
            }
          }
          stream.downFlushing = false;
        };
        flush();
      },
      writeUp: (payload) => {
        if (stream.closed) return;
        if (stream.upQueue.length >= STREAM_QUEUE_LIMIT_BYTES) {
          log('client', `stream ${stream.id} up-queue overflow, aborting`);
          stream.abort();
          return;
        }
        stream.upQueue.push(payload);
        stream.flushUp();
      },
      flushUp: () => {
        if (stream.upFlushing) return;
        stream.upFlushing = true;
        const flush = () => {
          while (stream.upQueue.length > 0) {
            // write() returning false only signals backpressure; the bytes
            // are already buffered, so shift before writing to avoid
            // duplicating frames.
            const frame = encodeFrame(TYPE_DATA, stream.id, stream.upQueue.shift());
            if (!client.req || !client.req.write(frame)) {
              if (client.req) client.req.once('drain', flush);
              return;
            }
          }
          stream.upFlushing = false;
          if (stream.finishClosePending) stream.finishClose();
        };
        flush();
      },
      closeFromPeer: (reason) => {
        if (stream.closed) return;
        log('client', `stream ${stream.id} closeFromPeer (${reason || 'peer CLOSE frame'}, upQueue=${stream.upQueue.length})`);
        stream.closed = true;
        client.streams.delete(stream.id);
        if (stream.upQueue.length > 0) {
          // Queued frames must reach the peer before CLOSE: let flushUp
          // drain the queue, then send the CLOSE frame.
          stream.finishClosePending = true;
          stream.flushUp();
          return;
        }
        stream.finishClose();
      },
      finishClose: () => {
        stream.finishClosePending = false;
        try { client.req?.write(encodeFrame(TYPE_CLOSE, stream.id)); } catch {}
        try { stream.upReq?.destroy(); } catch {}
        try { stream.rawSocket?.destroy(); } catch {}
      },
      abort: () => {
        if (stream.closed) return;
        stream.closed = true;
        client.streams.delete(stream.id);
        try { client.req?.write(encodeFrame(TYPE_CLOSE, stream.id)); } catch {}
        try { stream.upReq?.destroy(); } catch {}
        try { stream.rawSocket?.destroy(); } catch {}
      },
    };
    this.streams.set(streamId, stream);
    log('client', `stream ${streamId} open (waiting for request head)`);
  }

  stop() {
    this.stopping = true;
    this.reconnectSequence += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.pendingReconnect = false;
    this.teardown();
    log('client', 'stopped');
  }
}

export { TunnelClient };

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgv(argv);
  const url = options.url || '';
  if (!/^https?:\/\//.test(url)) argError(`invalid --url "${url}"`);
  const target = parseTarget(options.target, 7690);
  try {
    const token = await loadToken(argv);
    const client = new TunnelClient({ url, target, token });
    client.connect().catch(() => {});
    const shutdown = () => {
      client.stop();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    argError(err.message);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
