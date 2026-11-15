import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from '@playwright/test';

// Real browser UI with synthetic OAuth HTTP responses; no account login or
// external network. Native clipboard readback uses explicit browser permission;
// other cases simulate denied/pending clipboard and popup behavior separately.
const source = await readFile(new URL('../static/chat/model-providers.js', import.meta.url), 'utf8');
const html = `<div id="modelProvidersSettingsSection"></div><div id="modelProvidersPanel"></div>
<button id="modelProvidersOpenBtn">open</button><button id="modelProvidersAddBtn">add</button>
<div id="modelProvidersList"></div><div id="modelProvidersStatus"></div>
<script>window.__RAGENT_BOOTSTRAP__={auth:{role:'owner'}};</script><script src="/providers.js"></script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/providers.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/providers.js' ? source : html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const loginUrl = 'https://auth.openai.com/codex/device';
try {
  for (const mode of ['copy-ok', 'copy-fallback', 'copy-denied', 'copy-pending', 'popup-blocked', 'start-failed', 'cancel-pending', 'cancel-poll', 'copy-native']) {
    const context = await browser.newContext(mode === 'copy-native'
      ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
    await context.route('**/*', (route) => route.request().url().startsWith(origin)
      ? route.continue()
      : route.fulfill({ body: '<p>synthetic official login</p>', contentType: 'text/html' }));
    let pollCount = 0;
    await context.route(`${origin}/api/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/harnesses') return route.fulfill({ json: { harnesses: [{ id: 'codex', installed: true }] } });
      if (path === '/api/native-providers') return route.fulfill({ json: { providers: [] } });
      if (path === '/api/native-provider-oauth/jobs' && mode === 'start-failed') return route.fulfill({ status: 500, json: { error: 'fixture start failure' } });
      if (route.request().method() === 'DELETE') return route.fulfill({ json: {} });
      const code = path.endsWith('/job-test') && ++pollCount > (mode === 'copy-native' ? 5 : 1) ? 'ABCD-EFGH1' : '';
      if (path.endsWith('/job-test') && mode === 'cancel-poll') await new Promise((resolve) => setTimeout(resolve, 700));
      return route.fulfill({ json: { job: { id: 'job-test', agentType: 'codex', state: 'pending', url: loginUrl, code } } });
    });
    const page = await context.newPage();
    await context.addInitScript(({ mode }) => {
      window.__copies = [];
      if (mode !== 'copy-native') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText(value) {
        window.__copies.push(value);
        if (mode === 'copy-pending' || mode === 'cancel-pending') return new Promise(() => {});
        if (mode === 'copy-denied' || mode === 'copy-fallback' || mode === 'popup-blocked') return Promise.reject(new DOMException('denied', 'NotAllowedError'));
        return Promise.resolve();
      } } });
      document.execCommand = () => mode === 'copy-fallback';
      const open = window.open.bind(window);
      window.open = (...args) => {
        if (mode === 'popup-blocked') return null;
        const popup = open(...args);
        if (popup) {
          // about:blank inherits this same-origin document; install the same
          // clipboard double there so focus ownership does not change the case.
          if (mode !== 'copy-native') Object.defineProperty(popup.navigator, 'clipboard', { configurable: true, value: navigator.clipboard });
          popup.document.execCommand = () => mode === 'copy-fallback';
        }
        return popup;
      };
    }, { mode });
    await page.goto(origin);
    await page.waitForFunction(() => !!window.RagentModelProviders);
    await page.click('#modelProvidersAddBtn');
    await page.click('.modal-btn.primary');
    if (mode === 'start-failed') {
      await page.getByText('fixture start failure', { exact: true }).waitFor();
      assert.equal(context.pages().length, 1, 'failed start must close the reserved blank tab');
    } else if (mode === 'cancel-poll') {
      await page.getByText('modelProviders.loginWaiting', { exact: true }).waitFor();
      await page.click('.modal-close');
      await page.waitForTimeout(1800);
      assert.equal(context.pages().length, 1);
      assert.ok(pollCount <= 1, 'late polling response must not resume login after cancellation');
    } else if (mode === 'cancel-pending') {
      await page.waitForFunction(() => window.__copies.length > 0);
      await page.click('.modal-close');
      await page.waitForTimeout(1000);
      assert.ok(context.pages().every((p) => p.url() !== loginUrl), 'closing modal must cancel delayed navigation');
    } else if (mode === 'popup-blocked') {
      await page.getByText('modelProviders.loginOpenBlocked', { exact: true }).waitFor();
      assert.equal(await page.locator('.model-provider-login-result a').getAttribute('href'), loginUrl);
      const before = await page.evaluate(() => window.__copies.length);
      await page.getByRole('button', { name: 'modelProviders.copyDeviceCode', exact: true }).click();
      assert.ok(await page.evaluate(() => window.__copies.length) > before, 'manual copy remains available after denied auto-copy');
    } else {
      await page.waitForFunction(() => document.querySelector('.model-provider-login-handoff'));
      const popup = context.pages().find((p) => p !== page);
      await popup.waitForURL(loginUrl, { timeout: 5000 });
      if (mode === 'copy-native') {
        await page.bringToFront();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'ABCD-EFGH1');
      } else assert.ok(await page.evaluate(() => window.__copies.includes('ABCD-EFGH1')));
      const key = ['copy-ok', 'copy-fallback', 'copy-native'].includes(mode) ? 'modelProviders.loginRedirecting' : 'modelProviders.loginCopyFailed';
      await page.getByText(key, { exact: true }).waitFor();
      // A later poll must not erase actionable copy/redirect status.
      await page.waitForTimeout(1300);
      await page.getByText(key, { exact: true }).waitFor();
    }
    await context.close();
    console.log(`PASS: OAuth browser ${mode}`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
