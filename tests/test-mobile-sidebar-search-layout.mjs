#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

import { chromium } from '@playwright/test';

const baseCss = await readFile(new URL('../static/chat/chat-base.css', import.meta.url), 'utf8');
const sidebarCss = await readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8');
const responsiveCss = await readFile(new URL('../static/chat/chat-responsive.css', import.meta.url), 'utf8');

const sessionItems = Array.from({ length: 24 }, (_, index) => `
  <div class="session-item${index === 0 ? ' active' : ''}">
    <div class="session-item-info">
      <div class="session-item-name">Session ${index + 1}</div>
    </div>
  </div>
`).join('');

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    isMobile: true,
  });
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no">
        <style>
          ${baseCss}
          ${sidebarCss}
          ${responsiveCss}
          :root {
            --safe-top: 47px;
            --safe-bottom: 10px;
          }
        </style>
      </head>
      <body>
        <div class="sidebar-overlay open">
          <aside class="sidebar" id="sidebar">
            <div class="sidebar-tabs">
              <button class="sidebar-tab active">会话</button>
              <button class="sidebar-tab">Agent</button>
              <button class="sidebar-tab">设置</button>
            </div>
            <button class="header-btn sidebar-close-btn">Back</button>
            <div class="sidebar-workspace" id="workspacePicker">
              <button class="sidebar-workspace-summary" type="button">
                <span class="sidebar-workspace-summary-text">工作区：默认工作区</span>
              </button>
              <div class="sidebar-workspace-popover" id="workspacePopover" hidden>
                <div class="sidebar-section-title">Workspace</div>
                <div class="sidebar-workspace-form">
                  <select class="sidebar-workspace-select"><option>Default</option></select>
                </div>
                <div class="sidebar-workspace-actions">
                  <button class="sidebar-workspace-confirm">确认</button>
                </div>
              </div>
            </div>
            <div class="sidebar-search" id="sidebarSearch">
              <input class="sidebar-search-input" id="sessionSearchInput" type="search" placeholder="搜索会话...">
            </div>
            <div class="sidebar-list" id="sessionList">
              <div class="folder-group unified-sessions">
                <div class="folder-group-items">${sessionItems}</div>
              </div>
            </div>
            <button class="new-session-btn" id="newSessionBtn">+ 新建会话</button>
          </aside>
        </div>
      </body>
    </html>`);

  const initial = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      const bounds = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        height: bounds.height,
        position: styles.position,
        zIndex: styles.zIndex,
        overflowY: styles.overflowY,
      };
    };
    return {
      workspace: {
        ...rect('#workspacePicker'),
        borderRadius: getComputedStyle(document.querySelector('#workspacePicker')).borderRadius,
        borderWidth: getComputedStyle(document.querySelector('#workspacePicker')).borderWidth,
      },
      workspaceSummaryFontSize: getComputedStyle(document.querySelector('.sidebar-workspace-summary-text')).fontSize,
      workspaceSummaryFontWeight: getComputedStyle(document.querySelector('.sidebar-workspace-summary-text')).fontWeight,
      sessionNameFontSize: getComputedStyle(document.querySelector('.session-item-name')).fontSize,
      search: rect('#sidebarSearch'),
      list: rect('#sessionList'),
      first: rect('.session-item'),
      newSession: rect('#newSessionBtn'),
      listScrollTop: document.querySelector('#sessionList').scrollTop,
    };
  });

  assert.equal(initial.search.position, 'relative', 'mobile session search should stay in normal sidebar flow');
  assert.equal(initial.workspace.borderWidth, '1px', 'collapsed workspace should keep a flat outline');
  assert.ok(parseFloat(initial.workspace.borderRadius) >= initial.workspace.height / 2 - 1, 'collapsed workspace outline should use a large pill radius');
  assert.equal(initial.workspaceSummaryFontSize, initial.sessionNameFontSize, 'workspace summary typography should match session names');
  assert.ok(Number(initial.workspaceSummaryFontWeight) >= 600, 'workspace summary text should be bold');
  assert.equal(initial.list.overflowY, 'auto', 'mobile session list should be the scroll container');
  assert.ok(
    initial.search.bottom <= initial.list.top + 0.5,
    `search should not overlap the list: search bottom ${initial.search.bottom}, list top ${initial.list.top}`,
  );
  assert.ok(
    initial.first.top >= initial.search.bottom + 5,
    `first session should render below search: first top ${initial.first.top}, search bottom ${initial.search.bottom}`,
  );
  assert.ok(
    initial.list.bottom <= initial.newSession.top + 0.5,
    `session list should end before the new-session action: list bottom ${initial.list.bottom}, new session top ${initial.newSession.top}`,
  );

  await page.evaluate(() => {
    document.querySelector('#workspacePicker').classList.add('is-expanded');
    document.querySelector('#workspacePopover').hidden = false;
  });
  await page.waitForTimeout(240);
  const expandedWorkspace = await page.evaluate(() => {
    const rect = (selector) => {
      const bounds = document.querySelector(selector).getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, height: bounds.height, right: bounds.right };
    };
    const popover = document.querySelector('#workspacePopover');
    const picker = document.querySelector('#workspacePicker');
    const list = document.querySelector('#sessionList');
    const confirm = document.querySelector('.sidebar-workspace-confirm');
    const firstSessionName = document.querySelector('.session-item-name');
    const popoverBounds = popover.getBoundingClientRect();
    const firstSessionNameBounds = firstSessionName.getBoundingClientRect();
    const blankPointTarget = document.elementFromPoint(popoverBounds.left + 8, popoverBounds.bottom - 42);
    const firstSessionPointTarget = document.elementFromPoint(
      firstSessionNameBounds.left + 4,
      firstSessionNameBounds.top + (firstSessionNameBounds.height / 2),
    );
    return {
      workspace: rect('#workspacePicker'),
      search: rect('#sidebarSearch'),
      list: rect('#sessionList'),
      popover: rect('#workspacePopover'),
      confirm: rect('.sidebar-workspace-confirm'),
      popoverPosition: getComputedStyle(popover).position,
      popoverZIndex: Number.parseInt(getComputedStyle(popover).zIndex, 10),
      pickerZIndex: Number.parseInt(getComputedStyle(picker).zIndex, 10),
      listZIndex: Number.parseInt(getComputedStyle(list).zIndex, 10),
      popoverBackground: getComputedStyle(popover).backgroundColor,
      blankPointInsidePopover: popover.contains(blankPointTarget),
      firstSessionPointInsidePopover: popover.contains(firstSessionPointTarget),
      confirmParentDisplay: getComputedStyle(confirm.parentElement).display,
    };
  });

  assert.ok(Math.abs(expandedWorkspace.workspace.height - initial.workspace.height) < 0.5, 'opening workspace chooser should not resize its anchor');
  assert.ok(Math.abs(expandedWorkspace.search.top - initial.search.top) < 0.5, 'opening workspace chooser should not move session search');
  assert.ok(Math.abs(expandedWorkspace.list.top - initial.list.top) < 0.5, 'opening workspace chooser should not move session list');
  assert.equal(expandedWorkspace.popoverPosition, 'absolute', 'workspace chooser should float outside normal layout flow');
  assert.ok(expandedWorkspace.popoverZIndex > 0, 'workspace chooser should render above the session list');
  assert.ok(expandedWorkspace.pickerZIndex > expandedWorkspace.listZIndex, 'workspace chooser stacking context should stay above the session list');
  assert.notEqual(expandedWorkspace.popoverBackground, 'rgba(0, 0, 0, 0)', 'workspace chooser should have an opaque surface');
  assert.equal(expandedWorkspace.blankPointInsidePopover, true, 'workspace chooser should receive pointer hits over the covered session list');
  assert.equal(expandedWorkspace.firstSessionPointInsidePopover, true, 'workspace chooser should cover session-row hit targets beneath it');
  assert.equal(expandedWorkspace.confirmParentDisplay, 'flex', 'workspace chooser should expose its confirm action row');
  assert.ok(expandedWorkspace.confirm.right <= expandedWorkspace.popover.right, 'confirm button should stay inside the popover right edge');
  if (process.env.RAGENT_TEST_SCREENSHOT) {
    await page.screenshot({ path: process.env.RAGENT_TEST_SCREENSHOT, fullPage: true });
  }

  await page.locator('#sessionList').evaluate((node) => {
    node.scrollTop = 180;
  });
  const afterScroll = await page.evaluate(() => {
    const search = document.querySelector('#sidebarSearch').getBoundingClientRect();
    const list = document.querySelector('#sessionList').getBoundingClientRect();
    return {
      searchBottom: search.bottom,
      listTop: list.top,
      listScrollTop: document.querySelector('#sessionList').scrollTop,
    };
  });

  assert.ok(afterScroll.listScrollTop > 0, 'fixture should scroll the session list');
  assert.ok(
    Math.abs(afterScroll.searchBottom - initial.search.bottom) < 0.5,
    'scrolling the session list should not move the search box over the list',
  );
  assert.ok(
    Math.abs(afterScroll.listTop - initial.list.top) < 0.5,
    'scrolling the session list should keep the list viewport below the search box',
  );

  console.log('test-mobile-sidebar-search-layout: ok');
} finally {
  await browser.close();
}
