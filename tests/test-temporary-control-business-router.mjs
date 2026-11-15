import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[2] !== '--worker') {
  const root = await mkdtemp(join(tmpdir(), 'ragent-control-business-'));
  try {
    const importHook = process.env.RAGENT_CONTROL_ROUTER_IMPORT_HOOK;
    const child = spawn(process.execPath, [...(importHook ? ['--import', pathToFileURL(resolve(importHook)).href] : []),
      fileURLToPath(import.meta.url), '--worker', root], { windowsHide: true,
      env: { ...process.env, RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1', RAGENT_INSTANCE_ROOT: root,
        RAGENT_CONFIG_DIR: join(root, 'config'), RAGENT_MEMORY_DIR: join(root, 'memory'),
        RAGENT_RUN_SPOOL_DIR: join(root, 'data', 'chat-runs'), RAGENT_WORK_ROOT_DIR: join(root, 'workspace'),
        RAGENT_PROVIDER_HOMES_DIR: join(root, 'provider-homes'), RAGENT_HARNESS_ROOT: join(root, 'harnesses'),
        RAGENT_PACKAGED_HARNESS_ROOT: join(root, 'bundled-harnesses'),
        RAGENT_INSTANCE_KEY_FILE: join(root, 'config', 'instance-identity.json'),
        RAGENT_AUTH_SESSION_SECRET: 'temporary-control-business-test-session-secret',
        RAGENT_ACCOUNTS_URL: 'https://accounts.invalid', RAGENT_TURN_BROKER_URL: '',
        RAGENT_WINDOWS_SERVICE_MODE: '0', RAGENT_TEMPORARY_PAIRING_ENABLED: '1' } });
    let output = ''; child.stdout.on('data', (value) => { output += value; }); child.stderr.on('data', (value) => { output += value; });
    const timer = setTimeout(() => child.kill(), 60_000);
    const code = await new Promise((done, reject) => { child.on('error', reject); child.on('exit', done); }); clearTimeout(timer);
    assert.equal(code, 0, output); assert.match(output, /business-router-verified/);
    console.log('test-temporary-control-business-router: passed (real signed grant and production business handlers)');
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('ragent-control-business-'));
    await rm(root, { recursive: true, force: true });
  }
} else {
  try { await worker(); process.exit(0); } catch (error) { console.error(error); process.exit(1); }
}

async function worker() {
  const root = process.argv[3];
  const installerCalls = await prepareHarnessInstaller(root);
  // Any attempted external call is a fixture failure. All business state remains in root.
  const networkFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'isolated business test must not contact external accounts/providers');
    return networkFetch(url, options);
  };
  const { getTemporaryControlRegistry, getTemporaryControlHost, getTemporaryControlCarrierIngress } = await import('../chat/temporary-control-runtime.mjs');
  const { buildTemporaryControlClaimMessage, temporaryControlInvitationDigest } = await import('../lib/temporary-control-protocol.mjs');
  const { temporaryDeviceJwk } = await import('../lib/temporary-device-access.mjs');
  const { TEMPORARY_CONTROL_CARRIER_ORIGIN } = await import('../lib/temporary-control-routes.mjs');
  const { CONFIG_DIR, INSTANCE_ROOT } = await import('../lib/config.mjs');
  assert.equal(resolve(INSTANCE_ROOT), resolve(root)); assert.equal(resolve(CONFIG_DIR), resolve(join(root, 'config')));
  const registry = await getTemporaryControlRegistry(); const host = await getTemporaryControlHost();
  const ticket = await registry.create(); const invitation = ticket.envelope.invitation;
  const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = device.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const claim = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(invitation), requestId: `rtr_${randomBytes(18).toString('hex')}`,
    devicePublicKey: publicKey, token: ticket.token };
  claim.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(claim)), device.privateKey).toString('base64url');
  await registry.claim(claim); const active = await registry.confirm(invitation.invitationId);
  const credential = await host.credentialForGrant(active.grant.grantId);
  const ingress = await getTemporaryControlCarrierIngress({ instanceId: invitation.instanceId,
    grantId: active.grant.grantId, deviceId: active.grant.deviceId, accessExpiresAt: active.accessExpiresAt });
  const { handleRequest } = await import('../chat/router.mjs');
  const server = createServer((req, res) => { void (req.url.startsWith('/api/target-runtime/')
    ? handleRequest(req, res) : ingress(req, res)).catch((error) => {
    console.error(error); if (!res.headersSent) res.writeHead(500); res.end();
  }); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const prefix = `/api/temporary-control/v1/instances/${invitation.instanceId}`;
  async function api(method, path, body, expected = 200) {
    const route = prefix + path;
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ typ: 'dpop+jwt', alg: 'ES256', jwk: temporaryDeviceJwk(publicKey).jwk })}.${encode({
      jti: randomBytes(24).toString('base64url'), htm: method, htu: TEMPORARY_CONTROL_CARRIER_ORIGIN + route.split('?')[0],
      iat: Math.floor(Date.now() / 1000), ath: createHash('sha256').update(credential.access_token).digest('base64url') })}`;
    const proof = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { Authorization: `DPoP ${credential.access_token}`, DPoP: proof, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    assert.equal(response.headers.get('set-cookie'), null, 'temporary business requests must not create an Owner cookie');
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`); return result;
  }
  try {
    // Exercise the full dispatch order: the remote gateway must not swallow
    // this local endpoint, and its normal Owner authorization must still run.
    const { issueSession, setCookie, setVisitorCookie } = await import('../lib/auth.mjs');
    const ownerCookie = setCookie(await issueSession({ role: 'owner' })).split(';')[0];
    const contextUrl = `http://127.0.0.1:${server.address().port}/api/target-runtime/context`;
    const contextResponse = await fetch(contextUrl, { headers: { Cookie: ownerCookie } });
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.target.instanceId, invitation.instanceId);
    const visitorCookie = setVisitorCookie(await issueSession({ role: 'visitor' })).split(';')[0];
    assert.equal((await fetch(contextUrl, { headers: { Cookie: visitorCookie } })).status, 403);
    assert.equal((await fetch(contextUrl, { method: 'POST', headers: { Cookie: ownerCookie } })).status, 404);
    const workspace = join(root, 'workspace', 'project'); await mkdir(workspace, { recursive: true });
    const project = (await api('POST', '/projects', { name: 'Temporary QA', rootPath: workspace }, 201)).project;
    await api('GET', '/projects');
    await api('PATCH', `/projects/${project.id}`, { name: 'Temporary QA renamed' });
    assert.equal((await api('GET', `/projects/${project.id}`)).project.name, 'Temporary QA renamed');
    const session = (await api('POST', '/sessions', { name: 'Temporary QA', projectId: project.id, tool: 'codex' }, 201)).session;
    await api('PATCH', `/sessions/${session.id}`, { name: 'Temporary QA renamed' });
    assert.equal((await api('GET', `/sessions/${session.id}`)).session.name, 'Temporary QA renamed');
    await api('GET', '/harnesses'); await api('GET', '/tools'); await api('GET', '/providers');
    // Exercise the real carrier, business router, installer, version resolver,
    // installation journal and owned-prefix uninstall. Only npm's package
    // download is a local fixture; no live runtime or registry is contacted.
    const installed = (await api('POST', '/harnesses/qwen-code/install', {})).harness;
    assert.equal(installed.installationSource, 'managed');
    assert.equal(installed.detectedVersion, '0.22.2');
    assert.ok(resolve(installed.path).startsWith(resolve(join(root, 'harnesses', 'qwen-code')) + sep));
    const upgraded = (await api('POST', '/harnesses/qwen-code/upgrade', { version: '0.22.3' })).harness;
    assert.equal(upgraded.detectedVersion, '0.22.3');
    assert.equal(upgraded.upgraded, true);
    const uninstalled = (await api('POST', '/harnesses/qwen-code/uninstall', {})).harness;
    assert.equal(uninstalled.uninstalled, true);
    assert.equal(uninstalled.filesRemoved, true);
    assert.equal(uninstalled.available, false);
    await assert.rejects(access(join(root, 'harnesses', 'qwen-code')), { code: 'ENOENT' });
    const installJournal = JSON.parse(await readFile(join(root, 'config', 'harness-installations.json'), 'utf8'));
    assert.equal(installJournal['qwen-code'].installed, false);
    assert.deepEqual((await readFile(installerCalls, 'utf8')).trim().split('\n').map(JSON.parse)
      .map((entry) => entry.packageSpec), ['@qwen-code/qwen-code@0.22.2', '@qwen-code/qwen-code@0.22.3']);
    const provider = (await api('POST', '/providers', { agentType: 'codex', displayName: 'Temporary QA',
      baseUrl: 'https://example.invalid/v1', apiKey: 'qa-placeholder-not-a-real-secret', discoverModels: false }, 201)).provider;
    await api('PATCH', `/providers/${provider.id}`, { displayName: 'Temporary QA renamed' });
    await api('DELETE', `/providers/${provider.id}`);
    await api('DELETE', `/sessions/${session.id}`); await api('DELETE', `/projects/${project.id}`);
    await api('GET', '/device-pairing/devices', undefined, 403);
    const { getOwnerAccountBinding } = await import('../lib/owner-account-auth.mjs');
    const { listTrustedDevices } = await import('../chat/trusted-devices.mjs');
    assert.equal(await getOwnerAccountBinding(), null);
    assert.deepEqual((await listTrustedDevices()).devices, [], 'temporary control must not enroll a permanent trusted device');
    await registry.revoke(invitation.invitationId);
    assert.equal((await api('GET', '/projects', undefined, 410)).code, 'temporary_control_inactive');
    const beforeDeniedInstall = await readFile(installerCalls, 'utf8');
    await api('POST', '/harnesses/qwen-code/install', {}, 410);
    assert.equal(await readFile(installerCalls, 'utf8'), beforeDeniedInstall, 'revoked control must not invoke an installer');
    console.log('business-router-verified');
  } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
}

async function prepareHarnessInstaller(root) {
  const directory = join(root, 'installer-fixture'); await mkdir(directory, { recursive: true });
  const script = join(directory, 'npm-fixture.mjs');
  const calls = join(directory, 'calls.jsonl');
  await writeFile(script, `
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const args = process.argv.slice(2);
assert.equal(args.length, 6);
assert.deepEqual([args[0], args[1], args[3], args[4]], ['install', '--prefix', '--no-save', '--package-lock=false']);
const prefix = args[2];
assert.equal(resolve(prefix), resolve(process.env.RAGENT_HARNESS_ROOT, 'qwen-code'));
const packageSpec = args[5];
assert.ok(['@qwen-code/qwen-code@0.22.2', '@qwen-code/qwen-code@0.22.3'].includes(packageSpec));
const version = packageSpec.slice(packageSpec.lastIndexOf('@') + 1);
const bin = join(prefix, 'node_modules', '.bin'); await mkdir(bin, { recursive: true });
const command = join(bin, process.platform === 'win32' ? 'qwen.cmd' : 'qwen');
await writeFile(command, process.platform === 'win32'
  ? '@echo off\\r\\necho Qwen Code ' + version + '\\r\\n'
  : '#!/bin/sh\\nprintf "Qwen Code ' + version + '\\\\n"\\n');
await chmod(command, 0o700);
await appendFile(${JSON.stringify(calls)}, JSON.stringify({ prefix, packageSpec }) + '\\n');
`);
  const command = join(directory, process.platform === 'win32' ? 'npm-fixture.cmd' : 'npm-fixture');
  await writeFile(command, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(command, 0o700);
  process.env.RAGENT_NPM_COMMAND = command;
  return calls;
}
