import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalVoiceRoutes, resolveLocalVoiceRuntimeDirectory } from './local-voice-routes.mjs';

test('managed Whisper runtime can use an absolute local-drive override while settings remain per-instance', () => {
  const directory = resolveLocalVoiceRuntimeDirectory('C:\\ProgramData\\AgentoC\\instances\\owner\\config', {
    AGENTOC_LOCAL_VOICE_RUNTIME_DIRECTORY: 'G:\\AgentoCapp\\local-voice\\voice-runtime',
  });
  assert.equal(directory, 'G:\\AgentoCapp\\local-voice\\voice-runtime');
});

test('managed Whisper runtime override rejects relative and network paths', () => {
  assert.throws(() => resolveLocalVoiceRuntimeDirectory('/instance/config', {
    AGENTOC_LOCAL_VOICE_RUNTIME_DIRECTORY: 'voice-runtime',
  }), { code: 'VOICE_INSTALL_CONFIG_INVALID' });
  assert.throws(() => resolveLocalVoiceRuntimeDirectory('/instance/config', {
    AGENTOC_LOCAL_VOICE_RUNTIME_DIRECTORY: '\\\\server\\share\\voice-runtime',
  }), { code: 'VOICE_INSTALL_CONFIG_INVALID' });
});

function requestFor(method, body = '') {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.headers = {};
  return req;
}

function responseFor() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.setHeader = () => {};
  return res;
}

function wavBase64() {
  const audio = Buffer.alloc(44 + 16_000 * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVE', 8); audio.write('fmt ', 12); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24); audio.writeUInt32LE(32_000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio.toString('base64');
}

test('fresh installation with Whisper enabled by default starts the transcriber', async () => {
  let started = false;
  const routes = createLocalVoiceRoutes({
    transcriber: { isInstalled: async () => true, setEnabled: async value => { started = value; } },
    settingsStore: { load: async ({ defaultEnabled }) => ({ enabled: defaultEnabled }) },
  });
  const settings = await routes.initialize();
  assert.equal(settings.enabled, true);
  assert.equal(started, true);
});

test('saved disabled preference overrides the fresh-install default', async () => {
  let started = false;
  const routes = createLocalVoiceRoutes({
    transcriber: { isInstalled: async () => true, setEnabled: async value => { started = value; } },
    settingsStore: { load: async () => ({ enabled: false }) },
  });
  const settings = await routes.initialize();
  assert.equal(settings.enabled, false);
  assert.equal(started, false);
});

test('paired owner can transcribe through the computer without binding to a session', async () => {
  let received;
  const routes = createLocalVoiceRoutes({
    transcriber: {
      isInstalled: async () => true,
      transcribe: async audio => { received = audio; return 'recognized words'; },
    },
    settingsStore: { load: async ({ defaultEnabled }) => ({ enabled: defaultEnabled }) },
  });
  const req = requestFor('POST', JSON.stringify({ audio: wavBase64() }));
  const res = responseFor();
  let result;
  const handled = await routes({
    req, res, pathname: '/api/local-voice-recognition',
    authSession: { role: 'owner', principalKind: 'trusted_device' },
    writeJson: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.text, 'recognized words');
  assert.equal(received.length, 44 + 32_000);
});

test('general computer transcription rejects untrusted requests', async () => {
  let called = false;
  const routes = createLocalVoiceRoutes({
    transcriber: { isInstalled: async () => true, transcribe: async () => { called = true; return 'bad'; } },
  });
  const req = requestFor('POST', JSON.stringify({ audio: wavBase64() }));
  const res = responseFor();
  let result;
  await routes({
    req, res, pathname: '/api/local-voice-recognition',
    authSession: { role: 'member', principalKind: 'trusted_device' },
    writeJson: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(result.status, 403);
  assert.equal(called, false);
});

test('voice settings expose install support and in-progress installation state', async () => {
  const routes = createLocalVoiceRoutes({
    transcriber: { isInstalled: async () => false },
    installer: { isInstalling: () => true },
    settingsStore: { load: async () => ({ enabled: false }) },
  });
  let result;
  await routes({
    req: requestFor('GET'), res: responseFor(), pathname: '/api/local-voice-settings',
    authSession: { role: 'owner', principalKind: 'trusted_device' },
    writeJson: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.installable, true);
  assert.equal(result.body.installing, true);

  const unsupportedRoutes = createLocalVoiceRoutes({
    transcriber: { isInstalled: async () => false },
    settingsStore: { load: async () => ({ enabled: false }) },
  });
  await unsupportedRoutes({
    req: requestFor('GET'), res: responseFor(), pathname: '/api/local-voice-settings',
    authSession: { role: 'owner' },
    writeJson: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(result.body.installable, false);
  assert.equal(result.body.installing, false);
});

test('paired owner can install Whisper and poll the operation until it is ready', async () => {
  let installed = false;
  let enabled = false;
  let operation = null;
  const values = { enabled: false };
  const transcriber = {
    isInstalled: async () => installed,
    isRunning: () => enabled,
    isReady: () => enabled,
    configurePaths: async paths => { assert.match(paths.executable, /whisper-server\.exe$/); installed = true; },
    setEnabled: async value => { enabled = value; },
  };
  const installer = {
    initialize: async () => {},
    isInstalling: () => Boolean(operation && operation.status === 'starting'),
    start: async activate => {
      operation = { operationId: 'd1b1a6b9-54ef-4784-8cb5-ef0fe011f9e7', status: 'starting' };
      void activate({ executable: 'C:\\ProgramData\\AgentoC\\voice-runtime\\whisper-server.exe', model: 'C:\\ProgramData\\AgentoC\\voice-runtime\\ggml-base-q5_1.bin' })
        .then(() => { operation.status = 'succeeded'; })
        .catch(() => { operation.status = 'failed'; operation.error = 'Whisper install failed'; });
      return { ...operation, status: 'queued' };
    },
    getStatus: async id => id === operation?.operationId ? { ...operation } : null,
  };
  const routes = createLocalVoiceRoutes({
    transcriber,
    installer,
    settingsStore: {
      load: async () => ({ enabled: values.enabled }),
      save: async next => { values.enabled = next.enabled; return next; },
    },
  });
  let result;
  await routes({
    req: requestFor('POST', '{}'),
    res: responseFor(),
    pathname: '/api/local-voice-install',
    authSession: { role: 'owner', principalKind: 'trusted_device' },
    writeJson: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.operationId, 'd1b1a6b9-54ef-4784-8cb5-ef0fe011f9e7');
  for (let attempt = 0; attempt < 100 && operation.status !== 'succeeded'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(operation.status, 'succeeded');
  assert.equal(installed, true);
  assert.equal(enabled, true);
  assert.equal(values.enabled, true);

  await routes({
    req: requestFor('GET'),
    res: responseFor(),
    pathname: `/api/local-voice-install/${operation.operationId}`,
    authSession: { role: 'owner', principalKind: 'trusted_device' },
    writeJson: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'succeeded');
});

test('Whisper installation endpoint rejects an untrusted device and arbitrary options', async () => {
  let starts = 0;
  const routes = createLocalVoiceRoutes({
    transcriber: { isInstalled: async () => false, configurePaths: async () => {}, setEnabled: async () => {} },
    installer: { isInstalling: () => false, start: async () => { starts += 1; } },
  });
  let result;
  await routes({
    req: requestFor('POST', '{}'), res: responseFor(), pathname: '/api/local-voice-install',
    authSession: { role: 'owner', principalKind: 'guest' },
    writeJson: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(result.status, 403);

  await routes({
    req: requestFor('POST', JSON.stringify({ command: 'whoami' })), res: responseFor(), pathname: '/api/local-voice-install',
    authSession: { role: 'owner', principalKind: 'trusted_device' },
    writeJson: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(result.status, 400);
  assert.equal(starts, 0);
});
