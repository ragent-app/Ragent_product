#!/usr/bin/env node
// HTTP CRUD Idempotency-Key tests for chat/router-control-routes.mjs:
//  - Bounded receipt cache (TTL, 1024 max entries with oldest eviction, concurrency coalescing)
//  - DELETE /api/projects/:id, POST /api/projects/:id/delete, PATCH /api/projects/:id
//  - DELETE /api/sessions/:id, PATCH /api/sessions/:id
//  - Replay returns recorded 200 without re-executing; absent DELETE returns
//    { deleted: true, alreadyDeleted: true, id } with Idempotency-Key and 404 without it.
import assert from 'assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = await mkdtemp(join(tmpdir(), 'ragent-crud-idempotency-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

await mkdir(process.env.RAGENT_CONFIG_DIR, { recursive: true });
await writeFile(join(process.env.RAGENT_CONFIG_DIR, 'auth.json'), JSON.stringify({
  username: 'testowner',
  passwordHash: 'not-a-real-hash',
}), 'utf8');

const { handleControlRoutes, createCrudIdempotencyStore } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'router-control-routes.mjs')).href
);
const { createProject, getProject } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'projects.mjs')).href
);
const {
  createSession,
  getSession,
  killAll,
} = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const { withSessionsMetaMutation } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href
);
const { CHAT_RUNS_DIR } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'config.mjs')).href
);

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function makeReq(method, body, headers = {}) {
  const hasBody = body !== undefined && body !== null;
  const chunk = hasBody
    ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    : null;
  return {
    method,
    headers: { host: 'a.ragent.test', ...headers },
    on(event, handler) {
      if (event === 'data' && chunk) queueMicrotask(() => handler(chunk));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    destroy() {},
  };
}

async function dispatchControlRoute(method, pathname, {
  body,
  headers = {},
  authSession = { role: 'owner' },
  requireSessionAccess = async (res, session) => {
    if (session?.role === 'owner') return true;
    writeJson(res, 403, { error: 'Access denied' });
    return false;
  },
} = {}) {
  const res = makeRes();
  const handled = await handleControlRoutes({
    req: makeReq(method, body, headers),
    res,
    parsedUrl: { pathname, query: {} },
    pathname,
    authSession,
    requireSessionAccess,
    writeJson,
    writeJsonCached: writeJson,
  });
  assert.equal(handled, true, `${method} ${pathname} should be handled by control routes`);
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

try {
  // ── 1. Bounded receipt store unit checks (keying, TTL, eviction, coalescing) ──
  let fakeNow = 1_000_000;
  const store = createCrudIdempotencyStore({
    ttlMs: 5 * 60 * 1000,
    maxEntries: 3,
    now: () => fakeNow,
  });

  assert.equal(
    store.buildKey('delete', '/api/projects/prj_1', ' key-1 '),
    'DELETE:/api/projects/prj_1:key-1',
    'cache key should use ${method}:${path}:${idempotencyKey}',
  );
  assert.equal(store.buildKey('DELETE', '/api/projects/prj_1', '   '), '');

  let execCount = 0;
  const first = await store.run('PATCH', '/api/projects/prj_1', 'k1', async () => {
    execCount += 1;
    return { status: 200, payload: { count: execCount, nested: { ok: true } } };
  });
  assert.equal(first.replayed, false);
  assert.equal(first.outcome.status, 200);
  first.outcome.payload.nested.ok = false;

  const replaySame = await store.run('PATCH', '/api/projects/prj_1', 'k1', async () => {
    execCount += 1;
    return { status: 200, payload: { count: execCount } };
  });
  assert.equal(replaySame.replayed, true);
  assert.equal(execCount, 1, 'replay must not re-execute mutation');
  assert.deepEqual(replaySame.outcome.payload, { count: 1, nested: { ok: true } });

  // Different method or path with same key must NOT collide.
  const diffMethod = await store.run('DELETE', '/api/projects/prj_1', 'k1', async () => {
    execCount += 1;
    return { status: 200, payload: { count: execCount } };
  });
  assert.equal(diffMethod.replayed, false);
  assert.equal(execCount, 2);

  // Non-200 errors must not be cached.
  const errAttempt = await store.run('DELETE', '/api/projects/prj_2', 'k-err', async () => {
    execCount += 1;
    return { status: 409, payload: { error: 'conflict' } };
  });
  assert.equal(errAttempt.outcome.status, 409);
  const retryAfterErr = await store.run('DELETE', '/api/projects/prj_2', 'k-err', async () => {
    execCount += 1;
    return { status: 200, payload: { recovered: true } };
  });
  assert.equal(retryAfterErr.replayed, false);
  assert.equal(retryAfterErr.outcome.status, 200);
  assert.deepEqual(retryAfterErr.outcome.payload, { recovered: true });

  // Bounded eviction (maxEntries = 3): k1(PATCH), k1(DELETE), k-err are in cache; adding 4th evicts k1(PATCH).
  assert.equal(store.size, 3);
  await store.run('PATCH', '/api/sessions/s1', 'k4', async () => {
    execCount += 1;
    return { status: 200, payload: { count: execCount } };
  });
  assert.equal(store.size, 3);
  const afterEvict = await store.run('PATCH', '/api/projects/prj_1', 'k1', async () => {
    execCount += 1;
    return { status: 200, payload: { count: execCount } };
  });
  assert.equal(afterEvict.replayed, false, 'oldest receipt must be evicted when maxEntries is exceeded');

  // TTL expiry.
  fakeNow += 5 * 60 * 1000 + 1;
  assert.equal(store.size, 0, 'entries past TTL should expire');

  // Concurrent in-flight coalescing.
  let concurrentExecs = 0;
  let releaseConcurrent;
  const gate = new Promise((resolve) => { releaseConcurrent = resolve; });
  const p1 = store.run('PATCH', '/api/sessions/s2', 'k-concurrent', async () => {
    concurrentExecs += 1;
    await gate;
    return { status: 200, payload: { seq: concurrentExecs } };
  });
  const p2 = store.run('PATCH', '/api/sessions/s2', 'k-concurrent', async () => {
    concurrentExecs += 1;
    return { status: 200, payload: { seq: concurrentExecs } };
  });
  releaseConcurrent();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(concurrentExecs, 1, 'concurrent duplicate requests should coalesce into one execution');
  assert.equal(r1.outcome.payload.seq, 1);
  assert.equal(r2.outcome.payload.seq, 1);
  assert.equal(r2.replayed, true);

  // Default store bounds at 1024 entries.
  const defaultStore = createCrudIdempotencyStore();
  for (let i = 0; i < 1030; i += 1) {
    defaultStore.set(`DELETE:/api/sessions/s_${i}:k_${i}`, { deleted: true, i });
  }
  assert.equal(defaultStore.size, 1024, 'default receipt store should cap at 1024 entries');
  assert.equal(defaultStore.get('DELETE:/api/sessions/s_0:k_0'), null, 'oldest entry beyond 1024 should be evicted');
  assert.deepEqual(defaultStore.get('DELETE:/api/sessions/s_1029:k_1029'), { deleted: true, i: 1029 });

  // ── 2. PATCH /api/projects/:id idempotent replay + auth check ─────────────
  const rootPatch = join(tempHome, 'proj-patch');
  await mkdir(rootPatch, { recursive: true });
  const projPatch = await createProject({ name: 'Patch Initial', rootPath: rootPatch });
  assert.equal(projPatch.revision, 1);

  const patchRes1 = await dispatchControlRoute('PATCH', `/api/projects/${projPatch.id}`, {
    body: { name: 'Patch Updated Once', pinned: true },
    headers: { 'Idempotency-Key': 'proj-patch-key-1' },
  });
  assert.equal(patchRes1.status, 200);
  assert.equal(patchRes1.body.project.name, 'Patch Updated Once');
  assert.equal(patchRes1.body.project.pinned, true);
  assert.equal((await getProject(projPatch.id)).revision, 2);

  // Apply a second distinct PATCH so we can prove replaying key-1 returns key-1's
  // recorded 200 snapshot without re-executing updateProject.
  const patchRes2 = await dispatchControlRoute('PATCH', `/api/projects/${projPatch.id}`, {
    body: { name: 'Patch Updated Twice' },
    headers: { 'idempotency-key': 'proj-patch-key-2' },
  });
  assert.equal(patchRes2.status, 200);
  assert.equal(patchRes2.body.project.name, 'Patch Updated Twice');
  assert.equal((await getProject(projPatch.id)).revision, 3);

  const patchReplay = await dispatchControlRoute('PATCH', `/api/projects/${projPatch.id}`, {
    body: { name: 'Patch Updated Once', pinned: true },
    headers: { 'Idempotency-Key': 'proj-patch-key-1' },
  });
  assert.equal(patchReplay.status, 200);
  assert.deepEqual(patchReplay.body, patchRes1.body, 'project PATCH replay must return exact recorded 200 response');
  assert.equal((await getProject(projPatch.id)).revision, 3, 'replayed PATCH must not re-execute mutation');

  // Non-owner must never receive cached receipt.
  const unauthReplay = await dispatchControlRoute('PATCH', `/api/projects/${projPatch.id}`, {
    body: { name: 'Patch Updated Once' },
    headers: { 'Idempotency-Key': 'proj-patch-key-1' },
    authSession: { role: 'visitor' },
  });
  assert.equal(unauthReplay.status, 403);

  // ── 3. DELETE /api/projects/:id and POST /api/projects/:id/delete ─────────
  const rootDel = join(tempHome, 'proj-del');
  await mkdir(rootDel, { recursive: true });
  const projDel = await createProject({ name: 'Delete Me', rootPath: rootDel });
  await withSessionsMetaMutation(async (metas, save) => {
    metas.push({ id: 'sess_proj_del_1', projectId: projDel.id, folder: rootDel, createdAt: new Date().toISOString() });
    await save(metas, { immediate: true });
  });

  const delProjRes1 = await dispatchControlRoute('DELETE', `/api/projects/${projDel.id}`, {
    body: { deleteSessions: false },
    headers: { 'Idempotency-Key': 'proj-del-key-1' },
  });
  assert.equal(delProjRes1.status, 200);
  assert.equal(delProjRes1.body.detachedSessionCount, 1);

  const delProjReplay = await dispatchControlRoute('DELETE', `/api/projects/${projDel.id}`, {
    body: { deleteSessions: false },
    headers: { 'Idempotency-Key': 'proj-del-key-1' },
  });
  assert.equal(delProjReplay.status, 200);
  assert.deepEqual(delProjReplay.body, delProjRes1.body, 'project DELETE replay must return exact recorded 200 payload');

  const delProjAbsentWithKey = await dispatchControlRoute('DELETE', `/api/projects/${projDel.id}`, {
    body: { deleteSessions: false },
    headers: { 'Idempotency-Key': 'proj-del-key-fresh' },
  });
  assert.equal(delProjAbsentWithKey.status, 200);
  assert.deepEqual(delProjAbsentWithKey.body, {
    deleted: true,
    alreadyDeleted: true,
    id: projDel.id,
  });

  const delProjAbsentNoKey = await dispatchControlRoute('DELETE', `/api/projects/${projDel.id}`, {
    body: { deleteSessions: false },
  });
  assert.equal(delProjAbsentNoKey.status, 404, 'DELETE project without Idempotency-Key must preserve 404');

  const delProjBlankKey = await dispatchControlRoute('DELETE', `/api/projects/${projDel.id}`, {
    body: { deleteSessions: false },
    headers: { 'Idempotency-Key': '   ' },
  });
  assert.equal(delProjBlankKey.status, 404, 'whitespace Idempotency-Key must be treated as absent');

  // Compat POST /api/projects/:id/delete
  const rootCompat = join(tempHome, 'proj-compat-del');
  await mkdir(rootCompat, { recursive: true });
  const projCompat = await createProject({ name: 'Compat Delete', rootPath: rootCompat });

  const compatRes1 = await dispatchControlRoute('POST', `/api/projects/${projCompat.id}/delete`, {
    body: { deleteSessions: true },
    headers: { 'Idempotency-Key': 'proj-compat-key-1' },
  });
  assert.equal(compatRes1.status, 200);
  assert.equal(compatRes1.body.project.id, projCompat.id);

  const compatReplay = await dispatchControlRoute('POST', `/api/projects/${projCompat.id}/delete`, {
    body: { deleteSessions: true },
    headers: { 'Idempotency-Key': 'proj-compat-key-1' },
  });
  assert.equal(compatReplay.status, 200);
  assert.deepEqual(compatReplay.body, compatRes1.body);

  const compatAbsentWithKey = await dispatchControlRoute('POST', `/api/projects/${projCompat.id}/delete`, {
    body: { deleteSessions: true },
    headers: { 'Idempotency-Key': 'proj-compat-key-fresh' },
  });
  assert.equal(compatAbsentWithKey.status, 200);
  assert.deepEqual(compatAbsentWithKey.body, {
    deleted: true,
    alreadyDeleted: true,
    id: projCompat.id,
  });

  const compatAbsentNoKey = await dispatchControlRoute('POST', `/api/projects/${projCompat.id}/delete`, {
    body: { deleteSessions: true },
  });
  assert.equal(compatAbsentNoKey.status, 404);

  // Active-run 409 conflict must not be cached; retry with same key succeeds once run completes.
  const rootConflict = join(tempHome, 'proj-conflict-del');
  await mkdir(rootConflict, { recursive: true });
  const projConflict = await createProject({ name: 'Conflict Delete', rootPath: rootConflict });
  await withSessionsMetaMutation(async (metas, save) => {
    metas.push({
      id: 'sess_proj_active',
      projectId: projConflict.id,
      folder: rootConflict,
      activeRunId: 'run_active_idemp',
      createdAt: new Date().toISOString(),
    });
    await save(metas, { immediate: true });
  });
  await mkdir(join(CHAT_RUNS_DIR, 'run_active_idemp'), { recursive: true });
  await writeFile(
    join(CHAT_RUNS_DIR, 'run_active_idemp', 'status.json'),
    JSON.stringify({ id: 'run_active_idemp', state: 'running' }),
    'utf8',
  );

  const conflictRes = await dispatchControlRoute('DELETE', `/api/projects/${projConflict.id}`, {
    body: { deleteSessions: true },
    headers: { 'Idempotency-Key': 'proj-conflict-key-1' },
  });
  assert.equal(conflictRes.status, 409);

  await writeFile(
    join(CHAT_RUNS_DIR, 'run_active_idemp', 'status.json'),
    JSON.stringify({ id: 'run_active_idemp', state: 'completed' }),
    'utf8',
  );
  const resolvedRes = await dispatchControlRoute('DELETE', `/api/projects/${projConflict.id}`, {
    body: { deleteSessions: true },
    headers: { 'Idempotency-Key': 'proj-conflict-key-1' },
  });
  assert.equal(resolvedRes.status, 200, 'same Idempotency-Key after 409 should execute once run finishes');

  // ── 4. PATCH /api/sessions/:id & DELETE /api/sessions/:id ─────────────────
  const sessFolder = join(tempHome, 'sess-ws');
  await mkdir(sessFolder, { recursive: true });
  const createdSess = await createSession(sessFolder, 'codex', 'Initial Session');

  const sessPatch1 = await dispatchControlRoute('PATCH', `/api/sessions/${createdSess.id}`, {
    body: { name: 'Session Renamed One', pinned: true },
    headers: { 'Idempotency-Key': 'sess-patch-key-1' },
  });
  assert.equal(sessPatch1.status, 200);
  assert.equal(sessPatch1.body.session.name, 'Session Renamed One');
  assert.equal(sessPatch1.body.session.pinned, true);

  const sessPatch2 = await dispatchControlRoute('PATCH', `/api/sessions/${createdSess.id}`, {
    body: { name: 'Session Renamed Two' },
    headers: { 'Idempotency-Key': 'sess-patch-key-2' },
  });
  assert.equal(sessPatch2.status, 200);
  assert.equal(sessPatch2.body.session.name, 'Session Renamed Two');

  const sessPatchReplay = await dispatchControlRoute('PATCH', `/api/sessions/${createdSess.id}`, {
    body: { name: 'Session Renamed One', pinned: true },
    headers: { 'Idempotency-Key': 'sess-patch-key-1' },
  });
  assert.equal(sessPatchReplay.status, 200);
  assert.deepEqual(sessPatchReplay.body, sessPatch1.body, 'session PATCH replay must return recorded 200 response');
  assert.equal((await getSession(createdSess.id)).name, 'Session Renamed Two', 'replayed session PATCH must not re-execute');

  const sessPatchMissing = await dispatchControlRoute('PATCH', '/api/sessions/sess_does_not_exist', {
    body: { pinned: true },
    headers: { 'Idempotency-Key': 'sess-patch-missing' },
  });
  assert.equal(sessPatchMissing.status, 404);

  const sessDel1 = await dispatchControlRoute('DELETE', `/api/sessions/${createdSess.id}`, {
    headers: { 'Idempotency-Key': 'sess-del-key-1' },
  });
  assert.equal(sessDel1.status, 200);
  assert.deepEqual(sessDel1.body, { deleted: true, sessionId: createdSess.id });

  const sessDelReplay = await dispatchControlRoute('DELETE', `/api/sessions/${createdSess.id}`, {
    headers: { 'Idempotency-Key': 'sess-del-key-1' },
  });
  assert.equal(sessDelReplay.status, 200);
  assert.deepEqual(sessDelReplay.body, sessDel1.body, 'session DELETE replay must return recorded 200 payload');

  const sessDelAbsentWithKey = await dispatchControlRoute('DELETE', `/api/sessions/${createdSess.id}`, {
    headers: { 'Idempotency-Key': 'sess-del-key-fresh' },
  });
  assert.equal(sessDelAbsentWithKey.status, 200);
  assert.deepEqual(sessDelAbsentWithKey.body, {
    deleted: true,
    alreadyDeleted: true,
    id: createdSess.id,
  });

  const sessDelAbsentNoKey = await dispatchControlRoute('DELETE', `/api/sessions/${createdSess.id}`);
  assert.equal(sessDelAbsentNoKey.status, 404, 'DELETE session without Idempotency-Key must preserve 404');

  console.log('test-crud-idempotency: ok');
} finally {
  killAll();
  await rm(tempHome, { recursive: true, force: true });
}
