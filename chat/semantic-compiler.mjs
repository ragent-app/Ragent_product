/**
 * chat/semantic-compiler.mjs — Shadow semantic compiler（Phase 1，纯函数，无 I/O）。
 *
 * 输入：{ request }；request 至少含 rawCommand（+ 可选 binding/上下文）。
 *       语法事实一律由 rawCommand 在服务端现场重建；不会信任外部注入的 parserFacts。
 * 输出：{ operations, refusals, strictness, compilerVersion, source, unknowns, confidence }。
 *
 * 规则（notes/directional/semantic-operation-policy-architecture-2026-08-10.md
 * §6.3 / §13 Phase 1 / §15.2）：
 *   - 一个请求多个 resource mutation → 拆成多个 operation；
 *   - primaryAction 与全部 effects 进入集合，任何 effect 都不得被丢弃；
 *   - 嵌套 shell / 解释器代码 / 命令替换 / 下载后执行 / 动态 argv →
 *     refusal（confidence=unknown）或带 unknown 标记，绝不产生可执行 allow 操作；
 *   - 不读磁盘、不调用 git、不访问网络 —— 纯函数，可被 fixture 全量测试；
 *   - 输出带 compilerVersion、evidence、source.rawRequestHash；
 *   - scope.computed 一律为 false：scope 只能由服务端 resolver 计算（本模块不设权限）。
 *
 * 本模块不执行命令、不签发授权、不改变任何现有 gate/approval/execution 路径。
 */

import { parseCommandFacts } from './command-parser.mjs';
import { mapFactsToCandidates } from './semantic-parsers/linux-command.mjs';
import { mapDarwinFactsToCandidates } from './semantic-parsers/darwin-command.mjs';
import {
  mapPowerShellFactsToCandidates,
  parsePowerShellCommandFacts,
} from './semantic-parsers/powershell-command.mjs';
import {
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  STRICTNESS,
  isRefusal,
  operationActionStrictness,
  sha256Hex,
  validateSemanticOperation,
} from './semantic-operation.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function dedupe(values) {
  return [...new Set(Array.isArray(values) ? values : [])];
}

function makeOperationId(rawCommand, index) {
  return `sop_${sha256Hex(`${rawCommand}\u0000${index}`).slice(0, 24)}`;
}

function makeRequestBinding(request) {
  const fallback = (value, name) => (isNonEmptyString(value) ? value : name);
  return {
    sessionId: fallback(request.sessionId, 'unknown'),
    runId: fallback(request.runId, 'unknown'),
    turnId: fallback(request.turnId, 'unknown'),
    requestKey: fallback(request.requestKey, 'unknown'),
    provider: fallback(request.provider, 'unknown'),
    runtimeFamily: fallback(request.runtimeFamily, 'unknown'),
  };
}

function trustedCompilerContext(context) {
  const value = context && typeof context === 'object' ? context : {};
  return {
    cwd: isNonEmptyString(value.cwd) ? value.cwd : '',
    projectRoot: isNonEmptyString(value.projectRoot) ? value.projectRoot : '',
    home: isNonEmptyString(value.home) ? value.home : '',
    // A missing trusted platform must not silently acquire Linux semantics.
    platform: isNonEmptyString(value.platform) ? value.platform : 'unknown',
  };
}

function buildOperation(candidate, { request, binding, rawCommand, rawRequestHash, index, platform }) {
  const evidence = dedupe(candidate.evidence || []);
  const operation = {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: makeOperationId(rawCommand, index),
    requestBinding: binding,
    primaryAction: candidate.primaryAction,
    effects: dedupe(candidate.effects || []),
    executionClass: request.executionClass || 'session',
    // Platform is a trusted runtime fact. Parser candidates cannot override it.
    target: { ...(candidate.target || {}), platform },
    scope: { computed: false, kind: 'unresolved' },
    impact: {
      containsTrackedFiles: false,
      containsModifiedFiles: false,
      containsSensitiveMaterial: false,
      reversible: false,
    },
    source: {
      tool: request.tool || 'bash',
      rawRequestHash,
      commandForm: request.commandForm || 'argv',
      evidence,
    },
    analysis: {
      confidence: candidate.confidence,
      unknowns: dedupe(candidate.unknowns || []),
      // This flag is emitted only by the server-side parser adapters after
      // they have enumerated every known effect and found no unknown syntax.
      // Resolver facts and policy may still deny the operation later.
      effectsComplete: candidate.effectsComplete === true,
      policyVersion: SEMANTIC_POLICY_VERSION,
      compilerVersion: SEMANTIC_COMPILER_VERSION,
      reasons: candidate.reasons || [],
    },
  };
  if (Number.isFinite(candidate.estimatedItems)) {
    operation.impact.estimatedItems = candidate.estimatedItems;
  }
  return operation;
}

/**
 * 纯函数：语义编译。不做任何 I/O；scope 不计算；refusal 绝不参与 allow。
 *
 * @param {object} input
 * @param {object} input.request 至少含 rawCommand；可选 sessionId/runId/turnId/
 *   requestKey/provider/runtimeFamily/tool/commandForm/executionClass。request 中的 cwd /
 *   projectRoot / home 均是上游 evidence，不能参与 target 计算。
 * @param {object} [input.trustedContext] 仅由服务端 ExecutionScope/run manifest 注入的
 *   { cwd, projectRoot, home }；相对 path 只允许基于此上下文归一化。
 * @param {object} [input.parserFacts] 已废弃且刻意忽略。保留形状仅避免 Phase 1
 *   shadow 调用方因参数存在而崩溃；它绝不能覆盖 rawCommand 的服务端解析。
 * @returns {{operations:object[], refusals:object[], strictness:number,
 *            compilerVersion:string, source:object, unknowns:string[], confidence:string}}
 */
export function compileSemanticOperations({ request = {}, parserFacts, trustedContext } = {}) {
  const rawCommand = typeof request.rawCommand === 'string' ? request.rawCommand.trim() : '';
  if (!rawCommand) {
    return {
      compilerVersion: SEMANTIC_COMPILER_VERSION,
      operations: [],
      refusals: [],
      strictness: STRICTNESS.ALLOW,
      source: {
        tool: request.tool || 'bash',
        commandForm: request.commandForm || 'argv',
        rawRequestHash: `sha256:${sha256Hex('')}`,
        command: '',
      },
      unknowns: [],
      confidence: 'high',
    };
  }
  const { cwd, projectRoot, home, platform } = trustedCompilerContext(trustedContext);
  // parserFacts 可能来自 provider/agent 或过期缓存。即使其 command 字段看似匹配，
  // 也不能把它当成 rawCommand 的真实性证明；统一从绑定的原始请求重建。
  void parserFacts;
  const facts = platform === 'win32'
    ? parsePowerShellCommandFacts(rawCommand)
    : parseCommandFacts(rawCommand, { cwd, projectRoot, home });
  const mapped = platform === 'linux'
    ? mapFactsToCandidates(facts, { cwd, projectRoot, home })
    : platform === 'win32'
      ? mapPowerShellFactsToCandidates(facts, { cwd, projectRoot, home })
      : platform === 'darwin'
        ? mapDarwinFactsToCandidates(facts)
        : {
        candidates: [{
          primaryAction: 'unknown.host_effect',
          effects: [],
          confidence: 'unknown',
          target: { kind: 'unknown' },
          evidence: ['platform:unsupported', `platform:${platform}`],
          reasons: [],
          unknowns: ['platform:unsupported'],
        }],
        unknowns: ['platform:unsupported'],
        confidence: 'unknown',
      };
  const rawRequestHash = `sha256:${sha256Hex(rawCommand)}`;
  const binding = makeRequestBinding(request);

  const operations = mapped.candidates.map((candidate, index) => (
    buildOperation(candidate, { request, binding, rawCommand, rawRequestHash, index, platform })
  ));

  for (const op of operations) {
    const validation = validateSemanticOperation(op);
    if (!validation.ok) {
      throw new Error(`semantic-compiler produced invalid operation: ${validation.errors.join('; ')}`);
    }
  }

  const refusals = operations.filter((op) => isRefusal(op));
  const strictness = operations.length
    ? Math.max(...operations.map((op) => (
      isRefusal(op) ? STRICTNESS.DENY : operationActionStrictness(op)
    )))
    : STRICTNESS.ALLOW;

  return {
    compilerVersion: SEMANTIC_COMPILER_VERSION,
    operations,
    refusals,
    strictness,
    source: {
      tool: request.tool || 'bash',
      commandForm: request.commandForm || 'argv',
      rawRequestHash,
      command: rawCommand,
    },
    unknowns: mapped.unknowns,
    confidence: mapped.confidence,
  };
}
