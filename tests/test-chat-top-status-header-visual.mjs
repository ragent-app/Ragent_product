#!/usr/bin/env node
// Web chat top chrome parity fixture: the status control replaces the retired
// bottom Live Bar while Web keeps its hamburger, Home, and More controls.
import assert from 'assert/strict';
import { mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = String(process.env.RAGENT_TOP_STATUS_OUTPUT_DIR || '/tmp/ragent-top-status-visual');
mkdirSync(outputDir, { recursive: true });

const template = readFileSync(join(repoRoot, 'templates/chat.html'), 'utf8');
const bootstrap = readFileSync(join(repoRoot, 'static/chat/bootstrap.js'), 'utf8');
const liveStatus = readFileSync(join(repoRoot, 'static/chat/chat-live-status.css'), 'utf8');
const base = readFileSync(join(repoRoot, 'static/chat/chat-base.css'), 'utf8');
const responsive = readFileSync(join(repoRoot, 'static/chat/chat-responsive.css'), 'utf8');
const glass = readFileSync(join(repoRoot, 'static/chat/chat-glass.css'), 'utf8');
const finish = readFileSync(join(repoRoot, 'static/chat/chat-material-finish.css'), 'utf8');
const iconsSource = readFileSync(join(repoRoot, 'static/chat/icons.js'), 'utf8');

assert.match(template, /class="header-leading-actions"[\s\S]*?class="header-btn header-btn--sessions" id="menuBtn"[\s\S]*?class="header-btn header-btn--home" id="homeBtn"/, 'Web hamburger and Home must share one leading capsule');
assert.match(template, /id="menuBtn"[\s\S]*?data-icon="menu"/, 'Web hamburger must remain the session menu button, not a back button');
assert.match(template, /id="headerMoreBtn"[\s\S]*?data-icon="more"/, 'Web More must use the Android-style vertical dots icon');
assert.match(iconsSource, /home:\s*['"]<path fill="currentColor" stroke="none"/, 'Home should use Android\'s filled simplified glyph');
assert.match(template, /class="chat-status-header" id="chatStatusHeader"[\s\S]*?id="liveBar" class="live-bar chat-status-control"/, 'Live Bar status must be hosted by the top status control');
assert.doesNotMatch(template, /id="liveBarSlot"/, 'the retired bottom Live Bar slot must not return');
for (const id of [
  'headerOverflowRenameBtn',
  'headerOverflowCopySessionIdBtn',
  'headerOverflowCompactBtn',
  'headerOverflowDropToolsBtn',
  'headerOverflowDeleteBtn',
]) {
  assert.match(template, new RegExp(`id="${id}"`), `${id} must be in the Web More menu`);
}
assert.match(bootstrap, /window\.ragentOpenSessionRename/, 'rename must reuse the session action sheet');
assert.match(bootstrap, /window\.ragentOpenSessionDelete/, 'delete must reuse the session action sheet');
assert.match(bootstrap, /headerOverflowCopySessionIdBtn/, 'copy session ID must be wired into the More menu');
assert.match(liveStatus, /\.chat-status-header \.live-bar\s*\{[\s\S]*?height:\s*44px;[\s\S]*?border-radius:\s*999px;/, 'top status should use the Android-like compact pill geometry');
assert.match(liveStatus, /@media \(max-width:\s*767px\)[\s\S]*?\.chat-status-header \.live-bar\s*\{[\s\S]*?min-height:\s*40px;[\s\S]*?height:\s*40px;/, 'mobile status should align to the 40px navigation controls');
assert.match(base, /\.chat-status-header\s*\{[\s\S]*?left:\s*50%;[\s\S]*?height:\s*var\(--app-header-height\);/, 'status should use the fixed header lane on desktop');
assert.match(liveStatus, /@media \(max-width:\s*767px\)[\s\S]*?\.chat-status-header\s*\{[\s\S]*?left:\s*calc\(8px \+ 82px \+ 6px\);[\s\S]*?right:\s*calc\(8px \+ 40px \+ 6px\);[\s\S]*?width:\s*auto;/, 'mobile status should fill the lane with equal gaps to both controls');
assert.match(iconsSource, /\bmore:\s*['"]/,'shared icons should define the Android-style vertical More glyph');

const styles = [base, responsive, glass, finish, liveStatus].join('\n');
const html = () => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><div class="app-shell"><header class="header"><div class="header-leading-actions"><button class="header-btn header-btn--sessions" id="menuBtn" type="button"><span class="header-btn-icon" data-icon="menu"></span></button><button class="header-btn header-btn--home" id="homeBtn" type="button"><span class="header-btn-icon" data-icon="home"></span></button></div><div class="chat-status-header" id="chatStatusHeader"><div id="liveBar" class="live-bar chat-status-control" role="status"><span class="live-bar__orb" aria-hidden="true"></span><span class="live-bar__label">Working on your task</span><span class="live-bar__elapsed">12s</span></div></div><div class="header-title-block"><h1>Ragent Chat</h1></div><button class="header-more-btn" id="headerMoreBtn" type="button" style="display:flex" data-icon="more"></button></header><div class="header-overflow-menu is-open" id="headerOverflowMenu"><button class="header-overflow-menu-item"><span class="header-overflow-menu-icon" data-icon="file"></span><span>Run Sheet</span></button><button class="header-overflow-menu-item"><span class="header-overflow-menu-icon" data-icon="edit"></span><span>Rename</span></button><button class="header-overflow-menu-item"><span class="header-overflow-menu-icon" data-icon="copy"></span><span>Copy session ID</span></button><button class="header-overflow-menu-item"><span class="header-overflow-menu-icon" data-icon="refresh"></span><span>Compact</span></button><button class="header-overflow-menu-item"><span class="header-overflow-menu-icon" data-icon="terminal"></span><span>Drop tools</span></button><button class="header-overflow-menu-item"><span class="header-overflow-menu-icon" data-icon="trash"></span><span>Delete</span></button><button class="header-overflow-menu-item"><span class="header-overflow-menu-icon" data-icon="sidebar"></span><span>Sidebar</span></button><button class="header-overflow-menu-item"><span class="header-overflow-menu-icon" data-icon="refresh"></span><span>Reload latest frontend</span></button></div><main style="height:calc(100vh - 44px)"></main></div></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const { name, colorScheme } of [
    { name: '390-light', colorScheme: 'light' },
    { name: '390-dark', colorScheme: 'dark' },
  ]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme });
    await page.setContent(html());
    await page.addScriptTag({ content: iconsSource });
    await page.waitForTimeout(340);
    await page.screenshot({ path: join(outputDir, `${name}.png`) });
    const metrics = await page.evaluate(() => {
      const status = document.getElementById('liveBar').getBoundingClientRect();
      const hamburger = document.getElementById('menuBtn').getBoundingClientRect();
      const home = document.getElementById('homeBtn').getBoundingClientRect();
      const leading = document.querySelector('.header-leading-actions').getBoundingClientRect();
      const more = document.getElementById('headerMoreBtn').getBoundingClientRect();
      const menu = document.getElementById('headerOverflowMenu').getBoundingClientRect();
      return {
        statusLeft: Math.round(status.left),
        statusWidth: Math.round(status.width),
        statusHeight: Math.round(status.height),
        hamburgerWidth: Math.round(hamburger.width),
        homeWidth: Math.round(home.width),
        leadingWidth: Math.round(leading.width),
        leadingHeight: Math.round(leading.height),
        leadingGap: Math.round(home.left - hamburger.right),
        statusToLeading: Math.round(status.left - leading.right),
        statusToMore: Math.round(more.left - status.right),
        leadingShadow: getComputedStyle(document.querySelector('.header-leading-actions')).boxShadow,
        statusShadow: getComputedStyle(document.getElementById('liveBar')).boxShadow,
        moreShadow: getComputedStyle(document.getElementById('headerMoreBtn')).boxShadow,
        leadingBackground: getComputedStyle(document.querySelector('.header-leading-actions')).backgroundColor,
        statusBackground: getComputedStyle(document.getElementById('liveBar')).backgroundColor,
        moreBackground: getComputedStyle(document.getElementById('headerMoreBtn')).backgroundColor,
        menuBackground: getComputedStyle(document.getElementById('headerOverflowMenu')).backgroundColor,
        headerOverflow: getComputedStyle(document.querySelector('.header')).overflow,
        moreWidth: Math.round(more.width),
        menuWidth: Math.round(menu.width),
        menuItems: document.querySelectorAll('.header-overflow-menu-item').length,
      };
    });
    assert.equal(metrics.statusToLeading, metrics.statusToMore, `${name}: status capsule should keep equal gaps to both controls`);
    assert.equal(metrics.leadingShadow, metrics.statusShadow, `${name}: leading capsule and status should share one soft shadow`);
    assert.equal(metrics.statusShadow, metrics.moreShadow, `${name}: all three top controls should share one soft shadow`);
    assert.equal(metrics.leadingBackground, metrics.statusBackground, `${name}: leading capsule and status should share one material surface`);
    assert.equal(metrics.statusBackground, metrics.moreBackground, `${name}: More should share the same material surface`);
    assert.equal(metrics.moreBackground, metrics.menuBackground, `${name}: More panel should share the same dark/light material surface`);
    assert.equal(metrics.headerOverflow, 'visible', `${name}: header should let control shadows settle instead of clipping them`);
    if (colorScheme === 'dark') {
      const channelValues = metrics.menuBackground.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) || [];
      assert.ok(channelValues.length === 3 && Math.max(...channelValues) <= 40, `${name}: dark material surface should be near black`);
    }
    assert.equal(metrics.statusHeight, 40, `${name}: status pill should align to the 40px top controls`);
    assert.equal(metrics.hamburgerWidth, 40, `${name}: hamburger target should remain 40px`);
    assert.equal(metrics.homeWidth, 40, `${name}: Home target should remain 40px`);
    assert.equal(metrics.leadingWidth, 82, `${name}: hamburger and Home should share one 82px capsule`);
    assert.equal(metrics.leadingHeight, 40, `${name}: leading capsule should match the Android 40px control height`);
    assert.ok(metrics.leadingGap <= 2, `${name}: hamburger and Home should touch inside the shared capsule`);
    assert.equal(metrics.moreWidth, 40, `${name}: More target should remain 40px`);
    assert.equal(metrics.menuItems, 8, `${name}: More menu should expose Android's extra actions plus Web actions`);
    assert.ok(metrics.menuWidth >= 270, `${name}: More menu should retain a comfortable Android-like width`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`top status header visual: ok (${outputDir})`);
