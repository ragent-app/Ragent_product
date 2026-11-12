import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const root = await mkdtemp(join(tmpdir(), 'ragent-skill-route-'));
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
process.env.AGENTOC_MEMORY_DIR = join(root, 'memory');
await mkdir(process.env.AGENTOC_CONFIG_DIR, { recursive: true });
const meta = await import('../chat/session-meta-store.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
await meta.withSessionsMetaMutation(async (rows, save) => {
  rows.push({ id: 'session-1', name: 'Skill route test', folder: root, tool: 'codex', providerProfile: 'profile-a', sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true });
  rows.push({ id: 'session-model', name: 'Model-scoped Skill test', folder: root, tool: 'codex', model: 'gpt-5@profile-a', sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true });
  rows.push({ id: 'session-unknown', name: 'Unknown account Skill test', folder: root, tool: 'codex', sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true });
  await save(rows, { immediate: true, durable: true });
});
async function route(role, body, sessionId = 'session-1') {
  const path = `/api/sessions/${sessionId}/harness-capabilities/skills`;
  const req = new PassThrough(); req.method = 'POST'; req.url = path; req.headers = {};
  const res = {};
  let checks = 0;
  const done = handleSessionMainRoutes({ req, res, pathname: path, parsedUrl: new URL(path, 'http://localhost'), authSession: { role },
    requireSessionAccess: async () => { checks++; return true; },
    writeJson: (_res, status, value) => { res.status = status; res.body = value; } });
  req.end(JSON.stringify(body));
  assert.equal(await done, true);
  return { ...res, checks };
}
const visitor = await route('visitor', { providerProfileId: 'profile-a', id: 'codex:skill:aaaaaaaaaaaaaaaaaaaa', enabled: false });
assert.equal(visitor.status, 403);
assert.equal(visitor.checks, 0, 'visitor must not reach Skill management');
const stale = await route('owner', { providerProfileId: 'profile-b', id: 'codex:skill:aaaaaaaaaaaaaaaaaaaa', enabled: false });
assert.equal(stale.status, 409);
assert.equal(stale.body.code, 'CODEX_SKILL_ACCOUNT_CHANGED');
assert.equal(stale.checks, 1, 'owner must have access to the selected session');
const modelMismatch = await route('owner', { providerProfileId: 'profile-b', id: 'codex:skill:aaaaaaaaaaaaaaaaaaaa', enabled: false }, 'session-model');
assert.equal(modelMismatch.status, 409, 'model-scoped account must not accept a different provider');
const unknownAccount = await route('owner', { providerProfileId: 'profile-a', id: 'codex:skill:aaaaaaaaaaaaaaaaaaaa', enabled: false }, 'session-unknown');
assert.equal(unknownAccount.status, 409, 'unknown default account must not be guessed from the client request');
await meta.flushSessionsMetaNow();
console.log('Codex Skill route authorization tests passed');
