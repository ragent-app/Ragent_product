export const ACCOUNT_ASR_MAX_AUDIO_BYTES = 1024 * 1024;
export const ACCOUNT_ASR_MAX_DURATION_MS = 20_000;
export const ACCOUNT_ASR_MIN_DURATION_MS = 500;

function invalidAudio(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

/** Validate the exact WAV format emitted by Android before any provider call. */
export function inspectAccountAsrWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44) {
    throw invalidAudio('asr_audio_invalid', 400, 'A valid WAV recording is required.');
  }
  if (audio.length > ACCOUNT_ASR_MAX_AUDIO_BYTES) {
    throw invalidAudio('asr_audio_too_large', 413, 'The recording exceeds the upload size limit.');
  }
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw invalidAudio('asr_audio_invalid', 400, 'The recording is not a RIFF/WAVE file.');
  }
  const declaredSize = audio.readUInt32LE(4) + 8;
  if (declaredSize !== audio.length) {
    throw invalidAudio('asr_audio_invalid', 400, 'The WAV container length is inconsistent.');
  }

  let format = null;
  let dataLength = null;
  for (let offset = 12; offset < audio.length;) {
    if (offset + 8 > audio.length) {
      throw invalidAudio('asr_audio_invalid', 400, 'The WAV contains a truncated chunk.');
    }
    const id = audio.toString('ascii', offset, offset + 4);
    const length = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > audio.length) {
      throw invalidAudio('asr_audio_invalid', 400, 'The WAV contains an incomplete chunk.');
    }
    if (id === 'fmt ') {
      if (length < 16) throw invalidAudio('asr_audio_invalid', 400, 'The WAV format chunk is incomplete.');
      format = {
        encoding: audio.readUInt16LE(start),
        channels: audio.readUInt16LE(start + 2),
        sampleRate: audio.readUInt32LE(start + 4),
        byteRate: audio.readUInt32LE(start + 8),
        blockAlign: audio.readUInt16LE(start + 12),
        bitsPerSample: audio.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      dataLength = length;
    }
    offset = end + (length & 1);
  }

  if (!format || !dataLength || format.encoding !== 1 || format.channels !== 1
    || format.sampleRate !== 16_000 || format.byteRate !== 32_000
    || format.blockAlign !== 2 || format.bitsPerSample !== 16 || dataLength % 2 !== 0) {
    throw invalidAudio('asr_audio_format_unsupported', 415,
      'Use 16 kHz mono PCM16 audio recorded in the app.');
  }
  const durationMs = Math.floor(dataLength / format.byteRate * 1000);
  if (durationMs < ACCOUNT_ASR_MIN_DURATION_MS) {
    throw invalidAudio('asr_audio_too_short', 400, 'The recording is too short to transcribe.');
  }
  if (durationMs > ACCOUNT_ASR_MAX_DURATION_MS) {
    throw invalidAudio('asr_audio_too_long', 413, 'The recording exceeds the 20 second limit.');
  }
  return { durationMs, dataBytes: dataLength };
}
