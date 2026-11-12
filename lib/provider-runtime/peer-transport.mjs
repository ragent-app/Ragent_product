// Private provider-sync carrier: authenticated signaling and WebRTC data
// channels between two account-bound computers. Only the sync pull endpoint is
// exposed through this channel; no general control-plane route is proxied.
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { CHAT_PORT, P2P_SIGNALING_URL, TURN_BROKER_TIMEOUT_MS, TURN_BROKER_URL } from '../config.mjs';
import { buildManagedProcessSpawnSpec, spawnManagedProcess, terminateManagedProcessTree } from '../windows-managed-spawn.mjs';
import { resolveP2PHostBinary } from '../p2p-host-binary.mjs';
import { normalizeP2PHostIceServers } from '../p2p-host-agent.mjs';
import { signP2PSignal, verifyP2PSignal } from '../p2p-signal-protocol.mjs';
import { reserveOwnerAccountTurnConnection, releaseOwnerAccountTurnConnection } from '../owner-account-auth.mjs';
import { createTurnConnectionId } from '../turn-authorization.mjs';
import { createTurnLeaseId } from '../turn-lease-identity.mjs';
import { requestTurnCredentials } from '../turn-credential-broker-client.mjs';
import { deriveProviderPeerRoom } from './peer-room.mjs';

const sessions = new Map();
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
function signalUrl(value) { const url = new URL(value); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; if (url.pathname === '/') url.pathname = '/signal'; return url.toString(); }

async function acquireTurn({ accountId, identity, peer }) {
  const logical = createTurnConnectionId({ accountId, instanceId: identity.instanceId, deviceId: peer.instanceId });
  const connectionId = createTurnLeaseId(logical);
  const options = { deviceId: peer.instanceId, deviceKind: 'computer', connectionId };
  const reservation = await reserveOwnerAccountTurnConnection({ ...options,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
  if (!reservation?.authorization?.authorized || !reservation?.brokerCredential?.token) {
    if (reservation?.lease) await releaseOwnerAccountTurnConnection({ ...options, reason: 'provider-sync-no-capability' }).catch(() => {});
    throw new Error('Provider sync TURN reservation failed');
  }
  try {
    const credentials = await requestTurnCredentials({ brokerUrl: TURN_BROKER_URL, authMode: 'accounts-capability',
      capabilityToken: reservation.brokerCredential.token, accountId, instanceId: identity.instanceId,
      deviceId: peer.instanceId, connectionId, idempotencyKey: reservation.brokerCredential.idempotencyKey || connectionId,
      timeoutMs: TURN_BROKER_TIMEOUT_MS });
    return { iceServers: normalizeP2PHostIceServers(credentials.iceServers), expiresAt: credentials.expiresAt, options };
  } catch (error) {
    await releaseOwnerAccountTurnConnection({ ...options, reason: 'provider-sync-turn-failed' }).catch(() => {});
    throw error;
  }
}

async function createSession({ identity, peer, accountId }) {
  const room = deriveProviderPeerRoom({ identity, peer, accountId });
  const turn = await acquireTurn({ identity, peer, accountId });
  let child, socket, timer, connectTimer, heartbeat, retrySignals, alive = true, opened = false, joined = false, seq = 0, incomingSeq = 0, incomingJoin = 0;
  const outbound = [];
  const replaySignals = [];
  const seenSignals = new Set();
  const pending = new Map();
  let resolveOpen;
  const open = new Promise(resolve => { resolveOpen = resolve; });
  const close = () => {
    if (!alive) return;
    alive = false; opened = false;
    clearTimeout(timer); clearTimeout(connectTimer); clearInterval(heartbeat); clearInterval(retrySignals);
    try { socket?.close(); } catch {}
    if (child) { try { terminateManagedProcessTree(child); } catch {} }
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Provider peer disconnected')); }
    pending.clear(); resolveOpen(false);
    void releaseOwnerAccountTurnConnection({ ...turn.options, reason: 'provider-sync-closed' }).catch(() => {});
  };
  const send = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (!opened || bytes.length > MAX_MESSAGE_BYTES || !child?.stdin?.writable) throw new Error('Provider peer unavailable');
    child.stdin.write(`${JSON.stringify({ type: 'data', data: bytes.toString('base64') })}\n`);
  };
  const sendSignal = (payload) => {
    const envelope = signP2PSignal({ roomId: room.roomId, secret: room.secret, seq: ++seq, payload });
    socket.send(JSON.stringify({ type: 'signal', roomId: room.roomId, envelope }));
  };
  const handleData = async (encoded) => {
    const bytes = Buffer.from(encoded || '', 'base64');
    if (!bytes.length || bytes.length > MAX_MESSAGE_BYTES) return close();
    let frame; try { frame = JSON.parse(bytes.toString('utf8')); } catch { return close(); }
    if (!/^[a-f0-9]{32}$/.test(frame?.id || '')) return close();
    if (frame.type === 'response') {
      const waiter = pending.get(frame.id); if (!waiter) return;
      pending.delete(frame.id); clearTimeout(waiter.timer);
      if (!Number.isInteger(frame.status) || frame.status < 100 || frame.status > 599 || typeof frame.body !== 'string') return waiter.reject(new Error('Invalid provider peer response'));
      waiter.resolve(new Response(frame.body, { status: frame.status, headers: { 'Content-Type': 'application/json' } }));
      return;
    }
    if (frame.type !== 'pull' || typeof frame.body !== 'string' || Buffer.byteLength(frame.body) > MAX_MESSAGE_BYTES) return close();
    try {
      const response = await fetch(`http://127.0.0.1:${CHAT_PORT}/api/provider-sync/pull`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: frame.body,
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES - 1024) throw new Error('Provider peer response too large');
      send({ type: 'response', id: frame.id, status: response.status, body });
    } catch { try { send({ type: 'response', id: frame.id, status: 503, body: '{"error":"sync unavailable"}' }); } catch {} }
  };
  try {
    const spec = buildManagedProcessSpawnSpec({ file: resolveP2PHostBinary(), args: [], cwd: process.cwd(),
      env: { ...process.env, RAGENT_P2P_PROVIDER_SYNC: '1', RAGENT_P2P_PROVIDER_ROLE: room.role,
        AGENTOC_P2P_ICE_SERVERS_JSON: JSON.stringify(turn.iceServers) } });
    child = await spawnManagedProcess(spec, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdin.on('error', close); child.on('error', close); child.on('exit', close);
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES * 2) return close();
      let value; try { value = JSON.parse(line); } catch { return close(); }
      if (value.type === 'open') { opened = true; clearTimeout(connectTimer); resolveOpen(true); return; }
      if (value.type === 'closed') return close();
      if (value.type === 'data') { void handleData(value.data); return; }
      if (!['offer', 'answer', 'candidate'].includes(value.type)) return;
      if (room.role === 'mobile' && (value.type === 'offer' || value.type === 'candidate')) {
        if (replaySignals.length >= 128) return close();
        replaySignals.push(value);
      }
      if (!joined) { if (outbound.length >= 128) return close(); outbound.push(value); return; }
      sendSignal(value);
    });
    socket = new WebSocket(signalUrl(P2P_SIGNALING_URL));
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'join', roomId: room.roomId, role: room.role }));
      heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 20_000);
      heartbeat.unref?.();
    });
    socket.on('message', raw => {
      let message; try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (message.type === 'joined' && message.roomId === room.roomId && message.role === room.role) {
        joined = true;
        for (const payload of outbound.splice(0)) sendSignal(payload);
        if (room.role === 'mobile') {
          retrySignals = setInterval(() => { if (joined && !opened) for (const payload of replaySignals) sendSignal(payload); }, 3_000);
          retrySignals.unref?.();
        }
        return;
      }
      if (message.type !== 'signal' || !verifyP2PSignal(message.envelope, { roomId: room.roomId, secret: room.secret })) return;
      if (message.joinId && message.joinId !== incomingJoin) {
        // A rejoined peer has a new WebRTC negotiation. The old sidecar has
        // already consumed a remote description and cannot accept a second
        // offer/answer; rebuild the session on the next convergence attempt.
        if (incomingJoin) return close();
        incomingJoin = message.joinId; incomingSeq = 0; seenSignals.clear();
      }
      if (message.envelope.seq <= incomingSeq) return;
      incomingSeq = message.envelope.seq;
      const payload = message.envelope.payload;
      if (!['offer', 'answer', 'candidate'].includes(payload?.type)) return;
      const fingerprint = JSON.stringify(payload);
      if (seenSignals.has(fingerprint)) return;
      if (seenSignals.size >= 256) return close();
      seenSignals.add(fingerprint);
      if (payload.type === 'answer') { clearInterval(retrySignals); replaySignals.length = 0; }
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('error', close); socket.on('close', close);
    // Keep both ends available long enough for a peer that was sleeping or
    // restarting to join and complete ICE negotiation on a later retry.
    connectTimer = setTimeout(close, 120_000);
    connectTimer.unref?.();
    // A disconnected or expired TURN allocation is rebuilt by the next cycle.
    timer = setTimeout(close, Math.max(1000, Date.parse(turn.expiresAt) - Date.now() - 60_000));
    timer.unref?.();
  } catch (error) { close(); throw error; }
  return { open, close, isAlive: () => alive, request: async (body) => {
    if (!opened) throw new Error('Provider peer is not connected');
    const id = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { pending.delete(id); reject(new Error('Provider peer request timed out')); }, 30_000);
      pending.set(id, { resolve, reject, timer: deadline });
      try { send({ type: 'pull', id, body }); } catch (error) { clearTimeout(deadline); pending.delete(id); reject(error); }
    });
  } };
}

export async function ensureProviderPeerSession({ identity, peer, accountId }) {
  if (!P2P_SIGNALING_URL || !TURN_BROKER_URL) throw new Error('Provider peer signaling or TURN is unavailable');
  const key = `${accountId}:${identity.instanceId}:${peer.instanceId}:${peer.instanceKeyFingerprint}`;
  let entry = sessions.get(key);
  if (entry) {
    const session = await entry;
    if (session.isAlive()) return session;
    sessions.delete(key);
  }
  entry = createSession({ identity, peer, accountId });
  sessions.set(key, entry);
  try { return await entry; } catch (error) { if (sessions.get(key) === entry) sessions.delete(key); throw error; }
}

export function reconcileProviderPeerSessions({ identity, peers, accountId }) {
  const prefix = `${accountId}:${identity.instanceId}:`;
  const allowed = new Set(peers.map(peer => `${prefix}${peer.instanceId}:${peer.instanceKeyFingerprint}`));
  for (const [key, entry] of sessions) {
    if (key.startsWith(prefix) && allowed.has(key)) continue;
    sessions.delete(key);
    void entry.then(session => session.close()).catch(() => {});
  }
}

export function stopProviderPeerSessions() {
  for (const entry of sessions.values()) void entry.then(session => session.close()).catch(() => {});
  sessions.clear();
}
