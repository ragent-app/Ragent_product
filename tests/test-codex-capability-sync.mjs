import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedCodexMcpAccountBinding } from '../lib/provider-runtime/codex-mcp-config.mjs';
import { nativeProviderHomeKey } from '../lib/provider-runtime/provider-home.mjs';
import { readCodexCapabilitySync, refreshCodexCapabilitySync, scheduleCodexCapabilitySync, readCodexSyncPolicy, writeCodexSyncPolicy } from '../chat/codex-capability-sync.mjs';
import { scheduleRunCapabilityDiscovery } from '../chat/run-launcher.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-capability-sync-'));
let accountId = 'account-a';
const secret = () => ({ authType: 'oauth', tokens: { account_id: accountId, access_token: 'private-fixture-token' } });
const registry = { getProviderProfile: async (id) => ({ id, agentType: 'codex', authProfileId: 'auth' }), getAuthProfile: async () => ({ storageRef: 'secret' }) };
const secretStore = { resolveSecret: async () => secret() };
const options = { configDir: root, managedHomeDir: join(root, 'homes', 'codex'), registry, secretStore };
try {
  const scheduledRuns = [];
  const schedule = (providerId, args) => scheduledRuns.push({ providerId, args });
  const homesRoot = join(root, 'homes');
  await scheduleRunCapabilityDiscovery('normal', { readManifest: async () => ({ tool: 'codex', options: { providerProfile: 'requested' }, nativeRuntimeSnapshot: { providerProfileId: 'actual' } }), schedule, homesRoot });
  await scheduleRunCapabilityDiscovery('read-only', { readManifest: async () => ({ tool: 'codex', options: { providerProfile: 'actual' }, executionScope: { accessMode: 'read' } }), schedule, homesRoot });
  await scheduleRunCapabilityDiscovery('other', { readManifest: async () => ({ tool: 'claude', options: { providerProfile: 'other' } }), schedule, homesRoot });
  assert.deepEqual(scheduledRuns, [{ providerId: 'actual', args: { managedHomeDir: join(homesRoot, 'codex') } }]);
  const binding = managedCodexMcpAccountBinding(secret());
  assert.equal(await refreshCodexCapabilitySync('provider-a', { ...options, expectedBinding: 'different-binding',
    brokerReady: async () => { throw new Error('mismatched account must not be queried'); } }), null);
  assert.equal(await readCodexSyncPolicy(root, binding), 'approved-auto');
  const pending = await refreshCodexCapabilitySync('provider-a', { ...options, brokerReady: async () => false,
    discover: async () => { throw new Error('must not start a second broker'); } });
  assert.equal(pending.status, 'waiting_for_runtime');
  assert.equal(pending.capabilities.plugins, 'unsupported');
  assert.equal((await readCodexCapabilitySync(root, binding, 'provider-a')).status, 'waiting_for_runtime');
  const found = await refreshCodexCapabilitySync('provider-a', { ...options, brokerReady: async () => true, discover: async (args) => {
    assert.equal(args.expectedAccountId, 'account-a'); assert.equal(args.existingBrokerOnly, true);
    return { apps: { ok: true }, installedApps: { ok: true }, mcp: { ok: true } };
  } });
  assert.equal(found.status, 'discovered');
  assert.equal(found.capabilities.skills, 'requires_session');
  await writeCodexSyncPolicy(root, binding, 'manual');
  assert.equal(await refreshCodexCapabilitySync('provider-a', { ...options, automatic: true, brokerReady: async () => { throw new Error('automatic discovery must not run'); } }), null);
  assert.equal((await refreshCodexCapabilitySync('provider-a', { ...options, brokerReady: async () => false })).status, 'waiting_for_runtime');
  await writeCodexSyncPolicy(root, binding, 'disabled');
  await assert.rejects(refreshCodexCapabilitySync('provider-a', { ...options, brokerReady: async () => false }), { code: 'CODEX_SYNC_DISABLED' });
  await writeCodexSyncPolicy(root, binding, 'approved-auto');
  await refreshCodexCapabilitySync('provider-a', { ...options, brokerReady: async () => true,
    discover: async () => ({ apps: { ok: true }, installedApps: { ok: true }, mcp: { ok: true } }) });
  const saved = await readFile(join(root, 'native-provider-runtime', 'codex-capability-sync', 'by-account', binding, `${nativeProviderHomeKey('codex', 'provider-a')}.json`), 'utf8');
  assert.doesNotMatch(saved, /account-a|private-fixture-token/);
  const switched = await refreshCodexCapabilitySync('provider-a', { ...options, brokerReady: async () => true, discover: async () => {
    accountId = 'account-b'; return { apps: { ok: true }, installedApps: { ok: true }, mcp: { ok: true } };
  } });
  assert.equal(switched, null);
  assert.equal(await readCodexCapabilitySync(root, managedCodexMcpAccountBinding(secret()), 'provider-a'), null);
  assert.equal(await readCodexCapabilitySync(root, binding, 'provider-b'), null, 'another provider cannot borrow a discovery result before handoff');
  assert.equal((await readCodexCapabilitySync(root, binding, 'provider-a')).status, 'discovered');
  accountId = 'account-a';
  await refreshCodexCapabilitySync('provider-a', { ...options, brokerReady: async () => false });
  let attempts = 0;
  const retryOptions = { ...options, retryDelaysMs: [0, 1], brokerReady: async () => ++attempts >= 2,
    discover: async () => ({ apps: { ok: true }, installedApps: { ok: true }, mcp: { ok: true } }) };
  scheduleCodexCapabilitySync('provider-a', retryOptions);
  scheduleCodexCapabilitySync('provider-a', retryOptions);
  const deadline = Date.now() + 15_000;
  while ((await readCodexCapabilitySync(root, binding, 'provider-a')).status !== 'discovered' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await readCodexCapabilitySync(root, binding, 'provider-a')).status, 'discovered');
  assert.equal(attempts, 2, 'concurrent refresh scheduling should be coalesced and retry after startup');
  // Use a separate scheduling key: persisted discovery can become visible
  // just before the first scheduled callback finishes its bookkeeping.
  await refreshCodexCapabilitySync('provider-b', { ...options, brokerReady: async () => false });
  let lastAttemptReached;
  const reached = new Promise((resolve) => { lastAttemptReached = resolve; });
  let releaseLastAttempt;
  const release = new Promise((resolve) => { releaseLastAttempt = resolve; });
  let lateAttempts = 0;
  const lateOptions = { ...options, retryDelaysMs: [0, 1], brokerReady: async () => {
    lateAttempts += 1;
    if (lateAttempts === 2) { lastAttemptReached(); await release; }
    return lateAttempts >= 3;
  }, discover: async () => ({ apps: { ok: true }, installedApps: { ok: true }, mcp: { ok: true } }) };
  scheduleCodexCapabilitySync('provider-b', lateOptions);
  let timeout;
  try { await Promise.race([reached, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('final retry did not start')), 15_000); })]); }
  finally { clearTimeout(timeout); }
  scheduleCodexCapabilitySync('provider-b', lateOptions);
  releaseLastAttempt();
  const lateDeadline = Date.now() + 15_000;
  while ((await readCodexCapabilitySync(root, binding, 'provider-b')).status !== 'discovered' && Date.now() < lateDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await readCodexCapabilitySync(root, binding, 'provider-b')).status, 'discovered');
  assert.equal(lateAttempts, 3, 'a task launched during the final login retry must get its own retry window');
  // An initialized broker can still return a transient App catalog error.
  // Retry it rather than leaving a partially discovered account until a new Run.
  let catalogAttempts = 0;
  const partialOptions = { ...options, retryDelaysMs: [0, 1], brokerReady: async () => true,
    discover: async () => {
      catalogAttempts += 1;
      return { apps: { ok: catalogAttempts > 1 }, installedApps: { ok: true }, mcp: { ok: true } };
    } };
  scheduleCodexCapabilitySync('provider-c', partialOptions);
  const partialDeadline = Date.now() + 15_000;
  while ((await readCodexCapabilitySync(root, binding, 'provider-c'))?.status !== 'discovered' && Date.now() < partialDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await readCodexCapabilitySync(root, binding, 'provider-c'))?.status, 'discovered');
  assert.equal(catalogAttempts, 2, 'partial App discovery should be retried');
  console.log('Codex capability sync tests passed');
} finally { await rm(root, { recursive: true, force: true }); }
