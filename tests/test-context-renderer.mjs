#!/usr/bin/env node
import assert from 'assert/strict';

import { buildCanonicalContext } from '../chat/context-canonical.mjs';
import {
  CONTEXT_RENDERER_VERSION,
  VISITOR_TURN_GUARDRAIL,
  renderContextForRuntime,
  shouldIncludeSessionTemplateInstructions,
} from '../chat/context-renderer.mjs';

delete process.env.AGENTOC_CONTEXT_RENDERER_V2;
delete process.env.AGENTOC_CONTEXT_RENDERER_SHADOW;

const freshContext = buildCanonicalContext({
  runtimeFamily: 'codex-json',
  promptMode: 'default',
  flattenPrompt: false,
  hasResume: false,
  userText: 'Do the work.',
  systemContext: 'System context.',
  sourceRuntimePrompt: 'Source runtime instructions.',
  templateInstructions: 'Template instructions.',
  managerTurnContext: 'Manager context.',
  visitorGuardrail: VISITOR_TURN_GUARDRAIL,
  sourceSeq: 12,
});

const freshRender = renderContextForRuntime(freshContext);
assert.match(freshRender.prompt, /<private>\nManager context\.\n<\/private>/);
assert.match(freshRender.prompt, /User message:\nDo the work\./);
assert.match(freshRender.prompt, /Share-link security notice for this turn/);
assert.doesNotMatch(freshRender.prompt, /^System context\./);
assert.match(freshRender.developerInstructions, /Ragent system context:\nSystem context\./);
assert.match(freshRender.developerInstructions, /Source\/runtime instructions:\nSource runtime instructions\./);
assert.match(freshRender.developerInstructions, /Template instructions:\nTemplate instructions\./);
assert.equal(freshRender.metadata.rendererVersion, CONTEXT_RENDERER_VERSION);
assert.equal(freshRender.metadata.runtimeFamily, 'codex-json');
assert.equal(freshRender.metadata.resumeUsed, false);
assert.equal(freshRender.metadata.contextResumeMode, 'remote_continuation');
assert.equal(freshRender.metadata.rendererStrategy, 'codex-developer-instructions');
assert.equal(freshRender.metadata.sourceSeq, 12);
assert.ok(freshRender.metadata.includedSections.includes('systemContext'));
assert.ok(freshRender.metadata.includedSections.includes('managerTurnContext'));
assert.equal(freshRender.metadata.includedCarrierBySection.systemContext, 'developerInstructions');
assert.ok(freshRender.metadata.contextBudget.prompt > 0);
assert.ok(freshRender.metadata.charCounts.prompt > freshRender.metadata.charCounts.userText);
assert.ok(freshRender.metadata.charCounts.developerInstructions > 0);

const legacyRender = renderContextForRuntime(freshContext, { rendererStrategy: 'legacy' });
assert.match(legacyRender.prompt, /^System context\./);
assert.match(legacyRender.prompt, /Source\/runtime instructions \(backend-owned for this session source\):\nSource runtime instructions\./);
assert.match(legacyRender.prompt, /Template instructions \(follow these for this session\):\nTemplate instructions\./);
assert.equal(legacyRender.developerInstructions, '');
assert.equal(legacyRender.metadata.featureFlagEnabled, false);

const resumedContext = buildCanonicalContext({
  runtimeFamily: 'claude-stream-json',
  promptMode: 'default',
  hasResume: true,
  userText: 'Continue.',
  managerTurnContext: 'Manager context.',
  systemContext: 'System context should not be rendered on resume.',
});

const resumedRender = renderContextForRuntime(resumedContext);
assert.doesNotMatch(resumedRender.prompt, /System context should not be rendered/);
assert.match(resumedRender.prompt, /Current user message:\nContinue\./);
assert.equal(resumedRender.metadata.resumeUsed, true);
assert.equal(resumedRender.metadata.contextResumeMode, 'provider_resume');
assert.equal(resumedRender.metadata.rendererStrategy, 'claude-sectioned-prompt');

// Claude goal mode: the objective rides inside the prompt (no threadGoal RPC),
// rendered right before the user message and present on resume turns too.
const goalContext = buildCanonicalContext({
  runtimeFamily: 'claude-stream-json',
  promptMode: 'default',
  hasResume: true,
  userText: 'Continue.',
  managerTurnContext: 'Manager context.',
  goalInstructions: 'Active goal (applies to every turn until completed or cleared): "Clean imports". Token budget: 25000.',
});

const goalRender = renderContextForRuntime(goalContext);
assert.ok(goalRender.prompt.includes('"Clean imports"'), 'goal objective reaches the claude prompt');
assert.ok(
  goalRender.prompt.indexOf('Active goal') < goalRender.prompt.indexOf('Current user message:\nContinue.'),
  'goal block precedes the user message',
);
assert.ok(goalRender.metadata.includedSections.includes('goalInstructions'));
assert.equal(goalRender.metadata.includedCarrierBySection.goalInstructions, 'prompt');
assert.ok(goalRender.metadata.charCounts.goalInstructions > 0);

const bareContext = buildCanonicalContext({
  runtimeFamily: 'claude-stream-json',
  promptMode: 'bare-user',
  flattenPrompt: true,
  hasResume: false,
  userText: '  Remember   the   compact   input.  ',
  continuationContext: '[User]\nEarlier fact.',
});

const bareRender = renderContextForRuntime(bareContext);
assert.equal(bareRender.prompt, '[User]\nEarlier fact.\n\n---\n\nRemember the compact input.');

const budgetedContext = buildCanonicalContext({
  runtimeFamily: 'codex-json',
  promptMode: 'default',
  hasResume: false,
  userText: 'Run.',
  managerTurnContext: 'x'.repeat(120),
});
const budgetedRender = renderContextForRuntime(budgetedContext, {
  budgetOverrides: { managerTurnContext: 40 },
});
assert.ok(
  budgetedRender.metadata.truncatedSections.some((entry) => entry.section === 'managerTurnContext'),
  'renderer metadata should record context budget truncation',
);
assert.ok(budgetedRender.prompt.length < 160);

assert.equal(shouldIncludeSessionTemplateInstructions({ systemPrompt: 'Use this.' }), true);
assert.equal(shouldIncludeSessionTemplateInstructions({
  starterPreset: 'welcome',
  systemPrompt: 'Welcome.',
  welcomeOnboardingRetiredAt: '2025-01-01T00:00:00.000Z',
}), false);

console.log('test-context-renderer: ok');
