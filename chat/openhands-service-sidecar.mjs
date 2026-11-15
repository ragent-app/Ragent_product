// Detached lifecycle bridge for the OpenHands Agent Server.
//
// This is intentionally separate from runner-sidecar's stdio provider loop:
// Agent Server owns the agent process and emits typed events over WebSocket.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';

import {
  OpenHandsServiceClient,
  buildOpenHandsAgent,
  buildOpenHandsCreateConversationPayload,
  bridgeOpenHandsServiceEvent,
} from './adapters/openhands-service.mjs';
import {
  buildPlatformSpawnSpec,
  resolveExecutableCommandPathAsync,
} from '../lib/executable-resolution.mjs';
import {
  spawnManagedProcess,
  terminateProviderProcessTree,
} from '../lib/windows-managed-spawn.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Agent Server may spend several minutes in model/tool work without emitting
// a WebSocket event. Keep the first-event readiness guard short, but give a
// connected conversation a bounded long-running idle budget.
const DEFAULT_OPENHANDS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OPENHANDS_STREAM_START_TIMEOUT_MS = 45 * 1000;
const DEFAULT_OPENHANDS_EVENT_QUEUE_MAX = 1024;
const DEFAULT_OPENHANDS_EVENT_QUEUE_BYTES = 16 * 1024 * 1024;

function positiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(client, { attempts = 60, delayMs = 250 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // A spawned service can accept TCP before its HTTP handler is ready.
      // Bound each probe independently so one half-open connection cannot
      // stretch the whole readiness loop indefinitely.
      await Promise.race([
        client.request('/server_info'),
        sleep(Math.max(1_000, delayMs * 4)).then(() => {
          throw Object.assign(new Error('OpenHands Agent Server readiness probe timed out'), {
            code: 'OPENHANDS_READINESS_TIMEOUT',
          });
        }),
      ]);
      return;
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }
  throw lastError || new Error('OpenHands Agent Server did not become ready');
}

function serviceOptions(manifest = {}) {
  return manifest.options?.openhandsService || {};
}

function parseGeneratedEnv(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    try { values[match[1]] = JSON.parse(match[2]); } catch { /* generated files only */ }
  }
  return values;
}

async function readPreparedProviderEnv({ environment = process.env, readFileImpl = readFile } = {}) {
  const root = typeof environment?.RAGENT_PROVIDER_HOMES_DIR === 'string'
    ? environment.RAGENT_PROVIDER_HOMES_DIR.trim()
    : '';
  if (!root) return {};
  const home = join(root, 'openhands');
  const [generic, openhands] = await Promise.all([
    readFileImpl(join(home, '.ragent-provider.env'), 'utf8').catch(() => ''),
    readFileImpl(join(home, '.ragent-openhands.env'), 'utf8').catch(() => ''),
  ]);
  return { ...parseGeneratedEnv(generic), ...parseGeneratedEnv(openhands) };
}

/**
 * Start a locally owned Agent Server through the same platform boundary as
 * other controlled children. The injected hooks keep the sidecar testable;
 * the production path resolves Windows .cmd/.bat/.ps1 entries and places the
 * resulting process tree in a Windows Job Object.
 */
export async function spawnOpenHandsServiceProcess({
  command,
  args = [],
  cwd,
  env,
  spawnImpl = null,
  resolveCommandPathImpl = resolveExecutableCommandPathAsync,
  spawnManagedImpl = spawnManagedProcess,
  assertLaunchBoundary = null,
} = {}) {
  const resolved = await resolveCommandPathImpl(command);
  if (!resolved) {
    const error = new Error(`OpenHands Agent Server command not found: ${command}`);
    error.code = 'OPENHANDS_SERVICE_COMMAND_NOT_FOUND';
    throw error;
  }
  const spawnSpec = buildPlatformSpawnSpec(resolved, args, { cwd, env });
  const spawnOptions = {
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: spawnSpec.shell,
    ...(spawnSpec.windowsVerbatimArguments === true
      ? { windowsVerbatimArguments: true }
      : {}),
  };
  if (assertLaunchBoundary) await assertLaunchBoundary();
  if (typeof spawnImpl === 'function') {
    return spawnImpl(spawnSpec.file, spawnSpec.args, spawnOptions);
  }
  return spawnManagedImpl(spawnSpec, {
    stdio: spawnOptions.stdio,
    preserveOnControllerExit: false,
    ...(assertLaunchBoundary ? { assertAuthorization: assertLaunchBoundary } : {}),
  });
}

/**
 * Run one OpenHands conversation and return a normal detached-run result.
 * `append` receives both raw Agent Server events and bridged Harness events.
 * `readRun` is polled only for the durable cancel request, so cancellation
 * remains controlled by Ragent rather than by an in-memory UI state.
 */
export async function runOpenHandsServiceSidecar({
  runId,
  manifest = {},
  prompt,
  cwd,
  append,
  readRun,
  updateRun,
  serviceCommand = 'agent-canvas',
  serviceArgs = [],
  spawnImpl = null,
  resolveCommandPathImpl = resolveExecutableCommandPathAsync,
  spawnManagedImpl = spawnManagedProcess,
  clientFactory = (options) => new OpenHandsServiceClient(options),
  fetchImpl = globalThis.fetch,
  WebSocketImpl = WebSocket,
  environment = process.env,
  readFileImpl = readFile,
  assertLaunchBoundary = null,
} = {}) {
  if (typeof append !== 'function' || typeof readRun !== 'function' || typeof updateRun !== 'function') {
    throw new Error('OpenHands service sidecar requires run persistence callbacks');
  }
  const configured = serviceOptions(manifest);
  const idleTimeoutMs = positiveDuration(
    configured.idleTimeoutMs || environment.RAGENT_OPENHANDS_IDLE_TIMEOUT_MS,
    DEFAULT_OPENHANDS_IDLE_TIMEOUT_MS,
  );
  const streamStartTimeoutMs = positiveDuration(
    configured.streamStartTimeoutMs || environment.RAGENT_OPENHANDS_STREAM_START_TIMEOUT_MS,
    DEFAULT_OPENHANDS_STREAM_START_TIMEOUT_MS,
  );
  const requestTimeoutMs = positiveDuration(
    configured.requestTimeoutMs || environment.RAGENT_OPENHANDS_REQUEST_TIMEOUT_MS,
    30_000,
  );
  const eventQueueMax = positiveInteger(
    configured.eventQueueMax || environment.RAGENT_OPENHANDS_EVENT_QUEUE_MAX,
    DEFAULT_OPENHANDS_EVENT_QUEUE_MAX,
  );
  const eventQueueMaxBytes = positiveDuration(
    configured.eventQueueMaxBytes || environment.RAGENT_OPENHANDS_EVENT_QUEUE_BYTES,
    DEFAULT_OPENHANDS_EVENT_QUEUE_BYTES,
  );
  // The service runtime bypasses the ordinary process-runner cleanEnv path.
  // Load the broker-generated, per-Run provider files here so a prepared
  // profile is not silently replaced by an empty/default OpenHands LLM.
  const preparedEnv = await readPreparedProviderEnv({ environment, readFileImpl });
  const apiKey = String(configured.apiKey || environment.LOCAL_BACKEND_API_KEY || randomBytes(24).toString('hex'));
  let child = null;
  let host = String(configured.host || '').trim().replace(/\/+$/, '');
  let ownedService = false;

  if (!host) {
    const port = await freePort();
    host = `http://127.0.0.1:${port}`;
    const configuredArgs = Array.isArray(serviceArgs) && serviceArgs.length > 0
      ? serviceArgs
      : (Array.isArray(configured.args) ? configured.args : []);
    const args = [...configuredArgs, '--backend-only', '--port', String(port)];
    child = await spawnOpenHandsServiceProcess({
      command: serviceCommand,
      args,
      cwd,
      env: { ...environment, ...(configured.env && typeof configured.env === 'object' ? configured.env : {}), LOCAL_BACKEND_API_KEY: apiKey },
      spawnImpl,
      resolveCommandPathImpl,
      spawnManagedImpl,
      assertLaunchBoundary,
    });
    child?.on?.('error', () => {});
    ownedService = true;
  }

  const client = clientFactory({ host, apiKey, fetchImpl, WebSocketImpl, requestTimeoutMs });
  const cleanup = () => {
    // `killed` only records that kill() was requested; the process may still
    // be alive while its children drain. Use terminal state fields so cleanup
    // always closes an owned service tree after a failed readiness/stream run.
    if (child && child.exitCode == null && child.signalCode == null) {
      terminateProviderProcessTree(child, 'SIGTERM');
      const killTimer = setTimeout(() => {
        terminateProviderProcessTree(child, 'SIGKILL');
      }, 2_000);
      killTimer.unref?.();
    }
  };
  try {
    await append({ type: 'openhands.service.started', host, ownedService });
    await waitForServer(client);
    const agent = buildOpenHandsAgent({
      model: configured.model || manifest.options?.model || preparedEnv.LLM_MODEL || preparedEnv.RAGENT_PROVIDER_MODEL,
      apiKey: configured.llmApiKey || preparedEnv.LLM_API_KEY || preparedEnv.RAGENT_PROVIDER_API_KEY,
      baseUrl: configured.baseUrl || preparedEnv.LLM_BASE_URL || preparedEnv.RAGENT_PROVIDER_BASE_URL,
      agentKind: configured.agentKind || 'Agent',
      agentContext: configured.agentContext,
    });
    const priorRun = await readRun(runId);
    const resumedConversationId = String(
      configured.conversationId || priorRun?.openHandsConversationId || '',
    ).trim();
    if (assertLaunchBoundary) await assertLaunchBoundary();
    const conversation = resumedConversationId
      ? await client.getConversation(resumedConversationId)
      : await client.createConversation(buildOpenHandsCreateConversationPayload({
        agent,
        workingDir: cwd,
        initialMessage: prompt,
        maxIterations: configured.maxIterations,
        stuckDetection: configured.stuckDetection,
        userId: configured.userId,
      }));
    const conversationId = resumedConversationId || conversation?.id || conversation?.conversation_id;
    if (!conversationId) throw new Error('OpenHands did not return a conversation id');
    await updateRun((current) => ({ ...current, openHandsConversationId: conversationId, openHandsServiceHost: host }));
    await append({ type: 'openhands.conversation.created', conversationId });

    let socket;
    let responseInFlight = false;
    let cancelCheckInFlight = false;
    let settled = false;
    let resolveDone;
    let rejectDone;
    let streamStartTimer = null;
    let idleTimer = null;
    let lastEventAt = Date.now();
    let sawEvent = false;
    let pendingEventCount = 0;
    let pendingEventBytes = 0;
    let eventQueuePaused = false;
    let droppedDeltaCount = 0;
    let droppedEventDiagnosticSent = false;
    let eventProcessingPromise = Promise.resolve();
    const openHandsToolCalls = new Map();
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (streamStartTimer) clearTimeout(streamStartTimer);
      if (idleTimer) clearInterval(idleTimer);
      resolveDone(result);
    };
    const pauseEventSocketIfNeeded = () => {
      if (eventQueuePaused || !socket) return;
      if (pendingEventCount <= eventQueueMax && pendingEventBytes <= eventQueueMaxBytes) return;
      eventQueuePaused = true;
      try { socket._socket?.pause?.(); } catch {}
    };
    const resumeEventSocketIfPossible = () => {
      if (!eventQueuePaused) return;
      if (pendingEventCount > Math.max(1, Math.floor(eventQueueMax / 2))
        || pendingEventBytes > Math.max(1, Math.floor(eventQueueMaxBytes / 2))) return;
      eventQueuePaused = false;
      try { socket?._socket?.resume?.(); } catch {}
    };
    const eventSize = (event) => {
      try { return Buffer.byteLength(JSON.stringify(event), 'utf8'); } catch { return 1024; }
    };
    const isCriticalEvent = (bridged) => (bridged || []).some((mapped) => [
      'run.completed', 'run.failed', 'tool.approval_required', 'run.waiting',
    ].includes(mapped?.type));
    const appendDropDiagnostic = () => {
      if (droppedEventDiagnosticSent) return;
      droppedEventDiagnosticSent = true;
      void append({
        type: 'openhands.event_queue_overflow',
        conversationId,
        droppedStreamingEvents: droppedDeltaCount,
        maxEvents: eventQueueMax,
        maxBytes: eventQueueMaxBytes,
      }).catch(() => {});
    };
    const processEvent = async (event, bridged) => {
      await append({ type: 'openhands.event', conversationId, event });
      for (const mapped of bridged) {
        await append(mapped);
        if (mapped.type === 'tool.approval_required') {
          await updateRun((current) => ({
            ...current,
            state: 'waiting_user',
            appServerPendingApprovals: [
              ...(Array.isArray(current?.appServerPendingApprovals) ? current.appServerPendingApprovals : []),
              {
                approvalId: mapped.approvalId,
                providerRequestId: mapped.approvalId,
                providerRequestIdString: mapped.approvalId,
                providerMethod: 'openhands/confirmation',
                kind: 'confirmation',
                request: event,
                state: 'pending',
                createdAt: new Date().toISOString(),
              },
            ].filter((entry, index, list) => list.findIndex((candidate) => candidate.approvalId === entry.approvalId) === index),
          }));
        }
        if (['run.completed', 'run.failed'].includes(mapped.type)) {
          finish({ event: mapped, conversationId });
        }
      }
    };
    const enqueueEvent = (event) => {
      lastEventAt = Date.now();
      sawEvent = true;
      if (streamStartTimer) {
        clearTimeout(streamStartTimer);
        streamStartTimer = null;
      }
      const bridged = bridgeOpenHandsServiceEvent(event, { toolCalls: openHandsToolCalls });
      const bytes = eventSize(event);
      const overLimit = pendingEventCount >= eventQueueMax
        || pendingEventBytes + bytes > eventQueueMaxBytes;
      if (overLimit && !isCriticalEvent(bridged)) {
        // Streaming deltas are superseded by the next durable projection. If
        // the WebSocket implementation cannot be paused (as in some test
        // clients), drop only these high-volume intermediate frames rather
        // than retaining an unbounded Promise chain.
        droppedDeltaCount += 1;
        appendDropDiagnostic();
        return;
      }
      pendingEventCount += 1;
      pendingEventBytes += bytes;
      pauseEventSocketIfNeeded();
      eventProcessingPromise = eventProcessingPromise
        .then(() => processEvent(event, bridged))
        .catch((error) => { rejectDone(error); })
        .finally(() => {
          pendingEventCount = Math.max(0, pendingEventCount - 1);
          pendingEventBytes = Math.max(0, pendingEventBytes - bytes);
          resumeEventSocketIfPossible();
        });
    };
    socket = client.connectEvents(conversationId, {
      onEvent: (event) => {
        try {
          enqueueEvent(event);
        } catch (error) {
          rejectDone(error instanceof Error ? error : new Error(String(error)));
        }
      },
      onError: (error) => rejectDone(error instanceof Error ? error : new Error('OpenHands WebSocket error')),
      onClose: () => { if (!settled) rejectDone(new Error('OpenHands event socket closed before terminal event')); },
    });
    streamStartTimer = setTimeout(() => {
      if (!sawEvent && !settled) {
        finish({
          event: { type: 'run.failed', content: `OpenHands event stream produced no event within ${streamStartTimeoutMs}ms` },
          conversationId,
        });
      }
    }, streamStartTimeoutMs);
    streamStartTimer.unref?.();
    idleTimer = setInterval(() => {
      if (settled || Date.now() - lastEventAt < idleTimeoutMs) return;
      finish({
        event: { type: 'run.failed', content: `OpenHands event stream idle timeout after ${idleTimeoutMs}ms` },
        conversationId,
      });
      void client.interruptConversation(conversationId).catch(() => {});
    }, Math.min(5_000, Math.max(250, Math.floor(idleTimeoutMs / 4))));
    idleTimer.unref?.();
    if (assertLaunchBoundary) await assertLaunchBoundary();
    await client.runConversation(conversationId);
    const cancelTimer = setInterval(() => {
      void (async () => {
        if (settled || responseInFlight || cancelCheckInFlight) return;
        cancelCheckInFlight = true;
        try {
          const current = await readRun(runId);
          const queued = Array.isArray(current?.appServerApprovalResponseQueue)
            ? current.appServerApprovalResponseQueue.find((entry) => entry?.state !== 'sent')
            : null;
          if (queued?.approvalId) {
            responseInFlight = true;
            try {
              const decision = String(queued.decision || '').toLowerCase();
              const accepted = decision === 'approve' || decision === 'approved' || decision === 'approve_for_session';
              await client.respondToConfirmation(conversationId, { accept: accepted, reason: queued.reason || '' });
              await updateRun((latest) => ({
                ...latest,
                appServerPendingApprovals: (Array.isArray(latest?.appServerPendingApprovals) ? latest.appServerPendingApprovals : []).map((entry) => entry.approvalId === queued.approvalId ? { ...entry, state: 'responded', decision } : entry),
                appServerApprovalResponseQueue: (Array.isArray(latest?.appServerApprovalResponseQueue) ? latest.appServerApprovalResponseQueue : []).map((entry) => entry.id === queued.id ? { ...entry, state: 'sent', sentAt: new Date().toISOString() } : entry),
              }));
              await append({ type: 'ragent.approval_response', approvalId: queued.approvalId, decision, status: accepted ? 'approved' : 'denied' });
            } finally {
              responseInFlight = false;
            }
            return;
          }
          if (current?.cancelRequested === true) {
            try { await client.interruptConversation(conversationId); } catch {}
            finish({ cancelled: true, conversationId });
          }
        } finally {
          cancelCheckInFlight = false;
        }
      })().catch((error) => {
        if (!settled) rejectDone(error instanceof Error ? error : new Error(String(error)));
      });
    }, 500);
    try {
      const result = await done;
      await eventProcessingPromise;
      return result;
    } finally {
      clearInterval(cancelTimer);
      if (streamStartTimer) clearTimeout(streamStartTimer);
      if (idleTimer) clearInterval(idleTimer);
      try { socket?.close(); } catch {}
    }
  } finally {
    cleanup();
  }
}
