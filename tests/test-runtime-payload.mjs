import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { stageRuntimePayload } from '../scripts/stage-runtime-payload.mjs';
import { scanRuntimePayload } from '../scripts/verify-runtime-payload.mjs';

const root = mkdtempSync(join(tmpdir(), 'agct-payload-'));
let serial = 0;
let passed = 0;
// Synthetic, invalid key data; never use real credentials in a regression.
const privateKey = ['-----BEGIN PRIVATE KEY-----', 'A'.repeat(80), '-----END PRIVATE KEY-----'].join('\n');
function fixture(extra = {}) {
  const source = join(root, `source-${++serial}`);
  const destination = join(root, `payload-${serial}`);
  mkdirSync(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: 'pipe' });
  git('init');
  git('config', 'core.autocrlf', 'false');
  const files = {
    'package.json': '{"name":"desktop-fixture"}', 'package-lock.json': '{}',
    'chat-server.mjs': 'console.log("server")\n', 'cli.js': 'console.log("cli")\n',
    'lib/runtime.mjs': 'export const fixture = true;\n', 'static/chat/ui.js': 'export {};\n',
    'shared/whisper-languages.json': '{}\n',
    'templates/chat.html': '<html></html>', '.gitignore': '*.local-secret.json\n',
    'accounts/package.json': '{"name":"accounts-fixture"}', 'accounts/package-lock.json': '{}',
    'accounts/server.mjs': 'export {};\n', 'scripts/accounts-migrate.mjs': 'export {};\n',
    'accounts/turn-handoff-policy.mjs': 'export {};\n', 'accounts/turn-lease-policy.mjs': 'export {};\n',
    ...extra,
  };
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(source, name)), { recursive: true });
    writeFileSync(join(source, name), contents);
  }
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Payload Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  };
  commit();
  return { source, destination, git, commit };
}
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}
try {
  await check('desktop and account payloads retain license notices', async () => {
    for (const profile of ['desktop', 'accounts']) {
      const f = fixture({
        LICENSE: 'license text\n',
        NOTICE: 'attribution\n',
        'THIRD_PARTY_NOTICES.md': 'third-party notices\n',
        'third_party_licenses/example.txt': 'dependency license\n',
      });
      await stageRuntimePayload({ ...f, profile });
      for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'third_party_licenses/example.txt']) {
        assert.equal(existsSync(join(f.destination, name)), true, `${profile}: ${name}`);
      }
    }
  });
  await check('clean tracked allowlist omits developer secrets, state and unrelated root material', async () => {
    const f = fixture({ 'tracked-development-key.json': privateKey, 'android/source.kt': 'private dev code',
      'tests/fixture.json': privateKey, 'accounts/internal-not-client.mjs': 'export {}' });
    writeFileSync(join(f.source, 'firebase.local-secret.json'), privateKey);
    const result = await stageRuntimePayload({ ...f, profile: 'desktop' });
    assert.equal(result.sourceRevision.length, 40);
    assert.equal(existsSync(join(f.destination, 'chat-server.mjs')), true);
    assert.equal(existsSync(join(f.destination, 'shared/whisper-languages.json')), false);
    for (const name of ['tracked-development-key.json', 'firebase.local-secret.json', 'android', 'tests', 'accounts/server.mjs', 'accounts/internal-not-client.mjs']) {
      assert.equal(existsSync(join(f.destination, name)), false, name);
    }
    for (const name of ['accounts/turn-handoff-policy.mjs', 'accounts/turn-lease-policy.mjs']) {
      assert.equal(existsSync(join(f.destination, name)), true, name);
    }
    assert.equal((await scanRuntimePayload(f.destination)).ok, true);
    assert.equal(readFileSync(join(f.destination, '.agentoc-source-commit'), 'utf8').trim(), result.sourceRevision);
  });
  await check('Accounts profile maps independent package identity and includes only its allowed shared modules', async () => {
    const f = fixture({ 'lib/target-runtime-policy.mjs': 'export {};', 'static/m3-pages.css': 'body{}' });
    const result = await stageRuntimePayload({ ...f, profile: 'accounts' });
    assert.equal(JSON.parse(readFileSync(join(f.destination, 'package.json'))).name, 'accounts-fixture');
    assert.equal(existsSync(join(f.destination, 'accounts/server.mjs')), true);
    assert.equal(existsSync(join(f.destination, 'lib/target-runtime-policy.mjs')), true);
    assert.equal(existsSync(join(f.destination, 'lib/runtime.mjs')), false);
    assert.equal(existsSync(join(f.destination, 'chat-server.mjs')), false);
    assert.ok(result.files.every((file) => file.sha256.length === 64));
  });
  await check('dirty and untracked source changes cannot be advertised as a frozen release', async () => {
    const f = fixture();
    writeFileSync(join(f.source, 'untracked.txt'), 'dirty');
    await assert.rejects(stageRuntimePayload({ ...f, profile: 'desktop' }), /clean checkout/);
    assert.equal(existsSync(f.destination), false);
  });
  await check('explicit committed-object staging preserves dirty work and ignores changed manifest and inputs', async () => {
    const committedManifest = readFileSync(new URL('../packaging/runtime-payload.json', import.meta.url));
    const binary = Buffer.from([0, 1, 2, 13, 10, 255, 0, 42]);
    const f = fixture({ 'packaging/runtime-payload.json': committedManifest, 'lib/raw.bin': binary });
    writeFileSync(join(f.source, 'lib/runtime.mjs'), 'export const dirty = true;\n');
    writeFileSync(join(f.source, 'packaging/runtime-payload.json'), '{"schemaVersion":0}');
    writeFileSync(join(f.source, 'untracked.txt'), 'preserve');
    const result = await stageRuntimePayload({ ...f, profile: 'desktop', sourceMode: 'git-objects' });
    assert.equal(readFileSync(join(f.destination, 'lib/runtime.mjs'), 'utf8'), 'export const fixture = true;\n');
    assert.deepEqual(readFileSync(join(f.destination, 'lib/raw.bin')), binary);
    assert.equal(readFileSync(join(f.source, 'lib/runtime.mjs'), 'utf8'), 'export const dirty = true;\n');
    assert.equal(readFileSync(join(f.source, 'untracked.txt'), 'utf8'), 'preserve');
    assert.equal(result.sourceRevision, f.git('rev-parse', 'HEAD').toString().trim());
  });
  await check('Windows build inputs and runtime are frozen to the same commit despite dirty source', async () => {
    const committedManifest = readFileSync(new URL('../packaging/runtime-payload.json', import.meta.url));
    const names = ['package.json', 'package-lock.json', 'main.cjs', 'preload.cjs', 'update-check.cjs', 'auto-update.cjs', 'update-linux.sh', 'update-macos.sh', 'update-windows.ps1', 'wait.html', 'stage-windows.mjs'];
    const inputs = Object.fromEntries(names.map(name => [`desktop/${name}`, `committed ${name}\n`]));
    inputs['android/app/src/main/res/drawable-nodpi/adaptive_foreground_png.png'] = Buffer.from([0, 255, 1]);
    inputs['static/desktop/agentoc-android-logo.png'] = Buffer.from([0, 255, 1]);
    inputs['static/icon-512.png'] = Buffer.from([0, 255, 1]);
    const f = fixture({ 'packaging/runtime-payload.json': committedManifest, ...inputs });
    writeFileSync(join(f.source, 'desktop/main.cjs'), 'dirty desktop code');
    writeFileSync(join(f.source, 'android/app/src/main/res/drawable-nodpi/adaptive_foreground_png.png'), 'dirty logo');
    const buildDestination = join(root, `build-${serial}`);
    const result = await stageRuntimePayload({ ...f, profile: 'desktop', sourceMode: 'git-objects', windowsBuildDestination: buildDestination });
    const buildManifest = JSON.parse(readFileSync(join(buildDestination, 'windows-build-inputs-manifest.json')));
    assert.equal(buildManifest.sourceRevision, result.sourceRevision);
    assert.equal(buildManifest.files.length, 14);
    assert.equal(readFileSync(join(buildDestination, 'desktop/main.cjs'), 'utf8'), 'committed main.cjs\n');
    assert.deepEqual(readFileSync(join(buildDestination, 'android/app/src/main/res/drawable-nodpi/adaptive_foreground_png.png')), Buffer.from([0, 255, 1]));
    assert.equal(readFileSync(join(f.source, 'desktop/main.cjs'), 'utf8'), 'dirty desktop code');
    await assert.rejects(stageRuntimePayload({ ...f, destination: join(root, 'invalid-mode'), profile: 'desktop', windowsBuildDestination: join(root, 'invalid-build') }), /require committed desktop staging/);
  });
  await check('Windows build inputs cannot be staged into the source or runtime payload', async () => {
    const manifest = readFileSync(new URL('../packaging/runtime-payload.json', import.meta.url));
    const f = fixture({ 'packaging/runtime-payload.json': manifest });
    await assert.rejects(stageRuntimePayload({ ...f, profile: 'desktop', sourceMode: 'git-objects', windowsBuildDestination: join(f.source, 'owned-build') }), /must be separate/);
  });
  await check('assume-unchanged cannot hide altered executable source from committed-blob verification', async () => {
    const f = fixture();
    f.git('update-index', '--assume-unchanged', 'lib/runtime.mjs');
    writeFileSync(join(f.source, 'lib/runtime.mjs'), 'console.log("altered")');
    await assert.rejects(stageRuntimePayload({ ...f, profile: 'desktop' }), /differs from frozen commit/);
  });
  await check('secrets inside an allowed tracked runtime file fail without echoing their contents', async () => {
    const f = fixture({ 'lib/accidental-key.json': JSON.stringify({ private_key: privateKey }) });
    await assert.rejects(stageRuntimePayload({ ...f, profile: 'desktop' }), (error) => {
      assert.match(error.message, /private-key/);
      assert.equal(error.message.includes('A'.repeat(40)), false);
      return true;
    });
  });
  await check('existing destination data and required-input omissions are rejected', async () => {
    const f = fixture();
    mkdirSync(f.destination);
    writeFileSync(join(f.destination, 'keep'), 'preserve');
    await assert.rejects(stageRuntimePayload({ ...f, profile: 'desktop' }), /must be empty/);
    assert.equal(readFileSync(join(f.destination, 'keep'), 'utf8'), 'preserve');
    const missing = fixture();
    missing.git('rm', 'chat-server.mjs');
    missing.git('-c', 'user.name=Payload Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'missing');
    await assert.rejects(stageRuntimePayload({ ...missing, profile: 'desktop' }), /Required runtime input missing/);
  });
  await check('final scan catches secrets introduced by dependency assembly, including chunk boundaries', async () => {
    const f = fixture();
    await stageRuntimePayload({ ...f, profile: 'desktop' });
    const dependency = join(f.destination, 'node_modules', 'fixture');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'embedded.txt'), ' '.repeat(65530) + privateKey);
    writeFileSync(join(dependency, '.env'), 'TOKEN=synthetic');
    const result = await scanRuntimePayload(f.destination);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.kind === 'private-key'));
    assert.ok(result.findings.some((finding) => finding.kind === 'credential-or-runtime-state-file'));
    assert.equal(JSON.stringify(result).includes('A'.repeat(40)), false);
  });
  if (process.platform === 'win32') await check('real NTFS junctions cannot redirect committed runtime inputs or escape a final payload', async () => {
    const f = fixture({ 'lib/reparse/input.mjs': 'export {};\n' });
    const original = join(f.source, 'lib', 'reparse');
    assert.ok(original.startsWith(f.source + sep));
    rmSync(original, { recursive: true });
    const outside = join(root, 'outside-junction');
    mkdirSync(outside);
    writeFileSync(join(outside, 'input.mjs'), 'export {};\n');
    symlinkSync(outside, original, 'junction');
    await assert.rejects(stageRuntimePayload({ ...f, profile: 'desktop' }), /symlink|clean checkout/);
    const dir = join(root, 'junction-payload');
    mkdirSync(dir);
    symlinkSync(outside, join(dir, 'escape'), 'junction');
    assert.equal((await scanRuntimePayload(dir)).findings[0].kind, 'escaping-symlink');
  });
  if (process.platform !== 'win32') await check('source symlinks and final-payload escapes fail while internal npm links remain valid', async () => {
    const f = fixture();
    symlinkSync('../package.json', join(f.source, 'lib', 'link.json'));
    f.commit();
    await assert.rejects(stageRuntimePayload({ ...f, profile: 'desktop' }), /symlink|committed regular file/);
    const dir = join(root, 'links');
    mkdirSync(dir);
    writeFileSync(join(dir, 'ok'), 'public');
    symlinkSync('ok', join(dir, 'internal'));
    assert.equal((await scanRuntimePayload(dir)).ok, true);
    symlinkSync(f.source, join(dir, 'escape'));
    assert.equal((await scanRuntimePayload(dir)).findings[0].kind, 'escaping-symlink');
  });
} finally {
  assert.ok(root.startsWith(join(tmpdir(), 'agct-payload-')));
  rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} runtime payload checks passed`);
