#!/usr/bin/env node
import assert from 'node:assert/strict';
import { AGY_EFFORT_LEVELS, normalizeAgyModelCatalog } from '../lib/agy-manager.mjs';

const catalog = normalizeAgyModelCatalog([
  { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
  { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
  { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
]);

assert.deepEqual(catalog, [
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    reasoning: {
      kind: 'enum',
      label: 'Thinking',
      levels: ['low', 'medium', 'high'],
      default: 'medium',
    },
  },
  {
    id: 'claude-opus-4-6-thinking',
    label: 'Claude Opus 4.6 (Thinking)',
    reasoning: { kind: 'none', label: 'Thinking' },
  },
  {
    id: 'gpt-oss-120b-medium',
    label: 'GPT-OSS 120B (Medium)',
    reasoning: { kind: 'none', label: 'Thinking' },
  },
]);
assert.deepEqual([...AGY_EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
assert.equal(catalog[0].reasoning.kind, 'enum');
assert.equal(catalog[1].reasoning.kind, 'none');
assert.equal(catalog[2].reasoning.kind, 'none');

const v15Catalog = normalizeAgyModelCatalog([
  { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
  { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
  { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (Extra)' },
  { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
  { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (Extra)' },
  { id: 'gemini-4-hydrogen-max', label: 'Gemini 4 Hydrogen (Max)' },
]);
assert.deepEqual(v15Catalog, [
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    reasoning: {
      kind: 'enum',
      label: 'Thinking',
      levels: ['low', 'medium', 'high', 'xhigh'],
      default: 'medium',
    },
  },
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    reasoning: {
      kind: 'enum',
      label: 'Thinking',
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default: 'medium',
    },
  },
]);

console.log('test-models-agy-normalization: ok');
