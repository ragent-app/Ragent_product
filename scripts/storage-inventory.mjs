#!/usr/bin/env node
// Storage capacity inventory + dry-run reclamation estimate (Phase A of
// docs/ragent-storage-capacity-analysis.md).
//
// Purely read-only. It walks the active config dir and reports:
//   - top-level disk distribution
//   - per-run spool/artifact bytes grouped by terminal state
//   - per-session history bytes (events/bodies/meta/projection)
//   - per-asset descriptor vs object bytes, missing-object and orphan-object
//   - snapshot JSON vs .assets/ consistency
//   - daily growth by run creation date
//   - estimated reclaimable bytes (terminal spool, orphans) — nothing is
//     deleted, renamed, or migrated by this script.
//
// With --deep-refs it additionally scans every chat-history event and every
// snapshot for fasset_/hash references (attachment assetId, artifactFileId,
// localResultFileRewrites), computes sha256 of each asset object, and reports
// unreferenced assets. Slow path — not the default.
//
// Usage:
//   node scripts/storage-inventory.mjs [--root DIR] [--top N] [--deep-refs]
//       [--json-out PATH] [--md-out PATH]
//
// Exit 0 on success; never mutates anything.

import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';

const DEFAULT_ROOT = '/var/lib/ragent/config';
const SNAPSHOT_DIR_NAME = 'shared-snapshots';

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    top: 10,
    deepRefs: false,
    jsonOut: '',
    mdOut: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--top') {
      const value = Number.parseInt(argv[index + 1] || '', 10);
      index += 1;
      if (Number.isInteger(value) && value > 0) options.top = value;
    } else if (arg === '--deep-refs') {
      options.deepRefs = true;
    } else if (arg === '--json-out') {
      options.jsonOut = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--md-out') {
      options.mdOut = argv[index + 1] || '';
      index += 1;
    }
  }
  return options;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// Run `fn` over `items` with bounded concurrency, preserving order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function walkBytes(root) {
  // Recursive byte/file count for a directory tree.
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isSymbolicLink()) {
        // Count the link target once via lstat; avoid following into loops.
        try {
          bytes += (await stat(full)).size;
          files += 1;
        } catch {
          // dangling symlink — ignore
        }
      } else {
        try {
          bytes += (await stat(full)).size;
          files += 1;
        } catch {
          // raced away — ignore
        }
      }
    }
  }
  return { bytes, files };
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sha256OfBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function analyzeRuns(runsRoot, top) {
  const result = {
    dirs: 0,
    unreadable: 0,
    byState: {},
    largest: [],
  };
  if (!(await dirExists(runsRoot))) return result;

  let entries;
  try {
    entries = await readdir(runsRoot);
  } catch {
    return result;
  }
  const runDirs = entries.filter((name) => name.startsWith('run_'));
  result.dirs = runDirs.length;

  const summaries = await mapLimit(runDirs, 32, async (name) => {
    const dir = join(runsRoot, name);
    let status = null;
    let spoolBytes = 0;
    let artifactBytes = 0;
    let otherBytes = 0;
    try {
      const files = await readdir(dir, { withFileTypes: true });
      for (const entry of files) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'artifacts') {
            const walk = await walkBytes(full);
            artifactBytes += walk.bytes;
          } else {
            const walk = await walkBytes(full);
            otherBytes += walk.bytes;
          }
        } else {
          const size = (await stat(full)).size;
          if (entry.name === 'spool.jsonl' || entry.name.endsWith('.spool.jsonl')) {
            spoolBytes += size;
          } else if (entry.name === 'status.json') {
            status = await readJsonSafe(full);
          } else {
            otherBytes += size;
          }
        }
      }
    } catch {
      result.unreadable += 1;
      return null;
    }
    const state = status?.state || 'unknown';
    return {
      id: name,
      sessionId: status?.sessionId || '',
      state,
      tool: status?.tool || '',
      createdAt: status?.createdAt || '',
      completedAt: status?.completedAt || '',
      spoolBytes,
      artifactBytes,
      otherBytes,
      totalBytes: spoolBytes + artifactBytes + otherBytes,
    };
  });

  const valid = summaries.filter(Boolean);
  for (const run of valid) {
    const bucket = (result.byState[run.state] ??= {
      count: 0,
      spoolBytes: 0,
      artifactBytes: 0,
      otherBytes: 0,
      totalBytes: 0,
    });
    bucket.count += 1;
    bucket.spoolBytes += run.spoolBytes;
    bucket.artifactBytes += run.artifactBytes;
    bucket.otherBytes += run.otherBytes;
    bucket.totalBytes += run.totalBytes;
  }

  result.largest = [...valid].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, top);
  return result;
}

async function analyzeSessions(historyRoot, top) {
  const result = {
    dirs: 0,
    unreadable: 0,
    parts: { eventsBytes: 0, bodiesBytes: 0, metaBytes: 0, projectionBytes: 0, otherBytes: 0 },
    largest: [],
  };
  if (!(await dirExists(historyRoot))) return result;

  let entries;
  try {
    entries = await readdir(historyRoot);
  } catch {
    return result;
  }
  const sessionDirs = entries.filter((name) => {
    if (name.startsWith('.') || name.includes('test')) return false;
    const full = join(historyRoot, name);
    return /^[0-9a-f]{32}$/.test(name); // hex session id
  });
  result.dirs = sessionDirs.length;

  const summaries = await mapLimit(sessionDirs, 32, async (name) => {
    const dir = join(historyRoot, name);
    const parts = { eventsBytes: 0, bodiesBytes: 0, metaBytes: 0, projectionBytes: 0, otherBytes: 0 };
    let events = 0;
    let meta = null;
    try {
      const files = await readdir(dir, { withFileTypes: true });
      for (const entry of files) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          const walk = await walkBytes(full);
          if (entry.name === 'events') {
            parts.eventsBytes += walk.bytes;
            events = walk.files;
          } else if (entry.name === 'bodies') {
            parts.bodiesBytes += walk.bytes;
          } else {
            parts.otherBytes += walk.bytes;
          }
        } else {
          const size = (await stat(full)).size;
          if (entry.name === 'meta.json') {
            parts.metaBytes += size;
            meta = await readJsonSafe(full);
          } else if (entry.name === 'audit-projection.json') {
            parts.projectionBytes += size;
          } else {
            parts.otherBytes += size;
          }
        }
      }
    } catch {
      result.unreadable += 1;
      return null;
    }
    const totalBytes = Object.values(parts).reduce((a, b) => a + b, 0);
    return { id: name, totalBytes, events, parts, title: meta?.title || '', updatedAt: meta?.updatedAt || '' };
  });

  const valid = summaries.filter(Boolean);
  for (const s of valid) {
    for (const [key, value] of Object.entries(s.parts)) {
      result.parts[key] += value;
    }
  }
  result.largest = [...valid].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, top);
  return result;
}

async function analyzeAssets(assetsRoot) {
  const result = {
    descriptors: 0,
    ready: 0,
    nonReady: 0,
    descriptorBytes: 0,
    objectBytes: 0,
    missingObjects: [],
    orphanObjects: [],
    perSessionBytes: {},
    rows: [],
  };
  if (!(await dirExists(assetsRoot))) return result;

  let entries;
  try {
    entries = await readdir(assetsRoot);
  } catch {
    return result;
  }
  const descriptors = entries.filter((name) => name.startsWith('fasset_') && name.endsWith('.json'));
  result.descriptors = descriptors.length;

  const objectsDir = join(assetsRoot, 'objects');
  let objectFiles = [];
  if (await dirExists(objectsDir)) {
    try {
      objectFiles = await readdir(objectsDir);
    } catch {
      objectFiles = [];
    }
  }
  const knownObjects = new Set();

  const rows = await mapLimit(descriptors, 32, async (name) => {
    const full = join(assetsRoot, name);
    const st = await stat(full).catch(() => null);
    const d = await readJsonSafe(full);
    if (!d) return null;
    const objectPath = d.localizedPath || join(objectsDir, d.id);
    let objectExists = false;
    let objectSize = 0;
    try {
      const o = await stat(objectPath);
      objectExists = o.isFile();
      objectSize = o.size;
      knownObjects.add(objectPath);
    } catch {
      objectExists = false;
    }
    return {
      id: d.id,
      sessionId: d.sessionId || '',
      status: d.status || 'unknown',
      sizeBytes: Number(d.sizeBytes) || 0,
      createdAt: d.createdAt || '',
      descriptorBytes: st?.size || 0,
      objectPath,
      objectExists,
      objectSize,
    };
  });

  const valid = rows.filter(Boolean);
  result.rows = valid;
  for (const a of valid) {
    result.descriptorBytes += a.descriptorBytes;
    result.objectBytes += a.objectExists ? a.objectSize : 0;
    if (a.status === 'ready') result.ready += 1;
    else result.nonReady += 1;
    if (!a.objectExists) result.missingObjects.push({ id: a.id, expectedPath: a.objectPath, sizeBytes: a.sizeBytes });
    result.perSessionBytes[a.sessionId] = (result.perSessionBytes[a.sessionId] || 0) + a.objectSize;
  }

  const expectedPrefix = join(objectsDir, 'fasset_');
  for (const name of objectFiles) {
    const full = join(objectsDir, name);
    if (!knownObjects.has(full) && full.startsWith(expectedPrefix)) {
      try {
        const st = await stat(full);
        result.orphanObjects.push({ path: full, sizeBytes: st.size });
      } catch {
        // raced away
      }
    }
  }
  return result;
}

async function analyzeSnapshots(snapshotsRoot, deepRefs) {
  const result = {
    snapshots: 0,
    jsonBytes: 0,
    assetsBytes: 0,
    orphanAssetFiles: [],
  };
  if (!(await dirExists(snapshotsRoot))) return result;

  let entries;
  try {
    entries = await readdir(snapshotsRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  const snapJsons = entries.filter((e) => e.isFile() && e.name.startsWith('snap_') && e.name.endsWith('.json'));
  result.snapshots = snapJsons.length;

  // Collect every hash referenced inside snapshot JSON payloads so we can flag
  // .assets/ files that no snapshot references (deep mode only — the cheap
  // consistency check below is always on).
  const referencedHashes = new Set();
  let referencedCount = 0;
  const snapRows = await mapLimit(snapJsons, 16, async (entry) => {
    const full = join(snapshotsRoot, entry.name);
    const st = await stat(full);
    result.jsonBytes += st.size;
    const id = entry.name.slice(5, -5);
    const assetsDir = join(snapshotsRoot, `${entry.name.slice(0, -5)}.assets`);
    const hasAssetsDir = await dirExists(assetsDir);
    if (deepRefs) {
      const d = await readJsonSafe(full);
      const payload = JSON.stringify(d ?? {});
      // .assets files are named asset_<hash>; collect hashes mentioned anywhere.
      const matches = payload.matchAll(/asset_([0-9a-f]{16,64})/g);
      for (const m of matches) {
        referencedHashes.add(m[1]);
        referencedCount += 1;
      }
    }
    return { id, jsonBytes: st.size, assetsDir, hasAssetsDir };
  });

  const validSnaps = snapRows.filter(Boolean);
  for (const s of validSnaps) {
    if (!s.hasAssetsDir) continue;
    const walk = await walkBytes(s.assetsDir);
    result.assetsBytes += walk.bytes;
    if (!deepRefs) continue;
    let files;
    try {
      files = await readdir(s.assetsDir);
    } catch {
      continue;
    }
    for (const name of files) {
      const hashMatch = name.match(/^asset_([0-9a-f]+)$/);
      if (!hashMatch) continue;
      if (!referencedHashes.has(hashMatch[1])) {
        try {
          const st = await stat(join(s.assetsDir, name));
          result.orphanAssetFiles.push({ snapshot: s.id, path: join(s.assetsDir, name), sizeBytes: st.size });
        } catch {
          // raced away
        }
      }
    }
  }
  return result;
}

async function dailyGrowth(runsRoot, assetsRows) {
  // Daily run spool bytes by run creation date; assets bucketed by descriptor
  // createdAt. Run counts come from status.json; spool size from a stat.
  const byDate = {};
  if (await dirExists(runsRoot)) {
    let entries;
    try {
      entries = await readdir(runsRoot);
    } catch {
      entries = [];
    }
    const runDirs = entries.filter((name) => name.startsWith('run_'));
    const rows = await mapLimit(runDirs, 32, async (name) => {
      const status = await readJsonSafe(join(runsRoot, name, 'status.json'));
      if (!status || !status.createdAt) return null;
      let spool = 0;
      try {
        spool = (await stat(join(runsRoot, name, 'spool.jsonl'))).size;
      } catch {
        spool = 0;
      }
      return { day: status.createdAt.slice(0, 10), spool };
    });
    for (const r of rows.filter(Boolean)) {
      const bucket = (byDate[r.day] ??= { runCount: 0, runSpoolBytes: 0, assetBytes: 0 });
      bucket.runCount += 1;
      bucket.runSpoolBytes += r.spool;
    }
  }
  for (const a of assetsRows.filter(Boolean)) {
    if (!a.createdAt) continue;
    const day = a.createdAt.slice(0, 10);
    const bucket = (byDate[day] ??= { runCount: 0, runSpoolBytes: 0, assetBytes: 0 });
    bucket.assetBytes += a.objectExists ? a.objectSize : 0;
  }
  return Object.entries(byDate)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));
}

async function deepReferenceScan(historyRoot, snapshotsRoot) {
  // Collect every fasset_ reference in chat-history events and snapshot JSON.
  // Raw readFile + regex instead of JSON.parse — 550K small event files would
  // make parsing the dominant cost for no benefit (we only need the id tokens).
  const refs = new Map(); // fasset id -> count
  const bump = (id) => refs.set(id, (refs.get(id) || 0) + 1);
  const scanPayload = (payload) => {
    const matches = payload.matchAll(/fasset_[0-9a-f]{16,40}/g);
    for (const m of matches) bump(m[0]);
  };

  if (await dirExists(historyRoot)) {
    let sessions;
    try {
      sessions = await readdir(historyRoot);
    } catch {
      sessions = [];
    }
    let done = 0;
    for (const s of sessions) {
      const eventsDir = join(historyRoot, s, 'events');
      if (!(await dirExists(eventsDir))) continue;
      let files;
      try {
        files = await readdir(eventsDir);
      } catch {
        continue;
      }
      await mapLimit(files, 48, async (name) => {
        try {
          scanPayload(await readFile(join(eventsDir, name), 'utf8'));
        } catch {
          // unreadable event — skip
        }
      });
      done += 1;
      if (done % 25 === 0 || done === sessions.length) {
        process.stderr.write(`[deep-refs] events scan ${done}/${sessions.length} sessions\n`);
      }
    }
  }

  if (await dirExists(snapshotsRoot)) {
    let files;
    try {
      files = await readdir(snapshotsRoot);
    } catch {
      files = [];
    }
    await mapLimit(files.filter((f) => f.startsWith('snap_') && f.endsWith('.json')), 16, async (name) => {
      try {
        scanPayload(await readFile(join(snapshotsRoot, name), 'utf8'));
      } catch {
        // unreadable snapshot — skip
      }
    });
  }
  return refs;
}

async function hashObjects(paths) {
  const rows = await mapLimit(paths, 16, async (path) => {
    try {
      const buffer = await readFile(path);
      return { id: basename(path), path, hash: sha256OfBuffer(buffer), sizeBytes: buffer.length };
    } catch {
      return null;
    }
  });
  return rows.filter(Boolean);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root;
  if (!root || !(await dirExists(root))) {
    console.error(`storage-inventory: root not found: ${root}`);
    process.exit(2);
  }
  const startMs = Date.now();
  const runsRoot = join(root, 'chat-runs');
  const historyRoot = join(root, 'chat-history');
  const assetsRoot = join(root, 'file-assets');
  const snapshotsRoot = join(root, SNAPSHOT_DIR_NAME);

  const [runs, sessions, assets, snapshots] = await Promise.all([
    analyzeRuns(runsRoot, options.top),
    analyzeSessions(historyRoot, options.top),
    analyzeAssets(assetsRoot),
    analyzeSnapshots(snapshotsRoot, options.deepRefs),
  ]);

  // Top-level distribution (one extra pass over the whole root; runs/history
  // totals above already came from their own walks).
  let topLevel = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const rows = await mapLimit(entries.filter((e) => e.isDirectory()), 16, async (e) => {
      const walk = await walkBytes(join(root, e.name));
      return { name: e.name, bytes: walk.bytes, files: walk.files };
    });
    topLevel = rows.filter(Boolean).sort((a, b) => b.bytes - a.bytes);
  } catch {
    topLevel = [];
  }

  const growth = await dailyGrowth(runsRoot, assets?.rows ?? []);

  const report = {
    tool: 'storage-inventory',
    phase: 'A',
    generatedAt: new Date().toISOString(),
    root,
    mode: options.deepRefs ? 'deep-refs' : 'fast',
    topLevel,
    runs,
    sessions,
    assets,
    snapshots,
    dailyGrowth: growth,
    reclaimable: {
      terminalRunSpoolBytes:
        ['completed', 'failed', 'cancelled'].reduce(
          (acc, s) => acc + (runs.byState[s]?.spoolBytes || 0),
          0,
        ),
      missingObjectBytes: assets.missingObjects.reduce((a, b) => a + b.sizeBytes, 0),
      orphanObjectBytes: assets.orphanObjects.reduce((a, b) => a + b.sizeBytes, 0),
      orphanSnapshotAssetBytes: snapshots.orphanAssetFiles.reduce((a, b) => a + b.sizeBytes, 0),
    },
  };

  if (options.deepRefs) {
    process.stderr.write('[deep-refs] reference scan start\n');
    const refs = await deepReferenceScan(historyRoot, snapshotsRoot);
    process.stderr.write('[deep-refs] reference scan done; hashing assets\n');
    const objectPaths = (assets?.rows ?? []).filter((r) => r.objectExists).map((r) => r.objectPath);
    const hashed = objectPaths.length > 0 ? await hashObjects(objectPaths) : [];
    process.stderr.write('[deep-refs] hashing done\n');
    const unreferenced = (assets?.rows ?? [])
      .filter((r) => r.objectExists && !refs.has(r.id))
      .map((r) => ({ id: r.id, sessionId: r.sessionId, sizeBytes: r.objectSize }));
    report.deepRefs = {
      referencedAssetIds: refs.size,
      totalReferenceCount: [...refs.values()].reduce((a, b) => a + b, 0),
      unreferencedAssets: unreferenced,
      unreferencedBytes: unreferenced.reduce((a, b) => a + b.sizeBytes, 0),
      hashes: hashed.map((h) => ({ id: h.id, hash: h.hash.slice(0, 16), sizeBytes: h.sizeBytes })),
    };
  }

  // ---- console summary (Chinese, human-readable) ----
  const totalBytes = topLevel.reduce((a, b) => a + b.bytes, 0);
  const mode = options.deepRefs ? 'deep-refs' : 'fast';
  console.log(`Ragent 存储容量清单 (${mode} 模式，耗时 ${Date.now() - startMs}ms)`);
  console.log(`根目录: ${root}`);
  console.log('--- 顶层分布 ---');
  for (const t of topLevel.slice(0, 12)) {
    console.log(`  ${t.name.padEnd(28)} ${formatBytes(t.bytes).padStart(10)}  ${t.files} 文件`);
  }
  console.log(`  合计 ${formatBytes(totalBytes)}`);
  console.log('--- Run（按状态）---');
  const order = ['running', 'accepted', 'completed', 'failed', 'cancelled', 'unknown'];
  for (const s of order) {
    const b = runs.byState[s];
    if (!b) continue;
    console.log(`  ${s.padEnd(10)} ${String(b.count).padStart(5)} 个  spool ${formatBytes(b.spoolBytes).padStart(9)}  artifacts ${formatBytes(b.artifactBytes).padStart(9)}  合计 ${formatBytes(b.totalBytes)}`);
  }
  const terminal = ['completed', 'failed', 'cancelled'].reduce(
    (acc, s) => acc + (runs.byState[s]?.count || 0),
    0,
  );
  const terminalSpool = report.reclaimable.terminalRunSpoolBytes;
  console.log(`  Terminal run（已完成/失败/取消）: ${terminal} 个，spool 未压缩 ${formatBytes(terminalSpool)}（潜在冷归档量）`);
  console.log('--- Session（history）---');
  console.log(
    `  ${sessions.dirs} 个，events ${formatBytes(sessions.parts.eventsBytes)} + bodies ${formatBytes(sessions.parts.bodiesBytes)} + meta ${formatBytes(sessions.parts.metaBytes)} + projection ${formatBytes(sessions.parts.projectionBytes)}`,
  );
  console.log('--- Assets ---');
  console.log(
    `  ${assets.descriptors} 个描述（ready ${assets.ready}/${assets.nonReady}），objects ${formatBytes(assets.objectBytes)}，缺失对象 ${assets.missingObjects.length} 个，孤儿对象 ${assets.orphanObjects.length} 个`,
  );
  console.log('--- Snapshots ---');
  console.log(
    `  ${snapshots.snapshots} 个快照，JSON ${formatBytes(snapshots.jsonBytes)}，assets ${formatBytes(snapshots.assetsBytes)}，孤儿快照资产 ${snapshots.orphanAssetFiles.length} 个`,
  );
  console.log('--- 日增长（近 14 天）---');
  for (const d of growth.slice(-14)) {
    console.log(`  ${d.date}  run ${String(d.runCount).padStart(4)} 个  spool ${formatBytes(d.runSpoolBytes).padStart(9)}  assets ${formatBytes(d.assetBytes).padStart(9)}`);
  }
  console.log('--- 潜在可回收（dry-run 估算，未删除任何数据）---');
  for (const [k, v] of Object.entries(report.reclaimable)) {
    console.log(`  ${k.padEnd(26)} ${formatBytes(v)}`);
  }
  if (options.deepRefs) {
    console.log('--- 引用分析（deep）---');
    console.log(`  被引用 asset ${report.deepRefs.referencedAssetIds} 个，总引用 ${report.deepRefs.totalReferenceCount} 次，零引用 asset ${report.deepRefs.unreferencedAssets.length} 个（${formatBytes(report.deepRefs.unreferencedBytes)}）`);
  }
  console.log('说明：本工具只读，不执行任何删除/压缩/迁移。');

  if (options.jsonOut) {
    const { writeFile } = await import('fs/promises');
    await writeFile(options.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    console.log(`完整报告已写入: ${options.jsonOut}`);
  }
  if (options.mdOut) {
    const lines = [];
    lines.push('# Ragent 存储容量清单（阶段 A dry-run）');
    lines.push('');
    lines.push(`- 生成时间：${report.generatedAt}`);
    lines.push(`- 模式：${report.mode}`);
    lines.push(`- 根目录：${root}`);
    lines.push('');
    lines.push('## 顶层分布');
    lines.push('');
    lines.push('| 目录 | 占用 | 文件数 |');
    lines.push('| --- | ---: | ---: |');
    for (const t of topLevel) lines.push(`| ${t.name} | ${formatBytes(t.bytes)} | ${t.files} |`);
    lines.push('');
    lines.push('## Run（按状态）');
    lines.push('');
    lines.push('| 状态 | 数量 | spool | artifacts | 合计 |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const s of order) {
      const b = runs.byState[s];
      if (b) lines.push(`| ${s} | ${b.count} | ${formatBytes(b.spoolBytes)} | ${formatBytes(b.artifactBytes)} | ${formatBytes(b.totalBytes)} |`);
    }
    lines.push('');
    lines.push(`Terminal run（completed/failed/cancelled）：${terminal} 个，spool 未压缩 ${formatBytes(terminalSpool)}（阶段 B 冷归档的潜在回收量）。`);
    lines.push('');
    lines.push('## Session（history）');
    lines.push('');
    lines.push(`共 ${sessions.dirs} 个：events ${formatBytes(sessions.parts.eventsBytes)}，bodies ${formatBytes(sessions.parts.bodiesBytes)}，meta ${formatBytes(sessions.parts.metaBytes)}，projection ${formatBytes(sessions.parts.projectionBytes)}。`);
    lines.push('');
    lines.push('## Assets 与 Snapshots');
    lines.push('');
    lines.push(`- Assets：${assets.descriptors} 个描述，objects ${formatBytes(assets.objectBytes)}；缺失对象 ${assets.missingObjects.length}，孤儿对象 ${assets.orphanObjects.length}。`);
    lines.push(`- Snapshots：${snapshots.snapshots} 个，JSON ${formatBytes(snapshots.jsonBytes)}，assets ${formatBytes(snapshots.assetsBytes)}。`);
    lines.push('');
    lines.push('## 潜在可回收（dry-run 估算，未删除任何数据）');
    lines.push('');
    lines.push('| 项目 | 估算 |');
    lines.push('| --- | ---: |');
    for (const [k, v] of Object.entries(report.reclaimable)) lines.push(`| ${k} | ${formatBytes(v)} |`);
    if (options.deepRefs) {
      lines.push('');
      lines.push(`零引用 asset：${report.deepRefs.unreferencedAssets.length} 个，${formatBytes(report.deepRefs.unreferencedBytes)}。`);
    }
    const { writeFile } = await import('fs/promises');
    await writeFile(options.mdOut, lines.join('\n'), 'utf8');
    console.log(`摘要报告已写入: ${options.mdOut}`);
  }
}

main().catch((error) => {
  console.error('storage-inventory failed:', error);
  process.exit(1);
});
