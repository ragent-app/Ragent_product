// Incremental, bounded view of the provider-neutral member event stream.
// The adapter owns provider decoding; this layer retains only its safe events.
import { createMemberReader } from './adapters/provider-native-delegation.mjs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getRun, listDurableSessionRunIndexEntries, readRunSpoolDelta, runSpoolPath, runSpoolGzPath, runSpoolZstPath } from './runs.mjs';

const readers = new Map();
const MAX_READERS = 64;

async function readRun(rootSessionId, run) {
  const key = `${rootSessionId}\0${run.id}`;
  const current = await getRun(run.id);
  if (!current || current.sessionId !== rootSessionId) return { events: [], gap: true, pending: false };
  const providerEvidence = String(current.provider || current.providerCapabilities?.provider || current.runtimeFamily || run.provider || '').toLowerCase();
  const provider = providerEvidence.includes('claude') ? 'claude' : providerEvidence.includes('codex') ? 'codex' : '';
  if (!provider) return { events: [], gap: false, pending: false };
  const appThread = current.appServerThreadId || '';
  const codexThread = current.codexThreadId || '';
  const parentThreadId = appThread && codexThread && appThread !== codexThread ? '' : appThread || codexThread;
  const identity = JSON.stringify([provider, parentThreadId]);
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
    entry = { reader: createMemberReader({ provider, runId: run.id, parentSessionId: rootSessionId, parentThreadId }),
      identity, sourceIdentity, sourceSize: source?.size || 0,
      generation: createHash('sha256').update(`${key}:${sourceIdentity}`).digest().readUInt32BE(0) & 0x7fffffff,
      fingerprint: '', offset: 0, lines: 0, snapshot: [], gap: false, resetRequired: false, pending: null, complete: false };
    readers.set(key, entry);
    while (readers.size > MAX_READERS) readers.delete(readers.keys().next().value);
  }
  if (entry.pending) return entry.pending;
  if (entry.complete && entry.fingerprint === fingerprint && ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state)) {
    return { events: entry.snapshot.map((event) => ({ ...event, _generation: entry.generation })), gap: entry.gap, pending: false };
  }
  entry.pending = (async () => {
    let more = false;
    for (let page = 0; page < 4; page++) {
      const result = await readRunSpoolDelta(run.id, { startOffset: entry.offset, skipLines: entry.lines, maxRecords: 200, strictStatus: true });
      const verified = result.readStatus === 'verified';
      const projection = await entry.reader.consume(result.records, { sourceVerified: verified });
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
    return { events: entry.snapshot.map((event) => ({ ...event, _generation: entry.generation })), gap: entry.gap, pending: more };
  })().finally(() => { entry.pending = null; });
  return entry.pending;
}

export async function listMemberEvents(rootSessionId) {
  const indexed = await listDurableSessionRunIndexEntries(rootSessionId);
  const runs = indexed.filter((run) => run.sessionId === rootSessionId)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
  let gap = false;
  const events = [];
  // Bound each request; continuation occurs through the next organization refresh.
  for (const run of runs.slice(-32)) {
    const result = await readRun(rootSessionId, run);
    events.push(...result.events);
    gap ||= result.gap || result.pending;
  }
  if (runs.length > 32 || runs.some((run) => !Number.isFinite(Date.parse(run.createdAt)))) gap = true;
  if (runs.some((run, index) => index > 0 && run.createdAt === runs[index - 1].createdAt)) gap = true;
  return { events, gap, availability: 'partial' };
}

export function capturedMember(rootSessionId, runId, memberId) {
  const entry = readers.get(`${rootSessionId}\0${runId}`);
  if (!entry) return { entries: [], gap: true, availability: 'unavailable' };
  const result = entry.reader.readCapturedMember(memberId);
  return { ...result, generation: entry.generation, gap: entry.gap || result.gap || !entry.complete };
}
