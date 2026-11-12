import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const root = await mkdtemp(join(tmpdir(), 'ragent-codex-mcp-scope-'));
process.env.AGENTOC_CONFIG_DIR = root;
const { handleCodexMcpRoutes } = await import('../chat/router-codex-mcp-routes.mjs');
const { managedCodexMcpAccountBinding, readManagedCodexMcpConfig, withManagedCodexMcpLock } = await import('../lib/provider-runtime/codex-mcp-config.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
await mkdir(join(root, 'native-provider-runtime'), { recursive: true });
await writeFile(join(root, 'native-provider-runtime', 'providers.json'), JSON.stringify({ profiles: [
  { id: 'profile-a', agentType: 'codex', protocol: 'openai-responses', authProfileId: 'auth-a', baseUrl: 'https://example.invalid' },
  { id: 'profile-b', agentType: 'codex', protocol: 'openai-responses', authProfileId: 'auth-b', baseUrl: 'https://example.invalid' },
] }));
await writeFile(join(root, 'native-provider-runtime', 'auth-profiles.json'), JSON.stringify({ profiles: [
  { id: 'auth-a', agentType: 'codex', authType: 'oauth', storageRef: 'secret-a' },
  { id: 'auth-b', agentType: 'codex', authType: 'oauth', storageRef: 'secret-b' },
] }));
const secrets = createSecretStore({ configDir: root });
const accountA = { authType: 'oauth', tokens: { account_id: 'account-a', access_token: 'fixture' } };
assert.equal(managedCodexMcpAccountBinding({ authType: 'oauth', tokens: { user_id: 'same-user' } }), '', 'a user id alone must not merge workspace state');
await secrets.writeSecret('secret-a', accountA);
await secrets.writeSecret('secret-b', { authType: 'oauth', tokens: { account_id: 'account-b', access_token: 'fixture' } });

async function request(method, pathname, body, role = 'owner') {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  let response;
  const handled = await handleCodexMcpRoutes({ req, res: {}, pathname, authSession: { role },
    writeJson: (_res, status, data) => { response = { status, data }; } });
  assert.equal(handled, true);
  return response;
}

try {
  const base = '/api/providers/profile-a/codex/mcp-servers';
  const pluginA = '/api/providers/profile-a/codex/plugin-preference';
  const pluginB = '/api/providers/profile-b/codex/plugin-preference';
  const syncA = '/api/providers/profile-a/codex/capability-sync';
  const syncB = '/api/providers/profile-b/codex/capability-sync';
  const policyA = '/api/providers/profile-a/codex/capability-sync-policy';
  assert.equal((await request('POST', syncA, undefined, 'visitor')).status, 403);
  assert.equal((await request('POST', syncA)).data.sync.status, 'waiting_for_runtime');
  assert.equal((await request('GET', syncA)).data.sync.capabilities.plugins, 'unsupported');
  assert.equal((await request('GET', syncB)).data.sync, null);
  assert.equal((await request('GET', policyA)).data.mode, 'approved-auto');
  assert.equal((await request('POST', policyA, { mode: 'manual' }, 'visitor')).status, 403);
  assert.equal((await request('POST', policyA, { mode: 'invalid' })).status, 400);
  assert.equal((await request('POST', policyA, { mode: 'disabled' })).data.mode, 'disabled');
  assert.equal((await request('POST', syncA)).data.code, 'CODEX_SYNC_DISABLED');
  assert.equal((await request('GET', syncA)).data.sync, null);
  assert.equal((await request('POST', policyA, { mode: 'manual' })).data.mode, 'manual');
  assert.equal((await request('POST', pluginA, { enabled: true }, 'visitor')).status, 403);
  assert.equal((await request('POST', pluginA, { enabled: 'true' })).status, 400);
  assert.equal((await request('GET', pluginA)).data.desiredEnabled, false);
  assert.equal((await request('POST', pluginA, { enabled: true })).data.effectiveEnabled, null);
  assert.equal((await request('GET', pluginB)).data.desiredEnabled, false, 'different accounts must not inherit Plugin preferences');
  assert.equal((await request('POST', base, { name: 'drive', url: 'https://example.invalid/mcp' }, 'visitor')).status, 403);
  assert.equal((await request('POST', base, { name: 'bad', url: 'https://example.invalid/mcp?token=secret' })).status, 400);
  assert.equal((await request('POST', base, { name: 'bad', command: 'node', env: { TOKEN: 'secret' } })).status, 400);
  const added = await request('POST', base, { name: 'docs', url: 'https://example.invalid/mcp' });
  assert.equal(added.status, 200, JSON.stringify(added));
  // Hold the account configuration lock while the request advances past its
  // initial account resolution; switch accounts before releasing the lock.
  let lockAcquired, releaseLock;
  const locked = new Promise((resolve) => { lockAcquired = resolve; });
  const unlocked = new Promise((resolve) => { releaseLock = resolve; });
  const holder = withManagedCodexMcpLock(root, 'profile-a', managedCodexMcpAccountBinding(accountA), async () => {
    lockAcquired(); await unlocked;
  });
  await locked;
  let bodyRequested;
  const bodyStarted = new Promise((resolve) => { bodyRequested = resolve; });
  let releaseBody;
  const bodyReleased = new Promise((resolve) => { releaseBody = resolve; });
  const delayedReq = Readable.from((async function* () {
    bodyRequested(); await bodyReleased;
    yield JSON.stringify({ name: 'stale', url: 'https://example.invalid/stale' });
  })());
  delayedReq.method = 'POST';
  let delayedResponse;
  const delayed = handleCodexMcpRoutes({ req: delayedReq, res: {}, pathname: base, authSession: { role: 'owner' },
    writeJson: (_res, status, data) => { delayedResponse = { status, data }; } });
  await bodyStarted;
  try {
    releaseBody();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(delayedResponse, undefined, 'request must not write while the account lock is held');
    await secrets.writeSecret('secret-a', { authType: 'oauth', tokens: { account_id: 'changed-account', access_token: 'fixture' } });
  } finally { releaseBody(); releaseLock(); }
  await holder;
  await delayed;
  assert.equal(delayedResponse.status, 409);
  assert.equal(delayedResponse.data.code, 'CODEX_MCP_ACCOUNT_CHANGED');
  await secrets.writeSecret('secret-a', accountA);
  assert.doesNotMatch(await readManagedCodexMcpConfig(root, 'profile-a', managedCodexMcpAccountBinding(accountA)), /mcp_servers\.stale/);
  assert.match(await readManagedCodexMcpConfig(root, 'profile-a', managedCodexMcpAccountBinding(accountA)), /\[mcp_servers\.docs\]/);
  assert.match(await readManagedCodexMcpConfig(root, 'profile-b', managedCodexMcpAccountBinding(accountA)), /\[mcp_servers\.docs\]/, 'profiles for the same account must share a configuration');
  const list = await request('GET', base);
  assert.equal(list.status, 200);
  assert.equal(list.data.servers[0].name, 'docs');
  assert.equal(JSON.stringify(list).includes('example.invalid'), false);
  await secrets.writeSecret('secret-b', accountA);
  assert.equal((await request('GET', pluginB)).data.desiredEnabled, true, 'profiles of the same account share Plugin preference');
  assert.equal((await request('GET', '/api/providers/profile-b/codex/capability-sync-policy')).data.mode, 'manual', 'profiles of the same account share synchronization policy');
  const concurrent = await Promise.all([
    request('POST', base, { name: 'first', url: 'https://example.invalid/first' }),
    request('POST', '/api/providers/profile-b/codex/mcp-servers', { name: 'second', url: 'https://example.invalid/second' }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status), [200, 200]);
  assert.deepEqual((await request('GET', base)).data.servers.map((server) => server.name).sort(), ['docs', 'first', 'second']);
  assert.equal((await request('DELETE', `${base}/first`)).status, 200);
  assert.equal((await request('DELETE', `${base}/second`)).status, 200);
  await secrets.writeSecret('secret-b', { authType: 'oauth', tokens: { account_id: 'account-b', access_token: 'fixture' } });
  await secrets.writeSecret('secret-a', { authType: 'oauth', tokens: { account_id: 'another-account', access_token: 'fixture' } });
  const switched = await request('GET', base);
  assert.equal(switched.status, 200);
  assert.deepEqual(switched.data.servers, [], 'a switched account starts with its own empty MCP configuration');
  assert.equal(await readManagedCodexMcpConfig(root, 'profile-a', managedCodexMcpAccountBinding({ authType: 'oauth', tokens: { account_id: 'another-account' } })), '');
  assert.equal((await request('POST', base, { name: 'second', url: 'https://example.invalid/other' })).status, 200);
  await secrets.writeSecret('secret-a', accountA);
  assert.deepEqual((await request('GET', base)).data.servers.map((server) => server.name), ['docs']);
  assert.equal((await request('DELETE', `${base}/docs`)).status, 200);
  assert.doesNotMatch(await readManagedCodexMcpConfig(root, 'profile-a', managedCodexMcpAccountBinding(accountA)), /\[mcp_servers\.docs\]/);
  console.log('Codex provider-scoped MCP tests passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
