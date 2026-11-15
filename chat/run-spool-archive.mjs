// Cold-archive terminal-run spools: stream-compress spool.jsonl -> spool.jsonl.gz
// (gzip, default) or spool.jsonl.zst (zstd, opt-in) and delete the plain file.
// chat/runs.mjs reads both forms transparently, so run history stays fully
// readable while disk usage drops by ~86% on terminal runs (15.4 GB -> ~2.2 GB
// measured 2026-08-05 with gzip).
//
// This module is the single source of truth for the archive logic:
//   - archiveTerminalSpools() is the core (also used by scripts/archive-run-spools.mjs)
//   - startRunArchiveScheduler()/stopRunArchiveScheduler() drive it with a
//     one-shot wake-up, avoiding idle interval callbacks.
//   - verifyArchivedSpool() re-checks an existing archive against its meta sidecar.
//
// Streaming (no readFile of the spool):
//   - The plain spool is streamed through a sha256 tee into the codec
//     compressor and out to a temp file; memory stays bounded no matter how
//     large the spool (64 MB / 500 MB spools are covered by tests).
//   - The temp file is fsync'ed before rename, and the run directory is
//     fsync'ed (best-effort) after rename so a crash cannot leave a zero-length
//     or partial archive standing in for the plain file.
//
// Safety:
//   - Only terminal runs (completed/failed/cancelled) are touched; running and
//     accepted runs keep their appendable plain spool (state is re-checked
//     right before the rename, not just at scan time).
//   - The compressed form is integrity-verified by streaming it back through
//     the decompressor and comparing sha256 + byte count with the original
//     (the hash is computed during the first pass, so nothing is re-read).
//   - A meta sidecar (spool.jsonl.gz.meta.json / spool.jsonl.zst.meta.json)
//     retains originalBytes + originalSha256 + codec so archives stay
//     verifiable after the fact (scripts/archive-run-spools.mjs --verify).
//   - The plain spool is stat'ed before compression and again before unlink; a
//     size/mtime change (late append from a straggler writer) aborts the file
//     and keeps the plain spool intact. On any failure the temp file is
//     removed and the plain spool is left exactly as it was.
//   - Never touches manifest.json / status.json / result.json / artifacts/.
//   - minAgeMs retention gate: terminal runs younger than the gate (by
//     completedAt, falling back to updatedAt then spool mtime) are skipped, so a
//     run that just finished is not disturbed while a client may still stream it.
//
// Budgets (single worker, concurrency 1):
//   - Archive work is strictly sequential (module-level lock + per-tick loop),
//     so at most one file is being compressed at any time.
//   - Per tick: a file-count cap (perTickLimit) and an input-byte cap
//     (perTickBytes) stop the batch before it saturates CPU/disk; the in-place
//     archive is naturally resumable — the next tick picks up where the
//     previous one stopped. ThrottleMs additionally sleeps between files.
//   - gzip/gunzip/zstd run on the libuv thread pool so the main loop is not
//     blocked (a full-speed run measured ~28 GB of combined I/O and caused a
//     system-wide slowdown on 2026-08-05).
//
// Scheduler config (env, resolved lazily so tests can change them):
//   RAGENT_RUN_SPOOL_ARCHIVE_ENABLED      default 1        master switch (0 disables)
//   RAGENT_RUN_SPOOL_ARCHIVE_INTERVAL_MS  default 900000  (15m) cadence
//   RAGENT_RUN_SPOOL_ARCHIVE_MIN_AGE_MS   default 600000  (10m) retention gate
//   RAGENT_RUN_SPOOL_ARCHIVE_THROTTLE_MS  default 20       sleep between files
//   RAGENT_RUN_SPOOL_ARCHIVE_MIN_BYTES    default 1024     skip tiny spools
//   RAGENT_RUN_SPOOL_ARCHIVE_CODEC        default gzip     gzip | zstd
//   RAGENT_RUN_SPOOL_ARCHIVE_PER_TICK_LIMIT  default 64    files per tick
//   RAGENT_RUN_SPOOL_ARCHIVE_PER_TICK_BYTES  default 1073741824 (1 GiB input per tick)

import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { open, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip, createGzip, createZstdCompress, createZstdDecompress } from 'zlib';
import { CHAT_RUNS_DIR, CONFIG_DIR } from '../lib/config.mjs';

export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const GZIP_LEVEL = 6;
const DEFAULT_THROTTLE_MS_APPLY = 50;
const STATE_FILE = join(CONFIG_DIR, 'run-spool-archive-state.json');

export const ARCHIVE_CODECS = {
  gzip: {
    ext: '.gz',
    compress: () => createGzip({ level: GZIP_LEVEL }),
    decompress: () => createGunzip(),
  },
  zstd: {
    ext: '.zst',
    compress: () => createZstdCompress(),
    decompress: () => createZstdDecompress(),
  },
};

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '? B';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

// Sidecar retaining the original spool's hash + size so an archive can be
// verified after the fact (compression-before/after checkable).
export function archiveMetaPath(archivePath) {
  return `${archivePath}.meta.json`;
}

export function resolveCodec(codec) {
  return ARCHIVE_CODECS[codec] ? codec : 'gzip';
}

// Read status.json once and surface the fields the archive logic cares about.
async function readRunStatus(runDir) {
  try {
    const status = JSON.parse(await readFile(join(runDir, 'status.json'), 'utf8'));
    return {
      state: status?.state || status?.status || '',
      completedAt: status?.completedAt || null,
      updatedAt: status?.updatedAt || null,
    };
  } catch {
    return { state: null, completedAt: null, updatedAt: null };
  }
}

// Resolve the run's terminal moment for the retention gate. Prefer completedAt,
// then updatedAt, then fall back to the spool's own mtime (older deployments
// may not persist completedAt).
function resolveTerminalEpoch({ completedAt, updatedAt }, spoolMtimeMs) {
  const parsed = Date.parse(completedAt || updatedAt || '');
  if (Number.isFinite(parsed)) return parsed;
  return Number.isFinite(spoolMtimeMs) ? spoolMtimeMs : 0;
}

// Streaming integrity check: decompress `archivePath` and compare sha256 +
// byte count against the original hash/size recorded in the meta sidecar.
// Returns the outcome; never throws for a corrupt/legacy archive.
//
//   { valid, codec, actualBytes, actualSha256, expectedBytes, expectedSha256,
//     hashCheckable, reason }
//
// `valid` means the archive decompresses cleanly; `hashCheckable` is false for
// legacy archives that predate the meta sidecar (nothing to compare against).
export async function verifyArchivedSpool(archivePath) {
  const result = {
    valid: false,
    codec: null,
    actualBytes: 0,
    actualSha256: null,
    expectedBytes: null,
    expectedSha256: null,
    hashCheckable: false,
    reason: null,
  };
  let codec = 'gzip';
  let expectedBytes = null;
  let expectedSha256 = null;
  try {
    const meta = JSON.parse(await readFile(archiveMetaPath(archivePath), 'utf8'));
    if (meta?.codec === 'gzip' || meta?.codec === 'zstd') codec = meta.codec;
    if (Number.isInteger(meta?.originalBytes)) expectedBytes = meta.originalBytes;
    if (typeof meta?.originalSha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.originalSha256)) {
      expectedSha256 = meta.originalSha256;
    }
  } catch {
    // no sidecar: legacy archive, hash not checkable
  }
  result.codec = codec;
  result.expectedBytes = expectedBytes;
  result.expectedSha256 = expectedSha256;
  result.hashCheckable = expectedBytes !== null && expectedSha256 !== null;

  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(
      createReadStream(archivePath),
      ARCHIVE_CODECS[codec].decompress(),
      new Writable({
        write(chunk, _enc, cb) {
          hash.update(chunk);
          bytes += chunk.length;
          cb();
        },
      }),
    );
  } catch (error) {
    result.reason = `decompress failed: ${error.message}`;
    return result;
  }

  result.actualBytes = bytes;
  result.actualSha256 = hash.digest('hex');
  if (result.hashCheckable) {
    result.valid = bytes === expectedBytes && result.actualSha256 === expectedSha256;
    if (!result.valid) {
      result.reason =
        bytes !== expectedBytes
          ? `byte mismatch: ${bytes} != ${expectedBytes}`
          : `sha256 mismatch: ${result.actualSha256.slice(0, 12)} != ${expectedSha256.slice(0, 12)}`;
    }
  } else {
    result.valid = true; // decompressed cleanly; nothing stronger to check
  }
  return result;
}

/**
 * Archive terminal-run spools in place.
 *
 * @param {object} options
 * @param {string} [options.root]        runs dir (default CHAT_RUNS_DIR)
 * @param {boolean} [options.apply]      true to write; false/omit = dry-run scan
 * @param {number} [options.limit]       cap candidates processed (Infinity)
 * @param {number} [options.minBytes]    skip spools smaller than this
 * @param {number} [options.throttleMs]  sleep between files in APPLY (null -> apply?50:0)
 * @param {number} [options.minAgeMs]    retention gate: skip terminal runs younger than this
 * @param {string} [options.codec]       'gzip' (default) | 'zstd'
 * @param {number} [options.perTickLimit]     per-tick file-count budget (scheduler)
 * @param {number} [options.perTickBytes]     per-tick input-byte budget
 * @returns {Promise<object>} summary
 */
export async function archiveTerminalSpools(options = {}) {
  const root = options.root || CHAT_RUNS_DIR;
  const apply = options.apply === true;
  const codec = resolveCodec(options.codec);
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
  const perTickLimit = Number.isFinite(options.perTickLimit) ? options.perTickLimit : Infinity;
  const perTickBytes = Number.isFinite(options.perTickBytes) ? options.perTickBytes : Infinity;
  const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : 0;
  const throttleMs = Number.isFinite(options.throttleMs)
    ? options.throttleMs
    : apply ? DEFAULT_THROTTLE_MS_APPLY : 0;
  const minAgeMs = Number.isFinite(options.minAgeMs) && options.minAgeMs > 0 ? options.minAgeMs : 0;
  const now = Date.now();

  let entries;
  try {
    entries = await readdir(root);
  } catch {
    return {
      mode: apply ? 'APPLY' : 'DRY-RUN',
      generatedAt: new Date().toISOString(),
      codec,
      scannedRuns: 0,
      candidates: 0,
      candidateBytes: 0,
      skippedByAge: 0,
      archived: 0,
      freedBytes: 0,
      archivedBytes: 0,
      processedBytes: 0,
      tickStopped: null,
      remainingCandidates: 0,
      failures: [],
    };
  }

  const runDirs = entries.filter((e) => e.startsWith('run_'));
  const candidates = [];
  let skippedByAge = 0;
  for (const name of runDirs) {
    const dir = join(root, name);
    const spoolPath = join(dir, 'spool.jsonl');
    let spoolStats;
    try {
      spoolStats = await stat(spoolPath);
    } catch {
      continue; // no plain spool (already archived or never had one)
    }
    const status = await readRunStatus(dir);
    if (!TERMINAL_STATES.has(status.state)) continue; // keep live runs appendable
    if (spoolStats.size < minBytes) continue;
    if (minAgeMs > 0) {
      const epoch = resolveTerminalEpoch(status, spoolStats.mtimeMs);
      if (epoch > 0 && now - epoch < minAgeMs) {
        skippedByAge++;
        continue;
      }
    }
    candidates.push({
      name,
      dir,
      spoolPath,
      size: spoolStats.size,
      mtimeMs: spoolStats.mtimeMs,
      state: status.state,
    });
  }
  candidates.sort((a, b) => b.size - a.size);

  let archivedCount = 0;
  let freedBytes = 0;
  let archivedBytes = 0;
  let processedBytes = 0;
  let tickStopped = null;
  const failures = [];

  const effectiveLimit = Math.min(limit, perTickLimit);
  for (const c of candidates) {
    if (archivedCount >= effectiveLimit) {
      tickStopped = 'per-tick-limit';
      break;
    }
    if (perTickBytes !== Infinity && processedBytes + c.size > perTickBytes) {
      tickStopped = 'per-tick-bytes';
      break;
    }
    if (apply) {
      const archivePath = `${c.spoolPath}${ARCHIVE_CODECS[codec].ext}`;
      const outcome = await archiveOneSpool(c, archivePath, codec);
      if (outcome.ok) {
        archivedCount++;
        freedBytes += c.size;
        archivedBytes += outcome.compressedBytes;
      } else {
        failures.push({ runId: c.name, error: outcome.error });
      }
      processedBytes += c.size;
    } else {
      archivedCount++;
      freedBytes += c.size;
      // estimate compressed size for dry-run: compress the first 4 MB only
      try {
        const fd = await open(c.spoolPath, 'r');
        const head = Buffer.alloc(Math.min(4 * 1024 * 1024, c.size));
        await fd.read(head, 0, head.length, 0);
        await fd.close();
        const compressed = await new Promise((resolve, reject) => {
          const chunks = [];
          const comp = ARCHIVE_CODECS[codec].compress();
          comp.on('data', (chunk) => chunks.push(chunk));
          comp.on('end', () => resolve(Buffer.concat(chunks)));
          comp.on('error', reject);
          comp.end(head);
        });
        archivedBytes += Math.round(c.size * (compressed.length / head.length));
      } catch {
        archivedBytes += Math.round(c.size * 0.14); // measured median ratio
      }
      processedBytes += c.size;
    }
    if (apply && throttleMs > 0) await sleep(throttleMs);
  }

  return {
    mode: apply ? 'APPLY' : 'DRY-RUN',
    generatedAt: new Date().toISOString(),
    codec,
    scannedRuns: runDirs.length,
    candidates: candidates.length,
    candidateBytes: candidates.reduce((a, c) => a + c.size, 0),
    skippedByAge,
    archived: archivedCount,
    freedBytes,
    archivedBytes,
    processedBytes,
    tickStopped,
    remainingCandidates: candidates.length - archivedCount,
    failures,
  };
}

// Compress one spool to a temp file, verify the archive by streaming it back,
// record the original hash/size in a meta sidecar, then atomically rename and
// remove the plain file. On any failure the temp files are removed and the
// plain spool is untouched.
async function archiveOneSpool(c, archivePath, codec) {
  const tmpPath = `${archivePath}.tmp-${process.pid}`;
  const metaTmpPath = `${archiveMetaPath(archivePath)}.tmp-${process.pid}`;
  const codecDef = ARCHIVE_CODECS[codec];

  const removeTemps = async () => {
    for (const p of [tmpPath, metaTmpPath]) {
      try {
        await unlink(p);
      } catch {
        // ignore cleanup failure
      }
    }
  };

  try {
    // Pass 1: stream the plain spool through a sha256 tee into the compressor
    // and out to a temp file. Memory stays bounded regardless of spool size.
    const inputHash = createHash('sha256');
    let inputBytes = 0;
    const src = createReadStream(c.spoolPath);
    src.on('data', (chunk) => {
      inputHash.update(chunk);
      inputBytes += chunk.length;
    });
    await pipeline(src, codecDef.compress(), createWriteStream(tmpPath, { flags: 'wx' }));
    const inputSha256 = inputHash.digest('hex');

    // Durability: flush the temp file to disk before it can be renamed into place.
    const tmpFh = await open(tmpPath, 'r');
    try {
      await tmpFh.sync();
    } finally {
      await tmpFh.close();
    }
    const tmpStats = await stat(tmpPath);
    const compressedBytes = tmpStats.size;

    // Pass 2: stream the archive back through the decompressor and compare
    // sha256 + byte count with the original. Catches partial/corrupt writes.
    const verifyHash = createHash('sha256');
    let verifiedBytes = 0;
    await pipeline(
      createReadStream(tmpPath),
      codecDef.decompress(),
      new Writable({
        write(chunk, _enc, cb) {
          verifyHash.update(chunk);
          verifiedBytes += chunk.length;
          cb();
        },
      }),
    );
    if (verifiedBytes !== inputBytes || verifyHash.digest('hex') !== inputSha256) {
      throw new Error(
        `integrity mismatch: uncompressed ${verifiedBytes} bytes / sha256 differ from original ${inputBytes} bytes`,
      );
    }

    // Record original hash/size so the archive stays verifiable after the fact.
    await writeFile(
      metaTmpPath,
      JSON.stringify(
        {
          codec,
          algorithm: 'sha256',
          originalBytes: inputBytes,
          originalSha256: inputSha256,
          archivedBytes: compressedBytes,
          archivedAt: new Date().toISOString(),
          archivedBy: 'run-spool-archive',
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );

    // Re-check before commit: if the plain spool grew/changed while we were
    // compressing (late append from a straggler writer) or the run is no
    // longer terminal, abort and keep the plain spool.
    const afterStats = await stat(c.spoolPath);
    if (afterStats.size !== c.size || afterStats.mtimeMs !== c.mtimeMs) {
      throw new Error('spool changed during archive (concurrent append); plain spool kept');
    }
    const statusNow = await readRunStatus(c.dir);
    if (!TERMINAL_STATES.has(statusNow.state)) {
      throw new Error(`run no longer terminal (state=${statusNow.state}); plain spool kept`);
    }

    await rename(tmpPath, archivePath);
    await rename(metaTmpPath, archiveMetaPath(archivePath));

    // Narrow the unlink race further: if the plain file changed between the
    // check above and now, roll the archive back and keep the plain spool.
    const finalStats = await stat(c.spoolPath);
    if (finalStats.size !== c.size || finalStats.mtimeMs !== c.mtimeMs) {
      await rename(archivePath, tmpPath);
      await rename(archiveMetaPath(archivePath), metaTmpPath);
      throw new Error('spool changed during archive (concurrent append); plain spool kept');
    }
    await unlink(c.spoolPath);

    // Best-effort directory fsync so the renames are durable.
    try {
      const dirFh = await open(c.dir, 'r');
      try {
        await dirFh.sync();
      } finally {
        await dirFh.close();
      }
    } catch {
      // directory fsync is not supported everywhere; the file fsync still holds
    }

    return { ok: true, compressedBytes };
  } catch (error) {
    await removeTemps();
    return { ok: false, error: error.message };
  }
}

// --- scheduler -------------------------------------------------------------

function getArchiveConfig() {
  const envMs = (name, fallback) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const envFlag = (name, fallback) => {
    const v = process.env[name];
    return v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);
  };
  return {
    enabled: envFlag('RAGENT_RUN_SPOOL_ARCHIVE_ENABLED', true),
    intervalMs: envMs('RAGENT_RUN_SPOOL_ARCHIVE_INTERVAL_MS', 15 * 60 * 1000),
    minAgeMs: envMs('RAGENT_RUN_SPOOL_ARCHIVE_MIN_AGE_MS', 10 * 60 * 1000),
    throttleMs: envMs('RAGENT_RUN_SPOOL_ARCHIVE_THROTTLE_MS', 20),
    minBytes: envMs('RAGENT_RUN_SPOOL_ARCHIVE_MIN_BYTES', 1024),
    codec: resolveCodec(process.env.RAGENT_RUN_SPOOL_ARCHIVE_CODEC),
    // Keep compression work in short, schedulable bursts.  A smaller default
    // prevents the archive worker itself from producing multi-second I/O
    // stalls when a backlog has accumulated; operators can raise the budget
    // explicitly after observing host pressure.
    perTickLimit: envMs('RAGENT_RUN_SPOOL_ARCHIVE_PER_TICK_LIMIT', 64),
    perTickBytes: envMs('RAGENT_RUN_SPOOL_ARCHIVE_PER_TICK_BYTES', 1024 * 1024 * 1024),
    stateFile: STATE_FILE,
  };
}

async function readArchiveState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    return { lastRunAt: parsed.lastRunAt || null, lastSummary: parsed.lastSummary || null };
  } catch {
    return { lastRunAt: null, lastSummary: null };
  }
}

async function writeArchiveState(stateFile, state) {
  try {
    await writeFile(stateFile, JSON.stringify(state, null, 2));
  } catch {
    // state is advisory; a failed write must not crash the scheduler
  }
}

let archiveTimer = null;
let archiveRunning = false;
let archiveSchedulerEnabled = false;

/**
 * Run one scheduler tick: archive if enabled, not already running, and due per
 * the durable state file. Returns a small result describing what happened.
 */
export async function processRunArchiveDueNow(options = {}) {
  const config = { ...getArchiveConfig(), ...options };
  if (!config.enabled) return { ran: false, reason: 'disabled' };
  if (archiveRunning) return { ran: false, reason: 'already-running' };
  const state = await readArchiveState(config.stateFile);
  if (state.lastRunAt) {
    const elapsed = Date.now() - Date.parse(state.lastRunAt);
    if (Number.isFinite(elapsed) && elapsed < config.intervalMs) {
      return { ran: false, reason: 'not-due', lastRunAt: state.lastRunAt };
    }
  }
  archiveRunning = true;
  try {
    const summary = await archiveTerminalSpools({
      root: config.root,
      apply: true,
      limit: config.perTickLimit,
      minBytes: config.minBytes,
      throttleMs: config.throttleMs,
      minAgeMs: config.minAgeMs,
      codec: config.codec,
      perTickBytes: config.perTickBytes,
    });
    await writeArchiveState(config.stateFile, {
      lastRunAt: new Date().toISOString(),
      lastSummary: summary,
      lastTick: {
        archived: summary.archived,
        processedBytes: summary.processedBytes,
        tickStopped: summary.tickStopped,
      },
    });
    const stopNote = summary.tickStopped ? `, stopped by ${summary.tickStopped}` : '';
    console.log(
      `[run-spool-archive] scheduled tick (${summary.codec}): archived ${summary.archived}, ` +
        `freed ${formatBytes(summary.freedBytes)}, processed ${formatBytes(summary.processedBytes)}, ` +
        `skippedByAge ${summary.skippedByAge}, failures ${summary.failures.length}${stopNote}`,
    );
    return { ran: true, summary };
  } catch (error) {
    console.error(`[run-spool-archive] scheduled tick FAILED: ${error.message}`);
    return { ran: false, reason: 'error', error: error.message };
  } finally {
    archiveRunning = false;
  }
}

/**
 * Start the periodic cold-archive ticker. Mirrors startTriggerScheduler:
 * setInterval + unref + an immediate due-check on boot. The due-check reads the
 * durable state file so a restart (e.g. mid-deploy) does not re-run immediately.
 */
export function startRunArchiveScheduler(options = {}) {
  const config = { ...getArchiveConfig(), ...options };
  if (!config.enabled) {
    console.log('[run-spool-archive] automatic scheduling disabled (RAGENT_RUN_SPOOL_ARCHIVE_ENABLED!=1)');
    return null;
  }
  if (archiveTimer) return archiveTimer;
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : config.intervalMs;
  const schedule = (delayMs) => {
    if (archiveTimer || !archiveSchedulerEnabled) return;
    archiveTimer = setTimeout(() => {
      archiveTimer = null;
      void processRunArchiveDueNow(options)
        .catch(() => {})
        .finally(async () => {
          if (!archiveSchedulerEnabled) return;
          const state = await readArchiveState(config.stateFile).catch(() => ({}));
          const lastRunMs = Date.parse(state.lastRunAt || '');
          const remaining = Number.isFinite(lastRunMs)
            ? Math.max(0, config.intervalMs - (Date.now() - lastRunMs))
            : 0;
          schedule(Math.max(pollMs, remaining));
        });
    }, Math.max(0, delayMs));
    archiveTimer.unref?.();
  };
  archiveSchedulerEnabled = true;
  schedule(0);
  return archiveTimer;
}

export function stopRunArchiveScheduler() {
  const wasRunning = archiveSchedulerEnabled || Boolean(archiveTimer);
  archiveSchedulerEnabled = false;
  if (archiveTimer) clearTimeout(archiveTimer);
  archiveTimer = null;
  return wasRunning;
}

export function isRunArchiveSchedulerRunning() {
  return archiveSchedulerEnabled || archiveTimer !== null;
}

// Exposed for tests so they can reset the module-level lock between cases.
export function __resetRunArchiveSchedulerForTest() {
  if (archiveTimer) {
    clearTimeout(archiveTimer);
    archiveTimer = null;
  }
  archiveSchedulerEnabled = false;
  archiveRunning = false;
}
