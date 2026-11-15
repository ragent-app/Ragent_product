/**
 * chat/risk-policy-adapter.mjs — 策略引擎适配层（OPA shadow mode）。
 *
 * 第三阶段设计：OPA 只负责“策略镜像”，绝不负责 Shell 解析，也绝不成为
 * 唯一安全边界。默认走 Node 内置策略（engine: 'builtin'）；当
 * RAGENT_RISK_POLICY_OPA=1 且 opa 二进制可用时，用
 * policy/risk/linux-command.rego 并行计算并记录与内置策略的差异
 * （shadow），内置策略始终是最终裁决。
 *
 * 失败安全（fail-closed）：策略缺失/OPA 不可用时返回 caution（绝不
 * 降级成 safe）；tier 无效时同样按 caution 处理。
 *
 * env:
 *   RAGENT_RISK_POLICY_OPA  = '1' 启用 OPA shadow
 *   RAGENT_OPA_BIN          = opa 可执行文件路径（默认 'opa'）
 *   RAGENT_RISK_POLICY_REGO = rego 文件路径（默认 policy/risk/linux-command.rego）
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { RISK_POLICY_VERSION, RISK_SOURCE_DETERMINISTIC } from './risk-policy.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_REGO = join(dirname(fileURLToPath(import.meta.url)), '..', 'policy', 'risk', 'linux-command.rego');

export const RISK_POLICY_ADAPTER_ENGINE = Object.freeze({
  BUILTIN: 'builtin',
  OPA: 'opa',
  BUILTIN_FALLBACK: 'builtin-fallback',
});

const VALID_TIERS = new Set(['safe', 'caution', 'danger']);

const stats = {
  requests: 0,
  shadowEvaluations: 0,
  diffs: 0,
  failures: 0,
  engine: RISK_POLICY_ADAPTER_ENGINE.BUILTIN,
};

let diffListener = null;

/** 挂接 shadow 差异回调：{ builtinTier, opaTier, reasons, platform }。 */
export function setRiskPolicyDiffListener(fn) {
  diffListener = typeof fn === 'function' ? fn : null;
}

export function riskPolicyAdapterStats() {
  return { ...stats };
}

function safeTier(tier) {
  return VALID_TIERS.has(tier) ? tier : 'caution';
}

function builtinResult({ tier, reasons, policyVersion }) {
  return {
    engine: RISK_POLICY_ADAPTER_ENGINE.BUILTIN,
    tier: safeTier(tier),
    reasons: Array.isArray(reasons) ? reasons : [],
    policyVersion: policyVersion || RISK_POLICY_VERSION,
    source: RISK_SOURCE_DETERMINISTIC,
    availability: 'ok',
  };
}

function regoPath() {
  return process.env.RAGENT_RISK_POLICY_REGO || DEFAULT_REGO;
}

async function evalOpaTier(opaBin, input) {
  const { stdout } = await execFileAsync(
    opaBin,
    ['eval', '--data', regoPath(), '--stdin-input', '--format', 'json', 'data.risk.tier'],
    { input: JSON.stringify(input), maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const value = parsed?.result?.[0]?.expressions?.[0]?.value;
  return VALID_TIERS.has(value) ? value : '';
}

/**
 * 评估一次风险策略。
 *
 * @param {object} input
 * @param {string} [input.platform]    平台标识（linux-bash 等，透传给 shadow）。
 * @param {object} [input.facts]       解析器结构化事实（透传给 shadow）。
 * @param {string} [input.tier]        内置策略 tier（最终裁决）。
 * @param {Array}  [input.reasons]     [{code,message}]。
 * @param {string} [input.policyVersion]
 * @param {string} [input.riskMode]    'safe' | 'recommended'（透传，本期不参与）。
 * @param {string} [input.targetScope]  Resolved target scope audit fact.
 * @param {object} [input.riskContext] Admission-frozen workspace context.
 * @returns {Promise<object>}
 */
export async function evaluateRiskPolicy({
  platform = '',
  facts = null,
  tier = '',
  reasons = [],
  policyVersion = RISK_POLICY_VERSION,
  riskMode = '',
  targetScope = '',
  riskContext = null,
} = {}) {
  stats.requests += 1;
  const builtin = builtinResult({ tier, reasons, policyVersion });
  if (process.env.RAGENT_RISK_POLICY_OPA !== '1') return builtin;

  const opaBin = process.env.RAGENT_OPA_BIN || 'opa';
  try {
    const context = riskContext && typeof riskContext === 'object' ? riskContext : null;
    const resolvedTargetScope = targetScope
      || (typeof facts?.targetScope === 'string' ? facts.targetScope : '')
      || (typeof facts?.signals?.targetScope === 'string' ? facts.signals.targetScope : '');
    const opaTier = await evalOpaTier(opaBin, {
      reasons: builtin.reasons,
      tier: builtin.tier,
      platform,
      facts,
      riskMode,
      targetScope: resolvedTargetScope,
      riskContext: context
        ? {
            schemaVersion: context.schemaVersion || null,
            workspaceRoot: typeof context.workspaceRoot === 'string' ? context.workspaceRoot : '',
            trustedWorkspaceRoot: typeof context.trustedWorkspaceRoot === 'string' ? context.trustedWorkspaceRoot : '',
            cwd: typeof context.cwd === 'string' ? context.cwd : '',
            protectedRoots: Array.isArray(context.protectedRoots) ? context.protectedRoots : [],
          }
        : null,
    });
    stats.shadowEvaluations += 1;
    stats.engine = RISK_POLICY_ADAPTER_ENGINE.OPA;
    if (opaTier && opaTier !== builtin.tier) {
      stats.diffs += 1;
      if (diffListener) {
        try {
          diffListener({
            builtinTier: builtin.tier,
            opaTier,
            reasons: builtin.reasons,
            platform,
            facts,
            policyVersion: builtin.policyVersion,
          });
        } catch {
          // 差异回调异常不影响主链路。
        }
      }
    }
    return {
      ...builtin,
      engine: RISK_POLICY_ADAPTER_ENGINE.OPA,
      shadow: { opaTier, policyVersion: builtin.policyVersion },
    };
  } catch {
    stats.failures += 1;
    stats.engine = RISK_POLICY_ADAPTER_ENGINE.BUILTIN_FALLBACK;
    return {
      ...builtin,
      engine: RISK_POLICY_ADAPTER_ENGINE.BUILTIN_FALLBACK,
      availability: 'unavailable',
    };
  }
}
