/**
 * chat/semantic-operation.mjs — SemanticOperation 契约（Phase 0，纯逻辑，无 I/O）。
 *
 * 依据 notes/directional/semantic-operation-policy-architecture-2026-08-10.md
 * §4.1 / §4.2 / §4.3、§15、§17 定义语义操作层的：
 *   - 版本常量（operation/policy/resolver/capability/compiler）；
 *   - action taxonomy（V1 动作清单与默认严格度）；
 *   - 稳定 reason code（风格对齐 chat/risk-policy.mjs：code 稳定，文案仅兜底）；
 *   - strictness 聚合（DENY > ASK > ALLOW；UNKNOWN 不低于 DENY）；
 *   - SemanticOperation 结构校验（validateSemanticOperation）；
 *   - refusal / allow 资格判定（动态、解释器、未知 target 绝不默认 allow）；
 *   - canonical JSON 与 manifest hash（key 排序、纯函数、确定性）。
 *
 * 本模块不执行命令、不签发授权；最终决策由 policy 层基于本契约产生，
 * host 安全边界仍是独立的受控执行器（capability 仅在授权后下发）。
 */

import { createHash } from 'node:crypto';

export const SEMANTIC_OPERATION_VERSION = 'semantic-operation/v1';
export const SEMANTIC_POLICY_VERSION = 'semantic-policy/v1';
export const SEMANTIC_RESOLVER_VERSION = 'semantic-resolver/v1';
export const SEMANTIC_CAPABILITY_VERSION = 'semantic-capability/v1';
export const SEMANTIC_COMPILER_VERSION = 'semantic-compiler/v1';

// 决策严格度：数值越大越严格。UNKNOWN 表示“无法确定”，
// 参与聚合时按 DENY 处理（不确定性绝不降低严格度）。
export const STRICTNESS = Object.freeze({
  ALLOW: 1,
  ASK: 2,
  DENY: 3,
});

export const DECISIONS = Object.freeze(['ALLOW', 'ASK', 'DENY', 'UNKNOWN']);

export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low', 'unknown']);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * V1 action taxonomy。每个动作带 domain、默认严格度（策略缺省时的下限）、
 * sensitive/privileged/remoteCode 属性与中文描述。
 * 新增动作必须显式建模；无法归类的 host 副作用一律 unknown.host_effect。
 */
export const ACTION_TAXONOMY = deepFreeze({
  'fs.read': {
    domain: 'filesystem',
    defaultStrictness: STRICTNESS.ALLOW,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '读取文件或目录内容',
  },
  'fs.write': {
    domain: 'filesystem',
    // Ordinary file writes are part of the product's core automation loop.
    // The resolver still supplies the authoritative target/self-protection
    // facts; only high-impact, dynamic, or service-self mutations are raised
    // above this default by policy.
    defaultStrictness: STRICTNESS.ALLOW,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '写入或修改文件/目录',
  },
  'fs.delete': {
    domain: 'filesystem',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '删除文件/目录',
  },
  'fs.metadata': {
    domain: 'filesystem',
    defaultStrictness: STRICTNESS.ALLOW,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '读取文件元数据',
  },
  'file_asset.read': {
    domain: 'control_plane',
    defaultStrictness: STRICTNESS.ALLOW,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '读取当前会话绑定的文件资产并暂存到当前 Run',
  },
  'control_plane.asset_descriptor.read': {
    domain: 'control_plane',
    defaultStrictness: STRICTNESS.ALLOW,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '读取服务端文件资产描述符',
  },
  'control_plane.object_storage.read': {
    domain: 'control_plane',
    defaultStrictness: STRICTNESS.ALLOW,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '读取文件资产的对象存储内容',
  },
  'control_plane.run_input.write': {
    domain: 'control_plane',
    defaultStrictness: STRICTNESS.ALLOW,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '写入当前 Run 的输入目录',
  },
  'runner.current_run_input.read': {
    domain: 'runner',
    defaultStrictness: STRICTNESS.ALLOW,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '读取当前 Run 的已校验输入',
  },
  'process.execute': {
    domain: 'process',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '执行本地进程',
  },
  'package.install': {
    domain: 'software',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '安装软件包',
  },
  'package.upgrade': {
    domain: 'software',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '升级软件包',
  },
  'package.remove': {
    domain: 'software',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '移除软件包',
  },
  'package.source.modify': {
    domain: 'software',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '修改软件源/仓库配置',
  },
  'service.control': {
    domain: 'service',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '控制服务启停/状态',
  },
  'service.modify': {
    domain: 'service',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '修改服务定义/单元文件',
  },
  'network.egress': {
    domain: 'network',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '网络出站请求',
  },
  'network.listen': {
    domain: 'network',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '监听网络端口',
  },
  'network.firewall.modify': {
    domain: 'network',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '修改防火墙规则',
  },
  'security.firewall.rule.modify': {
    domain: 'security',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '修改防火墙规则（结构化、可限定范围）',
  },
  'security.firewall.disable': {
    domain: 'security',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '停用防火墙',
  },
  'security.antivirus.exclusion.add': {
    domain: 'security',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '添加杀毒软件排除项',
  },
  'security.antivirus.disable': {
    domain: 'security',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '停用杀毒软件',
  },
  'security.audit.config.modify': {
    domain: 'security',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '修改审计配置',
  },
  'security.audit.disable': {
    domain: 'security',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '停用审计',
  },
  'credential.read': {
    domain: 'credential',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: false,
    remoteCode: false,
    description: '读取凭据',
  },
  'credential.write': {
    domain: 'credential',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: false,
    remoteCode: false,
    description: '写入凭据',
  },
  'credential.use': {
    domain: 'credential',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: false,
    remoteCode: false,
    description: '使用凭据',
  },
  'git.remote_write': {
    domain: 'git',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '向 git 远程写入',
  },
  'privilege.elevate': {
    domain: 'privilege',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: false,
    privileged: true,
    remoteCode: false,
    description: '权限提升',
  },
  'remote_code.execute': {
    domain: 'remote',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: false,
    privileged: false,
    remoteCode: true,
    description: '执行远程来源代码',
  },
  'permission.policy.modify': {
    domain: 'meta-permission',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '修改权限策略或安全上限',
  },
  'capability.forge': {
    domain: 'meta-permission',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '伪造或篡改 capability',
  },
  'approval.bypass': {
    domain: 'meta-permission',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '绕过审批流程',
  },
  'audit.tamper': {
    domain: 'meta-permission',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '篡改审计记录',
  },
  'executor.bypass': {
    domain: 'meta-permission',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '绕过受控执行器',
  },
  'signing.key.read': {
    domain: 'meta-permission',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: true,
    privileged: true,
    remoteCode: false,
    description: '读取 capability 签名私钥',
  },
  'agent.create': {
    domain: 'product',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: true,
    privileged: false,
    remoteCode: false,
    description: '创建持久化 Agent 定义',
  },
  'product.agent_catalog.write': {
    domain: 'product',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: true,
    privileged: false,
    remoteCode: false,
    description: '写入产品 Agent catalog',
  },
  'product.agent_prompt.persist': {
    domain: 'product',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: true,
    privileged: false,
    remoteCode: false,
    description: '持久化 Agent prompt 定义',
  },
  'product.agent_runtime_binding.persist': {
    domain: 'product',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: true,
    privileged: false,
    remoteCode: false,
    description: '持久化 Agent runtime tool 绑定',
  },
  'product.agent_skill_labels.persist': {
    domain: 'product',
    defaultStrictness: STRICTNESS.ASK,
    sensitive: true,
    privileged: false,
    remoteCode: false,
    description: '持久化 Agent skill 标签',
  },
  'unknown.host_effect': {
    domain: 'unknown',
    defaultStrictness: STRICTNESS.DENY,
    sensitive: false,
    privileged: false,
    remoteCode: false,
    description: '无法归类的 host 副作用',
  },
});

export const KNOWN_ACTIONS = Object.freeze(Object.keys(ACTION_TAXONOMY));

export function isKnownAction(action) {
  return typeof action === 'string' && Object.prototype.hasOwnProperty.call(ACTION_TAXONOMY, action);
}

/**
 * 稳定 reason code —— 审批事件、审计、测试与 LLM 总结消费 code，
 * 中文 message 只是展示兜底（可随语言/措辞调整而不破坏契约）。
 */
export const SEMANTIC_OPERATION_REASON_CODES = Object.freeze({
  UNKNOWN_ACTION: 'unknown_action',
  UNKNOWN_HOST_EFFECT: 'unknown_host_effect',
  UNKNOWN_TARGET: 'unknown_target',
  DYNAMIC_TARGET: 'dynamic_target',
  INTERPRETER_NESTED: 'interpreter_nested',
  REMOTE_CODE_EXECUTE: 'remote_code_execute',
  DOWNLOAD_AND_EXECUTE: 'download_and_execute',
  PRIVILEGE_ELEVATE: 'privilege_elevate',
  CREDENTIAL_ACCESS: 'credential_access',
  CREDENTIAL_WRITE: 'credential_write',
  SYSTEM_PATH_WRITE: 'system_path_write',
  RECURSIVE_DELETE: 'recursive_delete',
  SENSITIVE_TARGET: 'sensitive_target',
  SELF_PROTECTION_BOUNDARY: 'self_protection_boundary',
  SELF_PROTECTION_UNAVAILABLE: 'self_protection_unavailable',
  SCOPE_NOT_COMPUTED: 'scope_not_computed',
  SCOPE_UNREADABLE: 'scope_unreadable',
  VERSION_MISMATCH: 'version_mismatch',
  REVALIDATION_REQUIRED: 'revalidation_required',
  MANIFEST_HASH_REQUIRED: 'manifest_hash_required',
  ORDINARY_OPERATION: 'ordinary_operation',
  PROJECT_GENERATED: 'project_generated',
  EFFECT_STRICTNESS_RAISE: 'effect_strictness_raise',
  GIT_REMOTE_WRITE: 'git_remote_write',
  NETWORK_EGRESS: 'network_egress',
  FIREWALL_MODIFY: 'firewall_modify',
  FIREWALL_RULE_MODIFY: 'firewall_rule_modify',
  FIREWALL_DISABLE: 'firewall_disable',
  ANTIVIRUS_EXCLUSION_ADD: 'antivirus_exclusion_add',
  ANTIVIRUS_DISABLE: 'antivirus_disable',
  AUDIT_CONFIG_MODIFY: 'audit_config_modify',
  AUDIT_DISABLE: 'audit_disable',
  PACKAGE_SOURCE_MODIFY: 'package_source_modify',
  SERVICE_MODIFY: 'service_modify',
  PACKAGE_REMOVE: 'package_remove',
  ENV_INJECTION: 'env_injection',
  PATH_HIJACK: 'path_hijack',
  MULTI_TARGET: 'multi_target',
  REFUSAL_NEVER_ALLOW: 'refusal_never_allow',
  META_PERMISSION: 'meta_permission',
  CAPABILITY_FORGE: 'capability_forge',
  APPROVAL_BYPASS: 'approval_bypass',
  AUDIT_TAMPER: 'audit_tamper',
  EXECUTOR_BYPASS: 'executor_bypass',
  SIGNING_KEY_READ: 'signing_key_read',
});

// code → 中文默认文案（展示兜底；正式消费方请用 code）。
export const SEMANTIC_OPERATION_REASON_MESSAGES = Object.freeze({
  [SEMANTIC_OPERATION_REASON_CODES.UNKNOWN_ACTION]: '未知的语义操作 action，拒绝',
  [SEMANTIC_OPERATION_REASON_CODES.UNKNOWN_HOST_EFFECT]: '无法归类的 host 副作用，拒绝',
  [SEMANTIC_OPERATION_REASON_CODES.UNKNOWN_TARGET]: '无法确定操作 target',
  [SEMANTIC_OPERATION_REASON_CODES.DYNAMIC_TARGET]: 'target 由变量/命令替换动态决定，静态无法复验',
  [SEMANTIC_OPERATION_REASON_CODES.INTERPRETER_NESTED]: '嵌套解释器执行，语义不完整，按 refusal 处理',
  [SEMANTIC_OPERATION_REASON_CODES.REMOTE_CODE_EXECUTE]: '远程代码执行，内容未固定',
  [SEMANTIC_OPERATION_REASON_CODES.DOWNLOAD_AND_EXECUTE]: '下载后直接执行',
  [SEMANTIC_OPERATION_REASON_CODES.PRIVILEGE_ELEVATE]: '权限提升',
  [SEMANTIC_OPERATION_REASON_CODES.CREDENTIAL_ACCESS]: '访问凭据',
  [SEMANTIC_OPERATION_REASON_CODES.CREDENTIAL_WRITE]: '写入凭据',
  [SEMANTIC_OPERATION_REASON_CODES.SYSTEM_PATH_WRITE]: '系统路径写入',
  [SEMANTIC_OPERATION_REASON_CODES.RECURSIVE_DELETE]: '递归删除',
  [SEMANTIC_OPERATION_REASON_CODES.SENSITIVE_TARGET]: '目标包含敏感材料',
  [SEMANTIC_OPERATION_REASON_CODES.SELF_PROTECTION_BOUNDARY]: '目标属于 Ragent 服务自保护边界，禁止直接修改',
  [SEMANTIC_OPERATION_REASON_CODES.SELF_PROTECTION_UNAVAILABLE]: '无法计算 Ragent 服务自保护边界，禁止写入',
  [SEMANTIC_OPERATION_REASON_CODES.SCOPE_NOT_COMPUTED]: 'scope 未由服务端计算，不得参与 allow',
  [SEMANTIC_OPERATION_REASON_CODES.SCOPE_UNREADABLE]: '无法遍历目标树',
  [SEMANTIC_OPERATION_REASON_CODES.VERSION_MISMATCH]: '语义操作/策略版本不兼容',
  [SEMANTIC_OPERATION_REASON_CODES.REVALIDATION_REQUIRED]: '执行前必须重新验证资源',
  [SEMANTIC_OPERATION_REASON_CODES.MANIFEST_HASH_REQUIRED]: '缺少 canonical manifest hash',
  [SEMANTIC_OPERATION_REASON_CODES.ORDINARY_OPERATION]: '常规操作',
  [SEMANTIC_OPERATION_REASON_CODES.PROJECT_GENERATED]: '项目生成物操作',
  [SEMANTIC_OPERATION_REASON_CODES.EFFECT_STRICTNESS_RAISE]: '副作用抬升整体严格度',
  [SEMANTIC_OPERATION_REASON_CODES.GIT_REMOTE_WRITE]: 'git 远程写入',
  [SEMANTIC_OPERATION_REASON_CODES.NETWORK_EGRESS]: '网络出站',
  [SEMANTIC_OPERATION_REASON_CODES.FIREWALL_MODIFY]: '防火墙规则修改',
  [SEMANTIC_OPERATION_REASON_CODES.FIREWALL_RULE_MODIFY]: '结构化防火墙规则修改',
  [SEMANTIC_OPERATION_REASON_CODES.FIREWALL_DISABLE]: '停用防火墙',
  [SEMANTIC_OPERATION_REASON_CODES.ANTIVIRUS_EXCLUSION_ADD]: '添加杀毒软件排除项',
  [SEMANTIC_OPERATION_REASON_CODES.ANTIVIRUS_DISABLE]: '停用杀毒软件',
  [SEMANTIC_OPERATION_REASON_CODES.AUDIT_CONFIG_MODIFY]: '修改审计配置',
  [SEMANTIC_OPERATION_REASON_CODES.AUDIT_DISABLE]: '停用审计',
  [SEMANTIC_OPERATION_REASON_CODES.PACKAGE_SOURCE_MODIFY]: '软件源/仓库配置修改',
  [SEMANTIC_OPERATION_REASON_CODES.SERVICE_MODIFY]: '服务定义/单元文件修改',
  [SEMANTIC_OPERATION_REASON_CODES.PACKAGE_REMOVE]: '软件包移除',
  [SEMANTIC_OPERATION_REASON_CODES.ENV_INJECTION]: '环境变量/预加载注入',
  [SEMANTIC_OPERATION_REASON_CODES.PATH_HIJACK]: 'PATH 劫持',
  [SEMANTIC_OPERATION_REASON_CODES.MULTI_TARGET]: '批量/多目标操作',
  [SEMANTIC_OPERATION_REASON_CODES.REFUSAL_NEVER_ALLOW]: 'refusal 操作不得默认 allow',
  [SEMANTIC_OPERATION_REASON_CODES.META_PERMISSION]: '权限系统自身的保护操作',
  [SEMANTIC_OPERATION_REASON_CODES.CAPABILITY_FORGE]: '伪造或篡改 capability',
  [SEMANTIC_OPERATION_REASON_CODES.APPROVAL_BYPASS]: '绕过审批流程',
  [SEMANTIC_OPERATION_REASON_CODES.AUDIT_TAMPER]: '篡改审计记录',
  [SEMANTIC_OPERATION_REASON_CODES.EXECUTOR_BYPASS]: '绕过受控执行器',
  [SEMANTIC_OPERATION_REASON_CODES.SIGNING_KEY_READ]: '读取 capability 签名私钥',
});

export function reasonMessage(code) {
  return SEMANTIC_OPERATION_REASON_MESSAGES[code] || code;
}

// --- strictness 聚合 ---

/** 决策名 → 数值严格度；UNKNOWN 按 DENY（不确定性不降低严格度）。 */
export function strictnessForDecision(decision) {
  if (decision === 'ALLOW') return STRICTNESS.ALLOW;
  if (decision === 'ASK') return STRICTNESS.ASK;
  return STRICTNESS.DENY;
}

/** 数值严格度 → 决策名（>ASK 一律 DENY）。 */
export function decisionFromStrictness(value) {
  if (value <= STRICTNESS.ALLOW) return 'ALLOW';
  if (value <= STRICTNESS.ASK) return 'ASK';
  return 'DENY';
}

/** 聚合一组数值严格度：max。空集返回 ALLOW 恒等值（无操作即无授权含义）。 */
export function aggregateStrictness(values) {
  const nums = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  return nums.length > 0 ? Math.max(...nums) : STRICTNESS.ALLOW;
}

/** 聚合一组决策名：DENY > ASK > ALLOW（UNKNOWN 计入 DENY）。 */
export function aggregateDecisions(decisions) {
  return decisionFromStrictness(aggregateStrictness((decisions || []).map(strictnessForDecision)));
}

/** 单个操作的默认严格度：primaryAction 与所有 effects 的 taxonomy 默认值取 max。 */
export function operationActionStrictness(op) {
  const actions = [
    op && op.primaryAction,
    ...(op && Array.isArray(op.effects) ? op.effects : []),
  ].filter(isKnownAction);
  return aggregateStrictness(actions.map((a) => ACTION_TAXONOMY[a].defaultStrictness));
}

/**
 * 一组操作 → 整体严格度（数值）。优先使用 op.decision（corpus/策略产物），
 * 否则回退到 action taxonomy 默认严格度聚合。
 */
export function setStrictness(operations) {
  const ops = Array.isArray(operations) ? operations : [];
  return aggregateStrictness(ops.map((op) => (
    op && Object.prototype.hasOwnProperty.call(op, 'decision')
      ? strictnessForDecision(op.decision)
      : operationActionStrictness(op)
  )));
}

// --- refusal / allow 资格 ---

/**
 * 是否属于 refusal：语义不完整或不可复验的操作。
 * 命中以下任一即 refusal，绝不参与 allow：
 *   - analysis.confidence === 'unknown' or 'low'；
 *   - analysis.unknowns 非空；
 *   - primaryAction/effects 含 unknown.host_effect；
 *   - target.kind === 'unknown'。
 */
export function isRefusal(op) {
  if (!op || typeof op !== 'object') return true;
  if (op.analysis && ['unknown', 'low'].includes(op.analysis.confidence)) return true;
  if (op.analysis && op.analysis.unknowns !== undefined
    && (!Array.isArray(op.analysis.unknowns) || op.analysis.unknowns.length > 0)) return true;
  const actions = [op.primaryAction, ...(Array.isArray(op.effects) ? op.effects : [])];
  if (actions.includes('unknown.host_effect')) return true;
  if (op.target && op.target.kind === 'unknown') return true;
  return false;
}

/** 是否可参与 allow：非 refusal 且 scope 已由服务端计算（computed === true）。 */
export function allowEligible(op) {
  if (!op || typeof op !== 'object') return false;
  if (isRefusal(op)) return false;
  return Boolean(op.scope && op.scope.computed === true);
}

/**
 * 无策略上下文时的默认决策下限（纯函数，供 shadow 对照与测试）：
 *   - refusal → DENY；
 *   - scope.computed !== true → UNKNOWN（不得 allow）；
 *   - 否则按 action taxonomy 默认严格度聚合。
 */
export function defaultDecision(op) {
  if (isRefusal(op)) return 'DENY';
  if (!op || !op.scope || op.scope.computed !== true) return 'UNKNOWN';
  return decisionFromStrictness(operationActionStrictness(op));
}

// --- 结构校验 ---

const REQUEST_BINDING_FIELDS = ['sessionId', 'runId', 'turnId', 'requestKey'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 校验 SemanticOperation 描述符（含 corpus 条目形态）。
 *
 * 必填：schemaVersion / operationId / requestBinding{sessionId,runId,turnId,requestKey}
 *      / primaryAction / effects[] / executionClass / target{kind,platform}
 *      / scope{computed} / impact / source{rawRequestHash,commandForm}
 *      / analysis{confidence,policyVersion,compilerVersion}
 * 校验规则：
 *   - 未知 action（primary 或 effect）→ 拒绝；
 *   - scope.computed !== true 时 decision 不得为 ALLOW；
 *   - refusal 操作（confidence=unknown / unknown.host_effect / target.kind=unknown）
 *     的 decision 不得为 ALLOW；
 *   - expectedSemantic 若存在，必须与顶层 primaryAction/effects 一致；
 *   - decision 必须是 ALLOW/ASK/DENY/UNKNOWN 之一。
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateSemanticOperation(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['operation must be a plain object'] };
  }

  if (obj.schemaVersion !== SEMANTIC_OPERATION_VERSION) {
    errors.push(`schemaVersion must be "${SEMANTIC_OPERATION_VERSION}"`);
  }
  if (!isNonEmptyString(obj.operationId)) {
    errors.push('operationId must be a non-empty string');
  }
  if (obj.requestBinding === null || typeof obj.requestBinding !== 'object') {
    errors.push('requestBinding must be an object');
  } else {
    for (const field of REQUEST_BINDING_FIELDS) {
      if (!isNonEmptyString(obj.requestBinding[field])) {
        errors.push(`requestBinding.${field} must be a non-empty string`);
      }
    }
  }
  if (!isNonEmptyString(obj.primaryAction)) {
    errors.push('primaryAction must be a non-empty string');
  } else if (!isKnownAction(obj.primaryAction)) {
    errors.push(`unknown primaryAction "${obj.primaryAction}"`);
  }
  if (!Array.isArray(obj.effects)) {
    errors.push('effects must be an array');
  } else {
    for (const effect of obj.effects) {
      if (!isKnownAction(effect)) {
        errors.push(`unknown effect "${effect}"`);
      }
    }
  }
  if (!isNonEmptyString(obj.executionClass)) {
    errors.push('executionClass must be a non-empty string');
  }
  if (obj.target === null || typeof obj.target !== 'object') {
    errors.push('target must be an object');
  } else {
    if (!isNonEmptyString(obj.target.kind)) errors.push('target.kind must be a non-empty string');
    if (!isNonEmptyString(obj.target.platform)) errors.push('target.platform must be a non-empty string');
  }
  if (obj.scope === null || typeof obj.scope !== 'object') {
    errors.push('scope must be an object');
  } else {
    if (typeof obj.scope.computed !== 'boolean') errors.push('scope.computed must be a boolean');
    if (!isNonEmptyString(obj.scope.kind)) errors.push('scope.kind must be a non-empty string');
  }
  if (obj.impact === null || typeof obj.impact !== 'object' || Array.isArray(obj.impact)) {
    errors.push('impact must be an object');
  } else if (obj.impact.estimatedItems !== undefined && typeof obj.impact.estimatedItems !== 'number') {
    errors.push('impact.estimatedItems must be a number');
  }
  if (obj.source === null || typeof obj.source !== 'object') {
    errors.push('source must be an object');
  } else {
    if (!isNonEmptyString(obj.source.rawRequestHash)) {
      errors.push('source.rawRequestHash must be a non-empty string');
    } else if (obj.source.rawRequestHash.startsWith('sha256:')
      && !/^sha256:[0-9a-f]{64}$/.test(obj.source.rawRequestHash)) {
      errors.push('source.rawRequestHash must match sha256:<64 hex>');
    }
    if (!isNonEmptyString(obj.source.commandForm)) {
      errors.push('source.commandForm must be a non-empty string');
    }
  }
  if (obj.analysis === null || typeof obj.analysis !== 'object') {
    errors.push('analysis must be an object');
  } else {
    if (!CONFIDENCE_LEVELS.includes(obj.analysis.confidence)) {
      errors.push(`analysis.confidence must be one of ${CONFIDENCE_LEVELS.join('/')}`);
    }
    if (!Array.isArray(obj.analysis.unknowns)) {
      errors.push('analysis.unknowns must be an array');
    }
    if (!isNonEmptyString(obj.analysis.policyVersion)) {
      errors.push('analysis.policyVersion must be a non-empty string');
    }
    if (!isNonEmptyString(obj.analysis.compilerVersion)) {
      errors.push('analysis.compilerVersion must be a non-empty string');
    }
  }

  // corpus 形态的可选字段（存在即校验）。
  if (obj.expectedSemantic !== undefined) {
    if (obj.expectedSemantic === null || typeof obj.expectedSemantic !== 'object') {
      errors.push('expectedSemantic must be an object');
    } else {
      if (obj.expectedSemantic.primaryAction !== obj.primaryAction) {
        errors.push('expectedSemantic.primaryAction must match primaryAction');
      }
      if (JSON.stringify(obj.expectedSemantic.effects || []) !== JSON.stringify(obj.effects || [])) {
        errors.push('expectedSemantic.effects must match effects');
      }
    }
  }
  if (obj.decision !== undefined && !DECISIONS.includes(obj.decision)) {
    errors.push(`invalid decision "${obj.decision}"`);
  }
  if (obj.decision === 'ALLOW') {
    if (!(obj.scope && obj.scope.computed === true)) {
      errors.push('decision ALLOW requires scope.computed === true');
    }
    if (isRefusal(obj)) {
      errors.push('refusal operation cannot have decision ALLOW');
    }
  }
  for (const flag of ['sensitive', 'generated', 'privileged']) {
    if (obj[flag] !== undefined && typeof obj[flag] !== 'boolean') {
      errors.push(`${flag} must be a boolean`);
    }
  }
  if (obj.id !== undefined && !isNonEmptyString(obj.id)) {
    errors.push('id must be a non-empty string');
  }

  return { ok: errors.length === 0, errors };
}

// --- canonical manifest ---

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/** 深度 key 排序后的确定性 JSON 字符串（数组保持原顺序）。 */
export function canonicalSemanticJson(op) {
  return JSON.stringify(sortKeysDeep(op));
}

/** sha256 hex。 */
export function sha256Hex(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

/** SemanticOperation → canonical manifest hash（sha256 hex，确定性）。 */
export function computeSemanticManifestHash(op) {
  return sha256Hex(canonicalSemanticJson(op));
}
