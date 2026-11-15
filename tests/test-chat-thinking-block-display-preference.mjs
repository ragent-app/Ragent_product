#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const template = readFileSync(join(repoRoot, 'templates/chat.html'), 'utf8');
const bootstrap = readFileSync(join(repoRoot, 'static/chat/bootstrap.js'), 'utf8');
const ui = readFileSync(join(repoRoot, 'static/chat/ui.js'), 'utf8');

assert.doesNotMatch(template, /thinkingBlockDisplaySelect/, 'thinking-detail display preference should be removed from Settings');
assert.doesNotMatch(bootstrap, /ragent\.thinkingBlockDisplay|localStorage\.setItem\([^\n]*thinking/i, 'thinking-detail preferences should no longer be persisted');
assert.match(bootstrap, /function getThinkingBlockDisplayExpandedState\(\)\s*\{\s*return false;/, 'thinking details should remain collapsed');
assert.match(ui, /function shouldCompactMobileThinking\(\)\s*\{\s*return true;/, 'desktop and mobile should share the compact run-activity presentation');

console.log('test-chat-thinking-block-display-preference: ok');
