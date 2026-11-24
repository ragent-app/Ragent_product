// Each authorized device owns its own P2P host and room. A new device must
// never evict another active device; explicit revocation, expiry, or shutdown
// releases its host and associated resources.
import { runP2PHostAgent } from './p2p-host-agent.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { tryP2PHostHandoff } from './p2p-host-handoff.mjs';

const P2P_HOST_REFRESH_LEAD_MS = 60_000;
const hosts = new Map(); // deviceId -> agent
const startingHosts = new Map(); // deviceId -> Promise<start result>
const startingAgents = new Map(); // deviceId -> agent
const startTickets = new Map(); // cancels starts even before an agent or readiness exists
const recoveryTickets = new Map(); // deviceId -> in-flight or queued recovery attempts
const refreshTimers = new Map(); // deviceId -> timeout
const expiryTimers = new Map(); // deviceId -> { agent, expiresAtMs, timer }
const replacementRetries = new Map(); // deviceId -> cancellable replacement attempt
const handoffs = new Map(); // deviceId -> cancellable standby
const hostOptions = new Map(); // deviceId -> options for the current host
const requestedHandoffs = new Map(); // deviceId -> preparation ticket
const refreshingHosts = new Set();
const completedHandoffs = new Map(); // deviceId -> short-lived idempotent receipt
const retiringHosts = new Map(); // deviceId -> Map<agent, hard expiry timer>
let stoppingAll = false;

// Device IDs are never logged directly here. This stable, one-way tag allows
// lifecycle and sidecar errors to be correlated. Lifecycle markers contain
// only this tag and a fixed event name, never credentials or payloads.
function deviceLogTag(deviceId) {
  return createHash('sha256').update(deviceId).digest('hex').slice(0, 12);
}
function traceHost(deviceId, event) {
  console.log(`[p2p-host] device_tag=${deviceLogTag(deviceId)} event=${event}`);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function failureResult(deviceId, reason, error = null) {
  const code = typeof error?.code === 'string' && /^(?:turn|owner_auth)_[a-z0-9_]{1,68}$/.test(error.code)
    ? error.code : '';
  const message = error?.message || (error ? String(error) : '');
  return {
    deviceId,
    started: false,
    reason,
    ...(message ? { error: code ? `${message} (${code})` : message } : {}),
  };
}

function clearRefreshTimer(deviceId) {
  const timer = refreshTimers.get(deviceId);
  if (timer) clearTimeout(timer);
  refreshTimers.delete(deviceId);
}

function clearExpiryTimer(deviceId) {
  const expiry = expiryTimers.get(deviceId);
  if (expiry) clearTimeout(expiry.timer);
  expiryTimers.delete(deviceId);
}

function cancelReplacementRetry(deviceId) {
  const ticket = replacementRetries.get(deviceId);
  if (!ticket) return;
  ticket.cancelled = true;
  if (ticket.timer) clearTimeout(ticket.timer);
  replacementRetries.delete(deviceId);
}

function cancelHandoff(deviceId) {
  const ticket = handoffs.get(deviceId);
  if (!ticket) return null;
  handoffs.delete(deviceId);
  ticket.controller.abort();
  return ticket.standby || null;
}

function retireHost(deviceId, agent, expiresAtMs) {
  const group = retiringHosts.get(deviceId) || new Map();
  const timer = setTimeout(() => { cleanup(); agent.stop(); },
    Math.max(1, expiresAtMs - Date.now()));
  timer.unref?.();
  group.set(agent, timer);
  retiringHosts.set(deviceId, group);
  let unsubscribeIdle = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    try { unsubscribeIdle?.(); } catch {}
    unsubscribeIdle = null;
    group.delete(agent);
    if (!group.size && retiringHosts.get(deviceId) === group) retiringHosts.delete(deviceId);
  };
  const retireNow = () => {
    cleanup();
    agent.stop();
  };
  if (typeof agent.onDataChannelIdle === 'function') {
    unsubscribeIdle = agent.onDataChannelIdle(retireNow);
  }
  agent.done.then(cleanup, cleanup);
}

async function startHostHandoff(deviceId, old, options, oldExpiresAt, credentials, requested = null) {
  if (handoffs.has(deviceId)) return false;
  if (typeof old?.hasActiveChild === 'function' && !old.hasActiveChild()) return false;
  const controller = new AbortController();
  const handoffId = randomBytes(16).toString('hex');
  const ticket = { controller, standby: null, handoffId, requested, probed: false, committed: false, committing: null };
  handoffs.set(deviceId, ticket);
  const current = () => !stoppingAll && handoffs.get(deviceId) === ticket && hosts.get(deviceId) === old;
  let verify;
  const verified = new Promise(resolve => { verify = resolve; });
  const oldExpiry = Date.parse(oldExpiresAt);
  const promoted = await tryP2PHostHandoff({
    old, verified, isCurrent: current, signal: controller.signal,
    deadlineMs: Math.min(20_000, Math.max(1, oldExpiry - Date.now() - 1_000)),
    createStandby: async () => {
      const standby = await options.runHostAgent({
        signalingUrl: options.signalingUrl, roomId: options.p2pAccess.roomId, secret: options.p2pAccess.secret,
        expiresAt: credentials.expiresAt, ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
        localBaseUrl: options.localBaseUrl, browserAuth: options.browserAuth,
        iceServers: credentials.iceServers,
        relayOnly: typeof credentials?.relayOnly === 'boolean' ? credentials.relayOnly : options.relayOnly,
        handoffId,
        subscribeOwnerInvalidations: options.subscribeOwnerInvalidations,
        onDemand: Boolean(options.onDemand),
        spawnOnInit: true,
        ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
        ...(options.resolveIceServers ? { resolveIceServers: options.resolveIceServers } : {}),
        onChildStart: ({ expiresAt: childExpiresAt, connectionId }) => {
          if (hosts.get(deviceId) !== ticket.standby) return;
          const currentOptions = hostOptions.get(deviceId) || options;
          if (connectionId) currentOptions.activeConnectionId = connectionId;
          if (childExpiresAt) {
            scheduleExpiry(deviceId, ticket.standby, childExpiresAt, currentOptions);
            scheduleRefresh(deviceId, ticket.standby, currentOptions, childExpiresAt);
          }
        },
        onChildStop: () => {
          if (hosts.get(deviceId) !== ticket.standby) return;
          clearRefreshTimer(deviceId);
          clearExpiryTimer(deviceId);
        },
        onPolicyDecision: options.onPolicyDecision,
        onSidecarLog: options.onSidecarLog || (line => process.stderr.write(`[p2p-host] device_tag=${deviceLogTag(deviceId)} ${line}\n`)),
        onGatewayResponse: event => {
          try { options.onGatewayResponse?.(event); } catch {}
          if (event?.path === '/api/auth/me' && event.status >= 200 && event.status < 300) {
            if (requested) ticket.probed = true; else verify();
          }
          if (requested && ticket.committed && event?.path === '/api/device-auth/turn/handoff/commit'
            && event.status >= 200 && event.status < 300) verify();
        },
      });
      ticket.standby = standby;
      return standby;
    },
    promote: async standby => {
      if (!current() || Date.now() >= oldExpiry || Date.now() >= Date.parse(credentials.expiresAt)) return false;
      standby.activateHandoff();
      if (requested) completedHandoffs.set(deviceId, { handoffId, expiresAt: Date.now() + 60_000 });
      handoffs.delete(deviceId);
      registerP2PHost(deviceId, standby, { preservePreviousUntil: oldExpiry });
      const nextRelayOnly = typeof credentials?.relayOnly === 'boolean' ? credentials.relayOnly : options.relayOnly;
      const nextOptions = requested
        ? { ...options, relayOnly: nextRelayOnly, activeConnectionId: credentials.connectionId }
        : { ...options, relayOnly: nextRelayOnly };
      hostOptions.set(deviceId, nextOptions);
      scheduleExpiry(deviceId, standby, credentials.expiresAt, nextOptions);
      scheduleRefresh(deviceId, standby, nextOptions, credentials.expiresAt);
      traceHost(deviceId, 'handoff-promoted');
      return true;
    },
  });
  if (handoffs.get(deviceId) === ticket) handoffs.delete(deviceId);
  if (!promoted && !controller.signal.aborted && hosts.get(deviceId) === old && Date.now() < oldExpiry) {
    traceHost(deviceId, 'handoff-rolled-back');
    scheduleRefresh(deviceId, old, options, oldExpiresAt);
  }
  return promoted;
}

/** Only the authenticated same-device request may start an early rotation. */
export function requestP2PHostHandoff(deviceId, previous) {
  const id = trimString(deviceId), old = hosts.get(id), options = hostOptions.get(id), expiry = expiryTimers.get(id);
  if (!old || !options || options.activeConnectionId !== previous?.from || !Number.isSafeInteger(previous?.signedExpiry)
    || previous.signedExpiry <= Date.now() || expiry?.agent !== old || expiry.expiresAtMs <= Date.now()
    || typeof options.prepareHandoff !== 'function' || typeof options.releaseHandoff !== 'function'
    || typeof options.commitHandoff !== 'function' || typeof old.suspendSignaling !== 'function'
    || typeof old.resumeSignaling !== 'function' || stoppingAll) return false;
  if (requestedHandoffs.has(id) || handoffs.has(id) || refreshingHosts.has(id)) return false;
  const request = { old, cancelled: false };
  requestedHandoffs.set(id, request);
  void (async () => {
    let credentials, promoted = false;
    try {
      credentials = await options.prepareHandoff(id, previous);
      if (request.cancelled || requestedHandoffs.get(id) !== request || hosts.get(id) !== old || stoppingAll
        || !credentials?.contract || !trimString(credentials.connectionId)
        || credentials.contract.turn?.connectionId !== credentials.connectionId
        || !Array.isArray(credentials.iceServers) || !credentials.iceServers.length
        || !Number.isFinite(Date.parse(credentials.expiresAt || '')) || Date.parse(credentials.expiresAt) <= Date.now()) return;
      request.contract = credentials.contract;
      request.connectionId = credentials.connectionId;
      promoted = await startHostHandoff(id, old, options,
        new Date(Math.min(expiry.expiresAtMs, previous.signedExpiry)).toISOString(), credentials, request);
    } catch { traceHost(id, 'requested-handoff-failed'); }
    finally {
      if (requestedHandoffs.get(id) === request) requestedHandoffs.delete(id);
      if (!promoted && credentials?.connectionId) {
        await Promise.resolve(options.releaseHandoff(id, credentials.connectionId)).catch(() => {});
      }
    }
  })();
  return true;
}

export function getP2PHostHandoffPlan(deviceId, handoffId) {
  const ticket = handoffs.get(trimString(deviceId));
  if (!ticket?.requested || ticket.handoffId !== handoffId || ticket.controller.signal.aborted) return null;
  return ticket.requested.contract || null;
}

export async function commitP2PHostHandoff(deviceId, handoffId) {
  const id = trimString(deviceId), ticket = handoffs.get(id), options = hostOptions.get(id);
  const receipt = completedHandoffs.get(id);
  if (receipt?.handoffId === handoffId && receipt.expiresAt > Date.now() && hosts.has(id)) return true;
  if (!ticket?.requested || ticket.handoffId !== handoffId || !ticket.probed || ticket.controller.signal.aborted
    || !options || !ticket.requested.connectionId) return false;
  if (ticket.committed) return true;
  if (ticket.committing) return ticket.committing;
  const operation = (async () => {
    try {
      await options.commitHandoff(id, ticket.requested.connectionId);
      if (handoffs.get(id) !== ticket || ticket.controller.signal.aborted || stoppingAll) return false;
      ticket.committed = true;
      return true;
    } catch { return false; }
  })();
  ticket.committing = operation;
  const committed = await operation;
  if (!committed && ticket.committing === operation) ticket.committing = null;
  return committed;
}

// Startup failures are returned as values by startP2PHostForDevice. Keep
// retrying the replacement rather than silently leaving the device without a
// host. Revocation and shutdown cancel both the timer and in-flight startup.
function startReplacementRetry(deviceId, options, initialCredentials) {
  cancelReplacementRetry(deviceId);
  const ticket = { cancelled: false, timer: null, attempt: 0, credentials: initialCredentials };
  replacementRetries.set(deviceId, ticket);
  const current = () => !ticket.cancelled && !stoppingAll && replacementRetries.get(deviceId) === ticket;
  const run = async () => {
    if (!current()) return;
    if (hosts.has(deviceId)) { replacementRetries.delete(deviceId); return; }
    try {
      if (Date.parse(ticket.credentials.expiresAt || '') <= Date.now()) {
        const refreshed = await options.refreshHost(deviceId);
        if (!current()) return;
        if (!Array.isArray(refreshed?.iceServers) || !refreshed.iceServers.length
          || !Number.isFinite(Date.parse(refreshed.expiresAt || '')) || Date.parse(refreshed.expiresAt) <= Date.now()) {
          throw new Error('invalid replacement credentials');
        }
        ticket.credentials = {
          iceServers: refreshed.iceServers,
          expiresAt: refreshed.expiresAt,
          ...(typeof refreshed?.allowDirectIce === 'boolean'
            ? { relayOnly: options.relayOnly || !refreshed.allowDirectIce }
            : {}),
        };
      }
      const result = await startP2PHostForDevice(deviceId, { ...options, ...ticket.credentials });
      if (!current()) return;
      if (result.started || result.reused) {
        replacementRetries.delete(deviceId);
        traceHost(deviceId, 'replacement-ready');
        return;
      }
    } catch {
      // Retry only while this ticket remains current and authorized.
    }
    if (!current()) return;
    traceHost(deviceId, 'replacement-retry-scheduled');
    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(ticket.attempt++, 5)));
    ticket.timer = setTimeout(() => { ticket.timer = null; void run(); }, delayMs);
    ticket.timer.unref?.();
  };
  void run();
}

function scheduleExpiry(deviceId, agent, expiresAt, options) {
  clearExpiryTimer(deviceId);
  const expiresAtMs = Date.parse(expiresAt || '');
  if (!Number.isFinite(expiresAtMs)) return;
  const expiry = { agent, expiresAtMs, timer: null };
  const check = () => {
    if (expiryTimers.get(deviceId) !== expiry || hosts.get(deviceId) !== agent) return;
    if (Date.now() >= expiresAtMs) {
      traceHost(deviceId, 'credentials-expired');
      if (options?.onDemand && typeof agent.teardownChild === 'function') {
        clearRefreshTimer(deviceId);
        clearExpiryTimer(deviceId);
        agent.teardownChild('credentials-expired');
        return;
      }
      stopP2PHost(deviceId);
      if (typeof options?.refreshHost === 'function') {
        startReplacementRetry(deviceId, options, { iceServers: [], expiresAt });
      }
      return;
    }
    expiry.timer = setTimeout(check, Math.min(2_147_483_647, expiresAtMs - Date.now()));
    expiry.timer.unref?.();
  };
  expiryTimers.set(deviceId, expiry);
  check();
}

function scheduleRefresh(deviceId, agent, options, expiresAt) {
  clearRefreshTimer(deviceId);
  if (typeof options.refreshHost !== 'function') return;
  const expiresAtMs = Date.parse(expiresAt || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return;
  const remainingMs = expiresAtMs - Date.now();
  const leadMs = Math.min(P2P_HOST_REFRESH_LEAD_MS, Math.max(1_000, Math.floor(remainingMs / 2)));
  const delayMs = Math.max(1_000, remainingMs - leadMs);
  const timer = setTimeout(async () => {
    if (refreshTimers.get(deviceId) !== timer) return;
    refreshTimers.delete(deviceId);
    if (stoppingAll || hosts.get(deviceId) !== agent) return;
    if (typeof agent.hasActiveChild === 'function' && !agent.hasActiveChild()) return;
    if (Date.now() >= expiresAtMs) {
      traceHost(deviceId, 'credentials-expired');
      stopP2PHost(deviceId);
      startReplacementRetry(deviceId, options, { iceServers: [], expiresAt });
      return;
    }
    if (requestedHandoffs.has(deviceId)) { scheduleRefresh(deviceId, agent, options, expiresAt); return; }
    refreshingHosts.add(deviceId);
    try {
      traceHost(deviceId, 'credentials-refresh-started');
      const refreshed = await options.refreshHost(deviceId);
      const nextIceServers = Array.isArray(refreshed?.iceServers) ? refreshed.iceServers : [];
      const nextExpiresAt = refreshed?.expiresAt;
      if (!nextIceServers.length || !Number.isFinite(Date.parse(nextExpiresAt || ''))
        || Date.parse(nextExpiresAt) <= Date.now()) {
        throw new Error('P2P host TURN refresh returned invalid credentials');
      }
      if (hosts.get(deviceId) !== agent) return;
      if (typeof agent.suspendSignaling === 'function' && typeof agent.resumeSignaling === 'function') {
        traceHost(deviceId, 'handoff-started');
        await startHostHandoff(deviceId, agent, options, expiresAt, {
          iceServers: nextIceServers,
          expiresAt: nextExpiresAt,
          ...(typeof refreshed?.allowDirectIce === 'boolean'
            ? { relayOnly: options.relayOnly || !refreshed.allowDirectIce }
            : {}),
        });
        return;
      }
      traceHost(deviceId, 'credentials-refresh-replacing-host');
      stopP2PHost(deviceId);
      startReplacementRetry(deviceId, options, { iceServers: nextIceServers, expiresAt: nextExpiresAt });
    } catch (error) {
      traceHost(deviceId, 'credentials-refresh-failed');
      // Keep the current host alive while there is still time to retry. Once
      // the credential expires, stop rather than run with stale TURN data.
      if (hosts.get(deviceId) === agent && Date.now() < expiresAtMs) {
        scheduleRefresh(deviceId, agent, options, expiresAt);
      }
    } finally { refreshingHosts.delete(deviceId); }
  }, delayMs);
  timer.unref?.();
  refreshTimers.set(deviceId, timer);
}

export function registerP2PHost(deviceId, agent, { preservePreviousUntil = null } = {}) {
  clearRefreshTimer(deviceId);
  clearExpiryTimer(deviceId);
  const previous = hosts.get(deviceId);
  if (previous && previous !== agent) {
    if (Number.isFinite(preservePreviousUntil) && preservePreviousUntil > Date.now()) retireHost(deviceId, previous, preservePreviousUntil);
    else previous.stop();
  }
  hosts.set(deviceId, agent);
  agent.done.then(
    (result) => {
      if (hosts.get(deviceId) === agent) {
        const code = result?.error ? 'error' : result?.signal ? 'signal' :
          result?.code === 0 ? 'clean' : Number.isInteger(result?.code) ? 'nonzero' : 'unknown';
        traceHost(deviceId, `host-exited-${code}`);
        const standby = cancelHandoff(deviceId);
        standby?.stop();
        clearRefreshTimer(deviceId);
        clearExpiryTimer(deviceId);
        hosts.delete(deviceId);
        hostOptions.delete(deviceId);
        completedHandoffs.delete(deviceId);
        const request = requestedHandoffs.get(deviceId); if (request) request.cancelled = true;
        requestedHandoffs.delete(deviceId);
      }
    },
    () => {},
  );
  return agent;
}

// A trusted device has one long-lived host, independent of the invitation that
// originally enrolled it. The caller supplies the already-authorized per-device
// room access so this registry never reads or persists the room secret itself.
export async function startP2PHostForDevice(deviceId, {
  p2pAccess = null,
  signalingUrl = '',
  localBaseUrl = 'http://127.0.0.1:7690',
  expiresAt,
  binaryPath,
  browserAuth = null,
  iceServers = [],
  relayOnly = false,
  onPolicyDecision = null,
  onGatewayResponse = null,
  onSidecarLog = null,
  refreshHost = null,
  resolveBootstrap = null,
  subscribeOwnerInvalidations = null,
  onDemand = false,
  spawnOnInit = !onDemand,
  idleTimeoutMs = undefined,
  activeConnectionId = '',
  prepareHandoff = null,
  commitHandoff = null,
  releaseHandoff = null,
  runHostAgent = runP2PHostAgent,
  authorizationGuard = null,
  startupTimeoutMs = 15_000,
} = {}) {
  const normalizedDeviceId = trimString(deviceId);
  if (authorizationGuard && !authorizationGuard()) return failureResult(normalizedDeviceId, 'authorization-inactive');
  if (!normalizedDeviceId) return failureResult('', 'device-id-required');
  if (stoppingAll) return failureResult(normalizedDeviceId, 'registry-stopping');

  const existingExpiry = expiryTimers.get(normalizedDeviceId);
  if (existingExpiry && Date.now() >= existingExpiry.expiresAtMs) stopP2PHost(normalizedDeviceId);

  const effectiveRelayOnly = Boolean(relayOnly || browserAuth);
  const existing = hosts.get(normalizedDeviceId);
  if (existing) {
    if ((!onDemand || spawnOnInit) && typeof existing.wake === 'function' && !existing.hasActiveChild?.()) {
      const hasWakeServers = Array.isArray(iceServers) && iceServers.length > 0;
      await existing.wake(hasWakeServers ? {
        iceServers,
        ...(expiresAt ? { expiresAt } : {}),
        ...(activeConnectionId ? { connectionId: activeConnectionId } : {}),
        ...(effectiveRelayOnly ? { relayOnly: true } : {}),
      } : null);
    }
    return { deviceId: normalizedDeviceId, started: false, reused: true, agent: existing };
  }
  const pending = startingHosts.get(normalizedDeviceId);
  if (pending) return pending;

  const roomId = trimString(p2pAccess?.roomId);
  const secret = trimString(p2pAccess?.secret);
  if (!roomId || !secret) return failureResult(normalizedDeviceId, 'p2p-access-unavailable');
  if (!trimString(signalingUrl)) return failureResult(normalizedDeviceId, 'signaling-url-unavailable');
  if (typeof runHostAgent !== 'function') return failureResult(normalizedDeviceId, 'host-agent-unavailable');
  const expiresAtMs = Date.parse(expiresAt || '');
  if (expiresAt && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now())) return failureResult(normalizedDeviceId, 'turn-credentials-expired');

  const resolveIceServers = (typeof resolveBootstrap === 'function' || typeof refreshHost === 'function')
    ? async () => {
      if (authorizationGuard && !authorizationGuard()) {
        throw new Error('Local account association inactive');
      }
      const resolved = typeof resolveBootstrap === 'function'
        ? await resolveBootstrap({ deviceId: normalizedDeviceId })
        : await refreshHost(normalizedDeviceId);
      const turn = resolved?.turn || resolved;
      if (!Array.isArray(turn?.iceServers) || !turn.iceServers.length || !trimString(turn?.expiresAt)) {
        const error = new Error('TURN bootstrap is unavailable for this device');
        if (resolved?.code) error.code = resolved.code;
        throw error;
      }
      return {
        iceServers: turn.iceServers,
        expiresAt: turn.expiresAt,
        connectionId: trimString(turn.connectionId),
        ...(typeof resolved?.allowDirectIce === 'boolean'
          ? { relayOnly: effectiveRelayOnly || !resolved.allowDirectIce }
          : {}),
      };
    }
    : null;

  const ticket = { cancelled: false, reason: '', stopped: false, agent: null };
  ticket.cancellation = new Promise(resolve => { ticket.cancel = reason => { ticket.cancelled = true; ticket.reason = reason; resolve(); }; });
  startTickets.set(normalizedDeviceId, ticket);
  const stopTicket = () => { if (ticket.agent && !ticket.stopped) { ticket.stopped = true; ticket.agent.stop(); } };
  const startPromise = Promise.resolve().then(async () => {
    let agent = null;
    try {
      if (ticket.cancelled) return failureResult(normalizedDeviceId, ticket.reason);
      if (authorizationGuard && !authorizationGuard()) return failureResult(normalizedDeviceId, 'authorization-inactive');
      agent = await runHostAgent({
        authorizationGuard,
        signalingUrl,
        roomId,
        secret,
        ...(expiresAt ? { expiresAt } : {}),
        ...(binaryPath ? { binaryPath } : {}),
        localBaseUrl,
        browserAuth,
        iceServers,
        relayOnly: effectiveRelayOnly,
        ...(subscribeOwnerInvalidations ? { subscribeOwnerInvalidations } : {}),
        ...(onDemand ? { onDemand, spawnOnInit } : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        ...(resolveIceServers ? { resolveIceServers } : {}),
        ...(onDemand ? {
          onChildStart: ({ expiresAt: childExpiresAt, connectionId }) => {
            if (hosts.get(normalizedDeviceId) !== agent) return;
            const currentOptions = hostOptions.get(normalizedDeviceId);
            if (!currentOptions) return;
            if (connectionId) currentOptions.activeConnectionId = connectionId;
            if (childExpiresAt) {
              scheduleExpiry(normalizedDeviceId, agent, childExpiresAt, currentOptions);
              scheduleRefresh(normalizedDeviceId, agent, currentOptions, childExpiresAt);
            }
          },
          onChildStop: () => {
            if (hosts.get(normalizedDeviceId) !== agent) return;
            clearRefreshTimer(normalizedDeviceId);
            clearExpiryTimer(normalizedDeviceId);
          },
        } : {}),
        onPolicyDecision,
        onGatewayResponse,
        onSidecarLog: onSidecarLog || ((line) => {
          process.stderr.write(`[p2p-host] device_tag=${deviceLogTag(normalizedDeviceId)} ${line}\n`);
        }),
      });
      ticket.agent = agent;
      if (authorizationGuard && !authorizationGuard()) { stopTicket(); return failureResult(normalizedDeviceId, 'authorization-inactive'); }
      if (ticket.cancelled) { stopTicket(); return failureResult(normalizedDeviceId, ticket.reason); }
      startingAgents.set(normalizedDeviceId, agent);
      if (!agent || typeof agent.stop !== 'function' || !agent.ready || !agent.done) {
        throw new Error('P2P host agent returned an invalid lifecycle handle');
      }
      await Promise.race([
        agent.ready,
        ticket.cancellation,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`P2P host startup timed out after ${startupTimeoutMs}ms`)), startupTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (stoppingAll || ticket.cancelled) {
        stopTicket();
        return failureResult(normalizedDeviceId, ticket.reason || 'registry-stopping');
      }
      if (expiresAt && Date.now() >= expiresAtMs) {
        agent.stop();
        return failureResult(normalizedDeviceId, 'turn-credentials-expired');
      }
      if (hosts.has(normalizedDeviceId)) {
        agent.stop();
        return { deviceId: normalizedDeviceId, started: false, reused: true, agent: hosts.get(normalizedDeviceId) };
      }
      registerP2PHost(normalizedDeviceId, agent);
      traceHost(normalizedDeviceId, onDemand && !spawnOnInit ? 'host-watcher-ready' : 'host-ready');
      if (Number.isFinite(expiresAtMs)) {
        const lifetimeSeconds = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
        console.log(`[p2p-host] device_tag=${deviceLogTag(normalizedDeviceId)} event=host-credential-lifetime seconds=${lifetimeSeconds}`);
      }
      const restartOptions = {
        p2pAccess,
        signalingUrl,
        localBaseUrl,
        binaryPath,
        browserAuth,
        relayOnly: effectiveRelayOnly,
        refreshHost,
        resolveBootstrap,
        resolveIceServers,
        subscribeOwnerInvalidations,
        onDemand,
        idleTimeoutMs,
        activeConnectionId,
        prepareHandoff,
        commitHandoff,
        releaseHandoff,
        onPolicyDecision,
        onGatewayResponse,
        onSidecarLog,
        runHostAgent,
        startupTimeoutMs,
      };
      hostOptions.set(normalizedDeviceId, restartOptions);
      // Independent hard deadline: a refresh awaiting an unavailable broker
      // must not keep an expired sidecar reusable indefinitely. Recovery may
      // continue only after obtaining fresh credentials.
      if (!onDemand || spawnOnInit) {
        scheduleExpiry(normalizedDeviceId, agent, expiresAt, restartOptions);
        scheduleRefresh(normalizedDeviceId, agent, restartOptions, expiresAt);
      }
      return { deviceId: normalizedDeviceId, started: true, reused: false, agent };
    } catch (error) {
      try { stopTicket(); } catch {}
      if (agent?.done) {
        await Promise.race([
          agent.done,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 1_000);
            timer.unref?.();
          }),
        ]);
      }
      return failureResult(normalizedDeviceId, 'startup-failed', error);
    } finally {
      if (startingAgents.get(normalizedDeviceId) === agent) startingAgents.delete(normalizedDeviceId);
      if (startingHosts.get(normalizedDeviceId) === startPromise) startingHosts.delete(normalizedDeviceId);
      if (startTickets.get(normalizedDeviceId) === ticket) startTickets.delete(normalizedDeviceId);
    }
  });
  startingHosts.set(normalizedDeviceId, startPromise);
  return startPromise;
}

// Restore only account-converged devices. Historical qr-scan records are
// intentionally excluded because they do not prove the current v2 account
// enrollment contract.
export async function restoreP2PHostsForDevices(devices, {
  getP2PAccess,
  getBootstrap,
  onDemand = false,
  ...startOptions
} = {}) {
  const eligible = (Array.isArray(devices) ? devices : []).filter(device => device?.status === 'bound'
    && device.accountId && !device.revokedAt
    && ['account-join', 'account-claim'].includes(device.enrollmentKind));
  const unique = [...new Map(eligible.map(device => [trimString(device.id), device])).entries()];
  const byDevice = new Map();
  const tickets = new Map(unique.map(([id]) => {
    const ticket = { reason: stoppingAll ? 'registry-stopping' : '' };
    const group = recoveryTickets.get(id) || new Set();
    group.add(ticket); recoveryTickets.set(id, group);
    return [id, ticket];
  }));
  let next = 0;
  async function restore(device, ticket) {
    const id = trimString(device.id);
    if (ticket.reason) return failureResult(id, ticket.reason);
    if (typeof getP2PAccess !== 'function') {
      return failureResult(id, 'p2p-access-provider-unavailable');
    }
    try {
      const p2pAccess = await getP2PAccess(device.id);
      if (ticket.reason) return failureResult(id, ticket.reason);
      if (onDemand) {
        const hasBootstrap = typeof getBootstrap === 'function';
        const deviceAllowsDirect = !device.workspaceAccess && !device.temporaryExpiresAt;
        return await startP2PHostForDevice(device.id, {
          ...startOptions,
          onDemand: true,
          spawnOnInit: false,
          p2pAccess,
          ...(hasBootstrap ? {
            relayOnly: startOptions.relayOnly !== undefined
              ? Boolean(startOptions.relayOnly)
              : !deviceAllowsDirect,
            resolveBootstrap: getBootstrap,
            refreshHost: async (deviceId) => {
              const bootstrap = await getBootstrap({ deviceId });
              return {
                iceServers: bootstrap?.turn?.iceServers || [],
                expiresAt: bootstrap?.turn?.expiresAt,
                connectionId: bootstrap?.turn?.connectionId || '',
                ...(typeof bootstrap?.allowDirectIce === 'boolean'
                  ? { allowDirectIce: bootstrap.allowDirectIce }
                  : {}),
              };
            },
          } : {}),
        });
      }
      let turn = null;
      let allowDirectIce = false;
      if (typeof getBootstrap === 'function') {
        const bootstrap = await getBootstrap({ deviceId: id });
        if (ticket.reason) return failureResult(id, ticket.reason);
        turn = bootstrap?.turn || null;
        if (!Array.isArray(turn?.iceServers) || !turn.iceServers.length || !trimString(turn.expiresAt)) {
          return failureResult(id, 'turn-bootstrap-unavailable');
        }
        allowDirectIce = bootstrap?.allowDirectIce === true
          && !device.workspaceAccess
          && !device.temporaryExpiresAt;
      }
      return await startP2PHostForDevice(device.id, {
        ...startOptions,
        p2pAccess,
        ...(turn ? {
          iceServers: turn.iceServers,
          relayOnly: startOptions.relayOnly !== undefined
            ? Boolean(startOptions.relayOnly)
            : !allowDirectIce,
          expiresAt: turn.expiresAt,
          activeConnectionId: turn.connectionId || '',
          refreshHost: async (deviceId) => {
            const bootstrap = await getBootstrap({ deviceId });
            return {
              iceServers: bootstrap?.turn?.iceServers || [],
              expiresAt: bootstrap?.turn?.expiresAt,
              connectionId: bootstrap?.turn?.connectionId || '',
              ...(typeof bootstrap?.allowDirectIce === 'boolean'
                ? { allowDirectIce: bootstrap.allowDirectIce }
                : {}),
            };
          },
        } : {}),
      });
    } catch (error) {
      return ticket.reason ? failureResult(id, ticket.reason) : failureResult(id, 'p2p-access-failed', error);
    }
  }
  // Limit load on Accounts while ensuring a slow device cannot block the
  // recovery of every other device. Duplicate records share one attempt.
  async function worker() {
    while (next < unique.length) {
      const [id, device] = unique[next++];
      const ticket = tickets.get(id);
      try { byDevice.set(id, await restore(device, ticket)); }
      finally {
        const group = recoveryTickets.get(id);
        group?.delete(ticket);
        if (group?.size === 0) recoveryTickets.delete(id);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, () => worker()));
  const results = eligible.map(device => byDevice.get(trimString(device.id)));
  return {
    attempted: results.length,
    started: results.filter((entry) => entry.started).length,
    reused: results.filter((entry) => entry.reused).length,
    failed: results.filter((entry) => !entry.started && !entry.reused).length,
    results,
  };
}

export function unregisterP2PHost(deviceId) {
  const request = requestedHandoffs.get(deviceId); if (request) request.cancelled = true;
  requestedHandoffs.delete(deviceId); hostOptions.delete(deviceId);
  completedHandoffs.delete(deviceId);
  clearRefreshTimer(deviceId);
  clearExpiryTimer(deviceId);
  hosts.delete(deviceId);
}

export function stopP2PHost(deviceId) {
  const request = requestedHandoffs.get(trimString(deviceId)); if (request) request.cancelled = true;
  requestedHandoffs.delete(trimString(deviceId)); hostOptions.delete(trimString(deviceId));
  completedHandoffs.delete(trimString(deviceId));
  cancelReplacementRetry(trimString(deviceId));
  const standby = cancelHandoff(trimString(deviceId));
  for (const recovery of recoveryTickets.get(trimString(deviceId)) || []) recovery.reason ||= 'device-stopped';
  clearRefreshTimer(deviceId);
  clearExpiryTimer(deviceId);
  const ticket = startTickets.get(deviceId); ticket?.cancel('device-stopped');
  const retired = retiringHosts.get(deviceId);
  const agents = new Set([hosts.get(deviceId), startingAgents.get(deviceId), standby, ...(retired?.keys() || [])].filter(Boolean));
  if (retired) { for (const timer of retired.values()) clearTimeout(timer); retiringHosts.delete(deviceId); }
  hosts.delete(deviceId); startingAgents.delete(deviceId); startingHosts.delete(deviceId); startTickets.delete(deviceId);
  for (const agent of agents) { if (ticket?.agent === agent) ticket.stopped = true; agent.stop(); }
}

// 只读视图：当前持有运行 host 的设备 id 列表。ACCEPTANCE 路由用它避开
// 有生产 host 的房间（同 room 双 host 会互相顶替），不改变注册表行为。
export function p2pHostDeviceIds() {
  return [...hosts.keys()];
}

export function p2pHostCount() {
  return hosts.size;
}

export function retiringHostCount(deviceId = '') {
  const id = trimString(deviceId);
  if (id) return retiringHosts.get(id)?.size || 0;
  let total = 0;
  for (const group of retiringHosts.values()) total += group.size;
  return total;
}

export async function stopAllP2PHosts({ timeoutMs = 1500 } = {}) {
  stoppingAll = true;
  for (const request of requestedHandoffs.values()) request.cancelled = true;
  requestedHandoffs.clear(); hostOptions.clear(); completedHandoffs.clear();
  refreshingHosts.clear();
  for (const deviceId of replacementRetries.keys()) cancelReplacementRetry(deviceId);
  const standbys = [...handoffs.keys()].map(cancelHandoff).filter(Boolean);
  for (const group of recoveryTickets.values()) for (const recovery of group) recovery.reason ||= 'registry-stopping';
  const tickets = [...startTickets.values()];
  for (const ticket of tickets) ticket.cancel('registry-stopping');
  startTickets.clear(); startingHosts.clear();
  for (const deviceId of refreshTimers.keys()) clearRefreshTimer(deviceId);
  for (const deviceId of expiryTimers.keys()) clearExpiryTimer(deviceId);
  const retired = [...retiringHosts.values()].flatMap(group => {
    for (const timer of group.values()) clearTimeout(timer);
    return [...group.keys()];
  });
  retiringHosts.clear();
  const agents = [...new Set([...hosts.values(), ...startingAgents.values(), ...standbys, ...retired])];
  hosts.clear();
  for (const agent of agents) {
    for (const ticket of tickets) if (ticket.agent === agent) ticket.stopped = true;
    agent.stop();
  }
  try {
    await Promise.allSettled(agents.map((agent) => Promise.race([
      agent.done,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])));
  } finally {
    stoppingAll = false;
  }
}
