import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

import { localVoiceProcessEnvironment, normalizeLocalVoiceLanguage, validateLocalVoiceWav } from './local-voice-transcriber.mjs';

const MAX_OUTPUT_BYTES = 64 * 1024;
const failure = code => Object.assign(new Error('Local voice transcription is unavailable'), { code });

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise(resolve => server.close(resolve));
    throw failure('VOICE_SERVER_START_FAILED');
  }
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A loopback-only whisper.cpp server that keeps its model loaded while enabled.
 * The persisted owner setting controls startup; a fresh Windows install with
 * Whisper included defaults to enabled. Audio reaches only this private
 * 127.0.0.1 endpoint. */
export function createLocalVoiceServer({
  executable,
  model,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  reservePort = reserveLoopbackPort,
  startupTimeoutMs = 90_000,
  requestTimeoutMs = 120_000,
  retryIntervalMs = 30_000,
} = {}) {
  if (!isAbsolute(executable || '') || !isAbsolute(model || '') || typeof spawnImpl !== 'function'
      || typeof fetchImpl !== 'function' || typeof reservePort !== 'function'
      || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 300_000
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 300_000
      || !Number.isSafeInteger(retryIntervalMs) || retryIntervalMs < 1000 || retryIntervalMs > 300_000) {
    throw failure('VOICE_CONFIG_INVALID');
  }

  let executablePath = executable;
  let modelPath = model;
  let enabled = false;
  let generation = 0;
  let current = null;
  let starting = null;
  let activeRequestController = null;
  let activeRequest = false;
  const children = new Set();

  async function resolveInputs() {
    const [binary, resolvedModel] = await Promise.all([realpath(executablePath), realpath(modelPath)]);
    const [binaryStat, modelStat] = await Promise.all([stat(binary), stat(resolvedModel)]);
    if (!binaryStat.isFile() || binaryStat.size === 0 || binaryStat.size > 512 * 1024 * 1024
        || !modelStat.isFile() || modelStat.size === 0 || modelStat.size > 16 * 1024 * 1024 * 1024) {
      throw failure('VOICE_CONFIG_INVALID');
    }
    return [binary, resolvedModel];
  }

  function killChildrenOnExit() {
    for (const child of children) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill(); } catch {}
    }
  }

  async function waitUntilReady(slot, requestGeneration) {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!enabled || generation !== requestGeneration || current !== slot) throw failure('VOICE_CANCELLED');
      if (slot.closed) throw failure('VOICE_SERVER_START_FAILED');
      const probe = new AbortController();
      const timer = setTimeout(() => probe.abort(), 750);
      try {
        const response = await fetchImpl(`${slot.baseUrl}/`, { signal: probe.signal });
        const server = String(response.headers?.get?.('server') || '').toLowerCase();
        const body = await response.text().catch(() => '');
        if (response.status < 500 && (server.includes('whisper.cpp') || body.includes('Whisper.cpp Server'))) {
          slot.ready = true;
          return true;
        }
      } catch {
        // The listener is not ready yet; retry while the model loads.
      } finally { clearTimeout(timer); }
      await delay(200);
    }
    throw failure('VOICE_TIMEOUT');
  }

  async function ensureStarted() {
    if (!enabled) throw failure('VOICE_DISABLED');
    if (current?.ready && !current.closed) return true;
    if (starting) return starting;
    const requestGeneration = generation;
    starting = (async () => {
      const [binary, modelPath] = await resolveInputs();
      if (!enabled || generation !== requestGeneration) throw failure('VOICE_CANCELLED');
      const port = await reservePort();
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('VOICE_SERVER_START_FAILED');
      const slot = {
        child: null,
        baseUrl: `http://127.0.0.1:${port}`,
        closed: false,
        ready: false,
        closePromise: null,
        resolveClose: null,
      };
      slot.closePromise = new Promise(resolve => { slot.resolveClose = resolve; });
      const child = spawnImpl(binary, [
        '--host', '127.0.0.1', '--port', String(port), '--model', modelPath,
        '--threads', '4', '--language', 'auto', '--no-timestamps', '--no-gpu',
      ], { shell: false, windowsHide: true, stdio: 'ignore', env: localVoiceProcessEnvironment() });
      slot.child = child;
      current = slot;
      children.add(child);
      child.once('error', () => {
        slot.closed = true;
        slot.ready = false;
        children.delete(child);
        if (current === slot) current = null;
        slot.resolveClose();
      });
      child.once('close', () => {
        slot.closed = true;
        slot.ready = false;
        children.delete(child);
        if (current === slot) current = null;
        slot.resolveClose();
      });
      try { await waitUntilReady(slot, requestGeneration); }
      catch (error) {
        if (current === slot) await stopChild();
        throw error;
      }
      return true;
    })().finally(() => { starting = null; });
    return starting;
  }

  async function stopChild() {
    const slot = current;
    current = null;
    if (!slot) return;
    slot.ready = false;
    if (!slot.closed && slot.child?.exitCode === null && slot.child?.signalCode === null) {
      try { slot.child.kill(); } catch {}
      await Promise.race([slot.closePromise, delay(3000)]);
      if (!slot.closed) {
        try { slot.child.kill('SIGKILL'); } catch { try { slot.child.kill(); } catch {} }
        await Promise.race([slot.closePromise, delay(1000)]);
      }
    }
  }

  const retryTimer = setInterval(() => {
    if (enabled && !current && !starting) void ensureStarted().catch(() => {});
  }, retryIntervalMs);
  retryTimer.unref?.();

  return Object.freeze({
    async isInstalled() {
      try { await resolveInputs(); return true; } catch { return false; }
    },
    isRunning() {
      return Boolean(current && !current.closed && current.child?.exitCode === null && current.child?.signalCode === null);
    },
    isEnabled() { return enabled; },
    isReady() { return Boolean(enabled && current?.ready && !current.closed); },
    async setEnabled(value) {
      if (typeof value !== 'boolean') throw failure('VOICE_CONFIG_INVALID');
      if (enabled === value) {
        if (!value) return false;
        // Repeated enable requests must join the existing startup instead of
        // invalidating it by advancing the generation while the model loads.
        await ensureStarted();
        return true;
      }
      enabled = value;
      generation += 1;
      if (!value) {
        activeRequestController?.abort();
        await stopChild();
        return false;
      }
      await ensureStarted();
      return true;
    },
    async configurePaths({ executable: nextExecutable, model: nextModel }) {
      if (!isAbsolute(nextExecutable || '') || !isAbsolute(nextModel || '')) throw failure('VOICE_CONFIG_INVALID');
      enabled = false;
      generation += 1;
      activeRequestController?.abort();
      await stopChild();
      if (starting) await starting.catch(() => {});
      executablePath = nextExecutable;
      modelPath = nextModel;
      return true;
    },
    async isAvailable() {
      if (!enabled || !current?.ready || current.closed) return false;
      try { await resolveInputs(); return true; } catch { return false; }
    },
    async transcribe(audio, { signal, language = 'auto' } = {}) {
      validateLocalVoiceWav(audio);
      const languageCode = normalizeLocalVoiceLanguage(language);
      if (!enabled) throw failure('VOICE_DISABLED');
      if (signal?.aborted) throw failure('VOICE_CANCELLED');
      if (activeRequest) throw failure('VOICE_BUSY');
      activeRequest = true;
      const input = Buffer.from(audio);
      const controller = new AbortController();
      activeRequestController = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        await ensureStarted();
        const slot = current;
        if (!slot?.ready || !enabled || controller.signal.aborted) throw failure(controller.signal.aborted ? 'VOICE_CANCELLED' : 'VOICE_UNAVAILABLE');
        const form = new FormData();
        form.append('file', new Blob([input], { type: 'audio/wav' }), 'ragent-voice.wav');
        form.append('language', languageCode);
        form.append('response_format', 'json');
        form.append('temperature', '0.0');
        const response = await fetchImpl(`${slot.baseUrl}/inference`, {
          method: 'POST', body: form, signal: controller.signal,
        });
        if (!response.ok) throw failure('VOICE_PROCESS_FAILED');
        const output = await response.json();
        const text = typeof output?.text === 'string' ? output.text.trim() : '';
        if (!text || Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
          throw failure('VOICE_OUTPUT_INVALID');
        }
        return text;
      } catch (error) {
        if (controller.signal.aborted || signal?.aborted) throw failure('VOICE_CANCELLED');
        if (typeof error?.code === 'string' && error.code.startsWith('VOICE_')) throw error;
        throw failure('VOICE_PROCESS_FAILED');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (activeRequestController === controller) activeRequestController = null;
        activeRequest = false;
      }
    },
    async dispose() {
      enabled = false;
      generation += 1;
      activeRequestController?.abort();
      clearInterval(retryTimer);
      await stopChild();
      killChildrenOnExit();
    },
    shutdownNow: killChildrenOnExit,
  });
}
