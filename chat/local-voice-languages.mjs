import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../shared/whisper-languages.json', import.meta.url), 'utf8'));

export const whisperLanguageCodes = Object.freeze(catalog.map(({ code }) => code));
export const localVoiceLanguageCodes = new Set(['auto', ...whisperLanguageCodes]);

export function normalizeLocalVoiceLanguage(language = 'auto') {
  if (typeof language !== 'string' || !localVoiceLanguageCodes.has(language)) {
    throw Object.assign(new Error('Local voice transcription is unavailable'), { code: 'VOICE_LANGUAGE_INVALID' });
  }
  return language;
}
