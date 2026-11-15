import { readProotAccountLink } from '../lib/proot-account-link-state.mjs';
import { buildDesktopAccountSessionAuthorization } from '../lib/device-auth-protocol.mjs';
import { signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { accountPairingError } from '../lib/account-pairing-client.mjs';

export class AccountPairingService {
  constructor({ identity, client, binding, createInvitation, getInvitation, consumeInvitation, listPendingInvitations = async () => [], clock = Date.now }) {
    Object.assign(this, { identity, client, binding, createInvitation, getInvitation, consumeInvitation, listPendingInvitations, clock });
    this.operations = new Map();
  }
  async create(localLink = null) {
    if (process.env.RAGENT_RUNTIME_MODE === 'proot' && readProotAccountLink().state === 'signed_out') throw accountPairingError('account_pairing_source_signed_out', 409);
    if (process.env.RAGENT_RUNTIME_MODE === 'proot' && readProotAccountLink().state === 'login_pending' && !localLink) throw accountPairingError('account_pairing_source_changed', 409);
    const binding = await this.binding();
    if (!binding?.accountId) throw accountPairingError('account_pairing_source_unbound', 409);
    // Creating this short-lived QR is the Owner consent to authorize its scanner.
    // Persist that consent only for this account and this particular invitation.
    const generation = process.env.RAGENT_RUNTIME_MODE === 'proot' ? readProotAccountLink().generation : null;
    const invitation = await this.createInvitation({ ttlMs: 120_000, accountHandoffAccountId: binding.accountId,
      ...(generation !== null ? { localLinkGeneration: generation } : {}),
      ...(localLink ? { localLinkId: localLink.linkId, localLinkGeneration: localLink.generation, localDeviceFingerprint: localLink.fingerprint } : {}) });
    const local = await this.getInvitation(invitation.id);
    try { await this.client.request('register', invitation.id, { tokenHash: local.tokenHash, expiresAt: Date.parse(invitation.expiresAt) }); }
    catch (error) { await this.consumeInvitation(invitation.id); throw error; }
    const uri = new URL(invitation.pairingUri); uri.searchParams.set('v', '4'); uri.searchParams.set('q', invitation.id);
    // A namespace hint selects the phone's local enrollment identity only.
    // Accounts independently checks it against the signed desktop's binding.
    uri.searchParams.set('accountType', binding.accountId.startsWith('acct_demo_') ? 'demo' : 'google');
    return { ...invitation, pairingUri: uri.toString(), accountHandoff: true };
  }
  async status(id) {
    const local = await this.getInvitation(id);
    if (!local || Date.parse(local.expiresAt) <= this.clock()) throw accountPairingError('account_pairing_inactive', 410);
    return this.client.request('inbox', id);
  }
  approve(id) { return this.serialize(id, () => this.approveClaim(id)); }
  async approveClaim(id) {
    if (process.env.RAGENT_RUNTIME_MODE === 'proot' && readProotAccountLink().state === 'signed_out') throw accountPairingError('account_pairing_source_signed_out', 409);
    const current = await this.status(id);
    if (current.status === 'APPROVED') { await this.consumeInvitation(id); return current; }
    if (!current.claim || current.status !== 'CLAIMED') throw accountPairingError('account_pairing_not_claimed', 409);
    const binding = await this.binding();
    if (!binding?.accountId) throw accountPairingError('account_pairing_source_unbound', 409);
    const local = await this.getInvitation(id);
    if (local?.accountHandoffAccountId && local.accountHandoffAccountId !== binding.accountId) {
      throw accountPairingError('account_pairing_source_changed', 409);
    }
    const claim = current.claim;
    if (process.env.RAGENT_RUNTIME_MODE === 'proot') {
      const link = readProotAccountLink();
      if (!Number.isSafeInteger(local?.localLinkGeneration) || link.generation !== local.localLinkGeneration
          || link.state === 'signed_out' || (link.state === 'login_pending' && !local.localLinkId))
        throw accountPairingError('account_pairing_source_changed', 409);
    }
    if (local?.localLinkId) {
      const link = readProotAccountLink();
      if (link.state !== 'login_pending' || link.linkId !== local.localLinkId || link.generation !== local.localLinkGeneration
          || link.accountId !== binding.accountId || claim.publicKeyFingerprint !== local.localDeviceFingerprint)
        throw accountPairingError('account_pairing_source_changed', 409);
    }
    const proof = { instanceId: this.identity.instanceId, accountId: binding.accountId, issuedAt: new Date(this.clock()).toISOString() };
    proof.signature = signWithInstanceIdentity(this.identity, buildDesktopAccountSessionAuthorization({ ...proof,
      transactionId: claim.transactionId, requestId: claim.requestId, deviceId: claim.deviceId,
      publicKeyFingerprint: claim.publicKeyFingerprint, nonce: claim.nonce }));
    const result = await this.client.request('approve', id, { desktopProof: proof });
    await this.consumeInvitation(id);
    return result;
  }
  revoke(id) { return this.serialize(id, async () => {
    await this.status(id); const result = await this.client.request('revoke', id); await this.consumeInvitation(id); return result;
  }); }
  serialize(id, operation) {
    const previous = this.operations.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operations.set(id, current);
    void current.finally(() => { if (this.operations.get(id) === current) this.operations.delete(id); }).catch(() => {});
    return current;
  }
  async pollPending(onError = () => {}) {
    if (process.env.RAGENT_RUNTIME_MODE === 'proot' && readProotAccountLink().state === 'signed_out') return;
    for (const invitation of await this.listPendingInvitations()) {
      if (!invitation.accountHandoffAccountId || invitation.usedAt || Date.parse(invitation.expiresAt) <= this.clock()) continue;
      try {
        await this.serialize(invitation.id, async () => {
          const local = await this.getInvitation(invitation.id);
          if (!local || local.usedAt || local.accountHandoffAccountId !== invitation.accountHandoffAccountId) return;
          const binding = await this.binding();
          if (binding?.accountId !== local.accountHandoffAccountId) return;
          const current = await this.status(invitation.id);
          if (current.status === 'CLAIMED') await this.approveClaim(invitation.id);
          else if (['APPROVED', 'REVOKED', 'EXPIRED'].includes(current.status)) await this.consumeInvitation(invitation.id);
        });
      } catch (error) { onError(error); }
    }
  }
}

let service;
export async function getAccountPairingService() {
  if (!service) service = (async () => {
    const { loadOrCreateInstanceIdentity } = await import('../lib/instance-identity.mjs');
    const { createAccountPairingClient } = await import('../lib/account-pairing-client.mjs');
    const { getOwnerAccountBinding } = await import('../lib/owner-account-auth.mjs');
    const devices = await import('./trusted-devices.mjs');
    const { ACCOUNTS_URL } = await import('../lib/config.mjs');
    const identity = await loadOrCreateInstanceIdentity();
    return new AccountPairingService({ identity, binding: getOwnerAccountBinding,
      client: createAccountPairingClient({ identity, baseUrl: ACCOUNTS_URL, allowInsecure: process.env.RAGENT_ALLOW_INSECURE_ACCOUNTS_URL === '1' }),
      createInvitation: devices.createTrustedDeviceInvitation, getInvitation: devices.getLocalAccountPairingInvitation,
      consumeInvitation: devices.consumeLocalAccountPairingInvitation,
      listPendingInvitations: devices.listPendingAccountPairingInvitations });
  })().catch((error) => { service = null; throw error; });
  return service;
}

/** Resume persisted QR consent after restart; no browser panel is required. */
export async function startAccountPairingPoller({ getService = getAccountPairingService, intervalMs = 1500, onError = () => {} } = {}) {
  const service = await getService(); let stopped = false; let timer;
  const run = async () => {
    try { await service.pollPending(onError); } catch (error) { if (!stopped) onError(error); }
    finally { if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); } }
  };
  timer = setTimeout(run, 0); timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
