// 设备入口切换（介绍人机制）路由：
//  - POST /api/entry-switch/invite     owner-only：为「切换到设备 B」签发一次性 join-token
//  - POST /api/entry-switch/introspect Bearer 握手凭证：B 消费 token，A 回介绍信（本机私钥签名）
// 鉴权复用阶段三：B → A 先走 /api/device-handshake 换 5 分钟一次性凭证，再用 Bearer 调 introspect。
import { randomBytes } from 'crypto';
import { readBody } from '../lib/utils.mjs';
import {
  issueEntryJoinToken,
  introspectEntryJoinToken,
  buildIntroSigned,
} from '../lib/entry-switch.mjs';
import { consumeDeviceHandshakeToken } from '../lib/device-handshake.mjs';
import { getCrossDeviceOwnerIdentity } from '../lib/owner-identity.mjs';
import { listTrustedDevices } from './trusted-devices.mjs';

const MAX_INVITE_BODY_BYTES = 4 * 1024;
const MAX_INTROSPECT_BODY_BYTES = 4 * 1024;
// 健康探测超时：只用于 UI 预检，不改变实际切换的超时/重试语义。
const HEALTH_PROBE_TIMEOUT_MS = 2000;

function isValidTargetUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// 入口可达性探测：HEAD 已登记入口的原始路径，任意 HTTP 应答（含 401 鉴权墙）
// 都算可达；只有网络层失败/超时算不可达。owner-only，目标限定账本内 entryUrl。
async function probeEntryReachability(entryUrl) {
  const startedAt = Date.now();
  const target = new URL(entryUrl);
  target.hash = '';
  try {
    const response = await fetch(target, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { accept: 'text/html,application/json' },
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return {
      reachable: true,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      reachable: false,
      reason: error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'timeout'
        : 'unreachable',
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function getSourceInstanceId() {
  try {
    const { getTrustedDeviceInstanceId } = await import('./trusted-devices.mjs');
    const id = await getTrustedDeviceInstanceId();
    return id || 'local';
  } catch {
    return 'local';
  }
}

export async function handleEntrySwitchRoutes({ req, res, pathname, authSession, writeJson }) {
  // 入口健康探测（P1-⑤）：owner-only。供设备工作台对「未登记/不可达」入口置灰
  // 切换按钮；探测失败不阻塞设备展示，结果不落库（每次查询实时探测 + 前端短缓存）。
  if (pathname === '/api/entry-switch/health' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const requestUrl = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
    const deviceId = String(requestUrl.searchParams.get('deviceId') || '').trim();
    if (!deviceId) {
      writeJson(res, 400, { error: 'deviceId is required.' });
      return true;
    }
    const { devices } = await listTrustedDevices();
    const device = devices.find((entry) => entry.id === deviceId);
    if (!device) {
      writeJson(res, 404, { error: 'Device not found.' });
      return true;
    }
    const entryUrl = String(device.entryUrl || '').trim();
    const checkedAt = new Date().toISOString();
    if (!entryUrl) {
      writeJson(res, 200, { deviceId, reachable: false, reason: 'entry_url_missing', checkedAt });
      return true;
    }
    if (!isValidTargetUrl(entryUrl)) {
      writeJson(res, 200, { deviceId, reachable: false, reason: 'entry_url_invalid', checkedAt });
      return true;
    }
    const probe = await probeEntryReachability(entryUrl);
    writeJson(res, 200, { deviceId, entryUrl, checkedAt, ...probe });
    return true;
  }

  // A 发起：owner 会话下签发一次性 join-token，拼 jumpUrl 跳 B 的入口
  if (pathname === '/api/entry-switch/invite' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    // The introduction protocol currently creates an unrestricted owner
    // cookie on the destination. A shared member must not inherit it.
    if (authSession.workspaceAccess) {
      writeJson(res, 403, { error: 'Entry switching is unavailable for shared workspaces', code: 'workspace_capability_unsupported' });
      return true;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_INVITE_BODY_BYTES));
    } catch {
      writeJson(res, 400, { error: 'Invalid invite body.' });
      return true;
    }
    const targetDeviceId = String(body?.targetDeviceId || '').trim();
    const targetUrl = String(body?.targetUrl || '').trim();
    if (!targetDeviceId) {
      writeJson(res, 400, { error: 'targetDeviceId is required.' });
      return true;
    }
    // 目标必须在本机 trusted-devices 清单且未 revoke
    const { devices } = await listTrustedDevices();
    const targetDevice = devices.find((device) => device.id === targetDeviceId);
    if (!targetDevice) {
      writeJson(res, 404, { error: 'Target device not found.' });
      return true;
    }
    // 入口地址来源：请求体显式 targetUrl（覆盖）→ 设备已登记 entryUrl（M3）→ 400
    const resolvedTargetUrl = targetUrl || targetDevice.entryUrl || '';
    if (!isValidTargetUrl(resolvedTargetUrl)) {
      writeJson(res, 400, { error: 'targetUrl is required (or register the device entry URL first).' });
      return true;
    }
    try {
      // 介绍信承载本机 Accounts ownerId；B 侧用自己的绑定比对，不信任
      // 浏览器请求体携带的账号字段。
      const ownerIdentity = await getCrossDeviceOwnerIdentity();
      if (!ownerIdentity) {
        writeJson(res, 409, { error: 'This instance has no owner account binding.' });
        return true;
      }
      const { joinToken, expiresAt } = await issueEntryJoinToken({
        targetDeviceId,
        ownerId: ownerIdentity.id,
      });
      const sourceInstance = await getSourceInstanceId();
      // A 的地址随 jumpUrl 带给 B（B 回调 introspect 用）；验 A 的介绍信签名即可防中间人替换
      const proto = String(req.headers?.['x-forwarded-proto'] || '') === 'https' ? 'https' : 'http';
      const introspect = `${proto}://${String(req.headers?.host || '')}`;
      const jumpUrl = new URL(resolvedTargetUrl);
      jumpUrl.searchParams.set('join', joinToken);
      jumpUrl.searchParams.set('from', sourceInstance);
      // A 在配对时为 B 分配的不可猜测设备 ID。B 用它和自己的私钥完成握手，
      // 不再上报自选 instanceId 或 Google sub。
      jumpUrl.searchParams.set('device', targetDeviceId);
      jumpUrl.searchParams.set('introspect', introspect);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ jumpUrl: jumpUrl.toString(), expiresAt }));
    } catch (error) {
      const status = error?.code === 'ENTRY_SWITCH_ALREADY_PENDING' ? 409 : 400;
      writeJson(res, status, { error: error.message || 'Failed to create entry switch invitation' });
    }
    return true;
  }

  // B 消费：Bearer 握手凭证（B 先对 A 做阶段三握手换凭证）→ 验 token → 回介绍信
  if (pathname === '/api/entry-switch/introspect' && req.method === 'POST') {
    const header = String(req.headers?.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const handshakeRecord = token ? await consumeDeviceHandshakeToken(token) : null;
    if (!handshakeRecord?.deviceId) {
      writeJson(res, 403, { error: 'Valid handshake credential required' });
      return true;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_INTROSPECT_BODY_BYTES));
    } catch {
      writeJson(res, 400, { error: 'Invalid introspect body.' });
      return true;
    }
    const joinToken = String(body?.joinToken || '').trim();
    try {
      const { ownerId, targetDeviceId } = await introspectEntryJoinToken({
        joinToken,
        requestDeviceId: handshakeRecord.deviceId,
      });
      const introNonce = randomBytes(16).toString('hex');
      const sourceInstance = await getSourceInstanceId();
      const { introSig, sourcePublicKey } = await buildIntroSigned({ sourceInstance, introNonce });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        ownerId,
        sourceInstance,
        targetDevice: targetDeviceId,
        introNonce,
        introSig,
        sourcePublicKey,
      }));
    } catch (error) {
      const status = error?.code === 'TOO_MANY_ATTEMPTS'
        ? 429
        : error?.code === 'JOIN_TOKEN_EXPIRED' || error?.code === 'JOIN_TOKEN_USED'
          ? 410
          : error?.code === 'JOIN_TOKEN_MISMATCH'
            ? 401
            : 400;
      writeJson(res, status, { error: error.message || 'Introspect failed' });
    }
    return true;
  }

  return false;
}
