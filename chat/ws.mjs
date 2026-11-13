import { isProotRuntime, authenticateProotRequest } from '../lib/proot-local-pairing.mjs';
import { WebSocketServer } from 'ws';
import { createP2PSignaling } from '../p2p/signaling-server.mjs';
import { isAuthenticated, getAuthSession, authenticateBearerToken, authenticateAccountCookie } from '../lib/auth.mjs';
import { setWss } from './ws-clients.mjs';
import { getPageBuildInfo } from './router.mjs';
import { closeWebSocketServer } from './ws-shutdown.mjs';
import { createReplayStore, verifySignalJoinToken } from '../lib/browser-connection-grant.mjs';
import { loadInstanceIdentity } from '../lib/instance-identity.mjs';

export { closeWebSocketServer };

function sendJson(ws, payload) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

async function sendBuildInfo(ws) {
  try {
    const buildInfo = await getPageBuildInfo();
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'build_info', buildInfo }));
  } catch (error) {
    console.warn(`[build] failed to send websocket build info: ${error.message}`);
  }
}

function envBrowserSignalAuthorizer() {
  const issuer = String(process.env.AGENTOC_BROWSER_SIGNAL_ISSUER || process.env.AGENTOC_ACCOUNTS_ISSUER || '').trim();
  let rawKeys = null;
  try {
    rawKeys = JSON.parse(process.env.AGENTOC_BROWSER_SIGNAL_TRUSTED_KEYS_JSON || 'null');
  } catch {
    rawKeys = null;
  }
  if (!issuer || !rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) return null;
  const trustedKeys = new Map(Object.entries(rawKeys).filter(([kid, key]) => kid && key));
  if (!trustedKeys.size) return null;
  const replayStore = createReplayStore();
  return ({ token, roomId, instanceId, clientId, connectionId }) => verifySignalJoinToken(token, {
    trustedKeys,
    replayStore,
    expectedIssuer: issuer,
    expectedRoomId: roomId,
    expectedInstanceId: instanceId,
    expectedClientId: clientId,
    expectedConnectionId: connectionId,
  }).valid;
}

// 单机部署回退：sjt 由本机实例身份私钥签发（issuer=instance:<id>，kid=身份指纹），
// 信令端与签发端同属一个信任根，只读加载本地身份公钥即可验证，无需在 env 里搬运
// 公钥。云端 broker 拓扑没有这层同进程信任关系，仍用 env 配置外部权威键集。
// 只读加载（不创建）：身份文件缺失时禁用 browser join，保持拒绝语义。
function localInstanceBrowserSignalAuthorizer() {
  let cached = null;
  return async ({ token, roomId, instanceId, clientId, connectionId }) => {
    if (!cached) {
      cached = loadInstanceIdentity().then((identity) => identity ? {
        issuer: String(process.env.AGENTOC_BROWSER_SIGNAL_ISSUER || `instance:${identity.instanceId}`).trim(),
        trustedKeys: new Map([[identity.keyFingerprint, identity.publicKey]]),
        replayStore: createReplayStore(),
      } : { unavailable: true }).catch(() => ({ unavailable: true }));
    }
    const config = await cached;
    if (config.unavailable) return false;
    return verifySignalJoinToken(token, {
      trustedKeys: config.trustedKeys,
      replayStore: config.replayStore,
      expectedIssuer: config.issuer,
      expectedRoomId: roomId,
      expectedInstanceId: instanceId,
      expectedClientId: clientId,
      expectedConnectionId: connectionId,
    }).valid;
  };
}

function configuredBrowserSignalAuthorizer() {
  try {
    if (JSON.parse(process.env.AGENTOC_BROWSER_SIGNAL_TRUSTED_KEYS_JSON || 'null')) {
      return envBrowserSignalAuthorizer();
    }
  } catch {
    // 显式配置了非法 JSON：保持禁用语义，不回退。
    return null;
  }
  return localInstanceBrowserSignalAuthorizer();
}

export function attachWebSocket(server, { authorizeP2PJoin = configuredBrowserSignalAuthorizer(), onP2PEvent = null } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  setWss(wss);
  // 元数据信令：与主服务同端口提供 /signal（Caddy catch-all 已把公网 /signal
  // upgrade 转发到 7690），只转发 HMAC 签名 envelope，不承载数据。
  const p2pSignaling = createP2PSignaling({ authorizeJoin: authorizeP2PJoin, onEvent: onP2PEvent });
  wss.once('close', () => p2pSignaling.close());

  server.on('upgrade', async (req, socket, head) => {
    if (isProotRuntime && (req.url !== '/ws' || (!(await authenticateProotRequest(req)) && !(await authenticateBearerToken(req))))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/signal') {
      p2pSignaling.handleUpgrade(req, socket, head);
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // 设备连接场景无浏览器 cookie，只带 rda_/rdt_
    // bearer 令牌；cookie session 与 bearer 任一通过即可握手。
    await authenticateAccountCookie(req);
    if (!isAuthenticated(req) && !(await authenticateBearerToken(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._authSession = getAuthSession(req) || req._bearerAuthSession || null;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const role = ws._authSession?.role || 'owner';
    console.log(`[ws] Client connected (role=${role})`);
    void sendBuildInfo(ws);
    let deviceExpiryTimer;
    if (ws._authSession?.principalKind === 'trusted_device' && Number.isFinite(ws._authSession.expiry)) {
      deviceExpiryTimer = setTimeout(() => {
        try { ws.close(1008, 'Device credential expired'); } catch {}
        const timer = setTimeout(() => { try { ws.terminate(); } catch {} }, 500); timer.unref?.();
      }, Math.max(0, Math.min(ws._authSession.expiry - Date.now(), 2_147_483_647)));
      deviceExpiryTimer.unref?.();
    }

    ws.on('message', () => {
      try {
        ws.close(1008, 'Push-only WebSocket');
      } catch {}
    });

    ws.on('error', (error) => {
      // A malformed or protocol-violating client frame (e.g. WS_ERR_EXPECTED_MASK
      // from an unmasked frame) surfaces here. Without this handler the error is
      // unhandled and crashes the whole chat server. Log and close the socket.
      console.warn(`[ws] connection error (role=${role}): ${error?.code || error?.message || error}`);
      try { ws.close(1008, 'websocket error'); } catch {}
    });

    ws.on('close', () => {
      if (deviceExpiryTimer) clearTimeout(deviceExpiryTimer);
      console.log(`[ws] Client disconnected (role=${role})`);
    });
  });

  return wss;
}
