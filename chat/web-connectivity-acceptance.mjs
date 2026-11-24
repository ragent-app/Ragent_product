// TEST/ACCEPTANCE ONLY — Web Connectivity Phase 0 最终真人授权 relay 验收入口。
// 非产品功能：仅为 owner 本人完成正式 Google 登录后的全链验收提供最小发证面。
// 规则：
//  - prepare/grant 全部复用生产函数（真实 reserve→brokerCredential→TURN mint→
//    实例签名 bootstrap v2 + bca1 grant + sjt1），无 fixture、无 mock、无 bypass、
//    无新协议；/healthz 走真实 RemoteApiGateway，不设任何浏览器专用处理分支。
//  - prepare 仅 owner 会话可达；浏览器凭 exchange ticket（一次性、120s TTL、
//    绑定 account/instance/device/connection）换取发证结果，owner 凭据永不进入浏览器。
//  - 本模块不记录、不返回任何长期凭据；ticket 与房间 secret 仅在响应中交付给
//    相应信任级调用方（ticket→POC 页面，secret→owner 会话调用方），不落日志。
import { createPrivateKey, createPublicKey, randomBytes } from 'crypto';
import {
  getOwnerAccountBinding,
  listOwnerAccountDevices,
} from '../lib/owner-account-auth.mjs';
import {
  loadOrCreateInstanceIdentity,
} from '../lib/instance-identity.mjs';
import {
  createReplayStore,
  issueBrowserConnectionGrant,
  issueSignalJoinToken,
  verifyBrowserConnectionGrant,
  verifySignalJoinToken,
} from '../lib/browser-connection-grant.mjs';
import { buildDeviceConnectionBootstrapContract } from './connection-bootstrap-service.mjs';
import { getTrustedDeviceP2PAccess, getTrustedDeviceStatus } from './trusted-devices.mjs';
import { p2pHostDeviceIds } from '../lib/p2p-host-registry.mjs';

const ACCEPTANCE_TICKET_TTL_MS = 120_000;
const tickets = new Map();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sweepTickets(nowMs = Date.now()) {
  for (const [ticket, record] of tickets) {
    if (record.expiresAt <= nowMs) tickets.delete(ticket);
  }
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function instancePublicPem(identity) {
  return createPublicKey(createPrivateKey(identity.privateKey))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

function normalizeDeviceList(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.devices)) return result.devices;
  return [];
}

function deviceRecordId(entry) {
  return trimString(entry?.id) || trimString(entry?.deviceId);
}

function bootstrapConnectionId(bootstrap) {
  return trimString(bootstrap?.turn?.connectionId)
    || trimString(bootstrap?.candidates?.find((entry) => entry?.kind === 'turn')?.metadata?.connectionId);
}

function bootstrapSignaling(bootstrap) {
  const candidate = bootstrap?.candidates?.find((entry) => entry?.kind === 'webrtc');
  return {
    signalingUrl: trimString(candidate?.endpoint),
    roomId: trimString(candidate?.metadata?.roomId),
  };
}

// 浏览器 exchange 发证（ticket 消费点）。浏览器 POC 页面跨源 fetch，需要与
// fixture 相同的最小 CORS 面；仅此 ACCEPTANCE 路由放开。
function grantIssuerFor(instanceId) {
  return `instance:${trimString(instanceId)}`;
}

export async function handleWebConnectivityAcceptanceRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
}) {
  const requestTarget = trimString(req?.url) || trimString(pathname);
  const qIndex = requestTarget.indexOf('?');
  const path = qIndex >= 0 ? requestTarget.slice(0, qIndex) : requestTarget;
  const query = new URLSearchParams(qIndex >= 0 ? requestTarget.slice(qIndex + 1) : '');

  if (path === '/api/acceptance/web-connectivity/status' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required', code: 'acceptance_owner_required' });
      return true;
    }
    sweepTickets();
    const [active] = tickets.values();
    writeJson(res, 200, {
      ok: true,
      testOnlyAcceptance: true,
      activeTicket: active
        ? { deviceId: active.deviceId, connectionId: active.connectionId, expiresAt: new Date(active.expiresAt).toISOString() }
        : null,
    });
    return true;
  }

  if (path === '/api/acceptance/web-connectivity/prepare' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required', code: 'acceptance_owner_required' });
      return true;
    }
    sweepTickets();
    let requestedDeviceId = '';
    try {
      const parsed = JSON.parse(await readBody(req) || '{}');
      requestedDeviceId = trimString(parsed?.deviceId);
    } catch {
      requestedDeviceId = '';
    }

    // §11–13：设备归属只认正式 owner API 的返回，不做本地绑定推断。
    let devices = [];
    try {
      devices = normalizeDeviceList(await listOwnerAccountDevices());
    } catch {
      devices = [];
    }
    if (!devices.length) {
      writeJson(res, 503, { error: 'Accounts device list is unavailable.', code: 'acceptance_devices_unavailable' });
      return true;
    }
    let deviceId = requestedDeviceId;
    if (deviceId) {
      if (!devices.some((entry) => deviceRecordId(entry) === deviceId)) {
        writeJson(res, 403, { error: 'Account does not own this device.', code: 'acceptance_not_owned' });
        return true;
      }
    } else {
      // 默认避开已有运行 host 的设备：同 room 第二个 host join 会以 1012
      // 踢掉生产 host 并与其自动重连互相顶替，验收不接受这种扰动。
      const hosted = new Set(p2pHostDeviceIds());
      deviceId = devices.map(deviceRecordId).find((id) => id && !hosted.has(id)) || '';
      if (!deviceId) {
        writeJson(res, 409, { error: 'Every owned device already has a running P2P host.', code: 'acceptance_host_conflict' });
        return true;
      }
    }

    const device = await getTrustedDeviceStatus(deviceId);
    if (!device) {
      writeJson(res, 404, { error: 'Trusted device not found on this instance.', code: 'acceptance_device_missing' });
      return true;
    }
    if (device.revokedAt) {
      writeJson(res, 403, { error: 'Trusted device is revoked.', code: 'acceptance_device_revoked' });
      return true;
    }

    // 真实生产链：reserve → brokerCredential → TURN mint → 实例签名 bootstrap v2。
    // Ephemeral browser acceptance connections must remain TURN relay-only.
    let bootstrap;
    try {
      bootstrap = await buildDeviceConnectionBootstrapContract({ deviceId, allowDirectIce: false });
    } catch (error) {
      writeJson(res, error?.statusCode || 503, {
        error: error?.message || 'TURN bootstrap failed.',
        code: error?.code || 'acceptance_bootstrap_failed',
      });
      return true;
    }
    const connectionId = bootstrapConnectionId(bootstrap);
    const { signalingUrl, roomId } = bootstrapSignaling(bootstrap);
    const p2pAccess = await getTrustedDeviceP2PAccess(deviceId);
    if (!connectionId || !signalingUrl || !roomId || p2pAccess?.roomId !== roomId || !p2pAccess?.secret) {
      writeJson(res, 503, { error: 'Bootstrap connection binding is incomplete.', code: 'acceptance_binding_incomplete' });
      return true;
    }
    const binding = await getOwnerAccountBinding().catch(() => null);
    const accountId = trimString(binding?.accountId);
    if (!accountId) {
      writeJson(res, 409, { error: 'Instance has no Accounts binding.', code: 'acceptance_not_bound' });
      return true;
    }

    const identity = await loadOrCreateInstanceIdentity();
    const publicKeyPem = instancePublicPem(identity);
    const keyId = trimString(bootstrap?.signature?.keyId);
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + ACCEPTANCE_TICKET_TTL_MS;
    tickets.set(ticket, {
      accountId,
      instanceId: trimString(bootstrap.instanceId),
      deviceId,
      connectionId,
      roomId,
      signalingUrl,
      signalSecret: p2pAccess.secret,
      bootstrap,
      bootstrapPublicKey: { algorithm: 'ed25519', keyId, publicKeyPem },
      expiresAt,
    });
    writeJson(res, 200, {
      ok: true,
      testOnlyAcceptance: true,
      ticket,
      accountId,
      instanceId: trimString(bootstrap.instanceId),
      deviceId,
      connectionId,
      roomId,
      signalingUrl,
      signalSecret: p2pAccess.secret,
      grantIssuer: grantIssuerFor(bootstrap.instanceId),
      bootstrap,
      bootstrapPublicKey: { algorithm: 'ed25519', keyId, publicKeyPem },
      ticketExpiresAt: new Date(expiresAt).toISOString(),
    });
    return true;
  }

  if (path === '/api/acceptance/web-connectivity/grant' && (req.method === 'POST' || req.method === 'OPTIONS')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type',
        'Cache-Control': 'no-store',
      });
      res.end();
      return true;
    }
    // POC 页面挂在临时静态端口上，实际 POST 是跨源请求：仅预检带 CORS 不够，
    // 响应本体缺 Access-Control-Allow-Origin 时浏览器会拦截，fetch 报 "Failed to fetch"。
    res.setHeader('Access-Control-Allow-Origin', '*');
    sweepTickets();
    const ticket = trimString(query.get('ticket'));
    const record = tickets.get(ticket);
    if (!record || record.expiresAt <= Date.now()) {
      writeJson(res, 403, { error: 'Acceptance ticket is invalid or expired.', code: 'acceptance_ticket_invalid' });
      return true;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      writeJson(res, 400, { error: 'Invalid request body.', code: 'acceptance_request_invalid' });
      return true;
    }
    const clientId = trimString(body?.clientId);
    const ephemeralPublicKey = body?.ephemeralPublicKey;
    if (!clientId || !ephemeralPublicKey
      || trimString(body?.accountId) !== record.accountId
      || trimString(body?.instanceId) !== record.instanceId
      || trimString(body?.connectionId) !== record.connectionId) {
      writeJson(res, 403, { error: 'Grant request does not match the acceptance ticket binding.', code: 'acceptance_binding_mismatch' });
      return true;
    }

    const privateKey = createPrivateKey((await loadOrCreateInstanceIdentity()).privateKey);
    const kid = trimString(record.bootstrapPublicKey.keyId);
    const issuer = grantIssuerFor(record.instanceId);
    const grant = issueBrowserConnectionGrant({
      privateKey,
      issuer,
      instanceId: record.instanceId,
      accountId: record.accountId,
      clientId,
      connectionId: record.connectionId,
      ephemeralPublicKey,
      kid,
    });
    const signal = issueSignalJoinToken({
      privateKey,
      issuer,
      roomId: record.roomId,
      instanceId: record.instanceId,
      clientId,
      connectionId: record.connectionId,
      kid,
    });
    // 发证后立即自验（与 fixture 同样的签名/绑定断言），失败即拒绝交付。
    const grantCheck = verifyBrowserConnectionGrant(grant.token, {
      trustedKeys: new Map([[kid, createPublicKey(privateKey)]]),
      expectedIssuer: issuer,
      expectedInstanceId: record.instanceId,
      expectedClientId: clientId,
      expectedConnectionId: record.connectionId,
    });
    const signalCheck = verifySignalJoinToken(signal.token, {
      trustedKeys: new Map([[kid, createPublicKey(privateKey)]]),
      // verifySignalJoinToken 的防重放检查是必选项：无 replayStore 时一律判
      // "signal token replayed"。自验与 fixture 断言面一致，配一次性 store。
      replayStore: createReplayStore(),
      expectedIssuer: issuer,
      expectedRoomId: record.roomId,
      expectedInstanceId: record.instanceId,
      expectedClientId: clientId,
      expectedConnectionId: record.connectionId,
    });
    if (!grantCheck.valid || !signalCheck.valid) {
      tickets.delete(ticket);
      writeJson(res, 500, { error: 'Issued acceptance credentials failed self-verification.', code: 'acceptance_selfcheck_failed' });
      return true;
    }

    // 一次性：exchange 成功即作废。
    tickets.delete(ticket);
    writeJson(res, 200, {
      grant: grant.token,
      grantJtiPrefix: grant.payload.jti.slice(0, 12),
      signalJoinToken: signal.token,
      signalSecret: record.signalSecret,
      signalingUrl: record.signalingUrl,
      roomId: record.roomId,
      instanceId: record.instanceId,
      clientId,
      connectionId: record.connectionId,
      deviceId: record.deviceId,
      bootstrap: record.bootstrap,
      bootstrapPublicKey: record.bootstrapPublicKey,
      // 与 fixture 的差异点：无 testOnlyDirectHarness → POC 客户端自动
      // iceTransportPolicy:'relay' + 使用签名契约内的真实 TURN iceServers。
      turnOnly: true,
    });
    return true;
  }

  return false;
}
