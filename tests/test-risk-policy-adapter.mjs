#!/usr/bin/env node
import assert from 'assert/strict';

import {
  evaluateRiskPolicy,
  RISK_POLICY_ADAPTER_ENGINE,
  riskPolicyAdapterStats,
  setRiskPolicyDiffListener,
} from '../chat/risk-policy-adapter.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const REASONS = [{ code: 'delete_system_path', message: 'delete on system path' }];

// 默认（未开 OPA）：内置策略直接裁决。
const before = riskPolicyAdapterStats().requests;
const builtin = await evaluateRiskPolicy({ tier: 'danger', reasons: REASONS, platform: 'linux-bash' });
eq('builtin engine', builtin.engine, RISK_POLICY_ADAPTER_ENGINE.BUILTIN);
eq('builtin tier preserved', builtin.tier, 'danger');
eq('builtin availability', builtin.availability, 'ok');
eq('builtin source deterministic', builtin.source, 'deterministic');
eq('stats requests incremented', riskPolicyAdapterStats().requests, before + 1);

// 失败安全：tier 缺失/非法 → caution，绝不 safe。
const missing = await evaluateRiskPolicy({ reasons: REASONS });
eq('missing tier fails closed to caution', missing.tier, 'caution');
const invalid = await evaluateRiskPolicy({ tier: 'nonsense', reasons: REASONS });
eq('invalid tier fails closed to caution', invalid.tier, 'caution');

// OPA 启用但二进制不可用：builtin-fallback，且不改判。
const oldEnv = process.env.RAGENT_RISK_POLICY_OPA;
process.env.RAGENT_RISK_POLICY_OPA = '1';
process.env.RAGENT_OPA_BIN = '/nonexistent/opa';
const fallback = await evaluateRiskPolicy({ tier: 'danger', reasons: REASONS });
eq('opa missing falls back', fallback.engine, RISK_POLICY_ADAPTER_ENGINE.BUILTIN_FALLBACK);
eq('fallback keeps danger tier', fallback.tier, 'danger');
eq('fallback availability unavailable', fallback.availability, 'unavailable');
check('fallback counted as failure', riskPolicyAdapterStats().failures >= 1);

// 差异回调在 fallback 下不触发。
let diffCalls = 0;
setRiskPolicyDiffListener(() => { diffCalls += 1; });
await evaluateRiskPolicy({ tier: 'danger', reasons: REASONS });
eq('no diff listener on fallback', diffCalls, 0);
setRiskPolicyDiffListener(null);

if (oldEnv === undefined) delete process.env.RAGENT_RISK_POLICY_OPA;
else process.env.RAGENT_RISK_POLICY_OPA = oldEnv;
delete process.env.RAGENT_OPA_BIN;

console.log(`risk-policy-adapter: ${passed} checks passed`);
