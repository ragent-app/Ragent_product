// 设备连接 bootstrap 路由（ADR-0001 2026-08-17 修订）：
//  - GET  /api/device-auth/bootstrap            已鉴权设备获取 signed contract
//  - POST /api/device-auth/bootstrap/report     设备上报选路/迁移结果（幂等）
//  - POST /api/device-auth/turn/release          设备主动释放 TURN 连接租约
//  - GET  /api/device-auth/bootstrap/public-key 实例验签公钥分发
// 仅 trusted_device principal 可访问；owner 会话与 provisional 设备都被拒绝。
// 这些路径都不在 RemoteApiGateway 的 blocked 前缀里；TURN 与 P2P
// 复用同一设备凭据与策略，不产生第二套权限。
import { readBody } from '../lib/utils.mjs';
import { buildDeviceConnectionBootstrapContract } from './connection-bootstrap-service.mjs';
import { recordConnectionBootstrapReport } from './connectivity-state.mjs';
import { CONNECTION_BOOTSTRAP_REPORT_PHASES } from '../lib/connection-bootstrap-contract.mjs';
import { loadOrCreateInstanceIdentity, publicInstanceIdentity } from '../lib/instance-identity.mjs';
import { markTurnConnectionLeaseConnected, releaseTurnConnectionLease } from './turn-connection-leases.mjs';
import { releaseOwnerAccountTurnConnection } from '../lib/owner-account-auth.mjs';
import { getTrustedDeviceStatus } from './trusted-devices.mjs';
import { validateTurnHandoffRequest } from './turn-handoff-request.mjs';
import { requestP2PHostHandoff, getP2PHostHandoffPlan, commitP2PHostHandoff } from '../lib/p2p-host-registry.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonBody(req) {
  const body = await readBody(req, 16 * 1024);
  return body ? JSON.parse(body) : {};
}

export async function handleConnectionBootstrapRoutes({ req, res, pathname, authSession, writeJson }) {
  if (
    pathname !== '/api/device-auth/bootstrap'
    && pathname !== '/api/device-auth/bootstrap/report'
    && pathname !== '/api/device-auth/turn/release'
    && pathname !== '/api/device-auth/bootstrap/public-key'
    && pathname !== '/api/device-auth/turn/handoff/request'
    && pathname !== '/api/device-auth/turn/handoff/plan'
    && pathname !== '/api/device-auth/turn/handoff/commit'
  ) {
    return false;
  }

  if (authSession?.principalKind !== 'trusted_device' || !authSession?.deviceId) {
    writeJson(res, 403, {
      error: 'A trusted-device session is required to access the connection bootstrap contract',
      code: 'device_session_required',
    });
    return true;
  }

  if (pathname.startsWith('/api/device-auth/turn/handoff/') && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (pathname.endsWith('/request')) {
        const device = await getTrustedDeviceStatus(authSession.deviceId);
        const identity = await loadOrCreateInstanceIdentity();
        const previous = validateTurnHandoffRequest({ contract: body.contract, identity,
          accountId: device?.accountId, deviceId: authSession.deviceId });
        const accepted = requestP2PHostHandoff(authSession.deviceId, previous);
        writeJson(res, accepted ? 202 : 409, { accepted });
        return true;
      }
      const handoffId = trimString(body.handoffId);
      if (!/^[a-f0-9]{32}$/.test(handoffId)) {
        writeJson(res, 400, { error: 'Invalid handoff identifier', code: 'turn_handoff_request_invalid' });
        return true;
      }
      if (pathname.endsWith('/plan')) {
        const contract = getP2PHostHandoffPlan(authSession.deviceId, handoffId);
        if (!contract) { writeJson(res, 409, { error: 'Handoff plan unavailable', code: 'turn_handoff_unavailable' }); return true; }
        res.setHeader('Cache-Control', 'private, no-store');
        writeJson(res, 200, contract);
        return true;
      }
      const committed = await commitP2PHostHandoff(authSession.deviceId, handoffId);
      writeJson(res, committed ? 200 : 409, { committed });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: 'Handoff request failed', code: error?.code || 'turn_handoff_unavailable' });
    }
    return true;
  }

  // 实例验签公钥分发：Android 首次拿到 signed contract 前需要公钥验签；
  // 已从 QR 配对响应登记公钥的设备无需请求本端点（keyId 相同即命中缓存）。
  if (pathname === '/api/device-auth/bootstrap/public-key' && req.method === 'GET') {
    try {
      const publicIdentity = publicInstanceIdentity(await loadOrCreateInstanceIdentity());
      res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
      writeJson(res, 200, {
        algorithm: 'ed25519',
        keyId: publicIdentity.keyFingerprint,
        publicKeyPem: publicIdentity.publicKey,
      });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to load instance public key' });
    }
    return true;
  }

  if (pathname === '/api/device-auth/bootstrap' && req.method === 'GET') {
    try {
      const allowDirectIce = authSession.principalKind === 'trusted_device'
        && authSession.role === 'owner'
        && !authSession.workspaceAccess;
      const contract = await buildDeviceConnectionBootstrapContract({
        deviceId: authSession.deviceId,
        allowDirectIce,
      });
      res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
      writeJson(res, 200, contract);
    } catch (error) {
      writeJson(res, error?.statusCode || 400, {
        error: error.message || 'Failed to build bootstrap contract',
        code: trimString(error?.code) || 'bootstrap_contract_unavailable',
      });
    }
    return true;
  }

  if (pathname === '/api/device-auth/bootstrap/report' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const phase = trimString(payload?.phase);
      if (!phase || !CONNECTION_BOOTSTRAP_REPORT_PHASES.includes(phase)) {
        writeJson(res, 400, {
          error: `phase must be one of ${CONNECTION_BOOTSTRAP_REPORT_PHASES.join(', ')}`,
        });
        return true;
      }
      const result = await recordConnectionBootstrapReport({
        deviceId: authSession.deviceId,
        requestId: trimString(payload?.requestId),
        phase,
        candidateId: trimString(payload?.candidateId),
        transport: trimString(payload?.transport),
        connectionId: trimString(payload?.connectionId),
        connectionMode: trimString(payload?.connectionMode),
        errorCode: trimString(payload?.errorCode),
        detail: trimString(payload?.detail),
      });
      const transport = trimString(payload?.transport);
      if (phase === 'connected' && transport === 'turn') {
        await markTurnConnectionLeaseConnected({
          deviceId: authSession.deviceId,
          connectionId: trimString(payload?.connectionId),
        }).catch(() => {});
      } else if (phase === 'rejected-consent' || phase === 'failed'
        || (phase === 'migrated' && transport === 'webrtc')) {
        await releaseTurnConnectionLease({
          deviceId: authSession.deviceId,
          connectionId: trimString(payload?.connectionId),
          reason: phase,
        }).catch(() => {});
        await releaseOwnerAccountTurnConnection({
          deviceId: authSession.deviceId,
          connectionId: trimString(payload?.connectionId),
          reason: phase,
        }).catch(() => {});
      }
      writeJson(res, result.recorded ? 201 : 200, result);
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to record bootstrap report' });
    }
    return true;
  }

  if (pathname === '/api/device-auth/turn/release' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await releaseTurnConnectionLease({
        deviceId: authSession.deviceId,
        connectionId: trimString(payload?.connectionId),
        reason: trimString(payload?.reason) || 'client-release',
      });
      await releaseOwnerAccountTurnConnection({
        deviceId: authSession.deviceId,
        connectionId: trimString(payload?.connectionId),
        reason: trimString(payload?.reason) || 'client-release',
      }).catch(() => {});
      writeJson(res, 200, { ok: true, ...result });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to release TURN connection' });
    }
    return true;
  }

  writeJson(res, 405, { error: 'Method not allowed' });
  return true;
}
