#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const [baseCss, inputCss, responsiveCss, glassCss, bootstrapSource] = await Promise.all([
  readFile(join(repoRoot, 'static/chat/chat-base.css'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/chat-input.css'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/chat-responsive.css'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/chat-glass.css'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/bootstrap.js'), 'utf8'),
]);

const helperStart = bootstrapSource.indexOf('const COMPOSER_MENU_PORTAL_Z_INDEX');
const helperEnd = bootstrapSource.indexOf('const OWNER_AUTH_CAPABILITIES');
assert.notEqual(helperStart, -1, 'bootstrap should expose composer menu portal helper');
assert.notEqual(helperEnd, -1, 'composer menu portal helper should sit before auth constants');
const portalHelperSource = bootstrapSource.slice(helperStart, helperEnd);

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><head><style>
    ${baseCss}
    ${inputCss}
    ${responsiveCss}
    ${glassCss}
    body { margin: 0; min-height: 844px; }
    .portal-test-spacer { height: 704px; }
    .portal-test-row { display: flex; justify-content: space-between; padding: 0 16px; }
    .portal-test-row button { width: 44px; height: 44px; }
  </style></head><body>
    <div class="portal-test-spacer"></div>
    <div class="input-area" id="inputArea">
      <div class="input-wrapper">
        <div class="portal-test-row">
          <button id="composerAddTrigger" type="button">+</button>
          <button id="composerRuntimeTrigger" type="button">R</button>
          <button id="composerRuntimeSpeedTrigger" type="button">S</button>
          <button id="composerPermissionTrigger" type="button">P</button>
        </div>
        <div class="composer-add-menu" id="composerAddMenu" hidden>
          <button class="composer-add-menu-item">Files</button>
          <button class="composer-add-menu-item">Plan</button>
        </div>
        <div class="composer-runtime-menu" id="composerRuntimeMenu" hidden>
          <button class="composer-runtime-option">Runtime</button>
          <button class="composer-runtime-option">Model</button>
        </div>
        <div class="composer-permission-menu" id="composerPermissionMenu" hidden>
          <button class="composer-runtime-option">Ask first</button>
          <button class="composer-runtime-option">Auto</button>
        </div>
        <div class="composer-runtime-speed-panel has-speed-choice has-effort-range" id="composerRuntimeSpeedPanel" hidden>
          <div class="composer-runtime-speed-select-wrap">
            <select class="composer-runtime-speed-select"><option>Standard</option><option>Fast</option></select>
          </div>
          <div class="composer-runtime-effort-slider">
            <div class="composer-runtime-effort-track"><input class="composer-runtime-effort-range" type="range" min="0" max="3" value="2"></div>
            <div class="composer-runtime-effort-value">High</div>
          </div>
        </div>
      </div>
    </div>
  </body></html>`);
  await page.addScriptTag({ content: portalHelperSource });

  const results = await page.evaluate(() => {
    const cases = [
      ['composerAddMenu', 'composerAddTrigger', 'left'],
      ['composerRuntimeMenu', 'composerRuntimeTrigger', 'right'],
      ['composerRuntimeSpeedPanel', 'composerRuntimeSpeedTrigger', 'center'],
      ['composerPermissionMenu', 'composerPermissionTrigger', 'right'],
    ];
    return cases.map(([menuId, triggerId, align]) => {
      const menu = document.getElementById(menuId);
      const trigger = document.getElementById(triggerId);
      window.RagentComposerMenuPortal.sync(menu, trigger, true, { align });
      menu.hidden = false;
      menu.classList.add('is-open');
      const style = getComputedStyle(menu);
      const menuRect = menu.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      return {
        menuId,
        parentIsBody: menu.parentNode === document.body,
        position: style.position,
        zIndex: style.zIndex,
        backdrop: style.backdropFilter || style.webkitBackdropFilter || '',
        bottomAboveTrigger: menuRect.bottom <= triggerRect.top + 0.5,
        menuTop: menuRect.top,
        menuBottom: menuRect.bottom,
        triggerTop: triggerRect.top,
        menuWidth: menuRect.width,
        menuHeight: menuRect.height,
        menuCenter: menuRect.left + menuRect.width / 2,
        triggerCenter: triggerRect.left + triggerRect.width / 2,
        sheetClass: menu.classList.contains('composer-menu--sheet'),
        withinViewport: menuRect.left >= -0.5 && menuRect.right <= window.innerWidth + 0.5,
      };
    });
  });

  for (const result of results) {
    assert.equal(result.parentIsBody, true, `${result.menuId} should be portaled to document.body`);
    assert.equal(result.position, 'fixed', `${result.menuId} should use fixed positioning`);
    assert.equal(result.zIndex, '200', `${result.menuId} should sit above composer/live surfaces`);
    if (result.menuId !== 'composerRuntimeSpeedPanel') {
      assert.match(result.backdrop, /blur\(/, `${result.menuId} should retain frosted backdrop blur`);
    }
    assert.equal(result.bottomAboveTrigger, true, `${result.menuId} should open above its trigger`);
    assert.ok(result.menuWidth > 120, `${result.menuId} should keep its panel width`);
    assert.ok(
      result.menuHeight > (result.menuId === 'composerRuntimeSpeedPanel' ? 40 : 60),
      `${result.menuId} should measure as a visible panel`,
    );
    assert.equal(result.withinViewport, true, `${result.menuId} should stay within the mobile viewport`);
  }

  const speedProbe = results.find((result) => result.menuId === 'composerRuntimeSpeedPanel');
  assert.equal(speedProbe.sheetClass, false, 'speed panel should use anchored popover geometry, not the mobile sheet branch');
  assert.ok(
    Math.abs(speedProbe.menuCenter - speedProbe.triggerCenter) <= 3,
    `speed panel should center on its trigger (${speedProbe.menuCenter} vs ${speedProbe.triggerCenter})`,
  );

  await page.evaluate(() => Promise.all(
    [...document.getElementById('composerRuntimeSpeedPanel').getAnimations()]
      .map((animation) => animation.finished.catch(() => {})),
  ));
  const settledSpeedProbe = await page.evaluate(() => {
    const menu = document.getElementById('composerRuntimeSpeedPanel');
    const trigger = document.getElementById('composerRuntimeSpeedTrigger');
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    return {
      left: menuRect.left,
      right: menuRect.right,
      menuCenter: menuRect.left + menuRect.width / 2,
      triggerCenter: triggerRect.left + triggerRect.width / 2,
      transform: getComputedStyle(menu).transform,
    };
  });
  assert.ok(settledSpeedProbe.left >= 0, `settled speed panel should not leave the viewport on the left: ${settledSpeedProbe.left}`);
  assert.ok(settledSpeedProbe.right <= 390, `settled speed panel should not leave the viewport on the right: ${settledSpeedProbe.right}`);
  assert.ok(
    Math.abs(settledSpeedProbe.menuCenter - settledSpeedProbe.triggerCenter) <= 3,
    `settled speed panel should remain centered (${settledSpeedProbe.menuCenter} vs ${settledSpeedProbe.triggerCenter})`,
  );
  assert.equal(settledSpeedProbe.transform, 'none', 'settled portaled speed panel should not retain the anchor translateX transform');

  await page.evaluate(() => Promise.all(
    [...document.getElementById('composerRuntimeMenu').getAnimations()]
      .map((animation) => animation.finished.catch(() => {})),
  ));

  const beforeProviderGrowth = await page.evaluate(() => {
    const menu = document.getElementById('composerRuntimeMenu');
    const trigger = document.getElementById('composerRuntimeTrigger');
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    return { bottom: menuRect.bottom, triggerTop: triggerRect.top, top: menuRect.top };
  });
  await page.evaluate(() => {
    const menu = document.getElementById('composerRuntimeMenu');
    for (let index = 0; index < 18; index += 1) {
      const option = document.createElement('button');
      option.className = 'composer-runtime-option';
      option.textContent = `Provider profile ${index + 1}`;
      menu.appendChild(option);
    }
  });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const afterProviderGrowth = await page.evaluate(() => {
    const menu = document.getElementById('composerRuntimeMenu');
    const trigger = document.getElementById('composerRuntimeTrigger');
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    return { bottom: menuRect.bottom, triggerTop: triggerRect.top, top: menuRect.top };
  });
  assert.ok(
    Math.abs(afterProviderGrowth.bottom - beforeProviderGrowth.bottom) <= 1,
    `runtime panel bottom should remain anchored while provider options load (${beforeProviderGrowth.bottom} vs ${afterProviderGrowth.bottom})`,
  );
  assert.ok(afterProviderGrowth.top <= beforeProviderGrowth.top, 'runtime panel should grow upward after provider options load');
  assert.ok(
    afterProviderGrowth.bottom <= afterProviderGrowth.triggerTop + 0.5,
    'runtime panel should remain above its trigger after provider options load',
  );

  // On the 390px viewport the runtime/permission menus run the mobile sheet
  // branch: near-full width, left-anchored, clearly separated from the trigger.
  // Measure the settled geometry, rather than a mid-frame scale transform. The
  // shared motion token is intentionally allowed to change without making this
  // spacing gate timing-dependent.
  await page.evaluate(() => Promise.all(
    [...document.getElementById('composerRuntimeMenu').getAnimations()]
      .map((animation) => animation.finished.catch(() => {})),
  ));
  const sheetProbe = await page.evaluate(() => {
    const menu = document.getElementById('composerRuntimeMenu');
    const trigger = document.getElementById('composerRuntimeTrigger');
    const r = menu.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    return {
      sheetClass: menu.classList.contains('composer-menu--sheet'),
      left: Math.round(r.left),
      width: Math.round(r.width),
      viewport: window.innerWidth,
      gap: Math.round(t.top - r.bottom),
    };
  });
  assert.equal(sheetProbe.sheetClass, true, 'runtime menu should get the mobile sheet class at 390px');
  assert.ok(Math.abs(sheetProbe.left - 8) <= 2, `sheet should sit at left 8px, got ${sheetProbe.left}`);
  assert.ok(Math.abs(sheetProbe.width - (sheetProbe.viewport - 16)) <= 3, `sheet should be near-full width ${sheetProbe.viewport - 16}px, got ${sheetProbe.width}`);
  assert.ok(sheetProbe.gap >= 10, `sheet should keep >=10px visual separation from its trigger, got ${sheetProbe.gap}px`);

  console.log('test-chat-composer-menu-portal: ok');
} finally {
  await browser.close();
}
