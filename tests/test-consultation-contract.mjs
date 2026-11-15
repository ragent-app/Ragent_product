#!/usr/bin/env node
// P0-2 契约测试:断言 Consultation V1 冻结契约 C1–C6 的冻结语义
// (docs/consultation-v1-implementation-plan-2026-08-14.md §3/§6)。
//
// TDD 契约优先:当前实现尚未点亮这些契约,因此本测试是「可运行的缺口清单」。
// 每个契约项下的每个 check 输出一行 PASS 或 GAP(带具体缺什么);
// 最后打印 `=== Consultation V1 契约缺口清单 ===` 汇总未满足项。
// 存在任何 GAP 时 exit 1(P0 预期红,输出缺口清单即验收通过);P1–P6 逐步点亮后应全绿 exit 0。
//
// 约定:对可能尚不存在的模块(chat/consultation-store.mjs、consultation-compiler-gate.mjs)
// 使用动态 import + try/catch,模块缺失时该契约项记为 GAP,而不是让整个测试 crash。
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-contract-'));

// 隔离临时 HOME / CONFIG_DIR —— 必须在 import 任何被测模块之前设置。
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;

assert.ok(process.env.RAGENT_CONFIG_DIR.startsWith(tempHome), 'RAGENT_CONFIG_DIR 必须隔离到临时目录');

// ── 记录器 ──────────────────────────────────────────────────────────────────
const results = [];
let passCount = 0;
let gapCount = 0;

function record(contract, check, pass, detail = '') {
  const line = `${pass ? 'PASS' : 'GAP'}  [${contract}] ${check}${pass ? '' : ` — ${detail}`}`;
  results.push({ contract, check, pass, detail });
  if (pass) passCount += 1;
  else gapCount += 1;
  console.log(line);
}

// ── 工具 ────────────────────────────────────────────────────────────────────
async function tryImport(specifier) {
  try {
    return { ok: true, mod: await import(specifier) };
  } catch {
    return { ok: false, mod: null };
  }
}

function readSource(relative) {
  try {
    return readFileSync(join(repoRoot, relative), 'utf8');
  } catch {
    return '';
  }
}

// 错误码可在本模块内联定义(仓库现状:无集中目录),也可在未来放入 lib/errors.mjs。
function codeExists(code, ...relPaths) {
  return relPaths.some((rel) => readSource(rel).includes(code));
}

// ── 被测模块(动态 import,守护式) ─────────────────────────────────────────────
const managedInput = await tryImport('../chat/managed-input.mjs');
const resultPackets = await tryImport('../chat/result-packets.mjs');
const collabStore = await tryImport('../chat/collaboration-store.mjs');
const governor = await tryImport('../chat/organization-governor.mjs');
// 可能尚不存在的模块 —— 缺失时对应契约项记为 GAP。
const consultationStore = await tryImport('../chat/consultation-store.mjs');
const compilerGate = await tryImport('../chat/consultation-compiler-gate.mjs');

// ── C1 Managed Scope 二态 ───────────────────────────────────────────────────
console.log('\n[C1] Managed Scope 二态线谱');
{
  const source = readSource('chat/managed-input.mjs');
  const mod = managedInput.mod;
  record('C1', 'managed-input.mjs 模块存在', managedInput.ok, 'chat/managed-input.mjs 缺失');

  // C1-2: managedScope 二态 'organization' | 'consultation'
  const scopeTwoState = /managedScope/.test(source)
    && (mod?.MANAGED_SCOPES?.includes?.('consultation') || /['"`]consultation['"`]/.test(source));
  record('C1', "managedScope 二态支持 'organization' | 'consultation'", !!scopeTwoState,
    scopeTwoState ? '' : 'managed-input.mjs 无 managedScope 概念或未枚举 consultation 值');

  // C1-3: consultation scope lineage 校验(不要求 node/role/revision)
  const consultLineage = /consultationRoundId/.test(source) && /expertAssignmentId/.test(source);
  record('C1', 'consultation scope lineage 校验 rootSessionId + consultationRoundId + expertAssignmentId + controllerSessionId(不要求 node/role/revision)', consultLineage,
    consultLineage ? '' : 'assertManagedSessionLineage 无 consultation 分支,仍只走 org 的 node/role/revision 校验');

  // C1-4: 错误码 CONSULTATION_LINEAGE_INCOMPLETE
  const hasLineageCode = codeExists('CONSULTATION_LINEAGE_INCOMPLETE', 'chat/managed-input.mjs')
    || mod?.CONSULTATION_LINEAGE_INCOMPLETE === 'CONSULTATION_LINEAGE_INCOMPLETE';
  record('C1', '错误码 CONSULTATION_LINEAGE_INCOMPLETE 存在', !!hasLineageCode,
    hasLineageCode ? '' : '当前仅存在 MANAGED_SESSION_LINEAGE_INCOMPLETE,无 CONSULTATION_LINEAGE_INCOMPLETE');

  // C1-5: 咨询专家会话仍 sessionPlane==='organization'(WORKER 受管类强制受管平面)
  let managedPlaneEnforced = false;
  try {
    const cls = mod?.resolveSessionClass({ sessionPlane: 'organization', sessionClass: 'WORKER' });
    let rejectsUserPlane = false;
    try {
      mod?.resolveSessionClass({ sessionPlane: 'user', sessionClass: 'WORKER' });
    } catch {
      rejectsUserPlane = true;
    }
    managedPlaneEnforced = cls === 'WORKER' && rejectsUserPlane;
  } catch {}
  record('C1', "咨询专家会话仍 sessionPlane==='organization'(WORKER 受管类强制 organization 平面)", managedPlaneEnforced,
    managedPlaneEnforced ? '' : '受管类未强制 organization 平面,consultation 专家无法保持受管平面');
}

// ── C2 Budget Governor scope 泛化 ───────────────────────────────────────────
console.log('\n[C2] Budget Governor scope 泛化');
{
  const source = readSource('chat/organization-governor.mjs');
  const mod = governor.mod;
  const govExists = governor.ok && source.length > 0;
  record('C2', 'organization-governor.mjs 模块存在', govExists, 'chat/organization-governor.mjs 缺失');

  if (govExists) {
    // C2-2: org:<organizationId>:<revision>
    const orgScopeKey = /['"`]org:/.test(source);
    record('C2', 'scope key 编码 org:<organizationId>:<revision>', orgScopeKey,
      orgScopeKey ? '' : '账本仍按 (organization_id, revision) 列直接寻址,无 org: 前缀 scope key 编码');

    // C2-3: consult:<roundId>
    const consultScopeKey = /['"`]consult:/.test(source);
    record('C2', 'scope key 编码 consult:<roundId>', consultScopeKey,
      consultScopeKey ? '' : '无 consult: 前缀的 consultation scope 账本');

    // C2-4: CONSULTATION_BUDGET_EXCEEDED
    const hasConsultBudgetCode = codeExists('CONSULTATION_BUDGET_EXCEEDED', 'chat/organization-governor.mjs');
    record('C2', '错误码 CONSULTATION_BUDGET_EXCEEDED 存在', hasConsultBudgetCode,
      hasConsultBudgetCode ? '' : '仅存在 ORG_BUDGET_EXCEEDED,无 consultation scope 超限码');

    // C2-5: org scope 行为不变
    const orgCode = mod?.ORG_BUDGET_EXCEEDED === 'ORG_BUDGET_EXCEEDED';
    const orgFns = ['getBudgetCounter', 'reserveOrganizationBudget', 'settleOrganizationBudget', 'releaseOrganizationBudgetReservation']
      .every((fn) => typeof mod?.[fn] === 'function');
    const orgTableIntact = /PRIMARY KEY \(organization_id, revision\)/.test(source);
    record('C2', 'org scope 行为不变(ORG_BUDGET_EXCEEDED 409 + org 账本结构保持)', orgCode && orgFns && orgTableIntact,
      orgCode && orgFns && orgTableIntact ? '' : 'org 账本/函数/超限码被改动');

    // C2-6: reservation→usage 结算→超时释放 lifecycle(org scope 入口)
    const orgLifecycle = ['reserveOrganizationBudget', 'settleOrganizationBudget', 'releaseOrganizationBudgetReservation', 'releaseExpiredOrganizationBudgetReservations']
      .every((fn) => typeof mod?.[fn] === 'function');
    record('C2', 'reservation→usage 结算→超时释放 lifecycle(org scope 入口存在)', orgLifecycle,
      orgLifecycle ? '' : 'org reservation/settle/release 入口缺失');

    // C2-7: consultation scope 生命周期入口
    const consultLifecycle = /reserveConsultation|settleConsultation|releaseConsultation|ConsultationBudget|consultScope/i.test(source);
    record('C2', 'consultation scope reservation/settle/release/对账入口存在', consultLifecycle,
      consultLifecycle ? '' : '无 consultation scope 的 reservation/settlement/release 入口');

    // C2-8: 崩溃恢复对账挂载(启动 reconcile 未结算 consultation reservation)
    const reconcilerSource = readSource('chat/organization-reconciler.mjs');
    const consultReconcile = /consult/i.test(reconcilerSource) || /reconcileConsultation/i.test(source);
    record('C2', '崩溃恢复对账(启动 reconcile 未结算 consultation reservation)', consultReconcile,
      consultReconcile ? '' : 'organization-reconciler 未挂载 consultation reservation 对账');
  } else {
    for (const [check, detail] of [
      ['scope key 编码 org:<organizationId>:<revision>', '模块缺失'],
      ['scope key 编码 consult:<roundId>', '模块缺失'],
      ['错误码 CONSULTATION_BUDGET_EXCEEDED 存在', '模块缺失'],
      ['org scope 行为不变(ORG_BUDGET_EXCEEDED 409 + org 账本结构保持)', '模块缺失'],
      ['reservation→usage 结算→超时释放 lifecycle(org scope 入口存在)', '模块缺失'],
      ['consultation scope reservation/settle/release/对账入口存在', '模块缺失'],
      ['崩溃恢复对账(启动 reconcile 未结算 consultation reservation)', '模块缺失'],
    ]) {
      record('C2', check, false, detail);
    }
  }
}

// ── C3 Task 完整只读契约持久化 ──────────────────────────────────────────────
console.log('\n[C3] Task 完整只读契约持久化');
{
  // 运行期 PRAGMA:真实读取 collaboration_tasks 当前 schema(含迁移)。
  let taskColumns = new Set();
  if (collabStore.ok) {
    try {
      const db = collabStore.mod.openDatabase();
      taskColumns = new Set(db.prepare('PRAGMA table_info(collaboration_tasks)').all().map((c) => c.name));
      db.close();
    } catch {
      taskColumns = new Set();
    }
  }

  // C3-1..C3-6: 六列契约持久化
  for (const column of ['task_kind', 'access_mode', 'read_only_required', 'execution_isolation', 'runner_id', 'runner_unit_scope']) {
    const present = taskColumns.has(column);
    record('C3', `collaboration_tasks 有 ${column} 列`, present,
      present ? '' : `PRAGMA table_info 未见 ${column} 列`);
  }

  // C3-7: taskKind=consultation → read_only_required 恒 1(Runtime 强制只读,模型不可降级)
  const collabSource = readSource('chat/collaboration-store.mjs');
  const planSource = readSource('chat/collaboration-plan.mjs');
  const hardReadOnly = /read_only_required\s*=\s*1|readOnlyRequired\s*[=:]\s*(true|1)/.test(collabSource + planSource)
    && /consultation/.test(collabSource + planSource);
  record('C3', 'taskKind=consultation 时 read_only_required 恒为 1(Runtime 强制只读)', hardReadOnly,
    hardReadOnly ? '' : '无 taskKind=consultation → read_only_required=1 的硬约束');

  // C3-8: collaboration-plan.mjs 校验只读一致性(consultation 写路径被拒)
  const planReadonlyCheck = planSource.includes('CONSULTATION_READONLY_VIOLATION')
    || /consultation[\s\S]{0,120}read.?only/i.test(planSource);
  record('C3', 'collaboration-plan.mjs 校验只读一致性(consultation 写路径被拒)', planReadonlyCheck,
    planReadonlyCheck ? '' : 'plan 仅有通用 read-only 冲突(COLLABORATION_WORKSPACE_CONFLICT),无 consultation 专属只读校验');

  // C3-9: 错误码 CONSULTATION_READONLY_VIOLATION
  const hasReadonlyCode = codeExists('CONSULTATION_READONLY_VIOLATION', 'chat/collaboration-store.mjs', 'chat/collaboration-plan.mjs');
  record('C3', '错误码 CONSULTATION_READONLY_VIOLATION 存在', hasReadonlyCode,
    hasReadonlyCode ? '' : '全仓无 CONSULTATION_READONLY_VIOLATION');
}

// ── C4 ResultPacket system-bound consultation 块 ────────────────────────────
console.log('\n[C4] ResultPacket system-bound consultation 块');
{
  const source = readSource('chat/result-packets.mjs');
  const mod = resultPackets.mod;
  const rpExists = resultPackets.ok && source.length > 0;
  record('C4', 'result-packets.mjs 模块存在', rpExists, 'chat/result-packets.mjs 缺失');

  if (rpExists) {
    // C4-1: kind 保持 'execution'
    const kindExecution = mod?.PACKET_KINDS?.has('execution') === true;
    record('C4', "kind 保持 'execution'(PACKET_KINDS 含 execution)", kindExecution,
      kindExecution ? '' : 'PACKET_KINDS 不再含 execution');

    // C4-2: taskKind 字段支持(默认 'execution',允许 'consultation')
    const hasTaskKind = /taskKind/.test(source);
    const taskKindTwoValue = hasTaskKind && /['"`]consultation['"`]/.test(source);
    record('C4', "taskKind 字段支持(默认 'execution',允许 'consultation')", taskKindTwoValue,
      taskKindTwoValue ? '' : hasTaskKind ? 'taskKind 已出现但未枚举 consultation 值' : 'normalizeResultPacket 无 taskKind 字段');

    // C4-3: result_packets 表有 task_kind 列(读 CREATE TABLE / 迁移字符串)
    const hasTaskKindColumn = /task_kind/.test(source);
    record('C4', 'result_packets 表有 task_kind 列', hasTaskKindColumn,
      hasTaskKindColumn ? '' : 'result_packets CREATE TABLE 无 task_kind 列');

    // C4-4: consultation packet 携带 consultation 块(建议模型生成;Task/Run/usage/scope/digest 后端绑定不可伪造)
    const consultBlock = /consultation/.test(source) && /recommendation/.test(source);
    record('C4', 'consultation packet 携带 consultation 块(建议模型生成,Task/Run/usage/scope/digest 后端绑定)', consultBlock,
      consultBlock ? '' : '无 consultation 块校验/后端绑定逻辑');

    // C4-5: 错误码 CONSULTATION_PACKET_INVALID
    const hasPacketCode = codeExists('CONSULTATION_PACKET_INVALID', 'chat/result-packets.mjs');
    record('C4', '错误码 CONSULTATION_PACKET_INVALID 存在', hasPacketCode,
      hasPacketCode ? '' : '无 CONSULTATION_PACKET_INVALID');
  } else {
    for (const [check, detail] of [
      ["kind 保持 'execution'(PACKET_KINDS 含 execution)", '模块缺失'],
      ["taskKind 字段支持(默认 'execution',允许 'consultation')", '模块缺失'],
      ['result_packets 表有 task_kind 列', '模块缺失'],
      ['consultation packet 携带 consultation 块(建议模型生成,Task/Run/usage/scope/digest 后端绑定)', '模块缺失'],
      ['错误码 CONSULTATION_PACKET_INVALID 存在', '模块缺失'],
    ]) {
      record('C4', check, false, detail);
    }
  }
}

// ── C5 Round 状态机 ─────────────────────────────────────────────────────────
console.log('\n[C5] Round 状态机');
{
  const source = readSource('chat/consultation-store.mjs');
  const mod = consultationStore.mod;
  const exists = consultationStore.ok;
  record('C5', 'chat/consultation-store.mjs 模块存在', exists, '模块不存在(尚未实现,P2 交付)');

  const ROUND_STATES = ['PLANNED', 'DISPATCHED', 'AGGREGATING', 'DECIDED', 'INCONCLUSIVE', 'FAILED', 'EXPIRED', 'CANCELLED'];

  // C5-2: 状态常量覆盖 8 态
  const stateConst = mod?.CONSULTATION_ROUND_STATES || mod?.ROUND_STATES || null;
  const statesCovered = (stateConst && ROUND_STATES.every((s) => stateConst.includes?.(s) || stateConst.has?.(s)))
    || ROUND_STATES.every((s) => source.includes(s));
  record('C5', '状态常量覆盖 8 态(PLANNED→DISPATCHED→AGGREGATING→DECIDED|INCONCLUSIVE|FAILED|EXPIRED|CANCELLED)', !!statesCovered,
    statesCovered ? '' : '缺状态常量或状态枚举不全');

  // C5-3: 合法迁移集合冻结
  const legalMigrations = /transition|legalMigrations|ALLOWED_TRANSITIONS|allowedTransitions|migrations/.test(source);
  record('C5', '合法迁移集合冻结(transition 表)', legalMigrations,
    legalMigrations ? '' : '无冻结的合法迁移集合');

  // C5-4: 状态迁移 API 拒绝非法迁移
  const stateApi = typeof mod?.transitionRoundState === 'function'
    || typeof mod?.transition === 'function'
    || typeof mod?.advanceRoundState === 'function';
  const rejectsIllegal = stateApi && source.includes('CONSULTATION_ROUND_STATE_INVALID');
  record('C5', '状态迁移 API 拒绝非法迁移(CONSULTATION_ROUND_STATE_INVALID)', !!rejectsIllegal,
    rejectsIllegal ? '' : '无迁移 API 或未抛 CONSULTATION_ROUND_STATE_INVALID');

  // C5-5: packetIds 由 append-only consultation_packet_links 推导
  const packetLinks = /consultation_packet_links/.test(source);
  record('C5', 'packetIds 由 append-only consultation_packet_links 推导(不存可变数组)', packetLinks,
    packetLinks ? '' : '无 consultation_packet_links append-only 关联');

  // C5-6: quorum 规则
  const quorum = /quorum/.test(source) && /digest|vote/.test(source);
  record('C5', 'quorum 规则(DECIDED 需 ≥quorum 不同专家 packet 且 digest 一致)', quorum,
    quorum ? '' : '无 quorum 聚合校验');

  // C5-7: deadline 规则
  const deadline = /deadline/.test(source) && /EXPIRED/.test(source);
  record('C5', 'deadline 规则(DISPATCHED/AGGREGATING 超 deadline → EXPIRED)', deadline,
    deadline ? '' : '无 deadline→EXPIRED 判定');

  // C5-8: CAS/version 规则
  const cas = /version/.test(source) && /WHERE version\s*=\s*\?/.test(source);
  record('C5', 'CAS/version 规则(迁移带 WHERE version = ?)', cas,
    cas ? '' : '无 version 乐观并发迁移');

  // C5-9: 错误码
  const roundCodes = ['CONSULTATION_ROUND_STATE_INVALID', 'CONSULTATION_ROUND_STATE_CONFLICT', 'CONSULTATION_QUORUM_NOT_MET', 'CONSULTATION_DEADLINE_EXPIRED'];
  const codesPresent = codeExists(roundCodes[0], 'chat/consultation-store.mjs')
    && roundCodes.every((code) => source.includes(code));
  record('C5', '错误码 ROUND_STATE_INVALID/CONFLICT/QUORUM_NOT_MET/DEADLINE_EXPIRED 存在', codesPresent,
    codesPresent ? '' : '缺少部分 CONSULTATION_ROUND_* 错误码');
}

// ── C6 DecisionRecord typed guards ──────────────────────────────────────────
console.log('\n[C6] DecisionRecord typed guards');
{
  const gateSource = readSource('chat/consultation-compiler-gate.mjs');
  const storeSource = readSource('chat/consultation-store.mjs');
  const decisionSource = gateSource + storeSource;
  const gateOrStore = compilerGate.ok || consultationStore.ok;

  record('C6', 'typed guard 校验入口存在(consultation-compiler-gate.mjs 或 consultation-store decision API)', gateOrStore,
    'consultation-compiler-gate.mjs 与 decision 表均未实现(P5/P4 交付)');

  // C6-2: 识别三个 typed guard
  const guardGrammar = /independent_reviewer/.test(decisionSource)
    && /execution_isolation/.test(decisionSource)
    && /max_concurrent_writers/.test(decisionSource);
  record('C6', '识别三个 typed guard(independent_reviewer(role=security,min=1) / execution_isolation(selector=writers,value=worktree) / max_concurrent_writers(value=1))', guardGrammar,
    guardGrammar ? '' : '无 typed guard 语法/语义解析');

  // C6-3: 拒绝未知 guard
  const rejectUnknown = codeExists('CONSULTATION_GUARD_INVALID', 'chat/consultation-compiler-gate.mjs', 'chat/consultation-store.mjs');
  record('C6', '拒绝未知 guard(CONSULTATION_GUARD_INVALID)', rejectUnknown,
    rejectUnknown ? '' : '无未知 guard 拒绝逻辑');

  // C6-4: 战略决策必须 decidedBySessionId
  const strategic = /decidedBySessionId/.test(decisionSource);
  record('C6', '战略决策必须 decidedBySessionId(decidedByNodeId 仅可选)', strategic,
    strategic ? '' : '无 decidedBySessionId 强制校验');

  // C6-5: 战术决策需 baseRevision + contextDigest 或明确失效条件
  const tactical = /baseRevision/.test(decisionSource)
    && (/contextDigest/.test(decisionSource) || /invalidate|expiresAt|expiry|失效/.test(decisionSource));
  record('C6', '战术决策需 baseRevision + contextDigest 或明确失效条件', tactical,
    tactical ? '' : '无战术决策 baseRevision/contextDigest/失效条件校验');

  // C6-6: 错误码
  const decisionCodes = codeExists('CONSULTATION_GUARD_INVALID', 'chat/consultation-compiler-gate.mjs', 'chat/consultation-store.mjs')
    && codeExists('CONSULTATION_DECISION_INVALID', 'chat/consultation-compiler-gate.mjs', 'chat/consultation-store.mjs');
  record('C6', '错误码 CONSULTATION_GUARD_INVALID / CONSULTATION_DECISION_INVALID 存在', decisionCodes,
    decisionCodes ? '' : '缺少 CONSULTATION_GUARD_INVALID 或 CONSULTATION_DECISION_INVALID');
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('\n=== Consultation V1 契约缺口清单 ===');
const gaps = results.filter((r) => !r.pass);
if (gaps.length === 0) {
  console.log('(无缺口 —— 全部冻结契约语义已满足)');
} else {
  for (const gap of gaps) {
    console.log(`GAP  [${gap.contract}] ${gap.check} — ${gap.detail}`);
  }
}
console.log('---');
console.log(`契约检查汇总: ${passCount} PASS, ${gapCount} GAP, 共 ${results.length} 项`);
if (gapCount > 0) {
  console.log('存在 GAP → exit 1(契约优先 TDD:P0 预期红,缺口清单即验收通过)');
  process.exitCode = 1;
} else {
  console.log('全部满足 → exit 0');
  process.exitCode = 0;
}

// 清理临时隔离目录。
rmSync(tempHome, { recursive: true, force: true });
