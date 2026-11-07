import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { createLocalVoiceServer } from './local-voice-server.mjs';
import { createLocalVoiceInstaller } from './local-voice-installation.mjs';
import { loadLocalVoiceSettings, saveLocalVoiceSettings } from '../lib/local-voice-settings.mjs';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readBody } from '../lib/utils.mjs';

const MAX_BODY = 900_000;
const MAX_BASE64 = Math.ceil((44 + 16_000 * 2 * 20) / 3) * 4;

function readRequest(req, signal) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const fail = code => finish(Object.assign(new Error('Invalid voice request'), { code }));
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { req.resume(); fail('BODY_TOO_LARGE'); }
      else chunks.push(Buffer.from(chunk));
    };
    const end = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const abort = () => fail('VOICE_CANCELLED');
    const error = () => fail('VOICE_CANCELLED');
    function finish(err, value) {
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('error', error); req.removeListener('aborted', abort);
      signal.removeEventListener('abort', abort);
      if (err) reject(err); else resolve(value);
    }
    const length = Number(req.headers?.['content-length']);
    if (Number.isFinite(length) && length > MAX_BODY) { req.resume(); return fail('BODY_TOO_LARGE'); }
    if (signal.aborted) return abort();
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', abort);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function decodeAudio(body) {
  let value;
  try { value = JSON.parse(body); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || typeof value.audio !== 'string'
      || value.audio.length > MAX_BASE64 || value.audio.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.audio)) return null;
  const audio = Buffer.from(value.audio, 'base64');
  return audio.toString('base64') === value.audio ? audio : null;
}

export function createLocalVoiceRoutes({ transcriber = null, installer = null, settingsStore = { load: loadLocalVoiceSettings, save: saveLocalVoiceSettings } } = {}) {
  async function isInstalled() {
    if (!transcriber) return false;
    if (typeof transcriber.isInstalled === 'function') return Boolean(await transcriber.isInstalled());
    return Boolean(await transcriber.isAvailable?.());
  }

  async function initialize() {
    await installer?.initialize?.();
    const settings = await settingsStore.load({ defaultEnabled: await isInstalled() });
    if (settings.enabled && transcriber?.setEnabled) {
      try { await transcriber.setEnabled(true); } catch { /* Leave the option saved; the runtime retries while enabled. */ }
    }
    return settings;
  }

  async function handleLocalVoice({ req, res, pathname, authSession, requireSessionAccess, getSession, writeJson }) {
    if (pathname === '/api/local-voice-settings' && ['GET', 'PATCH'].includes(req.method)) {
      res.setHeader?.('Cache-Control', 'no-store');
      if (authSession?.role !== 'owner') {
        req.resume?.(); writeJson(res, 403, { error: 'Owner access required' }); return true;
      }
      try {
        if (req.method === 'GET') {
          const installed = await isInstalled();
          const settings = await settingsStore.load({ defaultEnabled: installed });
          writeJson(res, 200, {
            installed,
            enabled: settings.enabled,
            running: Boolean(transcriber?.isRunning?.()),
            ready: Boolean(transcriber?.isReady?.()),
            installing: Boolean(installer?.isInstalling?.()),
            installable: Boolean(installer),
          });
          return true;
        }
        let payload;
        try { payload = JSON.parse(await readBody(req, 4096)); }
        catch (error) {
          writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
          return true;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || Object.keys(payload).length !== 1 || typeof payload.enabled !== 'boolean') {
          writeJson(res, 400, { error: 'enabled must be a boolean' });
          return true;
        }
        if (payload.enabled) {
          const installed = await isInstalled();
          if (!installed) {
            writeJson(res, 409, { code: 'VOICE_NOT_INSTALLED', error: 'Local voice recognition is not installed' });
            return true;
          }
          try { await transcriber.setEnabled(true); }
          catch {
            try { await transcriber.setEnabled(false); } catch {}
            writeJson(res, 503, { code: 'VOICE_START_FAILED', error: 'Local voice recognition could not start' });
            return true;
          }
          try { await settingsStore.save({ enabled: true }); }
          catch {
            try { await transcriber.setEnabled(false); } catch {}
            throw new Error('Failed to save local voice recognition setting');
          }
        } else {
          const saved = await settingsStore.save({ enabled: false });
          try { await transcriber?.setEnabled?.(false); }
          catch {
            writeJson(res, 503, { code: 'VOICE_STOP_FAILED', error: 'Local voice recognition could not stop' });
            return true;
          }
          writeJson(res, 200, {
            installed: await isInstalled(),
            enabled: saved.enabled,
            running: Boolean(transcriber?.isRunning?.()),
            ready: Boolean(transcriber?.isReady?.()),
            installing: Boolean(installer?.isInstalling?.()),
            installable: Boolean(installer),
          });
          return true;
        }
        const saved = await settingsStore.load({ defaultEnabled: true });
        writeJson(res, 200, {
          installed: true,
          enabled: saved.enabled,
          running: Boolean(transcriber?.isRunning?.()),
          ready: Boolean(transcriber?.isReady?.()),
          installing: Boolean(installer?.isInstalling?.()),
          installable: Boolean(installer),
        });
      } catch (error) {
        writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 503, {
          error: error?.message || 'Local voice recognition setting is unavailable',
        });
      }
      return true;
    }
    if (pathname === '/api/local-voice-install' && req.method === 'POST') {
      res.setHeader?.('Cache-Control', 'no-store');
      if (authSession?.role !== 'owner' ||
          (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind))) {
        req.resume?.(); writeJson(res, 403, { code: 'PERMISSION_DENIED', error: 'Owner access required' }); return true;
      }
      if (!installer || typeof transcriber?.configurePaths !== 'function') {
        req.resume?.(); writeJson(res, 503, { code: 'VOICE_INSTALL_UNAVAILABLE', error: 'Whisper installation is unavailable on this computer' }); return true;
      }
      let payload;
      try { payload = JSON.parse(await readBody(req, 4096)); }
      catch (error) {
        writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
        return true;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0) {
        writeJson(res, 400, { error: 'Expected an empty object' }); return true;
      }
      if (!installer.isInstalling?.() && await isInstalled()) {
        writeJson(res, 409, { code: 'VOICE_ALREADY_INSTALLED', error: 'Whisper is already installed' }); return true;
      }
      try {
        const operation = await installer.start(async paths => {
          try {
            await transcriber.configurePaths(paths);
            await settingsStore.save({ enabled: true });
            await transcriber.setEnabled(true);
          } catch {
            try { await transcriber.setEnabled(false); } catch {}
            try { await settingsStore.save({ enabled: false }); } catch {}
            throw Object.assign(new Error('Whisper did not become ready after installation'), { code: 'VOICE_INSTALL_START_FAILED' });
          }
        });
        writeJson(res, 202, { operationId: operation.operationId, status: operation.status });
      } catch (error) {
        writeJson(res, 503, { code: error?.code || 'VOICE_INSTALL_UNAVAILABLE', error: 'Whisper installation could not start' });
      }
      return true;
    }
    const installStatusMatch = /^\/api\/local-voice-install\/([a-f0-9-]{36})$/.exec(pathname);
    if (installStatusMatch && req.method === 'GET') {
      res.setHeader?.('Cache-Control', 'no-store');
      if (authSession?.role !== 'owner' ||
          (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind))) {
        req.resume?.(); writeJson(res, 403, { code: 'PERMISSION_DENIED', error: 'Owner access required' }); return true;
      }
      const operation = await installer?.getStatus?.(installStatusMatch[1]);
      if (!operation) { writeJson(res, 404, { code: 'VOICE_INSTALL_UNKNOWN', error: 'Whisper installation operation not found' }); return true; }
      writeJson(res, 200, operation);
      return true;
    }
    if (pathname === '/api/local-voice-recognition' && req.method === 'POST') {
      res.setHeader?.('Cache-Control', 'private, no-store');
      if (authSession?.role !== 'owner' ||
          (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind))) {
        req.resume?.(); writeJson(res, 403, { code: 'PERMISSION_DENIED', error: 'Owner access required' }); return true;
      }
      const voiceSettings = await settingsStore.load({ defaultEnabled: await isInstalled() });
      if (!voiceSettings.enabled || !await isInstalled()) {
        req.resume?.(); writeJson(res, 503, { code: 'VOICE_UNAVAILABLE', error: 'Local voice recognition is unavailable' }); return true;
      }
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      if (res.destroyed) controller.abort();
      try {
        const audio = decodeAudio(await readRequest(req, controller.signal));
        if (!audio) throw Object.assign(new Error('Invalid voice request'), { code: 'VOICE_AUDIO_INVALID' });
        const text = await transcriber.transcribe(audio, { signal: controller.signal });
        if (controller.signal.aborted) return true;
        writeJson(res, 200, { text });
      } catch (error) {
        if (controller.signal.aborted) return true;
        const code = ['BODY_TOO_LARGE', 'VOICE_AUDIO_INVALID', 'VOICE_BUSY', 'VOICE_TIMEOUT', 'VOICE_CANCELLED'].includes(error?.code)
          ? error.code : 'VOICE_UNAVAILABLE';
        const status = code === 'BODY_TOO_LARGE' ? 413 : code === 'VOICE_AUDIO_INVALID' ? 400 : code === 'VOICE_BUSY' ? 429 : 503;
        writeJson(res, status, { code, error: 'Local voice recognition failed' });
      } finally { res.removeListener('close', disconnected); }
      return true;
    }
    const match = /^\/api\/sessions\/([^/]+)\/local-voice-recognition$/.exec(pathname);
    if (!match || !['GET', 'POST'].includes(req.method)) return false;
    res.setHeader?.('Cache-Control', 'private, no-store');
    const gatewayOwner = authSession?.principalKind === 'target_runtime_gateway' && authSession?.targetRuntime === true &&
      authSession?.targetRuntimeOperation === (req.method === 'GET' ? 'session.read' : 'session.message');
    if (authSession?.role !== 'owner' || (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind) && !gatewayOwner)) {
      req.resume?.(); writeJson(res, 403, { code: 'PERMISSION_DENIED', error: 'Owner access required' }); return true;
    }
    const sessionId = match[1];
    if (!await requireSessionAccess(res, authSession, sessionId)) { req.resume?.(); return true; }
    if (!await getSession(sessionId)) { req.resume?.(); writeJson(res, 404, { error: 'Session not found' }); return true; }
    const voiceSettings = await settingsStore.load({ defaultEnabled: await isInstalled() });
    if (req.method === 'GET') {
      writeJson(res, 200, { available: Boolean(voiceSettings.enabled && transcriber && await transcriber.isAvailable()), destination: 'connected_computer', maxSeconds: 20 });
      return true;
    }
    if (!voiceSettings.enabled || !await isInstalled()) {
      req.resume?.(); writeJson(res, 503, { code: 'VOICE_UNAVAILABLE', error: 'Local voice recognition is unavailable' }); return true;
    }
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    if (res.destroyed) controller.abort();
    try {
      const audio = decodeAudio(await readRequest(req, controller.signal));
      if (!audio) throw Object.assign(new Error('Invalid voice request'), { code: 'VOICE_AUDIO_INVALID' });
      const text = await transcriber.transcribe(audio, { signal: controller.signal });
      if (controller.signal.aborted) return true;
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (!await getSession(sessionId)) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      if (controller.signal.aborted) return true;
      writeJson(res, 200, { text });
    } catch (error) {
      if (controller.signal.aborted) return true;
      const code = ['BODY_TOO_LARGE', 'VOICE_AUDIO_INVALID', 'VOICE_BUSY', 'VOICE_TIMEOUT', 'VOICE_CANCELLED'].includes(error?.code)
        ? error.code : 'VOICE_UNAVAILABLE';
      const status = code === 'BODY_TOO_LARGE' ? 413 : code === 'VOICE_AUDIO_INVALID' ? 400 : code === 'VOICE_BUSY' ? 429 : 503;
      writeJson(res, status, { code, error: 'Local voice recognition failed' });
    } finally { res.removeListener('close', disconnected); }
    return true;
  }
  handleLocalVoice.initialize = initialize;
  handleLocalVoice.shutdown = () => transcriber?.dispose?.();
  handleLocalVoice.shutdownNow = () => transcriber?.shutdownNow?.();
  return handleLocalVoice;
}

export function resolveLocalVoiceRuntimeDirectory(configDirectory = CONFIG_DIR, env = process.env) {
  const configured = typeof env.AGENTOC_LOCAL_VOICE_RUNTIME_DIRECTORY === 'string'
    ? env.AGENTOC_LOCAL_VOICE_RUNTIME_DIRECTORY.trim() : '';
  if (!configured) return join(configDirectory, 'voice-runtime');
  if (win32.isAbsolute(configured)) {
    if (configured.startsWith('\\\\')) throw Object.assign(new Error('A local voice runtime directory is required'), { code: 'VOICE_INSTALL_CONFIG_INVALID' });
    return win32.normalize(configured);
  }
  if (isAbsolute(configured)) return resolve(configured);
  throw Object.assign(new Error('A local voice runtime directory must be absolute'), { code: 'VOICE_INSTALL_CONFIG_INVALID' });
}

export function createConfiguredLocalVoiceRoutes(env = process.env) {
  let transcriber = null;
  let installer = null;
  const managedRuntimeDirectory = resolveLocalVoiceRuntimeDirectory(CONFIG_DIR, env);
  const managedExecutable = join(managedRuntimeDirectory, 'whisper-server.exe');
  const managedModel = join(managedRuntimeDirectory, 'ggml-base-q5_1.bin');
  const managedManifest = join(managedRuntimeDirectory, 'runtime-manifest.json');
  const hasManagedRuntime = existsSync(managedManifest);
  const executable = hasManagedRuntime ? managedExecutable : env.AGENTOC_LOCAL_VOICE_EXECUTABLE || managedExecutable;
  const model = hasManagedRuntime ? managedModel : env.AGENTOC_LOCAL_VOICE_MODEL || managedModel;
  try {
    transcriber = createLocalVoiceServer({ executable, model });
    if (process.platform === 'win32') {
      installer = createLocalVoiceInstaller({ runtimeDirectory: managedRuntimeDirectory });
    }
  } catch { /* Invalid or missing administrator configuration leaves it unavailable. */ }
  return createLocalVoiceRoutes({ transcriber, installer });
}
