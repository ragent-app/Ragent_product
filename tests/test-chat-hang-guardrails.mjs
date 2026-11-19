#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const server = readFileSync(join(repoRoot, 'chat-server.mjs'), 'utf8');
const routes = readFileSync(join(repoRoot, 'chat/router-session-main-routes.mjs'), 'utf8');
const history = readFileSync(join(repoRoot, 'chat/history.mjs'), 'utf8');
const sessionManager = readFileSync(join(repoRoot, 'chat/session-manager.mjs'), 'utf8');
const inspector = readFileSync(join(repoRoot, 'static/chat/workbench-inspector.js'), 'utf8');
const push = readFileSync(join(repoRoot, 'chat/push.mjs'), 'utf8');

assert.match(server, /monitorEventLoopDelay/, 'chat server should expose event-loop health metrics');
assert.match(server, /req\.method === 'GET' && req\.url === '\/healthz'/, 'chat server should expose a lightweight /healthz endpoint');
assert.match(server, /server\.requestTimeout = 30000/, 'chat server should bound ordinary HTTP request runtime');
assert.match(server, /server\.headersTimeout = 10000/, 'chat server should bound header stalls');
assert.match(server, /const chatWebSocketServer = ws\.attachWebSocket\(server\)/, 'chat server should retain the WebSocket server for bounded shutdown');
assert.match(server, /ws\.closeWebSocketServer\(chatWebSocketServer\)/, 'chat server should close WebSocket clients before HTTP drain');
assert.match(server, /backgroundAiQueue\.stop\(\)/, 'shutdown must drop queued background provider work');
assert.match(server, /serverToClose\.closeAllConnections\?\.\(\)/, 'shutdown must force lingering HTTP connections closed');
assert.match(server, /\}, 8_000\);/, 'shutdown must leave a large margin before systemd TimeoutStopSec');
assert.match(server, /clearTimeout\(rendezvousPollTimer\)/, 'rendezvous shutdown should clear its one-shot timer');
const rendezvousScheduleIndex = server.indexOf('rendezvousPollTimer = setTimeout');
const lifecycleStateIndex = server.indexOf('let shuttingDown = false;');
assert.ok(rendezvousScheduleIndex >= 0, 'rendezvous polling should use a one-shot timer');
assert.ok(lifecycleStateIndex >= 0 && lifecycleStateIndex < rendezvousScheduleIndex, 'shutdown state must be initialized before rendezvous callbacks can run');
assert.doesNotMatch(server, /rendezvousPollTimer = setInterval/, 'rendezvous polling must not run on a fixed unbounded interval');
assert.match(server, /RENDEZVOUS_TIMER_MAX_DELAY_MS/, 'rendezvous timer must avoid overflow without shortening broker cooldowns');

// Startup recovery must not delay the first reachable HTTP/WS listener, scan
// every historical session, or run the one-time stale-approval migration on
// every ordinary boot. These are the three resource spikes that previously
// made a fresh instance look like a reconnecting client.
assert.match(server, /const STARTUP_RECOVERY_DELAY_ENV = 'RAGENT_STARTUP_RECOVERY_DELAY_MS'/, 'startup recovery should have an explicit delay setting');
assert.match(server, /const STALE_APPROVAL_BACKFILL_ENV = 'RAGENT_STALE_APPROVAL_BACKFILL'/, 'stale approval backfill should be explicitly gated');
assert.match(
  server,
  /isEnvToggleEnabled\(process\.env\[STALE_APPROVAL_BACKFILL_ENV\],\s*\{\s*defaultValue: false\s*\}\)/,
  'stale approval backfill must be opt-in during startup',
);
const startupRecoveryIndex = server.indexOf('async function runStartupRecovery()');
const startupScheduleIndex = server.indexOf('function scheduleStartupRecovery()');
assert.ok(startupRecoveryIndex >= 0 && startupScheduleIndex > startupRecoveryIndex, 'startup recovery helpers should remain a bounded block');
const startupRecoverySource = server.slice(startupRecoveryIndex, startupScheduleIndex);
assert.match(startupRecoverySource, /await sessionManager\.startDetachedRunObservers\(\)/, 'startup recovery should still reattach active runs');
assert.doesNotMatch(startupRecoverySource, /listSessions\(/, 'startup recovery must not build an enriched full session list');
const startupListenerIndex = server.indexOf("server.listen(CHAT_PORT, CHAT_BIND_HOST, () => {");
const startupCallIndex = server.indexOf('scheduleStartupRecovery();');
assert.ok(startupListenerIndex >= 0 && startupCallIndex > startupListenerIndex, 'recovery should be scheduled after the listener is ready');

const observerStart = sessionManager.indexOf('export async function startDetachedRunObservers()');
const observerEnd = sessionManager.indexOf('export async function listSessions(', observerStart);
assert.ok(observerStart >= 0 && observerEnd > observerStart, 'detached-run observer startup should remain an inspectable block');
const observerSource = sessionManager.slice(observerStart, observerEnd);
assert.match(observerSource, /const allSessions = await loadSessionsMeta\(\)/, 'observer startup should use compact session metadata');
assert.match(observerSource, /const sessions = allSessions\.filter\(\(meta\) => \([\s\S]*?!!meta\?\.activeRunId[\s\S]*?getPendingPlanningQueueCount\(meta\)[\s\S]*?getFollowUpQueueCount\(meta\)/, 'observer startup should select only recovery candidates');
assert.match(observerSource, /resumePendingCompletionTargets\(\{ targetSessionIds: completionTargetSessionIds \}\)/, 'completion recovery should be restricted to advertised target sessions');

const completionSource = readFileSync(join(repoRoot, 'chat/session-turn-completion.mjs'), 'utf8');
assert.match(completionSource, /if \(sessionFilter && sessionFilter\.size === 0\) return 0;/, 'empty completion-target metadata must skip the run-directory scan');

const syncStart = sessionManager.indexOf('async function syncDetachedRunUnlocked(');
const dedupStart = sessionManager.indexOf('if (durableEvents.length > 0) {', syncStart);
const dedupEnd = sessionManager.indexOf('const deltaPushEvents', dedupStart);
assert.ok(syncStart >= 0 && dedupStart > syncStart && dedupEnd > dedupStart, 'detached-run dedup block should remain inspectable');
const dedupSource = sessionManager.slice(dedupStart, dedupEnd);
assert.doesNotMatch(dedupSource, /loadHistory\(sessionId,\s*\{\s*includeBodies:\s*false\s*\}\)/, 'provider dedup sync must not materialize a full uncached history');
assert.doesNotMatch(dedupSource, /buildKnownDedupKeySet|filterDuplicateProviderEvents/, 'provider dedup sync must use the bounded scanner path');
assert.match(sessionManager, /async function scanProviderDedupKeys\([\s\S]*?forEachStoredEvent\(sessionId/, 'provider dedup must scan stored events without populating history caches');

assert.match(history, /export async function readEventsPage/, 'history should expose a bounded paginated event reader');
assert.match(history, /events\.length >= limit/, 'paginated event reads should stop at the requested limit');
assert.match(sessionManager, /export async function getSessionEventsPage/, 'session manager should expose bounded event pages');
assert.match(routes, /DEFAULT_ALL_EVENTS_PAGE_LIMIT = 200/, 'all-events route should default to a bounded page');
assert.match(routes, /MAX_ALL_EVENTS_PAGE_LIMIT = 500/, 'all-events route should clamp page size');
assert.match(routes, /MAX_ALL_EVENTS_RESPONSE_BYTES/, 'all-events route should cap aggregate response bytes');
assert.match(routes, /MAX_ALL_EVENTS_BODY_BYTES/, 'all-events route should cap hydrated body bytes');
assert.match(history, /truncatedByBytes/, 'history page metadata should expose byte-budget truncation');
assert.doesNotMatch(
  routes,
  /if \(filter === 'all'\) \{\s*const events = await getSessionEventsAfter\(sessionId, 0,/,
  'all-events route must not materialize the full session from seq 0',
);
assert.match(routes, /getSessionEventsPage\(sessionId/, 'all-events route should use bounded pages');
assert.match(routes, /pagination/, 'all-events route should return pagination metadata');
assert.match(routes, /ensureSessionAuditProjection\(sessionId,\s*\{\s*latestSeq\s*\}\)/, 'projection route should read the maintained lightweight projection');
assert.doesNotMatch(
  routes,
  /ensureSessionAuditProjection\(sessionId,[\s\S]*?loadEvents/,
  'projection route must not rebuild by scanning full session events during ordinary UI opens',
);

assert.match(inspector, /INSPECTOR_EVENT_PAGE_LIMIT = 150/, 'Workbench Inspector should fetch bounded event pages');
assert.match(inspector, /MAX_INSPECTOR_EVENT_PAGES = 3/, 'Workbench Inspector should cap page count');
assert.doesNotMatch(
  inspector,
  /events\?filter=all`/,
  'Workbench Inspector must not request unbounded all-events payloads',
);
assert.match(
  inspector,
  /fetchSessionProjection\(targetSessionId,\s*\{\s*view:\s*"audit",\s*forceFresh\s*\}\)/,
  'Workbench Inspector regular refresh should load the lightweight session projection',
);
assert.doesNotMatch(
  inspector,
  /fetchAllSessionEvents\(targetSessionId/,
  'Workbench Inspector regular refresh must not call the all-events fetcher',
);
assert.match(
  inspector,
  /\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/projection/,
  'Workbench Inspector should request the projection endpoint for audit/run-sheet data',
);

assert.match(push, /PUSH_SEND_CONCURRENCY/, 'web push fan-out should expose a bounded concurrency budget');
assert.match(push, /sendable\.length/, 'web push should schedule only active subscriptions');
const sidecar = readFileSync(join(repoRoot, 'chat/runner-sidecar.mjs'), 'utf8');
assert.match(sidecar, /DEFAULT_PROVIDER_STDOUT_LINE_MAX_BYTES/, 'runner sidecar should bound individual provider stdout lines');
assert.match(sidecar, /provider-stdout-line-limit/, 'oversized provider frames should produce a durable diagnostic');
assert.match(sidecar, /lineBytes > stdoutLineMaxBytes/, 'oversized provider frames should be rejected before JSON parsing');

const compaction = readFileSync(join(repoRoot, 'chat/session-auto-compaction.mjs'), 'utf8');
assert.match(compaction, /readEventsPage\(sessionId/, 'compaction should read bounded head/tail pages');
assert.match(compaction, /tailStart > headEnd/, 'compaction should avoid rereading overlapping head/tail windows');
assert.doesNotMatch(
  compaction,
  /async function loadCompactionHistory[\s\S]*?forEachStoredEvent\(sessionId/,
  'compaction history must not scan every stored event on a large session',
);

const latestLookupStart = sessionManager.indexOf('async function findLatestStoredEvent(');
const latestLookupEnd = sessionManager.indexOf('\n}\n\nasync function loadRecentTurnHistory', latestLookupStart);
assert.ok(latestLookupStart >= 0 && latestLookupEnd > latestLookupStart, 'latest-event lookup helper should remain inspectable');
const latestLookupSource = sessionManager.slice(latestLookupStart, latestLookupEnd);
assert.match(latestLookupSource, /readEventsPage\(sessionId/, 'latest-event lookup should walk reverse pages');
assert.match(latestLookupSource, /hasMoreBefore/, 'latest-event lookup should preserve exact cold-path fallback');
assert.doesNotMatch(latestLookupSource, /forEachStoredEvent\(sessionId/, 'latest-event lookup must not scan forward from seq 1');
const publicationLookupStart = sessionManager.indexOf('async function findReplyPublicationRunByResponseId(');
const publicationLookupEnd = sessionManager.indexOf('\n}\n\nasync function buildReplyPublicationFromRun', publicationLookupStart);
assert.ok(publicationLookupStart >= 0 && publicationLookupEnd > publicationLookupStart, 'reply publication lookup should remain inspectable');
const publicationLookupSource = sessionManager.slice(publicationLookupStart, publicationLookupEnd);
assert.match(publicationLookupSource, /findLatestStoredEvent\(sessionId/, 'reply publication retries should use reverse event lookup');
assert.doesNotMatch(publicationLookupSource, /forEachStoredEvent\(sessionId/, 'reply publication retries must not scan forward from seq 1');
const planLookupStart = sessionManager.indexOf('async function findLatestPlanArtifact(');
const planLookupEnd = sessionManager.indexOf('\n}\n\nfunction buildPlanActionPrompt', planLookupStart);
assert.ok(planLookupStart >= 0 && planLookupEnd > planLookupStart, 'plan artifact lookup should remain inspectable');
const planLookupSource = sessionManager.slice(planLookupStart, planLookupEnd);
assert.match(planLookupSource, /readPlanEvents\(sessionId, normalizedPlanId\)/, 'plan actions should use the durable plan index');
assert.doesNotMatch(planLookupSource, /forEachStoredEvent\(sessionId/, 'plan actions must not scan the full transcript');
const delegationLookupStart = sessionManager.indexOf('async function findReusableDelegatedChild(');
const delegationLookupEnd = sessionManager.indexOf('\n}\n\nasync function findLatestRunForSession', delegationLookupStart);
assert.ok(delegationLookupStart >= 0 && delegationLookupEnd > delegationLookupStart, 'delegation reuse lookup should remain inspectable');
const delegationLookupSource = sessionManager.slice(delegationLookupStart, delegationLookupEnd);
assert.match(delegationLookupSource, /readEventsPage\(sourceSessionId/, 'delegation reuse should walk reverse pages');
assert.doesNotMatch(delegationLookupSource, /forEachStoredEvent\(sourceSessionId/, 'delegation reuse must not scan forward from seq 1');

console.log('test-chat-hang-guardrails: ok');
