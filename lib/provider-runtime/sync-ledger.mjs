// Local Provider sync ledger. It stores only sync keys, versions, and
// tombstones; provider rows and credential values remain outside this file.

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import {
  normalizeAccountSyncRecord,
  mergeAccountSyncRecords,
  normalizeSyncVersion,
} from './sync.mjs';
import { normalizeSyncScope, syncRecordIdentity } from '../account-sync.mjs';
import { parseProviderDataJson } from './json-data.mjs';

export const PROVIDER_SYNC_LEDGER_VERSION = 1;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function ledgerRecord(record) {
  const scope = normalizeSyncScope(record?.scope, 'provider');
  if (!scope) throw new Error('Provider sync ledger record scope is invalid');
  if (!record?.provider && !record?.auth && !record?.secret) {
    const key = trimString(record?.key || record?.syncId);
    if (!key) throw new Error('Provider sync ledger record key is missing');
    return {
      ...(scope !== 'provider' ? { scope } : {}),
      key,
      version: normalizeSyncVersion(record.version),
      ...(record.deletedAt ? { deletedAt: trimString(record.deletedAt) } : {}),
    };
  }
  const normalized = normalizeAccountSyncRecord(record);
  return {
    ...(scope !== 'provider' ? { scope } : {}),
    key: normalized.key,
    version: normalized.version,
    ...(normalized.deletedAt ? { deletedAt: normalized.deletedAt } : {}),
  };
}

function normalizeState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const records = Array.isArray(source.records)
    ? source.records.map((record) => ledgerRecord(record)).filter(Boolean)
    : [];
  return {
    version: PROVIDER_SYNC_LEDGER_VERSION,
    ...(source.recoveryRequired === true ? { recoveryRequired: true } : {}),
    counter: Number.isSafeInteger(Number(source.counter)) && Number(source.counter) >= 0
      ? Number(source.counter)
      : 0,
    records,
  };
}

export function createProviderSyncLedger({
  configDir,
  filePath = '',
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  renameImpl = rename,
} = {}) {
  const targetPath = filePath || join(configDir, 'native-provider-runtime', 'provider-sync-ledger.json');

  async function readState() {
    try {
      return normalizeState(parseProviderDataJson(await readFileImpl(targetPath, 'utf8'), 'provider-sync-ledger.json'));
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeState(null);
      throw error;
    }
  }

  async function writeState(state) {
    await mkdirImpl(dirname(targetPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await writeFileImpl(temporaryPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { mode: 0o600, flush: true });
    await renameImpl(temporaryPath, targetPath);
  }

  async function nextVersion(writerId, updatedAt = new Date().toISOString()) {
    const state = await readState();
    state.counter += 1;
    const version = {
      updatedAt,
      counter: state.counter,
      writerId: trimString(writerId),
    };
    await writeState(state);
    return version;
  }

  async function merge(incoming = []) {
    const state = await readState();
    const result = mergeAccountSyncRecords(state.records, incoming);
    state.records = result.records.map((record) => ledgerRecord(record));
    await writeState(state);
    return result;
  }

  return {
    path: targetPath,
    readState,
    writeState,
    nextVersion,
    merge,
    identity: (record) => syncRecordIdentity(record?.scope || 'provider', record?.key || record?.syncId),
  };
}
