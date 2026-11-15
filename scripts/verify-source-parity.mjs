#!/usr/bin/env node
// DS-01: source -> installed/runtime artifact parity gate (P0).
//
// Compares the committed source tree against the installed deployment root
// (/opt/ragent/app by default) and the recorded package manifest, and emits a
// machine-readable JSON report with five layer fields:
//
//   source-tested   — the source tree's git state for the compared paths
//   hot-mounted     — whether the installed root IS the source root (dev mode)
//   packaged        — whether current source hashes match the recorded manifest
//   installed       — whether installed files match source hashes
//   live-verified   — whether the running service serves the expected bytes
//
// Exit codes: 0 = parity pass, 1 = parity fail (any layer fail), 2 = usage error.
//
// This script is READ-ONLY with respect to the machine: it hashes files, runs
// `git status`, and (optionally) issues one HTTP GET. It never writes to the
// install root, never restarts services, and never auto-repairs a mismatch —
// failures produce actionable recommendations only.
//
// Usage:
//   node scripts/verify-source-parity.mjs [--source DIR] [--install DIR]
//       [--data-root DIR] [--manifest PATH] [--live-url URL|none]
//       [--allow-dirty-source] [--record-manifest]
//
//   --allow-dirty-source  permits uncommitted changes to compared paths in the
//                         source tree; hash mismatches are NEVER silently
//                         ignored (installed/packaged/live checks stay active).
//   --record-manifest     writes the current source snapshot (hashes, git HEAD,
//                         package version) to the manifest path.
//   --live-url none       disables the live HTTP probe.

import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const DEFAULT_INSTALL_ROOT = '/opt/ragent/app';
const DEFAULT_DATA_ROOT = '/opt/ragent/runtime';
const DEFAULT_LIVE_URL = 'http://127.0.0.1:7690';
const LIVE_TIMEOUT_MS = 1500;
const MANIFEST_FORMAT = 1;

// Compared paths, grouped by artifact class. Every path is relative to the
// source root and mirrored at the same location under the install root.
const COMPARED = {
  package: ['package.json'],
  backend: ['chat-server.mjs', 'chat/session-manager.mjs', 'lib/config.mjs'],
  static: [
    'static/chat/chat.css',
    'static/chat/compose.js',
    'static/chat/ui.js',
    'static/marked.min.js',
    'static/sw.js',
    'static/manifest.json',
  ],
  templates: ['templates/chat.html', 'templates/login.html'],
};

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function hashFile(p) {
  return sha256(await fs.readFile(p));
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = { source: repoRoot, install: DEFAULT_INSTALL_ROOT, dataRoot: DEFAULT_DATA_ROOT, liveUrl: DEFAULT_LIVE_URL, allowDirty: false, recordManifest: false };
  let manifest;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`missing value for ${a}`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--source': args.source = path.resolve(next()); break;
      case '--install': args.install = path.resolve(next()); break;
      case '--data-root': args.dataRoot = path.resolve(next()); break;
      case '--manifest': manifest = path.resolve(next()); break;
      case '--live-url': args.liveUrl = next(); break;
      case '--allow-dirty-source': args.allowDirty = true; break;
      case '--record-manifest': args.recordManifest = true; break;
      case '--help':
      case '-h':
        process.stdout.write(`usage: node scripts/verify-source-parity.mjs [options]\n\n${USAGE}\n`);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${a}`);
    }
  }
  args.manifest = manifest ?? path.join(args.source, 'scripts', 'parity-manifest.json');
  return args;
}

class UsageError extends Error {}

const USAGE = [
  '  --source DIR         source tree root (default: repo root)',
  '  --install DIR        installed deployment root (default: /opt/ragent/app)',
  '  --data-root DIR      key data root for informational markers (default: /opt/ragent/runtime)',
  '  --manifest PATH      recorded package manifest (default: <source>/scripts/parity-manifest.json)',
  '  --live-url URL|none  live probe base URL (default: http://127.0.0.1:7690)',
  '  --allow-dirty-source permit uncommitted source changes; hash checks stay enforced',
  '  --record-manifest    record the current source snapshot as the package manifest',
].join('\n');

function allComparedPaths() {
  return Object.values(COMPARED).flat();
}

async function gitHeadAndDirty(sourceRoot) {
  try {
    const [headRes, statusRes] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot }),
      execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: sourceRoot }),
    ]);
    const head = headRes.stdout.trim();
    const dirty = statusRes.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
    return { ok: true, head, dirty };
  } catch {
    return { ok: false, head: null, dirty: [] };
  }
}

async function hashComparedSet(root, paths) {
  const out = {};
  const missing = [];
  for (const rel of paths) {
    const p = path.join(root, rel);
    if (await exists(p)) out[rel] = await hashFile(p);
    else missing.push(rel);
  }
  return { hashes: out, missing };
}

async function readManifest(p) {
  try {
    const raw = JSON.parse(await fs.readFile(p, 'utf8'));
    if (raw.format !== MANIFEST_FORMAT) return { ok: false, reason: `unsupported manifest format ${raw.format}` };
    return { ok: true, manifest: raw };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'no manifest recorded yet' };
    return { ok: false, reason: `unreadable manifest: ${err.message}` };
  }
}

function fetchLiveHash(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, status: `http ${res.statusCode}` });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: true, hash: sha256(Buffer.concat(chunks)) }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, status: err.code ?? err.message }));
  });
}

function layer(status, detail) {
  return { status, detail };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const compared = allComparedPaths();
  const report = {
    format: MANIFEST_FORMAT,
    generatedAt: new Date().toISOString(),
    verdict: 'pass',
    exitCode: 0,
    inputs: { source: args.source, install: args.install, dataRoot: args.dataRoot, liveUrl: args.liveUrl },
    git: { head: null, dirty: [], dirtyCompared: [] },
    layers: {},
    manifest: null,
    mismatches: [],
    recommendations: [],
    dataRoot: null,
  };

  const sourceOk = await exists(args.source);
  const installOk = await exists(args.install);
  if (!sourceOk) {
    report.verdict = 'fail';
    report.exitCode = 1;
    report.layers['source-tested'] = layer('fail', `source root missing: ${args.source}`);
    process.stderr.write(`error: source root missing: ${args.source}\n`);
    process.exit(1);
  }

  // ---- source-tested: git state of the compared paths ---------------------
  const gitInfo = await gitHeadAndDirty(args.source);
  report.git.head = gitInfo.head;
  report.git.dirty = gitInfo.dirty;
  report.git.dirtyCompared = gitInfo.dirty.filter((p) => compared.includes(p));
  if (!gitInfo.ok) {
    report.layers['source-tested'] = layer('unknown', 'source root is not a git repository; git HEAD cannot be certified');
  } else if (report.git.dirtyCompared.length > 0 && !args.allowDirty) {
    report.layers['source-tested'] = layer(
      'fail',
      `uncommitted changes to compared paths: ${report.git.dirtyCompared.join(', ')}; commit them or pass --allow-dirty-source for advisory runs`
    );
    report.recommendations.push(
      `Source tree has uncommitted changes to shipped artifacts (${report.git.dirtyCompared.join(', ')}). ` +
        'Commit or stash them before packaging, or pass --allow-dirty-source to run the gate in advisory mode. ' +
        'Hash checks are still enforced in advisory mode.'
    );
  } else {
    const note = args.allowDirty && report.git.dirtyCompared.length > 0
      ? `dirty source allowed via --allow-dirty-source (${report.git.dirtyCompared.length} compared path(s) uncommitted); hash checks still enforced`
      : `git HEAD ${gitInfo.head}; compared paths clean${report.git.dirty.length > 0 ? ` (${report.git.dirty.length} unrelated dirty path(s) ignored)` : ''}`;
    report.layers['source-tested'] = layer('pass', note);
  }

  // ---- hot-mounted: install root is the source root (dev mode) ------------
  if (!installOk) {
    report.layers['hot-mounted'] = layer('unknown', `install root missing: ${args.install}`);
  } else {
    let same = false;
    try {
      same = realpathSync(args.install) === realpathSync(args.source);
    } catch {
      same = false;
    }
    report.layers['hot-mounted'] = same
      ? layer('yes', 'install root resolves to the source root: the service serves source directly (dev hot-mount)')
      : layer('no', `install root ${args.install} is a separate copy from source ${args.source}`);
  }

  // ---- source hashes (needed for packaged/installed/live) -----------------
  const src = await hashComparedSet(args.source, compared);

  // ---- packaged: current source vs recorded manifest ----------------------
  const manifestRes = await readManifest(args.manifest);
  if (!manifestRes.ok) {
    report.layers.packaged = layer('unknown', `${manifestRes.reason} at ${args.manifest}`);
  } else {
    const rec = manifestRes.manifest.groups ?? {};
    const recorded = new Map();
    for (const g of Object.values(rec)) for (const [rel, h] of Object.entries(g.files ?? {})) recorded.set(rel, h);
    const drift = compared
      .filter((rel) => src.hashes[rel] !== undefined && recorded.get(rel) !== undefined && src.hashes[rel] !== recorded.get(rel))
      .map((rel) => ({ path: rel, expected: recorded.get(rel), actual: src.hashes[rel] }));
    const notCovered = compared.filter((rel) => !recorded.has(rel));
    if (drift.length > 0) {
      report.layers.packaged = layer('fail', `source hashes drifted from recorded manifest: ${drift.map((d) => d.path).join(', ')}`);
      report.mismatches.push(...drift.map((d) => ({ ...d, layer: 'packaged' })));
      report.recommendations.push(
        `Source ${drift.map((d) => d.path).join(', ')} changed since the package manifest was recorded at ${manifestRes.manifest.gitHead ?? '?'}. ` +
          'Review the change, re-run with --record-manifest to certify the new snapshot, then rebuild the package.'
      );
    } else if (notCovered.length > 0) {
      report.layers.packaged = layer('unknown', `manifest missing ${notCovered.length} compared path(s): ${notCovered.join(', ')}; re-record with --record-manifest`);
    } else {
      const headNote = manifestRes.manifest.gitHead && manifestRes.manifest.gitHead !== gitInfo.head
        ? `; manifest recorded at ${manifestRes.manifest.gitHead}, current HEAD ${gitInfo.head} (files identical)`
        : '';
      report.layers.packaged = layer('pass', `all ${compared.length} compared paths match the recorded manifest${headNote}`);
    }
  }

  // ---- installed: install root files vs source hashes ---------------------
  if (!installOk) {
    report.layers.installed = layer('fail', `install root missing: ${args.install}`);
    report.recommendations.push(
      `Install root ${args.install} does not exist. The service is not installed from a known package; ` +
        'install the verified deb (scripts/build-deb.sh + verified install) before trusting this deployment.'
    );
  } else {
    const inst = await hashComparedSet(args.install, compared);
    const mism = compared
      .filter((rel) => src.hashes[rel] !== undefined && inst.hashes[rel] !== undefined && src.hashes[rel] !== inst.hashes[rel])
      .map((rel) => ({ path: rel, expected: src.hashes[rel], actual: inst.hashes[rel] }));
    const missingInInstall = inst.missing;
    if (mism.length === 0 && missingInInstall.length === 0) {
      report.layers.installed = layer('pass', `all ${compared.length} compared paths match source hashes under ${args.install}`);
    } else {
      report.layers.installed = layer(
        'fail',
        `installed artifacts differ from source: ${[...mism.map((m) => m.path), ...missingInInstall.map((p) => `${p} (missing)`)].join(', ')}`
      );
      report.mismatches.push(
        ...mism.map((m) => ({ ...m, layer: 'installed' })),
        ...missingInInstall.map((p) => ({ path: p, expected: src.hashes[p] ?? 'present', actual: null, layer: 'installed' }))
      );
      for (const m of mism) {
        report.recommendations.push(
          `installed ${path.join(args.install, m.path)} sha256=${m.actual} does not match source sha256=${m.expected}. ` +
            'Likely causes: the installed release predates current source, or the file was patched in place. ' +
            'Remedy: rebuild from source with scripts/build-deb.sh and install the verified deb through the approved ' +
            'package flow, then restart the unit. Do NOT hand-copy files into the install root.'
        );
      }
      for (const p of missingInInstall) {
        report.recommendations.push(
          `installed ${path.join(args.install, p)} is missing. The installed release is incomplete or older than source. ` +
            'Reinstall the verified deb built from current source.'
        );
      }
    }
  }

  // ---- data root: informational markers (never gates the verdict) ---------
  if (args.dataRoot && await exists(args.dataRoot)) {
    try {
      const entries = (await fs.readdir(args.dataRoot)).sort();
      const topHash = sha256(entries.join('\n'));
      report.dataRoot = { path: args.dataRoot, entries: entries.length, topLevelHash: topHash };
    } catch (err) {
      report.dataRoot = { path: args.dataRoot, entries: -1, error: err.message };
    }
  } else {
    report.dataRoot = { path: args.dataRoot ?? null, entries: -1, error: 'not present' };
  }

  // ---- live-verified: read-only probe of the running service --------------
  if (args.liveUrl === 'none') {
    report.layers['live-verified'] = layer('unknown', 'live probe disabled via --live-url none');
  } else {
    const srcCss = src.hashes['static/chat/chat.css'];
    // The app serves static assets at root-relative paths (chat/router.mjs
    // resolveStaticAsset: pathname.slice(1) under static/), pre-auth.
    const probe = await fetchLiveHash(`${args.liveUrl}/chat/chat.css`, LIVE_TIMEOUT_MS);
    if (!probe.ok) {
      report.layers['live-verified'] = layer('unknown', `live probe of ${args.liveUrl} failed: ${probe.status}`);
    } else if (srcCss !== undefined && probe.hash !== srcCss) {
      report.layers['live-verified'] = layer(
        'fail',
        `live service serves static/chat/chat.css sha256=${probe.hash} != source ${srcCss}`
      );
      report.mismatches.push({ path: 'static/chat/chat.css', expected: srcCss, actual: probe.hash, layer: 'live-verified' });
      report.recommendations.push(
        `The running service at ${args.liveUrl} serves chat.css bytes that differ from source. ` +
          'The service is running an older (or locally patched) tree. Reinstall the verified deb and restart the unit ' +
          'so the live surface matches the committed source. Do not hot-patch the running service.'
      );
    } else {
      report.layers['live-verified'] = layer('pass', `live service at ${args.liveUrl} serves chat.css matching source`);
    }
  }

  // ---- verdict -------------------------------------------------------------
  const failedLayers = Object.entries(report.layers).filter(([, l]) => l.status === 'fail');
  if (failedLayers.length > 0) {
    report.verdict = 'fail';
    report.exitCode = 1;
  }

  // ---- record manifest -----------------------------------------------------
  if (args.recordManifest) {
    const groups = {};
    for (const [g, paths] of Object.entries(COMPARED)) {
      groups[g] = { files: {} };
      for (const rel of paths) if (src.hashes[rel] !== undefined) groups[g].files[rel] = src.hashes[rel];
    }
    const manifest = {
      format: MANIFEST_FORMAT,
      recordedAt: report.generatedAt,
      gitHead: gitInfo.head,
      packageVersion: src.hashes['package.json'] !== undefined ? JSON.parse(await fs.readFile(path.join(args.source, 'package.json'), 'utf8')).version : null,
      groups,
    };
    await fs.mkdir(path.dirname(args.manifest), { recursive: true });
    await fs.writeFile(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stderr.write(`recorded package manifest (${compared.length} paths, HEAD ${gitInfo.head}) -> ${args.manifest}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.exitCode);
}

main().catch((err) => {
  process.stderr.write(`error: ${err.stack ?? err.message}\n`);
  process.exit(2);
});
