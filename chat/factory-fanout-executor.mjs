// Deterministic Fan-Out Workflow Executor (Stream 3B).
//
// Executes compiled `phase` / `parallel` / `pipeline` work graphs directly in
// host code with bounded concurrency, strict JSON Schema validation, durable
// governor budget accounting, immutable ResultPackets, and ZERO board/chat
// coordination chatter.
import { createHash, randomUUID } from 'node:crypto';

import { withDatabase } from './collaboration-store.mjs';
import { getOrganization } from './organization-store.mjs';
import { getOrganizationRuntimeCapabilities } from './organization-runtime-capabilities.mjs';
import {
  initializeOrganizationGovernor,
  reserveFactoryBudget,
  settleFactoryBudget,
  releaseOrganizationBudgetReservation,
} from './organization-governor.mjs';
import { createExecutionPacket, createProjectCheckpoint } from './result-packets.mjs';
import { getProject, findProjectByRootPath } from './projects.mjs';
import { resolveRealRoot, scopeContainsPath } from './execution-scope.mjs';
import {
  compileFactoryFanoutWorkflow,
  instantiateFactoryFanoutWorkflow,
} from './factory-workflow.mjs';

export const FANOUT_SCHEMA_VALIDATION_FAILED = 'FANOUT_SCHEMA_VALIDATION_FAILED';
export const FANOUT_STEP_FAILED = 'FANOUT_STEP_FAILED';
export const FANOUT_WORKFLOW_NOT_FOUND = 'FANOUT_WORKFLOW_NOT_FOUND';

const EXECUTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS factory_fanout_executions (
  workflow_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workflow_instance_id TEXT,
  goal_id TEXT,
  status TEXT NOT NULL,
  digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS factory_fanout_exec_org
  ON factory_fanout_executions(organization_id, created_at DESC, workflow_id);
`;

function executorError(code, message, statusCode = 400, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalStringify(value), 'utf8').digest('hex');
}

function ensureSchema(db) {
  db.exec(EXECUTIONS_SCHEMA);
}

function schemaError(message, path, schema) {
  return executorError(FANOUT_SCHEMA_VALIDATION_FAILED, message, 422, { path, schema });
}

function matchesJsonType(value, expectedType) {
  switch (expectedType) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return false;
  }
}

function valuesDeepEqual(a, b) {
  return canonicalStringify(a) === canonicalStringify(b);
}

/**
 * Deterministically validate a structured step output against a JSON Schema subset.
 * Fails closed with `FANOUT_SCHEMA_VALIDATION_FAILED` (422) on any violation.
 */
export function validateFanoutStepOutput(value, schema, path = '$') {
  if (schema === undefined || schema === null) return value;
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    throw schemaError(`Invalid schema at ${path}`, path, schema);
  }
  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.some((type) => matchesJsonType(value, type))) {
      throw schemaError(
        `Schema validation failed at ${path}: expected ${allowedTypes.join('|')}`,
        path,
        schema,
      );
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.some((entry) => valuesDeepEqual(entry, value))) {
      throw schemaError(`Schema validation failed at ${path}: value not in enum`, path, schema);
    }
  }
  if (schema.required !== undefined || schema.properties !== undefined || schema.additionalProperties !== undefined) {
    if (!matchesJsonType(value, 'object')) {
      throw schemaError(`Schema validation failed at ${path}: expected object`, path, schema);
    }
  }
  if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
    if (!matchesJsonType(value, 'array')) {
      throw schemaError(`Schema validation failed at ${path}: expected array`, path, schema);
    }
  }
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    if (!matchesJsonType(value, 'string')) {
      throw schemaError(`Schema validation failed at ${path}: expected string`, path, schema);
    }
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    if (!matchesJsonType(value, 'number')) {
      throw schemaError(`Schema validation failed at ${path}: expected number`, path, schema);
    }
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      throw schemaError(`Schema validation failed at ${path}: length < ${schema.minLength}`, path, schema);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      throw schemaError(`Schema validation failed at ${path}: length > ${schema.maxLength}`, path, schema);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw schemaError(`Schema validation failed at ${path}: value < ${schema.minimum}`, path, schema);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw schemaError(`Schema validation failed at ${path}: value > ${schema.maximum}`, path, schema);
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      throw schemaError(`Schema validation failed at ${path}: items < ${schema.minItems}`, path, schema);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      throw schemaError(`Schema validation failed at ${path}: items > ${schema.maxItems}`, path, schema);
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i += 1) {
        validateFanoutStepOutput(value[i], schema.items, `${path}[${i}]`);
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.hasOwn(value, reqKey)) {
          throw schemaError(`Schema validation failed at ${path}: missing required property '${reqKey}'`, `${path}.${reqKey}`, schema);
        }
      }
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) {
        validateFanoutStepOutput(value[key], propSchema, `${path}.${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) {
          throw schemaError(`Schema validation failed at ${path}: unexpected property '${key}'`, `${path}.${key}`, schema);
        }
      }
    }
  }
  return value;
}

function stripRagentEnvelopeTags(text) {
  return text
    .replace(/<ragent-result-packet>[\s\S]*?<\/ragent-result-packet>/gi, '')
    .replace(/<ragent-session-labels>[\s\S]*?<\/ragent-session-labels>/gi, '')
    .trim();
}

function scanFirstBalancedJson(text) {
  for (let start = 0; start < text.length; start += 1) {
    const ch = text[start];
    if (ch !== '{' && ch !== '[') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') {
        depth -= 1;
        if (depth === 0) {
          const slice = text.slice(start, i + 1);
          try {
            return { found: true, value: JSON.parse(slice) };
          } catch {
            break;
          }
        }
      }
    }
  }
  return { found: false, value: null };
}

/** Extract structured JSON deterministically from an agent text response. */
export function extractStructuredJsonFromText(rawText) {
  if (typeof rawText !== 'string') {
    throw schemaError('Agent response must be text or structured JSON', '$', null);
  }
  const cleaned = stripRagentEnvelopeTags(rawText);
  if (!cleaned) {
    throw schemaError('Agent returned empty response when structured JSON was required', '$', null);
  }
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to fenced/balanced JSON */ }

  const fenceMatches = [...cleaned.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)```/gi)];
  if (fenceMatches.length > 0) {
    const candidate = fenceMatches[fenceMatches.length - 1][1].trim();
    try {
      return JSON.parse(candidate);
    } catch { /* fall through */ }
  }

  const balanced = scanFirstBalancedJson(cleaned);
  if (balanced.found) return balanced.value;

  throw schemaError('Unable to parse valid JSON from step output', '$', null);
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0, cost: 0 };
}

function pickFiniteNonNeg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeStepUsage(raw = {}) {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const inputTokens = Math.trunc(pickFiniteNonNeg(raw.inputTokens ?? raw.input_tokens));
  const outputTokens = Math.trunc(pickFiniteNonNeg(raw.outputTokens ?? raw.output_tokens));
  const cachedTokens = Math.trunc(pickFiniteNonNeg(
    raw.cachedInputTokens ?? raw.cached_input_tokens ?? raw.cachedReadTokens ?? raw.cache_read_tokens,
  ));
  const thoughtTokens = Math.trunc(pickFiniteNonNeg(
    raw.thoughtTokens ?? raw.thought_tokens ?? raw.reasoningTokens ?? raw.reasoning_tokens ?? raw.reasoningOutputTokens,
  ));
  const explicitTotal = pickFiniteNonNeg(raw.totalTokens ?? raw.total_tokens);
  const computedTotal = inputTokens + outputTokens + thoughtTokens + cachedTokens;
  const totalTokens = Math.trunc(explicitTotal > 0 ? explicitTotal : computedTotal);
  const cost = pickFiniteNonNeg(raw.cost ?? raw.costUsd ?? raw.estimatedCostUsd);
  return { inputTokens, outputTokens, thoughtTokens, totalTokens, cost };
}

function extractAgyCliUsage(result) {
  if (!result || typeof result !== 'object') return emptyUsage();
  if (result.usage && typeof result.usage === 'object') return normalizeStepUsage(result.usage);
  const stats = result.stats && typeof result.stats === 'object' ? result.stats : null;
  if (!stats) return emptyUsage();
  if (stats.models && typeof stats.models === 'object') {
    const agg = emptyUsage();
    for (const modelEntry of Object.values(stats.models)) {
      const tokens = modelEntry?.tokens && typeof modelEntry.tokens === 'object' ? modelEntry.tokens : modelEntry;
      const part = normalizeStepUsage({
        inputTokens: tokens?.input ?? tokens?.prompt ?? tokens?.inputTokens ?? tokens?.input_tokens,
        outputTokens: tokens?.candidates ?? tokens?.output ?? tokens?.outputTokens ?? tokens?.output_tokens,
        thoughtTokens: tokens?.thoughts ?? tokens?.thoughtTokens ?? tokens?.thought_tokens,
        totalTokens: tokens?.total ?? tokens?.totalTokens ?? tokens?.total_tokens,
      });
      agg.inputTokens += part.inputTokens;
      agg.outputTokens += part.outputTokens;
      agg.thoughtTokens += part.thoughtTokens;
      agg.totalTokens += part.totalTokens;
    }
    return agg;
  }
  return normalizeStepUsage(stats);
}

function addUsage(target, delta) {
  target.inputTokens += delta.inputTokens || 0;
  target.outputTokens += delta.outputTokens || 0;
  target.thoughtTokens += delta.thoughtTokens || 0;
  target.totalTokens += delta.totalTokens || 0;
  return target;
}

function buildStepPrompt(step, upstreamOutputs) {
  const parts = [step.contract.prompt || step.contract.objective];
  if (step.item !== undefined) {
    parts.push(`Target item: ${typeof step.item === 'string' ? step.item : JSON.stringify(step.item)}`);
  }
  if (Array.isArray(step.inputFromKeys) && step.inputFromKeys.length > 0) {
    const inputs = {};
    for (const predKey of step.inputFromKeys) {
      if (Object.hasOwn(upstreamOutputs, predKey)) {
        inputs[predKey] = upstreamOutputs[predKey];
      }
    }
    if (Object.keys(inputs).length > 0) {
      parts.push(`Upstream stage validated JSON outputs:\n${JSON.stringify(inputs, null, 2)}`);
    }
  }
  if (step.contract.allowedPaths?.length > 0) {
    parts.push(`Allowed paths (${step.contract.accessMode}): ${step.contract.allowedPaths.join(', ')}`);
  }
  if (step.contract.outputSchema) {
    parts.push(
      `Respond with ONLY valid JSON matching this JSON Schema (no markdown wrapper if possible):\n${JSON.stringify(step.contract.outputSchema, null, 2)}`,
    );
  }
  return parts.join('\n\n');
}

function extractChunkText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : extractChunkText(part?.text ?? part?.content))).join('');
  }
  if (content && typeof content === 'object') {
    return typeof content.text === 'string' ? content.text : (typeof content.content === 'string' ? content.content : '');
  }
  return '';
}

function extractFinalAssistantText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' && msg?.type !== 'assistant') continue;
    const textVal = extractChunkText(msg.content) || (typeof msg.text === 'string' ? msg.text : '');
    if (textVal.trim()) return textVal;
  }
  return '';
}

function extractSpoolAssistantAndUsage(spoolRecords = []) {
  const acpChunks = [];
  const fallbackTexts = [];
  let usage = null;
  for (const rec of Array.isArray(spoolRecords) ? spoolRecords : []) {
    let obj = rec?.json && typeof rec.json === 'object' ? rec.json : null;
    if (!obj && typeof rec?.line === 'string' && rec.line.trim().startsWith('{')) {
      try { obj = JSON.parse(rec.line); } catch { obj = null; }
    }
    if (!obj) continue;
    const update = obj.method === 'session/update' ? obj.params?.update : null;
    if (update?.sessionUpdate === 'agent_message_chunk') {
      const piece = extractChunkText(update.content ?? update.text ?? update.message);
      if (piece) acpChunks.push(piece);
    } else if (obj.event === 'message' && obj.role === 'assistant') {
      const piece = extractChunkText(obj.content ?? obj.text);
      if (piece) fallbackTexts.push(piece);
    } else if (obj.type === 'assistant' || obj.role === 'assistant') {
      const piece = extractChunkText(obj.content ?? obj.text);
      if (piece) fallbackTexts.push(piece);
    }
    const promptId = typeof obj.id === 'string' && (obj.id === 'ragent-prompt' || obj.id.startsWith('ragent-prompt-'));
    if (promptId && obj.result?.usage && typeof obj.result.usage === 'object') {
      usage = obj.result.usage;
    } else if (obj.event === 'result' && obj.result) {
      if (typeof obj.result.response === 'string' && obj.result.response.trim()) {
        fallbackTexts.push(obj.result.response);
      }
      if (!usage && (obj.result.usage || obj.result.stats)) {
        usage = obj.result.usage || extractAgyCliUsage(obj.result);
      }
    }
  }
  const assistantText = acpChunks.length > 0 ? acpChunks.join('') : (fallbackTexts[fallbackTexts.length - 1] || '');
  return { assistantText, usage };
}

async function runViaRagentSession(deps, { step, prompt, runtime, project, cwd }) {
  const sessionManager = deps.sendMessage && deps.createSession
    ? { createSession: deps.createSession, sendMessage: deps.sendMessage, getHistory: deps.getHistory }
    : await import('./session-manager.mjs');
  const runsMod = deps.getRun
    ? { getRun: deps.getRun, getRunResult: deps.getRunResult, readRunSpoolRecords: deps.readRunSpoolRecords }
    : await import('./runs.mjs');
  const historyMod = deps.getHistory ? null : await import('./history.mjs');
  const readHistory = typeof deps.getHistory === 'function'
    ? deps.getHistory
    : (historyMod?.loadHistory || historyMod?.getHistory || null);

  const tool = trimString(runtime?.tool) || 'agy';
  const workFolder = trimString(runtime?.cwd) || trimString(cwd) || trimString(project?.rootPath || project?.folder) || process.cwd();
  const resolvedProject = project || (!deps.sendMessage ? await findProjectByRootPath(workFolder).catch(() => null) : null);
  const session = await sessionManager.createSession(workFolder, tool, `fanout:${step.key}`, {
    ...(trimString(runtime?.model) ? { model: trimString(runtime.model) } : {}),
    ...(trimString(runtime?.effort) ? { effort: trimString(runtime.effort) } : {}),
    ...(trimString(runtime?.providerProfile) ? { providerProfile: trimString(runtime.providerProfile) } : {}),
    ...(trimString(resolvedProject?.id) ? { projectId: trimString(resolvedProject.id) } : {}),
    riskMode: trimString(runtime?.riskMode) || 'full-auto',
  });

  const sendRes = await sessionManager.sendMessage(session.id, prompt, [], {
    ...(trimString(runtime?.runtimeFamily) ? { runtimeFamily: trimString(runtime.runtimeFamily) } : {}),
    ...(trimString(runtime?.model) ? { model: trimString(runtime.model) } : {}),
    ...(trimString(runtime?.effort) ? { effort: trimString(runtime.effort) } : {}),
    ...(trimString(runtime?.providerProfile) ? { providerProfile: trimString(runtime.providerProfile) } : {}),
    ...(trimString(runtime?.permissionMode) ? { permissionMode: trimString(runtime.permissionMode) } : {}),
    riskMode: trimString(runtime?.riskMode) || 'full-auto',
    accessMode: step.contract.accessMode,
    readOnlyRequired: false,
  });

  const runId = trimString(sendRes?.run?.id || sendRes?.runId);
  if (!runId) {
    throw executorError(FANOUT_STEP_FAILED, `Step '${step.key}' failed to start a run`, 502);
  }
  const timeoutMs = Number.isInteger(runtime?.timeoutMs) && runtime.timeoutMs > 0 ? runtime.timeoutMs : 180_000;
  const deadline = Date.now() + timeoutMs;
  let run = await runsMod.getRun(runId);
  while (run && !['completed', 'failed', 'cancelled'].includes(run.state)) {
    if (Date.now() > deadline) {
      throw executorError(FANOUT_STEP_FAILED, `Step '${step.key}' timed out waiting for run ${runId}`, 504, { runId });
    }
    await new Promise((r) => setTimeout(r, 100));
    run = await runsMod.getRun(runId);
  }
  if (!run || run.state !== 'completed') {
    throw executorError(
      FANOUT_STEP_FAILED,
      `Step '${step.key}' run ${runId} ended in state '${run?.state || 'missing'}': ${run?.failureReason || ''}`,
      502,
      { runId, state: run?.state },
    );
  }
  const runResult = runsMod.getRunResult ? await runsMod.getRunResult(runId).catch(() => null) : null;
  let hist = readHistory ? await readHistory(session.id).catch(() => []) : [];
  if (historyMod?.hydrateTimelineMessageSnapshots && Array.isArray(hist)) {
    try { hist = await historyMod.hydrateTimelineMessageSnapshots(session.id, hist); } catch { /* keep raw history */ }
  }
  let rawText = typeof runResult?.summary === 'string' && runResult.summary.trim()
    ? runResult.summary
    : extractFinalAssistantText(hist);

  const spoolRecords = typeof runsMod.readRunSpoolRecords === 'function'
    ? await runsMod.readRunSpoolRecords(runId).catch(() => [])
    : [];
  const spoolData = extractSpoolAssistantAndUsage(spoolRecords);
  if (!rawText.trim() && spoolData.assistantText) {
    rawText = spoolData.assistantText;
  }

  const runUsage = (run.usage && typeof run.usage === 'object' ? run.usage : null)
    || (run.usageProjection && typeof run.usageProjection === 'object' ? run.usageProjection : {});
  const spoolUsage = spoolData.usage && typeof spoolData.usage === 'object' ? spoolData.usage : {};
  const usage = normalizeStepUsage({
    inputTokens: spoolUsage.inputTokens ?? spoolUsage.input_tokens ?? runUsage.inputTokens ?? run.contextInputTokens,
    outputTokens: spoolUsage.outputTokens ?? spoolUsage.output_tokens ?? runUsage.outputTokens,
    thoughtTokens: spoolUsage.thoughtTokens ?? spoolUsage.reasoningTokens ?? runUsage.reasoningTokens ?? runUsage.thoughtTokens,
    cachedInputTokens: spoolUsage.cachedReadTokens ?? spoolUsage.cachedInputTokens ?? runUsage.cachedInputTokens,
    totalTokens: spoolUsage.totalTokens ?? spoolUsage.total_tokens ?? runUsage.totalTokens,
    costUsd: runUsage.costUsd ?? runUsage.estimatedCostUsd ?? spoolUsage.costUsd,
  });
  return {
    runId,
    sessionId: session.id,
    diskRun: !deps.sendMessage,
    rawText,
    usage,
  };
}

async function runViaAgyCli(deps, { step, prompt, runtime, cwd }) {
  const execFn = typeof deps.executeAgyPrompt === 'function'
    ? deps.executeAgyPrompt
    : (await import('../lib/agy-manager.mjs')).executeAgyPrompt;
  const result = await execFn(prompt, {
    ...(trimString(runtime?.model) ? { model: trimString(runtime.model) } : {}),
    ...(trimString(runtime?.effort) ? { effort: trimString(runtime.effort) } : {}),
    ...(trimString(runtime?.agent) ? { agent: trimString(runtime.agent) } : {}),
    ...(trimString(cwd) ? { project: trimString(cwd) } : {}),
    ...(trimString(runtime?.mode) ? { mode: trimString(runtime.mode) } : {}),
    format: 'json',
    sandbox: step.contract.accessMode === 'read',
    ...(Number.isInteger(runtime?.timeoutMs) ? { timeout: runtime.timeoutMs } : {}),
  });
  const rawText = typeof result === 'string'
    ? result
    : (typeof result?.response === 'string'
      ? result.response
      : (typeof result?.text === 'string' ? result.text : JSON.stringify(result)));
  return {
    runId: `fanout_agy_${randomUUID()}`,
    sessionId: `fanout_sess_${step.key}`,
    diskRun: false,
    rawText,
    usage: extractAgyCliUsage(result),
  };
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let firstError = null;
  async function nextWorker() {
    while (cursor < items.length) {
      if (firstError) return;
      const idx = cursor;
      cursor += 1;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        if (!firstError) firstError = err;
        return;
      }
    }
  }
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => nextWorker()));
  if (firstError) throw firstError;
  return results;
}

function buildTopologicalWaves(workItems) {
  const byKey = new Map(workItems.map((item) => [item.key, item]));
  const remaining = new Map(workItems.map((item) => [item.key, item]));
  const completed = new Set();
  const waves = [];
  while (remaining.size > 0) {
    const ready = [];
    for (const item of remaining.values()) {
      const allDepsDone = (item.dependencies || []).every((dep) => completed.has(dep.predecessorKey));
      if (allDepsDone) ready.push(item);
    }
    if (ready.length === 0) {
      throw executorError('FANOUT_DEADLOCK', 'Compiled workflow contains unresolvable dependencies', 400);
    }
    ready.sort((a, b) => {
      if (a.phaseIndex !== b.phaseIndex) return a.phaseIndex - b.phaseIndex;
      const ai = Number.isInteger(a.itemIndex) ? a.itemIndex : Number.MAX_SAFE_INTEGER;
      const bi = Number.isInteger(b.itemIndex) ? b.itemIndex : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return byKey.get(a.key) === byKey.get(b.key) ? 0 : 0;
    });
    for (const item of ready) {
      remaining.delete(item.key);
      completed.add(item.key);
    }
    waves.push(ready);
  }
  return waves;
}

function claimExecutionRecord({ workflowId, organizationId, projectId, digest }) {
  return withDatabase((db) => {
    ensureSchema(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare(
        'SELECT organization_id, status FROM factory_fanout_executions WHERE workflow_id = ?',
      ).get(workflowId);
      if (existing) {
        const msg = existing.organization_id === organizationId
          ? `Fan-out workflow '${workflowId}' already exists`
          : `Fan-out workflow '${workflowId}' belongs to a different organization`;
        throw executorError('FACTORY_CONFLICT', msg, 409, { workflowId });
      }
      const ts = nowIso();
      db.prepare(`
        INSERT INTO factory_fanout_executions
          (workflow_id, organization_id, project_id, workflow_instance_id, goal_id, status, digest, result_json, created_at, updated_at)
        VALUES (?, ?, ?, NULL, NULL, 'running', ?, ?, ?, ?)
      `).run(workflowId, organizationId, projectId, digest, JSON.stringify({ workflowId, organizationId, projectId, status: 'running' }), ts, ts);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
      throw error;
    }
  }, { mutate: true });
}

function updateExecutionRecord(record) {
  return withDatabase((db) => {
    ensureSchema(db);
    const ts = nowIso();
    const res = db.prepare(`
      UPDATE factory_fanout_executions
      SET workflow_instance_id = ?, goal_id = ?, status = ?, digest = ?, result_json = ?, updated_at = ?
      WHERE workflow_id = ? AND organization_id = ?
    `).run(
      record.workflowInstanceId || null,
      record.goalId || null,
      record.status,
      record.digest,
      JSON.stringify(record),
      ts,
      record.workflowId,
      record.organizationId,
    );
    if (res.changes !== 1) {
      throw executorError('FACTORY_CONFLICT', `Unable to update fan-out workflow '${record.workflowId}'`, 409, { workflowId: record.workflowId });
    }
  }, { mutate: true });
}

/** Look up a persisted Fan-Out workflow execution (scoped to organizationId). */
export async function getFactoryFanoutWorkflowExecution(organizationId, workflowId) {
  const orgId = trimString(organizationId);
  const wfId = trimString(workflowId);
  if (!orgId || !wfId) throw executorError('FACTORY_INVALID', 'organizationId and workflowId are required', 400);
  return withDatabase((db) => {
    ensureSchema(db);
    const row = db.prepare(
      'SELECT result_json FROM factory_fanout_executions WHERE organization_id = ? AND workflow_id = ?',
    ).get(orgId, wfId);
    if (!row) {
      throw executorError(FANOUT_WORKFLOW_NOT_FOUND, `Fan-out workflow '${wfId}' not found`, 404, { workflowId: wfId });
    }
    return JSON.parse(row.result_json);
  });
}

/** List persisted Fan-Out workflow executions for an organization (newest first). */
export async function listFactoryFanoutWorkflowExecutions(organizationId, { limit = 50 } = {}) {
  const orgId = trimString(organizationId);
  if (!orgId) throw executorError('FACTORY_INVALID', 'organizationId is required', 400);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return withDatabase((db) => {
    ensureSchema(db);
    const rows = db.prepare(
      'SELECT result_json FROM factory_fanout_executions WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(orgId, safeLimit);
    return rows.map((row) => JSON.parse(row.result_json));
  });
}

/**
 * Deterministically execute compiled `phase` / `parallel` / `pipeline` work items,
 * enforcing bounded concurrency, JSON Schema output validation, governor budget
 * reservation/settlement, and immutable per-item + aggregated ResultPackets.
 */
export async function executeFactoryFanout(depsOrInput = {}, maybeInput = null) {
  const hasTwoArgs = maybeInput !== null && maybeInput !== undefined;
  const deps = hasTwoArgs ? (depsOrInput || {}) : (depsOrInput?.deps || {});
  const input = hasTwoArgs ? maybeInput : (depsOrInput || {});

  const proposal = compileFactoryFanoutWorkflow(input);
  const { organizationId, projectId } = proposal.goal;
  const workflowId = trimString(input.workflowId) || `fanout_${randomUUID()}`;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  let org = null;
  try { org = await getOrganization(organizationId); } catch { org = null; }
  const orgRevision = Number.isInteger(org?.currentRevision) ? org.currentRevision : 0;
  if (org && org.projectId && org.projectId !== projectId) {
    throw executorError('FACTORY_CONFLICT', 'Project does not match organization', 409, {
      organizationId,
      projectId,
      organizationProjectId: org.projectId,
    });
  }

  const requestedCwd = trimString(input.runtime?.cwd) || trimString(input.cwd);
  let project = null;
  try { project = await getProject(projectId); } catch { project = null; }
  if (!project && requestedCwd && !deps.runStep) {
    const folderProject = await findProjectByRootPath(requestedCwd).catch(() => null);
    if (!folderProject || (folderProject.id && folderProject.id !== projectId)) {
      throw executorError('PROJECT_SCOPE_ESCAPE', 'Workflow cwd is outside registered project scope', 403, { cwd: requestedCwd });
    }
    project = folderProject;
  }
  const resolvedProjectRoot = trimString(project?.rootPath || project?.folder);
  if (requestedCwd && resolvedProjectRoot) {
    const realProjectRoot = await resolveRealRoot(resolvedProjectRoot).catch(() => '');
    const realRequestedCwd = await resolveRealRoot(requestedCwd).catch(() => '');
    if (!realProjectRoot || !realRequestedCwd || !(await scopeContainsPath(realProjectRoot, realRequestedCwd))) {
      throw executorError('PROJECT_SCOPE_ESCAPE', 'Workflow cwd escapes project folder', 403, {
        cwd: requestedCwd,
        projectFolder: resolvedProjectRoot,
      });
    }
  }

  await claimExecutionRecord({
    workflowId,
    organizationId,
    projectId,
    digest: sha256Hex({ workflowId, organizationId, projectId, inputDigest: proposal.inputDigest }),
  });

  let instantiated = null;
  if (input.actor && org && (input.instantiate === true || input.instantiate !== false)) {
    const commandId = trimString(input.commandId) || `cmd_fanout_${workflowId}`;
    const idempotencyKey = trimString(input.idempotencyKey) || `idem_fanout_${workflowId}`;
    instantiated = await instantiateFactoryFanoutWorkflow({
      ...input,
      organizationId,
      projectId,
      objective: proposal.goal.objective,
      commandId,
      idempotencyKey,
    }, input.actor);
  }

  const stallGovernorActive = getOrganizationRuntimeCapabilities().stallGovernor === true;
  const reserveFn = typeof deps.reserveBudget === 'function'
    ? deps.reserveBudget
    : (stallGovernorActive && org ? async (args) => {
        await initializeOrganizationGovernor();
        return reserveFactoryBudget(args);
      } : null);
  const settleFn = typeof deps.settleBudget === 'function'
    ? deps.settleBudget
    : (stallGovernorActive && org ? settleFactoryBudget : null);
  const releaseFn = typeof deps.releaseBudget === 'function'
    ? deps.releaseBudget
    : (stallGovernorActive && org ? releaseOrganizationBudgetReservation : null);

  const syntheticRuns = new Map();
  const syntheticResults = new Map();
  const stepOutcomesByKey = new Map();
  const validatedOutputsByKey = Object.create(null);
  const perItemMs = Object.create(null);
  const totalUsage = emptyUsage();
  const stepPacketIds = [];
  const diskRunIds = [];
  const allSyntheticRunIds = [];
  let totalRuns = 0;
  let totalObservedCost = 0;
  const settledReservations = [];
  const budgetLimits = {
    ...(org?.budget && typeof org.budget === 'object' ? org.budget : {}),
    ...(Number.isFinite(input.maxCost) ? { maxCost: input.maxCost } : {}),
    ...(Number.isInteger(input.maxRuns) ? { maxTotalRuns: input.maxRuns } : {}),
  };

  async function executeSingleStep(step) {
    const stepStartedMs = Date.now();
    const reservationCost = step.contract.budgetReservation?.cost || 0;
    const reservationId = `res_${workflowId}_${step.key}`;
    let reserved = false;

    if (reserveFn) {
      await reserveFn({
        organizationId,
        revision: orgRevision,
        reservationId,
        idempotencyKey: reservationId,
        delta: { runs: 1, cost: reservationCost },
        limits: budgetLimits,
        factoryWorkItemId: instantiated?.instance?.mapping?.[step.key] || '',
      });
      reserved = true;
    }

    let settled = false;
    try {
      const renderedPrompt = buildStepPrompt(step, validatedOutputsByKey);
      const upstreamData = {};
      for (const predKey of step.inputFromKeys || []) {
        if (Object.hasOwn(validatedOutputsByKey, predKey)) {
          upstreamData[predKey] = validatedOutputsByKey[predKey];
        }
      }

      let rawExec;
      if (typeof deps.runStep === 'function') {
        rawExec = await deps.runStep({
          step,
          key: step.key,
          item: step.item,
          index: step.itemIndex,
          phaseKey: step.phaseKey,
          prompt: renderedPrompt,
          upstreamOutputs: upstreamData,
          runtime: input.runtime || {},
          workflowId,
          allowedPaths: step.contract.allowedPaths,
          accessMode: step.contract.accessMode,
          outputSchema: step.contract.outputSchema,
        });
      } else if (typeof deps.executeAgyPrompt === 'function' || input.runtime?.transport === 'agy-cli') {
        rawExec = await runViaAgyCli(deps, {
          step,
          prompt: renderedPrompt,
          runtime: input.runtime,
          cwd: input.cwd || resolvedProjectRoot,
        });
      } else if (typeof deps.sendMessage === 'function' || input.runtime?.tool) {
        rawExec = await runViaRagentSession(deps, {
          step,
          prompt: renderedPrompt,
          runtime: input.runtime,
          project,
          cwd: input.cwd,
        });
      } else {
        throw executorError('FANOUT_RUNNER_MISSING', `No runStep, runtime, or agy executor configured for step '${step.key}'`, 400);
      }

      totalRuns += 1;
      const stepElapsedMs = Date.now() - stepStartedMs;
      perItemMs[step.key] = stepElapsedMs;

      const stepUsage = normalizeStepUsage(rawExec?.usage);
      addUsage(totalUsage, stepUsage);
      totalObservedCost += stepUsage.cost;
      if (totalObservedCost > proposal.resources.maxCost + 1e-9) {
        throw executorError('ORG_BUDGET_EXCEEDED', `Actual cost ${totalObservedCost} exceeded fan-out budget ${proposal.resources.maxCost}`, 409);
      }

      if (reserved && settleFn) {
        await settleFn({
          organizationId,
          revision: orgRevision,
          reservationId,
          idempotencyKey: reservationId,
          backendUsage: {
            runs: 1,
            tokens: stepUsage.totalTokens,
            cost: stepUsage.cost,
          },
        });
        settled = true;
        settledReservations.push({ reservationId, tokens: stepUsage.totalTokens, cost: stepUsage.cost });
      }

      let candidateOutput;
      if (rawExec && Object.hasOwn(rawExec, 'output') && rawExec.output !== undefined) {
        candidateOutput = rawExec.output;
      } else if (rawExec && typeof rawExec.rawText === 'string') {
        candidateOutput = step.contract.outputSchema ? extractStructuredJsonFromText(rawExec.rawText) : rawExec.rawText;
      } else if (typeof rawExec === 'string') {
        candidateOutput = step.contract.outputSchema ? extractStructuredJsonFromText(rawExec) : rawExec;
      } else if (step.contract.outputSchema) {
        throw schemaError(`Step '${step.key}' produced no structured output`, '$', step.contract.outputSchema);
      } else {
        candidateOutput = rawExec ?? null;
      }

      const validatedOutput = step.contract.outputSchema
        ? validateFanoutStepOutput(candidateOutput, step.contract.outputSchema)
        : candidateOutput;
      validatedOutputsByKey[step.key] = validatedOutput;

      const stepRunId = trimString(rawExec?.runId) || `fanout_run_${workflowId}_${step.key}`;
      const stepSessionId = trimString(rawExec?.sessionId) || `fanout_sess_${workflowId}_${step.key}`;
      const summaryText = typeof validatedOutput === 'string' ? validatedOutput : JSON.stringify(validatedOutput);

      let packet;
      if (rawExec?.diskRun) {
        diskRunIds.push(stepRunId);
        packet = await createExecutionPacket({
          runId: stepRunId,
          projectId,
          sessionId: stepSessionId,
          taskId: workflowId,
          attemptId: `${workflowId}:${step.key}`,
          organizationId,
          revision: orgRevision,
          phaseId: step.phaseKey,
          parentPacketIds: (step.dependencies || []).map((d) => stepOutcomesByKey.get(d.predecessorKey)?.packetId).filter(Boolean),
        });
      } else {
        const finishedAt = nowIso();
        const syntheticRun = {
          id: stepRunId,
          sessionId: stepSessionId,
          requestId: `${workflowId}:${step.key}`,
          state: 'completed',
          finalizedAt: finishedAt,
          contextInputTokens: stepUsage.inputTokens,
          contextWindowTokens: stepUsage.totalTokens,
        };
        const syntheticResult = {
          summary: summaryText.slice(0, 4000),
          changedFiles: Array.isArray(rawExec?.changedFiles) ? rawExec.changedFiles : [],
          artifacts: Array.isArray(rawExec?.artifacts) ? rawExec.artifacts : [],
          tests: Array.isArray(rawExec?.tests) ? rawExec.tests : [],
          acceptanceResults: Array.isArray(rawExec?.acceptanceResults) ? rawExec.acceptanceResults : [],
        };
        syntheticRuns.set(stepRunId, syntheticRun);
        syntheticResults.set(stepRunId, syntheticResult);
        allSyntheticRunIds.push(stepRunId);
        packet = await createExecutionPacket({
          runId: stepRunId,
          projectId,
          sessionId: stepSessionId,
          taskId: workflowId,
          attemptId: `${workflowId}:${step.key}`,
          organizationId,
          revision: orgRevision,
          phaseId: step.phaseKey,
          parentPacketIds: (step.dependencies || []).map((d) => stepOutcomesByKey.get(d.predecessorKey)?.packetId).filter(Boolean),
          deps: {
            getRun: async (id) => syntheticRuns.get(id) || null,
            getRunManifest: async (id) => ({ projectId, sessionId: syntheticRuns.get(id)?.sessionId || '', executionScope: { projectId } }),
            getRunResult: async (id) => syntheticResults.get(id) || {},
            listArtifacts: async () => [],
          },
        });
      }

      stepPacketIds.push(packet.packetId);
      const stepOutcome = {
        key: step.key,
        phaseKey: step.phaseKey,
        phaseIndex: step.phaseIndex,
        ...(Number.isInteger(step.itemIndex) ? { itemIndex: step.itemIndex } : {}),
        ...(step.item !== undefined ? { item: step.item } : {}),
        runId: stepRunId,
        sessionId: stepSessionId,
        packetId: packet.packetId,
        status: 'completed',
        wallClockMs: stepElapsedMs,
        usage: stepUsage,
        output: validatedOutput,
      };
      stepOutcomesByKey.set(step.key, stepOutcome);
      return stepOutcome;
    } catch (err) {
      if (reserved && !settled && releaseFn) {
        try {
          await releaseFn({
            organizationId,
            revision: orgRevision,
            reservationId,
            idempotencyKey: reservationId,
            reason: err?.message || 'fanout step failed',
          });
        } catch { /* preserve original error */ }
      }
      throw err;
    }
  }

  const waves = buildTopologicalWaves(proposal.workItems);
  let workflowStatus = 'completed';
  let failureInfo = null;

  try {
    for (const wave of waves) {
      const waveConcurrency = Math.min(
        input.maxConcurrency ?? proposal.resources.maxConcurrency,
        ...wave.map((item) => item.maxConcurrency || proposal.resources.maxConcurrency),
      );
      await runWithConcurrency(wave, waveConcurrency, executeSingleStep);
    }
  } catch (error) {
    workflowStatus = 'failed';
    failureInfo = {
      code: error?.code || FANOUT_STEP_FAILED,
      message: error?.message || 'Fan-out workflow failed',
      statusCode: error?.statusCode || 500,
    };

    const orderedPartialSteps = proposal.workItems
      .map((w) => stepOutcomesByKey.get(w.key))
      .filter(Boolean);
    const failedWallClockMs = Date.now() - startedAtMs;
    const failedRecord = {
      schemaVersion: 1,
      workflowId,
      workflowInstanceId: instantiated?.instance?.id || null,
      goalId: instantiated?.goal?.id || null,
      organizationId,
      projectId,
      objective: proposal.goal.objective,
      status: 'failed',
      error: failureInfo,
      startedAt,
      completedAt: nowIso(),
      proposal,
      phases: proposal.phases,
      steps: orderedPartialSteps,
      packetIds: stepPacketIds,
      aggregatedPacketId: null,
      aggregatedPacket: null,
      aggregatedOutput: null,
      metrics: {
        wallClockMs: failedWallClockMs,
        totalRuns,
        perItemMs,
        usage: {
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          thoughtTokens: totalUsage.thoughtTokens,
          totalTokens: totalUsage.totalTokens,
        },
      },
      budgetSettlement: {
        governorActive: Boolean(reserveFn),
        reservations: settledReservations,
        observedCost: totalObservedCost,
      },
    };
    failedRecord.digest = sha256Hex(failedRecord);
    try { await updateExecutionRecord(failedRecord); } catch { /* ignore persistence failure on error path */ }
    throw Object.assign(error, { workflowResult: failedRecord });
  }

  const orderedSteps = proposal.workItems.map((w) => stepOutcomesByKey.get(w.key));
  const phaseOutputs = proposal.phases.map((p) => ({
    key: p.key,
    name: p.name,
    index: p.index,
    outputs: p.stepKeys.map((k) => stepOutcomesByKey.get(k)?.output),
  }));
  const dependedKeys = new Set();
  for (const w of proposal.workItems) {
    for (const dep of w.dependencies || []) dependedKeys.add(dep.predecessorKey);
  }
  const sinkKeys = proposal.workItems.filter((w) => !dependedKeys.has(w.key)).map((w) => w.key);
  const sinkOutputs = sinkKeys.map((k) => stepOutcomesByKey.get(k)?.output);
  const aggregatedOutput = sinkOutputs.length === 1
    ? sinkOutputs[0]
    : (sinkOutputs.length > 0 ? sinkOutputs : orderedSteps.map((s) => s.output));

  let aggregatedPacket = null;
  const allRunIds = [...diskRunIds, ...allSyntheticRunIds];
  if (allRunIds.length > 0) {
    const projectForCheckpoint = project || { id: projectId };
    const useSyntheticCheckpoint = allSyntheticRunIds.length > 0 && diskRunIds.length === 0;
    aggregatedPacket = await createProjectCheckpoint({
      projectId,
      project: projectForCheckpoint,
      runIds: allRunIds,
      taskId: workflowId,
      requestId: `chk_${workflowId}`,
      organizationId,
      revision: orgRevision,
      ...(useSyntheticCheckpoint
        ? {
            deps: {
              getProject: async () => projectForCheckpoint,
              getWorkspaceById: async () => null,
              listActiveLeases: async () => [],
              previousCheckpointRevision: async () => null,
              getRun: async (id) => syntheticRuns.get(id) || null,
              getRunManifest: async (id) => ({ projectId, sessionId: syntheticRuns.get(id)?.sessionId || '', executionScope: { projectId } }),
              getRunResult: async (id) => syntheticResults.get(id) || {},
              listArtifacts: async () => [],
            },
          }
        : {}),
    });
  }

  const wallClockMs = Date.now() - startedAtMs;
  const result = {
    schemaVersion: 1,
    workflowId,
    workflowInstanceId: instantiated?.instance?.id || null,
    goalId: instantiated?.goal?.id || null,
    organizationId,
    projectId,
    objective: proposal.goal.objective,
    status: workflowStatus,
    startedAt,
    completedAt: nowIso(),
    proposal,
    phases: phaseOutputs,
    steps: orderedSteps,
    packetIds: stepPacketIds,
    aggregatedPacketId: aggregatedPacket?.packetId || null,
    aggregatedPacket,
    aggregatedOutput,
    metrics: {
      wallClockMs,
      totalRuns,
      perItemMs,
      usage: {
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        thoughtTokens: totalUsage.thoughtTokens,
        totalTokens: totalUsage.totalTokens,
      },
    },
    budgetSettlement: {
      governorActive: Boolean(reserveFn),
      reservations: settledReservations,
      observedCost: totalObservedCost,
    },
  };
  result.digest = sha256Hex(result);

  await updateExecutionRecord(result);
  return result;
}
