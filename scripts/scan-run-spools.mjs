#!/usr/bin/env node
// DS-14: offline read-only spool scanner + validated dedupe migration.
//
// Scans every run spool under <root>/chat-runs and reports, per run and in
// aggregate: structured records, raw-only records, duplicate-equivalent
// records (line === JSON.stringify(json) — the historical double-write that
// runs.mjs now drops at write time), lineArtifact refs (including missing
// ones), plain/gz/zst form, terminal age, bad/oversized lines, and the
// estimated reclaimable bytes (serialized size of the dropped `line` field).
//
// Default is dry-run: read-only, never deletes or rewrites anything.
//
// Usage:
//   node scripts/scan-run-spools.mjs [--root DIR] [--limit N] [--json-out PATH]
//       [--rewrite DIR] [--throttle-ms N]
//
// Migration (--rewrite DIR): writes a deduplicated copy of each terminal
// run's PLAIN spool into DIR as <runId>.spool.jsonl, but only after the
// written copy verifies (sha256 + record count + trailing record match the
// source). Live runs and archived (gz/zst) spools are skipped. Originals are
// never touched. Exit code 1 when any migration fails verification.

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { formatBytes, migrateRunSpool, scanAllRunSpools } from '../chat/run-spool-reclaim.mjs';

const DEFAULT_ROOT = '/var/lib/ragent/config';

function parseArgs(argv) {
  const out = {
    root: DEFAULT_ROOT,
    limit: Infinity,
    jsonOut: null,
    rewriteDir: null,
    throttleMs: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--root') out.root = argv[i + 1];
    else if (argv[i] === '--limit') out.limit = Number(argv[i + 1]);
    else if (argv[i] === '--json-out') out.jsonOut = argv[i + 1];
    else if (argv[i] === '--rewrite') out.rewriteDir = argv[i + 1];
    else if (argv[i] === '--throttle-ms') out.throttleMs = Number(argv[i + 1]);
    else if (argv[i] === '--help') {
      console.log(`Usage: node scripts/scan-run-spools.mjs [options]
  --root DIR       runs root (default ${DEFAULT_ROOT})
  --limit N        cap the number of runs scanned
  --json-out PATH  write the full report as JSON
  --rewrite DIR    migrate plain terminal spools to deduplicated copies in DIR
                   (dry-run scan by default; originals are never modified)
  --throttle-ms N  sleep between records while migrating (default 0)
  --help           show this help`);
      process.exit(0);
    }
  }
  return out;
}

function printTable(runs) {
  console.log(`| run | state | form | bytes | records | bad | oversize | structured | raw | dup | dup bytes | lineArtifact | missing ref | term age |`);
  console.log(`|-----|-------|------|------:|--------:|----:|---------:|-----------:|----:|----:|----------:|-------------:|------------:|---------:|`);
  for (const run of runs) {
    console.log(
      `| ${run.runId} | ${run.state || '-'} | ${run.form} | ${run.spoolBytes} | ${run.totalRecords} | ${run.badLines} | ${run.oversizedLines} | ${run.structuredRecords} | ${run.rawOnlyRecords} | ${run.duplicateRecords} | ${run.duplicateBytes} | ${run.lineArtifactRefs} | ${run.missingArtifactRefs} | ${run.terminalAgeMs === null ? '-' : `${Math.round(run.terminalAgeMs / 3600000)}h`} |`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const report = { mode: options.rewriteDir ? 'SCAN+MIGRATE' : 'SCAN (dry-run)', root: options.root, generatedAt: new Date().toISOString() };

  const { runsRoot, runs, totals, error } = await scanAllRunSpools({
    root: options.root,
    limit: options.limit,
  });
  if (error) {
    console.error(`[spool-reclaim] ${error}`);
    process.exit(1);
  }
  report.runsRoot = runsRoot;
  report.totals = totals;

  console.log(`[spool-reclaim] ${totals.runsScanned} runs scanned (${totals.runsWithSpool} with spool)`);
  console.log(
    `  form: plain=${totals.plain} gz=${totals.gz} zst=${totals.zst} | terminal=${totals.terminalRuns}`,
  );
  console.log(
    `  records: total=${totals.totalRecords} parseable=${totals.parseableRecords} bad=${totals.badLines} oversized=${totals.oversizedLines}`,
  );
  console.log(
    `  structured=${totals.structuredRecords} raw-only=${totals.rawOnlyRecords} lineArtifact=${totals.lineArtifactRefs} missing-ref=${totals.missingArtifactRefs}`,
  );
  console.log(
    `  duplicates: ${totals.duplicateRecords} records, ~${formatBytes(totals.duplicateBytes)} reclaimable`,
  );
  if (totals.oldestTerminalAgeMs !== null) {
    console.log(
      `  oldest terminal: ${totals.oldestTerminalAgeRun} (${Math.round(totals.oldestTerminalAgeMs / 3600000)}h)`,
    );
  }
  printTable(runs.slice(0, Math.min(40, runs.length)));

  if (options.rewriteDir) {
    await mkdir(options.rewriteDir, { recursive: true });
    const migrations = [];
    let failed = 0;
    for (const run of runs) {
      if (run.form !== 'plain' || !run.terminal) continue;
      const runDir = join(runsRoot, run.runId);
      process.stdout.write(`  migrate ${run.runId} ... `);
      const result = await migrateRunSpool(runDir, {
        outDir: options.rewriteDir,
        throttleMs: options.throttleMs,
      });
      migrations.push({ runId: run.runId, ...result });
      if (result.ok) {
        console.log(`ok -> ${result.writtenPath}`);
      } else {
        failed += 1;
        console.log(`REFUSED: ${result.reasons.join(' ')}`);
      }
    }
    report.migrations = migrations;
    console.log(`[spool-reclaim] migrated ${migrations.filter((m) => m.ok).length}, refused ${failed}`);
    if (failed > 0) process.exitCode = 1;
  }

  if (options.jsonOut) {
    await writeFile(options.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[spool-reclaim] report: ${options.jsonOut}`);
  }
}

await main();
