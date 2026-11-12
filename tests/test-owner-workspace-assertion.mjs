import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyAccountAssertion } from '../lib/owner-account-auth.mjs';

test('shared account claims require a signed owner, exact grant and binding revision', () => {
  const keys = generateKeyPairSync('ed25519'), kid = 'test-workspace-signing';
  const jwks = { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid }] };
  const now = Date.parse('2026-11-12T00:00:00Z');
  const opts = { accountIssuer: 'https://ragent.agentoncloud.com', instanceId: 'inst_workspace_test', purpose: 'account_join',
    transactionId: 'request_workspace_join_001', deviceId: 'device_workspace_test', expectedIntentId: 'intent_workspace_test',
    devicePublicKeyFingerprint: 'a'.repeat(64), clock: () => now };
  const claims = { iss: opts.accountIssuer, aud: opts.instanceId, sub: 'acct_workspace_member', purpose: opts.purpose,
    tx: opts.transactionId, deviceId: opts.deviceId, devicePublicKeyFingerprint: opts.devicePublicKeyFingerprint,
    intentId: opts.expectedIntentId, iat: now / 1000, exp: now / 1000 + 60, bindingAuthorityRevision: '4',
    workspaceAccess: { ownerAccountId: 'acct_workspace_owner', grantId: 'iag_' + 'a'.repeat(24) } };
  function jwt(value, key = keys.privateKey) {
    const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })).toString('base64url');
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = `${head}.${body}`;
    return `${message}.${sign(null, Buffer.from(message), key).toString('base64url')}`;
  }
  assert.deepEqual(verifyAccountAssertion(jwt(claims), jwks, opts).workspaceAccess, claims.workspaceAccess);
  for (const altered of [
    { ...claims, bindingAuthorityRevision: undefined },
    { ...claims, bindingAuthorityRevision: '0' },
    { ...claims, workspaceAccess: { ...claims.workspaceAccess, ownerAccountId: claims.sub } },
    { ...claims, sub: ` ${claims.workspaceAccess.ownerAccountId} ` },
    { ...claims, workspaceAccess: { ...claims.workspaceAccess, ownerAccountId: 12345678 } },
    { ...claims, workspaceAccess: { ...claims.workspaceAccess, grantId: 'short' } },
    { ...claims, workspaceAccess: { ...claims.workspaceAccess, extra: true } },
    { ...claims, workspaceAccess: null },
  ]) assert.throws(() => verifyAccountAssertion(jwt(altered), jwks, opts), { code: 'owner_auth_assertion_invalid' });
  assert.throws(() => verifyAccountAssertion(jwt(claims, generateKeyPairSync('ed25519').privateKey), jwks, opts),
    { code: 'owner_auth_assertion_invalid' });
  const wrongPurpose = { ...claims, purpose: 'native' };
  assert.throws(() => verifyAccountAssertion(jwt(wrongPurpose), jwks, { ...opts, purpose: 'native' }),
    { code: 'owner_auth_assertion_invalid' });
  const legacy = { ...claims }; delete legacy.workspaceAccess;
  assert.equal(verifyAccountAssertion(jwt(legacy), jwks, opts).workspaceAccess, undefined);
});
