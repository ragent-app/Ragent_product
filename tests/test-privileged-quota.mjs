#!/usr/bin/env node
// install-auto quota persistence (P3 hardening).
//
// Covers the durable privileged-quota.json state:
//   1. Missing file → empty window, first use allowed.
//   2. Record increments count; file is written atomically with mode 0600.
//   3. Sliding-window reset: uses after windowMs open a fresh window.
//   4. Over-quota → not allowed (mint path returns INSTALL_QUOTA_EXCEEDED).
//   5. check without record does not mutate state.

import assert from 'assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';

import {
  checkInstallQuotaFile,
  installQuotaWindowExpired,
  loadInstallQuotaState,
  recordInstallQuotaUse,
  INSTALL_AUTO_QUOTA_MAX_DEFAULT,
  INSTALL_AUTO_QUOTA_WINDOW_MS_DEFAULT,
} from '../chat/privileged-quota.mjs';

const MAX = 5;
const WINDOW_MS = 60 * 60 * 1000;

const tmpDir = await mkdtemp(join(tmpdir(), 'ragent-quota-test-'));
let passed = 0;
const eq = (label, actual, expected) => {
  assert.equal(actual, expected, label);
  passed += 1;
};
const ok = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

try {
  const quotaFile = join(tmpDir, 'privileged-quota.json');

  // 1. Missing file → allowed, count 0.
  {
    const state = await loadInstallQuotaState(quotaFile, { now: 1000 });
    eq('missing: count 0', state.count, 0);
    const verdict = await checkInstallQuotaFile(quotaFile, { now: 1000, max: MAX, windowMs: WINDOW_MS });
    eq('missing: allowed', verdict.allowed, true);
    eq('missing: remaining', verdict.remaining, MAX);
  }

  // 2. Record increments; file written atomically, mode 0600.
  {
    const v1 = await recordInstallQuotaUse(quotaFile, { now: 2000, max: MAX, windowMs: WINDOW_MS });
    eq('record 1: used', v1.used, 1);
    eq('record 1: remaining', v1.remaining, MAX - 1);
    const v2 = await recordInstallQuotaUse(quotaFile, { now: 3000, max: MAX, windowMs: WINDOW_MS });
    eq('record 2: used', v2.used, 2);
    const raw = JSON.parse(await readFile(quotaFile, 'utf8'));
    eq('file: count persisted', raw.count, 2);
    eq('file: windowStartedAt persisted', raw.windowStartedAtMs, 2000);
    const mode = (await stat(quotaFile)).mode & 0o777;
    eq('file: mode 0600', mode, 0o600);
    const state = await loadInstallQuotaState(quotaFile, { now: 3000 });
    eq('reload: count', state.count, 2);
  }

  // 3. Sliding-window reset.
  {
    eq('window expired: past end', installQuotaWindowExpired({ windowStartedAtMs: 2000, windowMs: WINDOW_MS }, 2000 + WINDOW_MS), true);
    eq('window expired: at end', installQuotaWindowExpired({ windowStartedAtMs: 2000, windowMs: WINDOW_MS }, 2000 + WINDOW_MS - 1), false);
    const v3 = await recordInstallQuotaUse(quotaFile, { now: 2000 + WINDOW_MS, max: MAX, windowMs: WINDOW_MS });
    eq('reset: used back to 1', v3.used, 1);
    eq('reset: remaining', v3.remaining, MAX - 1);
  }

  // 4. Over-quota → denied (fill remaining 4, then the 6th use is denied).
  {
    for (let i = 0; i < MAX - 1; i += 1) {
      await recordInstallQuotaUse(quotaFile, { now: 2000 + WINDOW_MS + i, max: MAX, windowMs: WINDOW_MS });
    }
    const before = await checkInstallQuotaFile(quotaFile, { now: 2000 + WINDOW_MS + 10, max: MAX, windowMs: WINDOW_MS });
    eq('at cap: not allowed', before.allowed, false);
    eq('at cap: used==max', before.used, MAX);
    // check without record does not mutate
    const after = await loadInstallQuotaState(quotaFile, { now: 2000 + WINDOW_MS + 10 });
    eq('check without record: count unchanged', after.count, MAX);
  }

  // 5. Defaults exported sane.
  {
    eq('default max', INSTALL_AUTO_QUOTA_MAX_DEFAULT, 5);
    eq('default windowMs', INSTALL_AUTO_QUOTA_WINDOW_MS_DEFAULT, 60 * 60 * 1000);
  }

  console.log(`test-privileged-quota: ${passed} checks passed`);
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
