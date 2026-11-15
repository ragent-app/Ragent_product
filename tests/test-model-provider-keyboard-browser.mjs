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
const assets = new Map(await Promise.all([
  'static/chat/model-providers.js', 'static/chat/focus-scope.js', 'static/chat/chat-input.css',
].map(async (path) => [`/${path}`, await readFile(new URL(`../${path}`, import.meta.url))])));
const html = `<!doctype html><html><head><link rel="stylesheet" href="/static/chat/chat-input.css"></head><body>
<div id="modelProvidersSettingsSection"></div><div id="modelProvidersPanel"></div>
<button id="modelProvidersOpenBtn">open</button><button id="modelProvidersAddBtn">add</button>
<button id="background-action" onclick="window.backgroundExecutions++">background action</button>
<div id="modelProvidersList"></div><div id="modelProvidersStatus"></div>
<script>window.backgroundExecutions=0;window.__RAGENT_BOOTSTRAP__={auth:{role:'owner'}};</script>
<script src="/static/chat/focus-scope.js"></script><script src="/static/chat/model-providers.js"></script></body></html>`;
const server = createServer((req, res) => {
  const asset = assets.get(req.url);
  res.setHeader('Content-Type', asset ? (req.url.endsWith('.css') ? 'text/css' : 'application/javascript') : 'text/html');
  res.end(asset || html);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const externalRequests = [];
let cancelledJobs = 0;
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      externalRequests.push(url.href);
      return route.abort();
    }
    if (url.pathname === '/api/harnesses') return route.fulfill({ json: { harnesses: [
      { id: 'codex', installed: true }, { id: 'agy', installed: true },
    ] } });
    if (url.pathname === '/api/native-providers') return route.fulfill({ json: { providers: [] } });
    if (url.pathname === '/api/native-provider-oauth/jobs' && request.method() === 'POST') {
      return route.fulfill({ json: { job: { id: 'synthetic-job' } } });
    }
    if (url.pathname === '/api/native-provider-oauth/jobs/synthetic-job') {
      if (request.method() === 'DELETE') {
        cancelledJobs++;
        return route.fulfill({ json: {} });
      }
      return route.fulfill({ json: { job: { id: 'synthetic-job', agentType: 'agy',
        state: 'pending', requiresInput: true, inputSubmitted: false } } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !!window.RagentModelProviders && !!window.RagentFocusScope);
  await page.evaluate(() => window.RagentModelProviders.refresh());
  const dialog = page.locator('.model-provider-modal');
  const add = page.locator('#modelProvidersAddBtn');
  const focusedInDialog = () => page.evaluate(() => !!document.activeElement.closest('.model-provider-modal'));
  const ids = () => dialog.locator('.provider-helper-field input, .provider-helper-field select')
    .evaluateAll((nodes) => nodes.map((node) => node.id));

  await add.click();
  await dialog.waitFor();
  assert.equal(await focusedInDialog(), true, 'initial focus enters dialog');
  assert.equal(await page.locator('#background-action').getAttribute('inert'), '', 'background is inert');
  assert.equal(await page.getByRole('dialog', { name: 'modelProviders.addTitle' }).count(), 1);
  const firstIds = await ids();
  assert.equal(firstIds.length, 7);
  assert.equal(new Set(firstIds).size, firstIds.length, 'field IDs are unique');
  assert(firstIds.every(Boolean), 'every control has an ID');
  const labels = await dialog.locator('.provider-helper-field input, .provider-helper-field select')
    .evaluateAll((nodes) => nodes.map((node) => node.labels?.length));
  assert(labels.every((count) => count === 1), 'every control has one associated label');
  assert.equal(await page.getByLabel('modelProviders.displayName', { exact: true }).count(), 1);
  const baseDescription = await page.getByLabel('modelProviders.baseUrl', { exact: true }).getAttribute('aria-describedby');
  assert(baseDescription && await page.locator(`[id="${baseDescription}"]`).count() === 1,
    'Base URL hint has an actual unique description target');
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await focusedInDialog(), true, `Tab ${i} stays in dialog`);
  }
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focusedInDialog(), true, `Shift+Tab ${i} stays in dialog`);
  }
  await page.evaluate(() => document.getElementById('background-action').focus());
  assert.equal(await focusedInDialog(), true, 'programmatic background focus is redirected');
  assert.equal(await page.evaluate(() => window.backgroundExecutions), 0);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'modelProvidersAddBtn');
  assert.equal(await page.locator('#background-action').getAttribute('inert'), null);
  await page.locator('#background-action').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.backgroundExecutions), 1, 'background works after close');
  console.log('PASS: initial focus, labelled controls, Tab containment, Escape and focus restore');

  await add.click();
  const secondIds = await ids();
  assert(secondIds.every((id) => !firstIds.includes(id)), 'reopened dialog uses fresh IDs');
  await dialog.locator('.modal-footer .modal-btn').first().click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'modelProvidersAddBtn');
  await add.click();
  await dialog.locator('.modal-close').click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'modelProvidersAddBtn');
  console.log('PASS: reopen, Cancel and close-button lifecycle restore focus');

  await add.click();
  await page.getByLabel('modelProviders.agentType', { exact: true }).selectOption('agy');
  await dialog.locator('.modal-footer .modal-btn.primary').click();
  await page.getByLabel('modelProviders.agyCredential', { exact: true }).waitFor();
  const credential = await page.getByLabel('modelProviders.agyCredential', { exact: true })
    .evaluate((node) => ({ id: node.id, labels: node.labels.length }));
  assert(credential.id && credential.labels === 1, 'dynamic credential has an associated label');
  await page.bringToFront();
  const cancelledResponse = page.waitForResponse((response) => response.url().endsWith('/synthetic-job')
    && response.request().method() === 'DELETE');
  await page.keyboard.press('Escape');
  await cancelledResponse;
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement.id === 'modelProvidersAddBtn');
  assert.equal(cancelledJobs, 1, 'Escape cancels the pending synthetic job');
  await add.click();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'modelProvidersAddBtn');
  assert.equal(cancelledJobs, 1, 'reopening does not revive the cancelled job');
  assert.deepEqual(externalRequests, []);
  console.log('PASS: dynamic agy label and Escape cancellation lifecycle');
  await context.close();
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
