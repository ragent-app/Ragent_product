#!/usr/bin/env node
// Strict gates for the end-of-run plan fallback card (ragent-plan-fallback).
// The fallback exists so plan-mode runs that finish with a plain-text plan
// (no ExitPlanMode approval — Claude asks mid-run, not always) still leave a
// plan card. It is STRICT: a run that already surfaced an ExitPlanMode
// approval (approval_request kind=plan) never gets a fallback card, and the
// final reply must actually look like a plan (step list / <proposed_plan>).
// The old end-to-end harness (test-plan-fallback-artifact.mjs) is parked:
// the fake-codex runner supervisor does not launch in this environment
// (pre-existing red at 1fbf6c4) — cover the pure helpers + source contracts
// here instead.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const managerSource = readFileSync(join(repoRoot, 'chat', 'session-manager.mjs'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const functionStart = source.indexOf(marker);
  assert.notEqual(functionStart, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', functionStart);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    if (source[index] === ')') {
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
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(functionStart, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

// ---------------------------------------------------------------------------
// 1. Pure helpers — what "looks like a plan" means for the strict gate
// ---------------------------------------------------------------------------
const helpers = [
  'getPlanFallbackTitle',
  'extractPlanFallbackMarkdown',
  'countPlanFallbackStepLines',
  'looksLikePlanFallbackMarkdown',
];
const context = {
  console,
  trimString: (value) => (typeof value === 'string' ? value.trim() : ''),
};
vm.createContext(context);
vm.runInContext(helpers.map((name) => extractFunctionSource(managerSource, name)).join('\n'), context);

assert.equal(context.looksLikePlanFallbackMarkdown(''), false, 'empty reply is not a plan');
assert.equal(
  context.looksLikePlanFallbackMarkdown('I did the thing and here is the result.'),
  false,
  'a plain prose reply (execution output) must NOT be carded',
);
assert.equal(
  context.looksLikePlanFallbackMarkdown('# Plan\n\n1. Inspect\n2. Patch\n3. Verify'),
  true,
  'a heading + step list looks like a plan',
);
assert.equal(
  context.looksLikePlanFallbackMarkdown('<proposed_plan>\nDo X\n</proposed_plan>'),
  true,
  'a <proposed_plan> tag looks like a plan',
);
assert.equal(
  context.looksLikePlanFallbackMarkdown('步骤：\n- 先做 A\n- 再做 B'),
  true,
  'a Chinese step list with plan keywords looks like a plan',
);
assert.equal(
  context.getPlanFallbackTitle('# My Plan\n\nbody'),
  'My Plan',
  'the first heading becomes the card title',
);
assert.equal(
  context.extractPlanFallbackMarkdown('<proposed_plan>\nDo X\n</proposed_plan>'),
  'Do X',
  'the proposed_plan tag body is extracted',
);

// ---------------------------------------------------------------------------
// 2. Flow gates — source contracts
// ---------------------------------------------------------------------------
const shouldCreate = extractFunctionSource(managerSource, 'shouldCreatePlanFallbackArtifact');
assert.match(
  shouldCreate,
  /event\?\.type === 'approval_request'[\s\S]*?String\(event\?\.kind \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'plan'/,
  'a run that already surfaced an ExitPlanMode approval (kind plan) must never get a fallback card',
);
assert.match(
  shouldCreate,
  /run\?\.state !== 'completed'/,
  'fallback must only fire for completed runs',
);
assert.match(
  shouldCreate,
  /interactionMode !== 'plan' && planAction !== 'revise'/,
  'fallback must only fire for plan mode (or plan revise), never execute',
);

const maybeAppend = extractFunctionSource(managerSource, 'maybeAppendPlanFallbackArtifact');
assert.match(
  maybeAppend,
  /if \(!looksLikePlanFallbackMarkdown\(sourceMarkdown\)\) return null;/,
  'a reply that does not look like a plan must not be carded (strict gate)',
);
assert.match(
  maybeAppend,
  /source: 'ragent-plan-fallback'/,
  'fallback cards keep the ragent-plan-fallback source',
);

console.log('test-plan-fallback-strict-gates: ok');
