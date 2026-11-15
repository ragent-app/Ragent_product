#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const template = readFileSync(join(repoRoot, 'templates/chat.html'), 'utf8');
const transition = readFileSync(join(repoRoot, 'static/chat/live-action-transition.js'), 'utf8');
const css = readFileSync(join(repoRoot, 'static/chat/chat-live-action.css'), 'utf8');
const liveStatus = readFileSync(join(repoRoot, 'static/chat/live-status-ui.js'), 'utf8');
const ui = readFileSync(join(repoRoot, 'static/chat/ui.js'), 'utf8');

assert.match(template, /chat\/chat-live-action\.css/);
assert.match(template, /chat\/live-action-transition\.js/);
assert.match(transition, /RagentLiveActionTransition = \{ setText, getText \}/);
assert.match(transition, /live-action-transition__stage/);
assert.match(css, /@keyframes live-action-slide-in/);
assert.match(css, /@keyframes live-action-slide-out/);
assert.match(css, /prefers-reduced-motion: reduce/);
assert.match(liveStatus, /RagentLiveActionTransition\?\.setText/);
assert.match(ui, /RagentLiveActionTransition\?\.setText/);
assert.match(ui, /RagentLiveActionTransition\?\.getText/);

console.log('test-chat-live-action-transition: ok');
