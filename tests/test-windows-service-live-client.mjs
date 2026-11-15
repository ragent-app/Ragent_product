import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createWindowsPrivilegedBrokerClient, handleWindowsPrivilegedBrokerRoutes } from '../chat/windows-privileged-broker.mjs';
import { windowsServiceOwnerSigningBytes, windowsServiceReviewSigningBytes } from '../chat/windows-service-grant.mjs';
import { buildApprovedAction } from '../chat/approved-actions.mjs';
import { prepareApprovedActionSemanticProjection } from '../chat/approved-action-semantic.mjs';
import { submitOrResumeWindowsServiceProposal, queryWindowsServiceProposal } from '../chat/windows-service-proposal.mjs';
import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignaling } from '../p2p/signaling-server.mjs';

const fixtureDir = process.env.RAGENT_BROKER_LIVE_CLIENT_DIR;
if (process.platform !== 'win32' || !fixtureDir) {
  console.log('windows-service-live-client: skipped (opt-in Windows live broker fixture)');
  process.exit(0);
}
const dir = path.resolve(fixtureDir);
const relative = path.relative(path.resolve(os.tmpdir()), dir);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
    !path.basename(dir).startsWith('service-qa-')) throw new Error('Invalid live broker fixture directory');

async function waitForFixture() {
  const deadline = Date.now() + (phonePort ? 120_000 : 40_000);
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path.join(dir, 'ready.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Live broker fixture did not become ready');
}
let succeeded = false;
const phonePort = Number(process.env.RAGENT_BROKER_PHONE_TEST_PORT || 0);
let phoneServer, phoneReview, phoneDecision, resolvePhoneDecision, phoneClient, phoneSignature;
let p2pHost, p2pSignaling;
let phonePublicKey;
const phoneDecisionPromise = new Promise(resolve => { resolvePhoneDecision = resolve; });
try {
  if (phonePort) {
    assert.ok(Number.isInteger(phonePort) && phonePort > 1024 && phonePort < 65536);
    phoneServer = createServer((req, res) => {
      // The app controller reads both legacy and service approvals. This
      // isolated fixture only creates service requests, so its legacy feed
      // must explicitly be empty rather than returning an unrelated 404.
      if (req.method === 'GET' && req.url?.startsWith('/api/windows-privileged-broker/requests/pending?')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          type: 'pending', pendingRequests: [], hasMore: false,
        }));
        return;
      }
      const serviceRoute = req.url?.startsWith('/api/windows-privileged-broker/service-requests/');
      const enrollmentRoute = req.url?.startsWith('/api/windows-privileged-broker/enrollments/');
      if (serviceRoute || enrollmentRoute) {
        if (serviceRoute && (!phoneReview || !phoneClient)) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'service_pending', items: [], hasMore: false }));
          return;
        }
        if (!phoneClient) {
          res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'BROKER_UNAVAILABLE' }));
          return;
        }
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        const routedClient = { ...phoneClient, approveServiceControl: async input => {
          phoneSignature = input.deviceSignature;
          return phoneClient.approveServiceControl(input);
        } };
        void handleWindowsPrivilegedBrokerRoutes({ req, res, pathname, authSession: { role: 'owner' }, brokerClient: routedClient,
          requireSessionAccess: async () => true, getSession: async () => ({ riskMode: 'recommended' }),
          resolveSessionRiskMode: session => session.riskMode,
          authorizeServiceApproval: async grant => grant.requestId === phoneReview.grant.requestId,
          writeJson: (response, status, payload) => {
            response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
            if (serviceRoute && req.method === 'POST' && status === 200 && ['executing', 'succeeded'].includes(payload.status)) {
              phoneDecision = payload; resolvePhoneDecision(payload);
            }
          },
        }).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
      req.on('end', () => { void (async () => {
        if (req.method === 'POST' && req.url === '/register' && !phonePublicKey) {
          const phone = JSON.parse(body);
          assert.match(phone.deviceId, /^[a-f0-9]{64}$/);
          assert.match(phone.publicKey, /^[A-Za-z0-9+/]+={0,2}$/);
          phonePublicKey = phone.publicKey;
          await writeFile(path.join(dir, 'phone.json'), JSON.stringify(phone), { flag: 'wx' });
          res.writeHead(200).end('{}');
        } else res.writeHead(404).end();
      })().catch(() => res.writeHead(400).end()); });
    });
    const p2pSecret = process.env.RAGENT_BROKER_P2P_SECRET || '';
    if (p2pSecret) {
      assert.match(p2pSecret, /^rpi_[a-f0-9]{48}$/);
      assert.ok(path.isAbsolute(process.env.RAGENT_BROKER_P2P_BINARY || ''));
      p2pSignaling = createP2PSignaling();
      phoneServer.on('upgrade', (req, socket, head) => {
        if (new URL(req.url, 'http://127.0.0.1').pathname === '/signal') p2pSignaling.handleUpgrade(req, socket, head);
        else socket.destroy();
      });
    }
    await new Promise((resolve, reject) => { phoneServer.once('error', reject); phoneServer.listen(phonePort, '127.0.0.1', resolve); });
    if (p2pSecret) {
      const stunUrl = process.env.RAGENT_BROKER_P2P_STUN || '';
      if (stunUrl && !stunUrl.startsWith('stun:')) throw new Error('Invalid fixture STUN URL');
      p2pHost = await runP2PHostAgent({ signalingUrl: `http://127.0.0.1:${phonePort}`,
        roomId: createP2PRoomId(p2pSecret), secret: p2pSecret, expiresAt: new Date(Date.now() + 240_000).toISOString(),
        binaryPath: process.env.RAGENT_BROKER_P2P_BINARY, localBaseUrl: `http://127.0.0.1:${phonePort}`,
        iceServers: stunUrl ? [{ urls: stunUrl }] : [] });
      await p2pHost.ready;
    }
    await writeFile(path.join(dir, 'phone-server-ready.json'), JSON.stringify({ port: phonePort }), { flag: 'wx' });
  }
  const fixture = await waitForFixture();
  assert.match(fixture.pipe, /^\\\\\.\\pipe\\Ragent\.PrivilegedBroker\.LocalTest\.[a-f0-9]+\.Request$/);
  const fixtureGrant = fixture.proposal?.serviceControl;
  assert.ok(fixtureGrant && fixture.approval?.requestId === fixtureGrant.requestId);
  // The production ServiceHost bridge supplies an impersonation-capable pipe
  // token. Node's direct named-pipe sockets do not, so this fixture uses the
  // same Windows pipe impersonation level against the isolated test pipe.
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const pipeName = fixture.pipe.slice('\\\\.\\pipe\\'.length);
  const healthPipeName = fixture.healthPipe?.slice('\\\\.\\pipe\\'.length);
  if (healthPipeName) assert.match(healthPipeName, /^Ragent\.PrivilegedBroker\.LocalTest\.[a-f0-9]+\.Health$/);
  const exchangeScript = `
    $ErrorActionPreference='Stop'
    $p=[IO.Pipes.NamedPipeClientStream]::new('.', $env:RAGENT_QA_PIPE, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Impersonation)
    try {
      $p.Connect(5000)
      $body=[Convert]::FromBase64String($env:RAGENT_QA_REQUEST)
      $header=[BitConverter]::GetBytes([uint32]$body.Length)
      $p.Write($header,0,4); $p.Write($body,0,$body.Length); $p.Flush()
      $header=[byte[]]::new(4); $offset=0
      while($offset -lt 4){$n=$p.Read($header,$offset,4-$offset);if($n -le 0){throw 'Short header'};$offset+=$n}
      $length=[BitConverter]::ToUInt32($header,0);if($length -eq 0 -or $length -gt 65536){throw 'Invalid frame'}
      $body=[byte[]]::new($length);$offset=0
      while($offset -lt $body.Length){$n=$p.Read($body,$offset,$body.Length-$offset);if($n -le 0){throw 'Short frame'};$offset+=$n}
      [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
      [Console]::Write([Text.Encoding]::UTF8.GetString($body))
    } finally {$p.Dispose()}`;
  const client = createWindowsPrivilegedBrokerClient({ platform: 'win32', pipeExchange: async ({ pipe, request }) =>
    JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', exchangeScript], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, RAGENT_QA_PIPE: pipe === 'health' ? healthPipeName : pipeName, RAGENT_QA_REQUEST: Buffer.from(JSON.stringify(request)).toString('base64') },
    })) });
  phoneClient = client;
  if (phonePort) {
    const deadline = Date.now() + 40_000;
    for (;;) {
      try { assert.equal(JSON.parse(await readFile(path.join(dir, 'phone-enrolled.json'), 'utf8')).enrolled, true); break; }
      catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  let grant = fixtureGrant;
  let decisionSignature = fixture.approval.deviceSignature;
  let controlPlaneOptions;
  let deviceKey;
  let proposal;
  if (fixture.testSignerKey && (fixture.testDeviceKey || phonePort) && healthPipeName) {
    const context = { sessionId: 'js-session', runId: 'js-run', turnId: 'js-turn', requestKey: 'js-request',
      platform: 'win32', cwd: dir, projectRoot: dir, home: dir };
    const action = buildApprovedAction({ command: `Start-Service ${fixtureGrant.serviceName}` }, context);
    const projection = await prepareApprovedActionSemanticProjection({ action, trustedContext: context,
      resolverOptions: { windowsFactsProvider: { name: 'live-broker', serviceFacts: args => client.inspectService(args) } } });
    const privateKey = createPrivateKey({ key: Buffer.from(fixture.testSignerKey, 'base64'), format: 'der', type: 'pkcs8' });
    controlPlaneOptions = { action, projection, riskMode: 'recommended', authenticatedPrincipalKind: 'owner',
      client, kid: 'test-key', privateKey, assertActive: async () => {} };
    proposal = await submitOrResumeWindowsServiceProposal(controlPlaneOptions);
    assert.equal(proposal.duplicate, false);
    assert.equal((await submitOrResumeWindowsServiceProposal(controlPlaneOptions)).duplicate, true);
    assert.equal((await queryWindowsServiceProposal(controlPlaneOptions)).status, 'awaiting_device');
    if (fixture.testDeviceKey) deviceKey = createPrivateKey({ key: Buffer.from(fixture.testDeviceKey, 'base64'), format: 'der', type: 'pkcs8' });
  } else {
    proposal = await client.proposeServiceControl({ grant, signature: fixture.proposal.signature });
  }
  assert.equal(proposal.status, 'awaiting_device');
  const pending = await client.pendingServiceControls({ deviceId: fixture.approval.deviceId });
  const review = pending.items.find(item => item.grant.requestId === proposal.requestId);
  assert.ok(review);
  if (controlPlaneOptions) {
    grant = review.grant;
    if (phonePort) {
      phoneReview = review;
      await Promise.race([phoneDecisionPromise, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Android decision timed out')), 30_000); timer.unref();
      })]);
      decisionSignature = phoneSignature;
      const phoneKey = createPublicKey({ key: Buffer.from(phonePublicKey, 'base64'), format: 'der', type: 'spki' });
      assert.equal(verify('sha256', windowsServiceOwnerSigningBytes(grant), phoneKey, Buffer.from(decisionSignature, 'base64')), true);
    } else decisionSignature = sign('sha256', windowsServiceOwnerSigningBytes(grant), deviceKey).toString('base64');
  } else assert.deepEqual(review.grant, grant);
  const publicKey = createPublicKey({ key: Buffer.from(review.brokerPublicKey, 'base64'), type: 'spki', format: 'der' });
  assert.equal(verify('sha256', windowsServiceReviewSigningBytes(grant), publicKey, Buffer.from(review.brokerSignature, 'base64')), true);
  const approval = phonePort ? phoneDecision : await client.approveServiceControl({ requestId: grant.requestId,
    deviceId: fixture.approval.deviceId, deviceSignature: decisionSignature });
  assert.ok(['executing', 'succeeded'].includes(approval.status));
  let status;
  const deadline = Date.now() + 15_000;
  do {
    status = await client.status(grant.requestId);
    if (status.status === 'succeeded') break;
    assert.equal(status.status, 'executing');
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(status.status, 'succeeded');
  assert.equal((await client.approveServiceControl({ requestId: grant.requestId,
    deviceId: fixture.approval.deviceId, deviceSignature: decisionSignature })).status, 'succeeded');
  if (controlPlaneOptions) assert.equal((await queryWindowsServiceProposal(controlPlaneOptions)).status, 'succeeded');
  succeeded = true;
  console.log(`windows-service-live-client: ${phonePort ? 'Android device signature, ' : ''}${controlPlaneOptions ? 'control-plane proposal and ' : ''}signed pending, approval, execution and replay verified through real broker pipe`);
} finally {
  if (p2pHost) { p2pHost.stop(); await p2pHost.done.catch(() => {}); }
  if (p2pSignaling) p2pSignaling.close();
  if (phoneServer) await new Promise(resolve => phoneServer.close(resolve));
  const temporary = path.join(dir, 'result.json.tmp');
  await writeFile(temporary, JSON.stringify({ success: succeeded, ...(succeeded ? {} : { error: 'Node client test failed' }) }), { flag: 'wx' });
  await rename(temporary, path.join(dir, 'result.json'));
}
