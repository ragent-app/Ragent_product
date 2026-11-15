import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';

const DEFAULT_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DIFF_CELLS = 4_000_000;
const DEFAULT_MAX_DIFF_PREVIEW_LINES = 80;
const DEFAULT_MAX_BASELINE_FILES = 4000;
const DEFAULT_MAX_BASELINE_TOTAL_BYTES = 32 * 1024 * 1024;
const BASELINE_SKIP_DIRS = new Set([
  '.cache',
  '.codex',
  '.config',
  '.git',
  '.hg',
  '.local',
  '.npm',
  '.next',
  '.ragent',
  '.svn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);
const MISSING_BASELINE_SNAPSHOT = Object.freeze({ exists: false, text: '' });

function toFilePath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveSnapshotPath(filePath, cwd = '') {
  const normalizedPath = toFilePath(filePath);
  if (!normalizedPath) return '';
  if (isAbsolute(normalizedPath)) return normalizedPath;
  return resolve(cwd || process.cwd(), normalizedPath);
}

function pathIsInside(rootPath, filePath) {
  if (!rootPath || !filePath) return false;
  const rel = relative(rootPath, filePath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function pathHasSkippedSegment(rootPath, filePath) {
  const rel = relative(rootPath, filePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  return rel.split(/[\\/]+/).some((segment) => BASELINE_SKIP_DIRS.has(segment));
}

function normalizeBaselineRoots(roots) {
  const values = Array.isArray(roots) ? roots : [roots];
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const rootPath = resolveSnapshotPath(value);
    if (!rootPath || seen.has(rootPath)) continue;
    try {
      const stat = statSync(rootPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(rootPath);
    normalized.push({
      rootPath,
      complete: false,
      scanned: false,
    });
  }
  return normalized;
}

function splitDiffLines(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return [];
  const trimmed = source.endsWith('\n') ? source.slice(0, -1) : source;
  return trimmed ? trimmed.split('\n') : [];
}

function hasPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function changeAlreadyHasStats(change) {
  return hasPositiveNumber(change?.added)
    || hasPositiveNumber(change?.additions)
    || hasPositiveNumber(change?.linesAdded)
    || hasPositiveNumber(change?.addedLines)
    || hasPositiveNumber(change?.removed)
    || hasPositiveNumber(change?.deletions)
    || hasPositiveNumber(change?.linesRemoved)
    || hasPositiveNumber(change?.removedLines);
}

export function readFileChangeSnapshot(filePath, options = {}) {
  const resolvedPath = resolveSnapshotPath(filePath, options.cwd);
  if (!resolvedPath) return null;
  try {
    if (!existsSync(resolvedPath)) {
      return { exists: false, text: '' };
    }
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) return null;
    const maxBytes = Number.isFinite(options.maxBytes)
      ? options.maxBytes
      : DEFAULT_MAX_SNAPSHOT_BYTES;
    if (stat.size > maxBytes) return null;
    const buffer = readFileSync(resolvedPath);
    if (buffer.includes(0)) return null;
    return {
      exists: true,
      text: buffer.toString('utf8'),
    };
  } catch {
    return null;
  }
}

function computeLcsLength(oldLines, newLines) {
  let previous = new Array(newLines.length + 1).fill(0);
  let current = new Array(newLines.length + 1).fill(0);
  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      if (oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
        current[newIndex] = previous[newIndex - 1] + 1;
      } else {
        current[newIndex] = Math.max(previous[newIndex], current[newIndex - 1]);
      }
    }
    const nextPrevious = previous;
    previous = current;
    current = nextPrevious;
    current.fill(0);
  }
  return previous[newLines.length] || 0;
}

export function computeTextLineChangeStats(beforeSnapshot, afterSnapshot, options = {}) {
  if (!beforeSnapshot || !afterSnapshot) return null;
  const oldLines = beforeSnapshot.exists ? splitDiffLines(beforeSnapshot.text) : [];
  const newLines = afterSnapshot.exists ? splitDiffLines(afterSnapshot.text) : [];
  const maxCells = Number.isFinite(options.maxCells)
    ? options.maxCells
    : DEFAULT_MAX_DIFF_CELLS;
  if (oldLines.length * newLines.length > maxCells) return null;
  const lcsLength = computeLcsLength(oldLines, newLines);
  const added = Math.max(0, newLines.length - lcsLength);
  const removed = Math.max(0, oldLines.length - lcsLength);
  if (added === 0 && removed === 0) return null;
  return { added, removed };
}

function computeLineDiff(oldLines, newLines) {
  const dp = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(newLines.length + 1),
  );
  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      dp[oldIndex][newIndex] = oldLines[oldIndex - 1] === newLines[newIndex - 1]
        ? dp[oldIndex - 1][newIndex - 1] + 1
        : Math.max(dp[oldIndex - 1][newIndex], dp[oldIndex][newIndex - 1]);
    }
  }
  const diff = [];
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;
  while (oldIndex > 0 || newIndex > 0) {
    if (
      oldIndex > 0
      && newIndex > 0
      && oldLines[oldIndex - 1] === newLines[newIndex - 1]
    ) {
      diff.unshift({
        type: 'equal',
        text: oldLines[oldIndex - 1],
        oldLine: oldIndex,
        newLine: newIndex,
      });
      oldIndex -= 1;
      newIndex -= 1;
    } else if (newIndex > 0 && (oldIndex === 0 || dp[oldIndex][newIndex - 1] >= dp[oldIndex - 1][newIndex])) {
      diff.unshift({
        type: 'add',
        text: newLines[newIndex - 1],
        newLine: newIndex,
      });
      newIndex -= 1;
    } else {
      diff.unshift({
        type: 'remove',
        text: oldLines[oldIndex - 1],
        oldLine: oldIndex,
      });
      oldIndex -= 1;
    }
  }
  return diff;
}

export function computeTextLineChangePreview(beforeSnapshot, afterSnapshot, options = {}) {
  if (!beforeSnapshot || !afterSnapshot) return null;
  const oldLines = beforeSnapshot.exists ? splitDiffLines(beforeSnapshot.text) : [];
  const newLines = afterSnapshot.exists ? splitDiffLines(afterSnapshot.text) : [];
  const maxCells = Number.isFinite(options.maxCells)
    ? options.maxCells
    : DEFAULT_MAX_DIFF_CELLS;
  if (oldLines.length * newLines.length > maxCells) return null;
  const maxPreviewLines = Number.isFinite(options.maxPreviewLines)
    ? options.maxPreviewLines
    : DEFAULT_MAX_DIFF_PREVIEW_LINES;
  const diff = computeLineDiff(oldLines, newLines);
  let added = 0;
  let removed = 0;
  const preview = [];
  for (const line of diff) {
    if (line.type === 'add') added += 1;
    if (line.type === 'remove') removed += 1;
    if (line.type !== 'equal' && preview.length < maxPreviewLines) {
      preview.push(line);
    }
  }
  if (added === 0 && removed === 0) return null;
  return {
    added,
    removed,
    ...(preview.length > 0 ? { preview } : {}),
  };
}

function computeTextLineChangeDetails(beforeSnapshot, afterSnapshot, options = {}) {
  const stats = computeTextLineChangeStats(beforeSnapshot, afterSnapshot, options);
  if (!stats) return null;
  const previewDetails = computeTextLineChangePreview(beforeSnapshot, afterSnapshot, {
    maxCells: Number.isFinite(options.maxPreviewCells) ? options.maxPreviewCells : options.maxCells,
    maxPreviewLines: options.maxPreviewLines,
  });
  return {
    ...stats,
    ...(Array.isArray(previewDetails?.preview) && previewDetails.preview.length > 0
      ? { preview: previewDetails.preview }
      : {}),
  };
}

function makeSnapshotKey(item, change, cwd = '') {
  const itemId = typeof item?.id === 'string' ? item.id : '';
  const path = resolveSnapshotPath(change?.path, cwd);
  return path ? `${itemId}\n${path}` : '';
}

export function createFileChangeStatsTracker(options = {}) {
  const snapshots = new Map();
  const finalSnapshots = new Map();
  const runBaselineSnapshots = new Map();
  const observedFiles = new Map();
  const pathsWithEmittedStats = new Set();
  const cwd = typeof options.cwd === 'string' ? options.cwd : '';
  const baselineRoots = normalizeBaselineRoots(
    Array.isArray(options.baselineRoots) && options.baselineRoots.length > 0
      ? options.baselineRoots
      : (cwd ? [cwd] : []),
  );
  const readSnapshot = typeof options.readSnapshot === 'function'
    ? options.readSnapshot
    : (filePath) => readFileChangeSnapshot(filePath, {
      cwd,
      maxBytes: options.maxBytes,
    });
  const maxBaselineFiles = Number.isFinite(options.maxBaselineFiles)
    ? options.maxBaselineFiles
    : DEFAULT_MAX_BASELINE_FILES;
  const maxBaselineTotalBytes = Number.isFinite(options.maxBaselineTotalBytes)
    ? options.maxBaselineTotalBytes
    : DEFAULT_MAX_BASELINE_TOTAL_BYTES;

  function findCoveringBaselineRoot(resolvedPath) {
    return baselineRoots.find((root) => (
      pathIsInside(root.rootPath, resolvedPath)
      && !pathHasSkippedSegment(root.rootPath, resolvedPath)
    )) || null;
  }

  function getKnownBaselineSnapshot(resolvedPath) {
    if (!resolvedPath) return undefined;
    if (runBaselineSnapshots.has(resolvedPath)) {
      return runBaselineSnapshots.get(resolvedPath);
    }
    const root = findCoveringBaselineRoot(resolvedPath);
    if (root?.complete) {
      return MISSING_BASELINE_SNAPSHOT;
    }
    return undefined;
  }

  function captureBaselineFile(filePath, counters) {
    if (counters.files >= maxBaselineFiles || counters.bytes >= maxBaselineTotalBytes) {
      counters.truncated = true;
      return false;
    }
    counters.files += 1;
    let stat = null;
    try {
      stat = statSync(filePath);
    } catch {
      return true;
    }
    if (!stat?.isFile()) return true;
    const maxBytes = Number.isFinite(options.maxBytes)
      ? options.maxBytes
      : DEFAULT_MAX_SNAPSHOT_BYTES;
    if (stat.size > maxBytes) {
      runBaselineSnapshots.set(filePath, null);
      return true;
    }
    if (counters.bytes + stat.size > maxBaselineTotalBytes) {
      counters.truncated = true;
      return false;
    }
    const snapshot = readFileChangeSnapshot(filePath, { maxBytes });
    runBaselineSnapshots.set(filePath, snapshot);
    counters.bytes += stat.size;
    return true;
  }

  function captureBaselineDirectory(dirPath, root, counters) {
    if (counters.truncated) return false;
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      root.complete = false;
      return true;
    }
    for (const entry of entries) {
      if (counters.truncated) return false;
      const entryPath = resolve(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (BASELINE_SKIP_DIRS.has(entry.name)) continue;
        if (!captureBaselineDirectory(entryPath, root, counters)) return false;
      } else if (entry.isFile()) {
        if (!captureBaselineFile(entryPath, counters)) return false;
      }
    }
    return true;
  }

  function captureRunBaseline() {
    for (const root of baselineRoots) {
      if (root.scanned) continue;
      const counters = {
        bytes: 0,
        files: 0,
        truncated: false,
      };
      root.scanned = true;
      root.complete = true;
      captureBaselineDirectory(root.rootPath, root, counters);
      if (counters.truncated) {
        root.complete = false;
      }
    }
  }

  function rememberObservedFile(change, snapshot = null) {
    const resolvedPath = resolveSnapshotPath(change?.path, cwd);
    if (!resolvedPath) return '';
    observedFiles.set(resolvedPath, {
      path: change.path,
      kind: change.kind || change.changeType || 'update',
    });
    if (!runBaselineSnapshots.has(resolvedPath)) {
      const knownBaseline = getKnownBaselineSnapshot(resolvedPath);
      runBaselineSnapshots.set(
        resolvedPath,
        knownBaseline !== undefined ? knownBaseline : (snapshot || readSnapshot(change.path)),
      );
    }
    return resolvedPath;
  }

  function captureStartedItem(item) {
    if (!Array.isArray(item?.changes)) return;
    for (const change of item.changes) {
      const key = makeSnapshotKey(item, change, cwd);
      if (!key || snapshots.has(key)) continue;
      const snapshot = readSnapshot(change.path);
      rememberObservedFile(change, snapshot);
      snapshots.set(key, snapshot);
    }
  }

  function enrichCompletedItem(item) {
    if (!Array.isArray(item?.changes)) return item;
    let changed = false;
    const changes = item.changes.map((change) => {
      const key = makeSnapshotKey(item, change, cwd);
      const resolvedPath = resolveSnapshotPath(change?.path, cwd);
      const startedSnapshot = key ? snapshots.get(key) : null;
      const previousFinalSnapshot = resolvedPath ? finalSnapshots.get(resolvedPath) : null;
      rememberObservedFile(change, startedSnapshot || previousFinalSnapshot || null);
      const runBaselineSnapshot = resolvedPath ? getKnownBaselineSnapshot(resolvedPath) : undefined;
      if (key) snapshots.delete(key);
      const afterSnapshot = readSnapshot(change.path);
      if (changeAlreadyHasStats(change)) {
        let previewDetails = null;
        if (!Array.isArray(change.preview) || change.preview.length === 0) {
          previewDetails = computeTextLineChangeDetails(startedSnapshot, afterSnapshot, {
            maxCells: options.maxCells,
            maxPreviewCells: options.maxPreviewCells,
            maxPreviewLines: options.maxPreviewLines,
          });
          if (!previewDetails && previousFinalSnapshot && previousFinalSnapshot !== startedSnapshot) {
            previewDetails = computeTextLineChangeDetails(previousFinalSnapshot, afterSnapshot, {
              maxCells: options.maxCells,
              maxPreviewCells: options.maxPreviewCells,
              maxPreviewLines: options.maxPreviewLines,
            });
          }
          if (
            !previewDetails
            && resolvedPath
            && runBaselineSnapshot !== undefined
            && runBaselineSnapshot !== startedSnapshot
            && runBaselineSnapshot !== previousFinalSnapshot
          ) {
            previewDetails = computeTextLineChangeDetails(runBaselineSnapshot, afterSnapshot, {
              maxCells: options.maxCells,
              maxPreviewCells: options.maxPreviewCells,
              maxPreviewLines: options.maxPreviewLines,
            });
          }
        }
        if (resolvedPath && afterSnapshot) {
          finalSnapshots.set(resolvedPath, afterSnapshot);
          pathsWithEmittedStats.add(resolvedPath);
        }
        if (Array.isArray(previewDetails?.preview) && previewDetails.preview.length > 0) {
          changed = true;
          return { ...change, preview: previewDetails.preview };
        }
        return change;
      }
      let stats = computeTextLineChangeDetails(startedSnapshot, afterSnapshot, {
        maxCells: options.maxCells,
        maxPreviewCells: options.maxPreviewCells,
        maxPreviewLines: options.maxPreviewLines,
      });
      if (!stats && previousFinalSnapshot && previousFinalSnapshot !== startedSnapshot) {
        stats = computeTextLineChangeDetails(previousFinalSnapshot, afterSnapshot, {
          maxCells: options.maxCells,
          maxPreviewCells: options.maxPreviewCells,
          maxPreviewLines: options.maxPreviewLines,
        });
      }
      if (
        !stats
        && resolvedPath
        && !pathsWithEmittedStats.has(resolvedPath)
        && runBaselineSnapshot !== undefined
        && runBaselineSnapshot !== startedSnapshot
        && runBaselineSnapshot !== previousFinalSnapshot
      ) {
        stats = computeTextLineChangeDetails(runBaselineSnapshot, afterSnapshot, {
          maxCells: options.maxCells,
          maxPreviewCells: options.maxPreviewCells,
          maxPreviewLines: options.maxPreviewLines,
        });
      }
      if (resolvedPath && afterSnapshot) {
        finalSnapshots.set(resolvedPath, afterSnapshot);
      }
      if (!stats) return change;
      changed = true;
      if (resolvedPath) {
        pathsWithEmittedStats.add(resolvedPath);
      }
      return {
        ...change,
        ...(stats.added > 0 ? { added: stats.added } : {}),
        ...(stats.removed > 0 ? { removed: stats.removed } : {}),
        ...(Array.isArray(stats.preview) && stats.preview.length > 0 ? { preview: stats.preview } : {}),
      };
    });
    return changed ? { ...item, changes } : item;
  }

  function observeProviderPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const item = payload.item;
    if (!item || item.type !== 'file_change') return payload;
    if (payload.type === 'item.started' || payload.type === 'item.updated') {
      captureStartedItem(item);
      return payload;
    }
    if (payload.type !== 'item.completed') return payload;
    const nextItem = enrichCompletedItem(item);
    return nextItem === item ? payload : { ...payload, item: nextItem };
  }

  function buildTerminalStatsPayload({ runId = '' } = {}) {
    const changes = [];
    for (const [resolvedPath, info] of observedFiles.entries()) {
      if (pathsWithEmittedStats.has(resolvedPath)) continue;
      const beforeSnapshot = getKnownBaselineSnapshot(resolvedPath);
      const afterSnapshot = readSnapshot(info.path) || finalSnapshots.get(resolvedPath);
      const stats = computeTextLineChangeDetails(beforeSnapshot, afterSnapshot, {
        maxCells: options.maxCells,
        maxPreviewCells: options.maxPreviewCells,
        maxPreviewLines: options.maxPreviewLines,
      });
      if (!stats) continue;
      pathsWithEmittedStats.add(resolvedPath);
      changes.push({
        path: info.path,
        kind: info.kind || 'update',
        ...(stats.added > 0 ? { added: stats.added } : {}),
        ...(stats.removed > 0 ? { removed: stats.removed } : {}),
        ...(Array.isArray(stats.preview) && stats.preview.length > 0 ? { preview: stats.preview } : {}),
      });
    }
    if (changes.length === 0) return null;
    return {
      type: 'item.completed',
      item: {
        id: `ragent_file_change_stats_${String(runId || 'run')}`,
        type: 'file_change',
        status: 'completed',
        source: 'ragent.snapshot-summary',
        changes,
      },
    };
  }

  if (options.captureRunBaseline === true) {
    captureRunBaseline();
  }

  return {
    buildTerminalStatsPayload,
    captureRunBaseline,
    observeProviderPayload,
  };
}
