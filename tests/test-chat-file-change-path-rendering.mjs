#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in ui.js`);
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

function createElement(tagName = 'div') {
  return {
    tagName: String(tagName || 'div').toUpperCase(),
    className: '',
    innerHTML: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const renderFileChangeIntoSource = extractFunctionSource(uiSource, 'renderFileChangeInto');
const readFileChangeTypeSource = extractFunctionSource(uiSource, 'readFileChangeType');
const normalizeFileChangeTypeSource = extractFunctionSource(uiSource, 'normalizeFileChangeType');
const formatFileChangeTypeLabelSource = extractFunctionSource(uiSource, 'formatFileChangeTypeLabel');
const context = {
  console,
  document: {
    createElement(tagName) {
      return createElement(tagName);
    },
  },
  esc,
  t(key) {
    return key;
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    readFileChangeTypeSource,
    normalizeFileChangeTypeSource,
    formatFileChangeTypeLabelSource,
    renderFileChangeIntoSource,
    'globalThis.renderFileChangeInto = renderFileChangeInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const container = createElement('section');
const node = context.renderFileChangeInto(container, {
  changeType: 'edit',
  filePath: '/Users/example/code/ragent/chat/router.mjs:910',
});

assert.equal(container.children.length, 1, 'file change cards should append exactly one node');
assert.equal(container.children[0], node, 'renderFileChangeInto should return the appended node');
assert.match(node.innerHTML, /<span class="file-path">\/Users\/example\/code\/ragent\/chat\/router\.mjs:910<\/span>/, 'file change cards should render host paths as plain text');
assert.doesNotMatch(node.innerHTML, /<a class="file-path"/, 'file change cards should not render host paths as clickable links');

const objectKindNode = context.renderFileChangeInto(createElement('section'), {
  changeType: { type: 'update', move_path: null },
  filePath: '/tmp/object-kind.js',
});
assert.match(objectKindNode.innerHTML, /change-type update/, 'file change cards should normalize object-shaped kinds into stable classes');
assert.doesNotMatch(objectKindNode.innerHTML, /\[object Object\]/, 'file change cards should not leak object-shaped kinds into the UI');

console.log('test-chat-file-change-path-rendering: ok');
