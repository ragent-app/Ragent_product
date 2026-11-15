import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-intake-capabilities-'));
process.env.RAGENT_CONFIG_DIR = root;
try {
  const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
  const request = async (authSession) => {
    const response = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status) { this.statusCode = status; },
      end(body = '') { this.body = body; },
    };
    const handled = await handleControlRoutes({
      req: { method: 'GET' }, res: response,
      pathname: '/api/intake/capabilities', authSession,
      writeJson(res, status, payload) { res.writeHead(status); res.end(JSON.stringify(payload)); },
    });
    assert.equal(handled, true);
    return response;
  };
  const owner = await request({ role: 'owner', principalKind: 'trusted_device' });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.headers['cache-control'], 'private, no-store');
  assert.deepEqual(JSON.parse(owner.body), {
    protocolVersion: 1, projectRouting: true, projectCreation: true,
  });
  for (const principal of [{ role: 'visitor' }, { role: 'owner', principalKind: 'run_capability' }]) {
    assert.equal((await request(principal)).statusCode, 403);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('test-intake-capability-route: ok');
