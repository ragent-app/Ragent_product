#!/usr/bin/env node
// Per-message system prompt injection (agent config perMessageSystemPrompt):
// the agent's localized per-message reminder is delivered to the model EVERY
// turn as a labeled block inside the rendered turn prompt (the only section
// re-sent on native provider resume), NOT as a durable system message event.
// Covers both renderer families (codex-json buildTurnPrompt and claude/
// legacy renderLegacyPrompt), bare-user mode, resume vs fresh start, the
// no-config no-op, locale resolution, and the continuation safety-net that
// prevents historical perMessage events from leaking into fallback context.
//
// Pure unit test: imports the renderer/canonical/continuation modules
// directly. No spawn-server, never touches live /var/lib/ragent/config.
import assert from 'assert/strict';

import { buildCanonicalContext } from '../chat/context-canonical.mjs';
import { renderContextForRuntime } from '../chat/context-renderer.mjs';
import { prepareSessionContinuationBody } from '../chat/session-continuation.mjs';
import { pickLocalizedText } from '../chat/ui-language.mjs';
import { normalizePerMessageSystemPrompt } from '../chat/apps.mjs';

delete process.env.RAGENT_CONTEXT_RENDERER_V2;
delete process.env.RAGENT_CONTEXT_RENDERER_SHADOW;

const ZH_PROMPT = '要充分结合前端开发规范，用好 skills';
const EN_PROMPT = 'Follow the frontend development guidelines and use skills well.';
const INSTRUCTION = 'Apply the frontend development standard first and cite the skill used.';
const PROMPT_KEY = 'agent.perMessageSystemPrompt';
const INSTRUCTION_BLOCK_RE = /Agent per-message instruction \(apply to this reply\):\nApply the frontend development standard first/;

function contextWithPerMessage({ runtimeFamily, promptMode = 'default', hasResume = false, withInstruction = true }) {
  return buildCanonicalContext({
    runtimeFamily,
    promptMode,
    flattenPrompt: false,
    hasResume,
    userText: 'Build the landing page.',
    managerTurnContext: 'Manager context.',
    perMessageInstruction: withInstruction ? INSTRUCTION : '',
  });
}

function assertEveryTurn(family, { hasResume }) {
  const render = renderContextForRuntime(contextWithPerMessage({
    runtimeFamily: family,
    hasResume,
  }));
  assert.match(render.prompt, INSTRUCTION_BLOCK_RE,
    `${family} hasResume=${hasResume}: per-message instruction must be in the turn prompt`);
  // It must sit before the user message so it frames this reply.
  const instrIdx = render.prompt.indexOf('Agent per-message instruction');
  const userIdx = render.prompt.indexOf('Build the landing page.');
  assert.ok(instrIdx > -1 && userIdx > instrIdx,
    `${family} hasResume=${hasResume}: instruction must precede the user message`);
  // The contract is turn-prompt delivery; it is not duplicated into developerInstructions.
  assert.doesNotMatch(render.developerInstructions, /Apply the frontend development standard first/,
    `${family}: per-message instruction must not leak into developerInstructions`);
}

assertEveryTurn('codex-json', { hasResume: false });
assertEveryTurn('codex-json', { hasResume: true });
assertEveryTurn('claude-stream-json', { hasResume: false });
assertEveryTurn('claude-stream-json', { hasResume: true });

// bare-user tools also receive the reminder every reply.
const bareRender = renderContextForRuntime(contextWithPerMessage({
  runtimeFamily: 'codex-json',
  promptMode: 'bare-user',
}));
assert.match(bareRender.prompt, INSTRUCTION_BLOCK_RE, 'bare-user: per-message instruction still delivered');

// No perMessage config -> nothing injected, no stray label.
const absentRender = renderContextForRuntime(contextWithPerMessage({
  runtimeFamily: 'codex-json',
  withInstruction: false,
}));
assert.doesNotMatch(absentRender.prompt, /Agent per-message instruction/, 'no instruction when config absent');
assert.doesNotMatch(absentRender.prompt, /Apply the frontend development standard first/, 'no instruction text when config absent');
assert.ok(!absentRender.metadata.includedSections.includes('perMessageInstruction'),
  'absent instruction is not listed as an included section');
assert.ok(renderContextForRuntime(contextWithPerMessage({ runtimeFamily: 'codex-json' })).metadata.includedSections.includes('perMessageInstruction'),
  'present instruction is listed as an included section');

// Locale resolution (unchanged): the catalog localizes per session.uiLanguage.
const catalog = { 'zh-CN': ZH_PROMPT, en: EN_PROMPT, auto: ZH_PROMPT };
assert.equal(pickLocalizedText(catalog, 'zh-CN'), ZH_PROMPT);
assert.equal(pickLocalizedText(catalog, 'en'), EN_PROMPT);
assert.equal(pickLocalizedText(catalog, 'zh-Hans'), ZH_PROMPT, 'zh variants normalize');
assert.equal(pickLocalizedText(catalog, ''), ZH_PROMPT, 'empty preference falls back to auto variant');
assert.equal(pickLocalizedText(catalog, 'auto'), ZH_PROMPT, 'explicit auto falls back to auto variant');
assert.equal(pickLocalizedText(catalog, 'fr'), ZH_PROMPT, 'unknown locale falls back to auto variant');
assert.equal(pickLocalizedText({ en: EN_PROMPT }, 'zh-CN'), EN_PROMPT, 'missing locale falls back to first variant');
assert.equal(pickLocalizedText(null, 'zh-CN'), '', 'null catalog yields empty text');
assert.equal(pickLocalizedText({ 'zh-CN': '  ' }, 'zh-CN'), '', 'blank variants yield empty text');
assert.deepEqual(normalizePerMessageSystemPrompt({ 'zh-CN': ZH_PROMPT, en: '' }), { 'zh-CN': ZH_PROMPT }, 'blank variants dropped');
assert.equal(normalizePerMessageSystemPrompt(null), null, 'null input rejected');
assert.equal(normalizePerMessageSystemPrompt('plain string'), null, 'non-object rejected');
assert.equal(normalizePerMessageSystemPrompt({ 'zh-CN': '   ' }), null, 'all-blank catalog rejected');

// Continuation safety-net: historical perMessage system events (written by the
// old durable mechanism before this change) must never leak into fallback
// continuation context as Assistant text.
const continuationBody = prepareSessionContinuationBody([
  { type: 'message', role: 'user', content: 'Earlier user turn.' },
  { type: 'message', role: 'system', content: 'SECRET_LEAKY_REMINDER', systemPromptKey: PROMPT_KEY },
  { type: 'message', role: 'assistant', content: 'Real assistant reply.' },
]);
assert.ok(continuationBody.length > 0, 'continuation body is produced');
assert.doesNotMatch(continuationBody, /SECRET_LEAKY_REMINDER/, 'historical perMessage event must not leak into continuation');
assert.match(continuationBody, /Real assistant reply\./, 'normal assistant message still appears in continuation');

console.log('PASS test-agent-message-prompt');
