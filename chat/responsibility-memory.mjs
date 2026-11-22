import { createHash, randomUUID } from 'node:crypto';
import { withDatabase } from './collaboration-store.mjs';
import { defaultEpisodicMemoryStore } from './episodic-memory-store.mjs';
import { defaultProjectMemoryStore, projectMemoryConflictMutationDigest } from './project-memory-store.mjs';
import { getResponsibility } from './responsibility-service.mjs';
import { activity, digest, error, now, read, transaction } from './responsibility-store.mjs';
import { defaultUserMemoryStore, ensureUserMemorySchema, validateUserMemoryWrite } from './user-memory-store.mjs';

const GOVERNANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS responsibility_memory_fact_governance (
  project_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  fact_version INTEGER NOT NULL DEFAULT 1,
  valid_until TEXT,
  superseded_by_fact_id TEXT,
  superseded_by_layer TEXT,
  source_type TEXT,
  source_ref TEXT,
  confidence REAL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, fact_id)
);

CREATE TABLE IF NOT EXISTS responsibility_memory_conflict_reviews (
  responsibility_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  fact_signature TEXT NOT NULL,
  members_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  resolution_journal_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(responsibility_id, group_id)
);

CREATE TABLE IF NOT EXISTS responsibility_memory_resolution_journal (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  responsibility_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','project_committed','committed','aborted','recovery_conflict')),
  plan_json TEXT NOT NULL,
  project_committed_version INTEGER,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(actor_id, responsibility_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS responsibility_memory_journal_pending
  ON responsibility_memory_resolution_journal(status, updated_at);

CREATE TABLE IF NOT EXISTS responsibility_memory_audit_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  responsibility_id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  owner_principal_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  layer TEXT NOT NULL,
  fact_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  previous_version INTEGER,
  new_version INTEGER,
  previous_value TEXT,
  new_value TEXT,
  valid_until TEXT,
  source_type TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '',
  preview_digest TEXT,
  idempotency_key TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS responsibility_memory_audit_scope
  ON responsibility_memory_audit_log(owner_principal_id, responsibility_id, sequence DESC);
CREATE TRIGGER IF NOT EXISTS responsibility_memory_audit_no_update
  BEFORE UPDATE ON responsibility_memory_audit_log
  BEGIN SELECT RAISE(ABORT, 'immutable memory audit log'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_memory_audit_no_delete
  BEFORE DELETE ON responsibility_memory_audit_log
  BEGIN SELECT RAISE(ABORT, 'immutable memory audit log'); END;
`;

const UNTRUSTED_ORIGIN_TOKENS = new Set([
  'external_untrusted', 'external', 'web', 'email', 'repo', 'repository',
  'webhook', 'ci_log', 'untrusted', 'prompt_injection', 'tool_output',
]);
const MODEL_ORIGIN_TOKENS = new Set(['model_inferred', 'model', 'llm', 'assistant', 'inferred']);
const FORBIDDEN_POLICY_KEYS = new Set([
  'policy', 'policypatch', 'responsibilitypolicy', 'allowedpaths', 'planapproval',
  'dailybudget', 'networkpolicy', 'capabilitygates', 'promotetouserrule',
]);

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of',
  'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'that', 'this', 'it', 'its',
  'and', 'or', 'we', 'our', 'you', 'your', 'user', 'project', 'fact', 'rule', 'preference',
  'constraint', 'decision', 'state', 'convention', 'habit', 'config', 'setting', 'should',
  'would', 'could', 'can', 'will', 'all', 'any', 'into', 'than', 'per',
]);

const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'none', 'dont', 'cannot', 'cant', 'forbid', 'forbidden',
  'prohibit', 'prohibited', 'ban', 'banned', 'disallow', 'disallowed', 'disable',
  'disabled', 'deny', 'denied', 'skip', 'avoid', 'off', 'false',
  '禁止', '不得', '不要', '不能', '关闭', '禁用', '拒绝', '免', '不',
]);

const AFFIRMATION_WORDS = new Set([
  'always', 'must', 'require', 'required', 'enable', 'enabled', 'allow', 'allowed',
  'enforce', 'enforced', 'on', 'true', 'yes', 'mandatory',
  '必须', '总是', '始终', '启用', '开启', '允许', '需要', '强制',
]);

const PHRASE_ALIASES = [
  [/\b(?:working directory|execution root|root path|repo root|workspace root|cwd)\b/g, 'workspace_root'],
  [/\b(?:default branch|target branch|main branch|primary branch)\b/g, 'target_branch'],
  [/\b(?:package manager|pkg manager|node package manager)\b/g, 'package_manager'],
  [/\b(?:time limit|max duration|maximum duration|timeout)\b/g, 'timeout'],
  [/\b(?:max retries|retry limit|maximum attempts|max attempts|retries)\b/g, 'max_retries'],
  [/\b(?:daily budget|budget limit|max cost|cost limit|spending limit)\b/g, 'budget_limit'],
  [/\b(?:response language|preferred language|output language|reply language|language|locale)\b/g, 'language'],
  [/\b(?:time zone|timezone|tz)\b/g, 'timezone'],
  [/\b(?:human review|manual review|human approval|approval|confirmation|confirm)\b/g, 'human_approval'],
  [/\b(?:auto merge|automatic merge|automerge)\b/g, 'auto_merge'],
  [/\b(?:auto push|automatic push|autopush)\b/g, 'auto_push'],
  [/\b(?:auto deploy|automatic deploy|autodeploy)\b/g, 'auto_deploy'],
  [/\b(?:network access|network policy|internet access|network)\b/g, 'network_policy'],
  [/\b(?:read only|readonly)\b/g, 'read_only'],
  [/\b(?:read write|readwrite|writable)\b/g, 'writable'],
  [/\b(?:do not|don't|must not|should not|never)\b/g, 'not'],
  [/\b(?:at least|no less than|minimum|min)\b/g, 'min_bound'],
  [/\b(?:at most|no more than|maximum|max)\b/g, 'max_bound'],
];

const TOKEN_SYNONYMS = {
  working: 'work',
  dir: 'directory',
  repo: 'repository',
  retries: 'max_retries',
  retry: 'max_retries',
  attempts: 'max_retries',
  response: 'reply',
  responses: 'reply',
  replies: 'reply',
  answer: 'reply',
  answers: 'reply',
  zh: 'chinese',
  中文: 'chinese',
  汉语: 'chinese',
  en: 'english',
  英文: 'english',
  英语: 'english',
  ja: 'japanese',
  日语: 'japanese',
  日文: 'japanese',
  brief: 'concise',
  short: 'concise',
  terse: 'concise',
  succinct: 'concise',
  detailed: 'verbose',
  comprehensive: 'verbose',
  lengthy: 'verbose',
  automatic: 'auto',
  automated: 'auto',
  confirm: 'human_approval',
  approve: 'human_approval',
  approvals: 'human_approval',
  tests: 'testing',
  test: 'testing',
  verify: 'testing',
  verification: 'testing',
  check: 'testing',
  checks: 'testing',
  prohibit: 'forbid',
  prohibited: 'forbid',
  forbidden: 'forbid',
  ban: 'forbid',
  banned: 'forbid',
  disallow: 'forbid',
  disallowed: 'forbid',
  deny: 'forbid',
  denied: 'forbid',
  block: 'forbid',
  blocked: 'forbid',
  disable: 'disabled',
  disabled: 'disabled',
  enable: 'enabled',
  enabled: 'enabled',
  allow: 'allowed',
  allowed: 'allowed',
  omit: 'skip',
  bypass: 'skip',
  optional: 'skip',
};

const ANTONYM_PAIRS = [
  ['access', 'allowed', 'forbid'],
  ['toggle', 'enabled', 'disabled'],
  ['requirement', 'require', 'skip'],
  ['requirement', 'required', 'skip'],
  ['boolean', 'true', 'false'],
  ['switch', 'on', 'off'],
  ['frequency', 'always', 'never'],
  ['verbosity', 'concise', 'verbose'],
  ['automation', 'manual', 'auto'],
  ['writability', 'read_only', 'writable'],
  ['strictness', 'strict', 'permissive'],
  ['strictness', 'strict', 'lenient'],
  ['visibility', 'public', 'private'],
  ['execution', 'sync', 'async'],
  ['order', 'asc', 'desc'],
  ['theme', 'light', 'dark'],
];

const EXCLUSIVE_DOMAINS = new Map([
  ['npm', 'package_manager'], ['pnpm', 'package_manager'], ['yarn', 'package_manager'], ['bun', 'package_manager'],
  ['english', 'language'], ['chinese', 'language'], ['japanese', 'language'], ['french', 'language'], ['german', 'language'], ['spanish', 'language'],
  ['sqlite', 'database'], ['postgres', 'database'], ['postgresql', 'database'], ['mysql', 'database'], ['mongodb', 'database'],
  ['json', 'format'], ['yaml', 'format'], ['toml', 'format'], ['xml', 'format'], ['markdown', 'format'],
  ['tabs', 'indent'], ['spaces', 'indent'],
  ['rebase', 'git_strategy'], ['merge', 'git_strategy'], ['squash', 'git_strategy'],
  ['main', 'branch'], ['master', 'branch'], ['develop', 'branch'], ['release', 'branch'], ['staging', 'branch'],
  ['utc', 'timezone'], ['asia/shanghai', 'timezone'], ['america/new_york', 'timezone'], ['america/los_angeles', 'timezone'], ['europe/london', 'timezone'],
]);

const TIME_MULTIPLIERS = { ms: 1, millisecond: 1, milliseconds: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000 };
const SIZE_MULTIPLIERS = { b: 1, byte: 1, bytes: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 };

const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function text(value, max = 0) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? normalized.slice(0, max) : normalized;
}

function parseJson(raw, fallback = null) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function ensureGovernanceSchemaSync(db) {
  db.exec(GOVERNANCE_SCHEMA);
}

async function asyncTransaction(fn) {
  await read(() => {});
  return withDatabase(async db => {
    ensureGovernanceSchemaSync(db);
    ensureUserMemorySchema(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }, { mutate: true });
}

function assertOwnerActor(actor) {
  if (!actor || actor.kind !== 'user' || actor.role !== 'owner' || !text(actor.principalId, 160)) {
    throw error('Owner access required', 403, 'RESPONSIBILITY_FORBIDDEN');
  }
  return text(actor.principalId, 160);
}

export function assertResponsibilityMemoryWritesEnabled() {
  if (process.env.RAGENT_RESPONSIBILITY_MEMORY_WRITES_ENABLED !== '1') {
    throw error('Memory revision is disabled', 503, 'MEMORY_REVISION_DISABLED');
  }
}

function assertNoPolicyMutationInPayload(input) {
  if (!input || typeof input !== 'object') return;
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_POLICY_KEYS.has(key.toLowerCase())) {
      throw error(`Memory operation cannot modify Responsibility policy field '${key}'`, 403, 'RESPONSIBILITY_POLICY_PROTECTED');
    }
  }
  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    for (const key of Object.keys(input.metadata)) {
      if (FORBIDDEN_POLICY_KEYS.has(key.toLowerCase())) {
        throw error(`Memory metadata cannot alter Responsibility policy field '${key}'`, 403, 'RESPONSIBILITY_POLICY_PROTECTED');
      }
    }
  }
}

function hasPromptInjectionDirective(content) {
  const raw = String(content || '');
  if (!raw) return false;
  return /\b(?:ignore|disregard|forget|override|bypass)\b.{0,50}\b(?:previous|prior|above|system|owner|responsibility)\b.{0,50}\b(?:instructions?|rules?|policy|policies|constraints?|approvals?)\b/i.test(raw)
    || /\b(?:promote|upgrade|convert|elevate|set)\b.{0,30}\b(?:to|as)\b.{0,20}\buser_rule\b/i.test(raw)
    || /\b(?:set|modify|update|override|change|rewrite)\b.{0,35}\b(?:responsibility[_ ]?policy|planApproval|dailyBudget|networkPolicy|allowedPaths|capabilityGates)\b/i.test(raw)
    || /<\/?(?:system|developer|hide|instructions)\b/i.test(raw);
}

function recordMemoryAuditSync(db, entry) {
  db.prepare(`
    INSERT INTO responsibility_memory_audit_log (
      id, responsibility_id, project_id, owner_principal_id, actor_id,
      operation, layer, fact_id, action, previous_version, new_version,
      previous_value, new_value, valid_until, source_type, source_ref,
      preview_digest, idempotency_key, details_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    `rma_${randomUUID()}`,
    text(entry.responsibilityId, 160),
    text(entry.projectId, 160),
    text(entry.ownerPrincipalId, 160),
    text(entry.actorId, 160),
    text(entry.operation, 80),
    text(entry.layer, 40) || 'governance',
    text(entry.factId, 160),
    text(entry.action, 60),
    Number.isInteger(entry.previousVersion) ? entry.previousVersion : null,
    Number.isInteger(entry.newVersion) ? entry.newVersion : null,
    entry.previousValue !== undefined && entry.previousValue !== null ? String(entry.previousValue).slice(0, 2000) : null,
    entry.newValue !== undefined && entry.newValue !== null ? String(entry.newValue).slice(0, 2000) : null,
    entry.validUntil || null,
    text(entry.sourceType, 60),
    text(entry.sourceRef, 500),
    entry.previewDigest || null,
    entry.idempotencyKey || null,
    JSON.stringify(entry.details || {}),
    entry.createdAt || now(),
  );
}

async function recordRejectedAttemptAudit({ responsibilityId = '', projectId = '', ownerPrincipalId, actorId, operation, layer = 'user', factId = '', sourceType = '', sourceRef = '', reason, details = {} }) {
  try {
    await transaction(db => {
      ensureGovernanceSchemaSync(db);
      recordMemoryAuditSync(db, {
        responsibilityId,
        projectId,
        ownerPrincipalId,
        actorId,
        operation: 'prompt_injection_rejected',
        layer,
        factId,
        action: operation,
        sourceType,
        sourceRef,
        details: { reason, ...details },
        createdAt: now(),
      });
      if (responsibilityId) {
        activity(db, responsibilityId, 'memory_governance_blocked', { operation, reason, layer, factId });
      }
    });
  } catch {}
}

function isUntrustedInput(input = {}) {
  const sourceType = text(input.sourceType, 60);
  const origin = text(input.originType || input.provenanceKind || input.sourceKind || '', 80).toLowerCase();
  const sourceRef = text(input.sourceRef, 500);
  return sourceType === 'external_untrusted'
    || UNTRUSTED_ORIGIN_TOKENS.has(origin)
    || input.untrusted === true
    || /^(?:external_untrusted|untrusted|email|web|webhook|ci_log):/i.test(sourceRef);
}

function isModelInput(input = {}) {
  const sourceType = text(input.sourceType, 60);
  const origin = text(input.originType || input.provenanceKind || input.sourceKind || '', 80).toLowerCase();
  const sourceRef = text(input.sourceRef, 500);
  return sourceType === 'model_inferred'
    || MODEL_ORIGIN_TOKENS.has(origin)
    || /^model_inferred:/i.test(sourceRef);
}

async function guardMemoryWriteInput(input, existingFact, actor, context = {}) {
  const principalId = assertOwnerActor(actor);
  try {
    assertNoPolicyMutationInPayload(input);
    const untrusted = isUntrustedInput(input);
    const model = isModelInput(input);
    const valueText = text(input?.factValue ?? input?.value ?? input?.statement ?? input?.content, 2000);
    if ((untrusted || model) && hasPromptInjectionDirective(valueText)) {
      throw error(
        'Untrusted or model-inferred content containing policy or user_rule override directives is rejected',
        403,
        'RESPONSIBILITY_POLICY_PROTECTED',
      );
    }
    if (untrusted && (input?.sourceType === 'user_rule' || input?.category === 'user_rule')) {
      throw error('External untrusted content cannot create or promote a user_rule', 403, 'USER_MEMORY_SOURCE_ISOLATION');
    }
    if (model && (input?.sourceType === 'user_rule' || input?.category === 'user_rule')) {
      throw error('Model-inferred content cannot create or promote a user_rule', 403, 'USER_MEMORY_SOURCE_ISOLATION');
    }
    validateUserMemoryWrite({ ...input, operation: context.operation || (existingFact ? 'revise' : 'create') }, existingFact, actor);
  } catch (err) {
    if (err?.statusCode === 403) {
      await recordRejectedAttemptAudit({
        responsibilityId: context.responsibilityId || '',
        projectId: context.projectId || '',
        ownerPrincipalId: principalId,
        actorId: principalId,
        operation: context.operation || 'write',
        layer: context.layer || 'user',
        factId: existingFact?.id || text(input?.factId, 120),
        sourceType: text(input?.sourceType, 60),
        sourceRef: text(input?.sourceRef, 500),
        reason: err.message,
        details: { code: err.code || 'FORBIDDEN' },
      });
    }
    throw err;
  }
}

function normalizeIdentifierText(raw) {
  let s = String(raw || '').normalize('NFKC');
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  s = s.toLowerCase();
  s = s.replace(/[._/\\:|-]+/g, ' ');
  for (const [pattern, replacement] of PHRASE_ALIASES) {
    s = s.replace(pattern, ` ${replacement} `);
  }
  return s.replace(/\s+/g, ' ').trim();
}

function isOpaqueGeneratedKey(factKey) {
  const k = String(factKey || '').trim().toLowerCase();
  return /^(?:state|decision|architecture|constraint|convention|failure)\.[0-9a-f]{16,}$/.test(k)
    || /^user\.[a-z_]+\.[0-9a-f]{12,}$/.test(k);
}

function tokenizeNormalized(str, { dropStopwords = true } = {}) {
  const cleaned = normalizeIdentifierText(str)
    .replace(/[^\p{L}\p{N}_ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const tokens = [];
  for (const raw of cleaned.split(' ')) {
    if (!raw) continue;
    const mapped = TOKEN_SYNONYMS[raw] || raw;
    if (dropStopwords && STOPWORDS.has(mapped)) continue;
    tokens.push(mapped);
  }
  return tokens;
}

function extractNumericConstraints(rawText) {
  const normalized = normalizeIdentifierText(rawText);
  const constraints = [];
  const regex = /(?:(min_bound|max_bound)\s+)?(-?\d+(?:\.\d+)?)\s*(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|bytes?|kib|mib|gib|kb|mb|gb|usd|dollars?|tokens?|runs?|s|m|h|b)?\b/g;
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    const rawNum = Number(match[2]);
    if (!Number.isFinite(rawNum)) continue;
    const boundWord = match[1] || '';
    const unit = (match[3] || '').toLowerCase();
    let unitKind = unit || 'scalar';
    let value = rawNum;
    if (TIME_MULTIPLIERS[unit]) {
      unitKind = 'time_ms';
      value = rawNum * TIME_MULTIPLIERS[unit];
    } else if (SIZE_MULTIPLIERS[unit]) {
      unitKind = 'bytes';
      value = rawNum * SIZE_MULTIPLIERS[unit];
    } else if (['usd', 'dollar', 'dollars'].includes(unit)) {
      unitKind = 'usd';
    } else if (['token', 'tokens'].includes(unit)) {
      unitKind = 'tokens';
    } else if (['run', 'runs'].includes(unit)) {
      unitKind = 'runs';
    }
    const start = Math.max(0, match.index - 40);
    const end = Math.min(normalized.length, match.index + match[0].length + 24);
    const around = tokenizeNormalized(normalized.slice(start, end))
      .filter(t => !/^-?\d+(?:\.\d+)?$/.test(t) && t !== 'min_bound' && t !== 'max_bound' && !TIME_MULTIPLIERS[t] && !SIZE_MULTIPLIERS[t]);
    constraints.push({
      value,
      rawNum,
      unitKind,
      comparator: boundWord === 'min_bound' ? 'min' : boundWord === 'max_bound' ? 'max' : 'eq',
      contextTokens: [...new Set(around)],
    });
  }
  return constraints;
}

function extractPathLiterals(rawText) {
  const matches = String(rawText || '').match(/(?:[a-zA-Z]:[\\/][^\s,;'"`]+|\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]*)/g);
  return (matches || []).map(p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
}

const KEY_NAMESPACE_PREFIXES = new Set([
  'git', 'project', 'user', 'policy', 'exec', 'command', 'tooling', 'ci', 'reply', 'deploy', 'app', 'runtime',
]);

function buildFactSignals(fact) {
  const opaqueKey = isOpaqueGeneratedKey(fact.factKey);
  const rawKeyTokens = opaqueKey ? [] : tokenizeNormalized(fact.factKey);
  const strippedKeyTokens = rawKeyTokens.filter((tok, idx) => !(idx === 0 && KEY_NAMESPACE_PREFIXES.has(tok) && rawKeyTokens.length > 1));
  const keyTokens = [...new Set(strippedKeyTokens)];
  const valueTokensAll = tokenizeNormalized(fact.factValue, { dropStopwords: false });
  const valueTokens = valueTokensAll.filter(t => !STOPWORDS.has(t));

  let polarity = 0;
  let negHits = 0;
  let posHits = 0;
  for (const tok of valueTokensAll) {
    if (NEGATION_WORDS.has(tok)) negHits += 1;
    if (AFFIRMATION_WORDS.has(tok)) posHits += 1;
  }
  if (negHits > 0 && posHits === 0) polarity = -1;
  else if (posHits > 0 && negHits === 0) polarity = 1;
  else if (negHits > posHits) polarity = -1;

  const antonymPoles = new Map();
  const tokenSet = new Set([...keyTokens, ...valueTokens]);
  for (const [dim, poleA, poleB] of ANTONYM_PAIRS) {
    if (tokenSet.has(poleA) && !tokenSet.has(poleB)) antonymPoles.set(dim, poleA);
    else if (tokenSet.has(poleB) && !tokenSet.has(poleA)) antonymPoles.set(dim, poleB);
  }

  const exclusiveValues = new Map();
  for (const tok of valueTokens) {
    const domain = EXCLUSIVE_DOMAINS.get(tok);
    if (domain) {
      const set = exclusiveValues.get(domain) || new Set();
      set.add(tok);
      exclusiveValues.set(domain, set);
    }
  }
  const paths = extractPathLiterals(fact.factValue);
  if (paths.length) {
    exclusiveValues.set('path', new Set(paths));
  }

  const subjectTokens = new Set([
    ...keyTokens,
    ...valueTokens.filter(t => !NEGATION_WORDS.has(t) && !AFFIRMATION_WORDS.has(t) && !EXCLUSIVE_DOMAINS.has(t) && !/^\d+(?:\.\d+)?$/.test(t)),
  ]);
  for (const [, poleA, poleB] of ANTONYM_PAIRS) {
    subjectTokens.delete(poleA);
    subjectTokens.delete(poleB);
  }

  return {
    opaqueKey,
    normalizedKey: opaqueKey ? '' : normalizeIdentifierText(fact.factKey),
    canonicalKeySig: keyTokens.slice().sort().join(' '),
    normalizedValue: String(fact.factValue || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(),
    keyTokens: new Set(keyTokens),
    subjectTokens,
    polarity,
    antonymPoles,
    exclusiveValues,
    numericConstraints: extractNumericConstraints(`${opaqueKey ? '' : `${fact.factKey} `}${fact.factValue}`),
  };
}

function tokenOverlap(setA, setB) {
  if (!setA.size || !setB.size) return { shared: [], jaccard: 0, minRatio: 0 };
  const shared = [];
  for (const item of setA) {
    if (setB.has(item)) shared.push(item);
  }
  const unionSize = setA.size + setB.size - shared.length;
  const minSize = Math.min(setA.size, setB.size);
  return {
    shared,
    jaccard: unionSize > 0 ? shared.length / unionSize : 0,
    minRatio: minSize > 0 ? shared.length / minSize : 0,
  };
}

function classifyPairConflict(factA, sigA, factB, sigB) {
  if (sigA.normalizedValue === sigB.normalizedValue) return null;

  const isCrossLayer = factA.layer !== factB.layer;
  const involvesUserRule = factA.sourceType === 'user_rule' || factB.sourceType === 'user_rule';
  const involvesModelOrProject = factA.layer === 'project' || factB.layer === 'project'
    || factA.sourceType === 'model_inferred' || factB.sourceType === 'model_inferred'
    || factA.sourceType === 'external_untrusted' || factB.sourceType === 'external_untrusted';
  const policyTension = factA.layer === 'responsibility_policy' || factB.layer === 'responsibility_policy';

  const decorate = (reasonCode, baseReason, score) => {
    let kind = 'semantic_conflict';
    if (policyTension) kind = 'policy_vs_memory_tension';
    else if (isCrossLayer || (involvesUserRule && involvesModelOrProject)) kind = 'cross_layer_conflict';
    else if (reasonCode === 'same_key_divergence') kind = 'possible_conflict';
    const authorityNote = involvesUserRule && involvesModelOrProject
      ? ' (cross-layer user_rule vs project/inferred tension; human review required)'
      : policyTension
        ? ' (Responsibility policy is read-only; review memory fact)'
        : ' (candidate flagged for human review only)';
    return {
      kind,
      reasonCode,
      conflictReason: `${baseReason}${authorityNote}`,
      confidenceScore: score,
      crossLayer: isCrossLayer,
      authorityTension: Boolean(involvesUserRule && involvesModelOrProject),
      policyTension,
    };
  };

  if (!sigA.opaqueKey && !sigB.opaqueKey && sigA.normalizedKey && sigA.normalizedKey === sigB.normalizedKey) {
    return decorate('same_key_divergence', `Same key '${factA.factKey}' has diverging values`, 0.98);
  }

  const keyOverlap = tokenOverlap(sigA.keyTokens, sigB.keyTokens);
  const subjectOverlap = tokenOverlap(sigA.subjectTokens, sigB.subjectTokens);
  const sharedTopic = keyOverlap.shared.length >= 1 || subjectOverlap.minRatio >= 0.45 || subjectOverlap.shared.length >= 2;

  for (const numA of sigA.numericConstraints) {
    for (const numB of sigB.numericConstraints) {
      if (numA.unitKind !== numB.unitKind) continue;
      const metricOverlap = tokenOverlap(new Set(numA.contextTokens), new Set(numB.contextTokens));
      const sameMetric = metricOverlap.shared.length >= 1 || keyOverlap.shared.length >= 1;
      if (!sameMetric) continue;
      const label = metricOverlap.shared[0] || keyOverlap.shared[0] || numA.unitKind;
      if (numA.comparator === 'eq' && numB.comparator === 'eq' && numA.value !== numB.value) {
        return decorate('numeric_constraint_conflict', `Contradictory numeric values for '${label}': ${numA.rawNum} vs ${numB.rawNum}`, 0.91);
      }
      if ((numA.comparator === 'min' && numB.comparator === 'max' && numA.value > numB.value)
        || (numB.comparator === 'min' && numA.comparator === 'max' && numB.value > numA.value)) {
        return decorate('numeric_constraint_conflict', `Impossible numeric bounds for '${label}': min > max`, 0.92);
      }
      if ((numA.comparator === 'eq' && numB.comparator === 'max' && numA.value > numB.value)
        || (numB.comparator === 'eq' && numA.comparator === 'max' && numB.value > numA.value)
        || (numA.comparator === 'eq' && numB.comparator === 'min' && numA.value < numB.value)
        || (numB.comparator === 'eq' && numA.comparator === 'min' && numB.value < numA.value)) {
        return decorate('numeric_constraint_conflict', `Numeric value violates constraint bound for '${label}'`, 0.9);
      }
    }
  }

  if (sharedTopic && sigA.polarity !== 0 && sigB.polarity !== 0 && sigA.polarity !== sigB.polarity) {
    const topicLabel = [...new Set([...keyOverlap.shared, ...subjectOverlap.shared])].slice(0, 4).join(', ');
    return decorate('negation_contradiction', `Opposing affirmative/negative policy on '${topicLabel}'`, 0.89);
  }

  for (const [dim, poleA] of sigA.antonymPoles) {
    const poleB = sigB.antonymPoles.get(dim);
    if (poleB && poleA !== poleB && (sharedTopic || ['verbosity', 'writability', 'theme', 'order'].includes(dim))) {
      return decorate('antonym_policy_divergence', `Opposing ${dim} setting: '${poleA}' vs '${poleB}'`, 0.88);
    }
  }

  if (sigA.canonicalKeySig && sigB.canonicalKeySig && sigA.canonicalKeySig === sigB.canonicalKeySig) {
    return decorate('normalized_key_divergence', `Normalized subject/attribute '${sigA.canonicalKeySig}' diverges across keys '${factA.factKey}' and '${factB.factKey}'`, 0.94);
  }

  for (const [domain, valsA] of sigA.exclusiveValues) {
    const valsB = sigB.exclusiveValues.get(domain);
    if (!valsB) continue;
    const hasCommon = [...valsA].some(v => valsB.has(v));
    if (hasCommon && valsA.size === 1 && valsB.size === 1) continue;
    const allSame = valsA.size === valsB.size && [...valsA].every(v => valsB.has(v));
    if (allSame) continue;
    const domainMatched = sharedTopic || sigA.subjectTokens.has(domain) || sigB.subjectTokens.has(domain) || domain === 'package_manager' || domain === 'language' || domain === 'timezone' || domain === 'git_strategy';
    if (domainMatched) {
      return decorate('exclusive_value_divergence', `Diverging ${domain} values: [${[...valsA].join(', ')}] vs [${[...valsB].join(', ')}]`, 0.87);
    }
  }

  return null;
}

function deriveProjectFactSourceType(fact, provenanceRows, governanceRow) {
  if (governanceRow?.sourceType) return governanceRow.sourceType;
  const matching = provenanceRows.filter(p => p.factId === fact.factId && p.factVersion === fact.currentVersion);
  const rows = matching.length ? matching : provenanceRows.filter(p => p.factId === fact.factId);
  if (rows.some(r => r.provider === 'user')) return 'user_rule';
  if (rows.some(r => r.provider === 'tool' || r.provider === 'workspace')) return 'tool_verified';
  if (rows.some(r => UNTRUSTED_ORIGIN_TOKENS.has(String(r.provider || '').toLowerCase()))) return 'external_untrusted';
  return 'model_inferred';
}

function deriveProjectFactSourceRef(fact, provenanceRows, governanceRow, projectId, memoryVersion) {
  if (governanceRow?.sourceRef) return governanceRow.sourceRef;
  const matching = provenanceRows.filter(p => p.factId === fact.factId && p.factVersion === fact.currentVersion);
  const first = matching[0] || provenanceRows.find(p => p.factId === fact.factId);
  if (first?.sessionId || first?.runId) {
    return `session:${first.sessionId || 'unknown'}/run:${first.runId || 'unknown'}#${first.sourceEventStart || 0}-${first.sourceEventEnd || 0}`;
  }
  return `project:${projectId}:v${memoryVersion}:${fact.factId}`;
}

function buildPolicyFacts(responsibility, policy) {
  if (!policy) return [];
  const base = {
    layer: 'responsibility_policy',
    readOnly: true,
    sourceType: 'user_rule',
    sourceRef: `responsibility:${responsibility.id}:policy:v${responsibility.policyRevision}`,
    confidence: 1.0,
    validUntil: policy.validUntil || null,
    version: responsibility.policyRevision,
    state: 'active',
    status: 'active',
    scope: { type: 'responsibility', projectId: responsibility.projectId, responsibilityId: responsibility.id },
    updatedAt: responsibility.updatedAt,
    sources: [],
  };
  const items = [];
  if (policy.resource?.networkPolicy) {
    items.push({
      ...base,
      factId: 'policy:networkPolicy',
      factKey: 'policy.network_policy',
      factValue: policy.resource.networkPolicy === 'deny'
        ? 'network access is denied (forbid network access)'
        : 'network access inherits existing permissions',
    });
  }
  if (policy.targetBranch) {
    items.push({
      ...base,
      factId: 'policy:targetBranch',
      factKey: 'policy.target_branch',
      factValue: `target branch is ${policy.targetBranch}`,
    });
  }
  if (policy.dailyBudget?.maxCost !== undefined) {
    items.push({
      ...base,
      factId: 'policy:dailyBudget.maxCost',
      factKey: 'policy.budget_limit',
      factValue: `daily budget limit is ${policy.dailyBudget.maxCost} usd`,
    });
  }
  if (policy.dailyBudget?.timeZone) {
    items.push({
      ...base,
      factId: 'policy:dailyBudget.timeZone',
      factKey: 'policy.timezone',
      factValue: `timezone is ${policy.dailyBudget.timeZone}`,
    });
  }
  if (Array.isArray(policy.allowedPaths) && policy.allowedPaths.length) {
    items.push({
      ...base,
      factId: 'policy:allowedPaths',
      factKey: 'policy.allowed_paths',
      factValue: `allowed paths are ${policy.allowedPaths.join(', ')}`,
    });
  }
  return items;
}

export async function listProjectMemoryFactGovernance(projectId) {
  const normalizedProjectId = text(projectId, 160);
  if (!normalizedProjectId) return { schemaVersion: 1, byFactId: {} };
  return read(db => {
    ensureGovernanceSchemaSync(db);
    const rows = db.prepare('SELECT * FROM responsibility_memory_fact_governance WHERE project_id=?').all(normalizedProjectId);
    const byFactId = {};
    for (const r of rows) {
      byFactId[r.fact_id] = {
        projectId: r.project_id,
        factId: r.fact_id,
        factVersion: Number(r.fact_version || 1),
        validUntil: r.valid_until || null,
        supersededByFactId: r.superseded_by_fact_id || null,
        supersededByLayer: r.superseded_by_layer || null,
        sourceType: r.source_type || null,
        sourceRef: r.source_ref || null,
        confidence: r.confidence !== null && r.confidence !== undefined ? Number(r.confidence) : null,
        actorId: r.actor_id,
        updatedAt: r.updated_at,
      };
    }
    return { schemaVersion: 1, byFactId };
  });
}

function conflictSignature(facts) {
  return hashJson(facts.map(f => ({
    layer: f.layer || 'project',
    factId: f.factId,
    version: f.version ?? f.currentVersion ?? 1,
    value: f.factValue,
    state: f.state || f.status || 'active',
    validUntil: f.validUntil || null,
  })).sort((a, b) => `${a.layer}:${a.factId}`.localeCompare(`${b.layer}:${b.factId}`)));
}

function normalizeConflictChangeItem(raw, factLookup) {
  const factId = text(raw?.factId, 120);
  if (!factId) throw error('Invalid conflict factId');
  let action = text(raw?.action, 40);
  if (action === 'setValidUntil') action = 'set_valid_until';
  if (!['keep', 'correct', 'retract', 'supersede', 'set_valid_until'].includes(action)) {
    throw error(`Unsupported conflict resolution action '${action}'`);
  }
  const explicitLayer = text(raw?.layer, 40);
  const candidates = factLookup.filter(f => f.factId === factId);
  let layer = explicitLayer;
  if (!layer) {
    if (candidates.length === 1) layer = candidates[0].layer;
    else if (candidates.some(f => f.layer === 'project') && !candidates.some(f => f.layer === 'user')) layer = 'project';
    else if (candidates.some(f => f.layer === 'user') && !candidates.some(f => f.layer === 'project')) layer = 'user';
    else throw error(`Ambiguous or unknown layer for fact '${factId}'`);
  }
  if (!['project', 'user', 'responsibility_policy'].includes(layer)) {
    throw error(`Invalid memory layer '${layer}'`);
  }
  if (layer === 'responsibility_policy' && action !== 'keep') {
    throw error('Responsibility policy cannot be altered via memory conflict resolution', 403, 'RESPONSIBILITY_POLICY_PROTECTED');
  }
  const value = typeof raw?.value === 'string' ? raw.value.trim() : '';
  if (action === 'correct' && (!value || value.length > 1200)) {
    throw error('Corrected fact value must be between 1 and 1200 characters');
  }
  if (action === 'supersede' && value.length > 1200) {
    throw error('Replacement value must be at most 1200 characters');
  }
  let validUntil = null;
  if (action === 'set_valid_until') {
    const rawValidUntil = text(raw?.validUntil, 80);
    const parsed = Date.parse(rawValidUntil);
    if (!rawValidUntil || !Number.isFinite(parsed)) {
      throw error('Valid ISO validUntil timestamp is required for set_valid_until');
    }
    validUntil = new Date(parsed).toISOString();
  }
  const supersededByFactId = text(raw?.supersededByFactId, 120) || null;
  const expectedVersion = Number.isSafeInteger(raw?.expectedVersion) ? raw.expectedVersion : null;
  const reason = text(raw?.reason, 500);
  return {
    layer,
    factId,
    action,
    value: (action === 'correct' || action === 'supersede') ? value : '',
    validUntil,
    supersededByFactId,
    expectedVersion,
    reason,
  };
}

function normalizeConflictResolutionInput(input, factLookup = []) {
  assertNoPolicyMutationInPayload(input);
  if (!Array.isArray(input?.factIds) || input.factIds.length < 2 || input.factIds.length > 20
    || !Array.isArray(input?.changes) || input.changes.length !== input.factIds.length) {
    throw error('Select two to twenty facts');
  }
  const normalizedChanges = input.changes.map(c => normalizeConflictChangeItem(c, factLookup));
  const sortedChanges = normalizedChanges.slice().sort((a, b) => `${a.layer}:${a.factId}`.localeCompare(`${b.layer}:${b.factId}`));
  const seenKeys = new Set(sortedChanges.map(c => `${c.layer}:${c.factId}`));
  if (seenKeys.size !== sortedChanges.length) {
    throw error('Duplicate fact selection in conflict changes');
  }
  const inputSortedIds = input.factIds.map(id => text(id, 120)).sort();
  const changeSortedIds = sortedChanges.map(c => c.factId).sort();
  if (inputSortedIds.some((id, idx) => !id || id !== changeSortedIds[idx])) {
    throw error('Conflict factIds do not match changes');
  }
  return sortedChanges;
}

async function collectConflictGovernanceContext(id, actor, stores = {}) {
  const projectMemoryStore = stores.projectMemoryStore || defaultProjectMemoryStore;
  const userMemoryStore = stores.userMemoryStore || defaultUserMemoryStore;
  const { responsibility, policy } = await getResponsibility(id, actor);
  const nowMs = Date.now();
  const [memory, userRes, govRes, govReviews] = await Promise.all([
    projectMemoryStore.getProjectMemory(responsibility.projectId),
    userMemoryStore.listUserMemoryFacts({
      ownerPrincipalId: responsibility.ownerPrincipalId,
      projectId: responsibility.projectId,
      responsibilityId: responsibility.id,
      status: 'active',
      includeExpired: false,
      includeUntrusted: true,
      limit: 300,
    }, { actor }),
    listProjectMemoryFactGovernance(responsibility.projectId),
    read(db => {
      ensureGovernanceSchemaSync(db);
      return db.prepare('SELECT * FROM responsibility_memory_conflict_reviews WHERE responsibility_id=?').all(id);
    }),
  ]);

  let projectFactsRaw = [];
  let provenanceRows = [];
  let projectReviews = [];
  if (memory) {
    [projectFactsRaw, projectReviews, provenanceRows] = await Promise.all([
      projectMemoryStore.listCurrentFacts(responsibility.projectId),
      projectMemoryStore.listConflictReviews(responsibility.projectId),
      projectMemoryStore.getFactProvenance(responsibility.projectId, memory.currentVersion),
    ]);
  }

  const projectFacts = [];
  for (const fact of projectFactsRaw.slice(0, 300)) {
    if (fact.state !== 'active' || !fact.factValue || !fact.factKey) continue;
    const rawGov = govRes.byFactId[fact.factId] || null;
    const gov = rawGov && (!rawGov.factVersion || Number(rawGov.factVersion) === Number(fact.currentVersion || 0)) ? rawGov : null;
    if (gov?.validUntil && Date.parse(gov.validUntil) <= nowMs) continue;
    const sourceType = deriveProjectFactSourceType(fact, provenanceRows, gov);
    const sourceRef = deriveProjectFactSourceRef(fact, provenanceRows, gov, responsibility.projectId, memory?.currentVersion || 0);
    const matchingSources = provenanceRows.filter(p => p.factId === fact.factId && p.factVersion === fact.currentVersion);
    projectFacts.push({
      ...fact,
      layer: 'project',
      version: fact.currentVersion,
      status: fact.state,
      sourceType,
      sourceRef,
      confidence: gov?.confidence ?? (sourceType === 'user_rule' ? 1.0 : sourceType === 'tool_verified' ? 0.9 : 0.65),
      validUntil: gov?.validUntil || null,
      scope: { type: 'project', projectId: responsibility.projectId, responsibilityId: null },
      sources: matchingSources,
    });
  }

  const userFacts = (userRes.facts || []).slice(0, 300).map(u => ({
    factId: u.id,
    factKey: u.factKey,
    factValue: u.factValue,
    currentVersion: u.version,
    version: u.version,
    state: u.status,
    status: u.status,
    category: u.category,
    layer: 'user',
    sourceType: u.sourceType,
    sourceRef: u.sourceRef,
    confidence: u.confidence,
    validUntil: u.validUntil || null,
    scope: u.scope,
    updatedAt: u.updatedAt,
    sources: [{ sourceType: u.sourceType, sourceRef: u.sourceRef, confidence: u.confidence, validUntil: u.validUntil || null }],
  }));

  const policyFacts = buildPolicyFacts(responsibility, policy);

  return {
    responsibility,
    policy,
    memory,
    projectFacts,
    userFacts,
    policyFacts,
    allFacts: [...userFacts, ...projectFacts, ...policyFacts],
    projectReviews,
    govReviews,
    truncated: projectFactsRaw.length > 300 || userRes.truncated,
  };
}

export async function listResponsibilityMemoryConflicts(id, actor, options = {}) {
  const ctx = await collectConflictGovernanceContext(id, actor, options.stores);
  const { responsibility, memory, projectFacts, userFacts, allFacts, projectReviews, govReviews, truncated } = ctx;

  // Verify snapshot consistency against concurrent edits
  const projectMemoryStore = options.stores?.projectMemoryStore || defaultProjectMemoryStore;
  const latestMemory = await projectMemoryStore.getProjectMemory(responsibility.projectId);
  const checked = await getResponsibility(id, actor);
  if ((latestMemory?.currentVersion || 0) !== (memory?.currentVersion || 0)
    || (latestMemory?.digest || '') !== (memory?.digest || '')
    || checked.responsibility.rowVersion !== responsibility.rowVersion) {
    throw error('Memory or responsibility changed', 409, 'RESPONSIBILITY_CONFLICT');
  }

  const groups = [];
  const seenPairs = new Set();

  // 1. Preserve exact same-key bucket detection in Project Memory
  const projectBuckets = new Map();
  for (const fact of projectFacts) {
    const key = fact.factKey.normalize('NFKC').trim().toLowerCase();
    if (!key) continue;
    const list = projectBuckets.get(key) || [];
    list.push(fact);
    projectBuckets.set(key, list);
  }
  for (const [factKey, all] of projectBuckets) {
    const selected = all.slice(0, 20);
    if (selected.length < 2 || new Set(selected.map(f => f.factValue.trim().replace(/\s+/g, ' '))).size < 2) continue;
    const ids = selected.map(f => f.factId).sort();
    const memberKeys = selected.map(f => `${f.layer}:${f.factId}`).sort();
    const bucketGroupId = hashJson(memberKeys);
    const legacyReview = projectReviews.find(r => r.groupKey === hashJson(ids));
    const govReview = govReviews.find(r => r.group_id === bucketGroupId || r.group_id === hashJson(ids));
    const sig = conflictSignature(selected);
    const legacySig = hashJson(selected.map(f => ({ factId: f.factId, version: f.currentVersion, value: f.factValue, state: f.state })).sort((a, b) => a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
    const reviewed = Boolean((legacyReview && legacyReview.factSignature === legacySig) || (govReview && govReview.fact_signature === sig));
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        const pairKey = [selected[i], selected[j]].map(f => `${f.layer}:${f.factId}`).sort().join('|');
        seenPairs.add(pairKey);
      }
    }
    groups.push({
      groupId: hashJson(ids),
      factKey,
      kind: 'possible_conflict',
      reasonCode: 'same_key_divergence',
      conflictReason: `Multiple active project facts share key '${factKey}' with diverging values (candidate flagged for human review only)`,
      confidenceScore: 0.98,
      layers: ['project'],
      crossLayer: false,
      authorityTension: false,
      policyTension: false,
      requiresHumanReview: true,
      autoResolved: false,
      reviewed,
      truncated: all.length > 20,
      facts: selected,
    });
  }

  // 2. Deterministic semantic & cross-layer candidate conflict detection across all active layers
  const signals = allFacts.map(f => buildFactSignals(f));
  const semanticCandidates = [];
  for (let i = 0; i < allFacts.length; i++) {
    for (let j = i + 1; j < allFacts.length; j++) {
      const a = allFacts[i];
      const b = allFacts[j];
      if (a.layer === 'responsibility_policy' && b.layer === 'responsibility_policy') continue;
      const pairKey = [`${a.layer}:${a.factId}`, `${b.layer}:${b.factId}`].sort().join('|');
      if (seenPairs.has(pairKey)) continue;
      const match = classifyPairConflict(a, signals[i], b, signals[j]);
      if (!match) continue;
      seenPairs.add(pairKey);
      const pairFacts = [a, b];
      const memberKeys = pairFacts.map(f => `${f.layer}:${f.factId}`).sort();
      const groupId = hashJson(memberKeys);
      const sig = conflictSignature(pairFacts);
      const govReview = govReviews.find(r => r.group_id === groupId);
      const entry = {
        groupId,
        factKey: `${a.factKey} <-> ${b.factKey}`,
        kind: match.kind,
        reasonCode: match.reasonCode,
        conflictReason: match.conflictReason,
        confidenceScore: match.confidenceScore,
        layers: [...new Set([a.layer, b.layer])],
        crossLayer: match.crossLayer,
        authorityTension: match.authorityTension,
        policyTension: match.policyTension,
        requiresHumanReview: true,
        autoResolved: false,
        reviewed: Boolean(govReview && govReview.fact_signature === sig),
        truncated: false,
        facts: pairFacts,
      };
      semanticCandidates.push(entry);
      groups.push(entry);
      if (groups.length >= 100) break;
    }
    if (groups.length >= 100) break;
  }

  return {
    schemaVersion: 1,
    version: memory?.currentVersion || 0,
    projectVersion: memory?.currentVersion || 0,
    userFactVersions: Object.fromEntries(userFacts.map(f => [f.factId, f.version])),
    groups: groups.slice(0, 100),
    semanticCandidates: semanticCandidates.slice(0, 100),
    truncated: truncated || groups.length >= 100,
  };
}

export async function previewResponsibilityMemoryConflict(id, input, actor, options = {}) {
  const projectMemoryStore = options.stores?.projectMemoryStore || defaultProjectMemoryStore;
  const ctx = await collectConflictGovernanceContext(id, actor, options.stores);
  const { responsibility, memory, projectFacts, allFacts } = ctx;
  const changes = normalizeConflictResolutionInput(input, allFacts);

  const touchesProjectMutation = changes.some(c => c.layer === 'project' && c.action !== 'keep');
  const touchesProject = changes.some(c => c.layer === 'project');
  const expectedProjectVersion = Number.isSafeInteger(input?.expectedProjectVersion)
    ? input.expectedProjectVersion
    : (Number.isSafeInteger(input?.expectedVersion) ? input.expectedVersion : (memory?.currentVersion || 0));

  if (touchesProject) {
    if (!memory || expectedProjectVersion < 1 || memory.currentVersion !== expectedProjectVersion) {
      throw error('Memory version changed', 409, 'RESPONSIBILITY_CONFLICT');
    }
  }

  const selectedFacts = [];
  const expectedUserFactVersions = {};
  const expectedProjectFactVersions = {};
  for (const c of changes) {
    const matched = allFacts.find(f => f.layer === c.layer && f.factId === c.factId);
    if (!matched || (matched.state !== 'active' && matched.status !== 'active')) {
      throw error('Conflict facts changed', 409, 'RESPONSIBILITY_CONFLICT');
    }
    if (c.layer === 'user') {
      if (c.expectedVersion !== null && c.expectedVersion !== matched.version) {
        throw error(`User memory fact '${c.factId}' version changed`, 409, 'USER_MEMORY_VERSION_CONFLICT');
      }
      if (c.action !== 'keep') {
        await guardMemoryWriteInput(
          {
            factValue: c.value,
            validUntil: c.validUntil,
            reason: c.reason,
            sourceType: matched.sourceType,
            category: matched.category,
            originType: input?.originType,
            provenanceKind: input?.provenanceKind,
            sourceKind: input?.sourceKind,
            untrusted: input?.untrusted,
          },
          matched,
          actor,
          { responsibilityId: id, projectId: responsibility.projectId, operation: `conflict_preview_${c.action}`, layer: 'user' },
        );
      }
      expectedUserFactVersions[c.factId] = matched.version;
    } else if (c.layer === 'project') {
      if (c.expectedVersion !== null && c.expectedVersion !== matched.currentVersion) {
        throw error(`Project memory fact '${c.factId}' version changed`, 409, 'RESPONSIBILITY_CONFLICT');
      }
      expectedProjectFactVersions[c.factId] = matched.currentVersion;
    }
    selectedFacts.push(matched);
  }

  // Re-verify no concurrent change while assembling preview
  const latestMemory = await projectMemoryStore.getProjectMemory(responsibility.projectId);
  const checked = await getResponsibility(id, actor);
  if ((latestMemory?.currentVersion || 0) !== (memory?.currentVersion || 0)
    || (latestMemory?.digest || '') !== (memory?.digest || '')
    || checked.responsibility.rowVersion !== responsibility.rowVersion) {
    throw error('Memory or responsibility changed', 409, 'RESPONSIBILITY_CONFLICT');
  }

  const projectChanged = touchesProjectMutation && changes.some(c =>
    c.layer === 'project' && (
      ['correct', 'retract', 'supersede'].includes(c.action)
      || (c.action === 'set_valid_until' && Date.parse(c.validUntil) <= Date.now())
    ),
  );
  const visibleProject = projectFacts.map(f => {
    const c = changes.find(x => x.layer === 'project' && x.factId === f.factId);
    if (!c || c.action === 'keep') return f;
    if (c.action === 'correct') return { ...f, state: 'active', factValue: c.value };
    if (c.action === 'supersede') return { ...f, state: c.value ? 'active' : 'invalidated', factValue: c.value || '' };
    if (c.action === 'set_valid_until') {
      const expired = Date.parse(c.validUntil) <= Date.now();
      return expired ? { ...f, state: 'invalidated', factValue: '' } : { ...f, validUntil: c.validUntil };
    }
    return { ...f, state: 'invalidated', factValue: '' };
  }).filter(f => f.state === 'active' && f.factValue);
  const lines = visibleProject.map(f => `- ${f.factValue}`).join('\n') || 'No active structured facts.';

  const projectedUserFacts = selectedFacts
    .filter(f => f.layer === 'user')
    .map(f => {
      const c = changes.find(x => x.layer === 'user' && x.factId === f.factId);
      if (!c || c.action === 'keep') return { factId: f.factId, nextStatus: 'active', factValue: f.factValue, validUntil: f.validUntil };
      if (c.action === 'correct') return { factId: f.factId, nextStatus: 'active', factValue: c.value, validUntil: f.validUntil };
      if (c.action === 'retract') return { factId: f.factId, nextStatus: 'retracted', factValue: f.factValue, validUntil: f.validUntil };
      if (c.action === 'supersede') return { factId: f.factId, nextStatus: c.value ? 'superseded_with_replacement' : 'retracted_as_superseded', replacementValue: c.value || null, supersededByFactId: c.supersededByFactId || null };
      if (c.action === 'set_valid_until') return { factId: f.factId, nextStatus: 'active', factValue: f.factValue, validUntil: c.validUntil };
      return { factId: f.factId, nextStatus: f.status };
    });

  const createdAt = now();
  const payload = {
    responsibilityId: id,
    responsibilityVersion: responsibility.rowVersion,
    projectId: responsibility.projectId,
    ownerPrincipalId: responsibility.ownerPrincipalId,
    actorId: actor.principalId,
    expectedVersion: memory?.currentVersion || 0,
    expectedProjectVersion: memory?.currentVersion || 0,
    expectedProjectFactVersions,
    expectedUserFactVersions,
    previousContentDigest: memory?.digest || '',
    previousSummary: memory?.summary || '',
    facts: selectedFacts,
    changes,
    projectedContent: projectChanged ? `# Project Memory\n\n${lines}` : (memory?.content || ''),
    projectedSummary: projectChanged ? `v${(memory?.currentVersion || 0) + 1}\n${lines}` : (memory?.summary || ''),
    projectedUserFacts,
    crossStore: changes.some(c => c.layer === 'project') && changes.some(c => c.layer === 'user'),
    createdAt,
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
  };
  const previewDigest = digest(payload);
  await transaction(db => {
    ensureGovernanceSchemaSync(db);
    db.prepare('INSERT OR IGNORE INTO responsibility_memory_previews VALUES(?,?,?,?,?)').run(previewDigest, actor.principalId, id, JSON.stringify(payload), createdAt);
  });
  return { schemaVersion: 1, preview: payload, previewDigest };
}

function resolveProjectMutationChange(change, allFacts) {
  if (change.action === 'keep' || change.action === 'correct' || change.action === 'retract') {
    return { factId: change.factId, action: change.action, value: change.value };
  }
  if (change.action === 'supersede') {
    if (change.value) {
      return { factId: change.factId, action: 'correct', value: change.value };
    }
    return { factId: change.factId, action: 'retract', value: '' };
  }
  if (change.action === 'set_valid_until') {
    if (Date.parse(change.validUntil) <= Date.now()) {
      return { factId: change.factId, action: 'retract', value: '' };
    }
    return { factId: change.factId, action: 'keep', value: '' };
  }
  return { factId: change.factId, action: 'keep', value: '' };
}

async function applyUserChangesInDb(db, { userMemoryStore, userChanges, previewPayload, ownerPrincipalId, actor, idempotencyKey, ts }) {
  const userResults = [];
  const winnerCandidate = previewPayload.changes.find(c => c.action === 'keep' || c.action === 'correct');
  for (const c of userChanges) {
    const expectedVer = previewPayload.expectedUserFactVersions?.[c.factId];
    const subKey = `${idempotencyKey}:um:${c.factId}`;
    const opts = { actor, now: ts, ...(userMemoryStore.databasePath ? {} : { db }) };
    if (c.action === 'keep') {
      userResults.push({ factId: c.factId, action: 'keep', version: expectedVer });
      continue;
    }
    if (c.action === 'correct') {
      const res = await userMemoryStore.reviseUserMemoryFact({
        ownerPrincipalId,
        factId: c.factId,
        expectedVersion: expectedVer,
        idempotencyKey: subKey,
        factValue: c.value,
        action: 'correct',
        reason: c.reason || 'Owner conflict correction',
      }, opts);
      userResults.push({ factId: c.factId, action: 'correct', version: res.fact.version, replayed: res.replayed });
    } else if (c.action === 'retract') {
      const res = await userMemoryStore.retractUserMemoryFact({
        ownerPrincipalId,
        factId: c.factId,
        expectedVersion: expectedVer,
        idempotencyKey: subKey,
        reason: c.reason || 'Owner conflict retraction',
      }, opts);
      userResults.push({ factId: c.factId, action: 'retract', version: res.fact.version, replayed: res.replayed });
    } else if (c.action === 'supersede') {
      if (c.value) {
        const priorFact = previewPayload.facts.find(f => f.layer === 'user' && f.factId === c.factId);
        const res = await userMemoryStore.supersedeUserMemoryFact({
          ownerPrincipalId,
          factId: c.factId,
          expectedVersion: expectedVer,
          idempotencyKey: subKey,
          reason: c.reason || 'Owner conflict supersede',
          replacement: {
            factValue: c.value,
            factKey: priorFact?.factKey,
            category: priorFact?.category || 'preference',
            sourceType: priorFact?.sourceType === 'user_rule' ? 'user_rule' : 'user_rule',
            sourceRef: `owner_conflict_resolution:${idempotencyKey}`,
            scope: priorFact?.scope,
            validUntil: priorFact?.validUntil || null,
          },
        }, opts);
        userResults.push({
          factId: c.factId,
          action: 'supersede',
          version: res.supersededFact.version,
          newFactId: res.newFact.id,
          replayed: res.replayed,
        });
      } else {
        const winnerId = c.supersededByFactId || winnerCandidate?.factId || 'owner_resolution';
        const res = await userMemoryStore.retractUserMemoryFact({
          ownerPrincipalId,
          factId: c.factId,
          expectedVersion: expectedVer,
          idempotencyKey: subKey,
          reason: c.reason || `Superseded by ${winnerId}`,
        }, opts);
        userResults.push({
          factId: c.factId,
          action: 'supersede',
          supersededByFactId: winnerId,
          version: res.fact.version,
          replayed: res.replayed,
        });
      }
    } else if (c.action === 'set_valid_until') {
      const res = await userMemoryStore.setUserMemoryValidUntil({
        ownerPrincipalId,
        factId: c.factId,
        expectedVersion: expectedVer,
        validUntil: c.validUntil,
        idempotencyKey: subKey,
        reason: c.reason || 'Owner conflict validUntil update',
      }, opts);
      userResults.push({ factId: c.factId, action: 'set_valid_until', validUntil: c.validUntil, version: res.fact.version, replayed: res.replayed });
    }
  }
  return userResults;
}

function finalizeResolutionAuditSync(db, { journalId, responsibilityId, projectId, ownerPrincipalId, actorId, idempotencyKey, previewDigest, previewPayload, projectVersion, projectResult, userResults, ts, isRecovery = false }) {
  const winnerCandidate = previewPayload.changes.find(c => c.action === 'keep' || c.action === 'correct');
  for (const c of previewPayload.changes) {
    const priorFact = previewPayload.facts.find(f => f.layer === c.layer && f.factId === c.factId);
    if (c.layer === 'project') {
      if (c.action === 'correct' || c.action === 'retract' || (c.action === 'supersede' && c.value)) {
        db.prepare('DELETE FROM responsibility_memory_fact_governance WHERE project_id=? AND fact_id=?')
          .run(projectId, c.factId);
      } else if (c.action === 'set_valid_until' || (c.action === 'supersede' && !c.value)) {
        const winner = c.action === 'supersede'
          ? (previewPayload.changes.find(x => x.factId === c.supersededByFactId) || winnerCandidate)
          : null;
        db.prepare(`
          INSERT INTO responsibility_memory_fact_governance (
            project_id, fact_id, fact_version, valid_until, superseded_by_fact_id,
            superseded_by_layer, source_type, source_ref, confidence, actor_id, request_id, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(project_id, fact_id) DO UPDATE SET
            fact_version = excluded.fact_version,
            valid_until = CASE WHEN excluded.valid_until IS NOT NULL THEN excluded.valid_until ELSE responsibility_memory_fact_governance.valid_until END,
            superseded_by_fact_id = COALESCE(excluded.superseded_by_fact_id, responsibility_memory_fact_governance.superseded_by_fact_id),
            superseded_by_layer = COALESCE(excluded.superseded_by_layer, responsibility_memory_fact_governance.superseded_by_layer),
            actor_id = excluded.actor_id,
            request_id = excluded.request_id,
            updated_at = excluded.updated_at
        `).run(
          projectId,
          c.factId,
          Number(priorFact?.version || 1) + (c.action === 'supersede' || (c.action === 'set_valid_until' && Date.parse(c.validUntil) <= Date.now()) ? 1 : 0),
          c.action === 'set_valid_until' ? c.validUntil : null,
          c.action === 'supersede' ? (c.supersededByFactId || winner?.factId || null) : null,
          c.action === 'supersede' ? (winner?.layer || 'project') : null,
          priorFact?.sourceType || null,
          priorFact?.sourceRef || null,
          priorFact?.confidence ?? null,
          actorId,
          idempotencyKey,
          ts,
        );
      }
      recordMemoryAuditSync(db, {
        responsibilityId,
        projectId,
        ownerPrincipalId,
        actorId,
        operation: isRecovery ? 'cross_store_recovered' : 'conflict_resolve',
        layer: 'project',
        factId: c.factId,
        action: c.action,
        previousVersion: priorFact?.version ?? null,
        newVersion: projectVersion ?? priorFact?.version ?? null,
        previousValue: priorFact?.factValue ?? '',
        newValue: c.action === 'correct' || (c.action === 'supersede' && c.value) ? c.value : (c.action === 'retract' ? '' : priorFact?.factValue ?? ''),
        validUntil: c.validUntil || priorFact?.validUntil || null,
        sourceType: priorFact?.sourceType || '',
        sourceRef: priorFact?.sourceRef || '',
        previewDigest,
        idempotencyKey,
        details: { journalId, projectResult: projectResult ? { version: projectResult.version, projectionState: projectResult.projectionState } : null },
        createdAt: ts,
      });
    } else if (c.layer === 'user') {
      const ur = userResults.find(u => u.factId === c.factId);
      recordMemoryAuditSync(db, {
        responsibilityId,
        projectId,
        ownerPrincipalId,
        actorId,
        operation: isRecovery ? 'cross_store_recovered' : 'conflict_resolve',
        layer: 'user',
        factId: c.factId,
        action: c.action,
        previousVersion: priorFact?.version ?? null,
        newVersion: ur?.version ?? priorFact?.version ?? null,
        previousValue: priorFact?.factValue ?? '',
        newValue: c.action === 'correct' || (c.action === 'supersede' && c.value) ? c.value : (c.action === 'retract' ? '' : priorFact?.factValue ?? ''),
        validUntil: c.validUntil || priorFact?.validUntil || null,
        sourceType: priorFact?.sourceType || '',
        sourceRef: priorFact?.sourceRef || '',
        previewDigest,
        idempotencyKey,
        details: { journalId, newFactId: ur?.newFactId || null, supersededByFactId: ur?.supersededByFactId || null },
        createdAt: ts,
      });
    }
  }

  // Record conflict review signature in responsibility_memory_conflict_reviews
  const memberKeys = previewPayload.facts.map(f => `${f.layer}:${f.factId}`).sort();
  const groupId = hashJson(memberKeys);
  const updatedSnapshot = previewPayload.facts.map(f => {
    const c = previewPayload.changes.find(x => x.layer === f.layer && x.factId === f.factId);
    if (!c || c.action === 'keep') return f;
    if (f.layer === 'user') {
      const ur = userResults.find(u => u.factId === f.factId);
      return {
        ...f,
        version: ur?.version ?? (f.version + 1),
        factValue: c.action === 'correct' ? c.value : f.factValue,
        status: c.action === 'retract' ? 'retracted' : c.action === 'supersede' ? 'superseded' : 'active',
        validUntil: c.action === 'set_valid_until' ? c.validUntil : f.validUntil,
      };
    }
    return {
      ...f,
      version: c.action === 'set_valid_until' && Date.parse(c.validUntil) > Date.now() ? f.version : f.version + 1,
      factValue: c.action === 'correct' || (c.action === 'supersede' && c.value) ? c.value : f.factValue,
      state: c.action === 'retract' || (c.action === 'supersede' && !c.value) ? 'invalidated' : 'active',
      validUntil: c.action === 'set_valid_until' ? c.validUntil : f.validUntil,
    };
  });
  const nextSig = conflictSignature(updatedSnapshot);
  db.prepare(`
    INSERT INTO responsibility_memory_conflict_reviews (
      responsibility_id, group_id, fact_signature, members_json, actor_id, resolution_journal_id, updated_at
    ) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(responsibility_id, group_id) DO UPDATE SET
      fact_signature = excluded.fact_signature,
      members_json = excluded.members_json,
      actor_id = excluded.actor_id,
      resolution_journal_id = excluded.resolution_journal_id,
      updated_at = excluded.updated_at
  `).run(responsibilityId, groupId, nextSig, JSON.stringify(memberKeys), actorId, journalId, ts);

  activity(db, responsibilityId, 'memory_conflict_resolved', {
    journalId,
    previewDigest,
    projectVersion: projectVersion ?? null,
    userResults,
    recovered: isRecovery,
  });
}

export async function commitResponsibilityMemoryConflict(id, input, actor, options = {}) {
  assertResponsibilityMemoryWritesEnabled();
  assertOwnerActor(actor);
  assertNoPolicyMutationInPayload(input);
  const projectMemoryStore = options.stores?.projectMemoryStore || defaultProjectMemoryStore;
  const userMemoryStore = options.stores?.userMemoryStore || defaultUserMemoryStore;
  const { responsibility } = await getResponsibility(id, actor);

  if (input?.confirmed !== true || typeof input?.idempotencyKey !== 'string' || !input.idempotencyKey.trim()
    || input.idempotencyKey.trim().length > 160 || typeof input?.previewDigest !== 'string') {
    throw error('Confirmation, preview digest and idempotency key are required');
  }
  const idempotencyKey = input.idempotencyKey.trim();

  const saved = await read(db => {
    ensureGovernanceSchemaSync(db);
    return db.prepare('SELECT * FROM responsibility_memory_previews WHERE digest=? AND actor_id=? AND responsibility_id=?')
      .get(input.previewDigest, actor.principalId, id);
  });
  if (!saved) throw error('Memory preview unavailable', 409, 'RESPONSIBILITY_CONFLICT');
  const p = JSON.parse(saved.payload_json);
  const changes = normalizeConflictResolutionInput(input, p.facts || []);

  const expectedProjectVersion = Number.isSafeInteger(input?.expectedProjectVersion)
    ? input.expectedProjectVersion
    : (Number.isSafeInteger(input?.expectedVersion) ? input.expectedVersion : (p.expectedProjectVersion ?? 0));
  if (p.projectId !== responsibility.projectId
    || p.responsibilityVersion !== responsibility.rowVersion
    || (p.expectedProjectVersion ?? p.expectedVersion ?? 0) !== expectedProjectVersion
    || digest(p) !== input.previewDigest
    || digest(p.changes) !== digest(changes)) {
    throw error('Memory preview does not match request', 409, 'RESPONSIBILITY_CONFLICT');
  }

  const payloadDigest = digest({
    previewDigest: input.previewDigest,
    expectedProjectVersion,
    changes,
  });

  // Check existing journal entry for idempotency / crash recovery
  const existingJournal = await read(db => {
    ensureGovernanceSchemaSync(db);
    return db.prepare('SELECT * FROM responsibility_memory_resolution_journal WHERE actor_id=? AND responsibility_id=? AND idempotency_key=?')
      .get(actor.principalId, id, idempotencyKey);
  });

  if (existingJournal) {
    if (existingJournal.payload_digest !== payloadDigest) {
      throw error('Idempotency key reused with different memory conflict resolution input', 409, 'RESPONSIBILITY_CONFLICT');
    }
    if (existingJournal.status === 'committed') {
      return { ...JSON.parse(existingJournal.result_json), replayed: true };
    }
    if (existingJournal.status === 'recovery_conflict') {
      throw error(existingJournal.error_message || 'Cross-store recovery conflict requires review', 409, 'RESPONSIBILITY_CONFLICT');
    }
    if (existingJournal.status === 'project_committed') {
      const recovered = await recoverPendingMemoryResolutions({
        responsibilityId: id,
        journalId: existingJournal.id,
        actor,
        stores: options.stores,
      });
      const entry = recovered.recovered.find(r => r.journalId === existingJournal.id);
      if (entry?.result) return { ...entry.result, replayed: true, recovered: true };
      throw error(entry?.error || 'Failed to recover cross-store memory resolution', 409, 'RESPONSIBILITY_CONFLICT');
    }
  }

  // Check preview expiry (unless resuming an already prepared/committed journal)
  if (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.now()) {
    const pmPrior = p.expectedProjectVersion > 0
      ? await projectMemoryStore.getMemoryMutationReceipt(p.projectId, actor.principalId, `${idempotencyKey}:pm`).catch(() => null)
      : null;
    const legacyPmChanges = p.changes.filter(c => c.layer === 'project').map(c => resolveProjectMutationChange(c, p.facts));
    const expectedPmDigest = legacyPmChanges.length >= 2
      ? projectMemoryConflictMutationDigest(p.projectId.trim().slice(0, 160), legacyPmChanges, p.expectedProjectVersion)
      : '';
    if (!pmPrior || pmPrior.payloadDigest !== expectedPmDigest) {
      throw error('Memory preview expired', 409, 'RESPONSIBILITY_CONFLICT');
    }
  }

  const projectChanges = p.changes.filter(c => c.layer === 'project');
  const userChanges = p.changes.filter(c => c.layer === 'user');
  for (const c of userChanges) {
    if (c.action === 'keep') continue;
    const priorFact = p.facts.find(f => f.layer === 'user' && f.factId === c.factId);
    await guardMemoryWriteInput({
      factValue: c.value,
      validUntil: c.validUntil,
      reason: c.reason,
      sourceType: priorFact?.sourceType,
      category: priorFact?.category,
      originType: input?.originType,
      provenanceKind: input?.provenanceKind,
      sourceKind: input?.sourceKind,
      untrusted: input?.untrusted,
    }, priorFact, actor, {
      responsibilityId: id,
      projectId: responsibility.projectId,
      operation: `conflict_commit_${c.action}`,
      layer: 'user',
    });
  }
  const projectMutatingChanges = projectChanges.filter(c => {
    const mapped = resolveProjectMutationChange(c, p.facts);
    return mapped.action !== 'keep';
  });

  const ts = now();
  const journalId = existingJournal?.id || `rmj_${randomUUID()}`;

  // Step 1: Validate User Memory versions & record durable prepared journal before any cross-store write
  await asyncTransaction(async db => {
    for (const c of userChanges) {
      const res = await userMemoryStore.getUserMemoryFact(c.factId, { ownerPrincipalId: responsibility.ownerPrincipalId, actor, db: userMemoryStore.databasePath ? undefined : db });
      const fact = res?.fact;
      const expectedVer = p.expectedUserFactVersions?.[c.factId];
      if (!fact || fact.status !== 'active' || fact.version !== expectedVer) {
        throw error(`User memory fact '${c.factId}' changed concurrently`, 409, 'USER_MEMORY_VERSION_CONFLICT');
      }
      if (c.action !== 'keep') {
        validateUserMemoryWrite({ sourceType: fact.sourceType, category: fact.category, operation: c.action }, fact, actor);
      }
    }
    if (!existingJournal) {
      db.prepare(`
        INSERT INTO responsibility_memory_resolution_journal (
          id, actor_id, responsibility_id, project_id, owner_principal_id,
          idempotency_key, preview_digest, payload_digest, status, plan_json,
          project_committed_version, result_json, error_message, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        journalId,
        actor.principalId,
        id,
        responsibility.projectId,
        responsibility.ownerPrincipalId,
        idempotencyKey,
        input.previewDigest,
        payloadDigest,
        'prepared',
        JSON.stringify({ previewPayload: p }),
        null,
        null,
        null,
        ts,
        ts,
      );
    }
  });

  // Step 2: Apply Project Memory mutations (if any) BEFORE finalizing User Memory
  let projectResult = null;
  let projectVersion = p.expectedProjectVersion || 0;
  if (projectChanges.length > 0) {
    try {
      const currentMemory = await projectMemoryStore.getProjectMemory(p.projectId);
      if (!currentMemory || currentMemory.currentVersion !== p.expectedProjectVersion) {
        throw error('Memory version changed', 409, 'RESPONSIBILITY_CONFLICT');
      }
      const currentFacts = await projectMemoryStore.listCurrentFacts(p.projectId);
      for (const c of projectChanges) {
        const currentFact = currentFacts.find(f => f.factId === c.factId);
        const expectedFactVer = p.expectedProjectFactVersions?.[c.factId];
        if (!currentFact || currentFact.state !== 'active' || (expectedFactVer && currentFact.currentVersion !== expectedFactVer)) {
          throw error('Conflict facts changed', 409, 'RESPONSIBILITY_CONFLICT');
        }
      }

      if (projectChanges.length >= 2 && (projectMutatingChanges.length > 0 || userChanges.length === 0)) {
        const pmChanges = projectChanges.map(c => resolveProjectMutationChange(c, p.facts));
        projectResult = await projectMemoryStore.resolveFactConflict({
          projectId: p.projectId,
          changes: pmChanges,
          expectedVersion: p.expectedProjectVersion,
          actorId: actor.principalId,
          requestId: `${idempotencyKey}:pm`,
        }, {
          authorize: async () => {
            const current = await getResponsibility(id, actor);
            if (current.responsibility.projectId !== p.projectId || current.responsibility.rowVersion !== p.responsibilityVersion) {
              throw error('Responsibility changed', 409, 'RESPONSIBILITY_CONFLICT');
            }
          },
        });
        projectVersion = projectResult.version;
      } else if (projectMutatingChanges.length === 1) {
        const single = projectMutatingChanges[0];
        const mapped = resolveProjectMutationChange(single, p.facts);
        projectResult = await projectMemoryStore.reviseFact({
          projectId: p.projectId,
          factId: mapped.factId,
          action: mapped.action,
          value: mapped.value,
          expectedVersion: p.expectedProjectVersion,
          actorId: actor.principalId,
          requestId: `${idempotencyKey}:pm`,
        });
        projectVersion = projectResult.version;
      }

      await transaction(db => {
        ensureGovernanceSchemaSync(db);
        db.prepare(`UPDATE responsibility_memory_resolution_journal SET status='project_committed', project_committed_version=?, updated_at=? WHERE id=?`)
          .run(projectVersion, now(), journalId);
      });
    } catch (err) {
      await transaction(db => {
        ensureGovernanceSchemaSync(db);
        db.prepare(`UPDATE responsibility_memory_resolution_journal SET status='aborted', error_message=?, updated_at=? WHERE id=? AND status='prepared'`)
          .run(String(err?.message || 'Project memory conflict resolution failed').slice(0, 1000), now(), journalId);
      });
      throw err;
    }
  }

  // Test hook for deterministic cross-store crash simulation after Project Memory commit
  if (typeof options.onAfterProjectCommit === 'function') {
    await options.onAfterProjectCommit({ journalId, projectVersion, projectResult });
  }

  // Step 3: Atomically commit User Memory changes, governance metadata, conflict review & audit log
  const finalResult = await asyncTransaction(async db => {
    const userResults = await applyUserChangesInDb(db, {
      userMemoryStore,
      userChanges,
      previewPayload: p,
      ownerPrincipalId: responsibility.ownerPrincipalId,
      actor,
      idempotencyKey,
      ts: now(),
    });
    const resultPayload = {
      schemaVersion: 1,
      version: projectVersion,
      projectId: p.projectId,
      projectVersion,
      projectionState: projectResult?.projectionState || (projectMutatingChanges.length ? 'unknown' : 'unchanged'),
      userResults,
      journalId,
      replayed: false,
    };
    finalizeResolutionAuditSync(db, {
      journalId,
      responsibilityId: id,
      projectId: p.projectId,
      ownerPrincipalId: responsibility.ownerPrincipalId,
      actorId: actor.principalId,
      idempotencyKey,
      previewDigest: input.previewDigest,
      previewPayload: p,
      projectVersion,
      projectResult,
      userResults,
      ts: now(),
      isRecovery: false,
    });
    db.prepare(`
      UPDATE responsibility_memory_resolution_journal
      SET status='committed', project_committed_version=?, result_json=?, error_message=NULL, updated_at=?
      WHERE id=?
    `).run(projectVersion, JSON.stringify(resultPayload), now(), journalId);
    return resultPayload;
  });

  return finalResult;
}

export async function recoverPendingMemoryResolutions({ responsibilityId = '', journalId = '', actor = null, stores = {} } = {}) {
  const userMemoryStore = stores.userMemoryStore || defaultUserMemoryStore;
  const projectMemoryStore = stores.projectMemoryStore || defaultProjectMemoryStore;
  const pending = await read(db => {
    ensureGovernanceSchemaSync(db);
    const clauses = ["status = 'project_committed'"];
    const params = [];
    if (responsibilityId) { clauses.push('responsibility_id = ?'); params.push(responsibilityId); }
    if (journalId) { clauses.push('id = ?'); params.push(journalId); }
    return db.prepare(`SELECT * FROM responsibility_memory_resolution_journal WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`).all(...params);
  });

  const recovered = [];
  for (const row of pending) {
    const plan = parseJson(row.plan_json, {});
    const p = plan.previewPayload;
    if (!p) continue;
    const effectiveActor = actor || { kind: 'user', role: 'owner', principalId: row.owner_principal_id };
    const userChanges = (p.changes || []).filter(c => c.layer === 'user');
    try {
      const resultPayload = await asyncTransaction(async db => {
        const userResults = await applyUserChangesInDb(db, {
          userMemoryStore,
          userChanges,
          previewPayload: p,
          ownerPrincipalId: row.owner_principal_id,
          actor: effectiveActor,
          idempotencyKey: row.idempotency_key,
          ts: now(),
        });
        const pmVersion = row.project_committed_version ?? p.expectedProjectVersion ?? 0;
        const head = p.projectId ? await projectMemoryStore.getProjectMemory(p.projectId).catch(() => null) : null;
        const payload = {
          schemaVersion: 1,
          version: pmVersion,
          projectId: p.projectId,
          projectVersion: pmVersion,
          projectionState: head?.projectionState || 'unknown',
          userResults,
          journalId: row.id,
          replayed: false,
          recovered: true,
        };
        finalizeResolutionAuditSync(db, {
          journalId: row.id,
          responsibilityId: row.responsibility_id,
          projectId: row.project_id,
          ownerPrincipalId: row.owner_principal_id,
          actorId: row.actor_id,
          idempotencyKey: row.idempotency_key,
          previewDigest: row.preview_digest,
          previewPayload: p,
          projectVersion: pmVersion,
          projectResult: head ? { version: pmVersion, projectionState: head.projectionState } : null,
          userResults,
          ts: now(),
          isRecovery: true,
        });
        db.prepare(`
          UPDATE responsibility_memory_resolution_journal
          SET status='committed', result_json=?, error_message=NULL, updated_at=?
          WHERE id=?
        `).run(JSON.stringify(payload), now(), row.id);
        return payload;
      });
      recovered.push({ journalId: row.id, status: 'committed', result: resultPayload });
    } catch (err) {
      await transaction(db => {
        ensureGovernanceSchemaSync(db);
        db.prepare(`UPDATE responsibility_memory_resolution_journal SET status='recovery_conflict', error_message=?, updated_at=? WHERE id=?`)
          .run(String(err?.message || 'Recovery failed').slice(0, 1000), now(), row.id);
      });
      recovered.push({ journalId: row.id, status: 'recovery_conflict', error: err?.message || 'Recovery failed' });
    }
  }
  return { schemaVersion: 1, recovered };
}

export async function previewResponsibilityMemory(id, factId, input, actor, options = {}) {
  const projectMemoryStore = options.stores?.projectMemoryStore || defaultProjectMemoryStore;
  const { responsibility } = await getResponsibility(id, actor);
  assertNoPolicyMutationInPayload(input);
  let action = input?.action;
  if (action === 'setValidUntil') action = 'set_valid_until';
  const value = typeof input?.value === 'string' ? input.value.trim() : '';
  const validUntilRaw = text(input?.validUntil, 80);
  if (!['correct', 'retract', 'supersede', 'set_valid_until'].includes(action)
    || !Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 1
    || (action === 'correct' && (!value || value.length > 1200))
    || (action === 'supersede' && value.length > 1200)
    || (action === 'set_valid_until' && (!validUntilRaw || !Number.isFinite(Date.parse(validUntilRaw))))) {
    throw error('Invalid memory preview');
  }
  const validUntil = action === 'set_valid_until' ? new Date(Date.parse(validUntilRaw)).toISOString() : null;
  const supersededByFactId = action === 'supersede' ? (text(input?.supersededByFactId, 120) || null) : null;

  const memory = await projectMemoryStore.getProjectMemory(responsibility.projectId);
  if (!memory || memory.currentVersion !== input.expectedVersion) {
    throw error('Memory version changed', 409, 'RESPONSIBILITY_CONFLICT');
  }
  const facts = await projectMemoryStore.listCurrentFacts(responsibility.projectId);
  const fact = facts.find(entry => entry.factId === factId);
  if (!fact) throw error('Fact unavailable', 404, 'RESPONSIBILITY_NOT_FOUND');
  const latest = await projectMemoryStore.getProjectMemory(responsibility.projectId);
  if (!latest || latest.currentVersion !== input.expectedVersion || latest.digest !== memory.digest) {
    throw error('Memory changed during preview', 409, 'RESPONSIBILITY_CONFLICT');
  }

  const visible = facts.map(entry => {
    if (entry.factId !== factId) return entry;
    if (action === 'correct') return { ...entry, state: 'active', factValue: value };
    if (action === 'supersede') return { ...entry, state: value ? 'active' : 'invalidated', factValue: value || '' };
    if (action === 'set_valid_until') {
      return Date.parse(validUntil) <= Date.now()
        ? { ...entry, state: 'invalidated', factValue: '' }
        : entry;
    }
    return { ...entry, state: 'invalidated', factValue: '' };
  }).filter(entry => entry.state === 'active' && entry.factValue);
  const lines = visible.map(entry => `- ${entry.factValue}`).join('\n') || 'No active structured facts.';
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  const willRebuild = action !== 'set_valid_until' || Date.parse(validUntil) <= Date.now();
  const nextVer = willRebuild ? input.expectedVersion + 1 : input.expectedVersion;
  const payload = {
    responsibilityId: id,
    projectId: responsibility.projectId,
    factId,
    factVersion: fact.currentVersion,
    action,
    value: (action === 'correct' || action === 'supersede') ? value : '',
    validUntil,
    supersededByFactId,
    expectedVersion: input.expectedVersion,
    actorId: actor.principalId,
    previousValue: fact.factValue || '',
    previousState: fact.state || '',
    previousContentDigest: memory.digest,
    previousSummary: memory.summary || '',
    projectedContent: willRebuild ? `# Project Memory\n\n${lines}` : memory.content,
    projectedSummary: willRebuild ? `v${nextVer}\n${lines}` : memory.summary,
    rebuildsContentAndSummary: willRebuild,
    createdAt,
    expiresAt,
  };
  const previewDigest = digest(payload);
  await transaction(db => {
    ensureGovernanceSchemaSync(db);
    db.prepare('INSERT OR IGNORE INTO responsibility_memory_previews VALUES(?,?,?,?,?)').run(previewDigest, actor.principalId, id, JSON.stringify(payload), createdAt);
  });
  return { schemaVersion: 1, preview: payload, previewDigest };
}

export async function reviseResponsibilityMemory(id, factId, rawAction, input, actor, options = {}) {
  assertResponsibilityMemoryWritesEnabled();
  assertOwnerActor(actor);
  assertNoPolicyMutationInPayload(input);
  const projectMemoryStore = options.stores?.projectMemoryStore || defaultProjectMemoryStore;
  const action = rawAction === 'setValidUntil' || rawAction === 'valid-until' ? 'set_valid_until' : rawAction;
  const { responsibility } = await getResponsibility(id, actor);
  if (input?.confirmed !== true || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()
    || input.idempotencyKey.trim().length > 160 || typeof input.previewDigest !== 'string') {
    throw error('Confirmation, preview digest and idempotency key are required');
  }
  const idempotencyKey = input.idempotencyKey.trim();
  const saved = await read(db => {
    ensureGovernanceSchemaSync(db);
    return db.prepare('SELECT * FROM responsibility_memory_previews WHERE digest=? AND actor_id=? AND responsibility_id=?')
      .get(input.previewDigest, actor.principalId, id);
  });
  if (!saved) throw error('Memory preview unavailable', 409, 'RESPONSIBILITY_CONFLICT');
  const p = JSON.parse(saved.payload_json);
  const normalizedValue = typeof input.value === 'string' ? input.value.trim() : '';
  const normalizedValidUntil = input.validUntil && Number.isFinite(Date.parse(String(input.validUntil)))
    ? new Date(Date.parse(String(input.validUntil))).toISOString()
    : p.validUntil;

  if (p.projectId !== responsibility.projectId || p.factId !== factId || p.action !== action
    || p.expectedVersion !== input.expectedVersion
    || ((action === 'correct' || (action === 'supersede' && p.value)) && p.value !== normalizedValue)
    || (action === 'set_valid_until' && p.validUntil !== normalizedValidUntil)
    || digest(p) !== input.previewDigest) {
    throw error('Memory preview does not match request', 409, 'RESPONSIBILITY_CONFLICT');
  }

  // Idempotency check for metadata-only set_valid_until
  const existingReceipt = await read(db => {
    ensureGovernanceSchemaSync(db);
    return db.prepare('SELECT * FROM responsibility_memory_resolution_journal WHERE actor_id=? AND responsibility_id=? AND idempotency_key=?')
      .get(actor.principalId, id, idempotencyKey);
  });
  const opPayloadDigest = digest({ factId, action, previewDigest: input.previewDigest, expectedVersion: p.expectedVersion });
  if (existingReceipt) {
    if (existingReceipt.payload_digest !== opPayloadDigest) {
      throw error('Idempotency key reused with different input', 409, 'RESPONSIBILITY_CONFLICT');
    }
    if (existingReceipt.status === 'committed') {
      return { ...JSON.parse(existingReceipt.result_json), replayed: true };
    }
  }

  if (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.now()) {
    const prior = await projectMemoryStore.getMemoryMutationReceipt(p.projectId, actor.principalId, idempotencyKey);
    const storeAction = action === 'correct' || (action === 'supersede' && p.value) ? 'correct' : 'retract';
    const expected = createHash('sha256').update(JSON.stringify({
      project: p.projectId.trim().slice(0, 160),
      fact: factId.trim().slice(0, 120),
      action: storeAction,
      value: p.value,
      expectedVersion: p.expectedVersion,
    })).digest('hex');
    if (!prior || prior.payloadDigest !== expected) {
      throw error('Memory preview expired', 409, 'RESPONSIBILITY_CONFLICT');
    }
  }

  let storeResult = null;
  const shouldMutateStore = action === 'correct' || action === 'retract' || action === 'supersede'
    || (action === 'set_valid_until' && Date.parse(p.validUntil) <= Date.now());

  if (shouldMutateStore) {
    const storeAction = (action === 'correct' || (action === 'supersede' && p.value)) ? 'correct' : 'retract';
    storeResult = await projectMemoryStore.reviseFact({
      projectId: p.projectId,
      factId,
      action: storeAction,
      value: p.value,
      expectedVersion: p.expectedVersion,
      actorId: actor.principalId,
      requestId: idempotencyKey,
    });
  } else {
    const head = await projectMemoryStore.getProjectMemory(p.projectId);
    if (!head || head.currentVersion !== p.expectedVersion) {
      throw error('Memory or fact version changed', 409, 'RESPONSIBILITY_CONFLICT');
    }
    storeResult = {
      version: head.currentVersion,
      replayed: false,
      projectId: p.projectId,
      factId,
      projectionState: head.projectionState || 'clean',
    };
  }

  const ts = now();
  const finalResult = { ...storeResult, action, ...(p.validUntil ? { validUntil: p.validUntil } : {}) };
  await transaction(db => {
    ensureGovernanceSchemaSync(db);
    if (action === 'correct' || action === 'retract' || (action === 'supersede' && p.value)) {
      db.prepare('DELETE FROM responsibility_memory_fact_governance WHERE project_id=? AND fact_id=?')
        .run(p.projectId, factId);
    } else if (action === 'set_valid_until' || (action === 'supersede' && !p.value)) {
      db.prepare(`
        INSERT INTO responsibility_memory_fact_governance (
          project_id, fact_id, fact_version, valid_until, superseded_by_fact_id,
          superseded_by_layer, actor_id, request_id, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id, fact_id) DO UPDATE SET
          fact_version = excluded.fact_version,
          valid_until = CASE WHEN excluded.valid_until IS NOT NULL THEN excluded.valid_until ELSE responsibility_memory_fact_governance.valid_until END,
          superseded_by_fact_id = COALESCE(excluded.superseded_by_fact_id, responsibility_memory_fact_governance.superseded_by_fact_id),
          superseded_by_layer = COALESCE(excluded.superseded_by_layer, responsibility_memory_fact_governance.superseded_by_layer),
          actor_id = excluded.actor_id,
          request_id = excluded.request_id,
          updated_at = excluded.updated_at
      `).run(
        p.projectId,
        factId,
        Number(p.factVersion || 1) + (shouldMutateStore ? 1 : 0),
        p.validUntil || null,
        p.supersededByFactId || null,
        p.supersededByFactId ? 'project' : null,
        actor.principalId,
        idempotencyKey,
        ts,
      );
    }
    if (!storeResult.replayed) {
      recordMemoryAuditSync(db, {
        responsibilityId: id,
        projectId: p.projectId,
        ownerPrincipalId: responsibility.ownerPrincipalId,
        actorId: actor.principalId,
        operation: `project_memory_${action}`,
        layer: 'project',
        factId,
        action,
        previousVersion: p.factVersion ?? p.expectedVersion,
        newVersion: storeResult.version,
        previousValue: p.previousValue,
        newValue: p.value,
        validUntil: p.validUntil || null,
        sourceType: 'user_rule',
        sourceRef: `owner:${actor.principalId}`,
        previewDigest: input.previewDigest,
        idempotencyKey,
        createdAt: ts,
      });
    }
    db.prepare(`
      INSERT OR IGNORE INTO responsibility_memory_resolution_journal (
        id, actor_id, responsibility_id, project_id, owner_principal_id,
        idempotency_key, preview_digest, payload_digest, status, plan_json,
        project_committed_version, result_json, error_message, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      `rmj_${randomUUID()}`,
      actor.principalId,
      id,
      p.projectId,
      responsibility.ownerPrincipalId,
      idempotencyKey,
      input.previewDigest,
      opPayloadDigest,
      'committed',
      JSON.stringify({ factId, action }),
      storeResult.version,
      JSON.stringify(finalResult),
      null,
      ts,
      ts,
    );
  });

  return finalResult;
}

export async function listOwnerUserMemory(query = {}, actor, options = {}) {
  const ownerPrincipalId = assertOwnerActor(actor);
  const userMemoryStore = options.stores?.userMemoryStore || defaultUserMemoryStore;
  let responsibility = null;
  if (query?.responsibilityId) {
    responsibility = (await getResponsibility(query.responsibilityId, actor)).responsibility;
  }
  return userMemoryStore.listUserMemoryFacts({
    ownerPrincipalId,
    projectId: query?.projectId || responsibility?.projectId || '',
    responsibilityId: query?.responsibilityId || '',
    scopeType: query?.scopeType || '',
    exactScopeOnly: query?.exactScopeOnly === true,
    category: query?.category || '',
    sourceType: query?.sourceType || '',
    status: query?.status || (query?.includeInactive ? '' : 'active'),
    statuses: Array.isArray(query?.statuses) ? query.statuses : undefined,
    includeExpired: query?.includeExpired === true,
    includeUntrusted: query?.includeUntrusted !== false,
    keywords: query?.keywords || '',
    limit: query?.limit || 100,
  }, { actor });
}

export async function getOwnerUserMemoryFact(factId, actor, { includeHistory = true, stores = {} } = {}) {
  const ownerPrincipalId = assertOwnerActor(actor);
  const userMemoryStore = stores.userMemoryStore || defaultUserMemoryStore;
  const res = await userMemoryStore.getUserMemoryFact(factId, { ownerPrincipalId, includeHistory, actor });
  if (!res?.fact) throw error('User memory fact not found', 404, 'USER_MEMORY_NOT_FOUND');
  return res;
}

export async function createOwnerUserMemoryFact(input, actor, options = {}) {
  assertResponsibilityMemoryWritesEnabled();
  const ownerPrincipalId = assertOwnerActor(actor);
  const userMemoryStore = options.stores?.userMemoryStore || defaultUserMemoryStore;
  let responsibility = null;
  if (input?.responsibilityId) {
    responsibility = (await getResponsibility(input.responsibilityId, actor)).responsibility;
  }
  await guardMemoryWriteInput(input, null, actor, {
    responsibilityId: responsibility?.id || '',
    projectId: responsibility?.projectId || text(input?.projectId, 160),
    operation: 'create',
    layer: 'user',
  });

  const ts = now();
  const payload = {
    ...input,
    ownerPrincipalId,
    sourceRef: text(input?.sourceRef, 500) || `owner:${ownerPrincipalId}`,
  };
  return asyncTransaction(async db => {
    const res = await userMemoryStore.createUserMemoryFact(payload, {
      actor,
      now: ts,
      db: userMemoryStore.databasePath ? undefined : db,
    });
    if (!res.replayed) {
      recordMemoryAuditSync(db, {
        responsibilityId: responsibility?.id || res.fact.scope?.responsibilityId || '',
        projectId: responsibility?.projectId || res.fact.scope?.projectId || '',
        ownerPrincipalId,
        actorId: ownerPrincipalId,
        operation: 'user_memory_create',
        layer: 'user',
        factId: res.fact.id,
        action: 'create',
        previousVersion: null,
        newVersion: res.fact.version,
        previousValue: null,
        newValue: res.fact.factValue,
        validUntil: res.fact.validUntil,
        sourceType: res.fact.sourceType,
        sourceRef: res.fact.sourceRef,
        idempotencyKey: payload.idempotencyKey,
        createdAt: ts,
      });
    }
    return res;
  });
}

export async function previewUserMemoryRevision(factId, input, actor, options = {}) {
  const ownerPrincipalId = assertOwnerActor(actor);
  assertNoPolicyMutationInPayload(input);
  const userMemoryStore = options.stores?.userMemoryStore || defaultUserMemoryStore;
  const responsibilityId = text(options.responsibilityId || input?.responsibilityId, 160);
  if (responsibilityId) await getResponsibility(responsibilityId, actor);

  let action = text(input?.action, 40);
  if (action === 'setValidUntil') action = 'set_valid_until';
  if (!['revise', 'correct', 'retract', 'supersede', 'set_valid_until'].includes(action)) {
    throw error('Invalid user memory preview action');
  }
  if (!Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 1) {
    throw error('Invalid expectedVersion');
  }

  const res = await userMemoryStore.getUserMemoryFact(factId, { ownerPrincipalId, includeHistory: false, actor });
  const fact = res?.fact;
  if (!fact) throw error('User memory fact not found', 404, 'USER_MEMORY_NOT_FOUND');
  if (fact.status !== 'active') throw error(`User memory fact is ${fact.status}`, 409, 'USER_MEMORY_CONFLICT');
  if (fact.version !== input.expectedVersion) {
    throw error('User memory fact version changed', 409, 'USER_MEMORY_VERSION_CONFLICT');
  }

  const factValue = text(input?.factValue ?? input?.value ?? input?.statement, 2000);
  if (['revise', 'correct'].includes(action) && !factValue) {
    throw error('factValue is required for revision');
  }
  if (action === 'supersede' && !factValue) {
    throw error('Replacement factValue is required to supersede');
  }
  let validUntil = fact.validUntil;
  if (action === 'set_valid_until' || input?.validUntil !== undefined) {
    if (input?.validUntil === null || input?.validUntil === '') {
      if (action === 'set_valid_until') validUntil = null;
      else validUntil = null;
    } else {
      const parsed = Date.parse(String(input.validUntil));
      if (!Number.isFinite(parsed)) throw error('Invalid validUntil timestamp');
      validUntil = new Date(parsed).toISOString();
    }
  }

  await guardMemoryWriteInput({ ...input, sourceType: input?.sourceType || fact.sourceType, category: input?.category || fact.category }, fact, actor, {
    responsibilityId,
    operation: `preview_${action}`,
    layer: 'user',
  });

  const createdAt = now();
  const payload = {
    layer: 'user',
    responsibilityId: responsibilityId || '_owner',
    ownerPrincipalId,
    actorId: actor.principalId,
    factId: fact.id,
    action,
    expectedVersion: fact.version,
    previousFact: fact,
    projectedFact: {
      ...fact,
      version: fact.version + 1,
      status: action === 'retract' ? 'retracted' : action === 'supersede' ? 'superseded' : 'active',
      factValue: ['revise', 'correct'].includes(action) ? factValue : fact.factValue,
      ...(action === 'supersede' ? { replacementValue: factValue } : {}),
      validUntil,
    },
    reason: text(input?.reason, 500),
    createdAt,
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
  };
  const previewDigest = digest(payload);
  await transaction(db => {
    ensureGovernanceSchemaSync(db);
    db.prepare('INSERT OR IGNORE INTO responsibility_memory_previews VALUES(?,?,?,?,?)')
      .run(previewDigest, actor.principalId, payload.responsibilityId, JSON.stringify(payload), createdAt);
  });
  return { schemaVersion: 1, preview: payload, previewDigest };
}

export async function commitUserMemoryRevision(factId, rawAction, input, actor, options = {}) {
  assertResponsibilityMemoryWritesEnabled();
  const ownerPrincipalId = assertOwnerActor(actor);
  const userMemoryStore = options.stores?.userMemoryStore || defaultUserMemoryStore;
  const responsibilityId = text(options.responsibilityId || input?.responsibilityId, 160);
  if (responsibilityId) await getResponsibility(responsibilityId, actor);

  let action = text(rawAction, 40);
  if (action === 'valid-until' || action === 'setValidUntil') action = 'set_valid_until';
  if (!['revise', 'correct', 'retract', 'supersede', 'set_valid_until'].includes(action)) {
    throw error('Unsupported user memory action');
  }

  if (input?.confirmed === false || typeof input?.idempotencyKey !== 'string' || !input.idempotencyKey.trim()
    || input.idempotencyKey.trim().length > 160) {
    throw error('Confirmation and idempotencyKey are required');
  }
  const idempotencyKey = input.idempotencyKey.trim();
  const hasPreview = input?.previewDigest !== undefined && input?.previewDigest !== null && input?.previewDigest !== '';

  let p;
  if (hasPreview) {
    if (input?.confirmed !== true || typeof input?.previewDigest !== 'string') {
      throw error('Confirmation and valid previewDigest are required');
    }
    const saved = await read(db => {
      ensureGovernanceSchemaSync(db);
      return db.prepare('SELECT * FROM responsibility_memory_previews WHERE digest=? AND actor_id=?')
        .get(input.previewDigest, actor.principalId);
    });
    if (!saved) throw error('Memory preview unavailable', 409, 'RESPONSIBILITY_CONFLICT');
    p = JSON.parse(saved.payload_json);
    const expectedScopeResp = responsibilityId || '_owner';
    if (p.layer !== 'user' || p.ownerPrincipalId !== ownerPrincipalId || p.factId !== factId
      || p.action !== action || p.expectedVersion !== input.expectedVersion
      || (responsibilityId && p.responsibilityId !== expectedScopeResp)
      || digest(p) !== input.previewDigest) {
      throw error('Memory preview does not match request', 409, 'RESPONSIBILITY_CONFLICT');
    }
    if (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.now()) {
      throw error('Memory preview expired', 409, 'RESPONSIBILITY_CONFLICT');
    }
  } else {
    if (!Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 1) {
      throw error('expectedVersion must be a positive integer');
    }
    const current = await userMemoryStore.getUserMemoryFact(factId, { ownerPrincipalId, actor });
    const fact = current?.fact;
    if (!fact) throw error('User memory fact not found', 404, 'USER_MEMORY_NOT_FOUND');
    const directValue = text(input?.factValue ?? input?.value ?? input?.statement ?? input?.replacement?.factValue, 2000);
    let directValidUntil = fact.validUntil;
    if (action === 'set_valid_until' || input?.validUntil !== undefined) {
      if (input?.validUntil === null || input?.validUntil === '') directValidUntil = null;
      else {
        const parsed = Date.parse(String(input.validUntil));
        if (!Number.isFinite(parsed)) throw error('Invalid validUntil timestamp');
        directValidUntil = new Date(parsed).toISOString();
      }
    }
    p = {
      layer: 'user',
      ownerPrincipalId,
      factId,
      action,
      expectedVersion: input.expectedVersion,
      previousFact: fact,
      projectedFact: {
        ...fact,
        factValue: ['revise', 'correct'].includes(action) ? directValue : fact.factValue,
        ...(action === 'supersede' ? { replacementValue: directValue } : {}),
        validUntil: directValidUntil,
      },
      reason: text(input?.reason, 500),
    };
  }

  const existing = await userMemoryStore.getUserMemoryFact(factId, { ownerPrincipalId, actor });
  await guardMemoryWriteInput({
    ...input,
    sourceType: input?.sourceType || p.previousFact?.sourceType,
    category: input?.category || p.previousFact?.category,
  }, existing?.fact || p.previousFact, actor, {
    responsibilityId,
    operation: action,
    layer: 'user',
  });

  const ts = now();
  return asyncTransaction(async db => {
    const opts = { actor, now: ts, db: userMemoryStore.databasePath ? undefined : db };
    let res;
    if (action === 'revise' || action === 'correct') {
      res = await userMemoryStore.reviseUserMemoryFact({
        ownerPrincipalId,
        factId,
        expectedVersion: p.expectedVersion,
        idempotencyKey,
        factValue: p.projectedFact.factValue,
        action,
        validUntil: p.projectedFact.validUntil,
        reason: text(input?.reason, 500) || p.reason,
        sourceType: input?.sourceType,
        sourceRef: input?.sourceRef,
        originType: input?.originType,
      }, opts);
    } else if (action === 'retract') {
      res = await userMemoryStore.retractUserMemoryFact({
        ownerPrincipalId,
        factId,
        expectedVersion: p.expectedVersion,
        idempotencyKey,
        reason: text(input?.reason, 500) || p.reason,
        sourceType: input?.sourceType,
        sourceRef: input?.sourceRef,
        originType: input?.originType,
      }, opts);
    } else if (action === 'supersede') {
      res = await userMemoryStore.supersedeUserMemoryFact({
        ownerPrincipalId,
        factId,
        expectedVersion: p.expectedVersion,
        idempotencyKey,
        reason: text(input?.reason, 500) || p.reason,
        replacement: {
          factValue: p.projectedFact.replacementValue,
          factKey: input?.replacement?.factKey || p.previousFact.factKey,
          category: input?.replacement?.category || p.previousFact.category,
          sourceType: input?.replacement?.sourceType || (p.previousFact.sourceType === 'user_rule' ? 'user_rule' : 'user_rule'),
          sourceRef: input?.replacement?.sourceRef || `owner:${ownerPrincipalId}`,
          scope: input?.replacement?.scope || p.previousFact.scope,
          validUntil: p.projectedFact.validUntil,
          originType: input?.replacement?.originType ?? input?.originType,
        },
      }, opts);
    } else {
      res = await userMemoryStore.setUserMemoryValidUntil({
        ownerPrincipalId,
        factId,
        expectedVersion: p.expectedVersion,
        validUntil: p.projectedFact.validUntil,
        idempotencyKey,
        reason: text(input?.reason, 500) || p.reason,
        sourceType: input?.sourceType,
        sourceRef: input?.sourceRef,
        originType: input?.originType,
      }, opts);
    }

    if (!res.replayed) {
      const resultingFact = res.fact || res.supersededFact;
      recordMemoryAuditSync(db, {
        responsibilityId: responsibilityId || p.previousFact?.scope?.responsibilityId || '',
        projectId: p.previousFact?.scope?.projectId || '',
        ownerPrincipalId,
        actorId: ownerPrincipalId,
        operation: `user_memory_${action}`,
        layer: 'user',
        factId,
        action,
        previousVersion: p.expectedVersion,
        newVersion: resultingFact?.version ?? (p.expectedVersion + 1),
        previousValue: p.previousFact?.factValue,
        newValue: action === 'supersede' ? p.projectedFact.replacementValue : resultingFact?.factValue,
        validUntil: p.projectedFact.validUntil,
        sourceType: resultingFact?.sourceType || p.previousFact?.sourceType || '',
        sourceRef: resultingFact?.sourceRef || p.previousFact?.sourceRef || '',
        previewDigest: input.previewDigest,
        idempotencyKey,
        details: res.newFact ? { newFactId: res.newFact.id } : {},
        createdAt: ts,
      });
    }
    return res;
  });
}

export async function listOwnerEpisodicMemory(query = {}, actor, options = {}) {
  const ownerPrincipalId = assertOwnerActor(actor);
  const episodicMemoryStore = options.stores?.episodicMemoryStore || defaultEpisodicMemoryStore;
  let responsibility = null;
  if (query?.responsibilityId) {
    responsibility = (await getResponsibility(query.responsibilityId, actor)).responsibility;
  }
  return episodicMemoryStore.listEpisodicMemories({
    ownerPrincipalId,
    projectId: query?.projectId || responsibility?.projectId || '',
    responsibilityId: query?.responsibilityId || '',
    outcome: query?.outcome || '',
    outcomes: Array.isArray(query?.outcomes) ? query.outcomes : undefined,
    sourceType: query?.sourceType || '',
    includeExpired: query?.includeExpired === true,
    includeRetracted: query?.includeRetracted === true,
    includeUntrusted: query?.includeUntrusted === true,
    keywords: query?.keywords || '',
    limit: query?.limit || 50,
  }, { actor });
}

export async function listResponsibilityMemoryAudit(id, actor, { limit = 50 } = {}) {
  const ownerPrincipalId = assertOwnerActor(actor);
  if (id) await getResponsibility(id, actor);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return read(db => {
    ensureGovernanceSchemaSync(db);
    const rows = id
      ? db.prepare(`
          SELECT * FROM responsibility_memory_audit_log
          WHERE owner_principal_id = ? AND (responsibility_id = ? OR responsibility_id = '')
          ORDER BY sequence DESC LIMIT ?
        `).all(ownerPrincipalId, id, boundedLimit)
      : db.prepare(`
          SELECT * FROM responsibility_memory_audit_log
          WHERE owner_principal_id = ?
          ORDER BY sequence DESC LIMIT ?
        `).all(ownerPrincipalId, boundedLimit);
    return {
      schemaVersion: 1,
      audit: rows.map(r => ({
        sequence: Number(r.sequence),
        id: r.id,
        responsibilityId: r.responsibility_id || null,
        projectId: r.project_id || null,
        ownerPrincipalId: r.owner_principal_id,
        actorId: r.actor_id,
        operation: r.operation,
        layer: r.layer,
        factId: r.fact_id,
        action: r.action,
        previousVersion: r.previous_version,
        newVersion: r.new_version,
        previousValue: r.previous_value,
        newValue: r.new_value,
        validUntil: r.valid_until || null,
        sourceType: r.source_type,
        sourceRef: r.source_ref,
        previewDigest: r.preview_digest || null,
        idempotencyKey: r.idempotency_key || null,
        details: parseJson(r.details_json, {}),
        createdAt: r.created_at,
      })),
    };
  });
}
