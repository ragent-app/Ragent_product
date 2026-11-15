// canonical 字符串序列化需对齐 Android org.json 的正斜杠转义怪癖（`/`→`\/`）：
// App（移动端）签名用转义形态，Node 默认不转义。sign 用转义形态（对齐服务端
// signP2PSignal 与 App），verify 双形态都接受（兼容旧 plain 客户端）。
function canonical(envelope, slashEscape = false) { const base = JSON.stringify({ v: 1, roomId: envelope.roomId, seq: envelope.seq, timestamp: envelope.timestamp, payload: envelope.payload || null }); return slashEscape ? base.replace(/\//g, '\\/') : base; }
function bytesToBase64Url(bytes) { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function base64UrlToBytes(value) { const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/'); const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4); const text = atob(padded); return Uint8Array.from(text, (char) => char.charCodeAt(0)); }
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function bootstrapSigningPayload(contract) {
  const { signature, ...payload } = contract || {};
  const digestInput = new TextEncoder().encode(canonicalJson(payload));
  return crypto.subtle.digest('SHA-256', digestInput).then((digest) => {
    const digestHex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return ['ragent-connection-bootstrap-v2', String(contract.instanceId || '').trim(), String(contract.deviceId || '').trim(), String(contract.connectionMode || '').trim(), String(contract.issuedAt || '').trim(), String(contract.expiresAt || '').trim(), digestHex].join('\n');
  });
}
function pemToDer(pem) { const encoded = String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''); const text = atob(encoded); return Uint8Array.from(text, (char) => char.charCodeAt(0)); }
function toBrowserIceServers(servers) {
  return servers.map((server) => ({
    ...server,
    ...(server.credential || server.password ? { credential: server.credential || server.password } : {}),
  }));
}
async function verifyConnectionBootstrapV2(contract, publicKey, { nowMs = Date.now(), expectedInstanceId = '', expectedDeviceId = '' } = {}) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new Error('bootstrap contract is not an object');
  if (contract.contractVersion !== 2) throw new Error('unsupported bootstrap contract version');
  if (!String(contract.instanceId || '').trim() || !String(contract.deviceId || '').trim()) throw new Error('bootstrap identity is missing');
  if (expectedInstanceId && contract.instanceId !== expectedInstanceId) throw new Error('bootstrap instance binding mismatch');
  if (expectedDeviceId && contract.deviceId !== expectedDeviceId) throw new Error('bootstrap device binding mismatch');
  if (contract.connectionMode !== 'turn-first') throw new Error('bootstrap connection mode is not turn-first');
  if (!['account-claim', 'account-join'].includes(contract.enrollmentKind)) throw new Error('bootstrap enrollment kind is invalid');
  if (!Array.isArray(contract.candidates) || !contract.candidates.length || contract.candidates.some((entry) => !['turn', 'webrtc'].includes(entry?.kind))) throw new Error('bootstrap candidates are invalid');
  if (!Number.isFinite(Date.parse(contract.expiresAt)) || Date.parse(contract.expiresAt) <= nowMs) throw new Error('bootstrap contract is expired');
  const turns = contract.candidates.filter((entry) => entry?.kind === 'turn');
  if (turns.length !== 1 || contract.initialCarrier?.kind !== 'turn' || contract.initialCarrier?.candidateId !== turns[0].id || contract.fallback !== null) throw new Error('turn-first bootstrap carrier is invalid');
  if (!contract.turn || !Array.isArray(contract.turn.iceServers) || !contract.turn.iceServers.length
    || contract.turn.iceServers.some((server) => {
      const urls = String(server?.urls || '').trim();
      const requiresCredential = /^turns?:/i.test(urls);
      return !urls || (requiresCredential && (!server?.username || !(server.credential || server.password)));
    })) throw new Error('bootstrap TURN configuration is invalid');
  if (contract.signature?.algorithm !== 'ed25519' || !contract.signature.keyId || !contract.signature.value) throw new Error('bootstrap signature is incomplete');
  const publicKeyPem = typeof publicKey === 'string' ? publicKey : publicKey?.publicKeyPem;
  const publicKeyId = typeof publicKey === 'string' ? '' : String(publicKey?.keyId || '').trim();
  if (!publicKeyPem || (publicKeyId && publicKeyId !== contract.signature.keyId)) throw new Error('bootstrap public key metadata mismatch');
  const key = await crypto.subtle.importKey('spki', pemToDer(publicKeyPem), { name: 'Ed25519' }, false, ['verify']);
  const payload = await bootstrapSigningPayload(contract);
  const verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, base64UrlToBytes(contract.signature.value), new TextEncoder().encode(payload));
  if (!verified) throw new Error('bootstrap signature mismatch');
  return { contract, keyId: contract.signature.keyId };
}
function logEvent(event, fields = {}) { try { console.info(`[ragent-browser] event=${event}`, fields); } catch {} }
async function mac(secret, envelope, slashEscape) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical(envelope, slashEscape))))); }
async function sign(secret, envelope) { return mac(secret, envelope, true); }
async function verify(secret, envelope) { if (Math.abs(Date.now() - envelope.timestamp) >= 600000) return false; const [slash, plain] = await Promise.all([mac(secret, envelope, true), mac(secret, envelope, false)]); return envelope.mac === slash || envelope.mac === plain; }
function toWs(value) { const url = new URL(value); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; if (url.pathname === '/') url.pathname = '/signal'; return url.toString(); }
function encodeBody(value) { const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value || []); let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); }
function decodeBody(value) { const text = atob(value || ''); return Uint8Array.from(text, (char) => char.charCodeAt(0)); }
async function readMessageData(value) { if (typeof value === 'string') return value; if (value instanceof Blob) return value.text(); if (value instanceof ArrayBuffer) return new TextDecoder().decode(value); if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value); throw new Error('Unsupported DataChannel message'); }

// A response can span several ordered DataChannel messages. Bound allocation
// across concurrent responses and verify the complete payload before using it.
class P2PResponseStreamAssembler {
  constructor() { this.transfers = new Map(); this.reserved = 0; }
  discard(id) { const transfer = this.transfers.get(id); if (transfer) this.reserved -= transfer.total; this.transfers.delete(id); }
  clear() { this.transfers.clear(); this.reserved = 0; }
  async add(frame) {
    const id = frame?.id;
    try {
      if (frame?.type !== 'http_response_stream_v1' || !/^[A-Za-z0-9_-]{1,128}$/.test(id || '') ||
          !Number.isSafeInteger(frame.index) || frame.index < 0 || !Number.isSafeInteger(frame.totalBytes) ||
          frame.totalBytes < 1 || frame.totalBytes > 12 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(frame.sha256 || '') ||
          typeof frame.dataBase64 !== 'string' || frame.dataBase64.length > 32768) throw new Error('Invalid response stream');
      const bytes = decodeBody(frame.dataBase64);
      let transfer = this.transfers.get(id);
      if (!transfer) {
        if (frame.index !== 0 || this.reserved + frame.totalBytes > 24 * 1024 * 1024) throw new Error('Invalid response stream');
        transfer = { total: frame.totalBytes, digest: frame.sha256, index: 0, offset: 0, bytes: new Uint8Array(frame.totalBytes) };
        this.transfers.set(id, transfer); this.reserved += frame.totalBytes;
      }
      const remaining = transfer.total - transfer.offset;
      if (transfer.total !== frame.totalBytes || transfer.digest !== frame.sha256 || transfer.index !== frame.index ||
          remaining <= 0 || bytes.length !== Math.min(24 * 1024, remaining)) throw new Error('Invalid response stream');
      transfer.bytes.set(bytes, transfer.offset); transfer.offset += bytes.length; transfer.index += 1;
      if (transfer.offset !== transfer.total) return null;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', transfer.bytes));
      const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== transfer.digest) throw new Error('Invalid response stream');
      const response = JSON.parse(new TextDecoder().decode(transfer.bytes));
      if (response?.type !== 'http_response' || response.id !== id) throw new Error('Invalid response stream');
      this.discard(id);
      return response;
    } catch (error) { this.discard(id); throw error; }
  }
}
function withTimeout(promise, timeoutMs, message) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]).finally(() => clearTimeout(timer)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function browserAuthChallenge({ connectionId, instanceId, grantJti, serverNonce }) { return ['ragent-browser-auth-v1', connectionId, instanceId, grantJti, serverNonce].join('\n'); }

export class RagentP2PClient {
  constructor({ signalingUrl, roomId, secret, iceServers = [{ urls: 'stun:stun.l.google.com:19302' }], connectTimeoutMs = 15000, requestTimeoutMs = 60000, turnOnly = false, browserAuth = null, autoAuthenticate = true }) { this.signalingUrl = signalingUrl; this.roomId = roomId; this.secret = secret; this.iceServers = toBrowserIceServers(iceServers); this.connectTimeoutMs = connectTimeoutMs; this.requestTimeoutMs = requestTimeoutMs; this.turnOnly = turnOnly; this.browserAuth = browserAuth; this.autoAuthenticate = autoAuthenticate; this.seq = 0; this.incomingSeq = 0; this.pending = new Map(); this.responseStreams = new P2PResponseStreamAssembler(); this.messageQueue = Promise.resolve(); this.authenticated = !browserAuth; this.authState = browserAuth ? 'AUTHENTICATING' : 'DISABLED'; }
  async connect() {
    const authReady = this.browserAuth ? new Promise((resolve, reject) => { this.authResolve = resolve; this.authReject = reject; }) : Promise.resolve();
    this.peer = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: this.turnOnly ? 'relay' : 'all' });
    this.channel = this.peer.createDataChannel('ragent-http', { ordered: true });
    this.channel.binaryType = 'arraybuffer';
    this.channel.onmessage = (event) => { this.messageQueue = this.messageQueue.then(async () => {
      let response; try { response = JSON.parse(await readMessageData(event.data)); } catch { return; }
      if (response.type === 'server_ready' && this.browserAuth && this.autoAuthenticate) {
        logEvent('datachannel_open');
        this.channel.send(JSON.stringify({ type: 'client_auth_init_v1', version: 1, connectionGrant: this.browserAuth.grant }));
        return;
      }
      if (response.type === 'server_challenge' && this.browserAuth && this.autoAuthenticate) {
        logEvent('auth_challenge_sent');
        const transcript = browserAuthChallenge(response);
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.browserAuth.privateKey, new TextEncoder().encode(transcript));
        this.channel.send(JSON.stringify({ type: 'client_auth_v1', version: 1, connectionGrant: this.browserAuth.grant, proof: { algorithm: 'ES256', signature: bytesToBase64Url(new Uint8Array(signature)) } }));
        return;
      }
      if (response.type === 'auth_ok' && this.browserAuth) { this.authenticated = true; this.authState = 'AUTHENTICATED'; logEvent('browser_authenticated'); this.authResolve?.(response); return; }
      if (response.type === 'auth_rejected' && this.browserAuth) { this.authState = 'CLOSED'; logEvent(String(response.reason || '').includes('replay') ? 'replay_rejected' : 'auth_rejected'); this.authReject?.(new Error(response.reason || 'browser authentication rejected')); this.channel.close(); return; }
      if (response.type === 'http_response_stream_v1') {
        const pending = this.pending.get(response.id); if (!pending) return;
        try { response = await this.responseStreams.add(response); if (!response) return; }
        catch { this.responseStreams.discard(response.id); this.pending.delete(response.id); clearTimeout(pending.timer); pending.reject(new Error('Invalid response stream')); return; }
      }
      const pending = this.pending.get(response.id); if (!pending) { this.responseStreams.discard(response.id); return; } this.responseStreams.discard(response.id); this.pending.delete(response.id); clearTimeout(pending.timer); logEvent('remote_response', { id: response.id, status: response.status }); response.error ? pending.reject(new Error(response.error)) : pending.resolve(response);
    }).catch(() => {}); };
    const opened = new Promise((resolve, reject) => { this.channel.onopen = resolve; this.channel.onerror = () => reject(new Error('DataChannel failed')); });
    this.socket = new WebSocket(toWs(this.signalingUrl));
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    const joined = new Promise((resolve, reject) => { this.joinResolve = resolve; this.joinReject = reject; });
    // join 等待期被服务端关闭（如 1008 unauthorized）时立即带原因失败，
    // 不要拖到 join 超时才报一个含糊的 "signaling join timed out"。
    this.socket.onclose = (event) => { this.joinReject?.(new Error(`signaling closed (${event.code})${event.reason ? `: ${event.reason}` : ''}`)); };
    this.socket.onmessage = async (event) => { const message = JSON.parse(event.data); if (message.type === 'joined') { logEvent(this.browserAuth ? 'signal_join_authorized' : 'signal_joined'); this.joinResolve?.(message); return; } if (message.type !== 'signal' || !(await verify(this.secret, message.envelope)) || message.envelope.seq <= this.incomingSeq) return; this.incomingSeq = message.envelope.seq; const payload = message.envelope.payload; if (payload.type === 'answer') await this.peer.setRemoteDescription({ type: 'answer', sdp: payload.sdp }); else if (payload.type === 'candidate') await this.peer.addIceCandidate(payload); };
    const join = { type: 'join', roomId: this.roomId, role: this.browserAuth ? 'browser' : 'mobile' };
    if (this.browserAuth) Object.assign(join, { joinToken: this.browserAuth.joinToken, instanceId: this.browserAuth.instanceId, clientId: this.browserAuth.clientId, connectionId: this.browserAuth.connectionId });
    this.socket.send(JSON.stringify(join));
    await withTimeout(joined, this.connectTimeoutMs, 'signaling join timed out');
    this.peer.onicecandidate = (event) => { if (event.candidate) this.sendSignal({ type: 'candidate', candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex }); };
    // ICE/连接状态可观测性：relay-only 跨境场景排障需要状态迁移时间线。
    this.peer.oniceconnectionstatechange = () => logEvent('ice_state', { state: this.peer.iceConnectionState });
    this.peer.onconnectionstatechange = () => logEvent('peer_state', { state: this.peer.connectionState });
    if (this.browserAuth) logEvent('turn_connecting', { policy: this.turnOnly ? 'relay' : 'direct-test' });
    const offer = await this.peer.createOffer(); await this.peer.setLocalDescription(offer); await this.sendSignal({ type: 'offer', sdp: offer.sdp });
    await withTimeout(opened, this.connectTimeoutMs, 'P2P DataChannel connection timed out');
    if (this.browserAuth && this.autoAuthenticate) await withTimeout(authReady, this.connectTimeoutMs, 'browser authentication timed out');
    if (this.turnOnly) {
      this.turnEvidence = await this.waitForRelayEvidence();
      if (!this.turnEvidence.ok) throw new Error(`TURN relay was not selected: ${this.turnEvidence.reason}`);
      logEvent('turn_connected', this.turnEvidence);
    }
    return this;
  }
  async sendSignal(payload) { const envelope = { v: 1, roomId: this.roomId, seq: ++this.seq, timestamp: Date.now(), payload }; envelope.mac = await sign(this.secret, envelope); this.socket.send(JSON.stringify({ type: 'signal', roomId: this.roomId, envelope })); }
  request({ method = 'GET', path = '/', headers = {}, body = '', requestId = null, idempotencyKey = null }) {
    if (this.channel?.readyState !== 'open' || !this.authenticated) return Promise.reject(new Error('P2P DataChannel is not authenticated'));
    const id = crypto.randomUUID();
    const requestHeaders = { ...headers };
    if (requestId) requestHeaders['X-Ragent-Request-Id'] = requestId;
    if (idempotencyKey) requestHeaders['Idempotency-Key'] = idempotencyKey;
    logEvent('remote_request', { id, method, path });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.responseStreams.discard(id); reject(new Error('P2P request timed out')); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.channel.send(JSON.stringify({ id, type: 'http_request', method, path, headers: requestHeaders, bodyBase64: encodeBody(body), acceptResponseStream: true })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
    return promise.then((response) => { const bodyBytes = decodeBody(response.bodyBase64); return { ...response, bodyBytes, text: new TextDecoder().decode(bodyBytes) }; });
  }
  async getRelayEvidence() {
    const stats = await this.peer.getStats();
    const selectedPairIds = new Set([...stats.values()]
      .filter((report) => report.type === 'transport' && report.selectedCandidatePairId)
      .map((report) => report.selectedCandidatePairId));
    let pair;
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair'
        && report.state === 'succeeded'
        && (report.selected === true || report.nominated === true || selectedPairIds.has(report.id))) {
        pair = report;
        break;
      }
    }
    const local = pair ? stats.get(pair.localCandidateId) : null;
    const remote = pair ? stats.get(pair.remoteCandidateId) : null;
    const evidence = {
      ok: Boolean(pair && local?.candidateType === 'relay'),
      pairId: pair?.id || '',
      pairState: pair?.state || '',
      localCandidateType: local?.candidateType || '',
      remoteCandidateType: remote?.candidateType || '',
      protocol: pair?.protocol || '',
      relayProtocol: local?.relayProtocol || '',
    };
    if (!evidence.ok) evidence.reason = pair
      ? `candidate type ${evidence.localCandidateType || 'unknown'}`
      : 'selected candidate pair unavailable';
    return evidence;
  }
  async waitForRelayEvidence(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let evidence;
    do {
      evidence = await this.getRelayEvidence();
      if (evidence.ok || Date.now() >= deadline) return evidence;
      await sleep(100);
    } while (true);
  }
  close() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('P2P client closed')); } this.pending.clear(); this.responseStreams.clear(); this.channel?.close(); this.peer?.close(); this.socket?.close(); }
}

export { verifyConnectionBootstrapV2, P2PResponseStreamAssembler };
