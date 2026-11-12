#!/usr/bin/env node
import assert from 'assert/strict';
import { accessSync, constants, readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const buildScript = read('scripts/build-accounts-release.sh');
const service = read('deploy/accounts/ragent-accounts.service');
const deploy = read('deploy/accounts/DEPLOY.md');
const packageJson = JSON.parse(read('package.json'));
const profile = JSON.parse(read('packaging/runtime-payload.json')).profiles.accounts;

accessSync(join(root, 'scripts/build-accounts-release.sh'), constants.X_OK);
assert.match(buildScript, /independent, versioned release archive/);
assert.match(buildScript, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
assert.match(buildScript, /Accounts Node runtime checksum mismatch/);
assert.match(buildScript, /stage-runtime-payload\.mjs/);
assert.match(buildScript, /--profile accounts/);
assert.match(buildScript, /verify-runtime-payload\.mjs/);
assert.match(buildScript, /mktemp -d "\$OUTPUT_DIR\/\.ragent-accounts-release/);
assert.doesNotMatch(buildScript, /mktemp -d \/tmp\//, 'release build work files must stay under its output directory');
assert.match(buildScript, /npm_config_cache=.*WORK_DIR\/npm-cache/);
assert.match(buildScript, /--exclude="\$RELEASE_NAME\/runtime\/node"/);
assert.match(buildScript, /--mode=0755 -rf/);
assert.match(buildScript, /gzip -n -c "\$WORK_DIR\/release\.tar"/);
assert.match(buildScript, /ragent-accounts\.service/);
assert.match(service, /^Alias=agentoc-accounts\.service$/m);
assert.match(buildScript, /RELEASE_NAME="ragent-accounts-/);
assert.match(buildScript, /"service":"ragent-accounts"/);
assert.match(service, /^ExecStart=\/opt\/agentoc-accounts\/current\/runtime\/node /m);
assert.match(service, /^WorkingDirectory=\/opt\/agentoc-accounts\/current\/app$/m);
assert.doesNotMatch(service, /\/opt\/agentoc\/app/);
assert.match(deploy, /scripts\/build-accounts-release\.sh/);
assert.match(deploy, /\/opt\/agentoc-accounts\/current/);
assert.equal(packageJson.files.includes('accounts/'), false, 'the client package must not include Accounts source');
assert.equal(packageJson.files.includes('!scripts/accounts-migrate.mjs'), true);
assert.equal(packageJson.files.includes('!scripts/accounts-rotate-key.mjs'), true);

// Check the shipped module dependency closure rather than merely searching for filenames.
const shippedLibraries = new Set(profile.files.filter((name) => name.startsWith('lib/')));
const sourceModules = readdirSync(join(root, 'accounts'), { recursive: true })
  .filter((name) => name.endsWith('.mjs') && !name.replaceAll('\\', '/').startsWith('node_modules/'))
  .map((name) => join(root, 'accounts', name));
sourceModules.push(...[...shippedLibraries].map((name) => join(root, name)));
for (const file of sourceModules) {
  const source = readFileSync(file, 'utf8');
  for (const imported of source.matchAll(/(?:from\s+|import\(\s*)['"](\.[^'"]+)['"]/g)) {
    const target = relative(root, resolve(dirname(file), imported[1])).replaceAll('\\', '/');
    assert.ok(target.startsWith('accounts/') || shippedLibraries.has(target), `Release omits ${target}, imported by ${relative(root, file)}`);
  }
}

const npmPack = process.platform === 'win32'
  ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json'], {
    cwd: root,
    encoding: 'utf8',
  })
  : execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
const packed = JSON.parse(npmPack)[0];
// These two policy modules are intentionally shared by the local API client;
// the Accounts service implementation itself must remain out of that package.
const sharedAccountPolicies = new Set([
  'accounts/turn-handoff-policy.mjs',
  'accounts/turn-lease-policy.mjs',
]);
const leaked = packed.files
  .map((entry) => entry.path)
  .filter((file) => (file.startsWith('accounts/') && !sharedAccountPolicies.has(file))
    || file.startsWith('scripts/accounts-'));
assert.deepEqual(leaked, [], `Accounts files leaked into the local-control-plane package: ${leaked.join(', ')}`);

console.log('accounts independent release packaging tests passed');
