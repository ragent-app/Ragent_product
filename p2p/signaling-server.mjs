import http from 'http';
import { WebSocketServer } from 'ws';

const MAX_MESSAGE_BYTES = 256 * 1024;
const ROOM_TTL_MS = 15 * 60_000;

function validRoom(value) { return /^[a-f0-9]{40}$/.test(String(value || '')); }
function validRole(value) { return value === 'host' || value === 'mobile' || value === 'browser'; }

// 可 attach 到任意 HTTP server 的信令核心（chat-server 主进程内嵌模式：公网经
// Caddy catch-all 把 /signal upgrade 转发到 7690，由主服务同一端口提供信令，
// 无需独立端口/unit/Caddy 路由）。独立模式（ragent signal）仍走
// createP2PSignalingServer 包装。
export function createP2PSignaling({ authorizeJoin = null, onEvent = null } = {}) {
  const rooms = new Map();
  // 尚未 join 就到达的合法 signal（移动端 App 会在收到 joined 前先发 offer）：
  // roomId -> [{ envelope, at }]。join 到位后按序转给对端，避免直接 1008 关闭
  // 把先发信令的客户端（旧 App）永久挡在门外。
  const pendingSignals = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  wss.on('connection', (ws) => {
    let membership = null;
    let joining = false;
    // A joined peer's WebSocket heartbeat is real room activity. Check that
    // it is still the registered peer so a replaced socket cannot keep a
    // room alive while its close handshake is pending.
    ws.on('ping', () => {
      if (!membership) return;
      const room = rooms.get(membership.roomId);
      if (room?.peers.get(membership.role) === ws) room.touchedAt = Date.now();
    });
    ws.on('message', async (raw) => {
      let message; try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!membership) {
        if (joining) return;
        if (message.type === 'join' && validRoom(message.roomId) && validRole(message.role)) {
          joining = true;
          if (message.role === 'browser' && typeof authorizeJoin === 'function') {
            let authorized = false;
            try {
              authorized = await authorizeJoin({
                token: message.joinToken,
                roomId: message.roomId,
                role: message.role,
                instanceId: message.instanceId,
                clientId: message.clientId,
                connectionId: message.connectionId,
              });
            } catch {
              authorized = false;
            }
            if (!authorized) {
              onEvent?.({ event: 'signal_join_rejected', roomId: message.roomId, clientId: message.clientId || '', connectionId: message.connectionId || '' });
              ws.close(1008, 'unauthorized browser join');
              return;
            }
          } else if (message.role === 'browser') {
            onEvent?.({ event: 'signal_join_rejected', roomId: message.roomId, clientId: message.clientId || '', connectionId: message.connectionId || '' });
            ws.close(1008, 'browser join authorization required');
            return;
          }
          const room = rooms.get(message.roomId) || { peers: new Map(), touchedAt: Date.now(), joinCounter: 0 };
          const previous = room.peers.get(message.role); if (previous && previous !== ws) previous.close(1012, 'replaced');
          room.peers.set(message.role, ws); room.touchedAt = Date.now(); rooms.set(message.roomId, room);
          // joinId：本房间内该角色的第几次 join（自增）。信令按需转发时带上发送方的
          // joinId，接收方（host agent）据此识别"对方重连了新会话"——重连后消息序号
          // 应从低值重新接受，否则重发的 offer 会被 seq 过滤永久丢弃。
          membership = {
            roomId: message.roomId,
            role: message.role,
            joinId: ++room.joinCounter,
            instanceId: message.instanceId || '',
            clientId: message.clientId || '',
            connectionId: message.connectionId || '',
          };
          if (membership.role === 'browser') {
            onEvent?.({ event: 'signal_join_authorized', roomId: membership.roomId, clientId: membership.clientId, connectionId: membership.connectionId });
          }
          ws.send(JSON.stringify({ type: 'joined', roomId: message.roomId, role: message.role }));
          // 冲掉本客户端 join 前缓冲的信令（from/joinId 都取 join 后的真实身份）。
          const buffered = pendingSignals.get(message.roomId);
          if (buffered && buffered.length) {
            const target = room.peers.get(membership.role === 'host'
              ? (room.peers.has('browser') ? 'browser' : 'mobile')
              : 'host');
            if (target?.readyState === 1) {
              for (const item of buffered) {
                target.send(JSON.stringify({ type: 'signal', roomId: message.roomId, from: membership.role, joinId: membership.joinId, envelope: item.envelope }));
              }
            }
            pendingSignals.delete(message.roomId);
          }
          return;
        }
        // 旧移动端 App 会在收到 joined 前就发送 offer：合法 signal 先缓冲，等 join。
        if (message.type === 'signal' && validRoom(message.roomId) && message.envelope && typeof message.envelope === 'object') {
          const list = pendingSignals.get(message.roomId) || [];
          list.push({ envelope: message.envelope, at: Date.now() });
          pendingSignals.set(message.roomId, list);
          return;
        }
        ws.close(1008, 'invalid join');
        return;
      }
      if (message.type !== 'signal' || message.roomId !== membership.roomId || !message.envelope) return;
      const room = rooms.get(membership.roomId); if (!room) return;
      room.touchedAt = Date.now();
      const target = room.peers.get(membership.role === 'host'
        ? (room.peers.has('browser') ? 'browser' : 'mobile')
        : 'host');
      // ws.OPEN === 1；target 可能尚未加入或已离开（对方先发 signal 或中途断开），
      // 用数值常量避免对 undefined 求值 target.OPEN 抛 TypeError 崩掉整个服务。
      if (target?.readyState === 1) target.send(JSON.stringify({ type: 'signal', roomId: membership.roomId, from: membership.role, joinId: membership.joinId, envelope: message.envelope }));
    });
    ws.on('close', () => {
      if (!membership) return; const room = rooms.get(membership.roomId); if (!room) return;
      if (room.peers.get(membership.role) === ws) room.peers.delete(membership.role);
      if (!room.peers.size) rooms.delete(membership.roomId);
    });
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) if (now - room.touchedAt > ROOM_TTL_MS) { for (const peer of room.peers.values()) peer.close(1001, 'expired'); rooms.delete(id); }
    for (const [id, list] of pendingSignals) if (now - (list.at(-1)?.at || 0) > ROOM_TTL_MS) pendingSignals.delete(id);
  }, 60_000); sweep.unref();
  return {
    // 只接受路径精确为 /signal 的 upgrade，其余 socket 直接销毁。
    handleUpgrade(req, socket, head) {
      if (new URL(req.url || '/', 'http://localhost').pathname !== '/signal') { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    },
    close() {
      clearInterval(sweep);
      for (const client of wss.clients) client.close();
    },
  };
}

export function createP2PSignalingServer({ host = '127.0.0.1', port = 7791, authorizeJoin = null, onEvent = null } = {}) {
  const signaling = createP2PSignaling({ authorizeJoin, onEvent });
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket, head) => { signaling.handleUpgrade(req, socket, head); });
  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); }),
    close: () => new Promise((resolve) => { signaling.close(); server.close(resolve); }),
    server,
  };
}
