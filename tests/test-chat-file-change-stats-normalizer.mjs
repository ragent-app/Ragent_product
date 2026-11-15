#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCodexAdapter } from '../chat/adapters/codex.mjs';
import { createCopilotAdapter } from '../chat/adapters/copilot.mjs';
import {
  computeTextLineChangePreview,
  createFileChangeStatsTracker,
} from '../chat/file-change-stats.mjs';
import { fileChangeEvent } from '../chat/normalizer.mjs';

const direct = fileChangeEvent('/tmp/app.js', 'update', {
  additions: 4,
  deletions: 2,
});
assert.equal(direct.added, 4, 'normalizer should preserve added line counts from common provider fields');
assert.equal(direct.removed, 2, 'normalizer should preserve removed line counts from common provider fields');

const directPreview = fileChangeEvent('/tmp/app.js', 'update', {
  preview: [
    { type: 'remove', text: 'old line', oldLine: 7 },
    { type: 'add', text: 'new line', newLine: 8 },
  ],
});
assert.deepEqual(
  directPreview.preview,
  [
    { type: 'remove', text: 'old line', oldLine: 7 },
    { type: 'add', text: 'new line', newLine: 8 },
  ],
  'normalizer should preserve sanitized file-change diff previews',
);

const unifiedDiff = fileChangeEvent('/tmp/app.js', { type: 'update' }, {
  diff: '@@ -2,2 +2,3 @@\n keep\n-old line\n+new line\n+extra line\n',
});
assert.equal(unifiedDiff.changeType, 'update', 'normalizer should simplify object-shaped change kinds');
assert.equal(unifiedDiff.added, 2, 'normalizer should derive added counts from unified diffs');
assert.equal(unifiedDiff.removed, 1, 'normalizer should derive removed counts from unified diffs');
assert.deepEqual(
  unifiedDiff.preview,
  [
    { type: 'remove', text: 'old line', oldLine: 3 },
    { type: 'add', text: 'new line', newLine: 3 },
    { type: 'add', text: 'extra line', newLine: 4 },
  ],
  'normalizer should derive line preview entries from unified diffs',
);

const bareAddedDiff = fileChangeEvent('/tmp/new.js', { type: 'add' }, {
  diff: 'alpha\nbeta\n',
});
assert.equal(bareAddedDiff.changeType, 'add', 'normalizer should simplify object-shaped add kinds');
assert.equal(bareAddedDiff.added, 2, 'normalizer should count bare add-file diffs as added lines');
assert.equal(bareAddedDiff.removed, 0, 'normalizer should mark bare add-file diffs with zero removed lines');
assert.deepEqual(
  bareAddedDiff.preview,
  [
    { type: 'add', text: 'alpha', newLine: 1 },
    { type: 'add', text: 'beta', newLine: 2 },
  ],
  'normalizer should derive preview lines for bare add-file diffs',
);

const computedPreview = computeTextLineChangePreview(
  { exists: true, text: 'alpha\nbeta\n' },
  { exists: true, text: 'alpha\nBETA\ngamma\n' },
);
assert.deepEqual(
  computedPreview.preview,
  [
    { type: 'remove', text: 'beta', oldLine: 2 },
    { type: 'add', text: 'BETA', newLine: 2 },
    { type: 'add', text: 'gamma', newLine: 3 },
  ],
  'file-change diff previews should include changed text and old/new line numbers',
);

const codexEvents = createCodexAdapter().parseLine(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'file_change',
    changes: [{
      path: '/tmp/codex.js',
      kind: 'update',
      addedLines: 3,
      removedLines: 1,
    }],
  },
}));
const codexFileChange = codexEvents.find((event) => event.type === 'file_change');
assert.equal(codexFileChange?.filePath, '/tmp/codex.js', 'Codex adapter should still emit file_change events');
assert.equal(codexFileChange?.added, 3, 'Codex adapter should pass through added line counts when available');
assert.equal(codexFileChange?.removed, 1, 'Codex adapter should pass through removed line counts when available');

const copilotEvents = createCopilotAdapter().parseLine(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'file_change',
    changes: [{
      path: '/tmp/copilot.js',
      kind: 'update',
      additions: 5,
      deletions: 2,
    }],
  },
}));
const copilotFileChange = copilotEvents.find((event) => event.type === 'file_change');
assert.equal(copilotFileChange?.filePath, '/tmp/copilot.js', 'Copilot adapter should still emit file_change events');
assert.equal(copilotFileChange?.added, 5, 'Copilot adapter should pass through added line counts when available');
assert.equal(copilotFileChange?.removed, 2, 'Copilot adapter should pass through removed line counts when available');

let liveFileText = 'alpha\nbeta\n';
const tracker = createFileChangeStatsTracker({
  readSnapshot(filePath) {
    assert.equal(filePath, '/tmp/live.js');
    return { exists: true, text: liveFileText };
  },
});
const startedPayload = {
  type: 'item.started',
  item: {
    id: 'item_live_edit',
    type: 'file_change',
    status: 'in_progress',
    changes: [{ path: '/tmp/live.js', kind: 'update' }],
  },
};
assert.equal(
  tracker.observeProviderPayload(startedPayload),
  startedPayload,
  'file change tracker should keep started payloads unchanged while recording a pre-edit snapshot',
);
liveFileText = 'alpha\nBETA\ngamma\n';
const enrichedPayload = tracker.observeProviderPayload({
  type: 'item.completed',
  item: {
    id: 'item_live_edit',
    type: 'file_change',
    status: 'completed',
    changes: [{ path: '/tmp/live.js', kind: 'update' }],
  },
});
assert.equal(enrichedPayload.item.changes[0].added, 2, 'sidecar file-change tracker should derive added lines from file snapshots');
assert.equal(enrichedPayload.item.changes[0].removed, 1, 'sidecar file-change tracker should derive removed lines from file snapshots');
assert.deepEqual(
  enrichedPayload.item.changes[0].preview,
  [
    { type: 'remove', text: 'beta', oldLine: 2 },
    { type: 'add', text: 'BETA', newLine: 2 },
    { type: 'add', text: 'gamma', newLine: 3 },
  ],
  'sidecar file-change tracker should include a line-level diff preview',
);
const enrichedCodexEvents = createCodexAdapter().parseLine(JSON.stringify(enrichedPayload));
const enrichedCodexFileChange = enrichedCodexEvents.find((event) => event.type === 'file_change');
assert.equal(enrichedCodexFileChange?.added, 2, 'Codex adapter should preserve sidecar-derived added line counts');
assert.equal(enrichedCodexFileChange?.removed, 1, 'Codex adapter should preserve sidecar-derived removed line counts');
assert.equal(enrichedCodexFileChange?.preview?.[0]?.oldLine, 2, 'Codex adapter should preserve sidecar-derived preview line numbers');

let providerStatsFileText = 'left\nright\n';
const providerStatsTracker = createFileChangeStatsTracker({
  readSnapshot(filePath) {
    assert.equal(filePath, '/tmp/provider-stats.js');
    return { exists: true, text: providerStatsFileText };
  },
});
providerStatsTracker.observeProviderPayload({
  type: 'item.started',
  item: {
    id: 'item_provider_stats',
    type: 'file_change',
    status: 'in_progress',
    changes: [{ path: '/tmp/provider-stats.js', kind: 'update' }],
  },
});
providerStatsFileText = 'left\nRIGHT\n';
const providerStatsPayload = providerStatsTracker.observeProviderPayload({
  type: 'item.completed',
  item: {
    id: 'item_provider_stats',
    type: 'file_change',
    status: 'completed',
    changes: [{
      path: '/tmp/provider-stats.js',
      kind: 'update',
      additions: 1,
      deletions: 1,
    }],
  },
});
assert.equal(providerStatsPayload.item.changes[0].additions, 1, 'provider-supplied additions should stay intact');
assert.equal(providerStatsPayload.item.changes[0].deletions, 1, 'provider-supplied deletions should stay intact');
assert.deepEqual(
  providerStatsPayload.item.changes[0].preview,
  [
    { type: 'remove', text: 'right', oldLine: 2 },
    { type: 'add', text: 'RIGHT', newLine: 2 },
  ],
  'file-change tracker should add preview details even when the provider already supplied stats',
);

liveFileText = 'alpha\nBETA\ngamma\ndelta\n';
tracker.observeProviderPayload({
  type: 'item.started',
  item: {
    id: 'item_late_started_edit',
    type: 'file_change',
    status: 'in_progress',
    changes: [{ path: '/tmp/live.js', kind: 'update' }],
  },
});
const fallbackEnrichedPayload = tracker.observeProviderPayload({
  type: 'item.completed',
  item: {
    id: 'item_late_started_edit',
    type: 'file_change',
    status: 'completed',
    changes: [{ path: '/tmp/live.js', kind: 'update' }],
  },
});
assert.equal(
  fallbackEnrichedPayload.item.changes[0].added,
  1,
  'file-change tracker should fall back to the previous final snapshot for later same-file edits',
);
assert.equal(
  fallbackEnrichedPayload.item.changes[0].removed,
  undefined,
  'file-change tracker should not invent removed lines when later same-file edits only add content',
);
assert.equal(
  tracker.buildTerminalStatsPayload({ runId: 'run_already_reported' }),
  null,
  'terminal summary should not duplicate file-change stats already emitted during the run',
);

let terminalFileText = 'one\n';
const terminalTracker = createFileChangeStatsTracker({
  readSnapshot(filePath) {
    assert.equal(filePath, '/tmp/terminal.js');
    return { exists: true, text: terminalFileText };
  },
});
terminalTracker.observeProviderPayload({
  type: 'item.started',
  item: {
    id: 'item_terminal_edit',
    type: 'file_change',
    status: 'in_progress',
    changes: [{ path: '/tmp/terminal.js', kind: 'update' }],
  },
});
terminalFileText = 'one\ntwo\nthree\n';
const terminalPayload = terminalTracker.buildTerminalStatsPayload({ runId: 'run_terminal' });
assert.ok(terminalPayload, 'terminal summary should emit stats when the final run state reveals line changes');
assert.equal(terminalPayload.item.changes[0].added, 2, 'terminal summary should include added line counts');
assert.equal(terminalPayload.item.changes[0].removed, undefined, 'terminal summary should omit zero removed line counts');
assert.deepEqual(
  terminalPayload.item.changes[0].preview,
  [
    { type: 'add', text: 'two', newLine: 2 },
    { type: 'add', text: 'three', newLine: 3 },
  ],
  'terminal summary should include added-line preview entries',
);
const terminalCodexEvents = createCodexAdapter().parseLine(JSON.stringify(terminalPayload));
const terminalCodexFileChange = terminalCodexEvents.find((event) => event.type === 'file_change');
assert.equal(terminalCodexFileChange?.added, 2, 'Codex adapter should render terminal summary stats as file changes');
assert.equal(terminalCodexFileChange?.preview?.[1]?.newLine, 3, 'Codex adapter should render terminal summary preview line numbers');

const baselineRoot = mkdtempSync(join(tmpdir(), 'ragent-file-change-baseline-'));
try {
  const srcDir = join(baselineRoot, 'src');
  mkdirSync(srcDir, { recursive: true });
  const latePath = join(srcDir, 'late.js');
  const newPath = join(srcDir, 'new.js');
  writeFileSync(latePath, 'one\n', 'utf8');

  const baselineTracker = createFileChangeStatsTracker({
    cwd: baselineRoot,
    baselineRoots: [baselineRoot],
    captureRunBaseline: true,
  });

  writeFileSync(latePath, 'one\ntwo\nthree\n', 'utf8');
  const lateBaselinePayload = baselineTracker.observeProviderPayload({
    type: 'item.completed',
    item: {
      id: 'item_baseline_late',
      type: 'file_change',
      status: 'completed',
      changes: [{ path: 'src/late.js', kind: 'update' }],
    },
  });
  assert.equal(
    lateBaselinePayload.item.changes[0].added,
    2,
    'run-start baseline should recover line stats when file_change arrives after the edit',
  );

  writeFileSync(newPath, 'alpha\nbeta\n', 'utf8');
  const newFilePayload = baselineTracker.observeProviderPayload({
    type: 'item.completed',
    item: {
      id: 'item_baseline_new',
      type: 'file_change',
      status: 'completed',
      changes: [{ path: 'src/new.js', kind: 'add' }],
    },
  });
  assert.equal(
    newFilePayload.item.changes[0].added,
    2,
    'complete run-start baseline should treat later-observed missing files as newly added',
  );
} finally {
  rmSync(baselineRoot, { recursive: true, force: true });
}

console.log('test-chat-file-change-stats-normalizer: ok');
