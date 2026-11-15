#!/usr/bin/env node
// Composer runtime/permission picker visibility contract (real CSS cascade).
//
// Regression: chat-material-finish.css loaded after chat-input.css and both
// files used !important on the same (0,2,0) selectors — the finish layer's
// `display: flex !important` beat `.composer-runtime-menu[hidden]
// { display: none !important }`, so a "closed" menu stayed painted. That
// produced three user-visible defects at once:
//   1. expanding the composer showed a ghost picker clipped by the composer
//      container (the menu had never been opened);
//   2. after closing, the portaled panel kept floating over the composer and
//      no tap could dismiss it (all state flags were already false);
//   3. on mobile the floating sheet-radius rule squared the bottom corners.
// This test loads the full CSS chain in page order and asserts both the
// hidden contract and the mobile floating radius.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Same cascade order the page uses: chat.css imports through chat-glass.css,
// then the later <link> sheets (m3-components, material-finish) override.
const cssChain = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-m3-components.css',
  'static/chat/chat-material-finish.css',
];

const [bootstrapSource, ...cssSources] = await Promise.all([
  readFile(join(repoRoot, 'static/chat/bootstrap.js'), 'utf8'),
  ...cssChain.map((p) => readFile(join(repoRoot, p), 'utf8')),
]);

const helperStart = bootstrapSource.indexOf('const COMPOSER_MENU_PORTAL_Z_INDEX');
const helperEnd = bootstrapSource.indexOf('const OWNER_AUTH_CAPABILITIES');
assert.notEqual(helperStart, -1, 'portal helper should exist in bootstrap.js');
const portalHelperSource = bootstrapSource.slice(helperStart, helperEnd);

const browser = await chromium.launch({ headless: true });

async function withPage(width, fn) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  try {
    await page.setContent(`<!doctype html><html><head><style>
      ${cssSources.join('\n')}
      body { margin: 0; min-height: 844px; }
      .spacer { height: 700px; }
    </style></head><body>
      <div class="spacer"></div>
      <div class="input-area composer-expanded" id="inputArea">
        <div class="input-wrapper">
          <div class="composer-runtime-controls" id="composerRuntimeControls">
            <button class="composer-runtime-btn" id="composerRuntimeBtn" type="button" aria-expanded="false">R</button>
            <div class="composer-runtime-menu" id="composerRuntimeMenu" role="menu" hidden>
              <div class="composer-runtime-view active" id="composerRuntimeToolView">
                <div class="composer-runtime-view-header"><div class="composer-runtime-menu-title">Tools</div></div>
                <div class="composer-runtime-options">
                  <button class="composer-runtime-option">Codex</button>
                  <button class="composer-runtime-option">Claude</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </body></html>`);
    await page.addScriptTag({ content: portalHelperSource });
    await fn(page);
  } finally {
    await page.close();
  }
}

try {
  for (const [label, width] of [['mobile', 390], ['desktop', 1280]]) {
    await withPage(width, async (page) => {
      const closed = await page.evaluate(() => {
        const menu = document.getElementById('composerRuntimeMenu');
        return { hidden: menu.hidden, display: getComputedStyle(menu).display };
      });
      assert.equal(closed.hidden, true, `[${label}] menu starts hidden`);
      assert.equal(
        closed.display,
        'none',
        `[${label}] a hidden runtime menu must not paint. The finish layer must not`
        + ' set an !important display on the same specificity as the [hidden]'
        + ' contract in chat-input.css (ghost panel regression).',
      );

      // Open through the real portal path.
      const open = await page.evaluate(() => {
        const menu = document.getElementById('composerRuntimeMenu');
        const trigger = document.getElementById('composerRuntimeBtn');
        window.RagentComposerMenuPortal.sync(menu, trigger, true, { align: 'right' });
        menu.hidden = false;
        menu.classList.add('is-open');
        const cs = getComputedStyle(menu);
        const menuRect = menu.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        return {
          position: cs.position,
          parentIsBody: menu.parentElement === document.body,
          radius: cs.borderRadius,
          bottomLeft: cs.borderBottomLeftRadius,
          bottomRight: cs.borderBottomRightRadius,
          sheetClass: menu.classList.contains('composer-menu--sheet'),
          aboveTrigger: menuRect.bottom <= triggerRect.top + 1,
        };
      });
      assert.equal(open.position, 'fixed', `[${label}] opened menu is portaled fixed`);
      assert.equal(open.parentIsBody, true, `[${label}] opened menu lives under body`);
      assert.equal(open.aboveTrigger, true, `[${label}] opened menu floats above the trigger`);
      assert.notEqual(
        open.bottomLeft,
        '0px',
        `[${label}] floating picker must keep rounded bottom-left corners`
        + ' (mobile sheet radius must not apply to trigger-anchored panels)',
      );
      assert.notEqual(
        open.bottomRight,
        '0px',
        `[${label}] floating picker must keep rounded bottom-right corners`,
      );
      if (label === 'mobile') {
        assert.equal(open.sheetClass, true, '[mobile] picker uses the sheet presentation class');
      }

      // Closing must return the menu to a non-painting state.
      const closedAgain = await page.evaluate(() => {
        const menu = document.getElementById('composerRuntimeMenu');
        const trigger = document.getElementById('composerRuntimeBtn');
        window.RagentComposerMenuPortal.sync(menu, trigger, false);
        menu.hidden = true;
        menu.classList.remove('is-open');
        return { hidden: menu.hidden, display: getComputedStyle(menu).display };
      });
      assert.equal(closedAgain.display, 'none', `[${label}] closed menu must stop painting`);
    });
  }
  console.log('composer runtime menu visibility contract: PASS');
} finally {
  await browser.close();
}
