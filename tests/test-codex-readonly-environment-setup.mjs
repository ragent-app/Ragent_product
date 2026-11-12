import { strict as assert } from 'node:assert';
import { createCodexReadOnlyEnvironmentSetup } from '../chat/codex-readonly-environment-setup.mjs';

function fixture(overrides = {}) {
  let id = 10, stopped = 0, cleaned = 0, ready, failed;
  const sent = [];
  const executor = { execServerUrl: 'ws://127.0.0.1:45678/', authBearerToken: 'a'.repeat(64), stop: async () => { stopped++; } };
  const prepareMcp = async ({ servers }) => ({ config: { mcp_servers: servers }, cleanup: async () => { cleaned++; } });
  const setup = createCodexReadOnlyEnvironmentSetup({ environmentId: 'run_1', cwd: '/workspace', workspace: '/workspace', hidePaths: ['/secret'], executor,
    nextRequestId: () => id++, send: message => { sent.push(message); return true; }, prepareMcp,
    onReady: value => { ready = value; }, onFailure: value => { failed = value; }, ...overrides });
  return { setup, sent, stats: () => ({ stopped, cleaned, ready, failed }) };
}
const a = fixture();
assert.equal(a.setup.start(), true);
assert.equal(a.sent[0].method, 'config/read');
assert.equal(await a.setup.consume({ id: 999, result: {} }), false);
assert.equal(await a.setup.consume({ id: 10, result: { config: { mcp_servers: { safe: { url: 'https://example.test' } } } } }), true);
assert.equal(a.sent[1].method, 'environment/add');
assert.equal(a.sent[1].params.authBearerToken, 'a'.repeat(64));
await a.setup.consume({ id: 11, result: {} });
assert.equal(a.sent[2].method, 'environment/info');
await a.setup.consume({ id: 12, result: { shell: { path: '/bin/sh' } } });
assert.deepEqual(a.stats().ready.executionEnvironment, { environmentId: 'run_1', cwd: '/workspace' });
assert.equal(a.stats().ready.threadMcpConfig.mcp_servers.safe.url, 'https://example.test');
assert.equal(await a.setup.consume({ id: null, result: {} }), false);
await a.setup.close(); await a.setup.close();
assert.equal(a.stats().stopped, 1); assert.equal(a.stats().cleaned, 1);

const b = fixture(); b.setup.start();
await b.setup.consume({ id: 10, error: { message: 'secret fixture should not be surfaced' } });
await b.setup.close();
assert.equal(b.stats().failed.code, 'CODEX_READONLY_ENVIRONMENT_UNAVAILABLE');
assert.equal(JSON.stringify(b.stats().failed).includes('secret fixture'), false);
assert.equal(b.stats().stopped, 1);

let finishPrepare;
const c = fixture({ prepareMcp: () => new Promise(resolve => { finishPrepare = resolve; }) });
c.setup.start();
const pending = c.setup.consume({ id: 10, result: { config: {} } });
await c.setup.close();
let lateCleanup = 0;
finishPrepare({ config: {}, cleanup: async () => { lateCleanup++; } });
await pending;
assert.equal(lateCleanup, 1); assert.equal(c.sent.length, 1);
console.log('test-codex-readonly-environment-setup: ok');
