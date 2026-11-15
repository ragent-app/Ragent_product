#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// The fixed bottom action bar must not make the last session or project
// unreachable. Verify the rendered scroll geometry for both sidebar levels.
const styleFiles = [
  'static/chat/chat-base.css',
  'static/chat/custom-select.css',
  'static/chat/chat-sidebar.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
];
const styles = (await Promise.all(styleFiles.map((file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')))).join('\n');

function sessionItems(count, prefix = 'Session') {
  return Array.from({ length: count }, (_, index) => `
    <button class="session-item" type="button">
      <span class="session-item-info"><span class="session-item-name">${prefix} ${index + 1}</span></span>
      <span class="session-item-time">12:00</span>
      <span class="session-item-status" aria-hidden="true"></span>
    </button>`).join('');
}

function projectItems(count) {
  return Array.from({ length: count }, (_, index) => `
    <section class="sidebar-project-group">
      <button class="sidebar-project-head" type="button">
        <span class="sidebar-project-head-icon"></span>
        <span class="sidebar-project-head-name">Project ${index + 1}</span>
        <span class="sidebar-project-head-count">3</span>
        <span class="sidebar-project-head-chevron"></span>
      </button>
      <div class="sidebar-project-preview">
        <button class="session-item" type="button">
          <span class="session-item-info"><span class="session-item-name">Preview ${index + 1}</span></span>
        </button>
      </div>
    </section>`).join('');
}

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1024]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style>
      <style>
        :root { --safe-top: 0px; --safe-bottom: 0px; --app-height: 844px; --sidebar-width: 320px; --sidebar-mobile-width: 100vw; }
        html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
        .sidebar { position: relative; width: min(320px, 100vw); height: 844px; }
        .sidebar-overlay { position: relative; width: min(320px, 100vw); height: 844px; opacity: 1; visibility: visible; pointer-events: auto; }
        .sidebar-overlay .sidebar { position: relative; width: 100%; height: 100%; transform: none; }
      </style></head><body>
      <div class="sidebar-overlay open"><aside class="sidebar" data-sidebar-mode="sessions">
        <div class="sidebar-app-bar"><div class="sidebar-brand">Ragent</div></div>
        <nav class="sidebar-primary-nav"><div class="sidebar-workspace"><button class="sidebar-workspace-summary" type="button">Workspace</button></div></nav>
        <div class="sidebar-session-surface">
          <div class="sidebar-projects-view" id="projectsView" hidden>${projectItems(14)}</div>
          <div class="sidebar-list" id="sessionList">${sessionItems(22)}</div>
        </div>
        <div class="sidebar-bottom-frost" aria-hidden="true"></div>
        <div class="sidebar-bottom-actions"><button class="sidebar-new-chat-btn" type="button">New project</button><button class="sidebar-filter-btn" type="button">Settings</button><button class="sidebar-account-btn" type="button">A</button></div>
      </aside></div></body></html>`);

    const measure = async (selector, targetSelector) => page.evaluate(({ selector: scrollSelector, targetSelector: itemSelector }) => {
      const scroll = document.querySelector(scrollSelector);
      const target = scroll.querySelector(itemSelector);
      const frost = document.querySelector('.sidebar-bottom-frost');
      scroll.scrollTop = scroll.scrollHeight;
      const targetRect = target.getBoundingClientRect();
      const frostRect = frost.getBoundingClientRect();
      return {
        scrollable: scroll.scrollHeight > scroll.clientHeight,
        atMax: Math.abs(scroll.scrollTop - (scroll.scrollHeight - scroll.clientHeight)) <= 1,
        targetBottom: targetRect.bottom,
        frostTop: frostRect.top,
      };
    }, { selector, targetSelector });

    const sessions = await measure('#sessionList', '.session-item:last-child');
    assert.equal(sessions.scrollable, true, `${width}px: session list should scroll`);
    assert.equal(sessions.atMax, true, `${width}px: session list should reach its maximum scroll position`);
    assert.ok(sessions.targetBottom <= sessions.frostTop - 4, `${width}px: last session should clear the bottom overlay`);

    await page.evaluate(() => {
      document.querySelector('#sessionList').hidden = true;
      document.querySelector('#projectsView').hidden = false;
    });
    const projects = await measure('#projectsView', '.sidebar-project-group:last-child');
    assert.equal(projects.scrollable, true, `${width}px: project list should scroll`);
    assert.equal(projects.atMax, true, `${width}px: project list should reach its maximum scroll position`);
    assert.ok(projects.targetBottom <= projects.frostTop - 4, `${width}px: last project should clear the bottom overlay`);

    await page.close();
  }
  console.log('test-chat-sidebar-bottom-clearance: ok');
} finally {
  await browser.close();
}
