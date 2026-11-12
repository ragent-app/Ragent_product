/**
 * Claude Code bidirectional stream-json protocol.
 *
 * The one-shot claude path (claude-stream-json) spawns
 *   claude -p <prompt> --output-format stream-json ...
 * per turn and exits. The bidirectional mode instead keeps one Claude Code
 * process alive across turns by feeding it newline-delimited JSON user
 * messages on stdin:
 *
 *   claude -p \
 *     --input-format stream-json \
 *     --output-format stream-json \
 *     --verbose \
 *     --include-partial-messages
 *
 * The first user message starts the turn. The stdout frames are identical to
 * the one-shot stream-json format (system/init, stream_event, assistant,
 * result), so output parsing is shared with the existing claude adapter —
 * this module only owns the stdin side (turn injection) plus helpers the
 * sidecar needs for terminal/error detection.
 *
 * Claude Code exposes SDK control requests on the same stdin channel. AgentoC
 * initializes that control channel, uses the native `interrupt` request to stop
 * the active turn, then sends the redirect text as the next user message. This
 * is stop-and-redirect steering, not surgical mutation of an in-flight turn.
 * The stdin protocol is still partly undocumented upstream
 * (anthropics/claude-code#24594, #44911); treat the shapes below as
 * empirically validated against the local CLI rather than a stable contract.
 */

export const CLAUDE_BIDI_RUNTIME_FAMILY = 'claude-stream-json-bidi';

export function buildClaudeBidiInitializeMessage(requestId, options = {}) {
  const request = {
    subtype: 'initialize',
    hooks: options.hooks === undefined ? null : options.hooks,
  };
  if (options.agents !== undefined) request.agents = options.agents;
  return {
    type: 'control_request',
    request_id: String(requestId || '').trim(),
    request,
  };
}

export function buildClaudeBidiInterruptMessage(requestId) {
  return {
    type: 'control_request',
    request_id: String(requestId || '').trim(),
    request: { subtype: 'interrupt' },
  };
}

export function readClaudeBidiApprovalRequest(message) {
  if (message?.type !== 'control_request' || message?.request?.subtype !== 'can_use_tool') return null;
  const requestId = typeof message.request_id === 'string' ? message.request_id.trim() : '';
  if (!requestId) return null;
  const request = message.request;
  const toolName = typeof request.tool_name === 'string' ? request.tool_name : '';
  let kind = 'permissions';
  let requestClass = 'tool_invocation';
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    kind = 'command';
    requestClass = 'command_invocation';
  } else if (toolName === 'AskUserQuestion') {
    kind = 'question';
    requestClass = 'user_question';
  } else if (toolName === 'ExitPlanMode') {
    // Claude Code in plan mode (`--permission-mode plan`) asks permission to
    // leave plan mode via ExitPlanMode; the request input carries the drafted
    // plan ({ plan: { title, text } }). Classify it as a plan approval so the
    // card can show the actual plan instead of a bare tool-name prompt.
    kind = 'plan';
    requestClass = 'plan_review';
  }
  return {
    approvalId: `claude:${requestId}`,
    providerRequestId: requestId,
    providerRequestIdString: requestId,
    providerMethod: 'can_use_tool',
    kind,
    requestClass,
    params: request,
    request: message,
  };
}

const CLAUDE_BIDI_MCP_TOOL_PREFIX = 'mcp__';
const CLAUDE_BIDI_MANAGED_MCP_TOOLS = new Set([
  'agentoc_request_actions',
  'agentoc_create_agent',
]);

function readClaudeBidiMcpToolParts(toolName) {
  const normalized = typeof toolName === 'string' ? toolName.trim() : '';
  if (!normalized.startsWith(CLAUDE_BIDI_MCP_TOOL_PREFIX)) return null;
  const encoded = normalized.slice(CLAUDE_BIDI_MCP_TOOL_PREFIX.length);
  const separatorIndex = encoded.lastIndexOf('__');
  if (separatorIndex <= 0 || separatorIndex >= encoded.length - 2) return null;
  const serverName = encoded.slice(0, separatorIndex).trim();
  const managedToolName = encoded.slice(separatorIndex + 2).trim();
  if (!serverName || !managedToolName) return null;
  return { serverName, managedToolName, toolName: normalized };
}

export function isClaudeBidiMcpToolName(toolName) {
  return !!readClaudeBidiMcpToolParts(toolName);
}

export function readClaudeBidiManagedMcpRequest(message) {
  const approval = readClaudeBidiApprovalRequest(message);
  if (!approval) return null;
  const parts = readClaudeBidiMcpToolParts(approval.params?.tool_name);
  if (!parts || !CLAUDE_BIDI_MANAGED_MCP_TOOLS.has(parts.managedToolName)) return null;
  return {
    ...approval,
    mcpServerName: parts.serverName,
    mcpToolName: parts.managedToolName,
  };
}

// The managed executor, not the provider tool, handles privileged operations.
// The provider gate is denied to prevent a second execution; explain that
// internal denial without exposing command output as trusted instructions.
export function describeManagedPrivilegeResponse(entry) {
  if (!entry?.privilegedBatchId || !entry?.privilegedOpId) return '';
  const decision = entry.privilegedDecision;
  const source = entry.privilegedDecisionSource;
  const review = decision === 'approved'
    ? (source === 'owner' ? 'The owner approved the managed operation.' : 'The managed operation was authorized.')
    : decision === 'denied'
      ? (source === 'owner' ? 'The owner did not approve the managed operation.' : 'The managed operation was not authorized.')
      : 'The approval decision is unknown.';
  const state = entry.privilegedExecutionState;
  const outcome = state === 'completed'
    ? 'The managed executor completed it successfully.'
    : state === 'failed'
      ? 'The managed execution failed; it may have had partial effects.'
      : 'The managed execution outcome is unknown.';
  return `Ragent blocked the original tool request to prevent duplicate execution. ${review} ${outcome} Do not automatically repeat the operation; report the recorded result accurately.`;
}

export function buildClaudeBidiApprovalResponseMessage(approval, decision, choices, options = {}) {
  const requestId = approval?.providerRequestIdString || approval?.providerRequestId;
  if (!requestId) return null;
  const normalized = String(decision || '').trim().toLowerCase();
  const allow = normalized === 'approve' || normalized === 'approve_for_session';
  const request = approval?.params || approval?.request?.request || {};
  const askUserInput = allow
    ? buildAskUserQuestionUpdatedInput(approval, request, choices, options?.customAnswer, options?.customAnswers, options?.multiChoices)
    : null;
  if (allow && Array.isArray(options?.multiChoices) && !askUserInput) return null;
  const baseInput = request.input && typeof request.input === 'object' ? request.input : {};
  const overrideInput = options?.updatedInput && typeof options.updatedInput === 'object'
    ? options.updatedInput
    : null;
  const updatedInput = overrideInput ? { ...baseInput, ...overrideInput } : baseInput;
  const response = allow
    ? askUserInput
      ? { behavior: 'allow', updatedInput: askUserInput, updatedPermissions: [] }
      : {
          behavior: 'allow',
          updatedInput,
          updatedPermissions: normalized === 'approve_for_session' && Array.isArray(request.permission_suggestions)
            ? request.permission_suggestions
            : [],
        }
    : { behavior: 'deny', message: typeof options?.message === 'string' && options.message ? options.message : 'User denied this tool request.', interrupt: normalized === 'cancel' };
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: String(requestId), response },
  };
}

export function buildClaudeBidiManagedMcpResponse(approval, decision = 'approve') {
  const requestId = approval?.providerRequestIdString || approval?.providerRequestId;
  if (!requestId) return null;
  const normalized = String(decision || '').trim().toLowerCase();
  const allow = normalized === 'approve'
    || normalized === 'approved'
    || normalized === 'allow';
  const response = allow
    ? { behavior: 'allow', updatedInput: {}, updatedPermissions: [] }
    : { behavior: 'deny', message: 'User denied this tool request.' };
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: String(requestId), response },
  };
}

// AskUserQuestion arrives as a can_use_tool permission prompt whose input holds the
// generated questions/options. Per the Claude Agent SDK contract, the host answers it by
// returning behavior:'allow' with updatedInput = { questions: <echo>, answers: { [questionText]: label } }.
// `choices` is a per-question array of selected option INDICES (from the UI); we resolve them
// against the ORIGINAL request.input.questions so the answer keys/values match what Claude sent.
function isAskUserQuestionApproval(approval, request) {
  if (approval?.kind === 'question') return true;
  const toolName = typeof request?.tool_name === 'string' ? request.tool_name : '';
  return toolName === 'AskUserQuestion';
}

function buildAskUserQuestionUpdatedInput(approval, request, choices, customAnswer = '', customAnswers = [], multiChoices = null) {
  if (!isAskUserQuestionApproval(approval, request)) return null;
  const questions = Array.isArray(request?.input?.questions) ? request.input.questions : [];
  if (questions.length === 0) return null;
  const choiceList = Array.isArray(choices) ? choices : [];
  const normalizedCustomAnswer = typeof customAnswer === 'string' ? customAnswer.trim() : '';
  const answers = {};
  let answered = 0;
  questions.forEach((question, index) => {
    const rawChoice = choiceList[index];
    const optionIndex = Number.isInteger(rawChoice)
      ? rawChoice
      : Number.parseInt(String(rawChoice ?? ''), 10);
    const options = Array.isArray(question?.options) ? question.options : [];
    if (Array.isArray(multiChoices)) {
      const selected = multiChoices[index];
      if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some((i) => !Number.isInteger(i) || i < 0 || i >= options.length)
          || (!question?.multiSelect && selected.length > 1)) return;
      const labels = selected.map((i) => typeof options[i]?.label === 'string' ? options[i].label.trim() : '').filter(Boolean);
      const text = typeof customAnswers?.[index] === 'string' ? customAnswers[index].trim().slice(0, 8000) : '';
      const questionText = typeof question?.question === 'string' ? question.question.trim() : '';
      if (text && !question?.multiSelect && labels.length) return;
      if (text) labels.push(text);
      if (!questionText || labels.length === 0) return;
      answers[questionText] = labels.join(', ');
      answered += 1;
      return;
    }
    const option = Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < options.length
      ? options[optionIndex]
      : null;
    const questionAnswer = typeof customAnswers?.[index] === 'string' ? customAnswers[index].trim().slice(0, 8000) : '';
    const answer = questionAnswer || normalizedCustomAnswer;
    if (!option && !answer) return;
    const label = option && typeof option.label === 'string' && option.label.trim()
      ? option.label
      : (option ? String(option.label ?? '').trim() : answer);
    const questionText = typeof question.question === 'string' && question.question.trim()
      ? question.question
      : String(question.question ?? '').trim();
    if (!label || !questionText) return;
    answers[questionText] = label;
    answered += 1;
  });
  if (answered === 0 || (Array.isArray(multiChoices) && (multiChoices.length !== questions.length || answered !== questions.length))) return null;
  return { questions, answers };
}

/**
 * Build a user-turn envelope to write on stdin.
 *
 * @param {object} options
 * @param {string} [options.text]       Plain-text user message.
 * @param {string|Array} [options.content] Content (string or content-block
 *   array). When supplied, overrides `text`.
 * @param {string} [options.sessionId]  Optional provider session id to pin.
 * @returns {{type:'user', message:{role:'user', content:(string|Array)}, session_id?:string}}
 */
export function buildClaudeBidiUserMessage({ text, content, sessionId } = {}) {
  const messageContent = Array.isArray(content) || content !== undefined
    ? content
    : (typeof text === 'string' ? text : String(text ?? ''));
  const message = { role: 'user', content: messageContent };
  const envelope = { type: 'user', message };
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (sid) envelope.session_id = sid;
  return envelope;
}

/** Serialize an envelope with a trailing newline, ready for proc.stdin.write(). */
export function serializeClaudeBidiMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

/** Read the provider session id from any output frame. */
export function readClaudeBidiSessionId(message) {
  if (!message || typeof message !== 'object') return '';
  const direct = typeof message.session_id === 'string' ? message.session_id.trim() : '';
  return direct;
}

export function readClaudeBidiControlResponse(message) {
  if (message?.type !== 'control_response') return null;
  const response = message.response && typeof message.response === 'object'
    ? message.response
    : {};
  const requestId = typeof response.request_id === 'string'
    ? response.request_id.trim()
    : (typeof message.request_id === 'string' ? message.request_id.trim() : '');
  return {
    requestId,
    response,
    success: response.subtype === 'success',
  };
}

/** A top-level `result` frame marks the end of a turn (terminal). */
export function isClaudeBidiTurnTerminal(message) {
  return message?.type === 'result';
}

export function isClaudeBidiTurnError(message) {
  const terminalReason = typeof message?.terminal_reason === 'string'
    ? message.terminal_reason.trim().toLowerCase()
    : '';
  const resultText = typeof message?.result === 'string' ? message.result.trim() : '';
  const invalidSuccessResult = message?.subtype === 'success'
    && (
      typeof message.result !== 'string'
      || !resultText
      || /empty\s+or\s+malformed\s+response/i.test(resultText)
    );
  return message?.type === 'result'
    && (
      message.is_error === true
      || message.subtype === 'error'
      || message.error
      || terminalReason === 'api_error'
      || terminalReason === 'error'
      || terminalReason === 'failed'
      || terminalReason === 'aborted'
      || terminalReason === 'cancelled'
      || terminalReason === 'canceled'
      || terminalReason === 'interrupted'
      || terminalReason === 'timeout'
      || /^api\s+error\b/i.test(resultText)
      || invalidSuccessResult
    );
}
