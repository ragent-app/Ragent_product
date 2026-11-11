#!/usr/bin/env node
import assert from 'node:assert/strict';
import { analyzeWindowsLocalGit, analyzeWindowsReadOnlyGit } from '../chat/windows-readonly-git.mjs';

for (const argv of [
  ['git', 'status'],
  ['git', 'status', '--short', '--branch'],
  ['git', 'status', '-sb', '--ignored=matching'],
  ['git', 'diff', '--stat'],
  ['git', 'diff', '--stat', '--no-ext-diff'],
  ['git', 'diff', '--stat', '--cached'],
  ['git', 'diff', '--no-ext-diff', '--no-textconv', '--cached'],
  ['git', 'branch', '--show-current'],
  ['git', 'branch', '--all', '-vv'],
  ['git', 'rev-parse', '--show-toplevel'],
  ['git', 'log', '--oneline', '-5'],
  ['git', 'log', '-n', '5', '--pretty=short'],
  ['git', 'log', '--max-count', '10', '--decorate'],
  ['git', 'log', '--oneline', '-5', 'HEAD~2..HEAD'],
  ['git', 'ls-files', '--cached', '--modified'],
]) {
  assert.equal(analyzeWindowsReadOnlyGit(argv)?.complete, true, argv.join(' '));
}

for (const argv of [
  ['git'],
  ['git', 'status', '--porcelain', '--untracked-files=all', '--ignored=bogus'],
  ['git', 'diff'],
  ['git', 'diff', '--no-ext-diff'],
  ['git', 'add', '.'],
  ['git', 'commit', '-m', 'test'],
  ['git', 'checkout', '-b', 'feature'],
  ['git', 'push'],
  ['git', 'config', '--global', 'safe.directory', '*'],
  ['git', 'log', '--format=%s'],
  ['git', 'log', '-n', '--exec=command'],
  ['git', 'branch', '--delete', 'main'],
  ['git', 'rev-parse', '--output=secret'],
]) {
  assert.equal(analyzeWindowsReadOnlyGit(argv), null, argv.join(' '));
}

console.log('windows-readonly-git: literal read-only allowlist checks passed');
for (const argv of [['git', 'diff'], ['git', 'diff', '--cached'], ['git', 'diff', '--stat', 'HEAD~1..HEAD'], ['git', 'diff', 'HEAD', '--', 'src/file.txt'], ['git', 'show', '--stat', 'HEAD'], ['git', 'add', '.'], ['git', 'add', '-A'], ['git', 'commit', '-m', 'message']]) assert.equal(analyzeWindowsLocalGit(argv)?.complete, true, argv.join(' '));
assert.deepEqual(analyzeWindowsLocalGit(['git', 'diff', 'HEAD', '--', 'src/file.txt']).pathspecs, ['src/file.txt']);
for (const argv of [['git', 'push'], ['git', 'push', '--force'], ['git', 'reset', '--hard'], ['git', 'commit', '--amend', '-m', 'x'], ['git', 'show', 'HEAD:.env'], ['git', 'diff', '.env'], ['git', 'diff', '--output=secret'], ['git', 'show', '--ext-diff'], ['git', 'ls-files', '--with-tree=HEAD']]) assert.equal(analyzeWindowsLocalGit(argv), null, argv.join(' '));
