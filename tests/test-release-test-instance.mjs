import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildChildEnvironment } from '../scripts/launch-test-instance.mjs';

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(repo, 'scripts', 'launch-test-instance.mjs');
const testTempBase = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
const root = mkdtempSync(join(testTempBase, 'agct-test-'));
let passed = 0;
async function run(args, options = {}) {
  try {
    const result = await exec(process.execPath, [launcher, '--base-dir', root, '--json', ...args],
      { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, ...options });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}
try {
  await check('all mutable roots and cloud endpoints override polluted parent environment', async () => {
    const dir = join(root, 'env');
    const env = buildChildEnvironment({ id: 'env', instanceDir: dir, configDir: join(dir, 'config'),
      memoryDir: join(dir, 'memory'), workRootDir: join(dir, 'workspace'),
      spoolDir: join(dir, 'data', 'chat-runs'), providerHomesDir: join(dir, 'provider-homes'), port: 41234,
    }, { PATH: process.env.PATH, RAGENT_WINDOWS_SERVICE_MODE: '1', RAGENT_RUN_SPOOL_DIR: '/production',
      ragent_provider_homes_dir: '/production', RAGENT_ACCOUNTS_URL: 'https://production.invalid',
      RAGENT_AUTH_SESSION_SECRET: 'production-secret', OPENAI_API_KEY: 'production-api-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/production-key.json', GOOGLE_APPLICATION_CREDENTIALS_JSON: 'private' });
    for (const key of ['RAGENT_INSTANCE_ROOT', 'RAGENT_CONFIG_DIR', 'RAGENT_MEMORY_DIR',
      'RAGENT_WORK_ROOT_DIR', 'RAGENT_RUN_SPOOL_DIR', 'RAGENT_PROVIDER_HOMES_DIR']) {
      const rel = relative(dir, env[key]);
      assert.ok(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)), key);
    }
    for (const key of ['RAGENT_WINDOWS_SERVICE_MODE', 'ragent_provider_homes_dir', 'OPENAI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON']) assert.equal(env[key], undefined, key);
    assert.notEqual(env.RAGENT_AUTH_SESSION_SECRET, 'production-secret');
    for (const key of ['RAGENT_ACCOUNTS_URL', 'RAGENT_ACCOUNTS_JWKS_URL', 'RAGENT_TURN_BROKER_URL',
      'RAGENT_P2P_SIGNALING_URL']) assert.equal(new URL(env[key]).hostname, '127.0.0.1');
  });
  await check('actual config import resolves inside isolated roots on this platform', async () => {
    const script = `const c=await import(${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).href)});
      console.log(JSON.stringify({config:c.CONFIG_DIR,spool:c.CHAT_RUNS_DIR,home:c.CODEX_MANAGED_HOME_DIR,
      memory:c.MEMORY_DIR,accounts:c.ACCOUNTS_URL,turn:c.TURN_BROKER_URL}));`;
    const result = await run(['--', process.execPath, '--input-type=module', '-e', script]);
    assert.equal(result.code, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    const actual = JSON.parse(status.stdoutTail.trim());
    for (const key of ['config', 'spool', 'home', 'memory']) {
      const rel = relative(status.instanceDir, actual[key]);
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), key);
    }
    assert.equal(new URL(actual.accounts).hostname, '127.0.0.1');
    assert.equal(new URL(actual.turn).hostname, '127.0.0.1');
    assert.equal(status.cleaned, true);
  });
  await check('existing instance directory is never overwritten or removed', async () => {
    const existing = join(root, 'collision');
    mkdirSync(existing);
    writeFileSync(join(existing, 'sentinel'), 'keep');
    const result = await run(['--instance-id', 'collision', '--', process.execPath, '-e', 'process.exit(0)']);
    assert.equal(result.code, 1);
    assert.equal(readFileSync(join(existing, 'sentinel'), 'utf8'), 'keep');
  });
  await check('production ports and malformed numeric limits fail before launch', async () => {
    for (const args of [['--port', '7690'], ['--port', '7699'], ['--port', '42junk'],
      ['--ttl', '1junk'], ['--ttl', '99999999999999'], ['--grace', '1junk'], ['--instance-id', '..']]) {
      const result = await run([...args, '--', process.execPath, '-e', 'process.exit(99)']);
      assert.equal(result.code, 1, args.join(' '));
    }
  });
  if (process.platform !== 'win32') await check('overlong Unix socket paths fail before a misleading partial server boot', async () => {
    const longBase = join(root, 'too-long-for-sockaddr-un-'.repeat(5));
    const result = await run(['--base-dir', longBase, '--', process.execPath, '-e', 'process.exit(99)']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /socket path is too long/);
  });
  await check('fast startup failure retains actual stderr and persists evidence', async () => {
    const evidence = join(root, 'evidence');
    const result = await run(['--evidence-dir', evidence, '--', process.execPath, '-e',
      'console.log("{child-json}"); console.error("STARTUP_FIXTURE_FAILURE"); process.exit(23)']);
    assert.equal(result.code, 23);
    const status = JSON.parse(result.stdout);
    assert.equal(status.exitCode, 23);
    assert.match(status.stderrTail, /STARTUP_FIXTURE_FAILURE/);
    assert.match(status.stdoutTail, /child-json/);
    assert.equal(status.cleaned, true);
    assert.equal(existsSync(status.instanceDir), false);
    assert.equal(JSON.parse(readFileSync(join(status.evidenceDir, 'result.json'), 'utf8')).exitCode, 23);
  });
  await check('missing command reports spawn error without an event-listener race', async () => {
    const result = await run(['--', join(root, 'no-such-command')]);
    assert.notEqual(result.code, 0);
    const status = JSON.parse(result.stdout);
    assert.match(status.spawnError, /ENOENT/);
    assert.equal(status.cleaned, true);
  });
  await check('TTL kills only the owned child and returns bounded structured failure', async () => {
    const result = await run(['--ttl', '1', '--grace', '100', '--', process.execPath, '-e',
      'process.on("SIGTERM",()=>{}); setInterval(()=>{},100)']);
    assert.equal(result.code, 124);
    const status = JSON.parse(result.stdout);
    assert.equal(status.ttlExpired, true);
    assert.equal(status.cleaned, true);
    assert.throws(() => process.kill(status.pid, 0));
  });
  await check('replaced ownership marker refuses cleanup and reports cleaned=false', async () => {
    const result = await run(['--', process.execPath, '-e', `const fs=require('fs');const path=require('path');
      const p=path.join(process.env.RAGENT_INSTANCE_ROOT,'instance.json');
      setTimeout(()=>{const m=JSON.parse(fs.readFileSync(p,'utf8'));m.ownerNonce='changed';
      fs.writeFileSync(p,JSON.stringify(m));},100);`]);
    assert.equal(result.code, 1);
    const status = JSON.parse(result.stdout);
    assert.equal(status.cleaned, false);
    assert.match(status.cleanupError, /ownership changed/);
    assert.equal(existsSync(status.instanceDir), true);
  });
  await check('keep-on-error preserves only the failed test instance', async () => {
    const result = await run(['--keep-on-error', '--', process.execPath, '-e', 'process.exit(9)']);
    assert.equal(result.code, 9);
    const status = JSON.parse(result.stdout);
    assert.equal(status.cleaned, false);
    assert.equal(existsSync(status.instanceDir), true);
  });
  if (process.platform !== 'win32') await check('inherited descendant pipes are bounded and cannot turn incomplete cleanup into success', async () => {
    const result = await run(['--grace', '100', '--', process.execPath, '-e',
      'const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},2500)"],{stdio:"inherit"});c.unref();']);
    assert.equal(result.code, 1);
    const status = JSON.parse(result.stdout);
    assert.equal(status.stdioIncomplete, true);
    assert.equal(status.cleaned, false);
    assert.equal(status.ok, false);
    // The deliberately created descendant self-exits; never scan/kill other PIDs.
    await new Promise((resolve) => setTimeout(resolve, 2600));
  });
  await check('real isolated control plane answers health and then exits without installed-service changes', async () => {
    const script = `await import(${JSON.stringify(new URL('../chat-server.mjs', import.meta.url).href)});
      const http=await import('node:http');
      const probe=()=>new Promise((resolve,reject)=>{
        const q=http.get({hostname:'127.0.0.1',port:Number(process.env.CHAT_PORT),path:'/healthz',agent:false},r=>{
          r.resume();r.once('end',()=>resolve(r.statusCode));
        });q.once('error',reject);q.setTimeout(500,()=>q.destroy(new Error('probe timeout')));
      });
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){
        try { const status=await probe();
          if(status===200){console.log('RELEASE_ISOLATED_HEALTH_PASS');process.emit('SIGTERM');
            await new Promise(r=>setTimeout(r,10000));process.exit(5);} } catch{}
        await new Promise(r=>setTimeout(r,100));
      }
      console.error('RELEASE_ISOLATED_HEALTH_FAILED');process.exit(4);`;
    const result = await run(['--ttl', '12', '--', process.execPath, '--input-type=module', '-e', script],
      { timeout: 20000 });
    assert.equal(result.code, 0, result.stderr.slice(-2500));
    const status = JSON.parse(result.stdout);
    assert.match(status.stdoutTail, /RELEASE_ISOLATED_HEALTH_PASS/);
    assert.equal(status.cleaned, true);
    assert.throws(() => process.kill(status.pid, 0));
  });
} finally {
  // root was exclusively created by this test; no production or external path.
  assert.ok(root.startsWith(join(testTempBase, 'agct-test-')));
  rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} release test launcher checks passed`);
