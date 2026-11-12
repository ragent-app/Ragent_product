// owner Google 账号绑定与跨设备登录路由（Accounts broker）。
//  - POST /api/auth/google/login  （公开）登录页发起 → {authUrl}
//  - POST /api/auth/google/bind   （owner-only）本机 owner 绑定 Google 账号（可选 body {alias}）→ {authUrl}
//  - GET  /api/auth/google/bind/redirect （owner-only）浏览器绑定跳转（先设 Cookie 再 302）
//  - GET  /api/auth/google/status （公开）登录页探测是否启用/已绑定
// 浏览器回跳使用 /api/auth/google/complete 兑换 Accounts 一次性 grant。
import { readBody } from '../lib/utils.mjs';
import { BRIDGE_PUBLIC_BASE_URL, PUBLIC_BASE_URL } from '../lib/config.mjs';
import {
  createGoogleIdTokenVerifier,
  resolveGoogleNativeServerClientIds,
} from '../lib/google-id-token.mjs';
import { authenticateBearerToken, getAuthSession, issueSession, setCookie } from '../lib/auth.mjs';
import {
  bindOwnerAccountFromGoogleIdentity,
  completeOwnerAccountNativeAuth,
  publishOwnerAccountEndpoint,
  clearOwnerAccountBinding,
  clearOwnerAccountNativePending,
  clearOwnerAccountStateCookie,
  claimOwnerAccountPollSession,
  completeOwnerAccountAuth,
  getOwnerAccountBinding,
  getOwnerAccountBindingHistory,
  getOwnerAccountBrokerStatus,
  getDemoSignInStatus,
  getOwnerAccountNativePending,
  getOwnerAccountTransactionStatus,
  recoverOwnerAccountNativePending,
  markOwnerAccountNativeJournal,
  clearOwnerAccountNativeJournal,
  listOwnerAccountDevices,
  rollbackOwnerAccountNativeAuth,
  startOwnerAccountAuth,
  attachOwnerAuthPoller,
  unbindOwnerAccount,
} from '../lib/owner-account-auth.mjs';
import {
  authenticateTrustedDeviceToken,
  convergeTrustedDevice,
  getTrustedDeviceStatus,
} from './trusted-devices.mjs';

// Android Credential Manager returns an ID token for the Web/server OAuth
// client. The allowlist is deployment configuration; an unset value fails
// closed instead of accepting a source-level fallback.
const verifyAndroidGoogleIdToken = createGoogleIdTokenVerifier({
  clientIds: resolveGoogleNativeServerClientIds(),
});
const nativeGoogleAudienceConfigured = resolveGoogleNativeServerClientIds().length > 0;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDeviceAlias(value) {
  return trimString(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 64);
}

// Caddy exposes the owner instance through more than one HTTPS hostname in
// some deployments (for example the historical thelab alias and the current
// agentoc hostname). The state cookie is host-only, so an Accounts transaction
// started on an alias must return to that same alias. Trust only the HTTPS
// forwarded host supplied by the reverse proxy; direct/internal requests keep
// using the configured canonical URL.
function resolveOwnerAuthPublicBaseUrl(req) {
  const configured = trimString(PUBLIC_BASE_URL) || trimString(BRIDGE_PUBLIC_BASE_URL);
  const forwardedHost = trimString(req.headers?.['x-forwarded-host'])
    .split(',')[0]
    .trim();
  const forwardedProto = trimString(req.headers?.['x-forwarded-proto'])
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!forwardedHost || forwardedProto !== 'https') return configured.replace(/\/+$/, '');
  try {
    const forwarded = new URL(`https://${forwardedHost}`);
    if (forwarded.username || forwarded.password || forwarded.search || forwarded.hash) return configured.replace(/\/+$/, '');
    const base = configured ? new URL(configured) : new URL(`https://${forwardedHost}`);
    forwarded.pathname = base.pathname.replace(/\/+$/, '');
    forwarded.search = '';
    forwarded.hash = '';
    return forwarded.toString().replace(/\/+$/, '');
  } catch {
    return configured.replace(/\/+$/, '');
  }
}

// Owner auth has one backend: the Accounts broker. An unconfigured broker is
// reported explicitly and never falls through to an instance-local OAuth flow.
async function resolveOwnerAuthMode(accountBroker) {
  const accountBinding = await getOwnerAccountBinding();
  return {
    mode: accountBroker.enabled ? 'accounts' : 'unconfigured',
    enabled: accountBroker.enabled,
    bound: Boolean(accountBinding),
    accountBinding,
  };
}

export async function handleGoogleOwnerAuthRoutes({ req, res, pathname, authSession, writeJson }) {
  // router.mjs keeps pathname query-free. Read the original request target for
  // browser navigation routes, while retaining the query-in-path form used by
  // direct callers and focused route tests.
  const requestTarget = trimString(req?.url) || trimString(pathname);
  const qIndex = requestTarget.indexOf('?');
  const path = qIndex >= 0 ? requestTarget.slice(0, qIndex) : requestTarget;
  const query = new URLSearchParams(qIndex >= 0 ? requestTarget.slice(qIndex + 1) : '');
  const accountBroker = getOwnerAccountBrokerStatus();

  if (path === '/api/auth/demo/status' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    writeJson(res, 200, { status: await getDemoSignInStatus() });
    return true;
  }

  // 受控 Accounts broker 回跳：不接触 Google code/client/token，实例只兑换一次性 grant。
  if (path === '/api/auth/google/complete' && req.method === 'GET') {
    try {
      const completed = await completeOwnerAccountAuth({
        req,
        transactionId: query.get('tx'),
        grant: query.get('grant'),
        authSession,
      });
      if (completed.purpose === 'bind') {
        res.writeHead(302, {
          Location: '/?google=bound',
          'Set-Cookie': clearOwnerAccountStateCookie(),
          'Cache-Control': 'no-store',
        });
        res.end();
        return true;
      }
      const sessionToken = await issueSession({ role: 'owner', authMethod: 'google_accounts', accountId: completed.accountId,
        ...(completed.bindingAuthorityRevision ? { bindingAuthorityRevision: completed.bindingAuthorityRevision } : {}) });
      if (!sessionToken) throw new Error('Failed to issue owner session');
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [setCookie(sessionToken), clearOwnerAccountStateCookie()],
        'Cache-Control': 'no-store',
      });
      res.end();
    } catch (error) {
      res.writeHead(302, {
        Location: '/login?error=1&mode=google',
        'Set-Cookie': clearOwnerAccountStateCookie(),
        'Cache-Control': 'no-store',
      });
      res.end();
      // 只记录稳定错误码，避免把 grant、cookie 或身份信息写入日志。
      console.warn('owner-account-callback:', error?.code || 'owner_auth_unexpected');
    }
    return true;
  }

  // 登录页发起 Google 登录（公开：回调前无会话）
  if (path === '/api/auth/google/login' && req.method === 'POST') {
    const ownerAuth = await resolveOwnerAuthMode(accountBroker);
    if (!ownerAuth.enabled) {
      writeJson(res, 503, { error: 'Accounts owner authentication is not configured on this instance.', code: 'owner_auth_broker_not_configured' });
      return true;
    }
    if (!ownerAuth.bound) {
      writeJson(res, 409, { error: 'Google sign-in has not been bound on this instance.' });
      return true;
    }
    try {
      const started = await startOwnerAccountAuth({
        purpose: 'login',
        publicBaseUrl: resolveOwnerAuthPublicBaseUrl(req),
      });
      if (started.deliveryMode === 'instance_poll') {
        attachOwnerAuthPoller(started.transactionId);
        // Poll login uses an opaque browser-only state cookie for the final
        // session handoff. It contains no account identity or credential.
        if (started.stateCookie) res.setHeader?.('Set-Cookie', started.stateCookie);
        writeJson(res, 200, {
          authUrl: started.authUrl,
          transactionId: started.transactionId,
          expiresAt: started.expiresAt,
          deliveryMode: 'instance_poll',
          mode: 'accounts',
        });
        return true;
      }
      res.setHeader?.('Set-Cookie', started.stateCookie);
      writeJson(res, 200, {
        authUrl: started.authUrl,
        transactionId: started.transactionId,
        expiresAt: started.expiresAt,
        mode: 'accounts',
      });
    } catch (error) {
      writeJson(res, error?.statusCode || 502, { error: 'Google login is temporarily unavailable.', code: error?.code || 'owner_auth_failed' });
    }
    return true;
  }

  // 本机已登录 owner 绑定 Google 账号（跨设备 owner 凭据的来源）。
  // 可选 body {alias}：新绑定/解绑后重绑时给本设备命名（存绑定文件 deviceAlias）
  // 浏览器导航端点先在主站设置 state cookie，再跳转到 Accounts。它是绑定 UI
  // 的首选入口，避免依赖 fetch/P2P 响应是否能写入浏览器 Cookie Jar。
  if (path === '/api/auth/google/bind/redirect' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const alias = normalizeDeviceAlias(query.get('alias'));
    if (!accountBroker.enabled) {
      writeJson(res, 503, { error: 'Accounts owner authentication is not configured on this instance.', code: 'owner_auth_broker_not_configured' });
      return true;
    }
    try {
      const started = await startOwnerAccountAuth({
        purpose: 'bind',
        alias,
        publicBaseUrl: resolveOwnerAuthPublicBaseUrl(req),
      });
      // Accounts owns credential entry; the hint contains no credentials.
      const destination = new URL(started.authUrl);
      if (query.get('flow') === 'demo') destination.searchParams.set('flow', 'demo');
      if (started.deliveryMode === 'instance_poll') {
        attachOwnerAuthPoller(started.transactionId);
        res.writeHead(302, {
          Location: destination.toString(),
          'Cache-Control': 'no-store',
        });
        res.end();
        return true;
      }
      res.writeHead(302, {
        Location: destination.toString(),
        'Set-Cookie': started.stateCookie,
        'Cache-Control': 'no-store',
      });
      res.end();
    } catch (error) {
      writeJson(res, error?.statusCode || 502, { error: 'Google binding is temporarily unavailable.', code: error?.code || 'owner_auth_failed' });
    }
    return true;
  }

  if (path === '/api/auth/google/bind' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let alias = '';
    try {
      const raw = await readBody(req, 8192);
      if (raw) {
        const parsedBody = JSON.parse(raw);
        if (typeof parsedBody.alias === 'string') {
          alias = normalizeDeviceAlias(parsedBody.alias);
        }
      }
    } catch {
      // 空/非 JSON body 视为无别名
    }
    if (!accountBroker.enabled) {
      writeJson(res, 503, { error: 'Accounts owner authentication is not configured on this instance.', code: 'owner_auth_broker_not_configured' });
      return true;
    }
    try {
      const started = await startOwnerAccountAuth({
        purpose: 'bind',
        alias,
        publicBaseUrl: resolveOwnerAuthPublicBaseUrl(req),
      });
      if (started.deliveryMode === 'instance_poll') {
        attachOwnerAuthPoller(started.transactionId);
        writeJson(res, 200, {
          authUrl: started.authUrl,
          transactionId: started.transactionId,
          expiresAt: started.expiresAt,
          deliveryMode: 'instance_poll',
          bound: Boolean(await getOwnerAccountBinding()),
          mode: 'accounts',
        });
        return true;
      }
      res.setHeader?.('Set-Cookie', started.stateCookie);
      writeJson(res, 200, {
        authUrl: started.authUrl,
        transactionId: started.transactionId,
        expiresAt: started.expiresAt,
        bound: Boolean(await getOwnerAccountBinding()),
        mode: 'accounts',
      });
    } catch (error) {
      writeJson(res, error?.statusCode || 502, { error: 'Google binding is temporarily unavailable.', code: error?.code || 'owner_auth_failed' });
    }
    return true;
  }

  // Android 原生 Google 登录（冻结契约候选 A）：Credential Manager ID token → 校验 +
  // 绑定/登录本设备。鉴权复用 trusted-device Bearer（router.mjs 中间件已把 rdt_/rda_
  // 解析进 authSession，role=owner）。无需发放新会话——设备凭据即会话。
  //   body: { idToken, alias? }
  //   未绑定 → bind；已绑定且 sub 一致 → login（刷新 lastSeenAt）。
  if (path === '/api/auth/google/token' && req.method === 'POST') {
    // router.mjs 在 google-owner 分派点（requireAuth 之前）不会解析 trusted-device Bearer，
    // 这里为 token 端点补一次 Bearer 解析（无 Bearer 时 authenticateBearerToken 快速返回 false）。
    if (!authSession) {
      await authenticateBearerToken(req);
      authSession = getAuthSession(req) || null;
    }
    if (!authSession) {
      writeJson(res, 401, { error: 'Owner access required', code: 'owner_auth_not_owner' });
      return true;
    }
    if (authSession.role !== 'owner' && authSession.principalKind !== 'provisional_device') {
      writeJson(res, 403, { error: 'Owner access required', code: 'owner_auth_not_owner' });
      return true;
    }
    let body = null;
    try {
      const raw = await readBody(req, 8192);
      if (raw) body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!body || typeof body.idToken !== 'string' || !body.idToken.trim()) {
      writeJson(res, 400, { error: 'Invalid request body.', code: 'owner_auth_request_invalid' });
      return true;
    }
    if (body.alias !== undefined && (typeof body.alias !== 'string' || body.alias.trim().length > 64)) {
      writeJson(res, 400, { error: 'Invalid device alias.', code: 'owner_auth_request_invalid' });
      return true;
    }
    // 幂等键单来源：Header `Idempotency-Key` 优先，body `idempotencyKey` 为兼容来源。
    // 两者同时存在且不一致时拒绝（防止代理/重试漂移），accounts 模式必须显式提供，
    // 禁止服务端自动生成新键破坏 P1–P2 恢复窗口的同 requestId 重放幂等。
    const headerIdempotencyKey = trimString(req.headers?.['idempotency-key'] || '');
    const bodyIdempotencyKey = body.idempotencyKey === undefined
      ? ''
      : (typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '\u0000');
    const isValidIdempotencyKey = (value) => !value
      || (value.length >= 16 && value.length <= 128 && /^[\x21-\x7e]+$/.test(value));
    if (!isValidIdempotencyKey(headerIdempotencyKey) || !isValidIdempotencyKey(bodyIdempotencyKey)) {
      writeJson(res, 400, { error: 'Invalid idempotency key.', code: 'owner_auth_request_invalid' });
      return true;
    }
    if (headerIdempotencyKey && bodyIdempotencyKey && headerIdempotencyKey !== bodyIdempotencyKey) {
      writeJson(res, 400, {
        error: 'Idempotency key mismatch between header and body.',
        code: 'owner_auth_idempotency_conflict',
      });
      return true;
    }
    const requestId = headerIdempotencyKey || bodyIdempotencyKey;
    const alias = typeof body.alias === 'string' ? body.alias.trim().slice(0, 64) : '';
    const ownerAuth = await resolveOwnerAuthMode(accountBroker);
    if (!ownerAuth.enabled) {
      writeJson(res, 409, { error: 'Google login is not configured on this instance.', code: 'google_login_not_configured' });
      return true;
    }
    if (!nativeGoogleAudienceConfigured) {
      writeJson(res, 409, {
        error: 'Native Google sign-in is not configured on this instance.',
        code: 'google_login_not_configured',
      });
      return true;
    }
    let googleIdentity;
    try {
      googleIdentity = await verifyAndroidGoogleIdToken({ idToken: body.idToken });
    } catch (error) {
      if (error?.statusCode === 502) {
        writeJson(res, 502, { error: 'Google account verification is temporarily unavailable.', code: 'owner_auth_account_invalid' });
      } else if (error?.statusCode === 409 && error?.code === 'google_login_not_configured') {
        writeJson(res, 409, { error: 'Native Google sign-in is not configured on this instance.', code: 'google_login_not_configured' });
      } else {
        writeJson(res, 401, { error: 'Google ID token is invalid.', code: 'owner_auth_token_invalid' });
      }
      return true;
    }
    try {
      if (ownerAuth.mode === 'accounts') {
        // A restart may have stopped after Accounts committed but before the
        // local device mutation. Finish only this local, already-authorized
        // work before asking Accounts to verify a fresh Google token.
        await recoverOwnerAccountNativePending().catch(() => {});
        const deviceId = trimString(authSession.deviceId || authSession.principalId);
        if (!deviceId) {
          writeJson(res, 400, { error: 'A trusted device identity is required.', code: 'owner_auth_request_invalid' });
          return true;
        }
        if (!requestId) {
          writeJson(res, 400, { error: 'An idempotency key is required.', code: 'owner_auth_request_invalid' });
          return true;
        }
        let completed = null;
        let localConverged = false;
        try {
          completed = await completeOwnerAccountNativeAuth({
            idToken: body.idToken,
            deviceId,
            deviceAlias: alias,
            accountProfile: googleIdentity,
            requestId,
          });
          const converged = await convergeTrustedDevice(deviceId, completed.accountId,
            { bindingAuthorityRevision: completed.bindingAuthorityRevision });
          localConverged = true;
          // Native login may be the first successful run after an upgrade.
          // Keep the directory endpoint current without making login depend
          // on a transient Accounts outage; startup retries the same signed
          // publication for already-bound instances.
          await publishOwnerAccountEndpoint().catch(() => {});
          await markOwnerAccountNativeJournal('device_promoted', {
            requestId,
            deviceId,
            accountId: completed.accountId,
            deviceAlias: alias,
            action: completed.action,
            bindingAuthorityRevision: completed.bindingAuthorityRevision,
            nativeCompletionId: completed.nativeCompletionId,
          });
          await markOwnerAccountNativeJournal('credential_issued', {
            requestId,
            deviceId,
            accountId: completed.accountId,
            deviceAlias: alias,
            action: completed.action,
            bindingAuthorityRevision: completed.bindingAuthorityRevision,
            nativeCompletionId: completed.nativeCompletionId,
          });
          // Local convergence is committed at this point. A cleanup failure
          // must leave the marker for recovery, never compensate a valid bound
          // device back to provisional.
          await clearOwnerAccountNativePending().catch(() => {});
          await clearOwnerAccountNativeJournal().catch(() => {});
          writeJson(res, 200, {
            ok: true,
            bound: true,
            mode: 'accounts',
            deviceState: completed.deviceState,
            deviceId: completed.deviceId,
            credential: { type: 'Bearer', ...converged.credential },
          });
          return true;
        } catch (error) {
          const completion = completed || error?.nativeCompletion;
          if (completion && !localConverged) {
            try {
              const rollback = await rollbackOwnerAccountNativeAuth({
                requestId,
                deviceId,
                deviceAlias: alias,
                accountId: completion.accountId,
                bindingAuthorityRevision: completion.bindingAuthorityRevision,
                nativeCompletionId: completion.nativeCompletionId,
              });
              if (!rollback?.rolledBack) throw new Error('Native convergence was superseded; retry is required.');
              if (completion.action === 'bind') await clearOwnerAccountBinding();
              await clearOwnerAccountNativePending();
              await clearOwnerAccountNativeJournal();
              error.code = 'owner_auth_convergence_failed';
              error.statusCode = 502;
            } catch (compensationError) {
              // Keep the durable pending marker. A later token submission can
              // retry central convergence or repeat this compensation.
              error.code = 'owner_auth_convergence_pending';
              error.statusCode = 503;
              error.retryable = true;
            }
          } else if (completion && localConverged) {
            // The device mutation already committed. Journal cleanup is a
            // recovery concern; never compensate a valid local bound state.
            error.code = 'owner_auth_convergence_pending';
            error.statusCode = 503;
            error.retryable = true;
          }
          throw error;
        }
      }
      throw new Error('Accounts owner authentication is not configured on this instance.');
    } catch (error) {
      writeJson(res, error?.statusCode || 502, {
        error: 'Google account binding failed.',
        code: error?.code || 'owner_auth_account_invalid',
      });
      return true;
    }
  }

  // 登录页探测：是否显示 Google 登录按钮
  if (path === '/api/auth/google/status' && req.method === 'GET') {
    if (!authSession && req.headers?.authorization) {
      await authenticateTrustedDeviceToken(req.headers.authorization.replace(/^Bearer\s+/i, '')).then((session) => {
        if (session) authSession = session;
      }).catch(() => {});
    }
    const ownerAuth = await resolveOwnerAuthMode(accountBroker);
    await recoverOwnerAccountNativePending().catch(() => {});
    const deviceId = trimString(authSession?.deviceId || authSession?.principalId);
    const device = deviceId ? await getTrustedDeviceStatus(deviceId) : null;
    const pending = await getOwnerAccountNativePending().catch(() => null);
    const pendingForDevice = Boolean(pending && (!deviceId || pending.deviceId === deviceId));
    const pendingPhase = pendingForDevice ? trimString(pending?.phase) : '';
    const pendingActive = pendingForDevice && !['credential_issued', 'completed'].includes(pendingPhase);
    const pendingDeviceState = ['device_promoted'].includes(pendingPhase)
      ? 'reconnect_required'
      : 'verifying';
    const deviceBound = device?.status === 'bound' || device?.status === 'legacy_trusted';
    writeJson(res, 200, {
      enabled: ownerAuth.enabled,
      bound: pendingActive ? false : (device ? deviceBound : ownerAuth.bound),
      mode: ownerAuth.mode,
      contractVersion: 2,
      capabilities: {
        nativeGoogleAuth: Boolean(ownerAuth.mode === 'accounts' && nativeGoogleAudienceConfigured),
        provisionalPairing: true,
        temporaryDeviceAccess: false,
        // Same-account device access is the normal path. QR is only the
        // explicit account-claim flow for an instance that is not bound yet.
        accountJoin: process.env.AGENTOC_ACCOUNT_JOIN_ENABLED !== '0' && ownerAuth.mode === 'accounts',
      },
      ...(device ? {
        deviceState: pendingActive ? pendingDeviceState : device.status,
        deviceId: device.id,
        ...(device.accountId ? { accountId: device.accountId } : {}),
        ...(device.temporaryExpiresAt ? { temporaryExpiresAt: device.temporaryExpiresAt } : {}),
      } : {}),
      ...(authSession && ownerAuth.accountBinding?.accountProfile
        ? { accountProfile: ownerAuth.accountBinding.accountProfile }
        : {}),
    });
    return true;
  }

  // 本机绑定历史（L1）：记录含邮箱等 PII，仅 owner 会话可查；
  // Accounts 模式改由 Accounts 服务按账号返回（不经过实例本地文件）
  if (path === '/api/auth/google/binding-history' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    if ((await resolveOwnerAuthMode(accountBroker)).mode === 'accounts') {
      try {
        const result = await getOwnerAccountBindingHistory();
        writeJson(res, 200, { entries: result.entries || [], mode: 'accounts' });
      } catch (error) {
        writeJson(res, error?.statusCode || 502, {
          error: 'Binding history is temporarily unavailable.',
          code: error?.code || 'owner_auth_failed',
        });
      }
      return true;
    }
    writeJson(res, 503, { error: 'Accounts owner authentication is not configured on this instance.', code: 'owner_auth_broker_not_configured' });
    return true;
  }

  // 跨设备绑定清单（L2）：本机 + 远程设备视图；Accounts 模式由
  // Accounts 服务统一维护 instance_bindings/devices（source=local|remote）
  if (path === '/api/auth/google/devices' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    if ((await resolveOwnerAuthMode(accountBroker)).mode === 'accounts') {
      try {
        const result = await listOwnerAccountDevices();
        writeJson(res, 200, { devices: result.devices || [], mode: 'accounts' });
      } catch (error) {
        writeJson(res, error?.statusCode || 502, {
          error: 'Device list is temporarily unavailable.',
          code: error?.code || 'owner_auth_failed',
        });
      }
      return true;
    }
    writeJson(res, 503, { error: 'Accounts owner authentication is not configured on this instance.', code: 'owner_auth_broker_not_configured' });
    return true;
  }

  // 解绑（owner-only）：Accounts 服务撤销 binding/device/历史并清空本机绑定。
  if (path === '/api/auth/google/unbind' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    if ((await resolveOwnerAuthMode(accountBroker)).mode === 'accounts') {
      try {
        const result = await unbindOwnerAccount();
        writeJson(res, 200, { ...result, mode: 'accounts' });
      } catch (error) {
        writeJson(res, error?.statusCode || 502, {
          error: 'Unbind failed.',
          code: error?.code || 'owner_auth_failed',
        });
      }
      return true;
    }
    writeJson(res, 503, { error: 'Accounts owner authentication is not configured on this instance.', code: 'owner_auth_broker_not_configured' });
    return true;
  }

  // 安全事务状态查询（契约 §5.3）：轮询等待页/前端只看到非敏感状态。
  // 公开端点，但响应只含 status/expiresAt/deliveryMode —— 即使被未授权访问
  // 也无法获得 accountId、grant、assertion 或可兑换 proof。
  const transactionStatus = /^\/api\/auth\/google\/transactions\/([^/]+)$/.exec(path);
  if (transactionStatus && req.method === 'GET') {
    const transactionId = decodeURIComponent(transactionStatus[1]);
    const status = await getOwnerAccountTransactionStatus(transactionId, { req });
    if (!status) {
      writeJson(res, 404, { error: 'Unknown owner authentication transaction.', code: 'owner_auth_transaction_invalid' });
      return true;
    }
    if (status.status === 'completed' && status.deliveryMode === 'instance_poll') {
      try {
        const handoff = await claimOwnerAccountPollSession({
          req,
          transactionId,
          issueSession,
        });
        if (handoff.sessionToken) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': [setCookie(handoff.sessionToken), clearOwnerAccountStateCookie()],
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({
            status: 'completed',
            expiresAt: status.expiresAt,
            deliveryMode: 'instance_poll',
          }));
          return true;
        }
      } catch (error) {
        writeJson(res, error?.statusCode || 502, {
          error: 'Google login handoff is temporarily unavailable.',
          code: error?.code || 'owner_auth_session_handoff_failed',
        });
        return true;
      }
    }
    writeJson(res, 200, status);
    return true;
  }

  return false;
}
