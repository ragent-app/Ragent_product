#!/usr/bin/env node
// opt(ds-00): read-only optimization baseline collector for the 2026-08 deep
// optimization program (DS-00). Collects source / install / data facts into a
// machine-readable JSON payload (or a human summary) WITHOUT reading secrets.
//
// Contract:
//   - Never reads env values, tokens, cookies, private keys, real message
//     bodies or real attachment contents. Env presence is recorded as
//     name -> boolean only. File hashes are sha256, never file contents.
//   - Never deletes, compresses, restarts, kills or migrates anything.
//   - Degrades gracefully: on a clean instance (no service, no journalctl,
//     no healthz endpoint, no git repo) every missing source is null / empty
//     and the exit code stays 0, so the script can run anywhere read-only.
//   - Flags: --source-root DIR (default /srv/ragent-promoted),
//     --data-root DIR (default /var/lib/ragent/config),
//     --json (machine-readable single JSON document on stdout),
//     --healthz-url URL (default http://127.0.0.1:7690/healthz; "" disables),
//     --log-since "24 hours ago" (journalctl window),
//     --log-unit UNIT (default ragent.service).
//
// Usage:
//   node scripts/collect-optimization-baseline.mjs [--source-root DIR] [--data-root DIR] [--json] [flags...]

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_VERSION = '1.1.0';
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Argument parsing (tiny, no deps)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { sourceRoot: '/srv/ragent-promoted', dataRoot: '/var/lib/ragent/config', json: false, healthzUrl: 'http://127.0.0.1:7690/healthz', logSince: '24 hours ago', logUnit: 'ragent.service' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--source-root') args.sourceRoot = argv[++i];
    else if (a === '--data-root') args.dataRoot = argv[++i];
    else if (a === '--healthz-url') args.healthzUrl = argv[++i];
    else if (a === '--log-since') args.logSince = argv[++i];
    else if (a === '--log-unit') args.logUnit = argv[++i];
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else { console.error(`collect-optimization-baseline: unknown option ${a}`); printUsage(); process.exit(2); }
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node collect-optimization-baseline.mjs [--source-root DIR] [--data-root DIR] [--json] [--healthz-url URL] [--log-since "24 hours ago"] [--log-unit ragent.service]`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Run a command, return { status, stdout, stderr } or null on spawn failure.
// Output bytes are processed locally only; nothing is printed unless the
// caller prints it.
function run(cmd, argList, opts = {}) {
  const timeout = opts.timeout ?? 30000;
  const res = spawnSync(cmd, argList, { encoding: 'utf8', timeout, maxBuffer: 512 * 1024 * 1024 });
  if (res.error) return null;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function sha256Of(file) {
  try {
    const buf = fs.readFileSync(file);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// File count under dir via `find ... -printf '.'` byte counting (fast on
// huge trees like chat-history with ~660k files).
function countFiles(dir) {
  const res = run('find', [dir, '-type', 'f', '-printf', '.'], { timeout: 60000 });
  if (!res) return null;
  return res.stdout.length;
}

function dirSizeBytes(dir) {
  const res = run('du', ['-sb', dir], { timeout: 60000 });
  if (!res || res.status !== 0) return null;
  const m = /^(\d+)/.exec(res.stdout);
  return m ? Number(m[1]) : null;
}

// Top-N largest files under one or more directories, as { bytes, path }.
function largestFiles(dirs, n = 5) {
  const rows = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const res = run('find', [dir, '-type', 'f', '-printf', '%s %p\n'], { timeout: 60000 });
    if (!res) continue;
    for (const line of res.stdout.split('\n')) {
      const m = /^(\d+) (.*)$/.exec(line);
      if (m) rows.push({ bytes: Number(m[1]), path: m[2] });
    }
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows.slice(0, n);
}

// ---------------------------------------------------------------------------
// Collectors — each returns a plain JSON-safe value and never throws.
// ---------------------------------------------------------------------------

function collectHost() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    kernelRelease: os.release(),
    uptimeSec: Math.round(os.uptime()),
    cpuCores: os.cpus().length,
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
    loadAvg: os.loadavg().map((x) => Math.round(x * 100) / 100),
  };
}

// df -k per mount point of the paths this program cares about (/srv source,
// /opt install, /var/lib data, / root). Values are sizes in KiB.
function collectDisk() {
  const res = run('df', ['-k', '/', '/srv', '/opt', '/var/lib']);
  if (!res || res.status !== 0) return [];
  const out = [];
  const seen = new Set();
  for (const line of res.stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const mount = cols[5];
    if (seen.has(mount)) continue;
    seen.add(mount);
    out.push({ mount, totalKiB: Number(cols[1]), usedKiB: Number(cols[2]), availKiB: Number(cols[3]), usePct: cols[4] });
  }
  return out;
}

function collectRuntime() {
  const git = run('git', ['--version']);
  return {
    nodeVersion: process.version,
    npmVersion: run('npm', ['--version'])?.stdout.trim() || null,
    gitVersion: git && git.status === 0 ? git.stdout.trim() : null,
  };
}

function collectGit(sourceRoot) {
  // Read-only git introspection of the source root. A missing repo is fine.
  const head = run('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']);
  const branch = run('git', ['-C', sourceRoot, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run('git', ['-C', sourceRoot, 'status', '--short']);
  const name = run('git', ['-C', sourceRoot, 'config', 'user.name']);
  const email = run('git', ['-C', sourceRoot, 'config', 'user.email']);
  if (!head || head.status !== 0) return null;
  const dirtyFiles = status && status.status === 0 ? status.stdout.split('\n').filter(Boolean) : [];
  return {
    headCommit: head.stdout.trim(),
    branch: branch && branch.status === 0 ? branch.stdout.trim() : null,
    dirtyCount: dirtyFiles.length,
    dirtyFiles,
    identity: {
      name: name && name.status === 0 ? name.stdout.trim() : null,
      email: email && email.status === 0 ? email.stdout.trim() : null,
    },
  };
}

// Key entry points pinned at baseline. Missing files are skipped (null hash).
const KEY_FILES = [
  'package.json',
  'package-lock.json',
  'chat-server.mjs',
  'cli.js',
  'chat/router.mjs',
  'chat/session-manager.mjs',
  'chat/runs.mjs',
  'chat/history.mjs',
  'chat/summarizer.mjs',
  'chat/background-ai-queue.mjs',
  'chat/session-memory-writeback.mjs',
  'static/chat/i18n.js',
  'static/chat/chat.css',
];

function collectSource(sourceRoot) {
  const out = { root: sourceRoot, fileCount: null, jsFileCount: null, testFileCount: null, staticFileCount: null, sizeBytes: null, keyFileHashes: {} };
  if (!fs.existsSync(sourceRoot)) return out;
  // Source file count excludes node_modules and .git (vendor/deps are not
  // "source" for this program).
  out.fileCount = run('bash', ['-c', `find "$0" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '.'`, sourceRoot])?.stdout.length ?? null;
  out.jsFileCount = run('bash', ['-c', `find "$0" -type f \\( -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '.'`, sourceRoot])?.stdout.length ?? null;
  out.testFileCount = run('bash', ['-c', `find "$0/tests" -type f -name 'test-*.mjs' -printf '.'`, sourceRoot])?.stdout.length ?? null;
  out.staticFileCount = run('bash', ['-c', `find "$0/static" -type f -printf '.'`, sourceRoot])?.stdout.length ?? null;
  out.sizeBytes = dirSizeBytes(sourceRoot);
  for (const rel of KEY_FILES) {
    const abs = path.join(sourceRoot, rel);
    const hash = sha256Of(abs);
    if (hash) out.keyFileHashes[rel] = hash;
  }
  return out;
}

function collectPackage(sourceRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    return { name: pkg.name ?? null, version: pkg.version ?? null, scripts: pkg.scripts ?? {} };
  } catch {
    return null;
  }
}

// Data subdirectories the program cares about (per DS-00). Missing dirs are
// recorded as null instead of skipped, so drift is visible.
const DATA_SUBDIRS = ['chat-history', 'chat-runs', 'file-assets', 'provider-runtime-homes', 'api-logs', 'backups', 'shared-snapshots', 'images', 'usage-ledger'];

const SPOOL_ARTIFACT_DIRS = ['chat-runs', 'file-assets', 'shared-snapshots', 'backups', 'run-spool', 'spool'];

function collectData(dataRoot) {
  const out = { root: dataRoot, totalSizeBytes: null, subdirs: {}, largestFiles: [] };
  if (!fs.existsSync(dataRoot)) return out;
  out.totalSizeBytes = dirSizeBytes(dataRoot);
  for (const name of DATA_SUBDIRS) {
    const dir = path.join(dataRoot, name);
    if (!fs.existsSync(dir)) { out.subdirs[name] = null; continue; }
    out.subdirs[name] = { sizeBytes: dirSizeBytes(dir), fileCount: countFiles(dir) };
  }
  out.largestFiles = largestFiles(SPOOL_ARTIFACT_DIRS.map((d) => path.join(dataRoot, d)), 5);
  return out;
}

const SERVICE_UNITS = ['ragent.service', 'ragent-runner-lifecycle.service', 'ragent-runner-supervisor.service', 'ragent-privileged-executor.service', 'ragent-health-watchdog.timer'];

function collectServices() {
  const out = {};
  for (const unit of SERVICE_UNITS) {
    const show = run('systemctl', ['show', unit, '--property=ExecMainPID,ExecStart,ActiveState,MemoryCurrent,CPUUsageNSec,ExecMainStartTimestamp']);
    if (!show || show.status !== 0) { out[unit] = null; continue; }
    const props = {};
    for (const line of show.stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    let cmdline = null;
    const execStart = props.ExecStart || '';
    const argvMatch = /argv\[\]([^;]*)/.exec(execStart);
    if (argvMatch) {
      try {
        const json = argvMatch[1].trim().replace(/^=/, '');
        const arr = JSON.parse(json);
        cmdline = Array.isArray(arr) ? arr.map(String) : null;
      } catch {
        cmdline = null;
      }
    }
    out[unit] = {
      activeState: props.ActiveState ?? null,
      execMainPID: props.ExecMainPID && props.ExecMainPID !== '0' ? Number(props.ExecMainPID) : null,
      cmdline,
      memoryCurrentBytes: props.MemoryCurrent && props.MemoryCurrent !== '[not set]' ? Number(props.MemoryCurrent) : null,
      cpuUsageNSec: props.CPUUsageNSec && props.CPUUsageNSec !== '[not set]' ? Number(props.CPUUsageNSec) : null,
      startedAt: props.ExecMainStartTimestamp && props.ExecMainStartTimestamp !== '[not set]' ? props.ExecMainStartTimestamp : null,
    };
  }
  return out;
}

// Active processes whose cmdline lives under /opt/ragent (app + vendor AI).
// Vendor AI processes (claude/codex) are counted but their cmdline is not
// recorded (may embed session/resume ids); app processes keep a truncated
// cmdline (run ids are operational identifiers, no secrets).
function collectProcesses() {
  const res = run('ps', ['-eo', 'pid=,rss=,pcpu=,comm=,args='], { timeout: 15000 });
  if (!res) return { total: null, appProcesses: [], vendorAiCount: 0 };
  let total = 0;
  const appProcesses = [];
  let vendorAiCount = 0;
  for (const line of res.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, rss, pcpu, comm, args] = m;
    total += 1;
    if (args.startsWith('/opt/ragent/')) {
      appProcesses.push({ pid: Number(pid), rssBytes: Number(rss) * 1024, cpuPct: Number(pcpu), comm, cmdline: args.length > 220 ? `${args.slice(0, 220)}…` : args });
    } else if (comm === 'claude' || comm === 'codex') {
      vendorAiCount += 1;
    }
  }
  return { total, appProcesses, vendorAiCount };
}

// Event-loop healthz from the running chat server. Read-only GET.
async function collectHealthz(healthzUrl) {
  if (!healthzUrl) return null;
  try {
    const res = await fetch(healthzUrl, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!res.ok) return { httpStatus: res.status, ok: false };
    return await res.json();
  } catch (err) {
    return null;
  }
}

// Background-AI log statistics: keyword line counts in the journal window.
// Only counts are recorded — never log content, message bodies or prompts.
const LOG_KEYWORDS = ['summarizer', 'task-card', 'workflow-state', 'memory-writeback', 'background-ai'];

function collectBackgroundAiLogs(unit, since) {
  const res = run('journalctl', ['-u', unit, '--since', since, '--no-pager', '-o', 'short'], { timeout: 45000 });
  if (!res || res.status !== 0) return { unit, since, totalLines: null, matched: null };
  const lines = res.stdout.split('\n');
  const matched = {};
  for (const kw of LOG_KEYWORDS) {
    matched[kw] = lines.filter((l) => l.toLowerCase().includes(kw)).length;
  }
  return { unit, since, totalLines: lines.filter(Boolean).length, matched };
}

// Test command inventory from package.json scripts (npm test smoke combos).
function collectTests(pkg) {
  if (!pkg) return [];
  return Object.keys(pkg.scripts)
    .filter((k) => k.startsWith('test'))
    .sort()
    .map((k) => ({ name: k, command: pkg.scripts[k] }));
}

// Env var PRESENCE only — names matching the curated pattern get a boolean,
// values are never read or recorded.
function collectEnvPresence() {
  const names = Object.keys(process.env)
    .filter((k) => /^(RAGENT_|ANTHROPIC_|OPENAI_|GEMINI_|DEEPSEEK_|CODEX_|GITHUB_|GOOGLE_)/.test(k))
    .sort();
  const presence = {};
  for (const n of names) presence[n] = true;
  return presence;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const pkg = collectPackage(args.sourceRoot);

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    collector: { script: 'scripts/collect-optimization-baseline.mjs', version: SCRIPT_VERSION },
    generatedAt: new Date().toISOString(),
    host: collectHost(),
    disk: collectDisk(),
    runtime: collectRuntime(),
    git: collectGit(args.sourceRoot),
    source: collectSource(args.sourceRoot),
    package: pkg,
    data: collectData(args.dataRoot),
    services: collectServices(),
    processes: collectProcesses(),
    healthz: await collectHealthz(args.healthzUrl),
    backgroundAiLogs: collectBackgroundAiLogs(args.logUnit, args.logSince),
    tests: collectTests(pkg),
    envPresence: collectEnvPresence(),
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  // Human-readable summary (used for the docs report).
  const lines = [];
  lines.push(`Ragent optimization baseline (collector v${SCRIPT_VERSION})`);
  lines.push(`generated: ${payload.generatedAt}`);
  lines.push(`host: ${payload.host.hostname} (${payload.host.platform}/${payload.host.arch}, ${payload.host.cpuCores} cores, ${Math.round(payload.host.memTotalBytes / 1048576)} MiB RAM)`);
  for (const d of payload.disk) lines.push(`disk ${d.mount}: ${d.usePct} used (${(d.usedKiB / 1048576).toFixed(0)} GiB / ${(d.totalKiB / 1048576).toFixed(0)} GiB)`);
  if (payload.git) lines.push(`git: ${payload.git.branch} @ ${payload.git.headCommit} (${payload.git.dirtyCount} dirty)`);
  if (payload.source) lines.push(`source ${payload.source.root}: ${payload.source.fileCount} files, ${payload.source.sizeBytes != null ? `${(payload.source.sizeBytes / 1048576).toFixed(1)} MiB` : 'n/a'}`);
  for (const [rel, hash] of Object.entries(payload.source?.keyFileHashes ?? {})) lines.push(`  sha256 ${rel} = ${hash}`);
  if (payload.data) {
    lines.push(`data ${payload.data.root}: ${payload.data.totalSizeBytes != null ? `${(payload.data.totalSizeBytes / 1048576).toFixed(1)} MiB` : 'n/a'}`);
    for (const [name, info] of Object.entries(payload.data.subdirs ?? {})) {
      if (!info) { lines.push(`  ${name}: missing`); continue; }
      lines.push(`  ${name}: ${info.fileCount} files, ${(info.sizeBytes / 1048576).toFixed(1)} MiB`);
    }
  }
  for (const [unit, info] of Object.entries(payload.services ?? {})) {
    lines.push(`service ${unit}: ${info ? `${info.activeState} pid=${info.execMainPID} rss=${info.memoryCurrentBytes != null ? `${(info.memoryCurrentBytes / 1048576).toFixed(0)} MiB` : 'n/a'}` : 'not present'}`);
  }
  const hl = payload.healthz;
  lines.push(`healthz: ${hl ? `ok=${hl.ok} rss=${hl.rssBytes != null ? `${(hl.rssBytes / 1048576).toFixed(0)} MiB` : 'n/a'} elMean=${hl.eventLoopDelayMs?.mean ?? 'n/a'}ms elMax=${hl.eventLoopDelayMs?.max ?? 'n/a'}ms` : 'unreachable'}`);
  const logs = payload.backgroundAiLogs;
  if (logs && logs.matched) lines.push(`bg-ai logs (${logs.unit}, ${logs.since}): ${JSON.stringify(logs.matched)}`);
  lines.push(`tests: ${payload.tests.length} test scripts (first: ${payload.tests[0]?.name ?? 'n/a'})`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((err) => {
  console.error(`collect-optimization-baseline: fatal: ${err?.stack || err}`);
  process.exit(1);
});
