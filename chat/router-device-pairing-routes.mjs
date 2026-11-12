import { readBody } from '../lib/utils.mjs';
import {
  completeTrustedDeviceAccountIntent,
  createTrustedDeviceInvitation,
  createTrustedDeviceAccountIntent,
  getTrustedDeviceAccountIntent,
  listTrustedDevices,
  markTrustedDeviceAccountIntentRegistered,
  releaseTrustedDeviceAccountClaim,
  revokeTrustedDevice,
  updateTrustedDeviceEntryUrl,
} from './trusted-devices.mjs';
import {
  completeOwnerAccountJoinIntent,
  getOwnerAccountBinding,
  registerOwnerAccountJoinIntent,
} from '../lib/owner-account-auth.mjs';
import { getClientIp, checkDevicePublicRateLimit } from './middleware.mjs';
import { handleTemporaryPairingOwnerRoutes } from './router-temporary-pairing-routes.mjs';
import { handleAccountPairingOwnerRoutes } from './router-account-pairing-routes.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Account binding is the normal enrollment path. QR remains only as an
// explicit account-claim challenge for a computer that has no owner binding.
// Deployments may disable the broker explicitly, but absence of the variable
// must not force every new device back into scan-only pairing.
function accountJoinEnabled() {
  return process.env.AGENTOC_ACCOUNT_JOIN_ENABLED !== '0';
}

async function readJsonBody(req) {
  const body = await readBody(req, 256 * 1024);
  return body ? JSON.parse(body) : {};
}

export async function handleDevicePairingPublicRoutes({ req, res, pathname, writeJson }) {
  if (pathname === '/api/device-pairing/account-intents' && req.method === 'POST') {
    if (!accountJoinEnabled()) {
      writeJson(res, 409, { error: 'Account binding is disabled on this instance', code: 'account_join_disabled' });
      return true;
    }
    const rateLimit = checkDevicePublicRateLimit(getClientIp(req));
    if (rateLimit.exceeded) {
      writeJson(res, 429, { error: 'Too many requests', retryAfterMs: rateLimit.retryAfterMs, code: 'owner_auth_rate_limited' });
      return true;
    }
    try {
      const payload = await readJsonBody(req);
      const accountClaimToken = trimString(payload?.accountClaimToken);
      // A computer without an owner binding cannot be claimed merely by
      // knowing its endpoint. It must receive a fresh one-time QR challenge.
      // Bound computers retain the QR-free same-account join path.
      if (!accountClaimToken && !await getOwnerAccountBinding()) {
        writeJson(res, 409, {
          error: 'This computer needs a one-time account-claim code',
          code: 'account_claim_required',
        });
        return true;
      }
      const intent = await createTrustedDeviceAccountIntent({
        devicePublicKey: payload?.devicePublicKey,
        deviceName: payload?.deviceName,
        computerAlias: payload?.computerAlias,
        platform: payload?.platform,
        // Account rendezvous is the only discovery mechanism.  A local or
        // public endpoint is never required or published for a join intent.
        publicEndpoint: '',
        accountClaimToken,
        renewExistingDeviceId: payload?.renewExistingDeviceId,
      });
      try {
        await registerOwnerAccountJoinIntent({ intent });
      } catch (error) {
        await releaseTrustedDeviceAccountClaim(intent.intentId);
        throw error;
      }
      await markTrustedDeviceAccountIntentRegistered(intent.intentId);
      writeJson(res, 201, {
        intent: {
          intentId: intent.intentId,
          instanceId: intent.instance.instanceId,
          deviceId: intent.deviceId,
          devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint,
          nonce: intent.nonce,
          issuedAt: intent.issuedAt,
          expiresAt: intent.expiresAt,
          instance: intent.instance,
          instanceSignature: intent.signature,
          deviceName: intent.deviceName,
          computerAlias: intent.computerAlias,
          platform: intent.platform,
        },
      });
    } catch (error) {
      writeJson(res, error?.statusCode || 502, {
        error: error.message || 'Failed to create account join intent',
        code: error?.code || 'owner_auth_broker_unavailable',
      });
    }
    return true;
  }

  const accountIntentComplete = /^\/api\/device-pairing\/account-intents\/([^/]+)\/complete$/.exec(pathname);
  if (accountIntentComplete && req.method === 'POST') {
    if (!accountJoinEnabled()) {
      writeJson(res, 409, { error: 'Account binding is disabled on this instance', code: 'account_join_disabled' });
      return true;
    }
    const rateLimit = checkDevicePublicRateLimit(getClientIp(req));
    if (rateLimit.exceeded) {
      writeJson(res, 429, { error: 'Too many requests', retryAfterMs: rateLimit.retryAfterMs, code: 'owner_auth_rate_limited' });
      return true;
    }
    try {
      const intentId = decodeURIComponent(accountIntentComplete[1]);
      const intent = await getTrustedDeviceAccountIntent(intentId);
      if (!intent) {
        writeJson(res, 410, { error: 'Account join intent is expired or unknown', code: 'owner_auth_account_intent_expired' });
        return true;
      }
      const payload = await readJsonBody(req);
      const requestId = trimString(req.headers?.['idempotency-key']);
      const completionIntent = { ...intent, nonce: trimString(payload?.nonce) };
      const completed = await completeOwnerAccountJoinIntent({
        intent: completionIntent,
        idToken: payload?.idToken,
        accountJoinGrant: payload?.accountJoinGrant,
        deviceSignature: payload?.deviceSignature,
        requestId,
      });
      const local = await completeTrustedDeviceAccountIntent({
        intentId,
        deviceSignature: payload?.deviceSignature,
        accountId: completed.accountId,
        bindingAuthorityRevision: completed.bindingAuthorityRevision,
        workspaceAccess: completed.workspaceAccess,
        requestId,
        verifiedAccountCompletion: true,
      });
      writeJson(res, 200, {
        ok: true,
        bound: true,
        mode: 'accounts',
        intentId,
        deviceState: 'bound',
        deviceId: intent.deviceId,
        credential: { type: 'Bearer', ...local.credential },
      });
    } catch (error) {
      writeJson(res, error?.statusCode || 502, {
        error: error.message || 'Failed to complete account join intent',
        code: error?.code || 'owner_auth_broker_unavailable',
      });
    }
    return true;
  }

  return false;
}

export async function handleDevicePairingOwnerRoutes({ req, res, pathname, authSession, writeJson }) {
  if (await handleTemporaryPairingOwnerRoutes({ req, res, pathname, authSession, writeJson })) return true;
  if (await handleAccountPairingOwnerRoutes({ req, res, pathname, authSession, writeJson })) return true;
  const trustedDevice = authSession?.principalKind === 'trusted_device';
  if (pathname === '/api/device-pairing/invitations' && req.method === 'POST') {
    if (trustedDevice) {
      writeJson(res, 403, { error: 'Trusted devices cannot create pairing invitations' });
      return true;
    }
    try {
      const payload = await readJsonBody(req);
      if (await getOwnerAccountBinding()) {
        if (authSession?.role !== 'owner' || (authSession.principalKind && authSession.principalKind !== 'owner')) {
          writeJson(res, 403, { code: 'account_pairing_owner_required' }); return true;
        }
        const { getAccountPairingService } = await import('./account-pairing-service.mjs');
        const service = await getAccountPairingService();
        writeJson(res, 201, { invitation: await service.create() });
        return true;
      }
      const result = await createTrustedDeviceInvitation({
        protocolVersion: Number(payload?.protocolVersion),
        ttlMs: Number(payload?.ttlMs),
      });
      writeJson(res, 201, { invitation: result });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to create pairing invitation' });
    }
    return true;
  }

  if (pathname === '/api/device-pairing/devices' && req.method === 'GET') {
    writeJson(res, 200, await listTrustedDevices());
    return true;
  }

  // 设备入口地址登记（入口切换 M3）：owner-only，空 entryUrl = 清除
  const entryUrlMatch = /^\/api\/device-pairing\/devices\/([^/]+)\/entry-url$/.exec(pathname);
  if (entryUrlMatch && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    if (trustedDevice) {
      writeJson(res, 403, { error: 'Trusted devices cannot update device entry URLs' });
      return true;
    }
    try {
      const payload = await readJsonBody(req);
      const device = await updateTrustedDeviceEntryUrl(
        decodeURIComponent(entryUrlMatch[1]),
        trimString(payload?.entryUrl),
      );
      writeJson(res, 200, { device });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to update device entry URL' });
    }
    return true;
  }

  const revokeMatch = /^\/api\/device-pairing\/devices\/([^/]+)\/revoke$/.exec(pathname);
  if (revokeMatch && req.method === 'POST') {
    if (trustedDevice) {
      writeJson(res, 403, { error: 'Trusted devices cannot revoke device principals' });
      return true;
    }
    try {
      const device = await revokeTrustedDevice(decodeURIComponent(revokeMatch[1]));
      writeJson(res, 200, { device });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to revoke trusted device' });
    }
    return true;
  }

  return false;
}
