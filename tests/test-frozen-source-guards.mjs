import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'agentoc-frozen-guards-'));
const bare = join(root, 'source.git');
const bootstrap = join(root, 'bootstrap');
const fakeBin = join(root, 'bin');
const env = {
  ...process.env,
  HOME: root,
  TMPDIR: root,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const inputs = [
  'scripts/build-deb.sh', 'scripts/build-dmg.sh',
  'scripts/stage-runtime-payload.mjs', 'scripts/verify-runtime-payload.mjs',
  'third_party_licenses/node/v24.12.0-LICENSE.txt',
];
function git(args, input) {
  return execFileSync('git', ['--git-dir', bare, ...args], { env, input, encoding: 'utf8' }).trim();
}
try {
  execFileSync('git', ['init', '--bare', '--quiet', bare], { env });
  const files = new Map();
  for (const name of inputs) {
    const data = readFileSync(join(repo, name));
    const target = join(bootstrap, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    files.set(name, git(['hash-object', '-w', '--stdin'], data));
  }
  function tree(prefix = '') {
    const children = new Map();
    for (const [name, oid] of files) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.set(rest, { type: 'blob', oid });
      else children.set(rest.slice(0, slash), { type: 'tree' });
    }
    const records = [...children].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
      const oid = value.type === 'tree' ? tree(`${prefix}${name}/`) : value.oid;
      return `${value.type === 'tree' ? '040000' : '100644'} ${value.type} ${oid}\t${name}\0`;
    }).join('');
    return git(['mktree', '-z'], records);
  }
  const commit = git(['commit-tree', tree()], 'fixture\n');
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['update-ref', 'refs/heads/main', commit]);
  mkdirSync(fakeBin);
  const uname = join(fakeBin, 'uname');
  writeFileSync(uname, '#!/bin/sh\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n');
  chmodSync(uname, 0o755);
  const common = {
    ...env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    AGENTOC_SOURCE_GIT_DIR: bare,
    AGENTOC_SOURCE_COMMIT: commit,
    AGENTOC_DMG_OUTPUT_DIR: join(root, 'out'),
    AGENTOC_DEB_OUTPUT_DIR: join(root, 'out'),
    AGENTOC_PACKAGE_VERSION: '0.0.1',
  };
  function build(script, override = {}) {
    return spawnSync('bash', [join(bootstrap, 'scripts', script)], {
      env: { ...common, ...override }, encoding: 'utf8', timeout: 30000,
    });
  }
  for (const script of ['build-deb.sh', 'build-dmg.sh']) {
    const wrongCommit = build(script, { AGENTOC_SOURCE_COMMIT: '0'.repeat(commit.length) });
    assert.notEqual(wrongCommit.status, 0);
    assert.match(wrongCommit.stderr, /requires the expected full commit ID/);
  }
  writeFileSync(join(bootstrap, 'scripts/verify-runtime-payload.mjs'), 'altered\n');
  for (const script of ['build-deb.sh', 'build-dmg.sh']) {
    const modifiedBootstrap = build(script);
    assert.notEqual(modifiedBootstrap.status, 0);
    assert.match(modifiedBootstrap.stderr, /bootstrap differs from the specified commit/);
  }
  const markerOnly = build('build-deb.sh', { AGENTOC_SOURCE_GIT_DIR: '', AGENTOC_SOURCE_COMMIT: '' });
  assert.notEqual(markerOnly.status, 0);
  assert.match(markerOnly.stderr, /source archive requires AGENTOC_SOURCE_GIT_DIR/);
  console.log('frozen source guard checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
