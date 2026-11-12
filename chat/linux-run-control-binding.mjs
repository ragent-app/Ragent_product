// A protected, immutable binding for a runner's deny-only completion signal.
// It contains a token hash, never the bearer token. The configured control
// directory must be inaccessible to the distinct runner identity.
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { ensureLinuxRunCancelIntentStore } from './linux-run-cancel-intent.mjs';
import { computeExecutionScopeDigest } from './execution-scope.mjs';

const DIRECTORY = join(CONFIG_DIR, 'linux-run-cancel-intents');
function invalid() { throw Object.assign(new Error('Linux Run control binding unavailable'), { code: 'LINUX_RUN_CONTROL_BINDING_INVALID' }); }
function pathFor(runId, attempt) {
  if (typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(runId) ||
      !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 10000) invalid();
  return join(DIRECTORY, `${createHash('sha256').update(runId, 'utf8').digest('hex')}-${attempt}.binding.json`);
}
function identity(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function hashToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) invalid();
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) invalid();
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
async function readBinding(filename, { synchronize = false } = {}) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 ||
        stat.size < 1 || stat.size > 4096) invalid();
    const value = JSON.parse(await file.readFile('utf8'));
    if (synchronize) await file.sync();
    return value;
  } finally { await file.close(); }
}
async function syncDirectory() {
  const dir = await open(DIRECTORY, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
function validBindingShape(binding) {
  const keys = ['version', 'runId', 'sessionId', 'turnId', 'launchAttempt', 'tokenHash', 'publicationId', 'scopeDigest'];
  const peerResult = binding?.resultChannel === 'peer-v1';
  return binding && typeof binding === 'object' && !Array.isArray(binding) && Object.keys(binding).length === keys.length + (peerResult ? 1 : 0) &&
    keys.every((key) => Object.hasOwn(binding, key)) && binding.version === 1 &&
    typeof binding.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(binding.tokenHash);
}
export async function persistLinuxRunControlBinding({ run, manifest, launchAttempt, resultChannel = 'legacy' } = {}) {
  if (!['legacy', 'peer-v1'].includes(resultChannel)) invalid();
  await ensureLinuxRunCancelIntentStore();
  const filename = pathFor(run?.id, launchAttempt), channel = manifest?.options?.approvedActionChannel;
  const digest = hashToken(channel?.token);
  if (channel?.tokenHash !== digest || manifest?.id !== run.id || manifest?.sessionId !== run.sessionId ||
      manifest?.requestId !== run.requestId || channel?.turnId !== run.requestId) invalid();
  const binding = { version: 1, runId: run.id, sessionId: identity(run.sessionId), turnId: identity(run.requestId),
    launchAttempt, tokenHash: digest, publicationId: identity(run?.runPublication?.publicationId),
    scopeDigest: identity(manifest?.executionScopeDigest), ...(resultChannel === 'peer-v1' ? { resultChannel } : {}) };
  let file;
  try {
    try { file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readBinding(filename, { synchronize: true });
      if (JSON.stringify(existing) !== JSON.stringify(binding)) invalid();
      await syncDirectory();
      return;
    }
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(binding)}\n`, 'utf8');
    await file.sync();
  } finally { if (file) await file.close(); }
  await syncDirectory();
}
export async function verifyLinuxRunControlBinding({ runId, sessionId, turnId, launchAttempt, token } = {}) {
  try {
    await ensureLinuxRunCancelIntentStore();
    const binding = await readBinding(pathFor(runId, launchAttempt));
    if (!validBindingShape(binding) || binding.runId !== runId || binding.sessionId !== sessionId || binding.turnId !== turnId ||
        binding.launchAttempt !== launchAttempt) invalid();
    const presented = Buffer.from(hashToken(token), 'hex'), expected = Buffer.from(binding.tokenHash, 'hex');
    return timingSafeEqual(presented, expected);
  } catch { return false; }
}
export async function matchesLinuxRunControlBinding({ run, manifest, launchAttempt } = {}) {
  try {
    await ensureLinuxRunCancelIntentStore();
    const binding = await readBinding(pathFor(run?.id, launchAttempt));
    return Boolean(validBindingShape(binding) && binding.runId === run.id && binding.sessionId === run.sessionId &&
      binding.turnId === run.requestId && binding.launchAttempt === launchAttempt &&
      binding.publicationId === run.runPublication?.publicationId && binding.scopeDigest === manifest?.executionScopeDigest &&
      binding.scopeDigest === computeExecutionScopeDigest(manifest?.executionScope) &&
      binding.tokenHash === manifest?.options?.approvedActionChannel?.tokenHash);
  } catch { return false; }
}

export async function hasLinuxRunControlBinding(runId, launchAttempt) {
  // Older ordinary Runs cannot have been registered by this protocol.
  if (typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(runId)) return false;
  if (!Number.isSafeInteger(launchAttempt) || launchAttempt < 0 || launchAttempt > 10000) invalid();
  try { await lstat(pathFor(runId, launchAttempt)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// The caller still verifies the live Run and manifest separately. This is only
// for persisting an immutable completion receipt in the same protected store.
export async function readLinuxRunControlBindingRecord(runId, launchAttempt) {
  await ensureLinuxRunCancelIntentStore();
  const binding = await readBinding(pathFor(runId, launchAttempt));
  if (!validBindingShape(binding) || binding.runId !== runId || binding.launchAttempt !== launchAttempt) invalid();
  return binding;
}

// Recover transport policy independently of runner-writable status.json. A
// missing or changed launch attempt must not hide an earlier peer binding.
export async function listLinuxRunControlBindings(runId) {
  pathFor(runId, 0);
  try { await lstat(DIRECTORY); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  await ensureLinuxRunCancelIntentStore();
  const prefix = `${createHash('sha256').update(runId, 'utf8').digest('hex')}-`;
  const bindings = [];
  for (const name of await readdir(DIRECTORY)) {
    if (!name.startsWith(prefix) || !name.endsWith('.binding.json')) continue;
    const attempt = name.slice(prefix.length, -'.binding.json'.length);
    if (!/^(0|[1-9][0-9]{0,4})$/.test(attempt) || Number(attempt) > 10000) invalid();
    bindings.push(await readLinuxRunControlBindingRecord(runId, Number(attempt)));
  }
  return bindings.sort((a, b) => a.launchAttempt - b.launchAttempt);
}
