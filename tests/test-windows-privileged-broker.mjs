import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import {
  currentWindowsBrokerApprovalRevision,
  publishWindowsBrokerApprovalInvalidation,
} from '../chat/windows-broker-approval-invalidation.mjs';

import {
  createWindowsPrivilegedBrokerClient,
  handleWindowsPrivilegedBrokerRoutes,
  WINDOWS_BROKER_MAX_FRAME_BYTES,
  WINDOWS_BROKER_PROTOCOL_VERSION,
  WINDOWS_BROKER_ENROLLMENTS_PATH,
  WINDOWS_BROKER_REQUESTS_PATH,
  WINDOWS_BROKER_TARGET_ID,
  resolveWindowsBrokerProfileDecision,
} from '../chat/windows-privileged-broker.mjs';

function encode(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

class MockPipeSocket extends Duplex {
  constructor(response) {
    super({ allowHalfOpen: true });
    this.response = response;
    this.written = Buffer.alloc(0);
    queueMicrotask(() => this.emit('connect'));
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.written = Buffer.concat([this.written, chunk]);
    callback();
  }

  _final(callback) {
    const response = encode(this.response);
    this.push(response.subarray(0, 2));
    this.push(response.subarray(2, 5));
    this.push(response.subarray(5));
    this.push(null);
    callback();
  }
}

function makeClient(response) {
  const calls = [];
  const sockets = [];
  const client = createWindowsPrivilegedBrokerClient({
    platform: 'win32',
    connect(options) {
      calls.push(options);
      const socket = new MockPipeSocket(response);
      sockets.push(socket);
      return socket;
    },
  });
  return { client, calls, sockets };
}

function fakeHttpRequest(method, body) {
  const req = new PassThrough();
  req.method = method;
  req.headers = body === undefined ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) };
  queueMicrotask(() => req.end(body === undefined ? undefined : JSON.stringify(body)));
  return req;
}

function fakeHttpResponse() {
  return Object.assign(new EventEmitter(), {
    headers: {}, setHeader(name, value) { this.headers[name] = value; },
  });
}

async function callRoute(options) {
  const res = options.res || fakeHttpResponse();
  options.req.url = options.url ?? options.pathname;
  let written;
  const handled = await handleWindowsPrivilegedBrokerRoutes({
    req: options.req,
    res,
    pathname: options.pathname,
    authSession: options.authSession,
    reauthorizePending: options.reauthorizePending,
    brokerClient: options.brokerClient,
    requireSessionAccess: async () => true,
    getSession: options.getSession ?? (async () => ({ riskMode: 'recommended' })),
    resolveSessionRiskMode: options.resolveSessionRiskMode ?? ((session) => session?.riskMode),
    writeJson(_res, status, body) { written = { status, body }; },
  });
  return { handled, res, written };
}

const validProposal = {
  requestId: 'req-qa-1',
  sessionId: 'session-qa-1',
  runId: 'run-qa-1',
  turnId: 'turn-qa-1',
  actionId: 'action-qa-1',
  operation: 'service.restart',
  targetId: WINDOWS_BROKER_TARGET_ID,
};

{
  const selectedInstaller = { id: 'Vendor.App', version: '1.2.3', source: 'winget', scope: 'System', elevation: 'ElevationRequired', type: 'Msi', nestedType: 'Unknown', architecture: 'X64', locale: 'en-US' };
  const { client, sockets } = makeClient({ version: 2, type: 'auto_install_inspection', selectedInstaller });
  assert.deepEqual(await client.inspectAutoInstall({ packageId: 'Vendor.App', packageVersion: '1.2.3' }), selectedInstaller);
  const prohibited = makeClient({ version: 2, type: 'auto_install_inspection', selectedInstaller: { ...selectedInstaller, elevation: 'ElevationProhibited' } });
  assert.equal((await prohibited.client.inspectAutoInstall({ packageId: 'Vendor.App', packageVersion: '1.2.3' })).elevation, 'ElevationProhibited');
  assert.deepEqual(JSON.parse(sockets[0].written.subarray(4).toString('utf8')), { version: 2, type: 'auto_install.inspect', autoInspect: { packageId: 'Vendor.App', packageVersion: '1.2.3' } });
  await assert.rejects(client.inspectAutoInstall({ packageId: 'Vendor.App;bad', packageVersion: '1.2.3' }), { code: 'BROKER_REQUEST_INVALID' });
  const mismatch = makeClient({ version: 2, type: 'auto_install_inspection', selectedInstaller: { ...selectedInstaller, version: 'other' } });
  await assert.rejects(mismatch.client.inspectAutoInstall({ packageId: 'Vendor.App', packageVersion: '1.2.3' }), { code: 'BROKER_RESPONSE_INVALID' });
}

{
  const { client, sockets } = makeClient({ version: 2, type: 'result', status: 'running' });
  const grant = {
    version: 1, keyId: 'key-1', brokerInstallationId: 'install-1', policyGeneration: 1,
    requestId: 'request-1', sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1', actionId: 'action-1',
    nonce: 'a'.repeat(32), packageId: 'Git.Git', packageVersion: '2.50.1', source: 'winget', installScope: 'machine',
    issuedMs: 1000, expiresMs: 61000,
  };
  const signature = 'A'.repeat(86);
  assert.equal((await client.executeAutoInstall({ grant, signature })).status, 'running');
  assert.deepEqual(JSON.parse(sockets[0].written.subarray(4).toString('utf8')), {
    version: 2, type: 'auto_install.execute', autoInstall: grant, signature,
  });
  const selectedInstaller = { id: 'Git.Git', version: '2.50.1', source: 'winget', scope: 'System', elevation: 'ElevationRequired', type: 'Msi', nestedType: 'Unknown', architecture: 'X64', locale: 'en-US' };
  assert.equal((await client.executeAutoInstall({ grant: { ...grant, selectedInstaller }, signature })).status, 'running');
  for (const bad of [
    { ...grant, command: 'arbitrary' }, { ...grant, packageId: 'Git.Git;cmd' },
    { ...grant, expiresMs: 61001 }, { ...grant, source: 'custom' },
    { ...grant, installScope: 'user' }, { ...grant, installScope: undefined },
    { ...grant, selectedInstaller: { ...selectedInstaller, scope: 'User' } },
    { ...grant, selectedInstaller: { ...selectedInstaller, id: 'Other.App' } },
    { ...grant, selectedInstaller: { ...selectedInstaller, extra: 'forged' } },
  ]) await assert.rejects(client.executeAutoInstall({ grant: bad, signature }), { code: 'BROKER_REQUEST_INVALID' });
  await assert.rejects(client.executeAutoInstall({ grant, signature: 'bad' }), { code: 'BROKER_REQUEST_INVALID' });
}

assert.deepEqual(resolveWindowsBrokerProfileDecision('full-auto', 'win32'), {
  decision: 'require_device', code: 'BROKER_DEVICE_APPROVAL_REQUIRED',
});
assert.deepEqual(resolveWindowsBrokerProfileDecision('recommended', 'win32'), {
  decision: 'require_device', code: 'BROKER_DEVICE_APPROVAL_REQUIRED',
});
assert.deepEqual(resolveWindowsBrokerProfileDecision('safe', 'win32'), {
  decision: 'require_device', code: 'BROKER_DEVICE_APPROVAL_REQUIRED',
});
assert.deepEqual(resolveWindowsBrokerProfileDecision('conservative-auto', 'win32'), {
  decision: 'deny', code: 'BROKER_PERMISSION_PROFILE_DENIED',
});
assert.deepEqual(resolveWindowsBrokerProfileDecision('full-auto', 'linux'), {
  decision: 'deny', code: 'BROKER_PLATFORM_UNSUPPORTED',
});
assert.deepEqual(resolveWindowsBrokerProfileDecision('', 'win32'), {
  decision: 'deny', code: 'BROKER_PERMISSION_PROFILE_UNAVAILABLE',
});

{
  const { client, calls, sockets } = makeClient({
    version: WINDOWS_BROKER_PROTOCOL_VERSION,
    type: 'health',
    code: 'BROKER_DISABLED',
  });
  const response = await client.health();
  assert.equal(response.code, 'BROKER_DISABLED');
  assert.deepEqual(calls, [{
    path: String.raw`\\.\pipe\Ragent.PrivilegedBroker.Health.v2`,
    allowHalfOpen: true,
  }]);
}

{
  const { client, calls, sockets } = makeClient({
    version: WINDOWS_BROKER_PROTOCOL_VERSION,
    type: 'result',
    requestId: validProposal.requestId,
    status: 'awaiting_device',
  });
  const response = await client.propose(validProposal);
  assert.equal(response.status, 'awaiting_device');
  assert.equal(calls[0].path, String.raw`\\.\pipe\Ragent.PrivilegedBroker.Request.v2`);
  const frame = sockets[0].written;
  const length = frame.readUInt32LE(0);
  assert.equal(length, frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString('utf8')), {
    version: 2,
    type: 'propose',
    ...validProposal,
  });
}

{
  const { client, sockets } = makeClient({ version: 2, type: 'pending', pendingRequests: [], hasMore: false });
  const response = await client.pending({ deviceId: 'a'.repeat(64), cursor: 'req-16' });
  assert.deepEqual(response.pendingRequests, []);
  const frame = sockets[0].written;
  assert.deepEqual(JSON.parse(frame.subarray(4).toString('utf8')), {
    version: 2, type: 'pending', deviceId: 'a'.repeat(64), cursor: 'req-16',
  });
  await assert.rejects(client.pending({ deviceId: 'bad' }), { code: 'BROKER_REQUEST_INVALID' });
}

{
  let responseIndex = 0;
  const responses = [
    { version: 2, type: 'enrollment_challenge', enrollmentChallenge: { enrollmentId: 'enroll-1' } },
    { version: 2, type: 'result', code: 'DEVICE_ENROLLED' },
  ];
  const sockets = [];
  const client = createWindowsPrivilegedBrokerClient({
    platform: 'win32',
    connect() {
      const socket = new MockPipeSocket(responses[responseIndex++]);
      sockets.push(socket);
      return socket;
    },
  });
  const deviceId = 'e'.repeat(64);
  assert.equal((await client.pendingEnrollment({ deviceId })).type, 'enrollment_challenge');
  assert.deepEqual(JSON.parse(sockets[0].written.subarray(4).toString('utf8')), {
    version: 2, type: 'enrollment.pending', deviceId,
  });
  assert.equal((await client.completeEnrollment({
    enrollmentId: 'enroll-1', verificationCode: '12345678', signature: 'MEUCIQ==',
  })).code, 'DEVICE_ENROLLED');
  assert.deepEqual(JSON.parse(sockets[1].written.subarray(4).toString('utf8')), {
    version: 2, type: 'enrollment.complete', enrollmentId: 'enroll-1',
    verificationCode: '12345678', signature: 'MEUCIQ==',
  });
  await assert.rejects(client.completeEnrollment({
    enrollmentId: 'enroll-1', verificationCode: '1234', signature: 'MEUCIQ==',
  }), { code: 'BROKER_REQUEST_INVALID' });
}

{
  const { client } = makeClient({ version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'result' });
  await assert.rejects(
    client.propose({ ...validProposal, targetId: 'WinDefend' }),
    { code: 'BROKER_REQUEST_INVALID' },
  );
  await assert.rejects(
    client.decision({ requestId: 'req-1', deviceId: 'a'.repeat(64), choice: 'approve', signature: 'x'.repeat(1025) }),
    { code: 'BROKER_REQUEST_INVALID' },
  );
}

{
  const client = createWindowsPrivilegedBrokerClient({ platform: 'linux' });
  await assert.rejects(client.health(), { code: 'BROKER_PLATFORM_UNSUPPORTED' });
}

{
  const calls = [];
  const client = createWindowsPrivilegedBrokerClient({
    platform: 'win32',
    pipeExchange: async (input) => {
      calls.push(input);
      return { version: 2, type: input.pipe === 'health' ? 'health' : 'result', code: 'BROKER_DISABLED' };
    },
  });
  assert.equal((await client.health()).code, 'BROKER_DISABLED');
  assert.equal(calls[0].pipe, 'health');
  await assert.rejects(client.status('invalid id'), { code: 'BROKER_REQUEST_INVALID' });
}

{
  const captured = [];
  const brokerClient = {
    async propose(input) { captured.push(['propose', input]); return { version: 2, type: 'result', requestId: input.requestId, status: 'awaiting_device' }; },
    async status(requestId) {
      captured.push(['status', requestId]);
      return { version: 2, type: 'result', requestId, status: 'awaiting_device', challenge: { sessionId: validProposal.sessionId } };
    },
    async pending(input) { captured.push(['pending', input]); return { version: 2, type: 'pending', pendingRequests: [] }; },
    async decision(input) { captured.push(['decision', input]); return { version: 2, type: 'result', requestId: input.requestId, status: 'denied' }; },
  };
  const owner = { role: 'owner' };
  const propose = await callRoute({
    req: fakeHttpRequest('POST', validProposal),
    pathname: WINDOWS_BROKER_REQUESTS_PATH,
    authSession: owner,
    brokerClient,
  });
  assert.equal(propose.handled, true);
  assert.equal(propose.written.status, 200);
  assert.equal(propose.written.body.status, 'awaiting_device');
  assert.equal(propose.res.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(captured[0], ['propose', validProposal]);

  const status = await callRoute({
    req: fakeHttpRequest('GET'),
    pathname: `${WINDOWS_BROKER_REQUESTS_PATH}/req-qa-1`,
    authSession: owner,
    brokerClient,
  });
  assert.equal(status.written.body.status, 'awaiting_device');
  assert.deepEqual(captured[1], ['status', 'req-qa-1']);

  const pending = await callRoute({
    req: fakeHttpRequest('GET'),
    pathname: `${WINDOWS_BROKER_REQUESTS_PATH}/pending`,
    url: `${WINDOWS_BROKER_REQUESTS_PATH}/pending?deviceId=${'c'.repeat(64)}&cursor=req-16`,
    authSession: owner,
    brokerClient,
  });
  assert.equal(pending.written.status, 200);
  assert.deepEqual(captured[2], ['pending', { deviceId: 'c'.repeat(64), cursor: 'req-16' }]);

  const signedDecision = { deviceId: 'b'.repeat(64), choice: 'approve', signature: 'MEUCIQ==' };
  const decision = await callRoute({
    req: fakeHttpRequest('POST', signedDecision),
    pathname: `${WINDOWS_BROKER_REQUESTS_PATH}/req-qa-1/decision`,
    authSession: owner,
    brokerClient,
  });
  assert.equal(decision.written.body.status, 'denied');
  assert.deepEqual(captured[3], ['status', 'req-qa-1']);
  assert.deepEqual(captured[4], ['decision', { requestId: 'req-qa-1', ...signedDecision }]);

  const forgedApproval = await callRoute({
    req: fakeHttpRequest('POST', { ...signedDecision, approved: true }),
    pathname: `${WINDOWS_BROKER_REQUESTS_PATH}/req-qa-1/decision`,
    authSession: owner,
    brokerClient,
  });
  assert.equal(forgedApproval.written.status, 400);
  assert.equal(captured.length, 5);
}

{
  let proposed = false;
  const response = await callRoute({
    req: fakeHttpRequest('POST', { ...validProposal, targetId: 'Ragent-ControlPlane' }),
    pathname: WINDOWS_BROKER_REQUESTS_PATH,
    authSession: { role: 'owner' },
    brokerClient: { async propose() { proposed = true; } },
  });
  assert.equal(response.written.status, 400);
  assert.equal(proposed, false);

  const denied = await callRoute({
    req: fakeHttpRequest('POST', validProposal),
    pathname: WINDOWS_BROKER_REQUESTS_PATH,
    authSession: { role: 'owner', principalKind: 'run_capability' },
    brokerClient: { async propose() { proposed = true; } },
  });
  assert.equal(denied.written.status, 403);
  assert.equal(proposed, false);
}

{
  let proposed = false;
  const denied = await callRoute({
    req: fakeHttpRequest('POST', validProposal),
    pathname: WINDOWS_BROKER_REQUESTS_PATH,
    authSession: { role: 'owner' },
    getSession: async () => ({ riskMode: 'conservative-auto' }),
    brokerClient: { async propose() { proposed = true; } },
  });
  assert.equal(denied.written.status, 403);
  assert.equal(denied.written.body.code, 'BROKER_PERMISSION_PROFILE_DENIED');
  assert.equal(proposed, false);
}

{
  let proposed = false;
  const unavailable = await callRoute({
    req: fakeHttpRequest('POST', validProposal),
    pathname: WINDOWS_BROKER_REQUESTS_PATH,
    authSession: { role: 'owner' },
    getSession: false,
    resolveSessionRiskMode: false,
    brokerClient: { async propose() { proposed = true; } },
  });
  assert.equal(unavailable.written.status, 503);
  assert.equal(unavailable.written.body.code, 'BROKER_SESSION_POLICY_UNAVAILABLE');
  assert.equal(proposed, false);
}

{
  let decided = false;
  const denied = await callRoute({
    req: fakeHttpRequest('POST', { deviceId: 'b'.repeat(64), choice: 'approve', signature: 'MEUCIQ==' }),
    pathname: `${WINDOWS_BROKER_REQUESTS_PATH}/req-qa-1/decision`,
    authSession: { role: 'owner' },
    getSession: async () => ({ riskMode: 'conservative-auto' }),
    brokerClient: {
      async status(requestId) {
        return { version: 2, type: 'result', requestId, status: 'awaiting_device', challenge: { sessionId: validProposal.sessionId } };
      },
      async decision() { decided = true; return { version: 2, type: 'result', status: 'succeeded' }; },
    },
  });
  assert.equal(denied.written.status, 403);
  assert.equal(denied.written.body.code, 'BROKER_PERMISSION_PROFILE_DENIED');
  assert.equal(decided, false);
}

{
  let decided = false;
  const noChallenge = await callRoute({
    req: fakeHttpRequest('POST', { deviceId: 'b'.repeat(64), choice: 'approve', signature: 'MEUCIQ==' }),
    pathname: `${WINDOWS_BROKER_REQUESTS_PATH}/req-qa-1/decision`,
    authSession: { role: 'owner' },
    brokerClient: {
      async status(requestId) { return { version: 2, type: 'result', requestId, status: 'awaiting_device' }; },
      async decision() { decided = true; return { version: 2, type: 'result', status: 'succeeded' }; },
    },
  });
  assert.equal(noChallenge.written.status, 409);
  assert.equal(noChallenge.written.body.code, 'BROKER_CHALLENGE_UNAVAILABLE');
  assert.equal(decided, false);
}

{
  let queried = false;
  const response = await callRoute({
    req: fakeHttpRequest('GET'),
    pathname: `${WINDOWS_BROKER_REQUESTS_PATH}/pending`,
    url: `${WINDOWS_BROKER_REQUESTS_PATH}/pending?deviceId=${'d'.repeat(64)}`,
    authSession: { role: 'run', principalKind: 'run_capability' },
    brokerClient: { async pending() { queried = true; } },
  });
  assert.equal(response.written.status, 403);
  assert.equal(queried, false);
}

assert.equal(WINDOWS_BROKER_MAX_FRAME_BYTES, 65536);

{
  const captured = [];
  const brokerClient = {
    async pendingEnrollment(input) {
      captured.push(['pendingEnrollment', input]);
      return { version: 2, type: 'enrollment_challenge', enrollmentChallenge: { enrollmentId: 'enroll-1' } };
    },
    async completeEnrollment(input) {
      captured.push(['completeEnrollment', input]);
      return { version: 2, type: 'result', code: 'DEVICE_ENROLLED' };
    },
  };
  const owner = { role: 'owner' };
  const pending = await callRoute({
    req: fakeHttpRequest('GET'),
    pathname: `${WINDOWS_BROKER_ENROLLMENTS_PATH}/pending`,
    url: `${WINDOWS_BROKER_ENROLLMENTS_PATH}/pending?deviceId=${'e'.repeat(64)}`,
    authSession: owner,
    brokerClient,
  });
  assert.equal(pending.written.status, 200);
  assert.deepEqual(captured[0], ['pendingEnrollment', { deviceId: 'e'.repeat(64) }]);

  const complete = await callRoute({
    req: fakeHttpRequest('POST', { verificationCode: '12345678', signature: 'MEUCIQ==' }),
    pathname: `${WINDOWS_BROKER_ENROLLMENTS_PATH}/enroll-1/complete`,
    authSession: owner,
    brokerClient,
  });
  assert.equal(complete.written.body.code, 'DEVICE_ENROLLED');
  assert.deepEqual(captured[1], ['completeEnrollment', {
    enrollmentId: 'enroll-1', verificationCode: '12345678', signature: 'MEUCIQ==',
  }]);

  const extra = await callRoute({
    req: fakeHttpRequest('POST', { verificationCode: '12345678', signature: 'MEUCIQ==', publicKey: 'forged' }),
    pathname: `${WINDOWS_BROKER_ENROLLMENTS_PATH}/enroll-1/complete`,
    authSession: owner,
    brokerClient,
  });
  assert.equal(extra.written.status, 400);
  assert.equal(captured.length, 2);

  const nonOwner = await callRoute({
    req: fakeHttpRequest('GET'),
    pathname: `${WINDOWS_BROKER_ENROLLMENTS_PATH}/pending`,
    url: `${WINDOWS_BROKER_ENROLLMENTS_PATH}/pending?deviceId=${'e'.repeat(64)}`,
    authSession: { role: 'run', principalKind: 'run_capability' },
    brokerClient,
  });
  assert.equal(nonOwner.written.status, 403);
  assert.equal(captured.length, 2);
}

{
  const pathname = `${WINDOWS_BROKER_REQUESTS_PATH}/pending`;
  const deviceId = 'f'.repeat(64);
  const owner = { role: 'owner' };
  let reads = 0;
  const brokerClient = { async pending() {
    reads++;
    return { version: 2, type: 'pending', pendingRequests: [], hasMore: false };
  } };
  const revision = currentWindowsBrokerApprovalRevision();
  const query = `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(revision)}&waitMs=1000`;
  const pendingPromise = callRoute({
    req: fakeHttpRequest('GET'), pathname, url: query, authSession: owner,
    reauthorizePending: async () => true, brokerClient,
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reads, 0, 'waiting must not hold or call the Broker pipe');
  publishWindowsBrokerApprovalInvalidation(
    { type: 'result', status: 'awaiting_device' },
    { action: 'propose', requestId: 'wake-1', broadcast: () => {} },
  );
  const woke = await pendingPromise;
  assert.equal(woke.written.status, 200);
  assert.equal(reads, 1);
  assert.equal(woke.written.body.revision, currentWindowsBrokerApprovalRevision());

  const timeout = await callRoute({
    req: fakeHttpRequest('GET'), pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(currentWindowsBrokerApprovalRevision())}&waitMs=5`,
    authSession: owner, reauthorizePending: async () => true, brokerClient,
  });
  assert.equal(timeout.written.status, 200, 'bounded timeout must fall back to an authoritative snapshot');
  assert.equal(reads, 2);

  const denied = await callRoute({
    req: fakeHttpRequest('GET'), pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(revision)}&waitMs=5`,
    authSession: owner, reauthorizePending: async () => false, brokerClient,
  });
  assert.equal(denied.written.status, 403);
  assert.equal(reads, 2, 'revoked owner must not reach Broker IPC');

  const expiredBearer = await callRoute({
    req: fakeHttpRequest('GET'), pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(revision)}&waitMs=5`,
    authSession: owner,
    reauthorizePending: async () => ({ allowed: false, status: 401 }), brokerClient,
  });
  assert.equal(expiredBearer.written.status, 401);
  assert.equal(expiredBearer.written.body.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(reads, 2, 'expired credential must not query Broker IPC');

  const noCallback = await callRoute({
    req: fakeHttpRequest('GET'), pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(revision)}&waitMs=5`,
    authSession: owner, brokerClient,
  });
  assert.equal(noCallback.written.status, 403, 'missing reauthorization must fail closed');
  assert.equal(reads, 2);

  const authUnavailable = await callRoute({
    req: fakeHttpRequest('GET'), pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(revision)}&waitMs=5`,
    authSession: owner,
    reauthorizePending: async () => { throw new Error('authorization store unavailable'); },
    brokerClient,
  });
  assert.equal(authUnavailable.written.status, 503);
  assert.equal(reads, 2, 'authorization errors must not query Broker IPC');

  const invalid = await callRoute({
    req: fakeHttpRequest('GET'), pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(revision)}&waitMs=20000`,
    authSession: owner, reauthorizePending: async () => true, brokerClient,
  });
  assert.equal(invalid.written.status, 400);
  assert.equal(reads, 2);

  const res = fakeHttpResponse();
  const cancelled = callRoute({
    req: fakeHttpRequest('GET'), res, pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(currentWindowsBrokerApprovalRevision())}&waitMs=1000`,
    authSession: owner, reauthorizePending: async () => true, brokerClient,
  });
  res.emit('close');
  const stopped = await cancelled;
  assert.equal(stopped.written, undefined);
  assert.equal(reads, 2, 'disconnected request must release waiter without Broker IPC');

  const duringAuthResponse = fakeHttpResponse();
  let releaseAuthorization;
  let authorizationStarted;
  const enteredAuthorization = new Promise(resolve => { authorizationStarted = resolve; });
  const duringAuthorization = callRoute({
    req: fakeHttpRequest('GET'), res: duringAuthResponse, pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(revision)}&waitMs=5`,
    authSession: owner,
    reauthorizePending: async () => {
      authorizationStarted();
      return new Promise(resolve => { releaseAuthorization = resolve; });
    },
    brokerClient,
  });
  await enteredAuthorization;
  duringAuthResponse.emit('close');
  releaseAuthorization({ allowed: true });
  const closedDuringAuthorization = await duringAuthorization;
  assert.equal(closedDuringAuthorization.written, undefined);
  assert.equal(reads, 2, 'disconnect during fresh authorization must not start Broker IPC');

  const beforeSnapshot = currentWindowsBrokerApprovalRevision();
  let raceReads = 0;
  const racingClient = { async pending() {
    raceReads++;
    if (raceReads === 1) publishWindowsBrokerApprovalInvalidation(
      { type: 'result', status: 'awaiting_device' },
      { action: 'propose', requestId: 'race-1', broadcast: () => {} },
    );
    return { version: 2, type: 'pending', pendingRequests: [], hasMore: false };
  } };
  const firstSnapshot = await callRoute({
    req: fakeHttpRequest('GET'), pathname, url: `${pathname}?deviceId=${deviceId}`,
    authSession: owner, brokerClient: racingClient,
  });
  assert.equal(firstSnapshot.written.body.revision, beforeSnapshot,
    'snapshot must carry a revision captured before Broker IPC');
  const secondSnapshot = await callRoute({
    req: fakeHttpRequest('GET'), pathname,
    url: `${pathname}?deviceId=${deviceId}&afterRevision=${encodeURIComponent(beforeSnapshot)}&waitMs=1000`,
    authSession: owner, reauthorizePending: async () => true, brokerClient: racingClient,
  });
  assert.equal(secondSnapshot.written.status, 200);
  assert.equal(raceReads, 2, 'event during snapshot must force an immediate subsequent read');
}

console.log('test-windows-privileged-broker: ok');
