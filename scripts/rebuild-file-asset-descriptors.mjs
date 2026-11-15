#!/usr/bin/env node
// Rebuild missing file-asset descriptor files (<id>.json) for /var/lib/ragent/config/file-assets.
//
// The 928 descriptors vanished between 05:04 and 05:14 UTC on 2026-08-05 while the
// objects/ payload files mostly survived. This tool reconstructs descriptors from:
//   1. storage-inventory.mjs output (inventory.json -> assets.rows): id, sessionId,
//      status, sizeBytes, createdAt, objectPath (object filename = storage.localFilename)
//   2. chat-history events: attachment metadata (originalName / mimeType) matched by
//      assetId (attachments[].assetId, localResultFileRewrites[].assetId, artifactFileId)
//
// It never touches object payloads. Run without flags for a dry-run report; pass
// --apply to write descriptors. Verify with the live download API afterwards.
//
// Usage:
//   node scripts/rebuild-file-asset-descriptors.mjs [--root DIR] [--inventory PATH] [--apply]

import { readdir, readFile, stat, writeFile, mkdir } from 'fs/promises';
import { join, basename } from 'path';

const DEFAULT_ROOT = '/var/lib/ragent/config';
const DEFAULT_INVENTORY = '/var/lib/ragent/workspace/storage-inventory/inventory.json';
// Legacy instance data dir: holds 90 original descriptors (same asset ids) plus
// object payloads that were never copied to the new instance objects dir.
const LEGACY_DIR = '/srv/ragent-promoted-data/config/file-assets';

const MIME_BY_EXT = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.sql': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.env': 'text/plain',
  '.patch': 'text/plain',
  '.diff': 'text/plain',
  '.deb': 'application/vnd.debian.binary-package',
};

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, inventory: DEFAULT_INVENTORY, apply: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[i + 1];
    else if (argv[i] === '--inventory') out.inventory = argv[i + 1];
    else if (argv[i] === '--apply') out.apply = true;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

async function walkEvents(root) {
  const historyDir = join(root, 'chat-history');
  const events = [];
  const sessions = await readdir(historyDir);
  for (const s of sessions) {
    const edir = join(historyDir, s, 'events');
    let files;
    try {
      files = await readdir(edir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        events.push(JSON.parse(await readFile(join(edir, f), 'utf8')));
      } catch {
        // skip unparseable
      }
    }
  }
  return events;
}

function collectAttachmentMeta(events) {
  // assetId -> { originalName, mimeType } (first-seen wins, prefer later metadata)
  const meta = new Map();
  for (const ev of events) {
    const payload = ev?.payload ?? ev;
    const record = (id, name, mime) => {
      if (!id || !String(id).startsWith('fasset_')) return;
      const current = meta.get(id) ?? {};
      if (name) current.originalName = name;
      if (mime) current.mimeType = mime;
      meta.set(id, current);
    };
    // attachments arrays (message events)
    const attachArrays = [];
    if (Array.isArray(payload?.attachments)) attachArrays.push(payload.attachments);
    if (Array.isArray(payload?.message?.attachments)) attachArrays.push(payload.message.attachments);
    if (Array.isArray(ev?.attachments)) attachArrays.push(ev.attachments);
    for (const arr of attachArrays) {
      for (const a of arr) {
        record(a?.assetId ?? a?.id, a?.originalName, a?.mimeType);
        // artifactFileId points at an artifact attachment rendered from an asset
        if (a?.artifactFileId) record(a.artifactFileId, a.originalName, a.mimeType);
      }
    }
    // localResultFileRewrites
    if (Array.isArray(payload?.localResultFileRewrites)) {
      for (const r of payload.localResultFileRewrites) {
        record(r.assetId, r.candidate ? basename(r.candidate) : undefined, undefined);
      }
    }
    // artifact render entries
    if (Array.isArray(payload?.artifactRenders)) {
      for (const r of payload.artifactRenders) {
        record(r.assetId, r.originalName, r.mimeType);
      }
    }
    // tool results with asset refs
    if (Array.isArray(payload?.toolResults)) {
      for (const r of payload.toolResults) {
        record(r.assetId, r.originalName, r.mimeType);
      }
    }
    // flattened strings: any attachment-like object carrying assetId + originalName
    const walk = (o, depth = 0) => {
      if (depth > 6 || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) {
        for (const v of o) walk(v, depth + 1);
        return;
      }
      const id = o.assetId;
      if (typeof id === 'string' && id.startsWith('fasset_') && (o.originalName || o.mimeType)) {
        record(id, o.originalName, o.mimeType);
      }
      for (const v of Object.values(o)) {
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(payload, 0);
  }
  return meta;
}

function mimeFromFilename(filename) {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return null;
  return MIME_BY_EXT[filename.slice(idx).toLowerCase()] ?? null;
}

async function main() {
  const options = parseArgs(process.argv);
  const inventory = JSON.parse(await readFile(options.inventory, 'utf8'));
  const rows = inventory.assets?.rows;
  if (!Array.isArray(rows)) {
    console.error(`inventory.json at ${options.inventory} has no assets.rows`);
    process.exit(1);
  }

  console.log(`[rebuild] inventory: ${rows.length} asset rows (phase ${inventory.phase} @ ${inventory.generatedAt})`);

  const events = await walkEvents(options.root);
  console.log(`[rebuild] scanned ${events.length} chat-history events`);

  const meta = collectAttachmentMeta(events);
  console.log(`[rebuild] attachment metadata found for ${meta.size} distinct fasset ids`);

  const objectsDir = join(options.root, 'file-assets', 'objects');
  let objectFiles = new Set();
  try {
    objectFiles = new Set(await readdir(objectsDir));
  } catch {
    // dir missing — all objects gone
  }

  // Original legacy descriptors (same asset ids, full field set)
  const legacy = new Map();
  let legacyFiles = [];
  try {
    legacyFiles = await readdir(LEGACY_DIR);
  } catch {
    // no legacy dir
  }
  for (const f of legacyFiles) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(await readFile(join(LEGACY_DIR, f), 'utf8'));
      if (typeof d?.id === 'string' && d.id.startsWith('fasset_')) legacy.set(d.id, d);
    } catch {
      // skip
    }
  }

  const written = [];
  const problems = [];
  let withOriginalName = 0;
  let withMime = 0;
  let objectExists = 0;
  let fromLegacy = 0;

  for (const row of rows) {
    const id = row.id;
    const localFilename = basename(row.objectPath ?? '');
    const m = meta.get(id) ?? {};

    let descriptor;
    const original = legacy.get(id);
    if (original) {
      // Use the original descriptor verbatim; point localizedPath at the new
      // objects dir so any path-based checks stay consistent. storage.localFilename
      // is authoritative for resolveLocalObjectPath.
      descriptor = { ...original };
      if (descriptor.storage?.localFilename) {
        descriptor.localizedPath = join(objectsDir, descriptor.storage.localFilename);
      } else {
        descriptor.storage = descriptor.storage ? { ...descriptor.storage } : {};
        descriptor.storage.provider = 'local';
        descriptor.storage.localFilename = localFilename;
      }
      fromLegacy++;
    } else {
      const originalName = m.originalName
        ?? (localFilename.startsWith('fasset_') ? localFilename.replace(/^fasset_[0-9a-f]{16,40}/, 'attachment') : localFilename)
        ?? 'attachment';
      const mimeType = m.mimeType ?? mimeFromFilename(localFilename) ?? 'application/octet-stream';
      if (m.originalName) withOriginalName++;
      if (m.mimeType) withMime++;
      descriptor = {
        id,
        sessionId: row.sessionId,
        status: 'ready',
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        createdBy: 'owner',
        originalName,
        mimeType,
        sizeBytes: row.sizeBytes,
        storage: {
          provider: 'local',
          localFilename,
        },
        localizedPath: join(objectsDir, localFilename),
      };
    }

    if (objectFiles.has(localFilename)) objectExists++;

    if (options.apply) {
      await mkdir(join(options.root, 'file-assets'), { recursive: true });
      const target = join(options.root, 'file-assets', `${id}.json`);
      await writeFile(target, JSON.stringify(descriptor, null, 2) + '\n', 'utf8');
      written.push(id);
    } else {
      problems.push({ id, originalName: descriptor.originalName, mimeType: descriptor.mimeType, localFilename, exists: objectFiles.has(localFilename) });
    }
  }

  const existsNow = rows.filter((r) => objectFiles.has(basename(r.objectPath ?? ''))).length;
  console.log(`[rebuild] objects present on disk now: ${existsNow}/${rows.length}`);
  console.log(`[rebuild] descriptors sourced from legacy originals: ${fromLegacy}`);

  if (!options.apply) {
    console.log(`[rebuild] DRY-RUN: would write ${rows.length} descriptors`);
    console.log(`[rebuild]   originalName from chat-history: ${withOriginalName}/${rows.length}`);
    console.log(`[rebuild]   mimeType from chat-history: ${withMime}/${rows.length}`);
    const missing = rows.filter((r) => !objectFiles.has(basename(r.objectPath ?? '')));
    console.log(`[rebuild]   objects missing on disk: ${missing.length}`);
    for (const r of missing) {
      console.log(`[rebuild]   MISSING OBJECT: ${r.id} -> ${basename(r.objectPath ?? '')} (size ${r.sizeBytes})`);
    }
    return;
  }

  console.log(`[rebuild] APPLY: wrote ${written.length} descriptors to ${join(options.root, 'file-assets')}`);
  if (problems.length) console.log(`[rebuild] NOTE: ${problems.length} rows lacked chat-history metadata (extension-derived mime)`);
}

main().catch((err) => {
  console.error('[rebuild] FAILED:', err.message);
  process.exit(1);
});
