import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { prepareNativeRunProviderHome } from '../lib/provider-runtime/run-provider-prepare.mjs';
import { prepareControlSideNativeProvider } from '../chat/control-side-provider.mjs';
import { runCodexControlPrompt } from '../chat/codex-control-prompt.mjs';
import { ensureCodexAppServerBroker, codexAppServerBrokerSocketPath, codexAppServerBrokerLockPath } from '../chat/codex-app-server-broker.mjs';
import { acquireNativeOAuthLock, nativeOAuthLockPath } from '../lib/provider-runtime/oauth-lock.mjs';
import { dirname } from 'node:path';
import { createServer } from 'node:net';

const root = await mkdtemp(join(tmpdir(), 'agentoc-control-refresh-'));
const configDir = join(root, 'config');
const homes = join(root, 'owned-provider-homes');
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });
const pids = new Set();
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const prepare = (id, manifest, options) => prepareNativeRunProviderHome(id, manifest, { ...options, registry, secretStore });
const control = () => prepareControlSideNativeProvider({
  tool: 'codex', providerProfile: 'official', configDir, providerHomesRoot: homes, prepareProviderHome: prepare,
});
const manifest = { tool: 'codex', options: { providerProfile: 'official' } };
const fakePath = join(root, 'fake-refresh-owner.mjs');
const logPath = join(root, 'upstreams.jsonl');
const interruptPath = join(root, 'interrupts.jsonl');
let home;

async function stopOwnedBrokers() {
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await new Promise((resolve) => setTimeout(resolve, 600));
  pids.clear();
}
async function ensure() {
  const result = await ensureCodexAppServerBroker({
    socketPath: codexAppServerBrokerSocketPath(home), lockPath: codexAppServerBrokerLockPath(home),
    upstreamFile: process.execPath, upstreamArgs: [fakePath], cwd: root,
    env: { ...process.env, CODEX_HOME: home, FIXTURE_ROOT: root }, waitMs: 7000,
  });
  if (result.pid) pids.add(result.pid);
  return result;
}
const prompt = (text, timeoutMs = 3000) => runCodexControlPrompt({ codexHomeDir: home, prompt: text, cwd: root, timeoutMs, expectedAccountId:'fixture-account' });
try {
  await mkdir(configDir, { recursive: true });
  await secretStore.writeSecret('credential', {
    authType: 'oauth', tokens: { access_token: 'fixture-access-1', refresh_token: 'fixture-refresh-1', account_id: 'fixture-account', expiresAt: 1000 },
  });
  assert.equal((await registry.upsertAuthProfile({
    id: 'official-auth', agentType: 'codex', authType: 'oauth', storageType: 'secret-store', storageRef: 'credential',
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id: 'official', agentType: 'codex', protocol: 'openai-responses', authProfileId: 'official-auth',
    baseUrl: 'https://chatgpt.com/backend-api/codex', modelPolicy: { defaultModel: 'fixture-model' },
  })).ok, true);
  const front = await prepare('foreground', manifest, { configDir, providerHomesRoot: homes });
  assert.equal(front.ok, true);
  home = front.codexHomeDir;
  const background = await control();
  assert.equal(background.codexHomeDir, home, 'background must not copy rotating OAuth to a second home');
  assert.equal(background.codexBroker, true);
  assert.equal(background.codexAccountId, 'fixture-account');
  await assert.rejects(() => prompt('absent'), { code: 'CODEX_CONTROL_BROKER_REQUIRED' });
  const legacyBroker = createServer(socket => socket.once('data', () => socket.end(
    JSON.stringify({ type:'agentoc-codex-broker-pong', ready:true }) + '\n',
  )));
  await new Promise((resolve, reject) => legacyBroker.once('error', reject).listen(codexAppServerBrokerSocketPath(home), resolve));
  try { await assert.rejects(() => prompt('legacy'), { code:'CODEX_CONTROL_ACCOUNT_UNVERIFIED' }); }
  finally { await new Promise(resolve => legacyBroker.close(resolve)); }

  await writeFile(fakePath, `
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const root = process.env.FIXTURE_ROOT, path = join(process.env.CODEX_HOME, 'auth.json');
const old = JSON.parse(readFileSync(path));
const generation = Number(old.tokens.refresh_token.split('-').at(-1));
// The fake authorization server accepts each rotating refresh token once.
mkdirSync(join(root, 'consumed-' + generation));
appendFileSync(join(root, 'upstreams.jsonl'), JSON.stringify({ pid: process.pid, generation }) + '\\n');
writeFileSync(path, JSON.stringify({ tokens: { ...old.tokens, access_token: 'fixture-access-' + (generation+1),
  refresh_token: 'fixture-refresh-' + (generation+1), expiresAt: (generation+1)*1000 }, last_refresh: 'fixture-refreshed' }));
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
let count = 0;
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line), p = m.params || {};
 if (m.method === 'initialize') setTimeout(() => send({id:m.id,result:{}}), 500);
 if (m.method === 'thread/start') {
   if (p.sandbox !== 'read-only' || p.approvalPolicy !== 'never') throw Error('unsafe background policy');
   send({id:m.id,result:{thread:{id:'thread-' + (++count)}}});
 }
 if (m.method === 'turn/start') {
   const text = p.input[0].text, id='turn-' + p.threadId;
   send({id:m.id,result:{turn:{id}}});
   send({method:'turn/started',params:{threadId:p.threadId,turn:{id}}});
   send({method:'turn/completed',params:{threadId:'delegated-child',turn:{id:'unrelated',status:'completed'}}});
   setTimeout(() => {
     send({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId:id,itemId:'item-'+id,delta:text}});
     send({method:'item/completed',params:{threadId:p.threadId,turnId:id,item:{id:'item-'+id,type:'agentMessage'}}});
     send({method:'turn/completed',params:{threadId:p.threadId,turn:{id,status:'completed'}}});
   }, text === 'slow' ? 600 : 100);
 }
 if (m.method === 'turn/interrupt') appendFileSync(join(root,'interrupts.jsonl'), JSON.stringify(p)+'\\n');
});
`);
  const launchesPromise = Promise.all([ensure(), ensure()]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const preparationDuringInitialize = prepare('concurrent-prepare', manifest, { configDir, providerHomesRoot: homes });
  const launches = await launchesPromise;
  assert.equal((await preparationDuringInitialize).ok, true);
  assert.equal(launches.filter((x) => x.pid).length, 1, 'slow initialization must still have one refresh owner');
  assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(() => acquireNativeOAuthLock(nativeOAuthLockPath(dirname(home)), { waitMs: 0 }),
    { code: 'NATIVE_OAUTH_LOCK_TIMEOUT' }, 'an exclusive CLI must not refresh while the broker owns OAuth');
  const preparedWhileRunning = await control();
  await preparedWhileRunning.cleanup();
  await background.cleanup();
  assert.equal((await readJson(join(home, 'auth.json'))).tokens.refresh_token, 'fixture-refresh-2', 'cleanup/preparation must preserve the rotated generation');
  await assert.rejects(() => runCodexControlPrompt({ codexHomeDir:home, prompt:'wrong-account', cwd:root,
    timeoutMs:3000, expectedAccountId:'other-account' }), { code:'CODEX_CONTROL_ACCOUNT_UNVERIFIED' });
  const replies = await Promise.all([prompt('foreground-equivalent'), prompt('background-title')]);
  assert.deepEqual(replies.map((x) => x.text), ['foreground-equivalent', 'background-title']);
  const [slow, fast] = await Promise.allSettled([prompt('slow', 100), prompt('still-alive')]);
  assert.equal(slow.status, 'rejected');
  assert.match(slow.reason.message, /timed out/);
  assert.equal(fast.value.text, 'still-alive', 'one caller timeout must not kill the shared provider');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const interrupts = (await readFile(interruptPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].turnId, `turn-${interrupts[0].threadId}`);

  await stopOwnedBrokers();
  assert.equal((await prepare('foreground-restart', manifest, { configDir, providerHomesRoot: homes })).ok, true);
  const restart = await control();
  assert.equal((await secretStore.resolveSecret('credential')).tokens.refresh_token, 'fixture-refresh-2', 'broker rotation must be reconciled into the vault before restart');
  await ensure();
  assert.equal((await prompt('after-restart')).text, 'after-restart');
  await restart.cleanup();
  assert.equal((await readJson(join(home, 'auth.json'))).tokens.refresh_token, 'fixture-refresh-3');
  assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, 2);
  console.log('PASS: canonical OAuth home, one slow-start owner, concurrent private threads, scoped timeout, rotation survives cleanup/restart');
} finally {
  await stopOwnedBrokers();
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 39) throw error; await new Promise((r) => setTimeout(r, 100)); }
  }
}
