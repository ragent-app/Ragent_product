// Incremental, bounded view of the provider-neutral member event stream.
// The adapter owns provider decoding; this layer retains only its safe events.
import {
  buildReadOnlyBoardProjection,
  canonicalizeNativeDelegationProvider,
  createMemberReader,
} from './adapters/provider-native-delegation.mjs';
import { AGY_MANAGED_HOME_DIR } from '../lib/config.mjs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { withDatabase } from './collaboration-store.mjs';
import { getRun, listDurableSessionRunIndexEntries, readRunSpoolDelta, runSpoolPath, runSpoolGzPath, runSpoolZstPath } from './runs.mjs';

const readers = new Map();
const MAX_READERS = 64;

function resolveRunMemberProvider(current, run) {
  for (const candidate of [
    current?.provider,
    current?.providerCapabilities?.provider,
    current?.runtimeFamily,
    run?.provider,
    run?.runtimeFamily,
  ]) {
    const resolved = canonicalizeNativeDelegationProvider(candidate);
    if (resolved) return resolved;
  }
  return '';
}

async function readRun(rootSessionId, run, options = {}) {
  const key = `${rootSessionId}\0${run.id}`;
  const getRunFn = options.getRun || getRun;
  const readDeltaFn = options.readRunSpoolDelta || readRunSpoolDelta;
  const current = await getRunFn(run.id);
  if (!current || current.sessionId !== rootSessionId) return { events: [], board: null, gap: true, pending: false };
  const provider = resolveRunMemberProvider(current, run);
  if (!provider) return { events: [], board: null, gap: false, pending: false };
  const appThread = current.appServerThreadId || '';
  const codexThread = current.codexThreadId || '';
  const parentThreadId = provider === 'codex'
    ? (appThread && codexThread && appThread !== codexThread ? '' : appThread || codexThread)
    : provider === 'agy'
      ? (current.agyConversationId || current.providerSessionId || appThread || '')
      : '';
  const agySessionStorageDir = options.agySessionStorageDir
    || current.agySessionStorageDir
    || current.providerPreparation?.agySessionStorageDir
    || '';
  const agyAppDataRelDir = options.agyAppDataRelDir
    || options.appDataRelDir
    || current.agyAppDataRelDir
    || current.appDataRelDir
    || current.manifest?.options?.agyAppDataRelDir
    || current.manifest?.options?.appDataRelDir
    || '';
  const agyAppDataDir = options.agyAppDataDir
    || current.agyAppDataDir
    || current.appDataDir
    || current.manifest?.options?.agyAppDataDir
    || current.manifest?.options?.appDataDir
    || '';
  const agyGeminiDir = options.agyGeminiDir
    || current.agyGeminiDir
    || current.geminiDir
    || current.manifest?.options?.agyGeminiDir
    || current.manifest?.options?.geminiDir
    || '';
  const appDataDirName = options.appDataDirName
    || current.agyAppDataDirName
    || current.appDataDirName
    || current.manifest?.options?.appDataDirName
    || '';
  const agyHomeDir = options.agyHomeDir || current.agyHomeDir || current.providerRuntimeHome
    || (provider === 'agy' ? AGY_MANAGED_HOME_DIR : '');
  const identity = JSON.stringify([
    provider,
    parentThreadId,
    agySessionStorageDir,
    agyAppDataRelDir,
    agyAppDataDir,
    agyGeminiDir,
    appDataDirName,
    agyHomeDir,
  ]);
  const paths = [runSpoolPath(run.id), runSpoolGzPath(run.id), runSpoolZstPath(run.id)];
  const stats = await Promise.all(paths.map((path) => stat(path).catch(() => null)));
  const index = stats.findIndex(Boolean);
  const source = index >= 0 ? stats[index] : null;
  const sourceIdentity = source ? `${index}:${source.dev}:${source.ino}:${source.birthtimeMs}` : '';
  const fingerprint = source ? `${sourceIdentity}:${source.size}:${source.mtimeMs}` : '';
  let entry = readers.get(key);
  if (entry && !entry.pending && (entry.identity !== identity || entry.resetRequired ||
      entry.sourceIdentity !== sourceIdentity || (source && source.size < entry.sourceSize))) {
    readers.delete(key); entry = null;
  }
  if (!entry) {
    entry = {
      reader: createMemberReader({
        provider,
        runId: run.id,
        parentSessionId: rootSessionId,
        parentThreadId,
        providerSessionId: current.agyConversationId || current.providerSessionId || '',
        agySessionStorageDir,
        agyAppDataRelDir,
        agyAppDataDir,
        agyGeminiDir,
        appDataDirName,
        agyHomeDir,
      }),
      identity,
      sourceIdentity,
      sourceSize: source?.size || 0,
      generation: createHash('sha256').update(`${key}:${sourceIdentity}`).digest().readUInt32BE(0) & 0x7fffffff,
      fingerprint: '',
      offset: 0,
      lines: 0,
      snapshot: [],
      gap: false,
      resetRequired: false,
      pending: null,
      complete: false,
    };
    readers.set(key, entry);
    while (readers.size > MAX_READERS) readers.delete(readers.keys().next().value);
  }
  if (entry.pending) return entry.pending;
  const terminalParentRun = ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state);
  if (entry.complete && entry.fingerprint === fingerprint && terminalParentRun && entry.parentRunState === current.state) {
    const board = entry.reader.readBoard?.() || null;
    return {
      events: entry.snapshot.map((event) => ({ ...event, _generation: entry.generation })),
      board,
      gap: entry.gap,
      pending: false,
    };
  }
  entry.pending = (async () => {
    let more = false;
    for (let page = 0; page < 4; page++) {
      const result = await readDeltaFn(run.id, { startOffset: entry.offset, skipLines: entry.lines, maxRecords: 200, strictStatus: true });
      const verified = result.readStatus === 'verified';
      const projection = await entry.reader.consume(result.records, {
        sourceVerified: verified,
        parentRunState: current.state,
      });
      entry.snapshot = projection.snapshot;
      entry.gap ||= projection.gap || !verified;
      if (!verified) { entry.resetRequired = true; more = true; break; }
      const previousOffset = entry.offset;
      const previousLines = entry.lines;
      if (previousOffset > 0 && result.nextOffset > 0 && result.nextOffset < previousOffset) { entry.gap = true; entry.resetRequired = true; more = true; break; }
      entry.offset = result.nextOffset || 0;
      entry.lines = result.nextOffset === 0 ? (result.processedLineCount || 0) : previousLines + (result.processedLineCount || 0);
      more = result.truncated === true;
      if (!more) break;
      if (entry.offset === previousOffset && entry.lines <= previousLines) { entry.gap = true; entry.resetRequired = true; break; }
    }
    entry.complete = !more && !entry.resetRequired;
    entry.fingerprint = fingerprint;
    entry.sourceSize = source?.size || 0;
    entry.parentRunState = current.state;
    const board = entry.reader.readBoard?.() || null;
    return {
      events: entry.snapshot.map((event) => ({ ...event, _generation: entry.generation })),
      board,
      gap: entry.gap,
      pending: more,
    };
  })().finally(() => { entry.pending = null; });
  return entry.pending;
}

function mergeBoards(boards = []) {
  const valid = boards.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  const latest = valid[valid.length - 1];
  const channels = [];
  const messages = [];
  let truncated = false;
  let gap = false;
  for (const board of valid) {
    if (Array.isArray(board.channels)) channels.push(...board.channels);
    if (Array.isArray(board.messages)) messages.push(...board.messages);
    truncated ||= Boolean(board.truncated);
    gap ||= Boolean(board.gap);
  }
  return buildReadOnlyBoardProjection({
    title: latest.title || null,
    channels,
    messages,
    source: latest.source || 'provider_native',
    provider: latest.provider || 'agy',
    truncated,
    gap,
  });
}

export async function listMemberEvents(rootSessionId, options = {}) {
  const listRunsFn = options.listDurableSessionRunIndexEntries || listDurableSessionRunIndexEntries;
  const indexed = await listRunsFn(rootSessionId);
  const runs = indexed.filter((run) => run.sessionId === rootSessionId)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
  let gap = false;
  const events = [];
  const boards = [];
  // Bound each request; continuation occurs through the next organization refresh.
  for (const run of runs.slice(-32)) {
    const result = await readRun(rootSessionId, run, options);
    events.push(...result.events);
    if (result.board) boards.push(result.board);
    gap ||= result.gap || result.pending;
  }
  if (runs.length > 32 || runs.some((run) => !Number.isFinite(Date.parse(run.createdAt)))) gap = true;
  if (runs.some((run, index) => index > 0 && run.createdAt === runs[index - 1].createdAt)) gap = true;
  const board = mergeBoards(boards);
  return {
    events,
    gap,
    availability: 'partial',
    ...(board ? { board, channels: board.channels } : {}),
  };
}

export function capturedMember(rootSessionId, runId, memberId) {
  const entry = readers.get(`${rootSessionId}\0${runId}`);
  if (!entry) return { entries: [], gap: true, availability: 'unavailable' };
  const result = entry.reader.readCapturedMember(memberId);
  return { ...result, generation: entry.generation, gap: entry.gap || result.gap || !entry.complete };
}

function parseJsonSafe(raw, fallback = null) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export async function resolveFormalNodeStagingConversationSession({
  organizationId,
  rootSessionId,
  node,
  getSessionReadSnapshotFn = null,
} = {}) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  const rootId = typeof rootSessionId === 'string' ? rootSessionId.trim() : '';
  const nodeId = typeof node?.id === 'string' ? node.id.trim() : '';
  const managedSessionId = typeof node?.currentSessionId === 'string' ? node.currentSessionId.trim() : '';
  const bindingGeneration = Number.isInteger(node?.bindingGeneration) ? node.bindingGeneration : null;
  if (!orgId || !rootId || !nodeId || !managedSessionId) return null;

  const candidateIds = await withDatabase((db) => {
    for (const table of [
      'collaborations',
      'collaboration_plans',
      'collaboration_tasks',
      'collaboration_attempts',
      'collaboration_dispatch_commands',
    ]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        return [];
      }
    }
    const rows = db.prepare(`
      SELECT a.attempt_number,
             a.session_id AS attempt_session_id,
             d.session_id AS dispatch_session_id,
             t.id AS task_id,
             t.writable_paths_json,
             c.policy_json,
             p.plan_json
      FROM collaborations c
      JOIN collaboration_tasks t ON t.collaboration_id = c.id
      JOIN collaboration_attempts a ON a.task_id = t.id
      LEFT JOIN collaboration_plans p ON p.collaboration_id = c.id AND p.version = c.plan_version
      LEFT JOIN collaboration_dispatch_commands d ON d.attempt_id = a.id
      WHERE c.root_session_id = ?
      ORDER BY a.created_at DESC, a.attempt_number DESC
    `).all(rootId);

    const matched = [];
    const seen = new Set();
    for (const row of rows) {
      const policy = parseJsonSafe(row.policy_json, null);
      if (!policy || policy.factoryExecution) continue;
      if (String(policy.organizationId || '').trim() !== orgId) continue;
      if (String(policy.organizationNodeId || '').trim() !== nodeId) continue;
      if (Number.isInteger(policy.organizationBindingGeneration)
          && Number.isInteger(bindingGeneration)
          && policy.organizationBindingGeneration !== bindingGeneration) {
        continue;
      }
      const writablePaths = parseJsonSafe(row.writable_paths_json, null);
      if (!Array.isArray(writablePaths) || writablePaths.length === 0) continue;
      const plan = parseJsonSafe(row.plan_json, null);
      const planTask = Array.isArray(plan?.tasks)
        ? plan.tasks.find((candidate) => candidate && candidate.id === row.task_id)
        : null;
      if (String(planTask?.managedSessionId || '').trim() !== managedSessionId) continue;

      const candidateSessionId = String(row.attempt_session_id || row.dispatch_session_id || '').trim();
      if (!candidateSessionId || candidateSessionId === managedSessionId || seen.has(candidateSessionId)) continue;
      seen.add(candidateSessionId);
      matched.push(candidateSessionId);
    }
    return matched;
  });

  if (!candidateIds.length) return null;
  const readSnapshot = typeof getSessionReadSnapshotFn === 'function'
    ? getSessionReadSnapshotFn
    : (await import('./session-manager.mjs')).getSessionReadSnapshot;

  let fallback = null;
  for (const candidateSessionId of candidateIds) {
    const snap = await readSnapshot(candidateSessionId);
    const meta = snap?.sessionMeta;
    if (!meta || meta.sessionPlane !== 'organization') continue;
    if (String(meta.organizationId || '').trim() !== orgId) continue;
    if (String(meta.organizationNodeId || '').trim() !== nodeId) continue;
    if (meta.organizationRootSessionId && String(meta.organizationRootSessionId).trim() !== rootId) continue;

    const targetFromMeta = String(meta.sourceContext?.managedWriter?.targetSessionId || '').trim();
    const parentFromMeta = String(meta.parentSessionId || '').trim();
    if (parentFromMeta !== managedSessionId && targetFromMeta !== managedSessionId) continue;

    const metaGeneration = meta.sourceContext?.managedWriter?.organizationBindingGeneration;
    if (Number.isInteger(metaGeneration) && Number.isInteger(bindingGeneration) && metaGeneration !== bindingGeneration) {
      continue;
    }

    const hasEntries = Number(snap.historyMeta?.latestSeq || 0) > 0;
    const candidate = { sessionId: candidateSessionId, snapshot: snap, hasEntries };
    if (hasEntries) return candidate;
    if (!fallback) fallback = candidate;
  }
  return fallback;
}
