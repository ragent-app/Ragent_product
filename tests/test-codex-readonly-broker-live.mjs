import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { codexAppServerBrokerLockPath, codexAppServerBrokerSocketPath, ensureCodexAppServerBroker } from '../chat/codex-app-server-broker.mjs';
import { buildCodexAppServerThreadMessage, buildCodexAppServerTurnStartMessage } from '../chat/codex-app-server-protocol.mjs';
import { startReadOnlyCodexExecutor } from '../chat/codex-readonly-executor.mjs';
import { createCodexReadOnlyEnvironmentSetup } from '../chat/codex-readonly-environment-setup.mjs';

if (process.platform !== 'linux' || process.env.AGENTOC_TEST_CODEX_EXTERNAL_EXECUTOR !== '1') {
  console.log('test-codex-readonly-broker-live: skipped (opt-in Linux integration test)');
  process.exit(0);
}
const binary = process.env.AGENTOC_TEST_CODEX_BINARY;
if (!binary?.startsWith('/')) throw new Error('An absolute AGENTOC_TEST_CODEX_BINARY is required');
const root = await mkdtemp(join(tmpdir(), 'ragent-codex-broker-'));
const workspace = join(root, 'workspace'), home = join(root, 'codex'), hidden = join(root, 'hidden');
await Promise.all([mkdir(workspace), mkdir(home), mkdir(hidden)]);
const protectedFile = join(workspace, 'protected.txt'), writableFile = join(workspace, 'writable.txt'), mcpFile = join(root, 'mcp.py');
await writeFile(protectedFile, 'original');
await writeFile(mcpFile, `import json,os,sys\nblocked=False\ntry:\n open(${JSON.stringify(protectedFile)},'w').write('changed')\nexcept OSError:\n blocked=True\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n name='blocked_and_env' if blocked and os.getenv('MCP_ACCOUNT_FIXTURE')=='present' else 'fixture_failed'\n r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}} if m.get('method')=='initialize' else {'tools':[{'name':name,'description':'fixture','inputSchema':{'type':'object'}}]}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)\n`);
const server = createServer((req, res) => {
  let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
    const value = JSON.parse(body), tool = (value.tools || []).find(item => ['shell_command', 'exec_command'].includes(item.name));
    const properties = tool?.parameters?.properties || {}, field = properties.cmd ? 'cmd' : properties.command ? 'command' : '';
    const completed = JSON.stringify(value.input).includes('function_call_output');
    const target = JSON.stringify(value.input).includes('writable-fixture') ? writableFile : protectedFile;
    const item = !completed && field ? { id: 'fixture-call', type: 'function_call', name: tool.name, call_id: 'fixture-call',
      arguments: JSON.stringify({ [field]: `printf changed > '${target}' 2>/dev/null || printf SANDBOX_WRITE_BLOCKED` }), status: 'completed' }
      : { id: 'fixture-answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
    const response = { id: 'fixture-response', object: 'response', created_at: 1, status: 'completed', model: 'gpt-5.4', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
await writeFile(join(home, 'config.toml'), `model_provider = "fixture"\nmodel = "gpt-5.4"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "FIXTURE_KEY"\n[mcp_servers.fixture]\ncommand = "/usr/bin/python3"\nargs = [${JSON.stringify(mcpFile)}]\nenv = { MCP_ACCOUNT_FIXTURE = "present" }\n`);
await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-only' } }));
const env = { ...process.env, CODEX_HOME: home, HOME: home, FIXTURE_KEY: 'fixture', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
const socket = codexAppServerBrokerSocketPath(home);
let broker, proxy, writableProxy, executor, setup;
try {
  broker = await ensureCodexAppServerBroker({ socketPath: socket, lockPath: codexAppServerBrokerLockPath(home),
    upstreamFile: binary, upstreamArgs: ['app-server'], cwd: workspace, env });
  proxy = spawn(process.execPath, [resolve('chat/codex-app-server-proxy.mjs'), '--socket', socket], { cwd: resolve('.'), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), notifications = [];
  let notify, next = 10;
  const completed = new Promise(resolveDone => { notify = resolveDone; });
  createInterface({ input: proxy.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (setup) void setup.consume(message);
    if (!message.method && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    if (message.method) notifications.push(message);
    if (message.method === 'turn/completed') notify(message.params.turn);
  });
  const send = message => { if (!proxy.stdin.writable) return false; proxy.stdin.write(`${JSON.stringify(message)}\n`); return true; };
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    const id = next++, timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    pending.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(`${method} failed: ${message.error.message || message.error.code}`)); else resolveRequest(message.result); });
    send({ id, method, params });
  });
  await request('initialize', { clientInfo: { name: 'ragent-qa', version: '1' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
  executor = await startReadOnlyCodexExecutor({ command: binary, cwd: workspace, workspace, hidePaths: [home, hidden], env });
  const ready = new Promise((resolveReady, reject) => {
    setup = createCodexReadOnlyEnvironmentSetup({ environmentId: 'ragent_run_fixture', cwd: workspace, workspace, hidePaths: [home, hidden], executor,
      nextRequestId: () => next++, send, onReady: resolveReady, onFailure: error => reject(new Error(`${error.message}: ${error.stage}`)) });
    setup.start();
  });
  const selected = await ready;
  const threadMessage = buildCodexAppServerThreadMessage({ cwd: workspace, model: 'gpt-5.4',
    executionEnvironment: selected.executionEnvironment, threadMcpConfig: selected.threadMcpConfig });
  const thread = await request(threadMessage.method, { ...threadMessage.params, modelProvider: 'fixture', approvalPolicy: 'never' });
  const mcp = await request('mcpServerStatus/list', { threadId: thread.thread.id, serverName: 'fixture' });
  assert.ok(JSON.stringify(mcp).includes('blocked_and_env'), 'scoped MCP must retain its account environment and fail to write');
  // A second connection shares the same broker while using a different
  // execution policy. Its writable turn must never inherit the first turn's
  // executor, and the isolated turn must not inherit the writable one.
  writableProxy = spawn(process.execPath, [resolve('chat/codex-app-server-proxy.mjs'), '--socket', socket],
    { cwd: resolve('.'), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const writablePending = new Map(), writableNotifications = [];
  let writableNext = 1000, writableDone;
  const writableCompleted = new Promise(resolveDone => { writableDone = resolveDone; });
  createInterface({ input: writableProxy.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (!message.method && writablePending.has(message.id)) { writablePending.get(message.id)(message); writablePending.delete(message.id); }
    if (message.method) writableNotifications.push(message);
    if (message.method === 'turn/completed') writableDone(message.params.turn);
  });
  const writableSend = message => writableProxy.stdin.write(`${JSON.stringify(message)}\n`);
  const writableRequest = (method, params) => new Promise((resolveRequest, reject) => {
    const id = writableNext++, timer = setTimeout(() => reject(new Error(`writable ${method} timed out`)), 30_000);
    writablePending.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(`writable ${method} failed`)); else resolveRequest(message.result); });
    writableSend({ id, method, params });
  });
  await writableRequest('initialize', { clientInfo: { name: 'ragent-qa-writable', version: '1' }, capabilities: { experimentalApi: true } });
  writableSend({ method: 'initialized', params: {} });
  const writableThreadMessage = buildCodexAppServerThreadMessage({ cwd: workspace, model: 'gpt-5.4',
    threadMcpConfig: { mcp_servers: { fixture: { enabled: false } } } });
  const writableThread = await writableRequest(writableThreadMessage.method,
    { ...writableThreadMessage.params, modelProvider: 'fixture', approvalPolicy: 'never' });
  const writableTurn = buildCodexAppServerTurnStartMessage({ threadId: writableThread.thread.id, text: 'writable-fixture' });
  const writableTurnStarted = writableRequest(writableTurn.method, { ...writableTurn.params, approvalPolicy: 'never' });
  const turn = buildCodexAppServerTurnStartMessage({ threadId: thread.thread.id, text: 'fixture', executionEnvironment: selected.executionEnvironment });
  const unavailable = process.env.AGENTOC_QA_STOP_EXECUTOR === '1';
  if (unavailable) await executor.stop();
  let outcome;
  try {
    await request(turn.method, { ...turn.params, approvalPolicy: 'never' });
    outcome = await Promise.race([completed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timed out')), 30_000); timer.unref();
    })]);
  } catch (error) {
    if (!unavailable || /timed out/i.test(error.message)) throw error;
    outcome = { status: 'failed' };
  }
  const output = notifications.filter(item => item.method === 'item/completed' && item.params?.item?.type === 'commandExecution')
    .map(item => item.params.item.aggregatedOutput || '').join('');
  if (unavailable) {
    const commands = notifications.filter(item => item.method === 'item/completed' && item.params?.item?.type === 'commandExecution');
    assert.ok(commands.some(item => item.params.item.status === 'failed' && item.params.item.exitCode !== 0),
      'an unavailable executor must fail the command instead of running on the broker host');
  }
  else { assert.equal(outcome.status, 'completed'); assert.match(output, /SANDBOX_WRITE_BLOCKED/); }
  await writableTurnStarted;
  const writableOutcome = await Promise.race([writableCompleted, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('writable turn timed out')), 30_000); timer.unref();
  })]);
  assert.equal(writableOutcome.status, 'completed');
  assert.equal(await readFile(writableFile, 'utf8'), 'changed', 'the writable turn must retain its own execution policy');
  assert.ok(writableNotifications.some(item => item.method === 'item/completed' && item.params?.item?.type === 'commandExecution'));
  assert.equal(await readFile(protectedFile, 'utf8'), 'original');
  console.log(`test-codex-readonly-broker-live: ${unavailable ? 'unavailable executor failed closed' : 'shared broker, executor and MCP retained read-only boundary'}`);
} finally {
  await setup?.close(); if (!setup) await executor?.stop();
  proxy?.kill(); writableProxy?.kill(); if (broker?.pid) { try { process.kill(broker.pid, 'SIGTERM'); } catch {} }
  server.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
