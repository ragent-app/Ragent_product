#!/usr/bin/env node
// Structural coverage for the account-level permission-mode Settings subpage.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const template = await readFile(join(repoRoot, 'templates', 'chat.html'), 'utf8');
assert.match(
  template,
  /<script src="chat\/account-policy\.js\?v=\{\{ASSET_VERSION\}\}" nonce="\{\{NONCE\}\}"><\/script>/,
  'chat template should load the account policy widget',
);
for (const id of ['accountPolicySettingsSection', 'accountPolicyOpenBtn', 'accountPolicyPanel', 'accountPolicyOptions']) {
  assert.match(template, new RegExp(`id="${id}"`), `template should contain ${id}`);
}

const widget = await readFile(join(repoRoot, 'static', 'chat', 'account-policy.js'), 'utf8');
assert.match(widget, /api\/account-policy/, 'widget should talk to the account policy endpoint');
assert.match(widget, /RagentAccountPolicy/, 'widget should expose its Settings controller');
assert.match(widget, /ragentOpenSidebarSubpage\("account-policy"/, 'widget should open as a Settings subpage');
assert.doesNotMatch(widget, /sidebarPrimaryNav|popover|style\.cssText|🛡️/, 'widget must not inject a sidebar control or inline-styled popover');

for (const marker of ['"full-auto"', '"approval"', '"conservative-auto"', 'permissionPolicy']) {
  assert.ok(widget.includes(marker), `widget should reference ${marker}`);
}

// Label completeness for all three policy values in zh and en.
const labelBlock = widget.match(/function copy\(\)[\s\S]*?\n  \}/);
assert.ok(labelBlock, 'widget should define a copy table');
for (const phrase of ['自主执行', '请求审批', '审慎自主', 'Autonomous', 'Ask for approval', 'Guarded autonomous']) {
  assert.ok(labelBlock[0].includes(phrase), `labels should include ${phrase}`);
}

console.log('test-chat-account-policy-widget: ok');
