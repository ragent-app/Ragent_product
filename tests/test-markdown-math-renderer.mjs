#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static', 'chat', 'markdown-math.js'), 'utf8');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const context = {
  console,
  window: null,
  document: {
    createElement() {
      let text = '';
      return {
        set textContent(value) {
          text = String(value ?? '');
        },
        get innerHTML() {
          return escapeHtml(text);
        },
      };
    },
  },
};
context.window = context;

vm.runInNewContext(source, context, { filename: 'static/chat/markdown-math.js' });

const prepared = context.prepareMarkdownMath([
  'Inline $x_i$ stays inline.',
  '',
  '$$',
  '\\frac{a_i}{b^2}',
  '$$',
  '',
  '`$not_math$`',
  '```',
  '$$not_math_either$$',
  '```',
].join('\n'));

assert.equal(prepared.tokens.length, 2, 'math preprocessor should ignore code spans and fenced code blocks');
assert.equal(prepared.tokens[0].display, false, 'single-dollar math should be inline');
assert.equal(prepared.tokens[1].display, true, 'double-dollar math should be display math');
assert.match(prepared.markdown, /RAGENT_MATH_TOKEN_0/, 'preprocessed Markdown should contain inline math token');
assert.match(prepared.markdown, /RAGENT_MATH_TOKEN_1/, 'preprocessed Markdown should contain display math token');
assert.doesNotMatch(prepared.markdown, /not_math_either[\s\S]*RAGENT_MATH_TOKEN_/, 'fenced code math markers should not be tokenized');

const mathMl = context.renderTexMathToMathMl('\\frac{a_i}{b^2} + \\sqrt{x}');
assert.match(mathMl, /<mfrac>/, 'TeX parser should render fractions as MathML');
assert.match(mathMl, /<msub><mi>a<\/mi><mi>i<\/mi><\/msub>/, 'TeX parser should render subscripts as MathML');
assert.match(mathMl, /<msup><mi>b<\/mi><mn>2<\/mn><\/msup>/, 'TeX parser should render superscripts as MathML');
assert.match(mathMl, /<msqrt><mrow><mi>x<\/mi><\/mrow><\/msqrt>/, 'TeX parser should render square roots as MathML');

console.log('test-markdown-math-renderer: ok');
