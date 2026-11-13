#!/usr/bin/env node
import { join } from 'path';
import { readFile as readFileAsync, rename, writeFile } from 'fs/promises';

import {
  E_CLI_SOCKET_MISSING,
  E_CLI_SOCKET_UNSAFE,
  E_SOCKET_ALREADY_ACTIVE,
  mayRemoveStaleSocket,
  probeCliSocketPath,
  recordSocketIdentity,
  shouldCleanupSocket,
} from './lib/cli-socket-guard.mjs';
import { computeControlPlaneHealth } from './lib/control-plane-health.mjs';
import { isEnvToggleEnabled } from './lib/env-toggle.mjs';
import { createOwnerServiceLifecycle } from './lib/windows-owner-service.mjs';
import { createOwnerActivationService } from './lib/windows-owner-activation-service.mjs';
import { createBindingAuthorityCarrierLifecycle } from './chat/binding-authority-carriers.mjs';
import { ensureWindowsServiceHarnessState } from './lib/harness-registry.mjs';

await ensureWindowsServiceHarnessState();

const http = await import('http');
const { monitorEventLoopDelay, performance } = await import('perf_hooks');
const processStartedAtMs = Date.now();
const [
  { CHAT_PORT, CHAT_BIND_HOST, SECURE_COOKIES, MEMORY_DIR, CLI_SOCKET_PATH, P2P_SIGNALING_URL, INSTANCE_ROOT },
  { handleRequest, stopFrontendBuildWatchers },
  { initWorkspaceLeaseRecovery },
  apiRequestLog,
  usageLedger,
  ws,
  sessionManager,
  triggers,
  runSpoolArchive,
  tools,
  { ensureDir },
  restartInterlock,
  systemdNotify,
  p2pHostRegistry,
  { getTrustedDeviceP2PAccess, listTrustedDevices },
  { buildDeviceConnectionBootstrapContract },
  { flushPendingAuditProjections },
  { flushSessionsMetaNow },
  { issueSession, revokeSession, setCookie, closeAuthSessionStore },
  memoryRegistry,
  { backgroundAiQueue },
  { startAdaptiveConcurrencyController },
  { chmodSync, unlinkSync, readFileSync, readdirSync },
  { prepareCliIpcTransport, cliIpcListenTarget, validateCliAuthRequest },
  { bootstrapInstanceRuntime },
  { watchWindowsServiceStop },
  { startSelfStopDetector },
  managedProcesses,
  { startProjectMemoryRecovery },
  bindingAuthorityRuntime,
  { closeInvalidBindingClients },
] = await Promise.all([
  import('./lib/config.mjs'),
  import('./chat/router.mjs'),
  import('./chat/run-admission.mjs'),
  import('./chat/api-request-log.mjs'),
  import('./chat/usage-ledger.mjs'),
  import('./chat/ws.mjs'),
  import('./chat/session-manager.mjs'),
  import('./chat/triggers.mjs'),
  import('./chat/run-spool-archive.mjs'),
  import('./lib/tools.mjs'),
  import('./chat/fs-utils.mjs'),
  import('./lib/restart-interlock.mjs'),
  import('./lib/systemd-notify.mjs'),
  import('./lib/p2p-host-registry.mjs'),
  import('./chat/trusted-devices.mjs'),
  import('./chat/connection-bootstrap-service.mjs'),
  import('./chat/session-audit-projection.mjs'),
  import('./chat/session-meta-store.mjs'),
  import('./lib/auth.mjs'),
  import('./chat/memory-registry.mjs'),
  import('./chat/background-ai-queue.mjs'),
  import('./chat/adaptive-concurrency-registry.mjs'),
  import('fs'),
  import('./lib/cli-ipc-transport.mjs'),
  import('./lib/instance-runtime.mjs'),
  import('./lib/windows-service-stop.mjs'),
  import('./lib/self-stop-detector.mjs'),
  import('./chat/managed-processes.mjs'),
  import('./chat/project-memory-engine.mjs'),
  import('./lib/binding-authority-runtime.mjs'),
  import('./chat/ws-clients.mjs'),
]);

const cliTransport = await prepareCliIpcTransport({
  platform: process.platform,
  unixSocketPath: CLI_SOCKET_PATH,
  bootstrapInstanceRuntime,
});
const cliListenTarget = cliIpcListenTarget(cliTransport);
// Environment selects lifecycle only. The installed OS inspector, never these
// flags, establishes the actual separated service token and Owner authority.
const ownerService = process.platform === 'win32'
  && process.env.AGENTOC_WINDOWS_SERVICE_MODE === '1'
  && process.env.AGENTOC_WINDOWS_SERVICE_ROLE === 'control'
  ? createOwnerServiceLifecycle({
    issueOwnerSession: () => issueSession({ role: 'owner', authMethod: 'native_cli' }),
    revokeOwnerSession: revokeSession,
  }) : null;
const ownerActivation = ownerService ? createOwnerActivationService({ lifecycle: ownerService }) : null;

const {
  RENDEZVOUS_POLL_BASE_DELAY_MS,
  RENDEZVOUS_TIMER_MAX_DELAY_MS,
  nextRendezvousPollDelayMs,
} = await import('./lib/owner-auth-rendezvous-schedule.mjs');
let rendezvousPollTimer = null;
let rendezvousPollBusy = false;
let rendezvousPollDelayMs = RENDEZVOUS_POLL_BASE_DELAY_MS;
// Initialize lifecycle state before any startup task can schedule a callback.
// In particular, the rendezvous poll may fire while the boot awaits below are
// still in progress.
let shuttingDown = false;
let authorityListenerReady = false;
let selfStopDetector = null;
let shutdownPromise = null;
let startupRecoveryTimer = null;
let stopAdaptiveConcurrency = () => {};
let stopProjectMemoryRecovery = () => {};
let factoryRuntime = null;
let stopTemporaryPairingPoller = () => {};
let stopAccountPairingPoller = () => {};
let stopTemporaryControlPoller = () => {};

const STARTUP_RECOVERY_DELAY_ENV = 'AGENTOC_STARTUP_RECOVERY_DELAY_MS';
const STALE_APPROVAL_BACKFILL_ENV = 'AGENTOC_STALE_APPROVAL_BACKFILL';
const P2P_HOST_RECOVERY_ENV = 'AGENTOC_P2P_HOST_RECOVERY';

function scheduleRendezvousPoll(delayMs = rendezvousPollDelayMs) {
  if (shuttingDown) return;
  if (rendezvousPollTimer) clearTimeout(rendezvousPollTimer);
  rendezvousPollTimer = setTimeout(() => {
    rendezvousPollTimer = null;
    void runRendezvousPoll();
  }, Math.max(0, Math.min(Number.isFinite(Number(delayMs)) ? Number(delayMs) : RENDEZVOUS_POLL_BASE_DELAY_MS, RENDEZVOUS_TIMER_MAX_DELAY_MS)));
  rendezvousPollTimer.unref?.();
}

async function runRendezvousPoll() {
  if (shuttingDown || rendezvousPollBusy) return;
  rendezvousPollBusy = true;
  try {
    const { pollOwnerAccountRendezvous } = await import('./lib/owner-account-auth.mjs');
    const result = await pollOwnerAccountRendezvous({
      buildBootstrap: buildDeviceConnectionBootstrapContract,
      startP2PHost: ({ deviceId, p2p, bootstrap, iceServers, expiresAt }) => p2pHostRegistry.startP2PHostForDevice(deviceId, {
        p2pAccess: p2p,
        signalingUrl: P2P_SIGNALING_URL,
        localBaseUrl: `http://127.0.0.1:${CHAT_PORT}`,
        iceServers,
        relayOnly: true,
        expiresAt,
        activeConnectionId: bootstrap?.turn?.connectionId || '',
        prepareHandoff: prepareRequestedTurnHandoff,
        commitHandoff: commitRequestedTurnHandoff,
        releaseHandoff: releaseRequestedTurnHandoff,
        refreshHost: async (refreshDeviceId) => {
          const bootstrap = await buildDeviceConnectionBootstrapContract({ deviceId: refreshDeviceId });
          return {
            iceServers: bootstrap?.turn?.iceServers || [],
            expiresAt: bootstrap?.turn?.expiresAt,
          };
        },
      }),
    });
    rendezvousPollDelayMs = nextRendezvousPollDelayMs({ result });
  } catch (error) {
    if (error?.code !== 'owner_auth_broker_not_configured') {
      console.warn(`[owner-auth-rendezvous] poll failed: ${error?.code ? `${error.code}: ` : ''}${error?.message || error}`);
    }
    // A broker rejection, rate limit, or network failure must not create a
    // permanent 2-second request/log loop in the chat control plane.
    rendezvousPollDelayMs = nextRendezvousPollDelayMs({ error, currentDelayMs: rendezvousPollDelayMs });
  } finally {
    rendezvousPollBusy = false;
    scheduleRendezvousPoll();
  }
}

async function prepareRequestedTurnHandoff(deviceId, previous) {
  const contract = await buildDeviceConnectionBootstrapContract({ deviceId, handoff: previous });
  return { contract, connectionId: contract.turn?.connectionId,
    iceServers: contract.turn?.iceServers || [], expiresAt: contract.turn?.expiresAt };
}

async function releaseRequestedTurnHandoff(deviceId, connectionId) {
  const [{ releaseTurnConnectionLease }, { releaseOwnerAccountTurnConnection }] = await Promise.all([
    import('./chat/turn-connection-leases.mjs'), import('./lib/owner-account-auth.mjs'),
  ]);
  await Promise.allSettled([
    releaseTurnConnectionLease({ deviceId, connectionId, reason: 'handoff-aborted' }),
    releaseOwnerAccountTurnConnection({ deviceId, connectionId, protocolVersion: 3, reason: 'handoff-aborted' }),
  ]);
}

async function commitRequestedTurnHandoff(deviceId, connectionId) {
  const [{ commitLocalTurnHandoff }, { commitOwnerAccountTurnHandoff }] = await Promise.all([
    import('./chat/turn-connection-leases.mjs'), import('./lib/owner-account-auth.mjs'),
  ]);
  await commitOwnerAccountTurnHandoff({ deviceId, connectionId });
  await commitLocalTurnHandoff({ deviceId, connectionId });
}

let accountHostsRecovery = null;
async function restoreAccountP2PHosts() {
  if (accountHostsRecovery) return accountHostsRecovery;
  const run = restoreMissingAccountP2PHosts(); accountHostsRecovery = run;
  try { return await run; } finally { if (accountHostsRecovery === run) accountHostsRecovery = null; }
}
async function restoreMissingAccountP2PHosts() {
  if (shuttingDown) return;
  const trusted = await listTrustedDevices();
  const running = new Set(p2pHostRegistry.p2pHostDeviceIds());
  const missing = (trusted?.devices || []).filter(device => !running.has(device.id));
  const result = await p2pHostRegistry.restoreP2PHostsForDevices(missing, {
    signalingUrl: P2P_SIGNALING_URL,
    localBaseUrl: `http://127.0.0.1:${CHAT_PORT}`,
    getP2PAccess: getTrustedDeviceP2PAccess,
    getBootstrap: buildDeviceConnectionBootstrapContract,
    prepareHandoff: prepareRequestedTurnHandoff,
    commitHandoff: commitRequestedTurnHandoff,
    releaseHandoff: releaseRequestedTurnHandoff,
  });
  if (result.attempted > 0) {
    console.log(`[p2p-host] account device recovery attempted=${result.attempted} started=${result.started} reused=${result.reused} failed=${result.failed}`);
    for (const entry of result.results.filter((item) => !item.started && !item.reused)) {
      console.warn(`[p2p-host] device=${entry.deviceId} unavailable reason=${entry.reason}${entry.error ? `: ${entry.error}` : ''}`);
    }
  }
  return result;
}

const authorityCarriers = createBindingAuthorityCarrierLifecycle({
  subscribe: bindingAuthorityRuntime.subscribeBindingAuthority, closeClients: closeInvalidBindingClients,
  stopDevice: p2pHostRegistry.stopP2PHost,
  stopHosts: () => shuttingDown ? Promise.resolve() : p2pHostRegistry.stopAllP2PHosts(), restoreHosts: restoreAccountP2PHosts,
  shouldRestore: () => !shuttingDown && authorityListenerReady
    && isEnvToggleEnabled(process.env[P2P_HOST_RECOVERY_ENV], { defaultValue: true }),
  onError: error => console.warn(`[binding-authority] carrier recovery failed: ${error?.code || 'unavailable'}`),
});
await bindingAuthorityRuntime.prepareBindingAuthorityRuntime();

for (const dir of [MEMORY_DIR, join(MEMORY_DIR, 'tasks')]) {
  await ensureDir(dir);
}

await restartInterlock.clearRestartDrainAfterStartup();
await apiRequestLog.initApiRequestLog();
await usageLedger.initUsageLedger();
await tools.ensureDefaultMicroAgentToolRegistrationAsync();
await tools.ensureCodexAvailableAsync();
// instance_poll 交付恢复：重启前未完成的轮询事务用原 requestId 继续领取。
// Also repair/publish the local instance's canonical endpoint in the central
// Accounts directory. This heals bindings created before endpoint publication
// existed, without requiring the owner to unbind and bind again.
await import('./lib/owner-account-auth.mjs').then(async ({ recoverOwnerAuthPollers, publishOwnerAccountEndpoint }) => {
  const count = await recoverOwnerAuthPollers();
  if (count > 0) console.log(`[owner-auth-poll] resumed ${count} transaction(s)`);
  // Endpoint repair must not make the local control plane depend on the
  // availability of the independently deployed Accounts service at boot.
  // Keep it best-effort and let the next restart/native login retry it.
  void publishOwnerAccountEndpoint()
    .then((published) => {
      if (published?.published) console.log(`[owner-auth-endpoint] published ${published.publicEndpoint}`);
    })
    .catch((error) => console.warn(`[owner-auth-endpoint] publication failed: ${error?.message || error}`));
  // Endpoint-less same-account joins are delivered through the central
  // Accounts rendezvous inbox. Run one request at a time and back off when
  // the independently deployed Accounts service rejects or cannot receive it.
  scheduleRendezvousPoll();
}).catch((error) => console.warn(`[owner-auth-recovery] startup recovery failed: ${error?.message || error}`));

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let previousEventLoopUtilization = performance.eventLoopUtilization();
let lastEventLoopWindowAtMs = 0;
let lastEventLoopWindow = { mean: 0, p99: 0, max: 0, utilization: 0 };
let lastMemorySnapshot = null;
let listenersReadyAtMs = null;
const CONTROL_PLANE_FORENSICS_PATH = join(MEMORY_DIR, 'control-plane-forensics.json');
let forensicSamples = null;
let forensicWriteChain = Promise.resolve();

function readEventLoopWindow() {
  const now = Date.now();
  const windowMs = readPositiveIntEnv('AGENTOC_EVENT_LOOP_WINDOW_MS', 5_000);
  if (lastEventLoopWindowAtMs === 0 || now - lastEventLoopWindowAtMs >= windowMs) {
    const utilization = performance.eventLoopUtilization(previousEventLoopUtilization);
    previousEventLoopUtilization = performance.eventLoopUtilization();
    const normalizeMs = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value * 1000) / 1000) : 0;
    lastEventLoopWindow = {
      mean: normalizeMs(eventLoopDelay.mean / 1e6),
      p99: normalizeMs(eventLoopDelay.percentile(99) / 1e6),
      max: normalizeMs(eventLoopDelay.max / 1e6),
      utilization: Number.isFinite(utilization.utilization)
        ? Math.max(0, Math.round(utilization.utilization * 1000) / 1000)
        : 0,
    };
    eventLoopDelay.reset();
    lastEventLoopWindowAtMs = now;
  }
  return lastEventLoopWindow;
}

function readCgroupSnapshot() {
  if (process.platform !== 'linux') return null;
  try {
    const cgroupText = readFileSync('/proc/self/cgroup', 'utf8');
    const relative = cgroupText.split(/\r?\n/)
      .map((line) => line.split('::')[1])
      .find((value) => typeof value === 'string' && value.startsWith('/'));
    if (!relative) return null;
    const root = join('/sys/fs/cgroup', relative);
    const readNumber = (name) => {
      try {
        const n = Number.parseInt(readFileSync(join(root, name), 'utf8').trim(), 10);
        return Number.isInteger(n) && n >= 0 ? n : null;
      } catch { return null; }
    };
    const events = {};
    try {
      for (const line of readFileSync(join(root, 'memory.events'), 'utf8').split(/\r?\n/)) {
        const [key, value] = line.trim().split(/\s+/);
        const n = Number.parseInt(value, 10);
        if (key && Number.isInteger(n)) events[key] = n;
      }
    } catch {}
    return {
      memoryCurrentBytes: readNumber('memory.current'),
      memoryHighBytes: readNumber('memory.high'),
      memoryMaxBytes: readNumber('memory.max'),
      pidsCurrent: readNumber('pids.current'),
      memoryEvents: events,
    };
  } catch {
    return null;
  }
}

function readCgroupDirectorySnapshot(root) {
  if (!root) return null;
  const readNumber = (name) => {
    try {
      const raw = readFileSync(join(root, name), 'utf8').trim();
      if (raw === 'max') return null;
      const n = Number.parseInt(raw, 10);
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch { return null; }
  };
  const memoryCurrentBytes = readNumber('memory.current');
  const pidsCurrent = readNumber('pids.current');
  if (memoryCurrentBytes === null && pidsCurrent === null) return null;
  return {
    memoryCurrentBytes,
    memoryHighBytes: readNumber('memory.high'),
    memoryMaxBytes: readNumber('memory.max'),
    pidsCurrent,
  };
}

function readRunnerFleetSnapshot() {
  if (process.platform !== 'linux') return null;
  // systemd creates this slice below agentoc.slice on packaged installs;
  // retain the direct path for older/dev units. This exposes the actual fleet
  // pressure instead of reporting only the chat-server cgroup.
  for (const root of [
    '/sys/fs/cgroup/agentoc.slice/agentoc-runners.slice',
    '/sys/fs/cgroup/agentoc-runners.slice',
  ]) {
    const snapshot = readCgroupDirectorySnapshot(root);
    if (snapshot) {
      let activeRunnerUnits = [];
      try {
        activeRunnerUnits = readdirSync(root)
          .filter((name) => /^agentoc-runner-run_[A-Za-z0-9_-]+\.service$/.test(name))
          .sort();
      } catch {}
      return { ...snapshot, activeRuns: activeRunnerUnits.length, activeRunnerUnits };
    }
  }
  return null;
}

function forensicRecord(snapshot) {
  const delay = snapshot?.process?.eventLoopDelayMs || {};
  const sampler = snapshot?.sampler || {};
  const thresholdMs = readPositiveIntEnv('AGENTOC_EVENT_LOOP_FORENSICS_DELAY_MS', 1_000);
  return {
    collectedAtMs: snapshot?.collectedAtMs || Date.now(),
    process: snapshot?.process || null,
    sampler,
    ...(Math.max(delay.max || 0, sampler.samplingDelayMs || 0) >= thresholdMs
      ? { stall: { thresholdMs, eventLoopMaxMs: delay.max || 0, samplingDelayMs: sampler.samplingDelayMs || 0 } }
      : {}),
  };
}

function persistForensicSnapshot(snapshot) {
  const maxSamples = readPositiveIntEnv('AGENTOC_FORENSICS_MAX_SAMPLES', 360);
  const record = forensicRecord(snapshot);
  forensicWriteChain = forensicWriteChain.catch(() => {}).then(async () => {
    if (!Array.isArray(forensicSamples)) {
      try {
        const previous = JSON.parse(await readFileAsync(CONTROL_PLANE_FORENSICS_PATH, 'utf8'));
        forensicSamples = Array.isArray(previous?.samples) ? previous.samples : [];
      } catch {
        forensicSamples = [];
      }
    }
    forensicSamples.push(record);
    if (forensicSamples.length > maxSamples) {
      forensicSamples.splice(0, forensicSamples.length - maxSamples);
    }
    const tempPath = `${CONTROL_PLANE_FORENSICS_PATH}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify({ schemaVersion: 1, samples: forensicSamples }), { mode: 0o600 });
    await rename(tempPath, CONTROL_PLANE_FORENSICS_PATH);
  }).catch((error) => {
    console.error(`[forensics] failed to persist control-plane sample: ${error?.message || error}`);
  });
}

// DS-06 unified memory/performance snapshot: process memory + event loop +
// every registered cache gauge. JSON-safe by construction (the memory registry
// only carries counts/bytes/static names — never cached values, paths, tokens
// or session bodies). Synchronous and O(cached entries) so it is safe to run
// from the request path and from the sampler tick.
function buildMemorySnapshot() {
  const memory = process.memoryUsage();
  return {
    collectedAtMs: Date.now(),
    process: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      eventLoopDelayMs: readEventLoopWindow(),
      cgroup: readCgroupSnapshot(),
      runnerFleet: readRunnerFleetSnapshot(),
    },
    caches: memoryRegistry.collectCacheMetrics(),
    requestMetrics: apiRequestLog.getApiRequestMetrics(),
  };
}

function findCacheMetrics(snapshot, name) {
  return snapshot.caches.find((entry) => entry.name === name) || null;
}

function getCliTransportStatus() {
  // The CLI identity socket is the concrete single-instance/CLI-auth channel.
  // We bound one during startup; if it is gone or replaced, local CLI auth is
  // broken even though HTTP keeps serving, so /healthz must degrade.
  if (!cliSocketBound) return 'degraded';
  if (cliTransport.kind === 'windows-named-pipe') {
    return ownerService ? (ownerService.snapshot().ready || ownerActivation.snapshot().ready ? 'ready' : 'degraded') : 'ready';
  }
  if (!cliSocketIdentity) return 'degraded';
  return shouldCleanupSocket(CLI_SOCKET_PATH, cliSocketIdentity) ? 'ready' : 'degraded';
}

function writeHealthz(res) {
  // Health probes are frequent during restart storms. Return the sampler's
  // last aggregate instead of synchronously walking cgroups and every cache
  // on each request; only the first request needs a bounded fallback sample.
  const snapshot = lastMemorySnapshot || buildMemorySnapshot();
  const memory = snapshot.process.memory;
  const health = computeControlPlaneHealth({ cliTransport: getCliTransportStatus() });
  const ownerActivationSnapshot = ownerActivation?.snapshot() || null;
  const ownerActivationHealth = ownerActivationSnapshot ? {
    state: ownerActivationSnapshot.state,
    ready: ownerActivationSnapshot.ready === true,
    code: typeof ownerActivationSnapshot.code === 'string'
      && /^(?:OBC|OBD|OSV|OBP|OBS)_[A-Z_]+$/.test(ownerActivationSnapshot.code)
      ? ownerActivationSnapshot.code
      : null,
  } : null;
  const payload = {
    ok: health.ok,
    status: health.status,
    http: health.http,
    cliTransport: health.cliTransport,
    pid: snapshot.process.pid,
    uptimeSec: snapshot.process.uptimeSec,
    startupToReadyMs: listenersReadyAtMs == null ? null : listenersReadyAtMs - processStartedAtMs,
    // Top-level backward-compatible fields (systemd watchdog, existing tests).
    rssBytes: memory.rssBytes,
    heapUsedBytes: memory.heapUsedBytes,
    heapTotalBytes: memory.heapTotalBytes,
    externalBytes: memory.externalBytes,
    arrayBuffersBytes: memory.arrayBuffersBytes,
    eventLoopDelayMs: snapshot.process.eventLoopDelayMs,
    cgroup: snapshot.process.cgroup,
    // Per-Run unit names are retained in owner diagnostics/forensics but are
    // deliberately omitted from the public health probe.
    runnerFleet: snapshot.process.runnerFleet
      ? { ...snapshot.process.runnerFleet, activeRunnerUnits: undefined }
      : null,
    ...(ownerActivationHealth ? { ownerActivation: ownerActivationHealth } : {}),
    // DS-06: cache gauges + queue/observer/sampler state. Aggregates only —
    // no session bodies, paths, tokens or cookies.
    caches: snapshot.caches,
    requestMetrics: snapshot.requestMetrics,
    backgroundQueue: findCacheMetrics(snapshot, 'backgroundQueue'),
    observedRuns: findCacheMetrics(snapshot, 'observedRuns'),
    sampler: {
      running: memoryRegistry.getSamplerState().running,
      samplesCollected: memoryRegistry.getSamplerState().samplesCollected,
      lastSampleAtMs: memoryRegistry.getSamplerState().lastSampleAtMs,
      intervalMs: memoryRegistry.getSamplerState().intervalMs,
      maxSamples: memoryRegistry.getSamplerState().maxSamples,
    },
  };
  res.writeHead(health.httpCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

// Keep a compact, bounded diagnostic for the MSI activation gate. The regular
// health payload contains detailed cache metrics and may exceed the installer's
// capped error-body read when it returns HTTP 503.
function writeOwnerActivationHealthz(res) {
  const health = computeControlPlaneHealth({ cliTransport: getCliTransportStatus() });
  const snapshot = ownerActivation?.snapshot() || null;
  const ownerActivationHealth = snapshot ? {
    state: snapshot.state,
    ready: snapshot.ready === true,
    code: typeof snapshot.code === 'string'
      && /^(?:OBC|OBD|OSV|OBP|OBS)_[A-Z_]+$/.test(snapshot.code)
      ? snapshot.code
      : null,
  } : null;
  res.writeHead(health.httpCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({
    ok: health.ok,
    cliTransport: health.cliTransport,
    pid: process.pid,
    ownerActivation: ownerActivationHealth,
  }));
}

async function handleCliSocketAuth(req, res) {
  // 本机 CLI 身份通道：仅经 0600 unix socket 可达（req.isLocalSocket 由 socket
  // listener 标记），网络请求一律 404。签发与 /login 完全同机制的 HMAC owner
  // 会话（可吊销、有时限），替代 2026-08-05 下线的静态 token。
  if (!req.isLocalSocket) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  // Node's legacy Windows pipe does not authenticate actual Owner token/session.
  // Native Owner IPC now exclusively issues Windows CLI sessions. Unix retains
  // its existing filesystem-owner socket contract; localweb is unchanged.
  if(process.platform==='win32'){
    res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({code:'CLI_NATIVE_OWNER_REQUIRED'}));return;
  }
  const requestContract = validateCliAuthRequest(req);
  if (!requestContract.ok) {
    res.writeHead(requestContract.statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: false, error: requestContract.code }));
    return;
  }
  let sessionToken;
  try { sessionToken = await issueSession({ role: 'owner' }); }
  catch {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ code: 'AUTH_SESSION_STORE_UNAVAILABLE' }));
    return;
  }
  if (!sessionToken) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Session issuance failed');
    return;
  }
  res.writeHead(201, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Set-Cookie': setCookie(sessionToken),
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleHttpRequest(req, res) {
  if (shuttingDown) {
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '1' });
    res.end('Service shutting down');
    return;
  }
  if (req.method === 'POST' && req.url === '/api/cli/auth') {
    void handleCliSocketAuth(req, res);
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz/owner-activation') {
    writeOwnerActivationHealthz(res);
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    writeHealthz(res);
    return;
  }
  const requestLog = apiRequestLog.startApiRequestLog(req, res);
  requestLog.run(() => handleRequest(req, res)).catch(err => {
    requestLog.markError(err);
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      const overloaded = err?.code === 'ADAPTIVE_CONCURRENCY_QUEUE_FULL'
        || err?.code === 'ADAPTIVE_CONCURRENCY_UNAVAILABLE';
      if (overloaded) {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Retry-After': '2',
        });
        res.end(JSON.stringify({
          error: 'Service temporarily busy',
          code: err.code,
          retryAfterMs: 2_000,
        }));
        return;
      }
      const code = typeof err?.code === 'string' ? err.code : '';
      const typedReadError = code.startsWith('SESSION_')
        || code.startsWith('JSON_')
        || code.startsWith('HISTORY_');
      const typedTransportError = code.startsWith('TRANSPORT_')
        || code === 'REQUEST_TIMEOUT'
        || code === 'AUTH_EXPIRED';
      const statusCode = typedReadError
        ? (code === 'SESSION_NOT_FOUND' || code === 'SESSION_HISTORY_MISSING' ? 404 : 409)
        : typedTransportError
          ? (code === 'AUTH_EXPIRED' ? 401 : 504)
          : 500;
      if (typedReadError || typedTransportError) {
        const requestCorrelation = apiRequestLog.getApiRequestCorrelation?.() || {};
        const requestId = typeof requestCorrelation.requestId === 'string' && requestCorrelation.requestId
          ? requestCorrelation.requestId
          : (typeof req.headers?.['x-agentoc-request-id'] === 'string'
            ? req.headers['x-agentoc-request-id'].trim()
            : '');
        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(statusCode === 504 ? { 'Retry-After': '1' } : {}),
        });
        res.end(JSON.stringify({
          error: err?.message || 'Session load failed',
          code,
          stage: err?.stage || (typedReadError ? 'history' : 'transport'),
          retryable: err?.retryable === true || statusCode >= 500,
          ...(requestId ? { requestId } : {}),
          ...(err?.sessionId ? { sessionId: err.sessionId } : {}),
          ...(Number.isInteger(err?.seq) ? { seq: err.seq } : {}),
        }));
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
}

const server = http.createServer(handleHttpRequest);
const cliSocketServer = http.createServer((req, res) => {
  req.isLocalSocket = true;
  handleHttpRequest(req, res);
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;

const chatWebSocketServer = ws.attachWebSocket(server);
let mailWorker = null;
let systemdWatchdog = null;
// P1-B: ownership-tracked CLI identity socket state (module-scope so healthz
// and shutdown can read it; assigned when the socket binds during startup).
let cliSocketBound = false;
let cliSocketIdentity = null;
let cliRuntimeReleased = false;
let stopWindowsServiceStopWatcher = () => {};

async function releaseCliRuntime() {
  if (cliRuntimeReleased) return;
  cliRuntimeReleased = true;
  if (typeof cliTransport.release !== 'function') return;
  try {
    await cliTransport.release();
  } catch (error) {
    console.error(`Failed to release instance runtime: ${error?.message || error}`);
  }
}

function readPositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// Recovery is intentionally scheduled only after the HTTP and WebSocket
// listeners announce readiness. A cold start must be reachable before any
// storage repair or run rehydration consumes disk, heap, or provider slots.
async function runStartupRecovery() {
  if (shuttingDown) return;
  console.log('[startup] background recovery started after listeners became ready');
  try {
    await sessionManager.startDetachedRunObservers();
  } catch (error) {
    console.error('Failed to rehydrate detached runs on startup:', error);
  }
  stopProjectMemoryRecovery = startProjectMemoryRecovery();
  if (shuttingDown) return;
  if (!isEnvToggleEnabled(process.env[STALE_APPROVAL_BACKFILL_ENV], { defaultValue: false })) {
    console.log(`[backfill] stale approval sweep disabled at startup; set ${STALE_APPROVAL_BACKFILL_ENV}=on for an explicit repair pass`);
    return;
  }
  try {
    // Historical approval repair is an opt-in storage migration. It is not
    // part of the normal boot path because it scans every session.
    await sessionManager.sweepStaleApprovalsAcrossSessions?.();
  } catch (error) {
    console.error('Failed to sweep stale approvals on startup:', error);
  }
}

function scheduleStartupRecovery() {
  if (startupRecoveryTimer || shuttingDown) return;
  const delayMs = readNonNegativeIntEnv(STARTUP_RECOVERY_DELAY_ENV, 1000);
  startupRecoveryTimer = setTimeout(() => {
    startupRecoveryTimer = null;
    void runStartupRecovery();
  }, delayMs);
  startupRecoveryTimer.unref?.();
}

async function startDeferredBackgroundServices() {
  // These services are useful only after the control plane is reachable. Keep
  // their code and storage work off the cold listener path; a slow archive,
  // organization repair, or mail poll must not delay the first HTTP/WS check.
  await import('./chat/provider-account-sync-service.mjs')
    .then(({ startProviderAccountSync }) => startProviderAccountSync())
    .catch((error) => console.warn(`[provider-sync] deferred start failed: ${error?.message || error}`));
  try {
    const forkRecovery = await sessionManager.recoverSharedForkHistories?.();
    if (forkRecovery?.repaired > 0) {
      console.warn('[sessions] shared fork history recovery marked sessions hidden', {
        repaired: forkRecovery.repaired,
      });
    }
    const cleanup = await sessionManager.purgeLegacyArchivedSessions();
    if (cleanup.deletedSessionIds.length > 0 || cleanup.skippedSessionIds.length > 0) {
      console.log('[sessions] legacy archive cleanup', {
        deleted: cleanup.deletedSessionIds.length,
        skippedActive: cleanup.skippedSessionIds.length,
      });
    }
  } catch (error) {
    console.warn(`[sessions] deferred archive cleanup failed: ${error?.message || error}`);
  }
  triggers.startTriggerScheduler();
  managedProcesses.startManagedProcessSupervisor();
  runSpoolArchive.startRunArchiveScheduler();
  await import('./chat/collaboration-orchestrator.mjs')
    .then(({ getDefaultCollaborationOrchestrator }) => getDefaultCollaborationOrchestrator().start())
    .catch((error) => console.warn(`[collaboration] deferred start failed: ${error?.message || error}`));
  await import('./chat/orchestration-reconciler.mjs')
    .then(({ startOrchestrationReconciler }) => startOrchestrationReconciler())
    .then((report) => {
      if (report?.status === 'attention') {
        console.warn(`[orchestration-reconciler] startup attention expired=${report.expiredInterrupts.length} stalled=${report.stalledExecutions.length}`);
      }
    })
    .catch((error) => console.warn(`[orchestration-reconciler] deferred start failed: ${error?.message || error}`));
  await import('./chat/organization-reconciler.mjs')
    .then(({ reconcileOrganizationsAtStartup }) => reconcileOrganizationsAtStartup())
    .then((report) => {
      if (report?.enabled && report.organizations?.some((organization) => organization.status === 'blocked')) {
        console.warn('[organization-reconciler] deferred recovery has blockers');
      }
    })
    .catch((error) => console.warn(`[organization-reconciler] deferred recovery failed: ${error?.message || error}`));
  if (!shuttingDown) {
    try {
      const { createFactoryRuntime } = await import('./chat/factory-runtime.mjs');
      factoryRuntime = createFactoryRuntime();
      await factoryRuntime.start();
      if (shuttingDown) await factoryRuntime.stop();
    } catch (error) { console.warn(`[factory] deferred start failed: ${error?.message || error}`); }
  }
  await import('./lib/embedded-mail-worker.mjs')
    .then(({ startEmbeddedMailWorker }) => startEmbeddedMailWorker({
      createSession: sessionManager.createSession,
      submitHttpMessage: sessionManager.submitHttpMessage,
      saveAttachments: sessionManager.saveAttachments,
    }))
    .then((worker) => { mailWorker = worker; })
    .catch((error) => console.warn(`[mail-worker] deferred start failed: ${error?.message || error}`));
  await initWorkspaceLeaseRecovery().catch((error) => {
    console.warn(`[workspace-leases] deferred recovery failed: ${error?.message || error}`);
  });
}

function withShutdownTimeout(task, label, timeoutMs = 4_000) {
  return Promise.race([
    Promise.resolve().then(task).catch((error) => {
      console.error(`[shutdown] ${label} failed: ${error?.message || error}`);
    }),
    new Promise((resolve) => setTimeout(() => {
      console.warn(`[shutdown] ${label} timed out after ${timeoutMs}ms`);
      resolve();
    }, timeoutMs)),
  ]);
}

function closeHttpServer(serverToClose, label) {
  if (!serverToClose?.listening) return Promise.resolve();
  return withShutdownTimeout(() => new Promise((resolve) => {
    try {
      serverToClose.close(() => resolve());
      // Keep-alive or a partially-written request must not hold a service
      // restart hostage. WebSockets have already received their close frame.
      serverToClose.closeIdleConnections?.();
      setTimeout(() => serverToClose.closeAllConnections?.(), 500).unref?.();
    } catch {
      resolve();
    }
  }), label, 2_000);
}

async function shutdown(signal = 'signal') {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  // Gate new issues and abort native/inspection work before any async drain.
  const ownerServiceStop = ownerService?.stop();
  ownerServiceStop?.catch(() => {});
  const ownerActivationStop = ownerActivation?.stop();
  ownerActivationStop?.catch(() => {});
  stopTemporaryPairingPoller();
  stopAccountPairingPoller();
  stopTemporaryControlPoller();
  if (startupRecoveryTimer) {
    clearTimeout(startupRecoveryTimer);
    startupRecoveryTimer = null;
  }
  if (rendezvousPollTimer) {
    clearTimeout(rendezvousPollTimer);
    rendezvousPollTimer = null;
  }
  shutdownPromise = (async () => {
    let ownerDrained = true;
    console.log(`Shutting down chat server (${signal})...`);
    stopWindowsServiceStopWatcher();
    if (selfStopDetector) selfStopDetector.stop();
    // TimeoutStopSec is 30s in the shipped unit. Leave systemd a large margin
    // and never serialize multiple four-second drains into a forced kill.
    const hardStop = setTimeout(() => {
      console.error('[shutdown] hard deadline reached; exiting');
      process.exit(143);
    }, 8_000);
    try {
      systemdWatchdog?.stop();
      stopAdaptiveConcurrency();
      stopAdaptiveConcurrency = () => {};
      stopProjectMemoryRecovery();
      stopProjectMemoryRecovery = () => {};
      memoryRegistry.stopSampler();
      if (mailWorker) mailWorker.stop();
      triggers.stopTriggerScheduler();
      managedProcesses.stopManagedProcessSupervisor();
      runSpoolArchive.stopRunArchiveScheduler();
      if (factoryRuntime) await factoryRuntime.stop();
      try {
        const { stopOrchestrationReconciler } = await import('./chat/orchestration-reconciler.mjs');
        stopOrchestrationReconciler();
      } catch {}
      backgroundAiQueue.stop();
      // Stop observers before any flush so no new recovery work is scheduled
      // while the process is draining.
      sessionManager.killAll();
      // Independent drains run concurrently. A slow optional subsystem must
      // not delay listener shutdown or consume the systemd stop budget.
      await Promise.all([
        withShutdownTimeout(async () => {
          bindingAuthorityRuntime.stopBindingAuthorityMonitor(); await authorityCarriers.dispose();
        }, 'binding authority', 2_000),
        withShutdownTimeout(() => ws.closeWebSocketServer(chatWebSocketServer), 'websocket server', 2_000),
        withShutdownTimeout(() => p2pHostRegistry.stopAllP2PHosts(), 'p2p hosts', 2_000),
        closeHttpServer(server, 'http server'),
        closeHttpServer(cliSocketServer, 'cli server'),
        withShutdownTimeout(async () => {
          try {
            const { stopProviderAccountSync } = await import('./chat/provider-account-sync-service.mjs');
            stopProviderAccountSync();
          } catch {}
        }, 'provider sync', 2_000),
        withShutdownTimeout(async () => {
          try {
            const { stopOwnerAuthPollers } = await import('./lib/owner-account-auth.mjs');
            stopOwnerAuthPollers();
          } catch {}
        }, 'owner-auth pollers', 2_000),
        withShutdownTimeout(() => apiRequestLog.closeApiRequestLog(), 'request log', 2_000),
        withShutdownTimeout(() => usageLedger.closeUsageLedger(), 'usage ledger', 2_000),
        withShutdownTimeout(() => stopFrontendBuildWatchers(), 'frontend watchers', 2_000),
      ]);
      // Flush debounced whole-file rewrites (audit projections + session metas)
      // so a graceful stop never loses the <=800ms write window.
      await Promise.all([
        withShutdownTimeout(() => flushPendingAuditProjections(), 'audit flush', 2_000),
        withShutdownTimeout(() => flushSessionsMetaNow(), 'session meta flush', 2_000),
      ]);
      try {
        // P1-B: only remove the socket this process created; a replacement
        // instance's socket (different inode) is never touched by shutdown.
        if (cliTransport.kind === 'unix-socket' && shouldCleanupSocket(CLI_SOCKET_PATH, cliSocketIdentity)) {
          unlinkSync(CLI_SOCKET_PATH);
        }
      } catch {
        // socket 文件可能已不存在
      }
      await withShutdownTimeout(() => releaseCliRuntime(), 'CLI runtime release');
      // Do not report a clean exit after an unconfirmed Owner endpoint drain.
      // A retained publisher lock requires verified offline recovery, not restart.
      if (ownerServiceStop) {
        try { await Promise.all([ownerServiceStop, ownerActivationStop]); }
        catch { ownerDrained = false; console.error('[owner-ipc] OSV_CLEANUP_UNCONFIRMED'); }
      }
      if (ownerDrained) closeAuthSessionStore();
    } finally {
      clearTimeout(hardStop);
    }
    process.exit(ownerDrained ? 0 : 1);
  })();
  return shutdownPromise;
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
stopWindowsServiceStopWatcher = watchWindowsServiceStop({
  onStop: () => shutdown('windows-service-stop'),
});
// Tripwire for systemd-initiated stops that never deliver SIGTERM to this
// process (2026-08-31 forensics: 72 crash-loop SIGKILLs, zero SIGTERM handler
// runs). Polling the unit SubState catches the deactivation within one
// interval, logs forensic signal state, and drains cleanly instead of
// burning the whole TimeoutStopSec before systemd escalates to SIGKILL.
selfStopDetector = startSelfStopDetector({
  onDetected: ({ subState }) => {
    if (!shuttingDown) void shutdown(`systemd-stop:${subState}`);
  },
});

server.listen(CHAT_PORT, CHAT_BIND_HOST, () => {
  console.log(`Chat server listening on http://${CHAT_BIND_HOST}:${CHAT_PORT}`);
  console.log(`Cookie mode: ${SECURE_COOKIES ? 'Secure (HTTPS)' : 'Non-secure (localhost)'}`);
  if (ownerService && !shuttingDown) {
    void ownerActivation.start({ instanceRoot: INSTANCE_ROOT, instanceId: cliTransport.instanceId,
      port: CHAT_PORT, host: CHAT_BIND_HOST }).catch((error) => {
      const code = /^(OSV|OBD|OBC)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'OSV_UNAVAILABLE';
      console.warn(`[owner-activation] ${code}`);
    });
  }
  stopAdaptiveConcurrency = startAdaptiveConcurrencyController({
    readSignals: () => {
      const eventLoop = readEventLoopWindow();
      const memory = process.memoryUsage();
      const cgroup = lastMemorySnapshot?.process?.cgroup || readCgroupSnapshot();
      const memoryUtilization = Number.isFinite(cgroup?.memoryCurrentBytes)
        && Number.isFinite(cgroup?.memoryMaxBytes)
        && cgroup.memoryMaxBytes > 0
        ? cgroup.memoryCurrentBytes / cgroup.memoryMaxBytes
        : memory.heapTotal > 0
          ? memory.heapUsed / memory.heapTotal
          : null;
      return {
        eventLoopUtilization: eventLoop.utilization,
        eventLoopDelayP99Ms: eventLoop.p99,
        memoryUtilization,
      };
    },
  });
  // Frequent, durable samples preserve the last healthy state before a
  // watchdog kills a blocked process. The file keeps aggregate/runtime facts
  // only, never histories, prompts, tokens, or environment values.
  // DS-06: periodic memory/performance sampler. Keeps a bounded ring of full
  // snapshots for /api/diagnostics/memory; the timer is unref'd so it never
  // keeps the process alive. Cadence/size are env-tunable for rollback.
  memoryRegistry.configureSampler({
    collect: () => {
      lastMemorySnapshot = buildMemorySnapshot();
      return lastMemorySnapshot;
    },
    onSample: persistForensicSnapshot,
    intervalMs: readPositiveIntEnv('AGENTOC_MEMORY_SAMPLER_INTERVAL_MS', 5_000),
    maxSamples: readPositiveIntEnv('AGENTOC_MEMORY_SAMPLER_MAX_SAMPLES', 360),
  });
  memoryRegistry.startSampler();
  listenersReadyAtMs = Date.now();
  authorityListenerReady = true;
  void bindingAuthorityRuntime.startBindingAuthorityMonitor();
  void import('./chat/temporary-pairing-runtime.mjs').then(({ startTemporaryPairingPoller }) => startTemporaryPairingPoller({
    onError: (code) => console.warn(`[temporary-pairing] ${code}`),
  })).then((stop) => {
    if (shuttingDown) stop(); else stopTemporaryPairingPoller = stop;
  }).catch((error) => console.warn(`[temporary-pairing] ${/^temporary_[a-z0-9_]{1,65}$/.test(error?.code || '') ? error.code : 'temporary_host_unavailable'}`));
  void import('./chat/account-pairing-service.mjs').then(({ startAccountPairingPoller }) => startAccountPairingPoller({
    onError: (error) => console.warn('[account-pairing] automatic handoff unavailable', /^account_pairing_[a-z_]+$/.test(error?.code || '') ? error.code : 'account_pairing_unavailable'),
  })).then((stop) => {
    if (shuttingDown) stop(); else stopAccountPairingPoller = stop;
  }).catch(() => console.warn('[account-pairing] deferred poller start failed'));
  void import('./chat/temporary-control-runtime.mjs').then(({ startTemporaryControlPoller }) => startTemporaryControlPoller({
    onError: (code) => console.warn(`[temporary-control] ${code}`),
  })).then((stop) => {
    if (shuttingDown) stop(); else stopTemporaryControlPoller = stop;
  }).catch((error) => console.warn(`[temporary-control] ${/^temporary_[a-z0-9_]{1,65}$/.test(error?.code || '') ? error.code : 'temporary_control_unavailable'}`));
  void systemdNotify.systemdNotify({ ready: true, status: 'AgentoC chat server listening' });
  systemdWatchdog = systemdNotify.startSystemdWatchdog({
    status: () => `AgentoC chat server healthy; uptime=${Math.round(process.uptime())}s`,
  });
  // P2P Host lifecycle is per trusted account device, not per invitation.
  // Start it after the control-plane listener is reachable so a slow signaling
  // provider cannot delay systemd readiness or the first HTTP request.
  if (isEnvToggleEnabled(process.env[P2P_HOST_RECOVERY_ENV], { defaultValue: true })) {
    void restoreAccountP2PHosts().catch((error) => {
      console.warn(`[p2p-host] account device recovery failed: ${error?.message || error}`);
    });
  } else {
    console.log(`[p2p-host] account device recovery disabled by ${P2P_HOST_RECOVERY_ENV}`);
  }
  scheduleStartupRecovery();
  const deferredTimer = setTimeout(() => { void startDeferredBackgroundServices(); }, 1000);
  deferredTimer.unref?.();
});
// P1-B: Unix uses the existing socket probe. Windows uses the P0-1 durable
// ownership marker acquired by bootstrapInstanceRuntime; the named pipe is
// bound exclusively by the listener below.
if (cliTransport.kind === 'unix-socket') {
  const cliSocketProbe = await probeCliSocketPath(CLI_SOCKET_PATH, {
    connectTimeoutMs: 300,
  });
  if (cliSocketProbe.action === 'active') {
    console.error(`Another chat-server instance owns ${CLI_SOCKET_PATH} (${E_SOCKET_ALREADY_ACTIVE}); refusing to start`);
    process.exit(1);
  }
  if (cliSocketProbe.action === 'error') {
    console.error(`Refusing to touch CLI socket ${CLI_SOCKET_PATH}: ${cliSocketProbe.message} (${cliSocketProbe.code})`);
    process.exit(1);
  }
  if (cliSocketProbe.action === 'removeStale') {
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!mayRemoveStaleSocket(cliSocketProbe.stats, { expectedUid })) {
      console.error(`Stale socket ${CLI_SOCKET_PATH} is not owned by this user; refusing to remove (${E_CLI_SOCKET_UNSAFE})`);
      process.exit(1);
    }
    try {
      unlinkSync(CLI_SOCKET_PATH);
    } catch (err) {
      console.error(`Failed to remove stale CLI socket ${CLI_SOCKET_PATH}: ${err?.message || err}`);
      process.exit(1);
    }
  }
}
cliSocketServer.on('error', (err) => {
  console.error(`CLI socket server error: ${err?.message || err}`);
  if (!cliSocketBound) {
    // A bind-phase failure must fail the service, not leave it "HTTP healthy"
    // without a CLI identity transport.
    const code = err?.code === 'EADDRINUSE' ? E_SOCKET_ALREADY_ACTIVE : E_CLI_SOCKET_MISSING;
    console.error(`Failed to bind CLI endpoint ${cliTransport.endpoint} (${code}): ${err?.message || err}`);
    void releaseCliRuntime().finally(() => process.exit(1));
  }
});
cliSocketServer.listen(cliListenTarget, () => {
  // unix socket 默认权限受 umask 影响（可能过宽），收紧为仅属主可连
  if (cliTransport.kind === 'unix-socket') {
    try {
      chmodSync(CLI_SOCKET_PATH, 0o600);
    } catch {
      // 忽略权限设置失败，仍可连接
    }
  }
  cliSocketBound = true;
  cliSocketIdentity = cliTransport.kind === 'unix-socket'
    ? recordSocketIdentity(CLI_SOCKET_PATH)
    : null;
  console.log(`CLI identity ${cliTransport.kind} ready at ${cliTransport.endpoint}`);
});
