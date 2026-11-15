#!/usr/bin/env node
// P4-T2 聚焦测试:DecisionRecord typed guards(C6)。
// 验证 chat/consultation-store.mjs 的 C6 冻结语义
// (docs/consultation-v1-implementation-plan-2026-08-14.md §3 C6 / §6 / §4):
//   - parseTypedGuards / validateTypedGuard:三 guard 的字符串与对象写法解析一致,
//     independent_reviewer(role=security,min=1) 默认参数正确
//   - 未知 guard 类型 → CONSULTATION_GUARD_INVALID(400)
//   - 非法参数 independent_reviewer(min=0) / execution_isolation(selector=wrong,value=worktree)
//     / max_concurrent_writers(value=0) → CONSULTATION_GUARD_INVALID
//   - 战略决策(无 decidedByNodeId):缺 decidedBySessionId → CONSULTATION_DECISION_INVALID;
//     有 decidedBySessionId → 创建成功
//   - 战术决策(有 baseRevision):无 contextDigest/失效条件 → CONSULTATION_DECISION_INVALID;
//     带 contextDigest → 成功
//   - 创建后 getConsultationDecision / listConsultationDecisions 读回字段齐全
//     (含 required_guards_json 解析回 typed guards)
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 隔离临时 HOME + RAGENT_CONFIG_DIR —— 必须在 import 被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-decision-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;

const store = await import('../chat/consultation-store.mjs');

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}
function futureIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
}

async function assertRejectsCode(promise, code, label = '') {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${label} expected code ${code}, got ${err.code} — ${err.message}`);
    return true;
  });
}

function assertThrowsCode(fn, code, label = '') {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `${label} expected code ${code}, got ${err.code} — ${err.message}`);
    assert.equal(err.statusCode, 400, `${label} expected HTTP 400, got ${err.statusCode}`);
    return true;
  });
}

async function makeRound() {
  return store.createConsultationRound({
    rootSessionId: nextId('root'),
    roundNumber: 1,
    objective: 'strategic consultation',
    question: 'proceed?',
    experts: [{ role: 'security' }],
    quorum: 1,
    budget: { tokens: 100000 },
    deadline: futureIso(),
  });
}

// ── typed guard 解析:字符串与对象写法一致 + 默认参数 ──────────────────────────
async function testTypedGuardParsing() {
  const canonical = {
    independent_reviewer: { type: 'independent_reviewer', role: 'security', min: 1 },
    execution_isolation: { type: 'execution_isolation', selector: 'writers', value: 'worktree' },
    max_concurrent_writers: { type: 'max_concurrent_writers', value: 1 },
  };

  for (const [type, expected] of Object.entries(canonical)) {
    const strForm = Object.entries(expected)
      .filter(([key]) => key !== 'type')
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const fromString = store.validateTypedGuard(`${type}(${strForm})`);
    const fromObject = store.validateTypedGuard(expected);
    assert.deepEqual(fromString, expected, `string form ${type} parses to canonical object`);
    assert.deepEqual(fromObject, expected, `object form ${type} parses to canonical object`);
    assert.deepEqual(fromString, fromObject, `${type} string/object parse identically`);
  }

  // 默认参数:independent_reviewer 默认 role=security, min=1;max_concurrent_writers 默认 value=1;
  // execution_isolation 默认 selector=writers, value=worktree。
  assert.deepEqual(
    store.validateTypedGuard('independent_reviewer()'),
    { type: 'independent_reviewer', role: 'security', min: 1 },
    'string independent_reviewer() defaults',
  );
  assert.deepEqual(
    store.validateTypedGuard({ type: 'independent_reviewer' }),
    { type: 'independent_reviewer', role: 'security', min: 1 },
    'object independent_reviewer defaults',
  );
  assert.deepEqual(
    store.validateTypedGuard('max_concurrent_writers()'),
    { type: 'max_concurrent_writers', value: 1 },
    'max_concurrent_writers() defaults',
  );
  assert.deepEqual(
    store.validateTypedGuard('execution_isolation()'),
    { type: 'execution_isolation', selector: 'writers', value: 'worktree' },
    'execution_isolation() defaults',
  );

  // parseTypedGuards:混合数组 / 单个 / 空输入。
  const mixed = store.parseTypedGuards([
    'independent_reviewer(role=security,min=1)',
    { type: 'execution_isolation', selector: 'writers', value: 'worktree' },
    'max_concurrent_writers(value=1)',
  ]);
  assert.deepEqual(mixed, [
    canonical.independent_reviewer,
    canonical.execution_isolation,
    canonical.max_concurrent_writers,
  ], 'parseTypedGuards normalizes a mixed array');
  assert.deepEqual(store.parseTypedGuards([]), [], 'empty array → empty guards');
  assert.deepEqual(store.parseTypedGuards(undefined), [], 'undefined → empty guards');
  assert.deepEqual(store.parseTypedGuards(null), [], 'null → empty guards');
  assert.deepEqual(
    store.parseTypedGuards('independent_reviewer(role=security,min=1)'),
    [canonical.independent_reviewer],
    'single string input normalizes to one guard',
  );
}

// ── 未知 guard 类型 → CONSULTATION_GUARD_INVALID(400) ────────────────────────
async function testUnknownGuardRejected() {
  assertThrowsCode(
    () => store.validateTypedGuard('rogue_guard(x=1)'),
    store.CONSULTATION_GUARD_INVALID,
    'unknown guard type (string)',
  );
  assertThrowsCode(
    () => store.validateTypedGuard({ type: 'rogue_guard' }),
    store.CONSULTATION_GUARD_INVALID,
    'unknown guard type (object)',
  );
  assertThrowsCode(
    () => store.parseTypedGuards(['independent_reviewer(min=1)', 'unknown_guard(x=1)']),
    store.CONSULTATION_GUARD_INVALID,
    'parseTypedGuards rejects unknown guard inside array',
  );
}

// ── 非法参数 → CONSULTATION_GUARD_INVALID(400) ───────────────────────────────
async function testInvalidGuardParams() {
  const invalid = [
    'independent_reviewer(min=0)',
    'independent_reviewer(role=,min=1)',
    'independent_reviewer(min=abc)',
    'execution_isolation(selector=wrong,value=worktree)',
    'execution_isolation(selector=writers,value=shared)',
    'max_concurrent_writers(value=0)',
    'max_concurrent_writers(value=-1)',
    'independent_reviewer(bogus=1)',
    { type: 'independent_reviewer', min: 0 },
    { type: 'execution_isolation', selector: 'wrong', value: 'worktree' },
    { type: 'max_concurrent_writers', value: 0 },
    { type: 'max_concurrent_writers', extra: 1 },
  ];
  for (const guard of invalid) {
    assertThrowsCode(
      () => store.validateTypedGuard(guard),
      store.CONSULTATION_GUARD_INVALID,
      `invalid guard ${JSON.stringify(guard)}`,
    );
  }
}

// ── 战略决策:无 decidedByNodeId 必须 decidedBySessionId ──────────────────────
async function testStrategicDecision() {
  const round = await makeRound();

  // 无 node 且缺 session → CONSULTATION_DECISION_INVALID
  await assertRejectsCode(
    store.createConsultationDecision({ roundId: round.id, decision: 'proceed' }),
    store.CONSULTATION_DECISION_INVALID,
    'strategic decision missing decidedBySessionId',
  );

  // 有 decidedBySessionId → 创建成功
  const session = nextId('session');
  const rec = await store.createConsultationDecision({
    roundId: round.id,
    decision: 'proceed with rollout',
    rationale: 'security review passed',
    requiredGuards: ['independent_reviewer(role=security,min=1)', 'max_concurrent_writers(value=1)'],
    decidedBySessionId: session,
  });
  assert.ok(rec.id.startsWith('dec_'), 'decision id prefixed dec_');
  assert.equal(rec.roundId, round.id);
  assert.equal(rec.decision, 'proceed with rollout');
  assert.equal(rec.rationale, 'security review passed');
  assert.equal(rec.decidedBySessionId, session);
  assert.equal(rec.decidedByNodeId, '', 'strategic decision has no node');
  assert.equal(rec.baseRevision, null, 'strategic decision has no baseRevision');
  assert.equal(rec.contextDigest, '', 'strategic decision has no contextDigest');
  assert.deepEqual(rec.requiredGuards, [
    { type: 'independent_reviewer', role: 'security', min: 1 },
    { type: 'max_concurrent_writers', value: 1 },
  ], 'requiredGuards persisted as typed guards');

  // round 缺失 → CONSULTATION_NOT_FOUND(404)
  await assertRejectsCode(
    store.createConsultationDecision({
      roundId: 'round_missing', decision: 'x', decidedBySessionId: nextId('session'),
    }),
    store.CONSULTATION_NOT_FOUND,
    'decision for missing round',
  );

  // decision 非空字符串
  await assertRejectsCode(
    store.createConsultationDecision({
      roundId: round.id, decision: '   ', decidedBySessionId: nextId('session'),
    }),
    store.CONSULTATION_DECISION_INVALID,
    'blank decision',
  );
}

// ── 战术决策:有 baseRevision 必须 contextDigest/expiresAt ────────────────────
async function testTacticalDecision() {
  const round = await makeRound();
  const session = nextId('session');

  // 有 baseRevision 但无 contextDigest/expiresAt → CONSULTATION_DECISION_INVALID
  await assertRejectsCode(
    store.createConsultationDecision({
      roundId: round.id, decision: 'approve', decidedBySessionId: session, baseRevision: 3,
    }),
    store.CONSULTATION_DECISION_INVALID,
    'tactical decision missing contextDigest',
  );

  // 带 contextDigest → 成功
  const withDigest = await store.createConsultationDecision({
    roundId: round.id,
    decision: 'approve at revision 3',
    rationale: 'context unchanged since base',
    requiredGuards: ['execution_isolation(selector=writers,value=worktree)'],
    decidedBySessionId: session,
    baseRevision: 3,
    contextDigest: 'sha256:abc123',
  });
  assert.equal(withDigest.baseRevision, 3, 'baseRevision persisted');
  assert.equal(withDigest.contextDigest, 'sha256:abc123', 'contextDigest persisted');

  // 带 expiresAt(明确失效条件)→ 成功
  const withExpiry = await store.createConsultationDecision({
    roundId: round.id,
    decision: 'approve with expiry',
    decidedBySessionId: session,
    baseRevision: 4,
    expiresAt: futureIso(),
  });
  assert.equal(withExpiry.baseRevision, 4, 'expiry decision baseRevision persisted');
  assert.ok(withExpiry.expiresAt, 'expiresAt persisted for explicit invalidation condition');

  // 非法 baseRevision(负数/小数)→ CONSULTATION_DECISION_INVALID
  await assertRejectsCode(
    store.createConsultationDecision({
      roundId: round.id, decision: 'x', decidedBySessionId: session,
      baseRevision: -1, contextDigest: 'sha256:bad',
    }),
    store.CONSULTATION_DECISION_INVALID,
    'negative baseRevision',
  );
}

// ── 读回:get / list 字段齐全,required_guards_json 解析回 typed guards ────────
async function testReadBack() {
  const round = await makeRound();
  const guards = [
    'independent_reviewer(role=security,min=1)',
    'execution_isolation(selector=writers,value=worktree)',
    'max_concurrent_writers(value=1)',
  ];
  const session = nextId('session');
  const rec = await store.createConsultationDecision({
    roundId: round.id,
    decision: 'go',
    rationale: 'rationale here',
    requiredGuards: guards,
    decidedBySessionId: session,
    baseRevision: 7,
    contextDigest: 'sha256:def456',
  });

  const fetched = await store.getConsultationDecision(rec.id);
  assert.equal(fetched.id, rec.id);
  assert.equal(fetched.roundId, round.id);
  assert.equal(fetched.decision, 'go');
  assert.equal(fetched.rationale, 'rationale here');
  assert.equal(fetched.decidedBySessionId, session);
  assert.equal(fetched.decidedByNodeId, '', 'no node on strategic/tactical-by-session decision');
  assert.equal(fetched.baseRevision, 7, 'baseRevision read back');
  assert.equal(fetched.contextDigest, 'sha256:def456', 'contextDigest read back');
  assert.deepEqual(fetched.requiredGuards, [
    { type: 'independent_reviewer', role: 'security', min: 1 },
    { type: 'execution_isolation', selector: 'writers', value: 'worktree' },
    { type: 'max_concurrent_writers', value: 1 },
  ], 'required_guards_json parses back to typed guards');

  const listed = await store.listConsultationDecisions(round.id);
  const found = listed.find((d) => d.id === rec.id);
  assert.ok(found, 'created decision appears in list');
  assert.deepEqual(found.requiredGuards, fetched.requiredGuards, 'listed guards parse back identically');
  assert.deepEqual(found, fetched, 'list row matches get row');

  await assertRejectsCode(
    store.getConsultationDecision('dec_missing'),
    store.CONSULTATION_NOT_FOUND,
    'get unknown decision',
  );

  // 空 requiredGuards(省略)创建成功
  const emptyGuards = await store.createConsultationDecision({
    roundId: round.id, decision: 'no guards', decidedBySessionId: nextId('session'),
  });
  assert.deepEqual(emptyGuards.requiredGuards, [], 'omitted requiredGuards → empty guard list');
}

// ── createConsultationDecision 拒绝非法 requiredGuards → GUARD_INVALID ───────
async function testCreateRejectsInvalidGuards() {
  const round = await makeRound();
  await assertRejectsCode(
    store.createConsultationDecision({
      roundId: round.id,
      decision: 'x',
      decidedBySessionId: nextId('session'),
      requiredGuards: ['independent_reviewer(min=0)'],
    }),
    store.CONSULTATION_GUARD_INVALID,
    'createConsultationDecision rejects invalid guard',
  );
}

try {
  await store.initializeConsultationStore();
  await testTypedGuardParsing();
  await testUnknownGuardRejected();
  await testInvalidGuardParams();
  await testStrategicDecision();
  await testTacticalDecision();
  await testReadBack();
  await testCreateRejectsInvalidGuards();
  console.log('test-consultation-decision: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
