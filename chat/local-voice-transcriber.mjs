import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 20;
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;
const MAX_OUTPUT_BYTES = 64 * 1024;
const failure = code => Object.assign(new Error('Local voice transcription is unavailable'), { code });

export function localVoiceProcessEnvironment({ platform = process.platform, env = process.env } = {}) {
  const systemRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot : '';
  // A privileged Windows service must not search inherited user-writable PATH
  // entries for a native executable's DLLs. Its own directory remains in the
  // Windows loader search path and is pinned by the service host.
  const serviceMode = platform === 'win32' && env.AGENTOC_WINDOWS_SERVICE_MODE === '1';
  const safeRoot = /^[A-Za-z]:[\\/]/.test(systemRoot) && !/[\0\r\n]/.test(systemRoot) ? systemRoot : '';
  const path = serviceMode ? (safeRoot ? win32.join(safeRoot, 'System32') : '') : (env.PATH || '');
  return { PATH: path, ...((serviceMode ? safeRoot : systemRoot) ? { SystemRoot: serviceMode ? safeRoot : systemRoot } : {}) };
}

/** Accept only the small, canonical PCM WAV produced by the client recorder.
 * Reject alternate chunks/codecs rather than handing arbitrary files to a decoder. */
export function validateLocalVoiceWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44 + SAMPLE_RATE || audio.length > 44 + MAX_PCM_BYTES
      || audio.toString('latin1', 0, 4) !== 'RIFF' || audio.readUInt32LE(4) !== audio.length - 8
      || audio.toString('latin1', 8, 12) !== 'WAVE' || audio.toString('latin1', 12, 16) !== 'fmt '
      || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1
      || audio.readUInt32LE(24) !== SAMPLE_RATE || audio.readUInt32LE(28) !== SAMPLE_RATE * 2
      || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
      || audio.toString('latin1', 36, 40) !== 'data' || audio.readUInt32LE(40) !== audio.length - 44
      || (audio.length - 44) % 2 !== 0) throw failure('VOICE_AUDIO_INVALID');
  return true;
}

/** A local, opt-in whisper.cpp adapter. Paths come only from server-owned
 * configuration. Audio goes to the child through stdin and is never written
 * by this adapter; neither audio nor transcript is logged. */
export function createLocalVoiceTranscriber({ executable, model, timeoutMs = 90_000, spawnImpl = spawn } = {}) {
  if (!isAbsolute(executable || '') || !isAbsolute(model || '') || typeof spawnImpl !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw failure('VOICE_CONFIG_INVALID');
  let active = false;
  async function resolveInputs() {
    const [binary, modelPath] = await Promise.all([realpath(executable), realpath(model)]);
    const [binaryStat, modelStat] = await Promise.all([stat(binary), stat(modelPath)]);
    if (!binaryStat.isFile() || !modelStat.isFile() || modelStat.size === 0) throw failure('VOICE_CONFIG_INVALID');
    return [binary, modelPath];
  }
  return Object.freeze({
    async isAvailable() {
      try { await resolveInputs(); return true; } catch { return false; }
    },
    async transcribe(audio, { signal } = {}) {
    validateLocalVoiceWav(audio);
    // Keep the validated bytes stable while asynchronous path checks run.
    const input = Buffer.from(audio);
    if (signal?.aborted) throw failure('VOICE_CANCELLED');
    if (active) throw failure('VOICE_BUSY');
    active = true;
    try {
      const [binary, modelPath] = await resolveInputs();
      if (signal?.aborted) throw failure('VOICE_CANCELLED');
      return await new Promise((resolve, reject) => {
        let child, timer, forceTimer, errorCode = '', total = 0;
        const chunks = [];
        const stop = code => {
          if (!errorCode) errorCode = code;
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill();
            if (!forceTimer) forceTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
          }
        };
        const cancel = () => stop('VOICE_CANCELLED');
        try {
          // With stdin input, whisper.cpp otherwise treats "-" as the output
          // target too and disables its stdout segment callback. No output
          // format is enabled, so this basename is never opened as a file.
          child = spawnImpl(binary, ['--model', modelPath, '--file', '-', '--output-file', 'agentoc-unused', '--language', 'auto', '--no-timestamps', '--no-prints', '--threads', '4'],
            { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: localVoiceProcessEnvironment() });
          signal?.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(() => stop('VOICE_TIMEOUT'), timeoutMs);
          child.on('error', () => { if (!errorCode) errorCode = 'VOICE_PROCESS_FAILED'; });
          child.stdout.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_OUTPUT_BYTES) stop('VOICE_OUTPUT_INVALID');
            else chunks.push(chunk);
          });
          child.stderr.resume();
          child.stdin.on('error', () => { if (!errorCode) errorCode = 'VOICE_PROCESS_FAILED'; });
          child.on('close', code => {
            clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', cancel);
            if (errorCode || code !== 0) return reject(failure(errorCode || 'VOICE_PROCESS_FAILED'));
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
              if (!text || text.length > 10_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw failure('VOICE_OUTPUT_INVALID');
              resolve(text);
            } catch { reject(failure('VOICE_OUTPUT_INVALID')); }
          });
          if (signal?.aborted) cancel();
          else child.stdin.end(input);
        } catch { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', cancel); reject(failure('VOICE_PROCESS_FAILED')); }
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('VOICE_')) throw error;
      throw failure('VOICE_CONFIG_INVALID');
    } finally { active = false; }
  } });
}
