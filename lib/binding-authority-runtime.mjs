import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { loadOrCreateInstanceIdentity } from './instance-identity.mjs';
import { createBindingAuthorityController } from './binding-authority-controller.mjs';
import { createWorkspaceAuthorityController } from './workspace-authority-controller.mjs';
import { writeJsonAtomic } from '../chat/fs-utils.mjs';

export const OWNER_ACCOUNT_AUTHORITY_FILE = join(CONFIG_DIR, 'owner-account-authority.json');
let controllerPromise, controller, ledgerPresent = false, enforcementKnown = false, currentAccountId = '', monitorTimer, monitorStopped = true, monitorEpoch = 0;
const observers = new Set();
const locallyRevokedDevices = new Set();
let workspaceController;
const workspaceDevices = new Map();
const workspaceKey = value => JSON.stringify([value.ownerAccountId, value.accountId, value.grantId, value.revision]);
function emit(event) {
  for (const observer of observers) { try { Promise.resolve(observer(event)).catch(() => {}); } catch {} }
}
async function currentBinding() {
  const { getOwnerAccountBinding } = await import('./owner-account-auth.mjs');
  const binding = await getOwnerAccountBinding(); currentAccountId = binding?.accountId || '';
  if (binding?.bindingAuthorityRevision) enforcementKnown = true;
  return binding;
}
async function getController() {
  if (!controllerPromise) controllerPromise = (async () => {
    const identity = await loadOrCreateInstanceIdentity();
    controller = createBindingAuthorityController({ instanceId: identity.instanceId, keyFingerprint: identity.keyFingerprint,
      readState: async () => {
        let info;
        try { info = await lstat(OWNER_ACCOUNT_AUTHORITY_FILE); }
        catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
        ledgerPresent = true; enforcementKnown = true;
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw Error('Unsafe binding authority state');
        let retained;
        try { retained = JSON.parse(await readFile(OWNER_ACCOUNT_AUTHORITY_FILE, 'utf8')); }
        catch { throw denied('owner_auth_authority_state_invalid', 503); }
        if (!retained || typeof retained !== 'object' || Array.isArray(retained)) throw denied('owner_auth_authority_state_invalid', 503);
        return retained;
      },
      writeState: async state => {
        await writeJsonAtomic(OWNER_ACCOUNT_AUTHORITY_FILE, state, { mode: 0o600 }); ledgerPresent = true; enforcementKnown = true;
      },
      query: async ({ accountId }) => {
        const { queryOwnerAccountBindingAuthority } = await import('./owner-account-auth.mjs');
        return queryOwnerAccountBindingAuthority({ accountId });
      },
      onInvalidate: event => {
        // A proof expiry closes remote carriers. Record its cause without
        // logging the account, assertion, or device credentials.
        if (/^[a-z-]{1,64}$/.test(event.reason || '')) console.warn(`[binding-authority] invalidated reason=${event.reason}`);
        emit({ type: 'invalidated', ...event,
          appliesToCurrentAccount: !event.accountId || event.accountId === currentAccountId });
      },
      onVerifiedInactive: async receipt => {
        const binding = await currentBinding();
        if (!binding || binding.accountId !== receipt.accountId) return;
        const revision = binding.bindingAuthorityRevision;
        if (revision !== undefined && (typeof revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(revision)
          || BigInt(revision) > BigInt(receipt.revision))) return;
        const { invalidatePendingTrustedDeviceInvitations } = await import('../chat/trusted-devices.mjs');
        const { clearOwnerAccountBinding } = await import('./owner-account-auth.mjs');
        await invalidatePendingTrustedDeviceInvitations();
        // Never erase the authority ledger, device keys or revocation facts.
        // Verified completions cannot publish newer metadata during this queue.
        await clearOwnerAccountBinding(); currentAccountId = '';
      },
      onActive: event => emit({ type: 'active', ...event }) });
    await controller.initialize(); return controller;
  })();
  return controllerPromise;
}
function required() { return enforcementKnown || ledgerPresent; }
function denied(code = 'owner_auth_authority_required', statusCode = 401) {
  return Object.assign(new Error('Current computer binding authorization is required'), { code, statusCode });
}

function getWorkspaceController() {
  if (!workspaceController) workspaceController = createWorkspaceAuthorityController({
    query: async input => (await import('./owner-account-auth.mjs')).queryWorkspaceAccountAuthority(input),
    onInvalidate: event => {
      emit({ type: 'invalidated', reason: event.reason, accountId: event.accountId, appliesToCurrentAccount: false });
      const key = workspaceKey(event);
      for (const deviceId of workspaceDevices.get(key) || []) emit({ type: 'device-invalidated', deviceId });
      workspaceDevices.delete(key);
    },
  });
  return workspaceController;
}

function workspaceIdentity(device) {
  const workspace = device?.workspaceAccess;
  if (!workspace) return null;
  if (typeof workspace !== 'object' || Array.isArray(workspace)
    || Object.keys(workspace).sort().join(',') !== 'grantId,ownerAccountId'
    || !/^[A-Za-z0-9_-]{8,160}$/.test(workspace.ownerAccountId || '')
    || !/^iag_[A-Za-z0-9_-]{16,128}$/.test(workspace.grantId || '')
    || !/^[A-Za-z0-9_-]{8,160}$/.test(device.accountId || '') || workspace.ownerAccountId === device.accountId) throw denied();
  return { ownerAccountId: workspace.ownerAccountId, accountId: device.accountId,
    grantId: workspace.grantId, revision: device.bindingAuthorityRevision };
}

export async function commitVerifiedOwnerBinding(account, identity, commit) {
  const authority = await getController();
  await currentBinding();
  if (!account?.bindingAuthorityRevision) {
    if (required()) throw denied('owner_auth_authority_upgrade_required', 503);
    return commit();
  }
  return authority.acceptVerifiedCompletion({ instanceId: identity.instanceId, keyFingerprint: identity.keyFingerprint,
    accountId: account.accountId, revision: account.bindingAuthorityRevision }, commit);
}

export async function authorizeDeviceBinding(device, { tokenRevision, credential = false } = {}) {
  const binding = await currentBinding(), authority = await getController();
  const workspace = workspaceIdentity(device);
  if (workspace) {
    if (!required() || !binding || binding.accountId !== workspace.ownerAccountId || device?.revokedAt) throw denied();
    if (credential && tokenRevision !== workspace.revision) throw denied('owner_auth_authority_superseded');
    const owner = await authority.authorize({ accountId: workspace.ownerAccountId, revision: workspace.revision });
    const shared = getWorkspaceController();
    const member = await shared.authorize(workspace);
    if (!authority.allows(workspace.ownerAccountId, workspace.revision) || !shared.allows(workspace)) throw denied();
    if (device?.id) {
      const key = workspaceKey(workspace), devices = workspaceDevices.get(key) || new Set();
      devices.add(device.id); workspaceDevices.set(key, devices);
    }
    return { accountId: workspace.accountId, revision: owner.revision, expiresAt: Math.min(owner.expiresAt, member.expiresAt),
      workspaceAccess: { ownerAccountId: workspace.ownerAccountId, grantId: workspace.grantId } };
  }
  if (!required()) return null; // An old backend cannot advertise or synthesize this protocol.
  const accountId = device?.accountId || binding?.accountId;
  if (!accountId || !binding || binding.accountId !== accountId || device?.revokedAt) throw denied();
  const revision = device?.bindingAuthorityRevision;
  if (credential && tokenRevision !== revision) throw denied('owner_auth_authority_superseded');
  return authority.authorize({ accountId, revision });
}

export function assertDeviceBindingNow(device) {
  const workspace = workspaceIdentity(device);
  if (workspace) {
    if (!required() || !controller?.allows(workspace.ownerAccountId, workspace.revision)
      || !workspaceController?.allows(workspace)) throw denied();
    return;
  }
  if (!required()) return;
  if (!controller?.allows(device?.accountId || currentAccountId, device?.bindingAuthorityRevision)) throw denied();
}

export function allowsRemoteBinding(session) {
  if (locallyRevokedDevices.has(session?.deviceId)) return false;
  if (!['trusted_device', 'device_handshake'].includes(session?.principalKind)
    && !['google_accounts', 'google_accounts_poll'].includes(session?.authMethod)) return true;
  let workspace;
  try { workspace = workspaceIdentity(session); } catch { return false; }
  if (workspace && !required()) return false;
  if (!required()) return true;
  if (!Number.isFinite(session.expiry) || session.expiry <= Date.now()) return false;
  if (workspace) return Boolean(controller?.allows(workspace.ownerAccountId, workspace.revision)
    && workspaceController?.allows(workspace));
  return Boolean(controller?.allows(session?.accountId, session?.bindingAuthorityRevision));
}

export function subscribeBindingAuthority(observer) {
  observers.add(observer); return () => observers.delete(observer);
}

export async function refreshWorkspaceBindingAuthority(workspace) {
  return getWorkspaceController().refresh(workspace);
}

export function invalidateLocalBindingAuthority() { controller?.invalidate(); }
export async function prepareBindingAuthorityRuntime() {
  // The shipped server calls this before exposing its listeners. A configured
  // account binding cannot keep using legacy remote credentials while the
  // first signed status is still pending; localweb remains independent.
  try {
    const binding = await currentBinding();
    const { getOwnerAccountBrokerStatus } = await import('./owner-account-auth.mjs');
    if (binding?.accountId && getOwnerAccountBrokerStatus().configured) enforcementKnown = true;
    await getController();
  } catch { enforcementKnown = true; }
}
export function notifyDeviceBindingRevoked(deviceId) {
  locallyRevokedDevices.add(deviceId); emit({ type: 'device-invalidated', deviceId });
}
export function notifyDeviceBindingAuthorized(deviceId) { locallyRevokedDevices.delete(deviceId); }

export async function refreshCurrentOwnerBindingAuthority() {
  const binding = await currentBinding();
  if (!binding?.accountId) return { active: false, reason: 'not-bound' };
  const { getOwnerAccountBrokerStatus } = await import('./owner-account-auth.mjs');
  if (!getOwnerAccountBrokerStatus().configured) return { active: false, reason: 'accounts-unconfigured' };
  const authority = await getController();
  // A verified status can activate enforcement for an older binding. Do not
  // stamp its existing devices/tokens with the observed generation: they need
  // a fresh Accounts-authorized completion before regaining remote access.
  return authority.refresh(binding.accountId);
}

export async function startBindingAuthorityMonitor() {
  if (!monitorStopped) return;
  monitorStopped = false; const epoch = ++monitorEpoch;
  let lastFailure = '';
  const tick = async () => {
    if (monitorStopped || epoch !== monitorEpoch) return;
    try {
      await refreshCurrentOwnerBindingAuthority();
      if (lastFailure) { console.log('[binding-authority] monitor-recovered'); lastFailure = ''; }
    } catch (error) {
      // Existing proofs still expire independently; this is diagnostic only.
      const code = /^[a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : `http_${Number(error?.statusCode) || 0}`;
      if (code !== lastFailure) { console.warn(`[binding-authority] monitor-failed code=${code}`); lastFailure = code; }
    }
    if (!monitorStopped && epoch === monitorEpoch) { monitorTimer = setTimeout(tick, 10_000); monitorTimer.unref?.(); }
  };
  void tick();
}

export function stopBindingAuthorityMonitor() {
  monitorStopped = true; monitorEpoch++; if (monitorTimer) clearTimeout(monitorTimer); monitorTimer = null; controller?.stop();
  workspaceController?.stop(); workspaceController = null; workspaceDevices.clear();
}
