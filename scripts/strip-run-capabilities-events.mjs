#!/usr/bin/env node
// Strip the persisted per-event providerCapabilities copy from chat-history
// event files. Provider capabilities are run-level metadata whose authority is
// the run record (chat/runs.mjs); events used to embed a ~1KB clone at write
// time. The persist boundary now strips it (chat/history.mjs
// appendEvent/appendEvents) and read paths enrich it back from the run record
// (enrichRunCapabilities, chat/session-manager.mjs), so the stored copies are
// dead weight: sampled 83% of event files carry the field (2026-08-06,
// ~400k files across chat-history).
//
// Safety:
//   - Only <session>/events/*.json files are touched; bodies/, meta.json,
//     projection files, run spools, and assets are never modified.
//   - Rewrites are atomic (temp file + rename). Files without the field are
//     skipped untouched. Corrupt JSON is skipped and counted, never deleted.
//   - Idempotent and re-runnable: a second pass finds nothing to do.
//   - The field is dropped from the event object only; the run record keeps it.
//
// Byte accounting: releasedBytes is the same quantity in both modes — the
// serialized size difference between the stored file and the stripped rewrite
// (i.e. the duplicated providerCapabilities field bytes + separators). Dry-run
// computes it without writing; apply reports the measured post-rewrite delta.
//
// Usage:
//   node scripts/strip-run-capabilities-events.mjs [--root DIR] [--dry-run]
//       [--apply] [--limit N] [--throttle-ms N] [--json-out PATH]
//
// Default is dry-run (read-only scan + stats). Pass --apply to rewrite.
//
// Throttling: APPLY mode sleeps --throttle-ms (default 25) between files.
// chat-history holds ~600k small files; a full-speed pass saturates the disk
// and starves the chat server on this 2-core host. For very large batches run
// under: nice -n 19 ionice -c3. --limit N processes at most N files and stops,
// so a large migration can be split into quiet-window chunks.

import { readdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_ROOT = '/var/lib/ragent/config/chat-history';
const PROGRESS_EVERY = 5000;

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, apply: false, limit: Infinity, throttleMs: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[i + 1];
    else if (argv[i] === '--limit') out.limit = Number(argv[i + 1]);
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--throttle-ms') out.throttleMs = Number(argv[i + 1]);
    else if (argv[i] === '--json-out') out.jsonOut = argv[i + 1];
  }
  // APPLY defaults to throttled; DRY-RUN is a read scan, leave it unthrottled
  // unless explicitly requested.
  if (out.throttleMs === null || Number.isNaN(out.throttleMs)) {
    out.throttleMs = out.apply ? 25 : 0;
  }
  if (!Number.isFinite(out.limit) || out.limit < 1) out.limit = Infinity;
  return out;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function main() {
  const options = parseArgs(process.argv);
  const startedAt = Date.now();
  const stats = {
    sessions: 0,
    scanned: 0,
    withField: 0,
    skipped: 0,
    corrupt: 0,
    readErrors: 0,
    rewritten: 0,
    releasedBytes: 0,
  };

  const sessionDirs = await readdir(options.root, { withFileTypes: true }).catch(() => []);
  let stoppedByLimit = false;

  outer:
  for (const entry of sessionDirs) {
    if (!entry.isDirectory()) continue;
    const eventsDir = join(options.root, entry.name, 'events');
    const files = await readdir(eventsDir).catch(() => []);
    if (files.length === 0) continue;
    stats.sessions += 1;

    for (const fileName of files) {
      if (!fileName.endsWith('.json')) continue;
      if (stats.scanned >= options.limit) {
        stoppedByLimit = true;
        break outer;
      }
      stats.scanned += 1;
      const filePath = join(eventsDir, fileName);

      let raw;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch {
        stats.readErrors += 1;
        continue;
      }
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        stats.corrupt += 1;
        continue;
      }
      if (!event || event.providerCapabilities === undefined) {
        stats.skipped += 1;
        continue;
      }
      stats.withField += 1;
      delete event.providerCapabilities;
      const rewritten = `${JSON.stringify(event, null, 2)}\n`;
      // Same quantity in both modes: the exact serialized delta of dropping the
      // duplicated field (measured, not estimated). Dry-run writes nothing.
      const released = raw.length - rewritten.length;
      if (!options.apply) {
        stats.releasedBytes += released;
        continue;
      }

      const tmpPath = `${filePath}.tmp`;
      await writeFile(tmpPath, rewritten, 'utf8');
      await rename(tmpPath, filePath);
      stats.rewritten += 1;
      stats.releasedBytes += released;
      await sleep(options.throttleMs);

      if (stats.scanned % PROGRESS_EVERY === 0) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.log(`[strip-capabilities] ${stats.scanned} scanned, ${stats.withField} with field, ${stats.rewritten} rewritten, ${elapsed}s`);
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const result = {
    mode: options.apply ? 'apply' : 'dry-run',
    root: options.root,
    sessions: stats.sessions,
    scanned: stats.scanned,
    withField: stats.withField,
    skipped: stats.skipped,
    corrupt: stats.corrupt,
    readErrors: stats.readErrors,
    rewritten: stats.rewritten,
    releasedBytes: stats.releasedBytes,
    limit: Number.isFinite(options.limit) ? options.limit : null,
    stoppedByLimit,
    elapsedMs,
  };

  if (options.jsonOut) {
    await writeFile(options.jsonOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  console.log(`[strip-capabilities] ${options.apply ? 'APPLY' : 'DRY-RUN'} done: ${stats.scanned} files scanned across ${stats.sessions} sessions, ${stats.withField} with providerCapabilities, ${stats.rewritten} rewritten, ${stats.corrupt} corrupt skipped, ${stats.readErrors} read errors, ${((result.releasedBytes) / (1024 * 1024)).toFixed(1)} MB duplicated-field bytes, ${(elapsedMs / 1000).toFixed(0)}s${stoppedByLimit ? ' (stopped by --limit)' : ''}`);
  process.exitCode = options.apply ? 0 : 0;
}

main().catch((error) => {
  console.error(`[strip-capabilities] fatal: ${error?.stack || error}`);
  process.exit(1);
});
