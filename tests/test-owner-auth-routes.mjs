#!/usr/bin/env node
import assert from 'assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import http from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const testedRoot = process.env.AGENTOC_ACCOUNTS_TEST_RELEASE_ROOT || repoRoot;
const home = mkdtempSync(join(tmpdir(), 'agentoc-owner-auth-routes-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.AGENTOC_INSTANCE_ROOT;

const { createOwnerAuthBroker } = await import(pathToFileURL(join(testedRoot, 'accounts', 'owner-auth-broker.mjs')).href);
const { handleOwnerAuthRoutes } = await import(pathToFileURL(join(testedRoot, 'accounts', 'owner-auth-routes.mjs')).href);
const {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signInstanceProof,
  signOwnerAuthDeviceProof,
  signOwnerAuthPollProof,
  signAccountFileUploadQuotaProof,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'instance-identity.mjs')).href);
const { createTurnConnectionId } = await import(pathToFileURL(join(testedRoot, 'lib', 'turn-authorization.mjs')).href);
const { createDevicePublicKeyFingerprint, normalizeDevicePublicKey } = await import(pathToFileURL(join(testedRoot, 'lib', 'device-auth-protocol.mjs')).href);

const identity = await loadOrCreateInstanceIdentity();
let state = {};
const store = { mutate: async (mutator) => mutator(state) };
const broker = createOwnerAuthBroker({
  store,
  allowInsecureReturnUrl: true,
  verifyGoogleCredential: async ({ idToken, nonce }) => {
    assert.equal(idToken, 'google-id-token');
    assert.match(nonce, /^nonce_/);
    return { providerSubject: 'google-subject-1' };
  },
  verifyNativeGoogleCredential: async ({ idToken }) => {
    assert.equal(idToken, 'google-id-token');
    return { providerSubject: 'google-subject-1' };
  },
  resolveAccount: async () => ({ accountId: 'acct_owner_1' }),
  signAssertion: async (claims) => `assertion:${claims.sub}:${claims.aud}:${claims.tx}`,
  signTurnBrokerCapability: async (claims) => `turn-capability:${claims.accountId}:${claims.connectionId}`,
});

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function transactionProof({ transactionId, returnUrl, purpose = 'bind' }) {
  const issuedAt = new Date().toISOString();
  const signature = signInstanceProof(identity, {
    transactionId, purpose, returnUrl, issuedAt, audience: 'agentoc-owner-auth',
  });
  return {
    transactionId, purpose, returnUrl,
    instance: publicInstanceIdentity(identity),
    issuedAt, audience: 'agentoc-owner-auth', signature: signature.signature,
  };
}

let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`ok - ${name}`);
}

const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  const handled = await handleOwnerAuthRoutes({
    req, res, pathname: req.url || '/', broker,
    publicBaseUrl: `http://127.0.0.1:${port}/accounts`,
    googleWebClientId: 'google-web-client-id.apps.googleusercontent.com',
    allowInsecurePublicBaseUrl: true,
  });
  if (!handled) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  }
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const transactionId = 'tx_route_1';
  const returnUrl = `http://instance.example.test/api/auth/google/complete?tx=${transactionId}`;
  const started = await request(port, 'POST', '/accounts/v1/owner-auth/transactions', transactionProof({ transactionId, returnUrl }));
  check('Accounts route 创建签名事务', started.status === 201 && started.json?.transactionId === transactionId);
  check('Accounts route 只给出受控 origin/path 的登录页', started.json?.authUrl?.startsWith(`http://127.0.0.1:${port}/accounts/owner/google?`) === true);

  const stripped = await request(port, 'POST', '/v1/owner-auth/transactions', transactionProof({ transactionId: 'tx_route_stripped', returnUrl }));
  check('反代剥掉前缀后路由仍可访问', stripped.status === 201 && stripped.json?.transactionId === 'tx_route_stripped');
  check('剥前缀响应仍构造带前缀的外部 URL', stripped.json?.authUrl?.startsWith(`http://127.0.0.1:${port}/accounts/owner/google?`) === true);

  const pageUrl = new URL(started.json.authUrl);
  const page = await request(port, 'GET', `${pageUrl.pathname}${pageUrl.search}`);
  const desktopCookie = String(page.headers['set-cookie']?.[0] || '').split(';')[0];
  const desktopCsrfCookie = String(page.headers['set-cookie']?.[1] || '').split(';')[0];
  check('登录页使用无缓存、拒绝 frame 且不暴露 bootstrap', page.status === 200
    && page.headers['cache-control']?.includes('no-store')
    && page.headers['x-frame-options'] === 'DENY'
    && !page.text.includes(started.json.bootstrap || 'not-returned'));
  check('电脑页有独立 state cookie、二维码和显式手机链接按钮', /^agentoc_owner_broker_state_[a-f0-9]{24}=/.test(desktopCookie)
    && /^agentoc_owner_broker_csrf_[a-f0-9]{24}=/.test(desktopCsrfCookie)
    && page.text.includes('手机就在此页？直接继续登录')
    && page.text.includes('QrCreator'));

  const replayPage = await request(port, 'GET', `${pageUrl.pathname}${pageUrl.search}`);
  const firstPhoneUrl = /id="ownerAuthContinue" href="([^"]+)"/.exec(page.text)?.[1] || '';
  const replayPhoneUrl = /id="ownerAuthContinue" href="([^"]+)"/.exec(replayPage.text)?.[1] || '';
  const firstGrant = /const deliveryGrant = "([^"]+)"/.exec(page.text)?.[1] || '';
  const replayGrant = /const deliveryGrant = "([^"]+)"/.exec(replayPage.text)?.[1] || '';
  check('重复打开同一桌面授权 URL 可幂等恢复', replayPage.status === 200
    && firstPhoneUrl === replayPhoneUrl
    && firstGrant.startsWith('grant_')
    && replayGrant === firstGrant);

  const phoneMatch = /id="ownerAuthContinue" href="([^"]+)"/.exec(page.text);
  const grantMatch = /const deliveryGrant = "([^"]+)"/.exec(page.text);
  check('电脑页只在自己的 HTML 中保留短时 delivery grant', Boolean(phoneMatch?.[1]) && /^grant_/.test(grantMatch?.[1] || ''));
  const phoneUrl = new URL(phoneMatch[1]);
  const phonePage = await request(port, 'GET', `${phoneUrl.pathname}${phoneUrl.search}`);
  const phoneCookie = String(phonePage.headers['set-cookie']?.[0] || '').split(';')[0];
  const phoneCsrfCookie = String(phonePage.headers['set-cookie']?.[1] || '').split(';')[0];
  check('电脑和手机的 state/CSRF Cookie 均保留完整十五分钟登录窗口',
    [...page.headers['set-cookie'], ...phonePage.headers['set-cookie']].every((cookie) =>
      cookie.includes('Max-Age=900') && cookie.includes('Secure') && cookie.includes('SameSite=Lax')));
  check('手机链接打开受控 GIS 页面并设置独立 phone state', phonePage.status === 200
    && /^agentoc_owner_broker_phone_state_[a-f0-9]{24}=/.test(phoneCookie)
    && /^agentoc_owner_broker_phone_csrf_[a-f0-9]{24}=/.test(phoneCsrfCookie)
    && phonePage.text.includes('google-web-client-id.apps.googleusercontent.com')
    && phonePage.text.includes('id="google-gsi-client"')
    && phonePage.text.indexOf('id="google-gsi-client"') < phonePage.text.indexOf('addEventListener(\'load\', initialize')
    && phonePage.text.includes("addEventListener('load', initialize")
    && phonePage.text.includes('  initialize();')
    && !phonePage.text.includes('onload="window.agentocGoogleIdentityReady'));
  check('GIS 失败页保留稳定 Accounts 拒绝码', phonePage.text.includes('owner_auth_account_invalid')
    && phonePage.text.includes('owner_auth_csrf_invalid')
    && phonePage.text.includes('credentialErrorMessage'));

  const phoneReplayWithoutCookie = await request(port, 'GET', `${phoneUrl.pathname}${phoneUrl.search}`);
  check('同一手机授权链接在 cookie 尚未落地时仍可幂等恢复', phoneReplayWithoutCookie.status === 200
    && phoneReplayWithoutCookie.text.includes('id="google-gsi-client"'));

  const phoneReplay = await request(port, 'GET', `${phoneUrl.pathname}${phoneUrl.search}`, undefined, {
    cookie: `${phoneCookie}; ${phoneCsrfCookie}`,
  });
  check('同一浏览器刷新手机授权页可幂等恢复', phoneReplay.status === 200
    && phoneReplay.text.includes('id="google-gsi-client"'));

  const pending = await request(port, 'GET', `/accounts/v1/owner-auth/transactions/${transactionId}/desktop-status`, undefined, { cookie: desktopCookie });
  check('电脑在手机完成前只能看到 pending 状态', pending.status === 200 && pending.json?.status === 'pending');

  const csrfRejected = await request(
    port,
    'POST',
    `/accounts/v1/owner-auth/transactions/${transactionId}/phone-google-credential`,
    { idToken: 'google-id-token' },
    { cookie: phoneCookie },
  );
  check('缺失同源双提交 CSRF 时拒绝 GIS credential', csrfRejected.status === 403 && csrfRejected.json?.code === 'owner_auth_csrf_invalid');

  const credential = await request(
    port,
    'POST',
    `/accounts/v1/owner-auth/transactions/${transactionId}/phone-google-credential`,
    { idToken: 'google-id-token' },
    {
      cookie: `${phoneCookie}; ${phoneCsrfCookie}`,
      origin: `http://127.0.0.1:${port}`,
      'x-agentoc-csrf': phoneCsrfCookie.split('=').slice(1).join('='),
    },
  );
  check('手机完成 GIS credential 后不返回 grant，只显示完成页', credential.status === 200
    && credential.json?.completeUrl?.startsWith(`http://127.0.0.1:${port}/accounts/owner/google/phone-complete?`) === true
    && !credential.text.includes('google-id-token'));

  const completed = await request(port, 'GET', `/accounts/v1/owner-auth/transactions/${transactionId}/desktop-status`, undefined, { cookie: desktopCookie });
  check('只有原电脑 state 能领取实例回跳地址，响应不暴露 grant', completed.status === 200
    && completed.json?.status === 'completed'
    && completed.json?.returnUrl === returnUrl
    && !Object.hasOwn(completed.json || {}, 'grant'));

  const redeemed = await request(port, 'POST', `/accounts/v1/owner-auth/transactions/${transactionId}/redeem`, {
    ...transactionProof({ transactionId, returnUrl }),
    grant: grantMatch[1],
  });
  check('仅原实例签名可兑换 Accounts 断言', redeemed.status === 200 && redeemed.json?.assertion?.startsWith('assertion:acct_owner_1:inst_'));

  const rejected = await request(port, 'POST', `/accounts/v1/owner-auth/transactions/${transactionId}/redeem`, {
    ...transactionProof({ transactionId, returnUrl }),
    grant: grantMatch[1],
  });
  check('grant 只能兑换一次', rejected.status === 410 && rejected.json?.code === 'owner_auth_grant_invalid');

  const discovered = await request(port, 'POST', '/accounts/v1/owner-auth/discovery', {
    idToken: 'google-id-token',
  });
  check('同账号发现路由返回可接管实例且不返回 token', discovered.status === 200
    && discovered.json?.instances?.some((item) => item.endpoint === 'http://instance.example.test')
    && !discovered.text.includes('google-id-token'));

  const identityIssuedAt = new Date().toISOString();
  const identityProof = signOwnerAuthDeviceProof(identity, {
    transactionId: 'op_route_identity_1',
    purpose: 'publish-identity',
    issuedAt: identityIssuedAt,
    audience: 'agentoc-owner-auth-device',
  });
  const identityPublished = await request(port, 'POST', '/accounts/v1/owner-auth/devices/acct_owner_1/identity', {
    transactionId: 'op_route_identity_1',
    purpose: 'publish-identity',
    instance: publicInstanceIdentity(identity),
    issuedAt: identityIssuedAt,
    audience: 'agentoc-owner-auth-device',
    signature: identityProof.signature,
  });
  check('实例身份发布路由不要求公网 endpoint', identityPublished.status === 200
    && identityPublished.json?.instanceId === identity.instanceId
    && identityPublished.json?.instanceKeyFingerprint === identity.keyFingerprint);

  const unauthenticatedDirectory = await request(port, 'GET', '/accounts/v1/owner-auth/account/devices');
  check('账号设备目录路由要求 Accounts bearer', unauthenticatedDirectory.status === 401
    && unauthenticatedDirectory.json?.code === 'owner_auth_account_credential_invalid');

  const routeDeviceKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const routeDevicePublicKey = routeDeviceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const routeDeviceKeyId = normalizeDevicePublicKey(routeDevicePublicKey).keyId;
  const routeDeviceId = 'adev_route_logout_1';
  const routeCredential = `rac_${'r'.repeat(32)}`;
  const routeStamp = new Date(Date.now()).toISOString();
  state.accountDevices = [{
    deviceId: routeDeviceId, accountId: 'acct_owner_1', alias: 'Android-ROUTE123', platform: 'android',
    createdAt: routeStamp, lastSeenAt: routeStamp, unboundAt: '', revokedAt: '',
  }];
  state.accountDeviceKeys = [{
    keyId: routeDeviceKeyId, accountId: 'acct_owner_1', deviceId: routeDeviceId,
    publicKey: routeDevicePublicKey, fingerprint: createDevicePublicKeyFingerprint(routeDevicePublicKey),
    createdAt: routeStamp, revokedAt: '',
  }];
  state.accountCredentials = [{
    credentialId: 'racid_route_logout_1', tokenHash: createHash('sha256').update(routeCredential).digest('hex'),
    accountId: 'acct_owner_1', deviceId: routeDeviceId, keyId: routeDeviceKeyId, scope: 'account-directory',
    issuedAt: routeStamp, expiresAt: new Date(Date.now() + 86400000).toISOString(), revokedAt: '', lastUsedAt: routeStamp,
  }];
  const routeLogout = await request(port, 'POST', '/accounts/v1/owner-auth/account/session/logout',
    { requestId: 'route-logout-request-0001' }, { authorization: `Bearer ${routeCredential}` });
  check('账号 logout 路由删除账号设备关联及旧凭据', routeLogout.status === 200
    && routeLogout.json?.loggedOut === true
    && !state.accountCredentials.some((item) => item.deviceId === routeDeviceId)
    && !state.accountDevices.some((item) => item.deviceId === routeDeviceId));

  // ---------- instance_poll：无公网实例主动领取 ----------
  const pollTx = 'tx_route_poll_1';
  const pollStartProof = (() => {
    const issuedAt = new Date().toISOString();
    const signature = signInstanceProof(identity, {
      transactionId: pollTx, purpose: 'bind', returnUrl: '', issuedAt, audience: 'agentoc-owner-auth-poll',
    });
    return {
      transactionId: pollTx, purpose: 'bind', deliveryMode: 'instance_poll',
      instance: publicInstanceIdentity(identity), issuedAt, audience: 'agentoc-owner-auth-poll',
      signature: signature.signature,
    };
  })();
  const pollStarted = await request(port, 'POST', '/accounts/v1/owner-auth/transactions', pollStartProof);
  check('instance_poll 事务创建成功且不要求 returnUrl', pollStarted.status === 201
    && pollStarted.json?.transactionId === pollTx
    && pollStarted.json?.deliveryMode === 'instance_poll');

  const pollPageUrl = new URL(pollStarted.json.authUrl);
  const pollPage = await request(port, 'GET', `${pollPageUrl.pathname}${pollPageUrl.search}`);
  const pollGrantMatch = /const deliveryGrant = "([^"]+)"/.exec(pollPage.text);
  check('poll 模式桌面页不包含 delivery grant', pollPage.status === 200
    && pollGrantMatch === null
    && pollPage.text.includes('电脑会自动完成登录')
    && !pollPage.text.includes('sessionStorage'));

  const pollPhoneUrl = /id="ownerAuthContinue" href="([^"]+)"/.exec(pollPage.text);
  const pollPhonePage = await request(port, 'GET', new URL(pollPhoneUrl[1], `http://127.0.0.1:${port}`).pathname + new URL(pollPhoneUrl[1]).search);
  const pollPhoneCookie = String(pollPhonePage.headers['set-cookie']?.[0] || '').split(';')[0];
  const pollPhoneCsrf = String(pollPhonePage.headers['set-cookie']?.[1] || '').split(';')[0];
  const pollCredential = await request(port, 'POST', `/accounts/v1/owner-auth/transactions/${pollTx}/phone-google-credential`, {
    idToken: 'google-id-token',
  }, {
    cookie: `${pollPhoneCookie}; ${pollPhoneCsrf}`,
    origin: `http://127.0.0.1:${port}`,
    'x-agentoc-csrf': pollPhoneCsrf.split('=').slice(1).join('='),
  });
  check('poll 模式手机仍可完成 GIS credential', pollCredential.status === 200 && !pollCredential.text.includes('google-id-token'));

  const pollDesktopCookie = String(pollPage.headers['set-cookie']?.[0] || '').split(';')[0];
  const pollStatus = await request(port, 'GET', `/accounts/v1/owner-auth/transactions/${pollTx}/desktop-status`, undefined, { cookie: pollDesktopCookie });
  check('poll 模式桌面状态 completed 不返回 returnUrl', pollStatus.status === 200
    && pollStatus.json?.status === 'completed'
    && pollStatus.json?.deliveryMode === 'instance_poll'
    && !Object.hasOwn(pollStatus.json || {}, 'transactionId')
    && !Object.hasOwn(pollStatus.json || {}, 'returnUrl'));

  const pollRedeemPath = `/accounts/v1/owner-auth/transactions/${pollTx}/instance-redeem`;
  function pollProof(requestId = 'opll_route_1') {
    const issuedAt = new Date().toISOString();
    const signature = signOwnerAuthPollProof(identity, {
      transactionId: pollTx, requestId, purpose: 'bind', deliveryMode: 'instance_poll',
      issuedAt, requestPath: `/v1/owner-auth/transactions/${pollTx}/instance-redeem`,
    });
    return {
      requestId, purpose: 'bind', deliveryMode: 'instance_poll',
      instance: publicInstanceIdentity(identity), issuedAt,
      audience: 'agentoc-owner-auth-poll', signature: signature.signature,
    };
  }
  const pollRedeemed = await request(port, 'POST', pollRedeemPath, pollProof());
  check('instance-redeem 路由返回完成断言', pollRedeemed.status === 200
    && pollRedeemed.json?.status === 'completed'
    && pollRedeemed.json?.assertion?.startsWith('assertion:acct_owner_1:'));

  const pollReplay = await request(port, 'POST', pollRedeemPath, pollProof());
  check('instance-redeem 同 requestId 幂等重放同一断言', pollReplay.status === 200
    && pollReplay.json?.assertion === pollRedeemed.json?.assertion);

  const callbackBlocked = await request(port, 'POST', `/accounts/v1/owner-auth/transactions/${transactionId}/instance-redeem`, (() => {
    const issuedAt = new Date().toISOString();
    const signature = signOwnerAuthPollProof(identity, {
      transactionId, requestId: 'opll_cb_1', purpose: 'bind', deliveryMode: 'instance_poll',
      issuedAt, requestPath: `/v1/owner-auth/transactions/${transactionId}/instance-redeem`,
    });
    return {
      requestId: 'opll_cb_1', purpose: 'bind', deliveryMode: 'instance_poll',
      instance: publicInstanceIdentity(identity), issuedAt,
      audience: 'agentoc-owner-auth-poll', signature: signature.signature,
    };
  })());
  check('callback 事务访问 instance-redeem 被 delivery mode 拒绝', callbackBlocked.status === 409
    && callbackBlocked.json?.code === 'owner_auth_delivery_mode_mismatch');

  const connectionId = createTurnConnectionId({
    accountId: 'acct_owner_1',
    instanceId: identity.instanceId,
    deviceId: identity.instanceId,
  });
  function connectionProof(purpose) {
    const issuedAt = new Date().toISOString();
    const signature = signOwnerAuthDeviceProof(identity, {
      transactionId: connectionId,
      purpose,
      issuedAt,
      audience: 'agentoc-owner-auth-device',
    });
    return {
      requestId: connectionId,
      accountId: 'acct_owner_1',
      deviceId: identity.instanceId,
      deviceKind: 'computer',
      connectionId,
      instance: publicInstanceIdentity(identity),
      issuedAt,
      audience: 'agentoc-owner-auth-device',
      signature: signature.signature,
    };
  }
  const reserved = await request(port, 'POST', '/accounts/v1/owner-auth/turn/connections/reserve', {
    ...connectionProof('turn-reserve'),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  check('TURN connection reserve route 返回连接授权', reserved.status === 201
    && reserved.json?.authorization?.authorized === true
    && reserved.json?.authorization?.activeComputers === 1
    && reserved.json?.brokerCredential?.scope === 'turn:mint'
    && reserved.json?.brokerCredential?.connectionId === connectionId
    && reserved.json?.brokerCredential?.token === `turn-capability:acct_owner_1:${connectionId}`);
  const releasedConnection = await request(port, 'POST', '/accounts/v1/owner-auth/turn/connections/release', {
    ...connectionProof('turn-release'),
    reason: 'route-test',
  });
  check('TURN connection release route 释放租约', releasedConnection.status === 200
    && releasedConnection.json?.released === true);

  function fileQuotaProof(operation, requestId, quotaBatchId, sizeBytes, sha256) {
    const issuedAt = new Date().toISOString();
    const fields = { accountId: 'acct_owner_1', operation, requestId, quotaBatchId, sizeBytes, sha256,
      issuedAt, audience: 'agentoc-account-file-upload' };
    const signature = signAccountFileUploadQuotaProof(identity, fields);
    return { ...fields, instance: publicInstanceIdentity(identity), signature: signature.signature };
  }
  const quotaFirst = await request(port, 'POST', '/accounts/v1/owner-auth/instances/uploads/reserve',
    fileQuotaProof('reserve', 'file-quota-a', 'message-quota-a', 50 * 1024 * 1024, 'a'.repeat(64)));
  const quotaSecond = await request(port, 'POST', '/accounts/v1/owner-auth/instances/uploads/reserve',
    fileQuotaProof('reserve', 'file-quota-b', 'message-quota-a', 50 * 1024 * 1024, 'b'.repeat(64)));
  const quotaOver = await request(port, 'POST', '/accounts/v1/owner-auth/instances/uploads/reserve',
    fileQuotaProof('reserve', 'file-quota-c', 'message-quota-a', 1, 'c'.repeat(64)));
  const quotaNextMessage = await request(port, 'POST', '/accounts/v1/owner-auth/instances/uploads/reserve',
    fileQuotaProof('reserve', 'file-quota-d', 'message-quota-next', 50 * 1024 * 1024, 'd'.repeat(64)));
  const quotaNextMessageSecond = await request(port, 'POST', '/accounts/v1/owner-auth/instances/uploads/reserve',
    fileQuotaProof('reserve', 'file-quota-e', 'message-quota-next', 50 * 1024 * 1024, 'e'.repeat(64)));
  check('免费档文件额度路由按签名消息批次跨设备累计，并独立重置到后续消息', quotaFirst.status === 200
    && quotaFirst.json?.reservedBytes === 50 * 1024 * 1024
    && quotaSecond.status === 200 && quotaSecond.json?.reservedBytes === 100 * 1024 * 1024
    && quotaOver.status === 429 && quotaOver.json?.code === 'account_file_upload_total_limit'
    && quotaNextMessage.status === 200 && quotaNextMessage.json?.reservedBytes === 50 * 1024 * 1024
    && quotaNextMessageSecond.status === 200 && quotaNextMessageSecond.json?.reservedBytes === 100 * 1024 * 1024);

  console.log(`test-owner-auth-routes: ${passed} assertions passed`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}
