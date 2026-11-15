#!/usr/bin/env node
// Cold-archive terminal-run spools: stream-compress spool.jsonl -> spool.jsonl.gz
// (gzip, default) or spool.jsonl.zst (zstd, opt-in) and delete the plain file.
// chat/runs.mjs reads both forms transparently, so run history stays fully
// readable while disk usage drops by ~86% on terminal runs (15.4 GB -> ~2.2 GB
// measured 2026-08-05 with gzip).
//
// This is the CLI entrypoint; the core logic lives in chat/run-spool-archive.mjs
// and is shared with the in-process scheduler (startRunArchiveScheduler).
//
// Safety:
//   - Only terminal runs (completed/failed/cancelled) are touched; running and
//     accepted runs keep their appendable plain spool.
//   - Compression streams through a sha256 tee (never readFile's the spool),
//     is written to a temp file that is fsync'ed before rename, then verified
//     by streaming it back through the decompressor and comparing hash + byte
//     count against the original (retained in a .meta.json sidecar); the plain
//     file is removed only after verification succeeds. Any failure keeps the
//     plain spool untouched.
//   - Never touches manifest.json / status.json / result.json / artifacts/.
//
// Usage:
//   node scripts/archive-run-spools.mjs [--root DIR] [--dry-run] [--apply]
//       [--limit N] [--min-bytes N] [--throttle-ms N] [--min-age-ms N]
//       [--codec gzip|zstd] [--per-tick-bytes N] [--verify] [--json-out PATH]
//
// Default is dry-run (read-only). Pass --dry-run=false or --apply to archive.
//
// Throttling: APPLY mode sleeps --throttle-ms (default 50) between files so the
// batch does not saturate the disk and starve the chat server (a full-speed run
// measured ~28 GB of combined I/O and caused a system-wide slowdown on
// 2026-08-05). Pass --throttle-ms 0 to disable. For very large batches also run
// under: nice -n 19 ionice -c3.
//
// Retention gate: --min-age-ms skips terminal runs whose completedAt/updatedAt
// is younger than the gate (default 0 = no gate; the scheduler uses 1h).
//
// Verify mode (--verify): scan the runs dir for existing archives and re-check
// each against its meta sidecar (sha256 + byte count of the original spool).
// Legacy archives without a sidecar are checked for decompression integrity
// only. Exit code 1 when any archive fails verification.

import { readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { archiveTerminalSpools, formatBytes, verifyArchivedSpool } from '../chat/run-spool-archive.mjs';

const DEFAULT_ROOT = '/var/lib/ragent/config';

function parseArgs(argv) {
  const out = {
    root: DEFAULT_ROOT,
    apply: false,
    limit: Infinity,
    minBytes: 0,
    throttleMs: null,
    minAgeMs: 0,
    codec: 'gzip',
    perTickBytes: Infinity,
    verify: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[i + 1];
    else if (argv[i] === '--limit') out.limit = Number(argv[i + 1]);
    else if (argv[i] === '--min-bytes') out.minBytes = Number(argv[i + 1]);
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--throttle-ms') out.throttleMs = Number(argv[i + 1]);
    else if (argv[i] === '--min-age-ms') out.minAgeMs = Number(argv[i + 1]);
    else if (argv[i] === '--codec') out.codec = argv[i + 1];
    else if (argv[i] === '--per-tick-bytes') out.perTickBytes = Number(argv[i + 1]);
    else if (argv[i] === '--verify') out.verify = true;
    else if (argv[i] === '--json-out') out.jsonOut = argv[i + 1];
  }
  // APPLY defaults to throttled; DRY-RUN is a read scan, leave it unthrottled
  // unless explicitly requested.
  if (out.throttleMs === null || Number.isNaN(out.throttleMs)) {
    out.throttleMs = out.apply ? 50 : 0;
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv);
  const runsRoot = join(options.root, 'chat-runs');

  if (options.verify) {
    const report = { mode: 'VERIFY', root: runsRoot, checked: 0, valid: 0, invalid: [], legacy: 0 };
    let entries = [];
    try {
      entries = await readdir(runsRoot);
    } catch {
      console.error(`[archive] VERIFY: runs dir not readable: ${runsRoot}`);
      process.exit(1);
    }
    for (const name of entries) {
      if (!name.startsWith('run_')) continue;
      const dir = join(runsRoot, name);
      for (const suffix of ['.gz', '.zst']) {
        const archivePath = join(dir, `spool.jsonl${suffix}`);
        try {
          await stat(archivePath);
        } catch {
          continue;
        }
        report.checked += 1;
        const result = await verifyArchivedSpool(archivePath);
        const label = result.hashCheckable
          ? `${result.codec} ${formatBytes(result.actualBytes)} sha256:${(result.actualSha256 || '').slice(0, 12)}`
          : `${result.codec} ${formatBytes(result.actualBytes)} (legacy, no sidecar)`;
        if (!result.hashCheckable) report.legacy += 1;
        if (result.valid) {
          report.valid += 1;
          console.log(`[archive] VERIFY ok: ${name} ${label}`);
        } else {
          report.invalid.push({ runId: name, archivePath, reason: result.reason || 'invalid' });
          console.error(`[archive] VERIFY FAILED: ${name} ${label} — ${result.reason}`);
        }
      }
    }
    console.log(
      `[archive] VERIFY: checked ${report.checked} archives, ${report.valid} valid, ` +
        `${report.invalid.length} invalid, ${report.legacy} legacy (decompress-only check)`,
    );
    if (options.jsonOut) {
      await writeFile(options.jsonOut, JSON.stringify(report, null, 2));
    }
    if (report.invalid.length > 0) process.exit(1);
    return;
  }

  const summary = await archiveTerminalSpools({
    root: runsRoot,
    apply: options.apply,
    limit: options.limit,
    minBytes: options.minBytes,
    throttleMs: options.throttleMs,
    minAgeMs: options.minAgeMs,
    codec: options.codec,
    perTickBytes: options.perTickBytes,
  });

  const mode = summary.mode;
  console.log(
    `[archive] ${mode} (${summary.codec}): scanned ${summary.scannedRuns} runs, ${summary.candidates} terminal spool candidates (${formatBytes(summary.candidateBytes)})`,
  );
  if (summary.skippedByAge > 0) {
    console.log(`[archive] ${mode}: skipped ${summary.skippedByAge} candidates younger than the retention gate`);
  }
  if (options.limit !== Infinity) {
    console.log(`[archive] ${mode}: processing first ${Math.min(summary.candidates, options.limit)} by size`);
  }
  if (summary.tickStopped) {
    console.log(`[archive] ${mode}: stopped by ${summary.tickStopped} (${summary.remainingCandidates} candidates left for the next tick)`);
  }
  if (options.apply && options.throttleMs > 0) {
    console.log(`[archive] ${mode}: throttling ${options.throttleMs}ms between files`);
  }
  console.log(
    `[archive] ${mode}: archived ${summary.archived} spools, freed ${formatBytes(summary.freedBytes)}, archived size ~${formatBytes(summary.archivedBytes)}`,
  );
  if (summary.failures.length) {
    console.log(`[archive] ${mode}: ${summary.failures.length} FAILURES`);
    for (const f of summary.failures.slice(0, 10)) console.log(`  ${f.runId}: ${f.error}`);
  }

  if (options.jsonOut) {
    await writeFile(options.jsonOut, JSON.stringify(summary, null, 2));
  }
}

main().catch((error) => {
  console.error('[archive] FAILED:', error.message);
  process.exit(1);
});
