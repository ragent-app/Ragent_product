import { createHmac } from 'crypto';
import http from 'http';
import { isIP } from 'net';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { signP2PSignal, verifyP2PSignal } from './p2p-signal-protocol.mjs';
import { resolveP2PHostBinary } from './p2p-host-binary.mjs';
import { createConnectivityPolicyEngine } from './connectivity-policy-engine.mjs';
import { temporaryControlCarrierRoute } from './temporary-control-routes.mjs';
import {
  buildManagedProcessSpawnSpec,
  spawnManagedProcess,
  terminateManagedProcessTree,
} from './windows-managed-spawn.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 与手机端 OkHttp pingInterval(20s) 对齐：公网代理对无心跳的 WS 有空闲超时
// （本机实测约 100s），host 侧若不主动 ping，邀请窗口内连接即被掐断，
// 之后 mobile 的 offer 会中继给空气，客户端只能干等到邀请过期。
const KEEPALIVE_INTERVAL_MS = 20_000;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_SIDECAR_LINE_BYTES = 1 * 1024 * 1024;
function wsUrl(value) { const url = new URL(value); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; if (url.pathname === '/') url.pathname = '/signal'; return url.toString(); }

// The TURN broker contract uses one `urls` string per ICE server, while the
// Go/Pion sidecar accepts the standard WebRTC list shape. Normalize at this
// process boundary so both sides keep their public contracts unchanged.
// Optional local escape hatch for networks where UDP DNS is polluted and the
// TURN hostname resolves to a bogus address (observed on some mainland-China
// networks: turn.cloudflare.com → 198.20.0.x). RAGENT_P2P_TURN_HOST_RESOLVE
// holds `hostname=address` pairs (comma-separated) rewritten into every TURN
// URL before they reach the sidecar; TURN short-term credentials are not
// bound to the hostname, so only the dial target changes.
function rewriteIceServerUrl(url) {
  const resolveMap = String(process.env.RAGENT_P2P_TURN_HOST_RESOLVE || '').trim();
  if (!resolveMap) return url;
  for (const pair of resolveMap.split(',')) {
    const [hostname, address] = pair.split('=').map((value) => String(value || '').trim());
    if (!hostname || !isIP(address)) continue;
    // Match the complete authority, not a substring of a different host.
    // Keep protocol, port and transport query from the verified contract.
    const match = url.match(/^(turns?:)(\/\/)?(\[[^\]]+\]|[^:/?]+)(:\d+)?(\?.*)?$/i);
    if (match && match[3].toLowerCase() === hostname.toLowerCase()) {
      const dialHost = isIP(address) === 6 ? `[${address}]` : address;
      return `${match[1]}${match[2] || ''}${dialHost}${match[4] || ''}${match[5] || ''}`;
    }
  }
  return url;
}

export function normalizeP2PHostIceServers(iceServers) {
  if (!Array.isArray(iceServers)) return [];
  return iceServers.map((server) => {
    if (!server || typeof server !== 'object') {
      throw new Error('P2P host ICE server is invalid');
    }
    const rawUrls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const urls = rawUrls
      .filter((url) => typeof url === 'string')
      .map((url) => url.trim())
      .filter(Boolean)
      .map(rewriteIceServerUrl);
    if (!urls.length) throw new Error('P2P host ICE server has no URLs');
    const username = typeof server.username === 'string' ? server.username.trim() : '';
    const credential = typeof server.credential === 'string'
      ? server.credential.trim()
      : typeof server.password === 'string'
        ? server.password.trim()
        : '';
    return {
      urls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    };
  });
}

export async function runP2PHostAgent({ signalingUrl, roomId, secret, expiresAt, binaryPath = resolveP2PHostBinary(root), localBaseUrl = 'http://127.0.0.1:7690', browserAuth = null, temporaryDevice = null, temporaryIngress = null, temporaryControlDevice = null, temporaryControlIngress = null, iceServers = [], relayOnly = false, onPolicyDecision = null, onGatewayResponse = null, onSidecarLog = null, handoffId = '', authorizationGuard = null }) {
  if (handoffId && !/^[a-f0-9]{32}$/.test(handoffId)) throw new Error('invalid P2P handoff identifier');
  const normalizedIceServers = normalizeP2PHostIceServers(iceServers);
  // Start an in-process loopback HTTP proxy that applies the unified gateway policy
  // engine before forwarding to the real upstream. The Go sidecar bridges DataChannel
  // requests to this proxy (RAGENT_P2P_LOCAL_BASE_URL), not directly to :7690.
  // A P2P host carries one temporary authority type. v2 full-control is a
  // separate option, so an old v1 sharing credential cannot select its route
  // inventory by adding a request header.
  if (temporaryDevice && temporaryControlDevice) throw new Error('P2P host cannot mix temporary carrier types');
  const carrier = temporaryControlDevice
    ? { device: temporaryControlDevice, ingress: temporaryControlIngress, route: temporaryControlCarrierRoute }
    : { device: temporaryDevice, ingress: temporaryIngress, route: undefined };
  const temporaryIngressReady = Boolean(carrier.device && typeof carrier.ingress === 'function');
  const policyEngine = createConnectivityPolicyEngine({ instanceId: browserAuth?.instanceId || '',
    temporaryDevice: carrier.device, temporaryIngressReady, temporaryRoute: carrier.route });
  const upstreamUrl = new URL(localBaseUrl);
  const proxyServer = http.createServer((proxyReq, proxyRes) => {
    // Discovery is exclusively for the local Android app, never a carrier.
    if (process.env.RAGENT_RUNTIME_MODE === 'proot'
        && new URL(proxyReq.url || '/', 'http://connectivity.local').pathname === '/api/local/discovery') {
      proxyRes.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      proxyRes.end(JSON.stringify({ error: 'Local discovery is unavailable on a remote carrier' }));
      return;
    }
    if (authorizationGuard && !authorizationGuard()) {
      proxyRes.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      proxyRes.end(JSON.stringify({ error: 'Remote authorization is inactive' }));
      return;
    }
    // A local owner token is never accepted through a remote carrier, including
    // routes normally exposed for device bootstrap.
    if (process.env.RAGENT_RUNTIME_MODE === 'proot'
        && (/^Bearer [a-f0-9]{64}$/.test(String(proxyReq.headers.authorization || '')) || proxyReq.headers.cookie)) {
      proxyRes.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      proxyRes.end(JSON.stringify({ error: 'Local credential cannot be used on a remote carrier' }));
      return;
    }
    const decision = policyEngine.decide(proxyReq);
    try {
      onPolicyDecision?.({
        requestId: String(proxyReq.headers['x-ragent-request-id'] || ''),
        method: proxyReq.method,
        path: new URL(proxyReq.url || '/', 'http://connectivity.local').pathname,
        decision: decision.kind,
        principalType: decision.principalKind || '',
        permission: decision.scope || '',
      });
    } catch {}
    if (decision.kind === 'temporary_authenticated') {
      Promise.resolve().then(() => carrier.ingress(proxyReq, proxyRes)).catch(() => {
        if (!proxyRes.headersSent && !proxyRes.destroyed) {
          proxyRes.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
          proxyRes.end(JSON.stringify({ code: 'temporary_request_failed' }));
        }
      });
      return;
    }
    if (decision.kind === 'blocked') {
      proxyRes.writeHead(403, { 'Content-Type': 'application/json' });
      proxyRes.end(JSON.stringify({ error: 'Route is not exposed by the device policy' }));
      return;
    }
    if (decision.kind === 'unauthorized') {
      proxyRes.writeHead(401, { 'Content-Type': 'application/json' });
      proxyRes.end(JSON.stringify({ error: 'Trusted-device bearer authentication is required' }));
      return;
    }
    // allowed: authenticated, public_bootstrap, local_health
    const forwardReq = http.request({
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: proxyReq.method,
      path: proxyReq.url,
      headers: { ...proxyReq.headers, host: upstreamUrl.host },
    }, (upstreamRes) => {
      try {
        onGatewayResponse?.({
          requestId: String(proxyReq.headers['x-ragent-request-id'] || ''),
          path: new URL(proxyReq.url || '/', 'http://connectivity.local').pathname,
          status: upstreamRes.statusCode || 502,
        });
      } catch {}
      proxyRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(proxyRes);
    });
    forwardReq.on('error', (err) => {
      if (!proxyRes.headersSent) {
        proxyRes.writeHead(502, { 'Content-Type': 'application/json' });
        proxyRes.end(JSON.stringify({ error: `Upstream unavailable: ${err.message}` }));
      } else {
        proxyRes.destroy(err);
      }
    });
    proxyReq.pipe(forwardReq);
  });
  await new Promise((resolve, reject) => {
    proxyServer.once('error', reject);
    proxyServer.listen(0, '127.0.0.1', () => {
      proxyServer.off('error', reject);
      resolve();
    });
  });
  const proxyPort = proxyServer.address().port;
  const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;

  const stopProxy = () => {
    try { proxyServer.close(); } catch {}
  };

  const childEnv = { ...process.env, RAGENT_P2P_LOCAL_BASE_URL: proxyBaseUrl };
  if (normalizedIceServers.length) {
    childEnv.RAGENT_P2P_ICE_SERVERS_JSON = JSON.stringify(normalizedIceServers);
  } else {
    // Do not leak a stale or malformed host-level value into the sidecar.
    // TURN-first bootstrap may legitimately have no ICE list for a degraded
    // device; the Go child must treat that as empty configuration instead of
    // panicking while parsing an inherited invalid JSON string.
    delete childEnv.RAGENT_P2P_ICE_SERVERS_JSON;
  }
  if (relayOnly) {
    if (!normalizedIceServers.length) {
      throw new Error('relay-only P2P host requires broker-issued TURN ICE servers');
    }
    childEnv.RAGENT_P2P_RELAY_ONLY = '1';
  } else {
    // Do not permit a machine-wide variable to change a local/developer host.
    childEnv.RAGENT_P2P_RELAY_ONLY = '0';
  }
  if (browserAuth && typeof browserAuth === 'object') {
    childEnv.RAGENT_P2P_BROWSER_AUTH_REQUIRED = '1';
    childEnv.RAGENT_P2P_BROWSER_GRANT_PUBLIC_KEY_PEM = String(browserAuth.publicKeyPem || '');
    childEnv.RAGENT_P2P_BROWSER_GRANT_KEY_ID = String(browserAuth.keyId || '');
    childEnv.RAGENT_P2P_BROWSER_GRANT_ISSUER = String(browserAuth.issuer || '');
    childEnv.RAGENT_P2P_BROWSER_INSTANCE_ID = String(browserAuth.instanceId || '');
  }
  const childSpec = buildManagedProcessSpawnSpec({
    file: binaryPath,
    args: [],
    cwd: process.cwd(),
    env: childEnv,
  });
  let child;
  try {
    // POSIX keeps the existing detached process-group behavior. Windows uses
    // the same Job Object contract as managed processes, so the Go host and
    // any descendants close as one tree on stop or runtime failure.
    child = await spawnManagedProcess(childSpec, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (error) {
    stopProxy();
    throw error;
  }
  child.stdin?.on?.('error', () => {});
  let socket = null;
  let outgoingSeq = 0;
  let incomingSeq = 0;
  let mobileJoinId = 0;
  let blockedJoin = false;
  let requireHandoff = Boolean(handoffId);
  let buffer = '';
  let stopped = false;
  let signalingSuspended = false;
  let signalingJoined = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let keepaliveTimer = null;
  let resolveJoined;
  const joined = new Promise((resolve) => { resolveJoined = resolve; });

  const stopKeepalive = () => { if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; } };
  const startKeepalive = (ws) => { stopKeepalive(); keepaliveTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, KEEPALIVE_INTERVAL_MS); };

  // 意外断开（公网代理空闲超时/边缘抖动）后自动重连并重发 join，直到邀请过期；
  // sidecar 继续持有 peer 状态，重连只换 WS 通道。
  const scheduleReconnect = () => {
    if (stopped || signalingSuspended || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * (2 ** reconnectAttempts), RECONNECT_MAX_DELAY_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectSocket(); }, delay);
  };

  const connectSocket = () => {
    if (stopped || signalingSuspended) return null;
    const ws = new WebSocket(wsUrl(signalingUrl));
    socket = ws;
    ws.on('open', () => {
      if (socket !== ws || stopped) return;
      signalingJoined = false;
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'join', roomId, role: 'host' }));
      console.log(`[host-agent] ws open — join sent room=${roomId}`);
      startKeepalive(ws);
    });
    ws.on('message', (raw) => {
      if (socket !== ws) return;
      let message; try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (message.type === 'joined') {
        if (message.roomId === roomId && message.role === 'host') { signalingJoined = true; resolveJoined(); }
        console.log(`[host-agent] joined ok room=${message.roomId} role=${message.role}`); return;
      }
      if (message.type !== 'signal') { console.log(`[host-agent] other msg type=${message.type}`); return; }
      const verified = verifyP2PSignal(message.envelope, { roomId, secret });
      const e = message.envelope || {};
      const mac = String(e.mac || '');
      const p = e.payload;
      const canonObj = { v: 1, roomId: String(e.roomId || ''), seq: Number(e.seq || 0), timestamp: Number(e.timestamp || 0), payload: p || null };
      const canonStr = JSON.stringify(canonObj);
      const tryMac = (canon, enc = 'base64url') => { try { return createHmac('sha256', String(secret)).update(canon).digest(enc) === mac; } catch { return false; } };
      const variants = [];
      variants.push('std=' + tryMac(canonStr));
      if (p && typeof p === 'object') {
        variants.push('payloadAsStr=' + tryMac(JSON.stringify({ ...canonObj, payload: JSON.stringify(p) })));
        variants.push('payloadRevKeys=' + tryMac(JSON.stringify({ ...canonObj, payload: Object.fromEntries(Object.entries(p).reverse()) })));
      } else if (typeof p === 'string') {
        try {
          variants.push('payloadAsObj=' + tryMac(JSON.stringify({ ...canonObj, payload: JSON.parse(p) })));
        } catch {
          // A malformed signed payload is simply not a valid variant; the
          // verified flag below still decides whether it can be forwarded.
        }
      }
      variants.push('rawTypes=' + tryMac(JSON.stringify({ v: e.v, roomId: String(e.roomId || ''), seq: e.seq, timestamp: e.timestamp, payload: p || null })));
      variants.push('noRoom=' + tryMac(JSON.stringify({ v: 1, seq: Number(e.seq || 0), timestamp: Number(e.timestamp || 0), payload: p || null })));
      variants.push('rawV=' + tryMac(JSON.stringify({ v: e.v, roomId: String(e.roomId || ''), seq: Number(e.seq || 0), timestamp: Number(e.timestamp || 0), payload: p || null })));
      variants.push('std64=' + tryMac(canonStr, 'base64'));
      console.log(`[host-agent] signal recv verified=${verified} joinId=${message.joinId} mobileJoinId=${mobileJoinId} | v=${JSON.stringify(e.v)} roomMatch=${e.roomId === roomId} roomLen=${String(e.roomId || '').length} seq=${JSON.stringify(e.seq)} seqType=${typeof e.seq} ts=${JSON.stringify(e.timestamp)} tsType=${typeof e.timestamp} skewMs=${typeof e.timestamp === 'number' ? Math.round(Date.now() - e.timestamp) : 'n/a'} payloadType=${typeof p} payloadKeys=${p && typeof p === 'object' ? Object.keys(p).join(',') : 'n/a'} macLen=${mac.length} macChars=${/[+/=]/.test(mac) ? (mac.includes('-') || mac.includes('_') ? 'mixed' : 'std64') : 'urlsafe'} macHead=${mac.slice(0, 6)} | ${variants.join(' ')}`);
      if (!verified) return;
      if (message.joinId && message.joinId !== mobileJoinId) { mobileJoinId = message.joinId; incomingSeq = 0; blockedJoin = false; }
      if (message.envelope.seq <= incomingSeq) { console.log(`[host-agent] signal dropped seq=${message.envelope.seq} <= incomingSeq=${incomingSeq}`); return; }
      incomingSeq = message.envelope.seq;
      if (blockedJoin) return;
      if (p?.type === 'offer') {
        const offerHandoffId = typeof p.handoffId === 'string' ? p.handoffId : '';
        if ((offerHandoffId && offerHandoffId !== handoffId) || (!offerHandoffId && requireHandoff)) {
          blockedJoin = true;
          console.log('[host-agent] signal dropped reason=handoff-generation-mismatch');
          return;
        }
      }
      console.log(`[host-agent] signal forwarded to child seq=${message.envelope.seq} type=${message.envelope.payload?.type || 'unknown'}`);
      try {
        if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message.envelope.payload)}\n`);
      } catch {}
    });
    // 重连（新 WS）时重置入向序号：mobile 断线重连后会从低序号重新发
    // offer/signal，若沿用连接内的单调过滤，重发的消息会被永久丢弃
    // （seq <= 已消费值），mobile 只能干等到邀请过期——实测复现。
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = null;
      signalingJoined = false;
      stopKeepalive();
      incomingSeq = 0;
      blockedJoin = false;
      scheduleReconnect();
    });
    ws.on('error', () => {});
    return ws;
  };

  const firstSocket = connectSocket();
  const ready = new Promise((resolve, reject) => {
    firstSocket.once('open', resolve);
    firstSocket.once('error', reject);
    child.once('error', reject);
  });
  const done = new Promise((resolve) => {
    // Spawn failures are surfaced through `ready` to the caller that is
    // starting the host. Keep the lifecycle promise settled as a result too;
    // rejecting both promises leaves an unhandled rejection after the route
    // has already caught the startup failure and can terminate chat-server.
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.setEncoding('utf8');
  if (onSidecarLog) {
    child.stderr.setEncoding('utf8');
    let stderrBuffer = '';
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
      if (Buffer.byteLength(stderrBuffer, 'utf8') > MAX_SIDECAR_LINE_BYTES) {
        stderrBuffer = '';
        try { onSidecarLog('[host-agent] sidecar stderr line exceeded safety limit; dropped'); } catch {}
        return;
      }
      let index;
      while ((index = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, index);
        stderrBuffer = stderrBuffer.slice(index + 1);
        try { onSidecarLog(line); } catch {}
      }
    });
  } else {
    // The managed facade cannot inherit stderr on Windows. Drain it and keep
    // the previous inherited-stderr behavior for callers that did not ask for
    // structured sidecar logging.
    child.stderr.on('data', (chunk) => {
      try { process.stderr.write(chunk); } catch {}
    });
  }
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_SIDECAR_LINE_BYTES) {
      buffer = '';
      console.error('[host-agent] sidecar stdout line exceeded safety limit; dropped');
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let payload;
      try { payload = JSON.parse(line); } catch { continue; }
      // Keep useful ICE diagnostics without recording candidate addresses,
      // ports, SDP, or TURN credentials in the controller log.
      const signalType = typeof payload.type === 'string' ? payload.type : 'unknown';
      if (signalType === 'state') {
        const state = typeof payload.state === 'string' ? payload.state : 'unknown';
        console.log(`[host-agent] sidecar -> signaling type=state state=${state}`);
      } else if (signalType === 'candidate') {
        const candidate = typeof payload.candidate === 'string' ? payload.candidate : '';
        const candidateType = candidate.match(/\btyp\s+(host|srflx|prflx|relay)\b/i)?.[1]?.toLowerCase() || 'unknown';
        const transport = candidate.match(/\bcandidate:\S+\s+\d+\s+(udp|tcp)\b/i)?.[1]?.toLowerCase() || 'unknown';
        console.log(`[host-agent] sidecar -> signaling type=candidate candidate_type=${candidateType} transport=${transport}`);
      } else {
        console.log(`[host-agent] sidecar -> signaling type=${signalType}`);
      }
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'signal', roomId, envelope: signP2PSignal({ roomId, secret, seq: ++outgoingSeq, payload }) }));
        } catch {}
      }
    }
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopKeepalive();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    stopProxy();
    try { socket?.close(); } catch {}
    terminateManagedProcessTree(child, 'SIGTERM');
  };
  // Temporarily release the room's host signaling slot while keeping the
  // sidecar and any existing DataChannel alive during carrier handoff.
  const suspendSignaling = () => {
    if (stopped || signalingSuspended) return;
    signalingSuspended = true;
    signalingJoined = false;
    stopKeepalive();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const previous = socket;
    socket = null;
    try { previous?.close(1000, 'handoff'); } catch {}
  };
  const resumeSignaling = () => {
    if (stopped || !signalingSuspended) return;
    signalingSuspended = false;
    reconnectAttempts = 0;
    connectSocket();
  };
  // This fixed, authenticated signal asks a capable mobile peer to prepare a
  // new carrier. It contains no credentials and is ignored by older peers.
  const requestCarrierHandoff = (timeoutMs) => {
    if (stopped || signalingSuspended || !signalingJoined || socket?.readyState !== WebSocket.OPEN) return false;
    if (!handoffId || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 5_000 || timeoutMs > 20_000) return false;
    try {
      const payload = { type: 'carrier_handoff_requested', version: 1, timeoutMs, handoffId };
      socket.send(JSON.stringify({ type: 'signal', roomId,
        envelope: signP2PSignal({ roomId, secret, seq: ++outgoingSeq, payload }) }));
      return true;
    } catch { return false; }
  };
  // expiresAt is optional. When provided the host stops after the TTL;
  // when omitted the host runs until explicitly stopped (device host lifecycle).
  let expiryTimer = null;
  const expiryMs = Date.parse(expiresAt);
  if (Number.isFinite(expiryMs)) {
    const timeout = Math.max(1_000, expiryMs - Date.now());
    expiryTimer = setTimeout(stop, timeout);
    expiryTimer.unref();
  }
  child.once('exit', () => { stopped = true; stopKeepalive(); stopProxy(); if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; } if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } try { socket?.close(); } catch {} });
  const activateHandoff = () => { requireHandoff = false; };
  return { child, socket, ready, joined, done, stop, suspendSignaling, resumeSignaling, requestCarrierHandoff, activateHandoff, gatewayUrl: proxyBaseUrl,
    temporaryBusinessReady: temporaryIngressReady };
}
