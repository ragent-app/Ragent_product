#!/usr/bin/env node
import assert from 'assert/strict';

import { createClaudeBidiAdapter } from '../chat/adapters/claude-bidi.mjs';

const adapter = createClaudeBidiAdapter();

// ExitPlanMode can_use_tool approval → plan-kind approval event carrying the
// drafted plan (title + body) instead of a bare tool-name prompt.
const events = adapter.parseLine(JSON.stringify({
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
}));

assert.equal(events.length, 1, 'ExitPlanMode should emit one approval event');
const approval = events[0];
assert.equal(approval.type, 'approval_request');
assert.equal(approval.kind, 'plan');
assert.equal(approval.approvalId, 'claude:exit-plan-1');
assert.equal(approval.title, 'Refactor approval card');
assert.equal(approval.reason, '1. Inspect card renderer\n2. Patch the adapter');
assert.equal(approval.status, 'pending');

// Real-world Claude Code 2.1.x shape: `plan` arrives as a plain markdown
// string (not { title, text }). The title is derived from the first heading
// and the body is carried as the approval reason.
const markdownEvents = adapter.parseLine(JSON.stringify({
  type: 'control_request',
  request_id: 'exit-plan-markdown',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'ExitPlanMode',
    display_name: 'ExitPlanMode',
    input: {
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
      plan: '# Refactor approval card\n\n1. Inspect renderer\n2. Patch the adapter',
    },
    tool_use_id: 'tool-exit-plan-3',
  },
}));
assert.equal(markdownEvents[0].kind, 'plan');
assert.equal(markdownEvents[0].title, 'Refactor approval card');
assert.equal(markdownEvents[0].reason, '# Refactor approval card\n\n1. Inspect renderer\n2. Patch the adapter');

// Without a plan payload (defensive), fall back to display_name/tool_name and
// description, keeping the pre-plan behavior.
const fallbackEvents = adapter.parseLine(JSON.stringify({
  type: 'control_request',
  request_id: 'exit-plan-2',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'ExitPlanMode',
    display_name: 'Exit plan mode?',
    description: 'Finish planning',
    input: {},
    tool_use_id: 'tool-exit-plan-2',
  },
}));
assert.equal(fallbackEvents[0].kind, 'plan');
assert.equal(fallbackEvents[0].title, 'Exit plan mode?');
assert.equal(fallbackEvents[0].reason, 'Finish planning');

// Non-plan approvals keep their existing shape (title from display_name, no
// plan-text hijack of reason).
const bashEvents = adapter.parseLine(JSON.stringify({
  type: 'control_request',
  request_id: 'bash-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    display_name: 'Bash',
    input: { command: 'rm temp.txt' },
    description: 'Delete temp file',
    tool_use_id: 'tool-bash-1',
  },
}));
assert.equal(bashEvents[0].kind, 'command');
assert.equal(bashEvents[0].title, 'Bash');
assert.equal(bashEvents[0].reason, 'Delete temp file');

const powershellEvents = adapter.parseLine(JSON.stringify({
  type: 'control_request', request_id: 'powershell-review',
  request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'Remove-Item D:\\\\Protected -Recurse' } },
}));
assert.equal(powershellEvents[0].kind, 'command');
assert.equal(powershellEvents[0].command, 'Remove-Item D:\\\\Protected -Recurse');

// Sidecar auto-approvals must never surface as user-facing approvals. The
// sidecar echoes its synthetic ragent.approval_response (autoApproved: true)
// into the stream BEFORE the control_request it answers; the adapter tracks
// the id so the later request frame is suppressed too (no card, no push).
const autoApprovalAdapter = createClaudeBidiAdapter();
const autoAckEvents = autoApprovalAdapter.parseLine(JSON.stringify({
  type: 'ragent.approval_response',
  approvalId: 'claude:auto-allowed-1',
  decision: 'approved',
  status: 'approved',
  providerRequestId: 'auto-allowed-1',
  providerMethod: 'can_use_tool',
  autoApproved: true,
  reason: 'risk safe: in-project file edit',
}));
assert.equal(autoAckEvents.length, 0, 'auto-approved ack must not emit a response event');
const suppressedRequestEvents = autoApprovalAdapter.parseLine(JSON.stringify({
  type: 'control_request',
  request_id: 'auto-allowed-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Write',
    display_name: 'Write',
    input: { file_path: '/srv/ragent-promoted/x.txt' },
    tool_use_id: 'tool-auto-1',
  },
}));
assert.equal(suppressedRequestEvents.length, 0, 'control_request for an auto-approved id must not emit an approval card');

const autoDenialAdapter = createClaudeBidiAdapter();
assert.equal(autoDenialAdapter.parseLine(JSON.stringify({
  type: 'ragent.approval_response', approvalId: 'claude:auto-denied-1',
  decision: 'denied', status: 'denied', providerRequestId: 'auto-denied-1',
  providerMethod: 'can_use_tool', autoDenied: true,
})).length, 0);
assert.equal(autoDenialAdapter.parseLine(JSON.stringify({
  type: 'control_request', request_id: 'auto-denied-1',
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm temp.txt' } },
})).length, 0, 'automatically denied request must not produce an owner card');

// A request frame WITHOUT a prior auto-approved ack still surfaces normally
// (a genuinely held approval the user must decide).
const heldAdapter = createClaudeBidiAdapter();
const heldEvents = heldAdapter.parseLine(JSON.stringify({
  type: 'control_request',
  request_id: 'held-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    display_name: 'Bash',
    input: { command: 'git push --force origin main' },
    description: 'Force push',
    tool_use_id: 'tool-held-1',
  },
}));
assert.equal(heldEvents.length, 1, 'held approval must still surface a card');
assert.equal(heldEvents[0].status, 'pending');

// Managed MCP requests still parse as permission approvals. Once the sidecar
// has echoed its synthetic auto-approval, the adapter must suppress the
// provider request frame so the user never sees a duplicate card.
const managedMcpAdapter = createClaudeBidiAdapter();
const managedMcpAckEvents = managedMcpAdapter.parseLine(JSON.stringify({
  type: 'ragent.approval_response',
  approvalId: 'claude:managed-mcp-1',
  decision: 'approved',
  status: 'approved',
  providerRequestId: 'managed-mcp-1',
  providerMethod: 'can_use_tool',
  autoApproved: true,
  mcpServerName: 'ragent_actions_fixture',
  mcpToolName: 'ragent_create_agent',
}));
assert.equal(managedMcpAckEvents.length, 0);
const managedMcpRequestEvents = managedMcpAdapter.parseLine(JSON.stringify({
  type: 'control_request',
  request_id: 'managed-mcp-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'mcp__ragent_actions_fixture__ragent_create_agent',
    input: {},
    tool_use_id: 'tool-managed-mcp-1',
  },
}));
assert.equal(managedMcpRequestEvents.length, 0);

// A real provider ack (no autoApproved flag) still emits its response event —
// only sidecar-synthesized auto-approvals are suppressed.
const realAckEvents = heldAdapter.parseLine(JSON.stringify({
  type: 'ragent.approval_response',
  approvalId: 'claude:held-1',
  decision: 'approved',
  status: 'approved',
  providerRequestId: 'held-1',
  providerMethod: 'can_use_tool',
}));
assert.equal(realAckEvents.length, 1, 'real provider ack must emit a response event');
assert.equal(realAckEvents[0].type, 'approval_response');

console.log('test-claude-bidi-adapter-plan-approval: ok');
