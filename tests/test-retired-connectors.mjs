#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-retired-connectors-'));
process.env.HOME = root;
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
process.env.AGENTOC_MEMORY_DIR = join(root, 'memory');

try {
  const { registerConnectorSurface, getConnectorSurface } = await import('../lib/connector-surface-registry.mjs');
  const { handleConnectorApiRoutes, handleConnectorSurfaceRoutes } = await import('../chat/router-connector-routes.mjs');
  const owner = { role: 'owner' };
  const ids = ['feishu', 'lark', 'wechat', 'weixin'];
  for (const connectorId of ids) {
    await registerConnectorSurface({ connectorId, baseUrl: 'http://127.0.0.1:9' });
  }
  const bindingsPath = join(root, 'config', 'connector-bindings.json');
  await mkdir(dirname(bindingsPath), { recursive: true });
  const bindings = ids.map((connectorId) => ({ id: `legacy-${connectorId}`, connectorId }));
  await writeFile(bindingsPath, JSON.stringify({ version: 1, bindings }));
  let response;
  const writeJson = (_res, status, body) => { response = { status, body }; };
  const opts = { req: { method: 'GET' }, res: {}, authSession: owner, writeJson, buildHeaders: (headers) => headers };
  assert.equal(await handleConnectorApiRoutes({ ...opts, pathname: '/api/connectors' }), true);
  assert.ok(response.body.bindings.every((binding) => !ids.includes(binding.connectorId)));
  assert.deepEqual(JSON.parse(await readFile(bindingsPath, 'utf8')).bindings, bindings);
  assert.equal(await handleConnectorSurfaceRoutes({ ...opts, pathname: '/api/connectors/surfaces' }), true);
  assert.deepEqual(response.body.surfaces, []);
  for (const connectorId of ids) {
    response = null;
    assert.equal(await handleConnectorSurfaceRoutes({ ...opts, pathname: `/api/connectors/${connectorId}/surface` }), true);
    assert.equal(response.status, 404);
    assert.equal(await handleConnectorSurfaceRoutes({ ...opts, pathname: `/connectors/${connectorId}/login` }), false);
    assert.ok(await getConnectorSurface(connectorId), 'retirement must not erase existing user configuration');
  }
  for (const pathname of ['/connectors/wechat/login', '/api/connectors/wechat/login', '/api/connectors/wechat/login/qr']) {
    assert.equal(await handleConnectorApiRoutes({ ...opts, pathname }), false);
  }
  console.log('test-retired-connectors: ok');
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('ragent-retired-connectors-'));
  await rm(root, { recursive: true, force: true });
}
