import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

const temp = await mkdtemp(join(tmpdir(), 'ragent-folder-picker-'));
process.env.RAGENT_CONFIG_DIR = join(temp, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
await mkdir(process.env.RAGENT_CONFIG_DIR, { recursive: true });
await writeFile(join(process.env.RAGENT_CONFIG_DIR, 'auth.json'), JSON.stringify({
  username: 'testowner', passwordHash: 'not-a-real-hash',
}));
const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
const isDirectoryPath = async (path) => stat(path).then((entry) => entry.isDirectory()).catch(() => false);
const writeJson = (res, status, value) => { res.statusCode = status; res.body = value; };

async function call(pathname, method, body = {}, query = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.headers = {};
  const res = {};
  await handleControlRoutes({ req, res, pathname, parsedUrl: { pathname, query },
    authSession: { role: 'owner' }, isDirectoryPath, writeJson, writeJsonCached: (req, res, value) => writeJson(res, 200, value) });
  return res;
}

try {
  const roots = await call('/api/browse', 'GET', {}, { roots: '1' });
  assert.equal(roots.statusCode, 200);
  if (process.platform !== 'win32' && homedir() !== resolve('/')) {
    assert.ok(roots.body.roots.some((root) => root.path === homedir() && root.name === 'Home'));
  }
  const created = await call('/api/browse/mkdir', 'POST', { path: temp, name: 'new-folder' });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.path, join(temp, 'new-folder'));
  assert.equal((await call('/api/browse/mkdir', 'POST', { path: temp, name: 'new-folder' })).statusCode, 409);
  assert.equal((await call('/api/browse/mkdir', 'POST', { path: temp, name: '../escape' })).statusCode, 400);
  if (process.env.RAGENT_TEST_READONLY_PARENT) {
    const denied = await call('/api/browse/mkdir', 'POST', {
      path: process.env.RAGENT_TEST_READONLY_PARENT, name: 'ragent-folder-picker-readonly-probe',
    });
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body.error, /read-only|cannot create/i);
  }
  console.log('test-project-folder-picker: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
