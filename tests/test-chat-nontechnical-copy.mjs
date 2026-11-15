#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const templateSource = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');
const i18nSource = readFileSync(join(repoRoot, 'static', 'chat', 'i18n.js'), 'utf8');

assert.match(i18nSource, /"settings\.sessionPresentation\.title": "Session opening"/);
assert.match(templateSource, /Advanced integration/);
assert.match(templateSource, /Copy setup brief/);
assert.match(templateSource, /dedicated technical session/);
assert.doesNotMatch(templateSource, /Auto follows the current browser language\./);
assert.doesNotMatch(templateSource, /Choose how thinking blocks open in this browser\./);
assert.doesNotMatch(templateSource, /Internal-only display control for the selected session\./);
assert.doesNotMatch(templateSource, /Create reusable apps or workflows here\./);
assert.doesNotMatch(templateSource, /Optional behavior instructions for this app/);
assert.doesNotMatch(templateSource, /Open source on GitHub ↗/);
assert.doesNotMatch(templateSource, /View project source ↗/);
assert.doesNotMatch(templateSource, /Built with AI/);
assert.doesNotMatch(templateSource, /Optional system prompt for this app/);
assert.doesNotMatch(templateSource, /Advanced provider code/);
assert.doesNotMatch(templateSource, /Copy base prompt/);
assert.doesNotMatch(templateSource, /open a new session in the Ragent repo/);

assert.match(i18nSource, /"settings\.language\.optionAuto": "Follow browser"/);
assert.match(i18nSource, /"settings\.theme\.optionSystem": "Follow system"/);
assert.match(i18nSource, /"settings\.thinkingBlocks\.optionExpanded": "Open by default"/);
assert.match(i18nSource, /"settings\.sessionPresentation\.entryMode\.resume": "Jump to latest"/);
assert.match(i18nSource, /"modal\.advancedTitle": "Advanced integration"/);
assert.match(i18nSource, /"modal\.copyBasePrompt": "Copy setup brief"/);
assert.match(i18nSource, /"modal\.advancedBody": "If the simple setup is not enough, start a dedicated technical session and paste this setup brief\."/);
assert.match(i18nSource, /"settings\.language\.optionAuto": "跟随浏览器"/);
assert.match(i18nSource, /"settings\.theme\.optionSystem": "跟随系统"/);
assert.match(i18nSource, /"settings\.thinkingBlocks\.optionExpanded": "默认展开"/);
assert.match(i18nSource, /"modal\.advancedTitle": "高级集成"/);
assert.match(i18nSource, /"modal\.advancedBody": "如果简单配置不够，就新开一个专门处理技术集成的会话，把这段设置说明贴进去。"/);
assert.doesNotMatch(i18nSource, /"footer\.openSource": "Open source on GitHub ↗"/);
assert.doesNotMatch(i18nSource, /"footer\.openSource": "GitHub 开源项目 ↗"/);
assert.doesNotMatch(i18nSource, /"footer\.openSource"/);
assert.doesNotMatch(i18nSource, /"footer\.tagline"/);
assert.doesNotMatch(i18nSource, /"settings\.apps\.systemPromptPlaceholder": "Optional system prompt for this app"/);
assert.doesNotMatch(i18nSource, /"settings\.apps\.systemPromptPlaceholder": "这个应用的可选系统提示词"/);
assert.doesNotMatch(i18nSource, /"settings\.language\.note": "Auto follows the current browser language\./);
assert.doesNotMatch(i18nSource, /"settings\.thinkingBlocks\.note": "Choose how thinking blocks open in this browser\."/);
assert.doesNotMatch(i18nSource, /"settings\.language\.note": "默认会跟随当前浏览器语言。你也可以在这里为当前浏览器强制切换/);
assert.doesNotMatch(i18nSource, /"settings\.thinkingBlocks\.note": "控制 thinking block 在这个浏览器里是展开还是折叠。"/);
assert.doesNotMatch(i18nSource, /Ragent repo/);
assert.doesNotMatch(i18nSource, /Ragent 仓库里新开一个会话/);

console.log('test-chat-nontechnical-copy: ok');
