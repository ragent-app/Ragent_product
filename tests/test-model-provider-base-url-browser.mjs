import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const playwright = (() => {
  try { return require('@playwright/test'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || !process.env.RAGENT_TEST_MODULE_ROOT) throw error;
    return createRequire(resolve(process.env.RAGENT_TEST_MODULE_ROOT, 'package.json'))('@playwright/test');
  }
})();
const source = await readFile(new URL('../static/chat/model-providers.js', import.meta.url), 'utf8');
const html = `<!doctype html><html><body><div id="modelProvidersSettingsSection"></div><div id="modelProvidersPanel"></div>
<button id="modelProvidersOpenBtn">open</button><button id="modelProvidersAddBtn">add</button>
<div id="modelProvidersList"></div><div id="modelProvidersStatus"></div>
<script>window.__RAGENT_BOOTSTRAP__={auth:{role:'owner'}};</script><script src="/providers.js"></script></body></html>`;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/providers.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/providers.js' ? source : html);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const saved = [{ id: 'existing', agentType: 'codex', authType: 'api-key', protocol: 'openai-responses',
  baseUrl: 'https://existing.fixture.invalid/v1', displayName: 'Existing', credentialOk: true }];
const writes = [];
const externalRequests = [];
let releaseCatalog;
const catalogGate = new Promise((resolveGate) => { releaseCatalog = resolveGate; });
let catalogRequests = 0;
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      externalRequests.push(url.href);
      return route.abort();
    }
    if (url.pathname === '/api/harnesses') {
      if (++catalogRequests > 1) await catalogGate;
      return route.fulfill({ json: { harnesses: [
        { id: 'codex', installed: true, providerProtocols: [] },
        { id: 'claude', installed: true },
        { id: 'pi', installed: true },
      ] } });
    }
    if (url.pathname === '/api/native-providers') {
      if (request.method() === 'POST') {
        const payload = request.postDataJSON();
        writes.push({ method: 'POST', payload });
        saved.push({ ...payload, id: 'created', authType: 'api-key', credentialOk: true });
        return route.fulfill({ json: { provider: saved.at(-1) } });
      }
      return route.fulfill({ json: { providers: saved } });
    }
    if (url.pathname === '/api/native-providers/existing' && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      writes.push({ method: 'PATCH', payload });
      Object.assign(saved[0], payload);
      return route.fulfill({ json: { provider: saved[0] } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  const initialCatalog = page.waitForResponse((response) => response.url() === `${origin}/api/harnesses`);
  await page.goto(origin);
  await initialCatalog;
  await page.waitForFunction(() => !!window.RagentModelProviders);
  await page.evaluate(() => window.RagentModelProviders.refresh());
  const field = (label) => page.locator('.model-provider-modal .provider-helper-field')
    .filter({ has: page.locator('label').filter({ hasText: label }) });
  const base = () => field('modelProviders.baseUrl').locator('input');
  const mode = () => field('modelProviders.authMode').locator('select');
  const protocol = () => field('modelProviders.protocol').locator('select');
  const agent = () => field('modelProviders.agentType').locator('select');
  const save = () => page.locator('.model-provider-modal .modal-btn.primary');
  const gateway = 'https://gateway.fixture.invalid/v1';

  await page.locator('#modelProvidersAddBtn').click();
  assert.equal(await base().inputValue(), 'https://api.openai.com/v1', 'new Codex uses its default');
  await mode().selectOption('api-key');
  await base().fill(gateway);
  await page.evaluate(() => { void window.RagentModelProviders.refresh({ refreshHarnesses: true }); });
  await protocol().selectOption('chat');
  assert.equal(await base().inputValue(), gateway, 'protocol change preserves custom gateway');
  await mode().selectOption('oauth');
  await mode().selectOption('api-key');
  assert.equal(await base().inputValue(), gateway, 'auth mode changes preserve custom gateway');
  const catalogResponse = page.waitForResponse((response) => response.url() === `${origin}/api/harnesses`);
  releaseCatalog();
  await catalogResponse;
  await field('modelProviders.baseUrl').locator('.model-provider-protocol-hint')
    .getByText('modelProviders.protocolsUnavailable').waitFor();
  assert.equal(await base().inputValue(), gateway, 'late catalog refresh preserves custom gateway');
  await field('modelProviders.apiKey').locator('input').fill('synthetic-not-a-real-key');
  await save().click();
  await page.locator('.model-provider-modal').waitFor({ state: 'detached' });
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[0].payload.baseUrl, gateway, 'POST saves custom gateway');
  assert.equal(writes[0].payload.protocol, 'chat');
  console.log('PASS: custom Base URL survives protocol, auth, async catalog and POST');

  await page.locator('#modelProvidersAddBtn').click();
  assert.equal(await base().inputValue(), 'https://api.openai.com/v1');
  await agent().selectOption('claude');
  assert.equal(await base().inputValue(), 'https://api.anthropic.com', 'untouched default follows Claude');
  await agent().selectOption('pi');
  assert.equal(await base().inputValue(), 'https://api.openai.com/v1', 'untouched default follows PI');
  await base().fill(gateway);
  await agent().selectOption('claude');
  assert.equal(await base().inputValue(), gateway, 'Agent change preserves custom gateway');
  await agent().selectOption('pi');
  await base().fill('');
  await agent().selectOption('claude');
  assert.equal(await base().inputValue(), '', 'deliberately cleared URL stays clear');
  await page.locator('.model-provider-modal .modal-close').click();
  console.log('PASS: untouched defaults follow Agent changes; deliberate clearing is preserved');

  await page.locator('#modelProvidersOpenBtn').click();
  await page.locator('.model-provider-card[data-provider-id="existing"] button').first().click();
  assert.equal(await base().inputValue(), 'https://existing.fixture.invalid/v1');
  await protocol().selectOption('chat');
  assert.equal(await base().inputValue(), 'https://existing.fixture.invalid/v1', 'edit preserves stored URL');
  await save().click();
  await page.locator('.model-provider-modal').waitFor({ state: 'detached' });
  assert.equal(writes[1].method, 'PATCH');
  assert.equal(writes[1].payload.baseUrl, 'https://existing.fixture.invalid/v1', 'PATCH keeps stored URL');
  assert.equal(writes[1].payload.protocol, 'chat');
  assert.deepEqual(externalRequests, [], 'fixture never requests external network');
  console.log('PASS: edited Provider preserves stored URL and PATCH payload');
  await context.close();
} finally {
  releaseCatalog();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
