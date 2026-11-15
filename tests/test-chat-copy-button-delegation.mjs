#!/usr/bin/env node
// Browser-level contract for delegated code-copy buttons (P2 audit item 7):
// one document-level click listener + per-button WeakMap reset timers, so
// settle re-enhancement (innerHTML rebuilds) never tears down/re-creates
// per-button listeners. Serves the real scripts (marked.min.js +
// realtime-render.js) over an HTTP fixture; only browser APIs (clipboard,
// i18n, icon renderer) are stubbed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>chat copy button delegation fixture</title>
</head>
<body>
  <div id="messages"><div id="messagesInner"></div></div>
  <script>
    // App stubs: i18n + icon rendering used by setCopyButtonState.
    window.ragentT = (key) => key;
    window.renderRealtimeIcon = (name) => '<svg data-icon="' + name + '"></svg>';

    // Delegation guard spy: counts document-level click listener registrations
    // so the test can assert enhanceCodeBlocks stays idempotent.
    window.__clickListenerCount = 0;
    const __origAddEventListener = document.addEventListener.bind(document);
    document.addEventListener = function (type, listener, options) {
      if (type === 'click') window.__clickListenerCount += 1;
      return __origAddEventListener(type, listener, options);
    };

    // Clipboard stub: every write lands in __copiedTexts for assertion.
    window.__copiedTexts = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__copiedTexts.push(text); },
      },
    });

    // Loopback (127.0.0.1) is already a secure context; pin it explicitly so
    // copyText always takes the Clipboard API branch in this fixture.
    try {
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    } catch (err) { /* read-only in this engine; loopback is still secure */ }

    // Warn capture for the copy-failure contract.
    window.__copyWarns = [];
    const __origWarn = console.warn.bind(console);
    console.warn = function (...args) {
      window.__copyWarns.push(args.join(' '));
      return __origWarn(...args);
    };
  </script>
  <script src="/marked.min.js"></script>
  <script src="/realtime-render.js"></script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/fixture.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
    return;
  }
  if (req.url === '/marked.min.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(join(repoRoot, 'static/marked.min.js'), 'utf8'));
    return;
  }
  if (req.url === '/realtime-render.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(join(repoRoot, 'static/chat/realtime-render.js'), 'utf8'));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(fixtureUrl);

  const baselineListeners = await page.evaluate(() => window.__clickListenerCount);

  // Scenario 1: markdown render + enhance -> click copies the exact code text
  // and enters the copied state; a re-click restarts the reset window; the
  // state restores 1600ms after the LAST click.
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'fixtureRoot';
    document.getElementById('messagesInner').appendChild(root);
    root.innerHTML = window.marked.parse('```js\nconst answer = 42;\n```');
    window.__root = root;
    enhanceCodeBlocks(root);
  });
  assert.equal(
    await page.evaluate(() => window.__clickListenerCount),
    baselineListeners + 1,
    'the first enhance should register the delegation listener exactly once',
  );
  assert.equal(
    await page.evaluate(() => window.__root.querySelectorAll('.code-block-wrap').length),
    1,
    'the code block should be wrapped',
  );
  assert.equal(
    await page.evaluate(() => window.__root.querySelectorAll('.code-copy-btn').length),
    1,
    'one code block should get one copy button',
  );
  assert.equal(
    await page.locator('#fixtureRoot .code-block-language-name').textContent(),
    'JavaScript',
    'the code block header should expose the canonical language label',
  );
  assert.equal(
    await page.locator('#fixtureRoot .code-block-language-icon').textContent(),
    '</>',
    'the code block header should expose the code-language marker',
  );

  const button = page.locator('#fixtureRoot .code-copy-btn');
  await button.click();
  await page.waitForFunction(() => window.__copiedTexts.length === 1);
  assert.equal(
    await page.evaluate(() => window.__copiedTexts[0]),
    'const answer = 42;\n',
    'the clipboard stub should receive the exact code text',
  );
  await page.waitForFunction(() => document.querySelector('.code-copy-btn').classList.contains('copied'));
  assert.equal(
    await page.evaluate(() => document.querySelector('.code-copy-btn').getAttribute('aria-label')),
    'action.copied',
    'the button should advertise the copied state',
  );

  // Re-click while copied: the pending 1600ms restore timer must be restarted.
  await page.waitForTimeout(300);
  await button.click();
  await page.waitForFunction(() => window.__copiedTexts.length === 2);
  await page.waitForTimeout(1300);
  assert.equal(
    await page.evaluate(() => document.querySelector('.code-copy-btn').classList.contains('copied')),
    true,
    'a re-click should restart the 1600ms reset window',
  );
  await page.waitForFunction(
    () => !document.querySelector('.code-copy-btn').classList.contains('copied'),
    null,
    { timeout: 2500 },
  );

  // Scenario 2: clicks that miss the button must not trigger a copy.
  await page.evaluate(() => { window.__copiedTexts.length = 0; });
  await page.locator('#fixtureRoot .code-block-wrap pre').click();
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => window.__copiedTexts.length),
    0,
    'clicking the code body (not the button) must not copy',
  );

  // Scenario 3: innerHTML rebuild + re-enhance (the settle path) — the
  // delegated listener survives and the rebuilt button still works; no second
  // registration happens.
  await page.evaluate(() => {
    window.__root.innerHTML = window.marked.parse('```python\nprint(\'hello\')\n```');
    enhanceCodeBlocks(window.__root);
    window.__copiedTexts.length = 0;
  });
  assert.equal(
    await page.evaluate(() => window.__clickListenerCount),
    baselineListeners + 1,
    're-enhance after an innerHTML rebuild must not register a second delegation listener',
  );
  assert.equal(
    await page.evaluate(() => window.__root.querySelectorAll('.code-copy-btn').length),
    1,
    'the rebuilt root should carry exactly one fresh button',
  );
  assert.equal(
    await page.locator('#fixtureRoot .code-block-language-name').textContent(),
    'Python',
    'the rebuilt code block should update its language label',
  );
  await page.locator('#fixtureRoot .code-copy-btn').click();
  await page.waitForFunction(() => window.__copiedTexts.length === 1);
  assert.equal(
    await page.evaluate(() => window.__copiedTexts[0]),
    "print('hello')\n",
    'the rebuilt button should copy its new code text through the surviving delegation',
  );
  await page.waitForFunction(
    () => !document.querySelector('.code-copy-btn').classList.contains('copied'),
    null,
    { timeout: 2500 },
  );

  // Scenario 4: a copy failure warns (not swallowed), never enters the copied
  // state, and never arms a reset timer that flips the button later.
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); };
    window.__copyWarns.length = 0;
  });
  await button.click();
  await page.waitForFunction(() => window.__copyWarns.length > 0);
  assert.match(
    await page.evaluate(() => window.__copyWarns[0]),
    /Failed to copy code block: clipboard denied/,
    'a failed copy should surface a console.warn with the underlying error',
  );
  assert.equal(
    await page.evaluate(() => document.querySelector('.code-copy-btn').classList.contains('copied')),
    false,
    'a failed copy must not enter the copied state',
  );
  await page.waitForTimeout(1700);
  assert.equal(
    await page.evaluate(() => document.querySelector('.code-copy-btn').classList.contains('copied')),
    false,
    'a failed copy must not arm a reset timer that flips the button later',
  );

  console.log('test-chat-copy-button-delegation: ok');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
