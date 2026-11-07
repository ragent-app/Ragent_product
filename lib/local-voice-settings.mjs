import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { UI_LOCAL_VOICE_SETTINGS_FILE } from './config.mjs';

let pendingWrite = Promise.resolve();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeLocalVoiceSettings(value = {}) {
  return {
    enabled: value?.enabled === true,
    updatedAt: trimString(value?.updatedAt),
  };
}

export async function loadLocalVoiceSettings(filePathOrOptions, options = {}) {
  const filePath = typeof filePathOrOptions === 'string' ? filePathOrOptions : undefined;
  const defaultEnabled = typeof filePathOrOptions === 'object' && filePathOrOptions !== null
    ? filePathOrOptions.defaultEnabled === true : options.defaultEnabled === true;
  try {
    return normalizeLocalVoiceSettings(JSON.parse(await readFile(filePath || UI_LOCAL_VOICE_SETTINGS_FILE, 'utf8')));
  } catch (error) {
    // A first installation that includes Whisper has no preference file yet.
    // A persisted value (including false) always wins on upgrades/restarts.
    if (error?.code === 'ENOENT') return normalizeLocalVoiceSettings({ enabled: defaultEnabled });
    return normalizeLocalVoiceSettings();
  }
}

export async function saveLocalVoiceSettings(value = {}, filePath) {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') {
    throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 });
  }
  const targetPath = filePath || UI_LOCAL_VOICE_SETTINGS_FILE;
  const next = normalizeLocalVoiceSettings({ enabled: value.enabled, updatedAt: new Date().toISOString() });
  pendingWrite = pendingWrite.catch(() => {}).then(async () => {
    await mkdir(dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tempPath, targetPath);
  });
  await pendingWrite;
  return next;
}
