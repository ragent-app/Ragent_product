import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--owned-child')) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-workbench-policy-'));
  await mkdir(join(root, 'home'));
  const policy = join(root, 'ceiling.json');
  await writeFile(policy, JSON.stringify({ schemaVersion: 1, agentType: 'codex', authType: 'oauth', model: 'gpt-5.6-luna', providerProfileId: 'review-codex' }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RAGENT_|CHAT_|CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_|GOOGLE_)/.test(key)));
  Object.assign(env, { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    RAGENT_INSTANCE_ROOT: root, RAGENT_CONFIG_DIR: join(root, 'config'),
    RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1', RAGENT_WORKBENCH_EXECUTION_POLICY_FILE: policy });
  for (const profile of [null, 'ragent-review']) {
    await writeFile(policy, JSON.stringify({ schemaVersion: 1, agentType: 'codex', authType: 'oauth',
      model: 'gpt-5.6-luna', providerProfileId: 'review-codex', ...(profile ? { codexPermissionProfile: profile } : {}) }));
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--owned-child'], { env, timeout: 45_000, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  }
  for (const value of ['{"schemaVersion":1,"agentType":"codex","authType":"oauth","model":"gpt-5.6-luna","unknown":true}', 'broken-json',
    ...[true, '../unmanaged', ':danger-full-access'].map((codexPermissionProfile) => JSON.stringify({
      schemaVersion: 1, agentType: 'codex', authType: 'oauth', model: 'gpt-5.6-luna', codexPermissionProfile,
    }))]) {
    await writeFile(policy, value);
    const failed = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./lib/workbench-execution-policy.mjs')"], { env, timeout: 10_000, encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /WORKBENCH_EXECUTION_POLICY_INVALID/);
    assert.ok(!failed.stderr.includes(value));
  }
  console.log('test-workbench-execution-policy: isolated resolution, broker boundary, permission ceiling, catalog and management denial PASS');
} else {
  const { WORKBENCH_EXECUTION_POLICY: policy, assertWorkbenchExecution, assertWorkbenchProviderSetup,
    applyWorkbenchRunPolicy, filterWorkbenchModels, constrainCodexBrokerRequest,
    buildWorkbenchCodexEnvironment } = await import('../lib/workbench-execution-policy.mjs');
  assert.ok(Object.isFrozen(policy));
  const expectedMode = policy.codexPermissionProfile ? 'never-read-only' : 'untrusted-read-only';
  const expectedApproval = policy.codexPermissionProfile ? 'never' : 'untrusted';
  const controlEnv = { Path: 'owned-runtime-path', CODEX_HOME: join(process.env.HOME, 'codex'),
    SystemRoot: 'owned-system-root', LANG: 'C.UTF-8', LC_CTYPE: 'C.UTF-8',
    RAGENT_SESSION_SECRET: 'synthetic-session-secret', RAGENT_NATIVE_OAUTH_LOCK_TOKEN: 'synthetic-lock-token',
    OPENAI_API_KEY: 'synthetic-unselected-api-key', HTTPS_PROXY: 'synthetic-private-proxy',
    LC_CONTROL_TOKEN: 'synthetic-control-token', NODE_OPTIONS: 'synthetic-startup-override',
    RAGENT_USER_SHELL_ENV_B64: 'synthetic-shell-snapshot', UNRECOGNIZED_CONTROL_VALUE: 'synthetic-control-value' };
  assert.equal(buildWorkbenchCodexEnvironment(controlEnv, null), controlEnv);
  assert.deepEqual(buildWorkbenchCodexEnvironment(controlEnv), { Path: 'owned-runtime-path',
    CODEX_HOME: controlEnv.CODEX_HOME, SystemRoot: 'owned-system-root', LANG: 'C.UTF-8', LC_CTYPE: 'C.UTF-8' });
  for (const selection of [{ agentType: 'claude' }, { agentType: 'harness' }, { model: 'gpt-6-astra' },
    { authType: 'api-key' }, { providerProfileId: 'personal' }]) {
    assert.throws(() => assertWorkbenchExecution(selection), { code: 'WORKBENCH_EXECUTION_POLICY_DENIED' });
  }
  assertWorkbenchExecution({ agentType: 'codex', model: 'gpt-5.6-luna@review-codex', authType: 'oauth', providerProfileId: 'review-codex' });
  assert.throws(() => assertWorkbenchProviderSetup({ agentType: 'codex', authType: 'oauth' }), { statusCode: 403 });
  const manifest = { tool: 'codex', options: { model: 'gpt-5.6-luna', riskMode: 'full-auto', privilegedMode: true, permissionMode: 'never-danger-full-access' } };
  const constrained = applyWorkbenchRunPolicy(manifest);
  assert.equal(constrained.options.riskMode, 'safe');
  assert.equal(constrained.options.permissionMode, expectedMode);
  assert.equal(constrained.options.privilegedMode, false);
  assert.equal(manifest.options.riskMode, 'full-auto');
  const forgedChannels = { tool: 'codex', options: { approvedActionChannel: { token: 'synthetic-action' },
    windowsBrokerChannel: { token: 'synthetic-broker' }, browserChannel: { token: 'synthetic-browser' } } };
  const withoutChannels = applyWorkbenchRunPolicy(forgedChannels);
  for (const name of ['approvedActionChannel', 'windowsBrokerChannel', 'browserChannel']) {
    assert.equal(Object.hasOwn(withoutChannels.options, name), false);
    assert.equal(Object.hasOwn(forgedChannels.options, name), true);
  }
  const { isPrivilegeRoutingEnabled } = await import('../chat/approved-action-policy.mjs');
  assert.equal(isPrivilegeRoutingEnabled({ riskMode: 'safe', privilegedMode: true }), false);
  const { executeApprovedAction } = await import('../chat/approved-action-executor.mjs');
  const deniedAction = await executeApprovedAction({ executionClass: 'session' });
  assert.equal(deniedAction.decision, 'DENY');
  assert.equal(deniedAction.reasonCode, 'WORKBENCH_EXECUTION_POLICY_DENIED');
  assert.throws(() => applyWorkbenchRunPolicy({ tool: 'custom', options: {} }), { statusCode: 403 });
  const { resolveProviderPermissionPolicy } = await import('../chat/provider-contract.mjs');
  for (const family of ['codex-json', 'codex-app-server-json']) {
    const result = resolveProviderPermissionPolicy(family, { permissionMode: 'never-danger-full-access', riskMode: 'full-auto' });
    assert.equal(result.id, expectedMode);
    assert.equal(result.sandbox, 'read-only');
    assert.equal(result.approvalPolicy, expectedApproval);
  }
  const { resolveRuntimeConfig } = await import('../lib/provider-runtime/resolver.mjs');
  let agentType = 'codex', authType = 'oauth';
  const registry = {
    getProviderProfile: async () => ({ id: 'review-codex', agentType, authProfileId: 'auth', enabled: true, modelPolicy: { defaultModel: 'gpt-6-astra' } }),
    getAuthProfile: async () => ({ id: 'auth', agentType, authType, storageRef: 'owned' }),
  };
  const resolve = (model, agent = 'codex') => resolveRuntimeConfig({ registry, runRequest: { agentType: agent, providerProfileId: 'review-codex', model } });
  assert.equal((await resolve('')).model, 'gpt-5.6-luna');
  await assert.rejects(resolve('gpt-6-astra'), { statusCode: 403 });
  authType = 'api-key'; await assert.rejects(resolve('gpt-5.6-luna'), { statusCode: 403 });
  authType = 'oauth'; agentType = 'claude'; await assert.rejects(resolve('gpt-5.6-luna', 'claude'), { statusCode: 403 });
  const catalog = { defaultModel: 'gpt-6-astra', models: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-luna@review-codex', providerProfileId: 'review-codex' }, { id: 'gpt-5.6-luna@personal', providerProfileId: 'personal' }] };
  assert.equal(filterWorkbenchModels(catalog, 'codex').models.length, 1);
  assert.equal(filterWorkbenchModels(catalog, 'codex').defaultModel, 'gpt-5.6-luna@review-codex');
  assert.deepEqual(filterWorkbenchModels(catalog, 'claude').models, []);
  const original = { method: 'turn/start', id: 1, params: { sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' } };
  const turn = constrainCodexBrokerRequest(original);
  assert.equal(turn.params.model, 'gpt-5.6-luna');
  assert.equal(turn.params.approvalPolicy, expectedApproval);
  if (policy.codexPermissionProfile) assert.equal(turn.params.sandboxPolicy, undefined);
  else assert.equal(turn.params.sandboxPolicy.type, 'readOnly');
  if (policy.codexPermissionProfile) {
    const originalExec = { method: 'command/exec', params: { command: ['true'],
      sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, permissionProfile: ':danger-full-access' } };
    const boundedExec = constrainCodexBrokerRequest(originalExec);
    for (const key of ['sandbox', 'sandboxPolicy', 'permissionProfile']) assert.equal(Object.hasOwn(boundedExec.params, key), false);
    assert.equal(originalExec.params.permissionProfile, ':danger-full-access');
    assert.throws(() => assertWorkbenchExecution({ agentType: 'codex-cli' }), { statusCode: 403 });
  }
  assert.equal(original.params.sandboxPolicy.type, 'dangerFullAccess');
  assert.throws(() => constrainCodexBrokerRequest({ method: 'turn/start', params: { model: 'gpt-6-astra' } }), { statusCode: 403 });
  assert.throws(() => constrainCodexBrokerRequest({ method: 'thread/start', params: { config: { model: 'gpt-6-astra' } } }), { statusCode: 403 });
  assert.throws(() => constrainCodexBrokerRequest({ method: 'turn/start', params: { collaborationMode: { settings: { model: 'gpt-6-astra' } } } }), { statusCode: 403 });
  assert.throws(() => constrainCodexBrokerRequest({ method: 'thread/start', params: { config: { model_providers: {} } } }), { statusCode: 403 });
  const { createNativeApiProvider, startNativeOAuthLogin, updateNativeProvider, deleteNativeProvider } = await import('../chat/native-provider-management.mjs');
  for (const action of [() => createNativeApiProvider({ payload: { agentType: 'codex', apiKey: 'public-fixture' } }),
    () => startNativeOAuthLogin({ agentType: 'codex' }), () => updateNativeProvider({ providerId: 'review-codex', payload: {} }),
    () => deleteNativeProvider({ providerId: 'review-codex' })]) await assert.rejects(action(), { statusCode: 403 });
  const { handleHarnessRoutes } = await import('../chat/router-harness-routes.mjs');
  let status, body;
  await handleHarnessRoutes({ req: { method: 'POST' }, res: { writeHead: (value) => { status = value; }, end: (value) => { body = JSON.parse(value); } }, pathname: '/api/harnesses/claude/install' });
  assert.equal(status, 403); assert.equal(body.code, 'WORKBENCH_EXECUTION_POLICY_DENIED');
  const { pickRunnerEnvAllowlist } = await import('../lib/runner-env.mjs');
  assert.equal(pickRunnerEnvAllowlist(process.env).RAGENT_WORKBENCH_EXECUTION_POLICY_FILE, process.env.RAGENT_WORKBENCH_EXECUTION_POLICY_FILE);
  // Auxiliary processes must not become an unsandboxed alternative to Codex.
  const { createManagedProcess } = await import('../chat/managed-processes.mjs');
  await assert.rejects(createManagedProcess({ sessionId: 'synthetic-denied-session',
    executable: process.execPath, args: ['-e', "process.stdout.write('must-not-run')"] }),
  { code: 'WORKBENCH_EXECUTION_POLICY_DENIED', statusCode: 403 });
  // Real broker socket/process: denial must happen before forwarding upstream.
  const { connect } = await import('node:net');
  const { once } = await import('node:events');
  const { ensureCodexAppServerBroker, codexAppServerBrokerSocketPath } = await import('../chat/codex-app-server-broker.mjs');
  const home = join(process.env.HOME, policy.codexPermissionProfile ? 'broker-profile' : 'broker');
  const upstream = join(process.env.HOME, 'echo-upstream.mjs');
  await writeFile(upstream, `import { createInterface } from 'node:readline';
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      if(m.id!==undefined) process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'owned-fixture-thread'},echo:m.params,
        upstreamEnv:{hasPath:!!process.env.PATH,codeHome:process.env.CODEX_HOME,
          controlCanaryPresent: 'RAGENT_TEST_CONTROL_CANARY' in process.env,
          lockTokenPresent: 'RAGENT_NATIVE_OAUTH_LOCK_TOKEN' in process.env}}})+'\\n');});`);
  const socketPath = codexAppServerBrokerSocketPath(home);
  const broker = await ensureCodexAppServerBroker({ socketPath, upstreamFile: process.execPath,
    upstreamArgs: [upstream], env: { ...process.env, CODEX_HOME: home,
      RAGENT_TEST_CONTROL_CANARY: 'synthetic-control-canary', RAGENT_NATIVE_OAUTH_LOCK_TOKEN: 'synthetic-lock-token' },
    lockPath: join(home, 'owned.lock') });
  let socket;
  try {
    assert.equal(broker.ok, true); assert.ok(broker.pid);
    socket = connect(socketPath); await once(socket, 'connect');
    let buffer = ''; const waiting = new Map(); let id = 10;
    socket.on('data', (chunk) => { buffer += chunk; let n;
      while ((n = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        const waiter = waiting.get(value.id); if (waiter) { waiting.delete(value.id); waiter(value); } }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id; const timer = setTimeout(() => reject(new Error('Owned broker fixture deadline')), 5000);
      waiting.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
      socket.write(JSON.stringify({ id: requestId, method, params }) + '\n');
    });
    assert.equal((await request('thread/start', { model: 'gpt-6-astra' })).error.code, -32003);
    const actualResponse = (await request('thread/start', { approvalPolicy: 'never', sandbox: 'danger-full-access' })).result;
    assert.deepEqual(actualResponse.upstreamEnv, { hasPath: true, codeHome: home, controlCanaryPresent: false, lockTokenPresent: false });
    const actual = actualResponse.echo;
    assert.equal(actual.model, 'gpt-5.6-luna'); assert.equal(actual.sandbox, policy.codexPermissionProfile ? undefined : 'read-only'); assert.equal(actual.approvalPolicy, expectedApproval);
    const actualTurn = (await request('turn/start', { threadId: 'owned-fixture-thread' })).result.echo;
    if (policy.codexPermissionProfile) assert.equal(actualTurn.sandboxPolicy, undefined);
    else assert.equal(actualTurn.sandboxPolicy.type, 'readOnly');
    assert.equal(actualTurn.model, 'gpt-5.6-luna');
    if (policy.codexPermissionProfile) {
      const actualExec = (await request('command/exec', { command: ['true'],
        sandboxPolicy: { type: 'dangerFullAccess' }, permissionProfile: ':danger-full-access' })).result.echo;
      assert.deepEqual(actualExec, { command: ['true'] });
    }
  } finally {
    socket?.destroy(); if (broker.pid) process.kill(broker.pid, 'SIGTERM');
  }
}
