import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('packaging/windows/ragent-installer-embedded-ui.cpp', 'utf8');
const table = await readFile('packaging/windows/installer-locales.h', 'utf8');
const appLocales = await readFile('android/app/src/main/res/xml/locales_config.xml', 'utf8');
const calls = [...source.matchAll(/Text\(L"((?:\\.|[^"\\])*)"\s*,\s*L"((?:\\.|[^"\\])*)"\)/g)];
const rows = new Map();
for (const line of table.split('\n')) {
  if (!line.startsWith('{L"')) continue;
  const fields = [...line.matchAll(/L"((?:\\.|[^"\\])*)"/g)].map(match => match[1]);
  assert.equal(fields.length, 6, `Each translation row must contain the source and five translations: ${line}`);
  assert.ok(fields.every(Boolean), `Missing translation: ${fields[0]}`);
  assert.ok(!rows.has(fields[0]), `Duplicate translation: ${fields[0]}`);
  rows.set(fields[0], fields.slice(1));
}
for (const [, english, simplified] of calls) {
  assert.ok(simplified, `Missing Simplified Chinese translation: ${english}`);
  assert.ok(rows.has(english), `Missing localized installer text: ${english}`);
}
for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es']) {
  assert.ok(appLocales.includes(`android:name="${locale}"`), `Installer language absent from app: ${locale}`);
}
assert.match(source, /CBN_SELCHANGE/);
assert.match(source, /GetUserDefaultUILanguage\(\)/);
console.log(`Installer translations: ${new Set(calls.map(match => match[1])).size} strings, seven app languages`);
