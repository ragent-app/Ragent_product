#!/usr/bin/env node
// Cold-meta recovery should probe only the contiguous orphan tail instead of
// listing/sorting every event file in a large session directory.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-history-meta-recovery-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_INSTANCE_ROOT = home;

const { ensureDir } = await import('../chat/fs-utils.mjs');
const { CHAT_HISTORY_DIR } = await import('../lib/config.mjs');
const { loadMeta } = await import('../chat/history.mjs');

function eventPath(sessionId, seq) {
  return join(CHAT_HISTORY_DIR, sessionId, 'events', `${String(seq).padStart(9, '0')}.json`);
}

async function fabricate(sessionId, latestSeq, eventSeqs) {
  const dir = join(CHAT_HISTORY_DIR, sessionId, 'events');
  await ensureDir(dir);
  await writeFile(join(CHAT_HISTORY_DIR, sessionId, 'meta.json'), JSON.stringify({
    latestSeq,
    size: latestSeq,
    counts: {},
  }));
  for (const seq of eventSeqs) {
    await writeFile(eventPath(sessionId, seq), JSON.stringify({
      seq,
      type: 'message',
      role: 'user',
      content: `orphan-${seq}`,
      timestamp: Date.now(),
    }));
  }
}

try {
  const contiguous = `history-meta-contiguous-${process.pid}`;
  await fabricate(contiguous, 2, [3, 4]);
  const recovered = await loadMeta(contiguous);
  assert.equal(recovered.latestSeq, 4, 'contiguous orphan tail should be recovered');
  assert.equal(recovered.size, 4);
  assert.equal(recovered.counts.message_user, 2);

  const gapped = `history-meta-gapped-${process.pid}`;
  await fabricate(gapped, 2, [4]);
  const untouched = await loadMeta(gapped);
  assert.equal(untouched.latestSeq, 2, 'non-contiguous orphan must remain a visible gap');
  console.log('history-meta-recovery: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
