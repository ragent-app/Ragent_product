import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync } from 'node:crypto';

const root = await mkdtemp(path.join(os.tmpdir(), 'ragent-user-install-store-'));
process.env.RAGENT_INSTANCE_ROOT = path.join(root, 'instance');
process.env.RAGENT_CONFIG_DIR = path.join(root, 'instance', 'config');
process.env.RAGENT_MEMORY_DIR = path.join(root, 'instance', 'memory');
process.env.RAGENT_WORK_ROOT_DIR = path.join(root, 'instance', 'workspace');
process.env.RAGENT_PROVIDER_HOMES_DIR = path.join(root, 'instance', 'provider-homes');
process.env.RAGENT_RUN_SPOOL_DIR = path.join(root, 'instance', 'data', 'chat-runs');
const { createRun, getRun } = await import('../chat/runs.mjs');
const { createWindowsUserInstallStore } = await import('../chat/windows-user-install-store.mjs');
const { bindWindowsRunExecutionIdentity } = await import('../chat/windows-run-identity.mjs');
const { getWindowsManagedAutoInstallStatus } = await import('../chat/windows-managed-auto-install.mjs');
const { compileSemanticOperations } = await import('../chat/semantic-compiler.mjs');
const { resolveSemanticContext } = await import('../chat/semantic-resolver.mjs');
const { evaluateSemanticOperation } = await import('../chat/semantic-policy.mjs');
const { createWindowsUserInstallAuthorization } = await import('../chat/windows-auto-install-authorization.mjs');
try {
  const run = await createRun({ status: { sessionId: 'fixture-session', state: 'accepted' },
    manifest: { sessionId: 'fixture-session', folder: root, tool: 'fixture', prompt: 'fixture', options: {} } });
  const binding = { sessionId: 'fixture-session', runId: run.id, turnId: 'turn-1', requestKey: 'gate:test' };
  assert.equal(await bindWindowsRunExecutionIdentity(run.id, { sid: 'S-1-5-21-1-2-3-4' }), 'S-1-5-21-1-2-3-4');
  assert.equal(await bindWindowsRunExecutionIdentity(run.id, { sid: 's-1-5-21-1-2-3-4' }), 's-1-5-21-1-2-3-4');
  await assert.rejects(bindWindowsRunExecutionIdentity(run.id, { sid: 'S-1-5-21-1-2-3-5' }), /changed/);
  await bindWindowsRunExecutionIdentity(run.id, { sid: 'S-1-5-21-1-2-3-4', isService: true });
  assert.equal((await getRun(run.id)).windowsExecutionIsService, true);
  await assert.rejects(bindWindowsRunExecutionIdentity(run.id, { sid: 'S-1-5-21-1-2-3-4', isService: false }), /changed/);
  const store = createWindowsUserInstallStore();
  const claim = { binding, nonce: 'nonce-1', operationFingerprint: 'a'.repeat(64) };
  assert.equal(await store.status(binding), null);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(claim)));
  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.filter((result) => result.duplicate && result.status === 'unknown').length, 7);
  assert.equal((await store.status(binding)).status, 'unknown');
  const status = await getWindowsManagedAutoInstallStatus({ platform: 'win32', binding: { ...binding, authenticatedPrincipalKind: 'owner' } }, {
    userStore: store, client: { status: async () => { throw new Error('unexpected broker lookup'); } },
  });
  assert.equal(status.status, 'unknown');
  assert.equal(status.requestKey, binding.requestKey);
  await assert.rejects(store.claim({ ...claim, operationFingerprint: 'b'.repeat(64) }), /conflicts/);
  await assert.rejects(store.finish({ binding, nonce: 'other', status: 'succeeded' }), /mismatch/);
  await store.finish({ binding, nonce: claim.nonce, status: 'succeeded' });
  assert.equal((await store.status(binding)).status, 'succeeded');
  assert.deepEqual(await store.claim({ ...claim, nonce: 'new-nonce' }), { duplicate: true, status: 'succeeded', code: '' });
  await assert.rejects(store.finish({ binding, nonce: claim.nonce, status: 'succeeded' }), /mismatch/);
  const concurrentRun = await createRun({ status: { sessionId: 'fixture-concurrent', state: 'accepted' },
    manifest: { sessionId: 'fixture-concurrent', folder: root, tool: 'fixture', prompt: 'fixture', options: {} } });
  const concurrentBinding = { sessionId: 'fixture-concurrent', runId: concurrentRun.id, turnId: 'turn-2', requestKey: 'gate:concurrent' };
  const moduleUrl = new URL('../chat/windows-user-install-store.mjs', import.meta.url).href;
  const script = `const {createWindowsUserInstallStore}=await import(process.env.RAGENT_QA_MODULE); const binding=JSON.parse(process.env.RAGENT_QA_BINDING); const result=await createWindowsUserInstallStore().claim({binding,nonce:process.env.RAGENT_QA_NONCE,operationFingerprint:'c'.repeat(64)}); process.stdout.write(JSON.stringify(result));`;
  const spawned = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true,
      env: { ...process.env, RAGENT_QA_MODULE: moduleUrl, RAGENT_QA_BINDING: JSON.stringify(concurrentBinding), RAGENT_QA_NONCE: `worker-${index}` } });
    return JSON.parse(stdout);
  }));
  assert.equal(spawned.filter((result) => result.claimed).length, 1, 'only one process may claim the operation');
  assert.equal(spawned.filter((result) => result.duplicate && result.status === 'unknown').length, 3);
  const executionRun = await createRun({ status: { sessionId: 'fixture-execute', state: 'accepted' },
    manifest: { sessionId: 'fixture-execute', folder: root, tool: 'fixture', prompt: 'fixture', options: {} } });
  const executionBinding = { sessionId: 'fixture-execute', runId: executionRun.id, turnId: 'turn-3', requestKey: 'gate:execute' };
  const trustedContext = { cwd: 'D:\\project', projectRoot: 'D:\\project', platform: 'win32' };
  const operation = compileSemanticOperations({ request: { ...executionBinding, executionClass: 'host', rawCommand: 'winget install Vendor.App --scope user' }, trustedContext }).operations[0];
  const resolution = await resolveSemanticContext({ operation, options: { trustedContext, windowsFactsProvider: {
    name: 'test-package', async packageFacts(query) { return { manager: 'winget', source: 'winget', sourceTrust: 'configured',
      repositories: [{ id: 'winget', trust: 'configured' }], packages: query.packages.map((name) => ({ name, requestedVersion: '', availableVersion: '1.2.3' })) }; },
  } } });
  const decision = evaluateSemanticOperation(operation, resolution);
  const keys = generateKeyPairSync('ed25519');
  const capability = createWindowsUserInstallAuthorization({ prepared: { binding: executionBinding, projection: { decisions: [decision] } },
    riskMode: 'recommended', kid: 'fixture-key', privateKey: keys.privateKey, expectedExecutionSid: 'S-1-5-21-1-2-3-4' });
  const receipt = path.join(root, 'mock-install-receipt');
  const executorUrl = new URL('../chat/windows-user-install-executor.mjs', import.meta.url).href;
  const executionScript = `const {appendFile}=await import('node:fs/promises'); const {createPublicKey}=await import('node:crypto');
    const {createWindowsUserInstallStore}=await import(process.env.RAGENT_QA_MODULE); const {executeWindowsUserInstall}=await import(process.env.RAGENT_QA_EXECUTOR);
    const store=createWindowsUserInstallStore(); const binding=JSON.parse(process.env.RAGENT_QA_BINDING); const capability=JSON.parse(process.env.RAGENT_QA_CAP);
    const result=await executeWindowsUserInstall({capability,binding,riskMode:'recommended',publicKey:createPublicKey(process.env.RAGENT_QA_PUBLIC),cwd:'D:\\project',expectedOwnerSid:'S-1-5-21-1-2-3-4',platform:'win32'},
    {claim:store.claim,finish:store.finish,assertIdentity:async()=>({sid:'S-1-5-21-1-2-3-4'}),assertActive:async()=>{},
    revalidate:async()=>({ok:true,invocation:{executable:'D:\\fixture\\winget.exe',argv:['install'],cwd:'D:\\project'}}),
    execFile:async()=>{await appendFile(process.env.RAGENT_QA_RECEIPT,'install\\n');await new Promise(r=>setTimeout(r,200));return {stdout:'fixture'};}});process.stdout.write(JSON.stringify(result));`;
  const executed = await Promise.all(Array.from({ length: 4 }, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', executionScript], { windowsHide: true,
      env: { ...process.env, RAGENT_QA_MODULE: moduleUrl, RAGENT_QA_EXECUTOR: executorUrl, RAGENT_QA_BINDING: JSON.stringify(executionBinding),
        RAGENT_QA_CAP: JSON.stringify(capability), RAGENT_QA_PUBLIC: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), RAGENT_QA_RECEIPT: receipt } });
    return JSON.parse(stdout);
  }));
  assert.equal(executed.filter((result) => !result.duplicate && result.status === 'succeeded').length, 1);
  assert.equal(executed.filter((result) => result.duplicate).length, 3);
  assert.equal((await readFile(receipt, 'utf8')).trim(), 'install', 'one mock installation must run across all processes');
  assert.equal((await store.status(executionBinding)).status, 'succeeded');
  const crashBinding = { ...executionBinding, requestKey: 'gate:crash' };
  const crashOperation = compileSemanticOperations({ request: { ...crashBinding, executionClass: 'host', rawCommand: 'winget install Vendor.App --scope user' }, trustedContext }).operations[0];
  const crashDecision = evaluateSemanticOperation(crashOperation, resolution);
  const crashCapability = createWindowsUserInstallAuthorization({ prepared: { binding: crashBinding, projection: { decisions: [crashDecision] } },
    riskMode: 'recommended', kid: 'fixture-key', privateKey: keys.privateKey, expectedExecutionSid: 'S-1-5-21-1-2-3-4' });
  const crashScript = executionScript.replace("await appendFile(process.env.RAGENT_QA_RECEIPT,'install\\n');await new Promise(r=>setTimeout(r,200));return {stdout:'fixture'};",
    "process.stdout.write('STARTED\\n');setInterval(()=>{},1000);await new Promise(()=>{});return {stdout:'fixture'};");
  assert.notEqual(crashScript, executionScript);
  const child = spawn(process.execPath, ['--input-type=module', '-e', crashScript], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RAGENT_QA_MODULE: moduleUrl, RAGENT_QA_EXECUTOR: executorUrl, RAGENT_QA_BINDING: JSON.stringify(crashBinding),
      RAGENT_QA_CAP: JSON.stringify(crashCapability), RAGENT_QA_PUBLIC: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), RAGENT_QA_RECEIPT: receipt } });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock installation did not start')), 15000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', (data) => { if (String(data).includes('STARTED')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('mock installer exited before start')); });
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
    assert.equal((await store.status(crashBinding)).status, 'unknown', 'interrupted operation must remain unknown');
    const replay = await store.claim({ binding: crashBinding, nonce: crashCapability.nonce,
      operationFingerprint: (await import('../chat/windows-user-install-executor.mjs')).windowsUserInstallOperationFingerprint(crashCapability) });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.status, 'unknown');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  console.log('windows-user-install-store: atomic claims and replay checks passed');
} finally {
  const actualRoot = await realpath(root);
  const actualParent = await realpath(os.tmpdir());
  assert.equal(path.dirname(actualRoot).toLowerCase(), actualParent.toLowerCase());
  assert.ok(path.basename(actualRoot).startsWith('ragent-user-install-store-'));
  await rm(actualRoot, { recursive: true, force: true });
}
