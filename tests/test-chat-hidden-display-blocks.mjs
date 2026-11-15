#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const realtimeRenderSource = readFileSync(join(repoRoot, 'static', 'chat', 'realtime-render.js'), 'utf8');
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const stripHiddenDisplayBlocksSource = extractFunctionSource(realtimeRenderSource, 'stripHiddenDisplayBlocks');
const cleanBase64TextForDisplaySource = extractFunctionSource(realtimeRenderSource, 'cleanBase64TextForDisplay');
const looksLikeReadableDisplayTextSource = extractFunctionSource(realtimeRenderSource, 'looksLikeReadableDisplayText');
const tryDecodeUtf8Base64TextSource = extractFunctionSource(realtimeRenderSource, 'tryDecodeUtf8Base64Text');
const formatDecodedDisplayTextSource = extractFunctionSource(realtimeRenderSource, 'formatDecodedDisplayText');
const renderMarkdownFragmentIntoNodeSource = extractFunctionSource(uiSource, 'renderMarkdownFragmentIntoNode');
const renderPlanAwareMarkdownIntoNodeSource = extractFunctionSource(uiSource, 'renderPlanAwareMarkdownIntoNode');
const renderMarkdownIntoNodeSource = extractFunctionSource(uiSource, 'renderMarkdownIntoNode');

const parsedInputs = [];
const context = {
  console,
  marked: {
    parse(text, options) {
      parsedInputs.push({ text, options });
      return `<p>${text}</p>`;
    },
  },
  enhanceCodeBlocks() {},
  enhanceTables() {},
  enhanceRenderedContentLinks() {},
};
context.globalThis = context;
context.window = context;

vm.runInNewContext(
  [
    stripHiddenDisplayBlocksSource,
    cleanBase64TextForDisplaySource,
    looksLikeReadableDisplayTextSource,
    tryDecodeUtf8Base64TextSource,
    formatDecodedDisplayTextSource,
    renderMarkdownFragmentIntoNodeSource,
    renderPlanAwareMarkdownIntoNodeSource,
    renderMarkdownIntoNodeSource,
    'globalThis.formatDecodedDisplayText = formatDecodedDisplayText;',
    'globalThis.renderMarkdownIntoNode = renderMarkdownIntoNode;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

assert.equal(
  context.formatDecodedDisplayText('Visible text\n<private>internal only</private>\nTail'),
  'Visible text\n\nTail',
  'display formatting should strip hidden UI blocks before rendering visible text',
);
assert.equal(
  context.formatDecodedDisplayText('Visible\n<ragent-collaboration-plan>{"schemaVersion":1}</ragent-collaboration-plan>\nTail'),
  'Visible\n\nTail',
  'display formatting should strip Runtime collaboration envelopes',
);
assert.equal(
  context.formatDecodedDisplayText('Visible <ragent-collab'),
  'Visible',
  'display formatting should hide a partial Runtime marker at a stream boundary',
);
assert.equal(
  context.formatDecodedDisplayText('Final answer\n<ragent-session-labels>{"title":"Hidden"}</ragent-session-labels>'),
  'Final answer',
  'display formatting should strip inline session labels after stream completion',
);
assert.equal(
  context.formatDecodedDisplayText('Final answer <ragent-session-la'),
  'Final answer',
  'display formatting should buffer a partial session-label marker instead of flashing it',
);

const node = { innerHTML: '', textContent: '' };
assert.equal(
  context.renderMarkdownIntoNode(node, 'Hello\n<hide>secret</hide>\nworld'),
  true,
  'markdown rendering should still succeed when hidden blocks are present',
);
assert.equal(parsedInputs[0].text, 'Hello\n\nworld', 'markdown rendering should receive only the visible text');
assert.equal(parsedInputs[0].options?.gfm, true, 'user-message rendering should keep GFM enabled');
assert.equal(parsedInputs[0].options?.breaks, true, 'user-message rendering should use the shared Typora-style line-break rule');

console.log('test-chat-hidden-display-blocks: ok');
