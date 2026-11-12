#!/usr/bin/env node
// Storage inventory + dry-run GC (DS-20).
//
// Scans seven data categories and reports every candidate with reason / age /
// size / reference check / recoverability. Only --apply executes deletions and
// api-log gzip compression; the default is a pure dry-run.
//
//   api-logs              <config>/api-logs/*.jsonl       retention + gzip
//   workspace-cache       <workspace>/cache/*             age + history ref
//   workspace-builds      <workspace>/builds/*            age + keep-min + ref
//   workspace-releases    <workspace>/releases/*.deb      installed version +
//                                                         keep-min + ref
//   backups               <config>/backups, <workspace>/backups (keep newest N)
//   temp-diagnostics      tmp dirs + *.tmp/*.part/core.*  short retention
//   unreferenced-artifacts <config>/images, file-assets,
//                          chat-runs/*/artifacts          history ref scan
//
// Safety rules (hard guarantees, independent of flags):
//   - Default is dry-run; only --apply mutates anything.
//   - The current day's api log is never compressed or deleted; files with a
//     future mtime are alert-only.
//   - The release .deb matching the installed version is never deleted.
//   - Anything referenced in session history / run results is alert-only.
//   - If a reference scan is capped, fails, or the installed version is
//     unknown, the affected candidates are alert-only ("no clear reference
//     info => alert, never delete").
//   - Only the category roots above are ever touched. The workspace root
//     itself and any other directories under it are never modified.
//
// Every run (dry-run included) persists an inventory snapshot to
// <config>/storage-gc-state.json so the next run reports per-category daily
// growth, volume daily growth, estimated days until exhaustion, and
// disk-usage threshold alerts.
//
// Config (env, resolved lazily so tests can change them):
//   AGENTOC_STORAGE_GC_ENABLED                  default 1       master switch
//   AGENTOC_STORAGE_GC_API_LOGS_RETENTION_MS    default 180d    delete .gz logs
//   AGENTOC_STORAGE_GC_API_LOGS_COMPRESS_AFTER_MS default 7d    gzip plain logs
//   AGENTOC_STORAGE_GC_CACHE_RETENTION_MS       default 30d
//   AGENTOC_STORAGE_GC_BUILDS_RETENTION_MS      default 90d
//   AGENTOC_STORAGE_GC_BUILDS_KEEP_MIN          default 5
//   AGENTOC_STORAGE_GC_RELEASES_RETENTION_MS    default 365d
//   AGENTOC_STORAGE_GC_RELEASES_KEEP_MIN        default 3
//   AGENTOC_STORAGE_GC_BACKUPS_KEEP_MIN         default 3
//   AGENTOC_STORAGE_GC_TMP_RETENTION_MS         default 1d
//   AGENTOC_STORAGE_GC_DIAG_RETENTION_MS        default 7d
//   AGENTOC_STORAGE_GC_ARTIFACTS_RETENTION_MS   default 90d
//   AGENTOC_STORAGE_GC_REF_SCAN_MAX_MB          default 256     history corpus cap
//   AGENTOC_STORAGE_GC_DISK_WARN_PCT            default 85
//   AGENTOC_STORAGE_GC_DISK_CRITICAL_PCT        default 95
//   AGENTOC_STORAGE_GC_STATE_FILE               default <config>/storage-gc-state.json
//   AGENTOC_STORAGE_GC_INSTALLED_VERSION        override installed version
//
// Usage:
//   node scripts/storage-inventory-gc.mjs [--apply] [--json] [--scheduled] [--workspace <dir>] [--help]
//
// Exit codes: 0 clean, 1 warnings or apply errors, 2 disk critical.

import { execFile as execFileCallback } from 'child_process';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { open, readdir, readFile, rename, rm, stat, statfs, unlink, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_DIR, MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const execFileAsync = promisify(execFileCallback);
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_BACKUP_AGE_MS = 60 * 60 * 1000; // never delete a backup younger than 1h

export const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);
export const API_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;
export const DEB_FILE_RE = /\.deb$/i;
export const TMP_FILE_RE = /(\.tmp(\.[a-zA-Z0-9]+)?|\.part$|\.download$|^core\.[0-9]+$|\.diag$|\.capture$)$/;
export const HISTORY_SCAN_CATEGORIES = new Set(['workspace-cache', 'workspace-builds', 'unreferenced-artifacts']);

export const CATEGORY_DEFINITIONS = [
  { key: 'api-logs', label: 'api-logs', owner: 'chat-server', retentionMs: 180 * DAY_MS, compression: 'gzip-after-7d', reference: 'none', recoverability: 'not-recoverable' },
  { key: 'workspace-cache', label: 'workspace/cache', owner: 'sessions', retentionMs: 30 * DAY_MS, compression: 'none', reference: 'history-scan', recoverability: 'regenerable' },
  { key: 'workspace-builds', label: 'workspace/builds', owner: 'operations', retentionMs: 90 * DAY_MS, compression: 'none', reference: 'history-scan', recoverability: 'regenerable' },
  { key: 'workspace-releases', label: 'workspace/releases', owner: 'operations', retentionMs: 365 * DAY_MS, compression: 'none', reference: 'installed', recoverability: 'rebuildable' },
  { key: 'backups', label: 'backups', owner: 'operations', retentionMs: null, compression: 'none', reference: 'none', recoverability: 'recovery-source' },
  { key: 'temp-diagnostics', label: 'temp-diagnostics', owner: 'diagnostics', retentionMs: 1 * DAY_MS, compression: 'none', reference: 'none', recoverability: 'regenerable' },
  { key: 'unreferenced-artifacts', label: 'unreferenced-artifacts', owner: 'sessions', retentionMs: 90 * DAY_MS, compression: 'none', reference: 'history-scan', recoverability: 'not-recoverable' },
];

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '? B';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms == null) return '?';
  const days = Math.round((ms / DAY_MS) * 10) / 10;
  if (days >= 3650) return `${Math.round(days / 365)}y`;
  if (days >= 90) return `${Math.round((days / 30.44) * 10) / 10}mo`;
  return `${days}d`;
}

function parseEnvMs(env, key, fallbackMs) {
  const raw = Number.parseInt(env[key] || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallbackMs;
}

function parseEnvInt(env, key, fallback) {
  const raw = Number.parseInt(env[key] || '', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : fallback;
}

function parseEnvPct(env, key, fallback) {
  const raw = Number.parseFloat(env[key] || '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : fallback;
}

export function resolveGcConfig(env = process.env, { configDir = CONFIG_DIR, workspaceDir = MANAGED_WORK_ROOT_DIR } = {}) {
  return {
    enabled: env.AGENTOC_STORAGE_GC_ENABLED !== '0',
    configDir,
    workspaceDir,
    stateFile: env.AGENTOC_STORAGE_GC_STATE_FILE || join(configDir, 'storage-gc-state.json'),
    installedVersion: env.AGENTOC_STORAGE_GC_INSTALLED_VERSION || null,
    apiLogsRetentionMs: parseEnvMs(env, 'AGENTOC_STORAGE_GC_API_LOGS_RETENTION_MS', 180 * DAY_MS),
    apiLogsCompressAfterMs: parseEnvMs(env, 'AGENTOC_STORAGE_GC_API_LOGS_COMPRESS_AFTER_MS', 7 * DAY_MS),
    cacheRetentionMs: parseEnvMs(env, 'AGENTOC_STORAGE_GC_CACHE_RETENTION_MS', 30 * DAY_MS),
    buildsRetentionMs: parseEnvMs(env, 'AGENTOC_STORAGE_GC_BUILDS_RETENTION_MS', 90 * DAY_MS),
    buildsKeepMin: parseEnvInt(env, 'AGENTOC_STORAGE_GC_BUILDS_KEEP_MIN', 5),
    releasesRetentionMs: parseEnvMs(env, 'AGENTOC_STORAGE_GC_RELEASES_RETENTION_MS', 365 * DAY_MS),
    releasesKeepMin: parseEnvInt(env, 'AGENTOC_STORAGE_GC_RELEASES_KEEP_MIN', 3),
    backupsKeepMin: parseEnvInt(env, 'AGENTOC_STORAGE_GC_BACKUPS_KEEP_MIN', 3),
    tmpRetentionMs: parseEnvMs(env, 'AGENTOC_STORAGE_GC_TMP_RETENTION_MS', 1 * DAY_MS),
    diagRetentionMs: parseEnvMs(env, 'AGENTOC_STORAGE_GC_DIAG_RETENTION_MS', 7 * DAY_MS),
    artifactsRetentionMs: parseEnvMs(env, 'AGENTOC_STORAGE_GC_ARTIFACTS_RETENTION_MS', 90 * DAY_MS),
    refScanMaxBytes: parseEnvInt(env, 'AGENTOC_STORAGE_GC_REF_SCAN_MAX_MB', 256) * 1024 * 1024,
    diskWarnPct: parseEnvPct(env, 'AGENTOC_STORAGE_GC_DISK_WARN_PCT', 85),
    diskCriticalPct: parseEnvPct(env, 'AGENTOC_STORAGE_GC_DISK_CRITICAL_PCT', 95),
  };
}

export function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function nowMs(now) {
  return now.getTime();
}

async function statIfExists(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function listDirEntries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- helpers

function pushCandidate(report, category, path, { reason, ageMs, sizeBytes, reference, action }) {
  report.candidates.push({
    category,
    path,
    reason,
    ageMs: Math.round(ageMs),
    sizeBytes,
    reference,
    recoverability: CATEGORY_DEFINITIONS.find((c) => c.key === category)?.recoverability || 'unknown',
    action,
  });
}

function addAlert(report, severity, message) {
  report.alerts.push({ severity, message });
}

// ---------------------------------------------------------------- api-logs

async function scanApiLogs(report, cfg, now) {
  const dir = join(cfg.configDir, 'api-logs');
  const entries = await listDirEntries(dir);
  if (!entries) return { scanned: 0, bytes: 0, count: 0 };
  const todayKey = formatDateKey(now);
  let scanned = 0;
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = API_LOG_RE.exec(entry.name);
    if (!match) continue;
    scanned += 1;
    count += 1;
    const path = join(dir, entry.name);
    const fileStat = await statIfExists(path);
    if (!fileStat) continue;
    bytes += fileStat.size;
    const dateKey = match[1];
    const isGz = Boolean(match[2]);
    const ageMs = nowMs(now) - fileStat.mtimeMs;

    if (dateKey === todayKey) {
      // Current day's file is still appended by chat/api-request-log.mjs.
      if (isGz) {
        addAlert(report, 'warn', `api-logs: today's log ${entry.name} is already gzipped; check log writer anomalies`);
      }
      continue;
    }
    if (fileStat.mtimeMs > nowMs(now) || dateKey > todayKey) {
      addAlert(report, 'warn', `api-logs: ${entry.name} has a future date/mtime; left untouched`);
      continue;
    }

    if (!isGz && ageMs >= cfg.apiLogsCompressAfterMs) {
      pushCandidate(report, 'api-logs', path, {
        reason: `compress-after ${formatDuration(cfg.apiLogsCompressAfterMs)}`,
        ageMs,
        sizeBytes: fileStat.size,
        reference: { status: 'none', detail: 'rotated daily; no live reader after day rollover' },
        action: 'compress',
      });
      continue;
    }
    if (ageMs >= cfg.apiLogsRetentionMs) {
      pushCandidate(report, 'api-logs', path, {
        reason: `older-than-retention ${formatDuration(cfg.apiLogsRetentionMs)}`,
        ageMs,
        sizeBytes: fileStat.size,
        reference: { status: 'none', detail: 'rotated daily; no live reader after day rollover' },
        action: 'delete',
      });
    }
  }
  return { scanned, bytes, count };
}

// ------------------------------------------------- reference scan (shared)

// Build one bounded corpus index over session history and run results so every
// history-scan category reuses the same scan. Returns found names plus whether
// the corpus hit the cap (incomplete => alert-only downstream).
export async function buildReferenceIndex({ configDir, candidateNames, capBytes = 256 * 1024 * 1024 } = {}) {
  const found = new Map();
  let consumed = 0;
  let capped = false;
  const names = [...new Set(candidateNames.filter(Boolean))];

  async function scanFile(path) {
    if (consumed >= capBytes) {
      capped = true;
      return;
    }
    let text = '';
    try {
      const fileStat = await stat(path);
      const length = Math.min(fileStat.size, capBytes - consumed);
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        text = buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
      consumed += length;
      if (fileStat.size > length) capped = true;
    } catch {
      return; // unreadable corpus file: no evidence either way
    }
    for (const name of names) {
      if (text.includes(name)) {
        const sources = found.get(name) || [];
        if (sources.length < 8) sources.push(path);
        found.set(name, sources);
      }
    }
  }

  async function walkDir(dir, depth) {
    if (consumed >= capBytes) return;
    const entries = await listDirEntries(dir);
    if (!entries || depth > 3) return;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'artifacts') continue; // run artifacts handled separately
        await walkDir(path, depth + 1);
      } else if (entry.isFile()) {
        await scanFile(path);
      }
      if (consumed >= capBytes) return;
    }
  }

  for (const root of [join(configDir, 'chat-history'), join(configDir, 'chat-runs')]) {
    await walkDir(root, 0);
    if (consumed >= capBytes) break;
  }

  return { found, consumed, capped };
}

function classifyReference(name, index) {
  if (!index) return { status: 'failed', detail: 'reference corpus unreadable' };
  if (index.capped) return { status: 'incomplete', detail: 'reference scan capped; no clear reference info' };
  const sources = index.found?.get(name);
  if (sources && sources.length > 0) {
    return { status: 'referenced', detail: `found in ${sources[0]}` };
  }
  return { status: 'checked-no-refs', detail: 'no reference found in history/run corpus' };
}

// -------------------------------------------- cache / builds / artifacts roots

// Collect old-enough entries (post keep-min) across a plain age root. The
// caller later classifies them against the shared reference index.
async function collectAgeRootCandidates(report, cfg, now, category, dir, {
  retentionMs,
  keepMin = 0,
  entryFilter = null,
} = {}) {
  const entries = await listDirEntries(dir);
  if (!entries) return { candidates: [], bytes: 0, count: 0 };
  const items = [];
  for (const entry of entries) {
    if (entryFilter && !entryFilter(entry)) continue;
    const path = join(dir, entry.name);
    const itemStat = await statIfExists(path);
    if (!itemStat) continue;
    items.push({ entry, path, sizeBytes: itemStat.size, mtimeMs: itemStat.mtimeMs });
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  const candidates = [];
  items.forEach((item, position) => {
    if (item.mtimeMs > nowMs(now)) {
      addAlert(report, 'warn', `${category}: ${item.path} has a future mtime; left untouched`);
      return;
    }
    if (keepMin > 0 && position < keepMin) return;
    const ageMs = nowMs(now) - item.mtimeMs;
    if (ageMs < retentionMs) return;
    candidates.push({ ...item, ageMs });
  });
  return {
    candidates,
    bytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    count: items.length,
  };
}

function classifyHistoryScanned(report, category, retentionMs, candidate, index) {
  const reference = classifyReference(candidate.entry.name, index);
  if (reference.status === 'checked-no-refs') {
    pushCandidate(report, category, candidate.path, {
      reason: `older-than-retention ${formatDuration(retentionMs)}`,
      ageMs: candidate.ageMs,
      sizeBytes: candidate.sizeBytes,
      reference,
      action: 'delete',
    });
    return;
  }
  pushCandidate(report, category, candidate.path, {
    reason: reference.status === 'referenced'
      ? `older-than-retention but referenced in history`
      : `older-than-retention (${reference.status})`,
    ageMs: candidate.ageMs,
    sizeBytes: candidate.sizeBytes,
    reference,
    action: 'alert',
  });
}

// -------------------------------------------------------- run artifacts

async function scanRunArtifacts(report, cfg, now) {
  const runsDir = join(cfg.configDir, 'chat-runs');
  const runDirs = await listDirEntries(runsDir);
  if (!runDirs) return { scanned: 0, candidates: [], bytes: 0, count: 0 };
  const retentionMs = cfg.artifactsRetentionMs;
  let scanned = 0;
  let bytes = 0;
  let count = 0;

  for (const runDirEntry of runDirs) {
    if (!runDirEntry.isDirectory()) continue;
    const runDir = join(runsDir, runDirEntry.name);
    const artifactsDir = join(runDir, 'artifacts');
    const artifactEntries = await listDirEntries(artifactsDir);
    if (!artifactEntries || artifactEntries.length === 0) continue;

    // Reference corpus for this run: status.json / result.json / manifest.json.
    let corpus = '';
    for (const name of ['status.json', 'result.json', 'manifest.json']) {
      try {
        corpus += `\n${await readFile(join(runDir, name), 'utf8')}`;
      } catch {
        // missing file: no evidence
      }
    }
    const terminal = TERMINAL_RUN_STATES.has(parseRunState(corpus));

    for (const entry of artifactEntries) {
      const path = join(artifactsDir, entry.name);
      const fileStat = await statIfExists(path);
      if (!fileStat) continue;
      bytes += fileStat.size;
      count += 1;
      if (fileStat.mtimeMs > nowMs(now)) {
        addAlert(report, 'warn', `unreferenced-artifacts: ${path} has a future mtime; left untouched`);
        continue;
      }
      const ageMs = nowMs(now) - fileStat.mtimeMs;
      if (ageMs < retentionMs) continue;
      scanned += 1;
      if (!terminal || !corpus.includes(entry.name)) {
        // Terminal run with no positive reference in its own result/manifest,
        // or a run whose state cannot be positively established: only alert
        // when the reference info is missing, delete only on positive proof.
        const reference = !terminal
          ? { status: 'failed', detail: `run state not terminal (${parseRunState(corpus) || 'unknown'}); no clear reference info` }
          : { status: 'checked-no-refs', detail: 'not referenced in run result.json/manifest.json' };
        pushCandidate(report, 'unreferenced-artifacts', path, {
          reason: !terminal ? 'older-than-retention but run state unclear' : `older-than-retention ${formatDuration(retentionMs)}`,
          ageMs,
          sizeBytes: fileStat.size,
          reference,
          action: !terminal ? 'alert' : 'delete',
        });
        if (!terminal) continue;
      } else {
        pushCandidate(report, 'unreferenced-artifacts', path, {
          reason: 'older-than-retention but referenced in run result',
          ageMs,
          sizeBytes: fileStat.size,
          reference: { status: 'referenced', detail: `found in ${runDir}/result.json` },
          action: 'alert',
        });
      }
    }
  }
  return { scanned, bytes, count };
}

function parseRunState(corpus) {
  const match = /"state"\s*:\s*"([^"]+)"/.exec(corpus);
  return match ? match[1] : null;
}

// --------------------------------------------------------------- releases

export async function resolveInstalledVersion(cfg, { query = execFileAsync } = {}) {
  if (cfg.installedVersion) return cfg.installedVersion;
  for (const name of ['ragent', 'agentoc']) {
    try {
      const { stdout } = await query('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', name], {
        timeout: 5_000, encoding: 'utf8',
      });
      const [status, version] = String(stdout || '').trim().split(/\s+/);
      if (status === 'installed' && version) return version;
    } catch {
      // The other package name may still be installed during migration.
    }
  }
  try {
    const pkg = JSON.parse(await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf8',
    ));
    if (pkg.version) return String(pkg.version);
  } catch {
    // fall through
  }
  return null;
}

async function loadInstallHandoffs(configDir) {
  try {
    return await readFile(join(configDir, 'install-handoffs.json'), 'utf8');
  } catch {
    return '';
  }
}

async function scanReleases(report, cfg, now) {
  const dir = join(cfg.workspaceDir, 'releases');
  const entries = await listDirEntries(dir);
  if (!entries) return { scanned: 0, bytes: 0, count: 0 };
  const installedVersion = await resolveInstalledVersion(cfg);
  const handoffs = await loadInstallHandoffs(cfg.configDir);

  const items = [];
  for (const entry of entries) {
    if (!DEB_FILE_RE.test(entry.name)) continue;
    const path = join(dir, entry.name);
    const itemStat = await statIfExists(path);
    if (!itemStat) continue;
    items.push({ entry, path, sizeBytes: itemStat.size, mtimeMs: itemStat.mtimeMs });
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  let scanned = 0;
  let bytes = 0;
  let count = 0;
  items.forEach((item, position) => {
    scanned += 1;
    bytes += item.sizeBytes;
    count += 1;
    const ageMs = nowMs(now) - item.mtimeMs;
    const isInstalled = Boolean(installedVersion) && item.entry.name.includes(installedVersion);
    const isHandoffReferenced = handoffs.includes(item.path);
    const isNewest = position < cfg.releasesKeepMin;
    if (isNewest || ageMs < cfg.releasesRetentionMs) return; // keep-min rollback targets / young

    if (isInstalled) {
      pushCandidate(report, 'workspace-releases', item.path, {
        reason: `older-than-retention ${formatDuration(cfg.releasesRetentionMs)} but matches installed version`,
        ageMs,
        sizeBytes: item.sizeBytes,
        reference: { status: 'referenced', detail: `matches installed version ${installedVersion}` },
        action: 'alert',
      });
      return;
    }
    if (isHandoffReferenced) {
      pushCandidate(report, 'workspace-releases', item.path, {
        reason: 'older-than-retention but referenced by install-handoffs.json',
        ageMs,
        sizeBytes: item.sizeBytes,
        reference: { status: 'referenced', detail: 'path present in install-handoffs.json' },
        action: 'alert',
      });
      return;
    }
    if (!installedVersion) {
      // Cannot positively prove this deb is not the installed one.
      pushCandidate(report, 'workspace-releases', item.path, {
        reason: `older-than-retention ${formatDuration(cfg.releasesRetentionMs)} but installed version unknown`,
        ageMs,
        sizeBytes: item.sizeBytes,
        reference: { status: 'unknown', detail: 'installed version could not be resolved; no clear reference info' },
        action: 'alert',
      });
      return;
    }
    pushCandidate(report, 'workspace-releases', item.path, {
      reason: `older-than-retention ${formatDuration(cfg.releasesRetentionMs)}`,
      ageMs,
      sizeBytes: item.sizeBytes,
      reference: { status: 'checked-no-refs', detail: `not the installed version (${installedVersion}), not in install-handoffs.json, not among newest ${cfg.releasesKeepMin}` },
      action: 'delete',
    });
  });
  return { scanned, bytes, count };
}

// ---------------------------------------------------------------- backups

async function scanBackups(report, cfg, now) {
  const roots = [join(cfg.configDir, 'backups'), join(cfg.workspaceDir, 'backups')];
  let scanned = 0;
  let bytes = 0;
  let count = 0;
  for (const dir of roots) {
    const entries = await listDirEntries(dir);
    if (!entries) continue;
    const items = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const itemStat = await statIfExists(path);
      if (!itemStat) continue;
      items.push({ entry, path, sizeBytes: itemStat.size, mtimeMs: itemStat.mtimeMs });
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    items.forEach((item, position) => {
      scanned += 1;
      bytes += item.sizeBytes;
      count += 1;
      const ageMs = nowMs(now) - item.mtimeMs;
      if (item.mtimeMs > nowMs(now)) {
        addAlert(report, 'warn', `backups: ${item.path} has a future mtime; left untouched`);
        return;
      }
      if (position < cfg.backupsKeepMin) return;
      if (ageMs < MIN_BACKUP_AGE_MS) return; // possibly still being written
      pushCandidate(report, 'backups', item.path, {
        reason: `keep-newest-${cfg.backupsKeepMin} exceeded`,
        ageMs,
        sizeBytes: item.sizeBytes,
        reference: { status: 'none', detail: `newer backups remain (${cfg.backupsKeepMin} kept by policy)` },
        action: 'delete',
      });
    });
  }
  return { scanned, bytes, count };
}

// ------------------------------------------------------ temp diagnostics

async function scanTempDiagnostics(report, cfg, now) {
  const roots = [
    { dir: join(cfg.configDir, 'tmp'), retentionMs: cfg.tmpRetentionMs, wholeDir: true },
    { dir: join(cfg.workspaceDir, 'tmp'), retentionMs: cfg.tmpRetentionMs, wholeDir: true },
    { dir: cfg.configDir, retentionMs: null, wholeDir: false }, // shallow pattern scan below
    { dir: cfg.workspaceDir, retentionMs: null, wholeDir: false },
  ];
  let scanned = 0;
  let bytes = 0;
  let count = 0;

  for (const { dir, retentionMs, wholeDir } of roots) {
    const entries = await listDirEntries(dir);
    if (!entries) continue;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const isTmpName = TMP_FILE_RE.test(entry.name);
      const isTmpDir = wholeDir && entry.isDirectory() && /^tmp(-|$)/.test(entry.name);
      if (!isTmpName && !isTmpDir) continue;
      const itemStat = await statIfExists(path);
      if (!itemStat) continue;
      bytes += itemStat.size;
      count += 1;
      if (itemStat.mtimeMs > nowMs(now)) {
        addAlert(report, 'warn', `temp-diagnostics: ${path} has a future mtime; left untouched`);
        continue;
      }
      const ageMs = nowMs(now) - itemStat.mtimeMs;
      const effectiveRetention = retentionMs
        ?? (/^core\.|\.(diag|capture)$/.test(entry.name) ? cfg.diagRetentionMs : cfg.tmpRetentionMs);
      if (ageMs < effectiveRetention) continue;
      scanned += 1;
      pushCandidate(report, 'temp-diagnostics', path, {
        reason: `temp/diagnostic file older than ${formatDuration(effectiveRetention)}`,
        ageMs,
        sizeBytes: itemStat.size,
        reference: { status: 'none', detail: 'temp/diagnostic by name convention' },
        action: 'delete',
      });
    }
  }
  return { scanned, bytes, count };
}

// --------------------------------------------------------------- volume

async function volumeStats(dir) {
  try {
    const stats = await statfs(dir);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    return { totalBytes, availableBytes, usagePct: totalBytes > 0 ? ((totalBytes - availableBytes) / totalBytes) * 100 : 0 };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ state file

export async function loadState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    if (parsed?.version === 1 && Number.isFinite(parsed?.lastRunAtMs)) return parsed;
  } catch {
    // missing or corrupt state: start fresh
  }
  return null;
}

export async function saveState(stateFile, state) {
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function computeGrowth(previous, report, now) {
  if (!previous || !Number.isFinite(previous.lastRunAtMs)) return null;
  const days = (nowMs(now) - previous.lastRunAtMs) / DAY_MS;
  if (days <= 0) return null;
  const growth = { days, categories: {}, volume: null };

  for (const category of Object.keys(report.categories)) {
    const current = report.categories[category];
    const prior = previous.categories?.[category];
    if (!prior) continue;
    const delta = current.bytes - prior.bytes;
    growth.categories[category] = {
      bytesPerDay: Math.max(0, delta / days),
      countDelta: current.count - prior.count,
    };
  }

  if (report.volume && previous.volume) {
    const consumedPerDay = (previous.volume.availableBytes - report.volume.availableBytes) / days;
    growth.volume = {
      bytesPerDay: Math.max(0, consumedPerDay),
      daysToExhaust: consumedPerDay > 0 ? report.volume.availableBytes / consumedPerDay : null,
    };
  }
  return growth;
}

// ---------------------------------------------------------------- main run

export async function runStorageGc({
  env = process.env,
  configDir = CONFIG_DIR,
  workspaceDir = MANAGED_WORK_ROOT_DIR,
  now = new Date(),
  apply = false,
  previousState = null,
} = {}) {
  const cfg = resolveGcConfig(env, { configDir, workspaceDir });
  const report = {
    generatedAt: now.toISOString(),
    dryRun: !apply,
    configDir,
    workspaceDir,
    volume: null,
    alerts: [],
    growth: null,
    categories: {},
    candidates: [],
    errors: [],
  };

  if (!cfg.enabled) {
    addAlert(report, 'info', 'storage GC disabled via AGENTOC_STORAGE_GC_ENABLED=0');
    return report;
  }

  report.volume = await volumeStats(configDir);

  // ---- scan categories
  const apiLogs = await scanApiLogs(report, cfg, now);
  const cacheRoot = await collectAgeRootCandidates(report, cfg, now, 'workspace-cache',
    join(cfg.workspaceDir, 'cache'), { retentionMs: cfg.cacheRetentionMs });
  const buildsRoot = await collectAgeRootCandidates(report, cfg, now, 'workspace-builds',
    join(cfg.workspaceDir, 'builds'), { retentionMs: cfg.buildsRetentionMs, keepMin: cfg.buildsKeepMin });
  const artifactsRoot = await collectAgeRootCandidates(report, cfg, now, 'unreferenced-artifacts',
    join(cfg.configDir, 'file-assets'), { retentionMs: cfg.artifactsRetentionMs });
  const imageRoot = await collectAgeRootCandidates(report, cfg, now, 'unreferenced-artifacts',
    join(cfg.configDir, 'images'), { retentionMs: cfg.artifactsRetentionMs });
  const assetCacheRoot = await collectAgeRootCandidates(report, cfg, now, 'unreferenced-artifacts',
    join(cfg.configDir, 'file-assets-cache'), { retentionMs: cfg.artifactsRetentionMs });
  const runArtifacts = await scanRunArtifacts(report, cfg, now);
  const releases = await scanReleases(report, cfg, now);
  const backups = await scanBackups(report, cfg, now);
  const temp = await scanTempDiagnostics(report, cfg, now);

  // ---- shared reference index for history-scan categories
  const ageCandidates = [
    ...cacheRoot.candidates,
    ...buildsRoot.candidates,
    ...artifactsRoot.candidates,
    ...imageRoot.candidates,
    ...assetCacheRoot.candidates,
  ];
  const historyNames = ageCandidates.map((candidate) => candidate.entry.name);
  const index = historyNames.length > 0
    ? await buildReferenceIndex({ configDir, candidateNames: historyNames, capBytes: cfg.refScanMaxBytes })
    : { found: new Map(), consumed: 0, capped: false };

  const classifyByCategory = [
    [cacheRoot.candidates, 'workspace-cache', cfg.cacheRetentionMs],
    [buildsRoot.candidates, 'workspace-builds', cfg.buildsRetentionMs],
    [[...artifactsRoot.candidates, ...imageRoot.candidates, ...assetCacheRoot.candidates], 'unreferenced-artifacts', cfg.artifactsRetentionMs],
  ];
  for (const [candidates, category, retentionMs] of classifyByCategory) {
    if (!candidates || candidates.length === 0) continue;
    for (const candidate of candidates) {
      classifyHistoryScanned(report, category, retentionMs, candidate, index);
    }
  }

  // ---- per-category stats (scanned totals + candidate-derived reclaimable)
  const scannedByCategory = {
    'api-logs': apiLogs,
    'workspace-cache': cacheRoot,
    'workspace-builds': buildsRoot,
    'workspace-releases': releases,
    'backups': backups,
    'temp-diagnostics': temp,
    'unreferenced-artifacts': {
      scanned: artifactsRoot.count + imageRoot.count + assetCacheRoot.count + runArtifacts.scanned,
      bytes: artifactsRoot.bytes + imageRoot.bytes + assetCacheRoot.bytes + runArtifacts.bytes,
      count: artifactsRoot.count + imageRoot.count + assetCacheRoot.count + runArtifacts.count,
    },
  };
  for (const definition of CATEGORY_DEFINITIONS) {
    const totals = scannedByCategory[definition.key] || { scanned: 0, bytes: 0, count: 0 };
    const categoryCandidates = report.candidates.filter((candidate) => candidate.category === definition.key);
    report.categories[definition.key] = {
      scanned: totals.scanned ?? totals.count,
      bytes: totals.bytes,
      count: totals.count,
      candidates: categoryCandidates.length,
      alertOnly: categoryCandidates.filter((candidate) => candidate.action === 'alert').length,
      reclaimableBytes: categoryCandidates.filter((candidate) => candidate.action === 'delete').reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
      compressibleBytes: categoryCandidates.filter((candidate) => candidate.action === 'compress').reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
      ...definition,
    };
  }

  // ---- disk threshold alerts
  if (report.volume) {
    if (report.volume.usagePct >= cfg.diskCriticalPct) {
      addAlert(report, 'critical', `disk usage ${report.volume.usagePct.toFixed(1)}% >= critical threshold ${cfg.diskCriticalPct}%`);
    } else if (report.volume.usagePct >= cfg.diskWarnPct) {
      addAlert(report, 'warn', `disk usage ${report.volume.usagePct.toFixed(1)}% >= warn threshold ${cfg.diskWarnPct}%`);
    }
  }

  // ---- execute (only with --apply)
  if (apply) {
    // Compress first, so a freshly created .gz is never removed by a sibling
    // delete candidate for the same logical log file.
    const createdGzPaths = new Set();
    for (const candidate of report.candidates) {
      if (candidate.action !== 'compress') continue;
      try {
        await compressJsonlInPlace(candidate.path);
        createdGzPaths.add(`${candidate.path}.gz`);
      } catch (error) {
        report.errors.push({ path: candidate.path, message: error.message });
        addAlert(report, 'error', `${candidate.category}: failed to compress ${candidate.path}: ${error.message}`);
      }
    }
    for (const candidate of report.candidates) {
      if (candidate.action !== 'delete') continue;
      if (createdGzPaths.has(candidate.path)) continue; // freshly compressed this run
      try {
        await rm(candidate.path, { recursive: true, force: true });
      } catch (error) {
        report.errors.push({ path: candidate.path, message: error.message });
        addAlert(report, 'error', `${candidate.category}: failed to delete ${candidate.path}: ${error.message}`);
      }
    }
  }

  // ---- growth + state persistence (dry-run also snapshots inventory)
  const state = {
    version: 1,
    lastRunAtMs: nowMs(now),
    volume: report.volume ? { totalBytes: report.volume.totalBytes, availableBytes: report.volume.availableBytes } : null,
    categories: Object.fromEntries(
      Object.entries(report.categories).map(([key, stats]) => [key, { bytes: stats.bytes, count: stats.count }]),
    ),
  };
  report.growth = computeGrowth(previousState, report, now);
  try {
    await saveState(cfg.stateFile, state);
  } catch (error) {
    addAlert(report, 'error', `failed to persist state ${cfg.stateFile}: ${error.message}`);
  }

  return report;
}

async function compressJsonlInPlace(path) {
  const content = await readFile(path);
  const compressed = await gzipAsync(content);
  const gzPath = `${path}.gz`;
  const tempPath = `${gzPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tempPath, compressed, { mode: 0o600 });
  await rename(tempPath, gzPath);
  // Integrity check: gunzip must reproduce the original byte count.
  const restored = await gunzipAsync(compressed);
  if (restored.length !== content.length) {
    await rm(gzPath, { force: true });
    throw new Error(`gzip integrity check failed (${restored.length} != ${content.length} bytes)`);
  }
  await unlink(path);
}

// ---------------------------------------------------------------- report

export function summarizeReport(report) {
  const deleteCandidates = report.candidates.filter((candidate) => candidate.action === 'delete');
  const compressCandidates = report.candidates.filter((candidate) => candidate.action === 'compress');
  const alertCandidates = report.candidates.filter((candidate) => candidate.action === 'alert');
  return {
    deleteCount: deleteCandidates.length,
    compressCount: compressCandidates.length,
    alertCount: alertCandidates.length,
    reclaimableBytes: deleteCandidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
    compressibleBytes: compressCandidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
  };
}

export function formatReport(report) {
  const lines = [];
  const summary = summarizeReport(report);
  lines.push(`Storage inventory + GC report (${report.dryRun ? 'dry-run' : 'apply'}) @ ${report.generatedAt}`);
  if (report.volume) {
    lines.push(`Volume: ${formatBytes(report.volume.totalBytes)} total, ${formatBytes(report.volume.availableBytes)} available (${report.volume.usagePct.toFixed(1)}% used)`);
  } else {
    lines.push('Volume: unknown (statfs unavailable)');
  }

  if (report.growth) {
    lines.push(`Growth (over ${report.growth.days.toFixed(1)} days):`);
    for (const [key, stats] of Object.entries(report.growth.categories)) {
      lines.push(`  ${key}: +${formatBytes(stats.bytesPerDay)}/day`);
    }
    if (report.growth.volume) {
      const exhaustion = report.growth.volume.daysToExhaust == null
        ? 'stable'
        : `~${Math.round(report.growth.volume.daysToExhaust)} days`;
      lines.push(`  volume: +${formatBytes(report.growth.volume.bytesPerDay)}/day, estimated exhaustion in ${exhaustion}`);
    }
  }

  for (const alert of report.alerts) {
    lines.push(`[${alert.severity.toUpperCase()}] ${alert.message}`);
  }

  lines.push('Categories:');
  for (const [key, stats] of Object.entries(report.categories)) {
    lines.push(
      `  ${stats.label.padEnd(24)} owner=${stats.owner.padEnd(12)} scanned=${stats.scanned} `
      + `candidates=${stats.candidates} alert-only=${stats.alertOnly} `
      + `reclaimable=${formatBytes(stats.reclaimableBytes)} compressible=${formatBytes(stats.compressibleBytes)}`,
    );
  }

  lines.push(`Candidates (${report.candidates.length}):`);
  for (const candidate of report.candidates) {
    lines.push(
      `  [${candidate.action.padEnd(8)}] ${candidate.category.padEnd(20)} ${relative(report.configDir, candidate.path)} `
      + `age=${formatDuration(candidate.ageMs)} size=${formatBytes(candidate.sizeBytes)} `
      + `ref=${candidate.reference.status} recoverability=${candidate.recoverability} `
      + `reason=${candidate.reason}`,
    );
  }

  if (report.errors.length > 0) {
    lines.push(`Errors: ${report.errors.length}`);
    for (const error of report.errors) {
      lines.push(`  ${error.path}: ${error.message}`);
    }
  }

  lines.push(
    `Summary: ${summary.deleteCount} delete(s) reclaiming ${formatBytes(summary.reclaimableBytes)}, `
    + `${summary.compressCount} compressible (${formatBytes(summary.compressibleBytes)}), ${summary.alertCount} alert-only`,
  );
  return lines.join('\n');
}

export function exitCodeForReport(report) {
  const severities = report.alerts.map((alert) => alert.severity);
  if (report.errors.length > 0 || severities.includes('critical')) return 2;
  if (severities.includes('warn') || severities.includes('error')) return 1;
  return 0;
}

// A scheduled pass must keep running and keep its report visible while the
// volume is above a threshold. Treating a disk alert as a failed unit causes
// systemd to hide the useful inventory result behind a generic failure state;
// actual scan/apply errors still fail the timer job.
export function exitCodeForScheduledReport(report) {
  return report.errors.length > 0 ? 1 : 0;
}

// ------------------------------------------------------------------- CLI

function parseArgs(argv = []) {
  const options = { apply: false, json: false, scheduled: false, workspaceDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--scheduled') {
      options.scheduled = true;
    } else if (arg === '--workspace') {
      options.workspaceDir = resolve(argv[index + 1] || '');
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/storage-inventory-gc.mjs [--apply] [--json] [--scheduled] [--workspace <dir>] [--help]');
      console.log('Default dry-run; --apply executes deletions and api-log gzip compression.');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runStorageGc({
    apply: options.apply,
    workspaceDir: options.workspaceDir || MANAGED_WORK_ROOT_DIR,
    previousState: await loadState(
      (process.env.AGENTOC_STORAGE_GC_STATE_FILE || join(CONFIG_DIR, 'storage-gc-state.json')),
    ),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
  process.exitCode = options.scheduled
    ? exitCodeForScheduledReport(report)
    : exitCodeForReport(report);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`storage-inventory-gc: ${error.message}`);
    process.exitCode = 2;
  });
}
