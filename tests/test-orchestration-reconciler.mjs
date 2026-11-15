#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-orchestration-reconciler-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const store = await import('../chat/orchestration-store.mjs');
const reconciler = await import('../chat/orchestration-reconciler.mjs');

try {
  const waiting = await store.ensureExecution({
    scopeKind: 'approval',
    scopeId: 'approval-reconcile-1',
    rootSessionId: 'root-reconcile-1',
    kind: 'approval',
    state: 'running',
    spec: {},
  });
  await store.openInterrupt({
    executionId: waiting.id,
    stableKey: 'approval:reconcile-1',
    kind: 'approval',
    deadlineAt: new Date(Date.now() + 1_000).toISOString(),
  });
  const stale = await store.ensureExecution({
    scopeKind: 'organization_phase',
    scopeId: 'organization-reconcile-1:1:phase-1',
    rootSessionId: 'root-reconcile-1',
    kind: 'organization_phase',
    state: 'running',
    spec: {},
  });
  const future = new Date(Date.now() + 20 * 60 * 1000);
  const report = await reconciler.reconcileOrchestrationLedger({
    now: future,
    staleAfterMs: 15 * 60 * 1000,
    collaborationOrchestrator: {
      reconcileLedger: async () => ({ scanned: 3, mirrored: 3, failed: 0, truncated: false }),
    },
  });
  assert.equal(report.status, 'attention');
  assert.equal(report.mirroredCollaborations.scanned, 3);
  assert.equal(report.expiredInterrupts.length, 1);
  assert.equal(report.expiredInterrupts[0].executionId, waiting.id);
  assert.ok(report.stalledExecutions.some((entry) => entry.executionId === stale.id));
  assert.equal((await store.getExecution(waiting.id)).state, 'blocked');
  assert.equal(report.errors.length, 0);
  console.log('test-orchestration-reconciler: ok');
} finally {
  reconciler.stopOrchestrationReconciler();
  rmSync(configDir, { recursive: true, force: true });
}
