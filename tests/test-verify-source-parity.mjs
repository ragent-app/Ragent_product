#!/usr/bin/env node
// DS-01 parity gate fixture tests.
//
// Builds temporary git fixtures (never touches /opt or any real data root),
// runs scripts/verify-source-parity.mjs as a subprocess, and asserts exit
// codes and JSON layer statuses:
//   1. identical source/install            -> pass (exit 0)
//   2. one installed file different        -> fail (exit 1)
//   3. missing install root                -> fail (exit 1)
//   4. dirty source: fail by default, pass only with --allow-dirty-source
//   5. --allow-dirty-source never swallows a hash mismatch
//   6. JSON report contains the five layer fields
//   7. packaged layer: recorded manifest matches, then fails on drift
//   8. file missing in install root        -> fail (exit 1)
//
// Run: node tests/test-verify-source-parity.mjs

import assert from 'assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const verifier = path.join(repoRoot, 'scripts', 'verify-source-parity.mjs');

// The compared path set is part of the verifier contract; keep this fixture
// tree in sync with COMPARED in scripts/verify-source-parity.mjs.
const TREE = {
  'package.json': '{"name":"ragent-test","version":"0.0.0-test"}',
  'chat-server.mjs': 'export const ENTRY = "chat-server";\n',
  'chat/session-manager.mjs': 'export const ENTRY = "session-manager";\n',
  'lib/config.mjs': 'export const ENTRY = "config";\n',
  'static/chat/chat.css': '/* fixture chat css */\n',
  'static/chat/compose.js': 'export const ENTRY = "compose";\n',
  'static/chat/ui.js': 'export const ENTRY = "ui";\n',
  'static/marked.min.js': '/* fixture marked */\n',
  'static/sw.js': '/* fixture sw */\n',
  'static/manifest.json': '{"name":"fixture-manifest"}\n',
  'templates/chat.html': '<html><body>chat</body></html>\n',
  'templates/login.html': '<html><body>login</body></html>\n',
};

async function writeTree(root, overrides = {}) {
  for (const [rel, content] of Object.entries({ ...TREE, ...overrides })) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
}

async function gitInit(srcRoot) {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: srcRoot });
  await execFileAsync('git', ['add', '-A'], { cwd: srcRoot });
  await execFileAsync('git', ['-c', 'user.name=parity-test', '-c', 'user.email=parity-test@local', 'commit', '-q', '-m', 'fixture baseline'], { cwd: srcRoot });
}

async function copyTree(fromRoot, toRoot) {
  for (const rel of Object.keys(TREE)) {
    const p = path.join(toRoot, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.copyFile(path.join(fromRoot, rel), p);
  }
}

let passed = 0;
let failed = 0;

async function runVerifier(args) {
  try {
    const res = await execFileAsync(process.execPath, [verifier, ...args], { encoding: 'utf8' });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function parseReport(result) {
  return JSON.parse(result.stdout);
}

async function makeFixture(committed = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-test-'));
  const src = path.join(dir, 'src');
  const inst = path.join(dir, 'inst');
  const data = path.join(dir, 'data');
  await fs.mkdir(data, { recursive: true });
  await writeTree(src);
  if (committed) await gitInit(src);
  await copyTree(src, inst);
  return { dir, src, inst, data };
}

async function cleanup(fixture) {
  await fs.rm(fixture.dir, { recursive: true, force: true });
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`FAIL - ${name}\n  ${err.message}\n`);
  }
}

const baseArgs = (f) => [
  '--source', f.src,
  '--install', f.inst,
  '--data-root', f.data,
  '--live-url', 'none',
  '--manifest', path.join(f.dir, 'manifest.json'),
];

async function main() {
  // 1. identical source/install -> pass
  await test('identical source and install pass (exit 0)', async () => {
    const f = await makeFixture();
    try {
      const res = await runVerifier(baseArgs(f));
      const rep = parseReport(res);
      assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`);
      assert.equal(rep.verdict, 'pass');
      assert.equal(rep.layers['source-tested'].status, 'pass');
      assert.equal(rep.layers.installed.status, 'pass');
      assert.equal(rep.layers.packaged.status, 'unknown'); // no manifest recorded yet
    } finally {
      await cleanup(f);
    }
  });

  // 2. one installed file different -> fail
  await test('one installed file different fails (exit 1)', async () => {
    const f = await makeFixture();
    try {
      await fs.writeFile(path.join(f.inst, 'chat-server.mjs'), 'export const ENTRY = "tampered";\n');
      const res = await runVerifier(baseArgs(f));
      const rep = parseReport(res);
      assert.equal(res.code, 1, `expected exit 1, got ${res.code}`);
      assert.equal(rep.verdict, 'fail');
      assert.equal(rep.layers.installed.status, 'fail');
      const hit = rep.mismatches.find((m) => m.path === 'chat-server.mjs' && m.layer === 'installed');
      assert.ok(hit, 'mismatch for chat-server.mjs expected');
      assert.notEqual(hit.expected, hit.actual);
      assert.ok(rep.recommendations.some((r) => r.includes('chat-server.mjs')), 'actionable recommendation expected');
    } finally {
      await cleanup(f);
    }
  });

  // 3. missing install root -> fail
  await test('missing install root fails (exit 1)', async () => {
    const f = await makeFixture();
    try {
      const res = await runVerifier([...baseArgs(f), '--install', path.join(f.dir, 'does-not-exist')]);
      const rep = parseReport(res);
      assert.equal(res.code, 1, `expected exit 1, got ${res.code}`);
      assert.equal(rep.layers.installed.status, 'fail');
      assert.ok(rep.recommendations.some((r) => r.includes('does not exist')), 'missing-root recommendation expected');
    } finally {
      await cleanup(f);
    }
  });

  // 4. dirty source: fail by default, pass only with --allow-dirty-source
  await test('dirty source fails by default, passes only with --allow-dirty-source', async () => {
    const f = await makeFixture();
    try {
      // working tree changes to a compared path; install mirrors the working tree
      await fs.writeFile(path.join(f.src, 'package.json'), '{"name":"ragent-test","version":"0.0.0-test-dirty"}');
      await fs.copyFile(path.join(f.src, 'package.json'), path.join(f.inst, 'package.json'));

      const strict = await runVerifier(baseArgs(f));
      const strictRep = parseReport(strict);
      assert.equal(strict.code, 1, `dirty source should fail without flag, got ${strict.code}`);
      assert.equal(strictRep.layers['source-tested'].status, 'fail');
      assert.deepEqual(strictRep.git.dirtyCompared, ['package.json']);

      const allowed = await runVerifier([...baseArgs(f), '--allow-dirty-source']);
      const allowedRep = parseReport(allowed);
      assert.equal(allowed.code, 0, `dirty source should pass with flag, got ${allowed.code}: ${allowed.stderr}`);
      assert.equal(allowedRep.layers['source-tested'].status, 'pass');
      assert.equal(allowedRep.layers.installed.status, 'pass'); // hash checks still ran
    } finally {
      await cleanup(f);
    }
  });

  // 5. --allow-dirty-source must not swallow a hash mismatch
  await test('--allow-dirty-source never swallows a hash mismatch', async () => {
    const f = await makeFixture();
    try {
      // dirty source AND stale install (install still holds committed content)
      await fs.writeFile(path.join(f.src, 'package.json'), '{"name":"ragent-test","version":"0.0.0-test-dirty"}');
      const res = await runVerifier([...baseArgs(f), '--allow-dirty-source']);
      const rep = parseReport(res);
      assert.equal(res.code, 1, `hash mismatch must fail even with flag, got ${res.code}`);
      assert.equal(rep.layers.installed.status, 'fail');
      assert.equal(rep.layers['source-tested'].status, 'pass'); // flag only relaxes source cleanliness
    } finally {
      await cleanup(f);
    }
  });

  // 6. five layer fields present
  await test('report contains source-tested/hot-mounted/packaged/installed/live-verified', async () => {
    const f = await makeFixture();
    try {
      const res = await runVerifier(baseArgs(f));
      const rep = parseReport(res);
      for (const key of ['source-tested', 'hot-mounted', 'packaged', 'installed', 'live-verified']) {
        assert.ok(key in rep.layers, `missing layer field ${key}`);
      }
      assert.equal(rep.layers['hot-mounted'].status, 'no'); // fixture install is a separate copy
      assert.equal(rep.layers['live-verified'].status, 'unknown'); // probe disabled in tests
    } finally {
      await cleanup(f);
    }
  });

  // 7. packaged layer: recorded manifest matches, then fails on drift
  await test('packaged layer passes after --record-manifest, fails on source drift', async () => {
    const f = await makeFixture();
    try {
      const recorded = await runVerifier([...baseArgs(f), '--record-manifest']);
      assert.equal(recorded.code, 0, `record-manifest run failed: ${recorded.stderr}`);
      assert.equal(parseReport(recorded).layers.packaged.status, 'unknown'); // manifest did not exist during that run
      const first = parseReport(await runVerifier(baseArgs(f)));
      assert.equal(first.layers.packaged.status, 'pass');

      // drift: change a compared file, commit it, mirror to install
      await fs.writeFile(path.join(f.src, 'chat/session-manager.mjs'), 'export const ENTRY = "session-manager-v2";\n');
      await execFileAsync('git', ['add', '-A'], { cwd: f.src });
      await execFileAsync('git', ['-c', 'user.name=parity-test', '-c', 'user.email=parity-test@local', 'commit', '-q', '-m', 'drift'], { cwd: f.src });
      await fs.copyFile(path.join(f.src, 'chat/session-manager.mjs'), path.join(f.inst, 'chat/session-manager.mjs'));

      const drifted = await runVerifier(baseArgs(f));
      const driftedRep = parseReport(drifted);
      assert.equal(drifted.code, 1, `manifest drift should fail, got ${drifted.code}`);
      assert.equal(driftedRep.layers.packaged.status, 'fail');
      assert.ok(driftedRep.mismatches.some((m) => m.layer === 'packaged' && m.path === 'chat/session-manager.mjs'));
      assert.equal(driftedRep.layers.installed.status, 'pass'); // install still matches source
    } finally {
      await cleanup(f);
    }
  });

  // 8. file missing in install root -> fail
  await test('file missing in install root fails (exit 1)', async () => {
    const f = await makeFixture();
    try {
      await fs.rm(path.join(f.inst, 'templates/login.html'));
      const res = await runVerifier(baseArgs(f));
      const rep = parseReport(res);
      assert.equal(res.code, 1, `expected exit 1, got ${res.code}`);
      assert.equal(rep.layers.installed.status, 'fail');
      assert.ok(rep.mismatches.some((m) => m.path === 'templates/login.html' && m.actual === null));
    } finally {
      await cleanup(f);
    }
  });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`test harness error: ${err.stack ?? err.message}\n`);
  process.exit(2);
});
