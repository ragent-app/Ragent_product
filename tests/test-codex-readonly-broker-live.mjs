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
const protectedFile = join(workspace, 'protected.txt'), mcpFile = join(root, 'mcp.py');
await writeFile(protectedFile, 'original');
await writeFile(mcpFile, `import json,os,sys\nblocked=False\ntry:\n open(${JSON.stringify(protectedFile)},'w').write('changed')\nexcept OSError:\n blocked=True\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n name='blocked_and_env' if blocked and os.getenv('MCP_ACCOUNT_FIXTURE')=='present' else 'fixture_failed'\n r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}} if m.get('method')=='initialize' else {'tools':[{'name':name,'description':'fixture','inputSchema':{'type':'object'}}]}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)\n`);
const server = createServer((req, res) => {
  let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
    const value = JSON.parse(body), tool = (value.tools || []).find(item => ['shell_command', 'exec_command'].includes(item.name));
    const properties = tool?.parameters?.properties || {}, field = properties.cmd ? 'cmd' : properties.command ? 'command' : '';
    const completed = JSON.stringify(value.input).includes('function_call_output');
    const item = !completed && field ? { id: 'fixture-call', type: 'function_call', name: tool.name, call_id: 'fixture-call',
      arguments: JSON.stringify({ [field]: `printf changed > '${protectedFile}' 2>/dev/null || printf SANDBOX_WRITE_BLOCKED` }), status: 'completed' }
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
let broker, proxy, executor, setup;
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
  const turn = buildCodexAppServerTurnStartMessage({ threadId: thread.thread.id, text: 'fixture', executionEnvironment: selected.executionEnvironment });
  await request(turn.method, { ...turn.params, approvalPolicy: 'never' });
  const outcome = await Promise.race([completed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('turn timed out')), 30_000); timer.unref();
  })]);
  const output = notifications.filter(item => item.method === 'item/completed' && item.params?.item?.type === 'commandExecution')
    .map(item => item.params.item.aggregatedOutput || '').join('');
  assert.equal(outcome.status, 'completed'); assert.match(output, /SANDBOX_WRITE_BLOCKED/);
  assert.equal(await readFile(protectedFile, 'utf8'), 'original');
  console.log('test-codex-readonly-broker-live: shared broker, executor and MCP retained read-only boundary');
} finally {
  await setup?.close(); if (!setup) await executor?.stop();
  proxy?.kill(); if (broker?.pid) { try { process.kill(broker.pid, 'SIGTERM'); } catch {} }
  server.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
