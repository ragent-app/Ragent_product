#!/usr/bin/env node
// Execution-Scope slice 2: sidecar cwd resolution contract.
//
// New manifests with an immutable executionScope use ONLY
// executionScope.cwd.realPath and fail fast with EXECUTION_SCOPE_UNAVAILABLE
// (never a silent fallback to managed work root / home). Legacy manifests keep
// the existing resolveRunnableSessionFolder fallback and are flagged
// legacyExecutionScope=true. Importing the module must not start a sidecar
// (isMainEntry guard).
import assert from 'assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { resolveRunCwd, isRunnableDirectory, resolveRunRiskContext } = await import('../chat/runner-sidecar.mjs');
const { computeExecutionScopeDigest } = await import('../chat/execution-scope.mjs');

const createdDirs = [];
function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

try {
  // ── new scope: valid cwd ──────────────────────────────────────────────────
  const root = makeDir('ragent-sidecar-root-');
  const scoped = resolveRunCwd({ executionScope: { cwd: { realPath: root } } });
  assert.equal(scoped.cwd, root, 'new scope should use executionScope.cwd.realPath');
  assert.equal(scoped.legacyExecutionScope, false, 'new scope runs are not legacy');
  assert.equal(scoped.repaired, false, 'a valid scope must not be marked repaired');

  // ── new scope: missing / non-directory / inaccessible cwd fails fast ──────
  const missing = join(tmpdir(), `ragent-sidecar-missing-${Date.now()}`);
  assert.throws(
    () => resolveRunCwd({ executionScope: { cwd: { realPath: missing } } }),
    (error) => error.code === 'EXECUTION_SCOPE_UNAVAILABLE' && error.statusCode === 409,
    'a missing scope cwd must fail with EXECUTION_SCOPE_UNAVAILABLE (no fallback)',
  );

  const filePath = join(root, 'not-a-dir.txt');
  writeFileSync(filePath, 'x\n');
  assert.throws(
    () => resolveRunCwd({ executionScope: { cwd: { realPath: filePath } } }),
    (error) => error.code === 'EXECUTION_SCOPE_UNAVAILABLE',
    'a non-directory scope cwd must fail with EXECUTION_SCOPE_UNAVAILABLE',
  );

  // inaccessible via injected checker (chmod-based checks are root-dependent)
  assert.throws(
    () => resolveRunCwd(
      { executionScope: { cwd: { realPath: root } } },
      { isRunnableDirectory: () => false },
    ),
    (error) => error.code === 'EXECUTION_SCOPE_UNAVAILABLE',
    'an inaccessible scope cwd must fail with EXECUTION_SCOPE_UNAVAILABLE',
  );

  // ── legacy manifests keep the existing fallback contract ─────────────────
  const legacy = resolveRunCwd(
    { folder: root },
    { resolveLegacy: (folder) => ({ cwd: folder, requestedCwd: folder, repaired: false, reason: '' }) },
  );
  assert.equal(legacy.cwd, root, 'legacy manifests should resolve the session folder');
  assert.equal(legacy.legacyExecutionScope, true, 'legacy manifests must be flagged legacyExecutionScope=true');

  const repaired = resolveRunCwd(
    { folder: join(tmpdir(), 'ragent-sidecar-missing-2') },
    {
      resolveLegacy: (folder) => ({
        cwd: '/managed-work-root',
        requestedCwd: folder,
        repaired: true,
        reason: 'missing-session-folder-fallback-managed-work-root',
      }),
    },
  );
  assert.equal(repaired.repaired, true, 'legacy repair signal should pass through');
  assert.equal(repaired.reason, 'missing-session-folder-fallback-managed-work-root');

  // legacy folder is '' -> resolveLegacy receives the empty folder
  const emptyFolder = resolveRunCwd({}, { resolveLegacy: (folder) => ({ cwd: folder || '/home', legacy: true }) });
  assert.equal(emptyFolder.cwd, '/home', 'legacy resolution should run even without a folder');

  // Risk context is trusted only when it is bound to the immutable scope
  // digest. Missing, malformed, or stale bindings must fall back closed.
  const riskScope = {
    schemaVersion: 1,
    snapshotId: 'ess_risk_fixture',
    createdAt: '2026-09-01T00:00:00.000Z',
    workspaceRoot: { realPath: root },
    scopeRoot: { realPath: root },
    cwd: { realPath: root },
    riskContext: {
      schemaVersion: 1,
      platform: 'linux',
      workspaceRoot: root,
      trustedWorkspaceRoot: root,
      cwd: root,
      protectedRoots: [],
      systemPathRoots: ['/etc', '/var'],
    },
  };
  const riskDigest = computeExecutionScopeDigest(riskScope);
  const boundRisk = resolveRunRiskContext({ executionScope: riskScope, executionScopeDigest: riskDigest }, { platform: 'linux' });
  assert.equal(boundRisk.valid, true, 'matching risk context digest should be accepted');
  assert.equal(boundRisk.riskContext.trustedWorkspaceRoot, root, 'accepted context should preserve the bound workspace');
  assert.equal(resolveRunRiskContext({ executionScope: riskScope }).reason, 'execution-scope-digest-missing',
    'missing digest must reject risk context');
  assert.equal(resolveRunRiskContext({ executionScope: { ...riskScope, riskContext: undefined }, executionScopeDigest: riskDigest }).reason,
    'risk-context-missing', 'missing risk context must reject the exception');
  const tamperedScope = {
    ...riskScope,
    riskContext: { ...riskScope.riskContext, trustedWorkspaceRoot: '/tmp/attacker-root' },
  };
  assert.equal(resolveRunRiskContext({ executionScope: tamperedScope, executionScopeDigest: riskDigest }).reason,
    'execution-scope-digest-mismatch', 'tampered risk context must fail digest verification');

  // ── isRunnableDirectory primitive ─────────────────────────────────────────
  assert.equal(isRunnableDirectory(root), true, 'a real directory should be runnable');
  assert.equal(isRunnableDirectory(missing), false, 'a missing path should not be runnable');
  assert.equal(isRunnableDirectory(filePath), false, 'a file should not be runnable');

  console.log('test-runner-sidecar-cwd: ok');
} finally {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}
