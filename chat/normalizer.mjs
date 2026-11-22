import { normalizeMessageEventAttachments } from './attachment-utils.mjs';
import { normalizeWorkStateUpdate } from './continuity-work-state.mjs';

let counter = 0;

function createEvent(type, fields = {}) {
  counter += 1;
  return {
    type,
    id: `evt_${String(counter).padStart(6, '0')}`,
    timestamp: Date.now(),
    ...fields,
  };
}

function trimOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeApprovalOptionItem(option) {
  if (typeof option === 'string') {
    const label = trimOptionalString(option).slice(0, 180);
    return label ? { label, value: label } : null;
  }
  if (!(option && typeof option === 'object')) return null;
  const label = trimOptionalString(
    option.label
    || option.title
    || option.text
    || option.name
    || option.value
    || option.id,
  ).slice(0, 180);
  if (!label) return null;
  const value = trimOptionalString(option.value || option.id || option.key || label).slice(0, 180);
  const description = trimOptionalString(
    option.description
    || option.detail
    || option.note
    || option.help,
  ).slice(0, 600);
  return {
    label,
    ...(value ? { value } : {}),
    ...(description ? { description } : {}),
  };
}

function normalizeApprovalOptions(options) {
  return (Array.isArray(options) ? options : [])
    .slice(0, 12)
    .map(normalizeApprovalOptionItem)
    .filter(Boolean);
}

function normalizeApprovalQuestionItem(question) {
  if (typeof question === 'string') {
    const text = trimOptionalString(question).slice(0, 800);
    return text ? { question: text } : null;
  }
  if (!(question && typeof question === 'object')) return null;
  const header = trimOptionalString(question.header || question.title || question.label).slice(0, 120);
  const id = trimOptionalString(question.id || question.key || question.name).slice(0, 120);
  const text = trimOptionalString(
    question.question
    || question.prompt
    || question.text
    || question.message,
  ).slice(0, 1000);
  const options = normalizeApprovalOptions(question.options || question.choices);
  if (!header && !id && !text && options.length === 0) return null;
  return {
    ...(id ? { id } : {}),
    ...(header ? { header } : {}),
    ...(text ? { question: text } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(typeof (question.multiSelect ?? question.isMultiSelect) === 'boolean'
      ? { multiSelect: question.multiSelect ?? question.isMultiSelect } : {}),
    ...(typeof question.isOther === 'boolean' ? { isOther: question.isOther } : {}),
    ...(typeof question.isSecret === 'boolean' ? { isSecret: question.isSecret } : {}),
  };
}

function normalizeApprovalQuestions({ question, prompt, questions, options, choices } = {}) {
  const normalizedQuestions = (Array.isArray(questions) ? questions : [])
    .slice(0, 6)
    .map(normalizeApprovalQuestionItem)
    .filter(Boolean);
  if (normalizedQuestions.length > 0) return normalizedQuestions;

  const normalizedQuestion = normalizeApprovalQuestionItem({
    question: question || prompt,
    options: Array.isArray(options) ? options : choices,
  });
  return normalizedQuestion ? [normalizedQuestion] : [];
}

export function planEventModeFields(event, { interactionMode = '', planAction = '' } = {}) {
  const normalizedInteractionMode = trimOptionalString(event?.interactionMode || interactionMode).toLowerCase();
  const normalizedPlanAction = trimOptionalString(event?.planAction || planAction).toLowerCase();
  const source = trimOptionalString(event?.source).toLowerCase();
  const explicitIntent = trimOptionalString(event?.planIntent).toLowerCase();
  const isCodexProgressList = ['codex', 'codex-app-server'].includes(source)
    && Array.isArray(event?.items)
    && event.items.length > 0
    && !trimOptionalString(event?.bodyMarkdown);
  const planIntent = isCodexProgressList
    ? 'progress'
    : (explicitIntent === 'proposal' || explicitIntent === 'progress'
    ? explicitIntent
    : (
        normalizedInteractionMode === 'plan'
        || normalizedPlanAction === 'revise'
        || source === 'ragent-plan-fallback'
        || source === 'ragent-plan-action'
          ? 'proposal'
          : 'progress'
      ));
  return {
    ...(normalizedInteractionMode ? { interactionMode: normalizedInteractionMode } : {}),
    planIntent,
  };
}

export function messageEvent(role, content, images, extra = {}) {
  const fields = { role, content, ...extra };
  if (images && images.length > 0) fields.attachments = images;
  return normalizeMessageEventAttachments(createEvent('message', fields));
}

export function toolUseEvent(toolName, toolInput, extra = {}) {
  return createEvent('tool_use', { role: 'assistant', toolName, toolInput, ...extra });
}

export function toolResultEvent(toolName, output, exitCode, extra = {}) {
  return createEvent('tool_result', { role: 'system', toolName, output, exitCode, ...extra });
}

function pickFinitePositiveNumber(source, keys = []) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function pickFinitePositiveInteger(source, keys = []) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

function normalizeDiffPreviewType(value) {
  if (value === ' ') return 'equal';
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'add' || normalized === 'added' || normalized === 'insert' || normalized === '+') return 'add';
  if (normalized === 'remove' || normalized === 'removed' || normalized === 'delete' || normalized === 'deleted' || normalized === '-') return 'remove';
  if (normalized === 'equal' || normalized === 'context') return 'equal';
  return '';
}

function normalizeDiffPreviewLine(value) {
  if (typeof value === 'string') {
    const marker = value.slice(0, 1);
    const type = normalizeDiffPreviewType(marker);
    return {
      type: type || 'equal',
      text: type ? value.slice(1) : value,
    };
  }
  if (!(value && typeof value === 'object')) return null;
  const type = normalizeDiffPreviewType(value.type || value.kind || value.op || value.marker);
  if (!type) return null;
  const text = typeof value.text === 'string'
    ? value.text
    : (typeof value.content === 'string'
      ? value.content
      : (typeof value.value === 'string' ? value.value : ''));
  const oldLine = pickFinitePositiveInteger(value, ['oldLine', 'old_line', 'beforeLine', 'before_line']);
  const newLine = pickFinitePositiveInteger(value, ['newLine', 'new_line', 'afterLine', 'after_line']);
  return {
    type,
    text: text.slice(0, 1000),
    ...(Number.isInteger(oldLine) ? { oldLine } : {}),
    ...(Number.isInteger(newLine) ? { newLine } : {}),
  };
}

function normalizeDiffPreview(source) {
  const rawPreview = Array.isArray(source?.preview)
    ? source.preview
    : (Array.isArray(source?.diffPreview) ? source.diffPreview : []);
  return rawPreview
    .slice(0, 80)
    .map((line) => normalizeDiffPreviewLine(line))
    .filter(Boolean);
}

function splitPatchLines(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return [];
  const trimmed = source.endsWith('\n') ? source.slice(0, -1) : source;
  return trimmed ? trimmed.split('\n') : [];
}

function readChangeType(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    return trimOptionalString(value.type || value.kind || value.changeType || value.status);
  }
  return '';
}

export function normalizeFileChangeType(value) {
  const normalized = readChangeType(value).toLowerCase();
  if (['add', 'added', 'create', 'created'].includes(normalized)) return 'add';
  if (['delete', 'deleted', 'remove', 'removed'].includes(normalized)) return 'delete';
  if (['edit', 'edited', 'modify', 'modified'].includes(normalized)) return 'edit';
  if (normalized === 'update' || normalized === 'updated') return 'update';
  return normalized || 'update';
}

function readHunkHeaderLineNumbers(line) {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
  if (!match) return null;
  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2]),
  };
}

function createDiffPreviewLine(type, text, lineNumber) {
  return {
    type,
    text: String(text || '').slice(0, 1000),
    ...(Number.isInteger(lineNumber) && lineNumber > 0
      ? (type === 'add' ? { newLine: lineNumber } : { oldLine: lineNumber })
      : {}),
  };
}

function parseUnifiedDiffDetails(diffText) {
  const lines = splitPatchLines(diffText);
  let added = 0;
  let removed = 0;
  let oldLine = null;
  let newLine = null;
  let sawHunk = false;
  const preview = [];

  for (const line of lines) {
    const hunk = readHunkHeaderLineNumbers(line);
    if (hunk) {
      sawHunk = true;
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      continue;
    }
    if (!sawHunk) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) {
      added += 1;
      if (preview.length < 80) {
        preview.push(createDiffPreviewLine('add', line.slice(1), newLine));
      }
      if (Number.isInteger(newLine)) newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      removed += 1;
      if (preview.length < 80) {
        preview.push(createDiffPreviewLine('remove', line.slice(1), oldLine));
      }
      if (Number.isInteger(oldLine)) oldLine += 1;
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (Number.isInteger(oldLine)) oldLine += 1;
    if (Number.isInteger(newLine)) newLine += 1;
  }

  if (!sawHunk || (added === 0 && removed === 0)) return null;
  return {
    added,
    removed,
    ...(preview.length > 0 ? { preview } : {}),
  };
}

function parseBareFileDiffDetails(diffText, changeType) {
  const lines = splitPatchLines(diffText);
  if (lines.length === 0) return null;
  if (changeType === 'add') {
    return {
      added: lines.length,
      removed: 0,
      preview: lines.slice(0, 80).map((line, index) => createDiffPreviewLine('add', line, index + 1)),
    };
  }
  if (changeType === 'delete') {
    return {
      added: 0,
      removed: lines.length,
      preview: lines.slice(0, 80).map((line, index) => createDiffPreviewLine('remove', line, index + 1)),
    };
  }
  return null;
}

function parseDiffDetails(source, changeType) {
  const diffText = typeof source?.diff === 'string' ? source.diff : '';
  if (!diffText) return null;
  return parseUnifiedDiffDetails(diffText) || parseBareFileDiffDetails(diffText, changeType);
}

export function fileChangeEvent(filePath, changeType, stats = {}, extra = {}) {
  const normalizedChangeType = normalizeFileChangeType(changeType);
  const diffDetails = parseDiffDetails(stats, normalizedChangeType);
  const added = pickFinitePositiveNumber(stats, ['added', 'additions', 'linesAdded', 'addedLines'])
    ?? diffDetails?.added;
  const removed = pickFinitePositiveNumber(stats, ['removed', 'deletions', 'linesRemoved', 'removedLines'])
    ?? diffDetails?.removed;
  const explicitPreview = normalizeDiffPreview(stats);
  const preview = explicitPreview.length > 0
    ? explicitPreview
    : (Array.isArray(diffDetails?.preview) ? diffDetails.preview : []);
  return createEvent('file_change', {
    role: 'system',
    filePath,
    changeType: normalizedChangeType,
    ...(Number.isFinite(added) ? { added } : {}),
    ...(Number.isFinite(removed) ? { removed } : {}),
    ...(preview.length > 0 ? { preview } : {}),
    ...extra,
  });
}

export function reasoningEvent(content, extra = {}) {
  return createEvent('reasoning', { role: 'assistant', content, ...extra });
}

export function textDeltaEvent(blockIndex, text, extra = {}) {
  return createEvent('text_delta', { role: 'assistant', blockIndex, text, ...extra });
}

export function planEvent({
  planId,
  artifactId,
  title,
  bodyMarkdown,
  items,
  state,
  status,
  source,
  revision,
  providerThreadId,
  providerTurnId,
  previousPlanId,
  lastPlanAction,
  sourceMessageSeq,
  interactionMode,
  planIntent,
} = {}) {
  const normalizedItems = Array.isArray(items)
    ? items
      .map((item) => (item && typeof item === 'object' ? item : { text: item }))
      .map((item) => ({
        text: trimOptionalString(item.text || item.step || item.title),
        status: trimOptionalString(item.status || item.state)
          || (item.completed === true ? 'completed' : 'pending'),
      }))
      .filter((item) => item.text)
    : [];
  const normalizedPlanId = trimOptionalString(planId || artifactId);
  const normalizedStatus = trimOptionalString(status || state) || 'running';
  return createEvent('plan', {
    role: 'assistant',
    ...(normalizedPlanId ? { planId: normalizedPlanId, artifactId: normalizedPlanId } : {}),
    ...(trimOptionalString(title) ? { title: trimOptionalString(title) } : {}),
    ...(trimOptionalString(bodyMarkdown) ? { bodyMarkdown: trimOptionalString(bodyMarkdown) } : {}),
    items: normalizedItems,
    state: normalizedStatus,
    status: normalizedStatus,
    ...(trimOptionalString(source) ? { source: trimOptionalString(source) } : {}),
    ...(Number.isInteger(revision) && revision > 0 ? { revision } : {}),
    ...(trimOptionalString(providerThreadId) ? { providerThreadId: trimOptionalString(providerThreadId) } : {}),
    ...(trimOptionalString(providerTurnId) ? { providerTurnId: trimOptionalString(providerTurnId) } : {}),
    ...(trimOptionalString(previousPlanId) ? { previousPlanId: trimOptionalString(previousPlanId) } : {}),
    ...(trimOptionalString(lastPlanAction) ? { lastPlanAction: trimOptionalString(lastPlanAction) } : {}),
    ...(Number.isInteger(sourceMessageSeq) && sourceMessageSeq > 0 ? { sourceMessageSeq } : {}),
    ...(trimOptionalString(interactionMode) ? { interactionMode: trimOptionalString(interactionMode) } : {}),
    ...(trimOptionalString(planIntent) ? { planIntent: trimOptionalString(planIntent) } : {}),
  });
}

export function approvalRequestEvent({
  approvalId,
  providerRequestId,
  providerMethod,
  providerThreadId,
  providerTurnId,
  providerItemId,
  providerApprovalId,
  runId,
  turnId,
  operation,
  kind,
  title,
  reason,
  command,
  cwd,
  filePaths,
  grantRoot,
  permissions,
  status,
  source,
  question,
  prompt,
  questions,
  options,
  choices,
  confirmLabel,
  denyLabel,
  approveMessage,
  denyMessage,
  isBlocking,
  elicitation,
  risk,
  explanation,
} = {}) {
  const normalizedApprovalId = trimOptionalString(approvalId || providerApprovalId || providerRequestId);
  if (!normalizedApprovalId) return null;
  // 人话解释快照（{summary, reason, saferAlternative}，additive）：
  // 审批事件是持久化事件，异步 LLM 结果无法回改，因此在标准化时快照；
  // 缺省时事件与之前字节兼容。
  const normalizedExplanation = explanation && typeof explanation === 'object'
    ? {
      ...(trimOptionalString(explanation.summary) ? { summary: trimOptionalString(explanation.summary) } : {}),
      ...(trimOptionalString(explanation.reason) ? { reason: trimOptionalString(explanation.reason) } : {}),
      ...(trimOptionalString(explanation.saferAlternative) ? { saferAlternative: trimOptionalString(explanation.saferAlternative) } : {}),
      ...(trimOptionalString(explanation.operation) ? { operation: trimOptionalString(explanation.operation) } : {}),
      ...(Array.isArray(explanation.targets) ? { targets: explanation.targets.map(trimOptionalString).filter(Boolean).slice(0, 20) } : {}),
      ...(typeof explanation.conditional === 'boolean' ? { conditional: explanation.conditional } : {}),
      ...(typeof explanation.partial === 'boolean' ? { partial: explanation.partial } : {}),
      ...(trimOptionalString(explanation.riskCode) ? { riskCode: trimOptionalString(explanation.riskCode) } : {}),
      ...(explanation.providerConflict === true ? { providerConflict: true } : {}),
      ...(explanation.elevated === true ? { elevated: true } : {}),
    }
    : null;
  // Phase 5: optional risk tier on the event (string like 'danger', or an object
  // like the gate's op.risk — normalized to its tier). Frontend layers already
  // probe evt.risk; absent risk keeps the event byte-compatible with before.
  const normalizedRisk = typeof risk === 'string'
    ? trimOptionalString(risk)
    : (risk && typeof risk === 'object' ? trimOptionalString(risk.tier) : '');
  // 统一风险契约：事件可选携带策略版本与稳定 reason code（additive，
  // 缺省时事件与之前字节兼容）。
  const normalizedRiskPolicyVersion = risk && typeof risk === 'object'
    ? trimOptionalString(risk.policyVersion)
    : '';
  const normalizedRiskReasonCodes = risk && typeof risk === 'object' && Array.isArray(risk.reasons)
    ? risk.reasons
      .map((item) => trimOptionalString(typeof item === 'string' ? item : item?.code))
      .filter(Boolean)
      .slice(0, 8)
    : [];
  const normalizedFilePaths = Array.isArray(filePaths)
    ? filePaths.map(trimOptionalString).filter(Boolean)
    : [];
  const normalizedQuestions = normalizeApprovalQuestions({ question, prompt, questions, options, choices });
  return createEvent('approval_request', {
    role: 'system',
    approvalId: normalizedApprovalId,
    status: trimOptionalString(status) || 'pending',
    ...(trimOptionalString(providerRequestId) ? { providerRequestId: trimOptionalString(providerRequestId) } : {}),
    ...(trimOptionalString(providerMethod) ? { providerMethod: trimOptionalString(providerMethod) } : {}),
    ...(trimOptionalString(providerThreadId) ? { providerThreadId: trimOptionalString(providerThreadId) } : {}),
    ...(trimOptionalString(providerTurnId) ? { providerTurnId: trimOptionalString(providerTurnId) } : {}),
    ...(trimOptionalString(providerItemId) ? { providerItemId: trimOptionalString(providerItemId) } : {}),
    ...(trimOptionalString(providerApprovalId) ? { providerApprovalId: trimOptionalString(providerApprovalId) } : {}),
    ...(trimOptionalString(runId) ? { runId: trimOptionalString(runId) } : {}),
    ...(trimOptionalString(turnId) ? { turnId: trimOptionalString(turnId) } : {}),
    ...(trimOptionalString(operation) ? { operation: trimOptionalString(operation) } : {}),
    ...(trimOptionalString(kind) ? { kind: trimOptionalString(kind) } : {}),
    ...(trimOptionalString(title) ? { title: trimOptionalString(title) } : {}),
    ...(trimOptionalString(reason) ? { reason: trimOptionalString(reason) } : {}),
    ...(trimOptionalString(command) ? { command: trimOptionalString(command) } : {}),
    ...(trimOptionalString(cwd) ? { cwd: trimOptionalString(cwd) } : {}),
    ...(normalizedFilePaths.length > 0 ? { filePaths: normalizedFilePaths } : {}),
    ...(trimOptionalString(grantRoot) ? { grantRoot: trimOptionalString(grantRoot) } : {}),
    ...(permissions && typeof permissions === 'object' ? { permissions } : {}),
    ...(trimOptionalString(source) ? { source: trimOptionalString(source) } : {}),
    ...(normalizedQuestions.length > 0 ? { questions: normalizedQuestions } : {}),
    ...(typeof isBlocking === 'boolean' ? { isBlocking } : {}),
    ...(elicitation && typeof elicitation === 'object' ? { elicitation } : {}),
    ...(trimOptionalString(confirmLabel) ? { confirmLabel: trimOptionalString(confirmLabel) } : {}),
    ...(trimOptionalString(denyLabel) ? { denyLabel: trimOptionalString(denyLabel) } : {}),
    ...(trimOptionalString(approveMessage) ? { approveMessage: trimOptionalString(approveMessage) } : {}),
    ...(trimOptionalString(denyMessage) ? { denyMessage: trimOptionalString(denyMessage) } : {}),
    ...(normalizedRisk ? { risk: normalizedRisk } : {}),
    ...(normalizedRiskPolicyVersion ? { riskPolicyVersion: normalizedRiskPolicyVersion } : {}),
    ...(normalizedRiskReasonCodes.length > 0 ? { riskReasonCodes: normalizedRiskReasonCodes } : {}),
    ...(normalizedExplanation && Object.keys(normalizedExplanation).length > 0 ? { explanation: normalizedExplanation } : {}),
  });
}

export function approvalResponseEvent({
  approvalId,
  decision,
  status,
  source,
  providerRequestId,
  providerMethod,
  redacted,
} = {}) {
  const normalizedApprovalId = trimOptionalString(approvalId);
  if (!normalizedApprovalId) return null;
  const normalizedDecision = trimOptionalString(decision);
  const normalizedStatus = trimOptionalString(status)
    || (normalizedDecision === 'denied' || normalizedDecision === 'cancelled' ? 'denied' : 'approved');
  return createEvent('approval_response', {
    role: 'system',
    approvalId: normalizedApprovalId,
    status: normalizedStatus,
    ...(normalizedDecision ? { decision: normalizedDecision } : {}),
    ...(trimOptionalString(source) ? { source: trimOptionalString(source) } : {}),
    ...(trimOptionalString(providerRequestId) ? { providerRequestId: trimOptionalString(providerRequestId) } : {}),
    ...(trimOptionalString(providerMethod) ? { providerMethod: trimOptionalString(providerMethod) } : {}),
    ...(redacted === true ? { redacted: true } : {}),
  });
}

export function managerContextEvent(content, extra = {}) {
  return createEvent('manager_context', { role: 'system', content, ...extra });
}

export function statusEvent(content, extra = {}) {
  return createEvent('status', { role: 'system', content, ...extra });
}

export function usageEvent({
  contextTokens,
  inputTokens,
  outputTokens,
  cachedInputTokens,
  reasoningTokens,
  costUsd,
  estimatedCostUsd,
  estimatedCostModel,
  contextWindowTokens,
  contextSource,
  costSource,
  provider,
  runtimeFamily,
  reportedModel,
  providerSessionId,
  usageScope,
  usageAccountingTokens,
} = {}) {
  return createEvent('usage', {
    role: 'system',
    ...(Number.isFinite(contextTokens) ? { contextTokens } : {}),
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(Number.isFinite(cachedInputTokens) ? { cachedInputTokens } : {}),
    ...(Number.isFinite(reasoningTokens) ? { reasoningTokens } : {}),
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
    ...(Number.isFinite(estimatedCostUsd) ? { estimatedCostUsd } : {}),
    ...(typeof estimatedCostModel === 'string' && estimatedCostModel ? { estimatedCostModel } : {}),
    ...(Number.isFinite(contextWindowTokens) ? { contextWindowTokens } : {}),
    ...(typeof contextSource === 'string' && contextSource ? { contextSource } : {}),
    ...(typeof costSource === 'string' && costSource ? { costSource } : {}),
    ...(typeof provider === 'string' && provider ? { provider } : {}),
    ...(typeof runtimeFamily === 'string' && runtimeFamily ? { runtimeFamily } : {}),
    ...(typeof reportedModel === 'string' && reportedModel ? { reportedModel } : {}),
    ...(typeof providerSessionId === 'string' && providerSessionId ? { providerSessionId } : {}),
    ...(typeof usageScope === 'string' && usageScope ? { usageScope } : {}),
    ...(Number.isInteger(usageAccountingTokens) && usageAccountingTokens >= 0 ? { usageAccountingTokens } : {}),
  });
}

export function contextOperationEvent({
  operation,
  phase,
  title,
  summary,
  reason,
  trigger,
  content,
  ...extra
} = {}) {
  const normalizedOperation = trimOptionalString(operation);
  const normalizedPhase = trimOptionalString(phase);
  const normalizedTitle = trimOptionalString(title);
  const normalizedSummary = trimOptionalString(summary);
  const normalizedReason = trimOptionalString(reason);
  const normalizedTrigger = trimOptionalString(trigger);
  const normalizedContent = trimOptionalString(content)
    || normalizedTitle
    || normalizedSummary
    || normalizedOperation
    || 'Context operation';

  return createEvent('context_operation', {
    role: 'system',
    ...(normalizedOperation ? { operation: normalizedOperation } : {}),
    ...(normalizedPhase ? { phase: normalizedPhase } : {}),
    ...(normalizedTitle ? { title: normalizedTitle } : {}),
    ...(normalizedSummary ? { summary: normalizedSummary } : {}),
    ...(normalizedReason ? { reason: normalizedReason } : {}),
    ...(normalizedTrigger ? { trigger: normalizedTrigger } : {}),
    content: normalizedContent,
    ...extra,
  });
}

// Structured task facts are deliberately separate from assistant prose. The
// reducer accepts only this bounded, provenance-carrying event shape; callers
// must not use it to assert deterministic file, test, process, or approval
// facts that belong to the execution projection.
export function workStateUpdateEvent(input = {}) {
  const normalized = normalizeWorkStateUpdate(input);
  if (!normalized) return null;
  return createEvent('work_state_update', {
    role: 'system',
    ...normalized,
  });
}
