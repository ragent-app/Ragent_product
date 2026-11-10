#!/usr/bin/env node
import assert from 'node:assert/strict';
import { analyzeWindowsReadOnlyGit } from '../chat/windows-readonly-git.mjs';

for (const argv of [
  ['git', 'status'],
  ['git', 'status', '--short', '--branch'],
  ['git', 'diff', '--stat'],
  ['git', 'diff', '--stat', '--no-ext-diff'],
  ['git', 'diff', '--no-ext-diff', '--no-textconv', '--cached'],
  ['git', 'branch', '--show-current'],
  ['git', 'rev-parse', '--show-toplevel'],
  ['git', 'log', '--oneline', '-5'],
]) {
  assert.equal(analyzeWindowsReadOnlyGit(argv)?.complete, true, argv.join(' '));
}

for (const argv of [
  ['git'],
  ['git', 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'],
  ['git', 'diff'],
  ['git', 'diff', '--no-ext-diff'],
  ['git', 'add', '.'],
  ['git', 'commit', '-m', 'test'],
  ['git', 'checkout', '-b', 'feature'],
  ['git', 'push'],
  ['git', 'config', '--global', 'safe.directory', '*'],
  ['git', 'log', '--format=%s'],
]) {
  assert.equal(analyzeWindowsReadOnlyGit(argv), null, argv.join(' '));
}

console.log('windows-readonly-git: literal read-only allowlist checks passed');
