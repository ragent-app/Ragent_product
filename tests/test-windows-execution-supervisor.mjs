import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildChildEnvironment } from '../scripts/launch-test-instance.mjs';

if (process.platform !== 'win32') {
  console.log('SKIP: actual Windows token/pipe test requires Windows');
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), 'ragent-identity-live-'));
const instance = { instanceDir: root, configDir: join(root, 'config'),
  spoolDir: join(root, 'data', 'chat-runs'), providerHomesDir: join(root, 'provider-homes'),
  memoryDir: join(root, 'memory'), workRootDir: join(root, 'workspace'),
  port: 48329, id: 'identity-test', ttlSeconds: 60 };
const childEnvironment = buildChildEnvironment(instance);
for (const name of Object.keys(process.env)) {
  if (/^(RAGENT_|CHAT_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_|FCM_|FIREBASE_)/.test(name)) delete process.env[name];
}
Object.assign(process.env, childEnvironment);
const { assertOrdinaryWindowsExecutionIdentity, readWindowsExecutionIdentity } = await import('../lib/windows-execution-identity.mjs');
const { createRunnerSupervisorServer, spawnSupervisedRunner } = await import('../chat/runner-supervisor-daemon.mjs');
const { launchDetachedRunnerViaSupervisor } = await import('../chat/run-launcher.mjs');
const { createRun, getRun } = await import('../chat/runs.mjs');
const pipe = '\\\\.\\pipe\\ragent-identity-test-' + randomBytes(12).toString('hex');
const prepareProviderImpl = async () => ({});
let server, child, childExit, childOutput = '';
let normalExit = false;
try {
  await Promise.all([instance.configDir, instance.spoolDir, instance.providerHomesDir,
    instance.memoryDir, instance.workRootDir].map(path => mkdir(path, { recursive: true })));
  await createRun({ status: { id: 'run_ordinary_live_123', sessionId: 'ordinary-live-test', state: 'accepted' },
    manifest: { folder: instance.workRootDir } });
  let attemptedSpawn = false;
  server = await createRunnerSupervisorServer({ socketPath: pipe,
    spawnRunner: runId => spawnSupervisedRunner(runId, {
      assertExecutionIdentityImpl: () => assertOrdinaryWindowsExecutionIdentity({
        readIdentityImpl: async () => ({ version: 1, sid: 'S-1-5-18', isSystem: true, isService: true,
          isAdministrator: true, integrityRid: 16384 }),
      }),
      spawnImpl() { attemptedSpawn = true; throw new Error('forbidden spawn'); },
    }),
  });
  await assert.rejects(launchDetachedRunnerViaSupervisor('run_reject_system_123', { socketPath: pipe, prepareProviderImpl }),
    { code: 'WINDOWS_EXECUTION_IDENTITY_UNSAFE' });
  assert.equal(attemptedSpawn, false);
  console.log('PASS: real named-pipe unsafe-token refusal, typed code, zero child spawn (unsafe token simulated)');
  await server.close(); server = null;

  const parentIdentity = await assertOrdinaryWindowsExecutionIdentity();
  const receipt = join(instance.workRootDir, 'receipt.json');
  const probeModule = new URL('../lib/windows-execution-identity.mjs', import.meta.url).href;
  const workerPath = join(root, 'ordinary-worker.mjs');
  await writeFile(workerPath, `import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertOrdinaryWindowsExecutionIdentity,readWindowsExecutionIdentity} from ${JSON.stringify(probeModule)};
const identity=await assertOrdinaryWindowsExecutionIdentity({readIdentityImpl:()=>readWindowsExecutionIdentity({execFileImpl:async(...args)=>{
try{return await promisify(execFile)(...args)}catch(error){console.error(JSON.stringify({probeError:error.code,stderr:String(error.stderr||'').slice(0,2000)}));throw error}
}})});
await writeFile(${JSON.stringify(receipt)},JSON.stringify({identity,runId:process.argv[2],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,TEMP:process.env.TEMP,TMP:process.env.TMP}}));\n`);
  server = await createRunnerSupervisorServer({ socketPath: pipe,
    spawnRunner: runId => spawnSupervisedRunner(runId, { runnerScriptPath: workerPath,
      spawnImpl(...args) {
        const [file, argv, options] = args;
        child = spawn(file, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childOutput = (childOutput + chunk).slice(-16000); });
        childExit = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', code => resolve(code));
        });
        return child;
      },
    }),
  });
  const launched = await launchDetachedRunnerViaSupervisor('run_ordinary_live_123', { socketPath: pipe, prepareProviderImpl });
  assert.equal(launched.pid, child.pid);
  assert.equal((await getRun('run_ordinary_live_123')).windowsExecutionSid, parentIdentity.sid);
  let timer;
  const code = await Promise.race([childExit, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Ordinary child exceeded 15s deadline')), 15000);
  })]).finally(() => clearTimeout(timer));
  normalExit = true;
  assert.equal(code, 0, childOutput);
  const result = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(result.runId, 'run_ordinary_live_123');
  assert.deepEqual(result.identity, parentIdentity);
  assert.equal(result.env.SystemRoot, process.env.SystemRoot);
  assert.equal(result.env.USERPROFILE, process.env.USERPROFILE);
  assert.equal(result.env.LOCALAPPDATA, process.env.LOCALAPPDATA);
  assert.equal(result.env.TEMP, process.env.TEMP);
  assert.equal(result.env.TMP, process.env.TMP);
  assert.equal((await readWindowsExecutionIdentity()).sid, parentIdentity.sid);
  console.log('PASS: real ordinary Windows supervisor child, matching SID/token label, workspace receipt, exit 0');
} finally {
  if (child && !normalExit && child.exitCode === null) child.kill();
  if (server) await server.close();
  // Only the exact freshly-created owned root may be removed.
  const actualRoot = await realpath(root);
  const actualParent = await realpath(tmpdir());
  assert.equal(dirname(actualRoot).toLowerCase(), actualParent.toLowerCase());
  assert.ok(basename(actualRoot).startsWith('ragent-identity-live-'));
  await rm(actualRoot, { recursive: true, force: true });
}
