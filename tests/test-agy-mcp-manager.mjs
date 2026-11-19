#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-mcp-manager-'));
const configDir = join(root, 'config');
const mcpHome = join(root, 'agy-mcp-home');
const providerHomesRoot = join(root, 'provider-homes');

process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_AGY_MCP_HOME_DIR = mcpHome;

const {
  AGY_MCP_CONFIG_RELATIVE_PATH,
  addAgyMcpServer,
  isReservedRagentMcpName,
  listAgyMcpServers,
  removeAgyMcpServer,
  resolveAgyMcpConfigFile,
  resolveAuthorizedAgyExternalMcpServers,
  setAgyMcpServerEnabled,
} = await import('../lib/agy-mcp-manager.mjs');
const { handleAgyRoutes } = await import('../chat/router-agy-routes.mjs');
const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const {
  prepareNativeRunProviderHome,
  resolveNativeSelectionFromManifest,
} = await import('../lib/provider-runtime/run-provider-prepare.mjs');
const { AGY_AUTH_RELATIVE_PATH } = await import('../lib/agy-runtime.mjs');

async function callAgyRoute(options) {
  const { method, pathname, body = undefined, headers = {} } = options;
  const authSession = Object.hasOwn(options, 'authSession') ? options.authSession : { role: 'owner' };
  const chunks = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = headers;
  let result = null;
  const handled = await handleAgyRoutes({
    req,
    res: {},
    pathname,
    authSession,
    writeJson: (_res, status, data) => {
      result = { status, data };
    },
  });
  return { handled, result };
}

try {
  // 1. Manager CRUD & validation invariants
  assert.equal(isReservedRagentMcpName('ragent_organization'), true);
  assert.equal(isReservedRagentMcpName('ragent-browser'), true);
  assert.equal(isReservedRagentMcpName('ragent'), true);
  assert.equal(isReservedRagentMcpName('my-docs'), false);

  const sseRejected = await addAgyMcpServer({
    name: 'legacy_sse',
    type: 'sse',
    url: 'https://legacy.example.invalid/sse',
  });
  assert.equal(sseRejected.ok, false);
  assert.equal(sseRejected.code, 'AGY_MCP_UNSUPPORTED_TRANSPORT');
  assert.match(sseRejected.error, /SSE/i);

  const sseFlagRejected = await addAgyMcpServer({
    name: 'legacy_sse_flag',
    sse: true,
    url: 'https://legacy.example.invalid/sse',
  });
  assert.equal(sseFlagRejected.ok, false);
  assert.equal(sseFlagRejected.code, 'AGY_MCP_UNSUPPORTED_TRANSPORT');

  for (const reserved of ['ragent_actions', 'ragent-browser', 'ragent']) {
    const res = await addAgyMcpServer({ name: reserved, command: 'node', args: ['x.mjs'] });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'AGY_MCP_RESERVED_NAME');
  }

  const badUrlCreds = await addAgyMcpServer({ name: 'bad_url', url: 'https://user:secret@example.invalid/mcp' });
  assert.equal(badUrlCreds.ok, false);
  assert.equal(badUrlCreds.code, 'AGY_MCP_INVALID_URL');

  const badEnv = await addAgyMcpServer({
    name: 'spoof_env',
    command: 'node',
    args: ['srv.mjs'],
    env: { RAGENT_APPROVED_ACTIONS_TOKEN: 'spoof' },
  });
  assert.equal(badEnv.ok, false);
  assert.equal(badEnv.code, 'AGY_MCP_RESERVED_ENV');

  const addedStdio = await addAgyMcpServer({
    name: 'localTool',
    command: process.execPath,
    args: ['tool.mjs'],
    env: { API_SECRET: 'stdio-secret-val' },
  });
  assert.equal(addedStdio.ok, true);
  assert.deepEqual(addedStdio.server.envKeys, ['API_SECRET']);
  assert.ok(!JSON.stringify(addedStdio).includes('stdio-secret-val'));

  const addedHttp = await addAgyMcpServer({
    name: 'docs',
    type: 'http',
    url: 'https://docs.example.invalid/mcp',
    headers: { Authorization: 'Bearer http-secret-val' },
  });
  assert.equal(addedHttp.ok, true);
  assert.equal(addedHttp.server.type, 'http');
  assert.deepEqual(addedHttp.server.headerKeys, ['Authorization']);
  assert.ok(!JSON.stringify(addedHttp).includes('http-secret-val'));

  const diskConfig = JSON.parse(await readFile(resolveAgyMcpConfigFile(), 'utf8'));
  assert.equal(diskConfig.mcpServers.docs.serverUrl, 'https://docs.example.invalid/mcp');
  assert.equal(diskConfig.mcpServers.localTool.command, process.execPath);

  const listed = await listAgyMcpServers();
  assert.equal(listed.ok, true);
  assert.equal(listed.servers.length, 2);
  assert.ok(!JSON.stringify(listed).includes('stdio-secret-val'));
  assert.ok(!JSON.stringify(listed).includes('http-secret-val'));

  // 2. Owner-authenticated /api/agy/mcp-servers routes
  for (const deniedAuth of [
    null,
    { role: 'visitor' },
    { role: 'owner', principalKind: 'run_capability' },
    { role: 'owner', principalKind: 'provisional_device' },
    { role: 'owner', principalKind: 'temporary_device' },
  ]) {
    const rGet = await callAgyRoute({ method: 'GET', pathname: '/api/agy/mcp-servers', authSession: deniedAuth });
    assert.equal(rGet.handled, true);
    assert.equal(rGet.result.status, 403);
    const rPost = await callAgyRoute({
      method: 'POST', pathname: '/api/agy/mcp-servers', authSession: deniedAuth, body: { name: 'x', command: 'node' },
    });
    assert.equal(rPost.result.status, 403);
  }
  // Fallback when authSession is omitted by router.mjs: narrow run tokens still fail closed
  const runHeaderDenied = await callAgyRoute({
    method: 'GET',
    pathname: '/api/agy/mcp-servers',
    authSession: undefined,
    headers: { 'x-ragent-session-control-token': 'scoped-run-token' },
  });
  assert.equal(runHeaderDenied.handled, true);
  assert.equal(runHeaderDenied.result.status, 403);

  const routeList = await callAgyRoute({ method: 'GET', pathname: '/api/agy/mcp-servers' });
  assert.equal(routeList.result.status, 200);
  assert.equal(routeList.result.data.servers.length, 2);
  assert.ok(!JSON.stringify(routeList).includes('http-secret-val'));

  const routeSse = await callAgyRoute({
    method: 'POST', pathname: '/api/agy/mcp-servers', body: { name: 'bad', type: 'sse', url: 'https://e.invalid/sse' },
  });
  assert.equal(routeSse.result.status, 400);
  assert.equal(routeSse.result.data.code, 'AGY_MCP_UNSUPPORTED_TRANSPORT');

  const routeAdd = await callAgyRoute({
    method: 'POST', pathname: '/api/agy/mcp-servers',
    body: { name: 'viaRoute', url: 'https://route.example.invalid/mcp', headers: { 'X-Key': 'route-secret' } },
  });
  assert.equal(routeAdd.result.status, 200);
  assert.ok(!JSON.stringify(routeAdd).includes('route-secret'));

  const routeDisable = await callAgyRoute({
    method: 'PATCH', pathname: '/api/agy/mcp-servers/viaRoute', body: { disabled: true },
  });
  assert.equal(routeDisable.result.status, 200);
  assert.equal(routeDisable.result.data.server.disabled, true);

  const routeDelete = await callAgyRoute({ method: 'DELETE', pathname: '/api/agy/mcp-servers/viaRoute' });
  assert.equal(routeDelete.result.status, 200);

  const routeMissingDelete = await callAgyRoute({ method: 'DELETE', pathname: '/api/agy/mcp-servers/viaRoute' });
  assert.equal(routeMissingDelete.result.status, 404);

  assert.equal((await addAgyMcpServer({ name: 'directRemove', command: 'node', args: ['a.mjs'] })).ok, true);
  assert.equal((await removeAgyMcpServer({ name: 'directRemove' })).ok, true);
  assert.equal((await removeAgyMcpServer({ name: 'directRemove' })).code, 'AGY_MCP_NOT_FOUND');

  // Also test authorized external server filtering helper directly
  await setAgyMcpServerEnabled({ name: 'localTool', disabled: false });
  const emptyFailClosed = await resolveAuthorizedAgyExternalMcpServers({ agyHomeDir: mcpHome });
  assert.equal(emptyFailClosed.servers.length, 0, 'Without explicit allowlist/flag, must fail closed');

  // Inject rogue reserved + SSE entries directly into disk mcp_config.json to test defense-in-depth filtering
  const rawDisk = JSON.parse(await readFile(resolveAgyMcpConfigFile(), 'utf8'));
  rawDisk.mcpServers.ragent_actions_hijack = { command: 'node', args: ['evil.mjs'], disabled: false };
  rawDisk.mcpServers.raw_sse = { type: 'sse', url: 'https://raw.invalid/sse', disabled: false };
  await writeFile(resolveAgyMcpConfigFile(), JSON.stringify(rawDisk, null, 2), 'utf8');

  // 3. run-provider-prepare.mjs: persistent session storage + controlled external MCP pass-through
  assert.equal(resolveNativeSelectionFromManifest({
    tool: 'agy', options: { runtimeFamily: 'agy-acp' },
  }).agentType, 'agy');

  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  for (const [id, tok] of [['agy-main', 'main-oauth-token'], ['agy-other', 'other-oauth-token']]) {
    await secretStore.writeSecret(`${id}-sec`, { authType: 'oauth', tokens: { tokenFile: tok } });
    await registry.upsertAuthProfile({ id: `${id}-auth`, agentType: 'agy', authType: 'oauth', displayName: id, storageType: 'secret-store', storageRef: `${id}-sec` });
    await registry.upsertProviderProfile({ id, agentType: 'agy', protocol: 'agy', displayName: id, baseUrl: '', authProfileId: `${id}-auth` });
  }

  const run1 = await prepareNativeRunProviderHome('run-session-1', {
    tool: 'agy',
    sessionId: 'sess-persistent-1',
    options: {
      runtimeFamily: 'agy-acp',
      providerProfile: 'agy-main',
      authorizedExternalMcpServers: ['docs', 'localTool', 'ragent_actions_hijack', 'raw_sse'],
    },
  }, { configDir, providerHomesRoot, externalOAuthOwnership: false });

  assert.equal(run1.ok, true, run1.error || run1.reason);
  assert.ok(run1.agySessionStorageDir);
  assert.deepEqual(run1.authorizedExternalMcpNames, ['localTool', 'docs']);
  assert.ok(!JSON.stringify(run1).includes('stdio-secret-val'));
  assert.ok(!JSON.stringify(run1).includes('http-secret-val'));
  assert.equal(
    (await readFile(join(run1.agyHomeDir, AGY_AUTH_RELATIVE_PATH), 'utf8')).trim(),
    'main-oauth-token',
  );
  const run1Mcp = JSON.parse(await readFile(join(run1.agyHomeDir, AGY_MCP_CONFIG_RELATIVE_PATH), 'utf8'));
  assert.deepEqual(Object.keys(run1Mcp.mcpServers).sort(), ['docs', 'localTool']);
  assert.equal(run1Mcp.mcpServers.ragent_actions_hijack, undefined);
  assert.equal(run1Mcp.mcpServers.raw_sse, undefined);

  // Persist a synthetic conversation file inside run1's bound app-data storage and verify run2 (same session & account) sees it!
  await mkdir(join(run1.agyAppDataDir, 'conversations'), { recursive: true });
  await writeFile(join(run1.agyAppDataDir, 'conversations', 'conv-123.pb'), 'persisted-conversation-data', 'utf8');

  const run2 = await prepareNativeRunProviderHome('run-session-2', {
    tool: 'agy',
    sessionId: 'sess-persistent-1',
    options: {
      runtimeFamily: 'agy-stream-json',
      providerProfile: 'agy-main',
    },
  }, { configDir, providerHomesRoot, externalOAuthOwnership: false });

  assert.equal(run2.ok, true);
  assert.notEqual(run2.agyHomeDir, run1.agyHomeDir, 'Distinct Run homes');
  assert.equal(run2.agySessionStorageDir, run1.agySessionStorageDir, 'Same session + provider binds same persistent storage dir');
  assert.equal(
    await readFile(join(run2.agyAppDataDir, 'conversations', 'conv-123.pb'), 'utf8'),
    'persisted-conversation-data',
    'Resumed run accesses persisted session conversation storage',
  );
  assert.equal(
    existsSync(join(run2.agyHomeDir, AGY_MCP_CONFIG_RELATIVE_PATH)),
    false,
    'Without explicit authorization, Run 2 receives NO external MCP servers',
  );

  // Different provider profile with same sessionId must stay strictly isolated
  const runOtherAccount = await prepareNativeRunProviderHome('run-other-acct', {
    tool: 'agy',
    sessionId: 'sess-persistent-1',
    options: { runtimeFamily: 'agy-acp', providerProfile: 'agy-other' },
  }, { configDir, providerHomesRoot, externalOAuthOwnership: false });
  assert.notEqual(runOtherAccount.agySessionStorageDir, run1.agySessionStorageDir);
  assert.equal(existsSync(join(runOtherAccount.agyAppDataDir, 'conversations', 'conv-123.pb')), false);

  // Delegated child run must NOT inherit authorizedExternalMcpServers / allowedExternalMcpServers / externalAgyMcpServers
  const runDelegatedDenied = await prepareNativeRunProviderHome('run-delegated-child', {
    tool: 'agy',
    organizationId: 'org-1',
    parentRunId: 'run-session-1',
    sessionId: 'sess-child-1',
    options: {
      runtimeFamily: 'agy-acp',
      providerProfile: 'agy-main',
      authorizedExternalMcpServers: ['docs', 'localTool'],
      allowedExternalMcpServers: ['docs'],
      externalAgyMcpServers: [{ name: 'unapprovedChildTool', command: 'node', args: ['x.js'] }],
    },
  }, { configDir, providerHomesRoot, externalOAuthOwnership: false });
  assert.equal(runDelegatedDenied.ok, true);
  assert.equal(runDelegatedDenied.authorizedExternalMcpNames, undefined);
  assert.equal(existsSync(join(runDelegatedDenied.agyHomeDir, AGY_MCP_CONFIG_RELATIVE_PATH)), false);

  // Delegated child run receives ONLY servers explicitly approved via delegatedApprovedExternalMcpServers
  const runDelegatedApproved = await prepareNativeRunProviderHome('run-delegated-child-approved', {
    tool: 'agy',
    organizationId: 'org-1',
    parentRunId: 'run-session-1',
    sessionId: 'sess-child-2',
    options: {
      runtimeFamily: 'agy-acp',
      providerProfile: 'agy-main',
      authorizedExternalMcpServers: ['docs', 'localTool'],
      delegatedApprovedExternalMcpServers: ['docs'],
    },
  }, { configDir, providerHomesRoot, externalOAuthOwnership: false });
  assert.equal(runDelegatedApproved.ok, true);
  assert.deepEqual(runDelegatedApproved.authorizedExternalMcpNames, ['docs']);
  const childMcp = JSON.parse(await readFile(join(runDelegatedApproved.agyHomeDir, AGY_MCP_CONFIG_RELATIVE_PATH), 'utf8'));
  assert.deepEqual(Object.keys(childMcp.mcpServers), ['docs']);

  // 4. Unified canonical default (WITHOUT RAGENT_AGY_MCP_HOME_DIR): route -> catalog -> instructions -> run-prepare
  const canonicalRoot = join(root, 'canonical-default-test');
  const canonicalConfig = join(canonicalRoot, 'config');
  const canonicalWs = join(canonicalRoot, 'ws');
  const canonicalHomes = join(canonicalRoot, 'homes');
  await mkdir(canonicalConfig, { recursive: true });
  await mkdir(canonicalWs, { recursive: true });
  const childEnv = { ...process.env, RAGENT_CONFIG_DIR: canonicalConfig };
  delete childEnv.RAGENT_AGY_MCP_HOME_DIR;
  delete childEnv.RAGENT_AGY_HOME_DIR;
  delete childEnv.RAGENT_AGY_GEMINI_DIR;

  const childScript = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { Readable } from 'node:stream';
    import { AGY_CONTROL_HOME_DIR } from './lib/config.mjs';
    import { resolveAgyMcpHomeDir, resolveAgyMcpConfigFile, AGY_MCP_CONFIG_RELATIVE_PATH } from './lib/agy-mcp-manager.mjs';
    import { handleAgyRoutes } from './chat/router-agy-routes.mjs';
    import { listHarnessCapabilities, resolveHarnessCapabilityInstructions } from './chat/harness-capability-catalog.mjs';
    import { createNativeProviderRegistry } from './lib/provider-runtime/registry.mjs';
    import { createSecretStore } from './lib/provider-runtime/secret-store.mjs';
    import { prepareNativeRunProviderHome } from './lib/provider-runtime/run-provider-prepare.mjs';

    const cfgDir = ${JSON.stringify(canonicalConfig)};
    const ws = ${JSON.stringify(canonicalWs)};
    const homes = ${JSON.stringify(canonicalHomes)};
    assert.equal(resolveAgyMcpHomeDir(), AGY_CONTROL_HOME_DIR);

    const postReq = Readable.from([JSON.stringify({ name: 'canonicalDocs', url: 'https://canonical.invalid/mcp', headers: { Authorization: 'Bearer tok' } })]);
    postReq.method = 'POST';
    postReq.headers = {};
    let postRes;
    await handleAgyRoutes({
      req: postReq, res: {}, pathname: '/api/agy/mcp-servers', authSession: { role: 'owner' },
      writeJson: (_r, s, d) => { postRes = { s, d }; },
    });
    assert.equal(postRes.s, 200);
    assert.equal(resolveAgyMcpConfigFile(), join(AGY_CONTROL_HOME_DIR, AGY_MCP_CONFIG_RELATIVE_PATH));

    const catalog = await listHarnessCapabilities({ session: { tool: 'agy-acp' }, cwd: ws, platformSkillsDir: '' });
    const entry = catalog.items.find((i) => i.title === 'canonicalDocs');
    assert.ok(entry, 'Route-added MCP server discovered via canonical default AGY_CONTROL_HOME_DIR');
    const instructions = await resolveHarnessCapabilityInstructions({
      ids: [entry.id], session: { tool: 'agy-acp' }, cwd: ws, platformSkillsDir: '',
    });
    assert.match(instructions, /canonicalDocs/);

    const reg = createNativeProviderRegistry({ configDir: cfgDir });
    const sec = createSecretStore({ configDir: cfgDir });
    await sec.writeSecret('c-sec', { authType: 'oauth', tokens: { tokenFile: 'c-tok' } });
    await reg.upsertAuthProfile({ id: 'c-auth', agentType: 'agy', authType: 'oauth', displayName: 'c', storageType: 'secret-store', storageRef: 'c-sec' });
    await reg.upsertProviderProfile({ id: 'c-prof', agentType: 'agy', protocol: 'agy', displayName: 'c', baseUrl: '', authProfileId: 'c-auth' });

    const prep = await prepareNativeRunProviderHome('run-canonical', {
      tool: 'agy', sessionId: 's-canonical',
      options: { runtimeFamily: 'agy-acp', providerProfile: 'c-prof', authorizedExternalMcpServers: ['canonicalDocs'] },
    }, { configDir: cfgDir, providerHomesRoot: homes, externalOAuthOwnership: false });
    assert.equal(prep.ok, true, prep.error || prep.reason);
    assert.deepEqual(prep.authorizedExternalMcpNames, ['canonicalDocs']);
    const runMcp = JSON.parse(await readFile(join(prep.agyHomeDir, AGY_MCP_CONFIG_RELATIVE_PATH), 'utf8'));
    assert.equal(runMcp.mcpServers.canonicalDocs.serverUrl, 'https://canonical.invalid/mcp');
  `;
  const repoRoot = join(import.meta.dirname, '..');
  await execFileAsync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: repoRoot,
    env: childEnv,
  });

  console.log('test-agy-mcp-manager: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
