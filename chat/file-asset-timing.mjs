import { createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Correlation is limited to one service process and cannot reveal asset IDs.
const processKey = randomBytes(32);
const stages = new Set(['relay_open', 'relay_receive', 'relay_wait', 'finalize_local',
  'quota_binding', 'quota_complete', 'finalize_total']);

export function createAttachmentTiming({ enabled = process.env.AGENTOC_ATTACHMENT_TIMING === '1',
  clock = () => performance.now(), sink = line => console.error(line), key = processKey } = {}) {
  function start() {
    if (!enabled) return 0;
    try { return clock(); } catch { return null; }
  }
  function end(assetId, stage, started, { bytes, outcome = 'ok' } = {}) {
    if (!enabled) return;
    if (typeof assetId !== 'string' || !/^fasset_[a-f0-9]{24}$/.test(assetId) || !stages.has(stage) ||
        !['ok', 'error'].includes(outcome) || !Number.isFinite(started)) return;
    // Timing must never turn a successful upload into a failure.
    try {
      const elapsedMs = Math.max(0, Math.round((clock() - started) * 100) / 100);
      if (!Number.isFinite(elapsedMs)) return;
      const correlation = createHmac('sha256', key).update(assetId).digest('hex').slice(0, 16);
      const record = { correlation, stage, elapsedMs, outcome };
      if (Number.isSafeInteger(bytes) && bytes >= 0) record.bytes = bytes;
      sink(`[attachment-timing] ${JSON.stringify(record)}`);
    } catch { /* observational only */ }
  }
  async function measure(assetId, stage, operation, { bytes } = {}) {
    if (!enabled) return operation();
    const started = start();
    let outcome = 'error';
    try {
      const result = await operation();
      outcome = 'ok';
      return result;
    } finally {
      end(assetId, stage, started, { bytes, outcome });
    }
  }
  return { start, end, measure };
}

export const attachmentTiming = createAttachmentTiming();
