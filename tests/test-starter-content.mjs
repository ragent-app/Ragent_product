import assert from 'node:assert/strict';
import { CREATE_AGENT_STARTER_MESSAGE, CREATE_AGENT_STARTER_SYSTEM_PROMPT, resolveDefaultStarterToolId } from '../chat/starter-session-content.mjs';

assert.match(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /When it is sufficient, use reasonable defaults and proceed/);
assert.match(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /Distinguish awaiting approval, successful creation, rejection, and failure/);
assert.doesNotMatch(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /never build from the first partial description|opening checklist/i);
assert.doesNotMatch(CREATE_AGENT_STARTER_MESSAGE, /shareable link|CodeX is the default/i);
assert.equal(await resolveDefaultStarterToolId([{ id: 'claude', available: true }, { id: 'codex', available: false }]), 'claude');
assert.equal(await resolveDefaultStarterToolId([{ id: 'claude', available: true }, { id: 'codex', available: true }]), 'codex');
console.log('test-starter-content: ok');
