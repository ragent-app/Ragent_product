#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [baseCss, m3Tokens, bootstrap, monetContract, template] = await Promise.all([
  readFile(join(repoRoot, 'static/chat/chat-base.css'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/chat-m3-tokens.css'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/bootstrap.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/monet-theme-contract.js'), 'utf8'),
  readFile(join(repoRoot, 'templates/chat.html'), 'utf8'),
]);

const requiredRoles = [
  '--sys-primary', '--sys-on-primary', '--sys-primary-container',
  '--sys-on-primary-container', '--sys-secondary', '--sys-tertiary',
  '--sys-error', '--sys-error-container', '--sys-success', '--sys-success-container',
  '--sys-warning', '--sys-warning-container', '--sys-surface',
  '--sys-surface-container', '--sys-surface-container-high',
  '--sys-surface-container-highest', '--sys-on-surface',
  '--sys-on-surface-variant', '--sys-outline', '--sys-outline-variant',
  '--sys-inverse-surface', '--sys-inverse-on-surface', '--sys-scrim',
];

for (const role of requiredRoles) {
  assert.match(baseCss, new RegExp(`${role.replaceAll('-', '\\-')}\\s*:`), `${role} must be declared`);
}

for (const alias of [
  '--color-canvas', '--color-surface', '--color-surface-raised',
  '--color-text-primary', '--color-text-secondary', '--color-action',
  '--color-action-container', '--color-divider', '--color-focus',
]) {
  assert.match(baseCss, new RegExp(`${alias.replaceAll('-', '\\-')}\\s*:`), `${alias} must be declared`);
}

assert.match(bootstrap, /window\.ragentApplyMonetTheme\s*=\s*applyMonetTheme/);
assert.match(bootstrap, /ragent:monet-theme/);
assert.match(bootstrap, /RagentMonetThemeContract/);
assert.match(monetContract, /version:\s*1/);
assert.match(monetContract, /CSS\?\.supports/);
assert.match(monetContract, /root\.style\.removeProperty\(variable\)/);
assert.match(bootstrap, /monetThemeColorOverrides/);
for (const theme of ["blue", "purple", "green", "rose", "teal", "monet"]) {
  assert.match(bootstrap, new RegExp(`value: "${theme}"`), `${theme} must be selectable`);
  assert.match(m3Tokens, new RegExp(`data-theme=\\"${theme}\\"`), `${theme} must have a token palette`);
}
assert.match(m3Tokens, /:root,\s*:root\[data-theme="light"\]\s*\{[\s\S]*?--m3-surface:\s*#ffffff;[\s\S]*?--m3-on-surface:\s*#1f232a;/, 'light theme should use a pure-white canvas and dark text');
assert.match(m3Tokens, /:root\[data-theme="dark"\]\s*\{[\s\S]*?--m3-surface:\s*#000000;[\s\S]*?--m3-on-surface:\s*#ffffff;/, 'dark theme should use a black canvas with white text');
assert.match(m3Tokens, /:root,\s*:root\[data-theme="light"\],[\s\S]*?:root\[data-theme="teal"\]\s*\{[\s\S]*?--m3-surface:\s*#ffffff;[\s\S]*?--m3-surface-container:\s*#f5f6f8;[\s\S]*?--message-bubble-fill:\s*#e5e8ed;/, 'all light presets should share a faint neutral surface and quieter message bubble');
for (const [theme, primary] of [
  ['light', '#000000'],
  ['blue', '#3f5f90'],
  ['amber', '#4f662f'],
  ['purple', '#6750a4'],
  ['green', '#386a20'],
  ['rose', '#8e495d'],
  ['teal', '#006a6a'],
]) {
  assert.match(
    m3Tokens,
    new RegExp(`:root(?:\\[data-theme="${theme}"\\])?[^{]*\\{[\\s\\S]*?--m3-primary:\\s*${primary};`),
    `${theme} should retain its Material seed primary color`,
  );
}
assert.match(m3Tokens, /--sys-primary:\s*var\(--m3-primary\);[\s\S]*?--color-action:\s*var\(--m3-primary\);/, 'light preset compatibility aliases must follow the selected Material primary');
assert.match(m3Tokens, /--m3-success:\s*#2f6b3c;[\s\S]*?--m3-on-success:\s*#ffffff;[\s\S]*?--m3-success-container:\s*#c9e1cd;[\s\S]*?--m3-on-success-container:\s*#14361a;/, 'success needs a complete MD3 semantic role family');
assert.match(m3Tokens, /--sys-success:\s*var\(--m3-success\);[\s\S]*?--sys-on-success:\s*var\(--m3-on-success\);[\s\S]*?--sys-success-container:\s*var\(--m3-success-container\);[\s\S]*?--sys-on-success-container:\s*var\(--m3-on-success-container\);/, 'system success aliases should resolve from the MD3 family');
assert.match(m3Tokens, /--success:\s*var\(--sys-success\);[\s\S]*?--success-bg:\s*var\(--sys-success-container\);[\s\S]*?--copy-btn-success-border:\s*color-mix\(in srgb, var\(--sys-success\) 26%, transparent\);/, 'legacy success aliases should flow from the shared MD3 semantic roles');
assert.match(baseCss, /--indicator-unread:\s*#2563eb;[\s\S]*?--indicator-needs-action:\s*#d97706;/, 'sidebar attention markers should use an independent blue/amber vocabulary');
assert.match(baseCss, /@media \(prefers-color-scheme:\s*dark\)[\s\S]*?--indicator-unread:\s*#60a5fa;[\s\S]*?--indicator-needs-action:\s*#fbbf24;/, 'dark attention markers should only adjust for contrast, not selected Material theme');
assert.doesNotMatch(m3Tokens, /--status-(?:unread|needs-action)\s*:/, 'sidebar attention markers must not be aliases in the unified workflow status palette');
assert.doesNotMatch(m3Tokens, /--status-running:\s*var\(--m3-secondary\)/, 'running status must not alias the M3 secondary role');
assert.match(bootstrap, /RagentAndroidMonet/);
assert.match(bootstrap, /requestTheme/);
assert.match(monetContract, /--m3-primary/);
assert.ok(
  template.indexOf('chat/monet-theme-contract.js') < template.indexOf('chat/bootstrap.js'),
  'Monet contract must load before bootstrap',
);

console.log('test-chat-theme-contract: ok');
