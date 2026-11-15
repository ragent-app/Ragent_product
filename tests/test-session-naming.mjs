#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildTemporarySessionName,
  normalizeGeneratedSessionTitle,
} from '../chat/session-naming.mjs';

assert.equal(
  normalizeGeneratedSessionTitle('Ragent Rename Flow', 'Ragent'),
  'Rename Flow',
  'AI titles should drop a repeated leading group name',
);

assert.equal(
  normalizeGeneratedSessionTitle('Rename Flow — Ragent', 'Ragent'),
  'Rename Flow',
  'AI titles should drop a repeated trailing group name',
);

assert.equal(
  normalizeGeneratedSessionTitle('招聘 JD 优化', '招聘'),
  'JD 优化',
  'AI titles should also drop repeated leading group text in Chinese',
);

assert.equal(
  normalizeGeneratedSessionTitle('Fix auth bug', 'Ragent'),
  'Fix auth bug',
  'specific titles should stay unchanged when they do not repeat the group',
);

assert.equal(
  normalizeGeneratedSessionTitle('Ragent', 'Ragent'),
  'Ragent',
  'empty results should fall back to the original title',
);

assert.equal(
  buildTemporarySessionName('请帮我分析一下 Ragent 的会话标题生成机制，现在只是截断第一条消息'),
  '分析一下 Ragent 的会话标题生成机制',
  'provisional Chinese titles should drop filler and explanatory tails',
);

assert.equal(
  buildTemporarySessionName('Please investigate why the Codex app-server exits before an accepted terminal event'),
  'investigate why the Codex…',
  'provisional English titles should stop at a word boundary',
);

console.log('test-session-naming: ok');
