#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildClaudeBidiApprovalResponseMessage,
  describeManagedPrivilegeResponse,
  buildClaudeBidiManagedMcpResponse,
  buildClaudeBidiInitializeMessage,
  buildClaudeBidiInterruptMessage,
  buildClaudeBidiUserMessage,
  isClaudeBidiTurnError,
  isClaudeBidiTurnTerminal,
  isClaudeBidiMcpToolName,
  readClaudeBidiControlResponse,
  readClaudeBidiApprovalRequest,
  readClaudeBidiManagedMcpRequest,
  serializeClaudeBidiMessage,
} from '../chat/claude-bidi-protocol.mjs';

assert.deepEqual(
  buildClaudeBidiInitializeMessage('init-1'),
  {
    type: 'control_request',
    request_id: 'init-1',
    request: { subtype: 'initialize', hooks: null },
  },
);
assert.deepEqual(
  buildClaudeBidiInterruptMessage('interrupt-1'),
  {
    type: 'control_request',
    request_id: 'interrupt-1',
    request: { subtype: 'interrupt' },
  },
);
assert.deepEqual(
  buildClaudeBidiUserMessage({ text: 'hello', sessionId: 'session-1' }),
  {
    type: 'user',
    message: { role: 'user', content: 'hello' },
    session_id: 'session-1',
  },
);
assert.equal(
  serializeClaudeBidiMessage(buildClaudeBidiInterruptMessage('interrupt-1')),
  '{"type":"control_request","request_id":"interrupt-1","request":{"subtype":"interrupt"}}\n',
);
assert.deepEqual(
  readClaudeBidiControlResponse({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'init-1', response: {} },
  }),
  {
    requestId: 'init-1',
    response: { subtype: 'success', request_id: 'init-1', response: {} },
    success: true,
  },
);
assert.equal(readClaudeBidiControlResponse({ type: 'assistant' }), null);
const approvalRequest = readClaudeBidiApprovalRequest({
  type: 'control_request',
  request_id: 'approval-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'rm temp.txt' },
    permission_suggestions: [{ type: 'addRules' }],
    tool_use_id: 'tool-1',
  },
});
assert.equal(approvalRequest.approvalId, 'claude:approval-1');
assert.equal(approvalRequest.kind, 'command');
assert.equal(approvalRequest.requestClass, 'command_invocation');
assert.deepEqual(
  buildClaudeBidiApprovalResponseMessage(approvalRequest, 'approve'),
  {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'approval-1',
      response: { behavior: 'allow', updatedInput: { command: 'rm temp.txt' }, updatedPermissions: [] },
    },
  },
);
assert.equal(
  buildClaudeBidiApprovalResponseMessage(
    approvalRequest,
    'approve',
    undefined,
    { updatedInput: { command: 'echo real-command' } },
  ).response.response.updatedInput.command,
  'echo real-command',
);
assert.equal(
  buildClaudeBidiApprovalResponseMessage(approvalRequest, 'deny').response.response.behavior,
  'deny',
);
const managedEntry = {
  privilegedBatchId: 'batch', privilegedOpId: 'op', privilegedDecision: 'approved',
  privilegedDecisionSource: 'owner', privilegedExecutionState: 'completed',
};
const managedMessage = describeManagedPrivilegeResponse(managedEntry);
assert.match(managedMessage, /owner approved/);
assert.match(managedMessage, /completed it successfully/);
assert.match(managedMessage, /prevent duplicate execution/);
assert.equal(buildClaudeBidiApprovalResponseMessage(approvalRequest, 'deny', [], {
  message: managedMessage,
}).response.response.message, managedMessage);
assert.match(describeManagedPrivilegeResponse({ ...managedEntry, privilegedExecutionState: 'failed' }), /partial effects/);
assert.match(describeManagedPrivilegeResponse({ ...managedEntry, privilegedExecutionState: 'unknown' }), /outcome is unknown/);
assert.match(describeManagedPrivilegeResponse({ ...managedEntry, privilegedDecision: 'denied', privilegedDecisionSource: 'policy' }), /not authorized/);
assert.equal(describeManagedPrivilegeResponse({}), '');

const managedMcpApproval = readClaudeBidiManagedMcpRequest({
  type: 'control_request',
  request_id: 'managed-mcp-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'mcp__agentoc_actions_0123456789abcdef__agentoc_create_agent',
    input: { agent: { name: 'Workflow helper' } },
  },
});
assert.equal(isClaudeBidiMcpToolName(managedMcpApproval.params.tool_name), true);
assert.equal(managedMcpApproval.mcpServerName, 'agentoc_actions_0123456789abcdef');
assert.equal(managedMcpApproval.mcpToolName, 'agentoc_create_agent');
const renamedManagedMcpApproval = readClaudeBidiManagedMcpRequest({ type: 'control_request', request_id: 'renamed', request: { subtype: 'can_use_tool', tool_name: 'mcp__agentoc_actions_0123456789abcdef__ragent_create_agent', input: {} } });
assert.equal(renamedManagedMcpApproval?.mcpToolName, 'ragent_create_agent');
assert.deepEqual(
  buildClaudeBidiManagedMcpResponse(managedMcpApproval),
  {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'managed-mcp-1',
      response: { behavior: 'allow', updatedInput: {}, updatedPermissions: [] },
    },
  },
);
const foreignManagedMcp = readClaudeBidiManagedMcpRequest({
    type: 'control_request',
    request_id: 'foreign-mcp-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'mcp__foreign_server__agentoc_create_agent',
      input: {},
    },
  });
assert.equal(foreignManagedMcp.mcpServerName, 'foreign_server');
assert.equal(foreignManagedMcp.mcpToolName, 'agentoc_create_agent');
// === AskUserQuestion forward + return path regression ===
const askUserQuestions = [
  {
    question: 'Which color?',
    options: [
      { label: 'Red', description: 'warm' },
      { label: 'Blue', description: 'cool' },
    ],
  },
];
const askUserApproval = readClaudeBidiApprovalRequest({
  type: 'control_request',
  request_id: 'ask-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: { questions: askUserQuestions },
    tool_use_id: 'tool-ask-1',
  },
});
// Forward: kind='question', questions/options preserved on params.
assert.equal(askUserApproval.kind, 'question');
assert.equal(askUserApproval.requestClass, 'user_question');
assert.equal(askUserApproval.params.input.questions, askUserQuestions);

// Return: a selected option INDEX is resolved against the original questions and mapped
// to a structured { questions, answers } answer. behavior stays 'allow' so the tool runs,
// but updatedInput now carries the user's choice instead of a generic echo.
assert.deepEqual(
  buildClaudeBidiApprovalResponseMessage(askUserApproval, 'approve', [0]),
  {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'ask-1',
      response: {
        behavior: 'allow',
        updatedInput: { questions: askUserQuestions, answers: { 'Which color?': 'Red' } },
        updatedPermissions: [],
      },
    },
  },
);
// Selecting the second option resolves to its label.
assert.deepEqual(
  buildClaudeBidiApprovalResponseMessage(askUserApproval, 'approve', [1]).response.response.updatedInput.answers,
  { 'Which color?': 'Blue' },
);

// The mobile Ask User surface always exposes an "other response" field. A
// custom answer fills the first unanswered question while preserving the
// provider's structured AskUserQuestion contract.
assert.deepEqual(
  buildClaudeBidiApprovalResponseMessage(askUserApproval, 'approve', [-1], {
    customAnswer: 'Use a muted teal instead.',
  }).response.response.updatedInput.answers,
  { 'Which color?': 'Use a muted teal instead.' },
);

const multipleApproval = readClaudeBidiApprovalRequest({
  type: 'control_request', request_id: 'ask-many', request: {
    subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [
      { question: 'First?', options: [{ label: 'A' }] },
      { question: 'Second?', options: [{ label: 'B' }] },
      { question: 'Third?', options: [{ label: 'C' }] },
    ] },
  },
});
const multiSelectApproval = readClaudeBidiApprovalRequest({
  type: 'control_request', request_id: 'ask-select', request: {
    subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [
      { question: 'Features?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Name?', multiSelect: false, options: [{ label: 'C' }] },
    ] },
  },
});
assert.deepEqual(buildClaudeBidiApprovalResponseMessage(multiSelectApproval, 'approve', [], {
  multiChoices: [[0, 1], []], customAnswers: ['Extra', 'Custom name'],
}).response.response.updatedInput.answers, { 'Features?': 'A, B, Extra', 'Name?': 'Custom name' });
assert.equal(buildClaudeBidiApprovalResponseMessage(multiSelectApproval, 'approve', [], {
  multiChoices: [[0, 9], []], customAnswers: ['', 'Custom name'],
}), null);
assert.deepEqual(
  buildClaudeBidiApprovalResponseMessage(multipleApproval, 'approve', [-1, 0, -1], {
    customAnswers: ['first custom', '', 'third custom'],
  }).response.response.updatedInput.answers,
  { 'First?': 'first custom', 'Second?': 'B', 'Third?': 'third custom' },
);

// No choices provided -> graceful fallback to a generic allow that echoes the request
// input (no structured answers), so the prompt is never silently dropped.
const askUserNoChoice = buildClaudeBidiApprovalResponseMessage(askUserApproval, 'approve', []);
assert.equal(askUserNoChoice.response.response.behavior, 'allow');
assert.deepEqual(askUserNoChoice.response.response.updatedInput, { questions: askUserQuestions });
assert.ok(!('answers' in askUserNoChoice.response.response.updatedInput));

// Out-of-range choice index is treated as unanswered (same graceful fallback).
assert.deepEqual(
  buildClaudeBidiApprovalResponseMessage(askUserApproval, 'approve', [99]).response.response.updatedInput,
  { questions: askUserQuestions },
);

// Deny still denies regardless of question kind.
assert.equal(
  buildClaudeBidiApprovalResponseMessage(askUserApproval, 'deny', [0]).response.response.behavior,
  'deny',
);

// === ExitPlanMode (plan mode exit) classification + response ===
const exitPlanApproval = readClaudeBidiApprovalRequest({
  type: 'control_request',
  request_id: 'exit-plan-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'ExitPlanMode',
    display_name: 'Exit plan mode?',
    input: {
      plan: {
        title: 'Refactor approval card',
        text: '1. Inspect card renderer\n2. Patch the adapter',
      },
    },
    tool_use_id: 'tool-exit-plan-1',
  },
});
// Plan-exit prompts classify as plan approvals so the card can show the plan
// content instead of a bare tool-name prompt.
assert.equal(exitPlanApproval.kind, 'plan');
assert.equal(exitPlanApproval.requestClass, 'plan_review');
assert.equal(exitPlanApproval.params.input.plan.title, 'Refactor approval card');
// Approve exits plan mode by allowing ExitPlanMode with the plan echoed back;
// deny keeps the run in plan mode.
assert.equal(
  buildClaudeBidiApprovalResponseMessage(exitPlanApproval, 'approve').response.response.behavior,
  'allow',
);
assert.equal(
  buildClaudeBidiApprovalResponseMessage(exitPlanApproval, 'approve').response.response.updatedInput.plan.title,
  'Refactor approval card',
);
assert.equal(
  buildClaudeBidiApprovalResponseMessage(exitPlanApproval, 'deny').response.response.behavior,
  'deny',
);

assert.equal(isClaudeBidiTurnTerminal({ type: 'result' }), true);
assert.equal(isClaudeBidiTurnError({ type: 'result', is_error: true }), true);
assert.equal(isClaudeBidiTurnError({ type: 'result', subtype: 'success', is_error: false }), true);
assert.equal(isClaudeBidiTurnError({
  type: 'result',
  subtype: 'success',
  is_error: false,
  terminal_reason: 'api_error',
  result: 'API Error: upstream failure',
}), true);

console.log('test-claude-bidi-protocol: ok');
